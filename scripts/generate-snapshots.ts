import fs from "node:fs/promises";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import type { PlaceResearchResult, ResearchIntent, VerifiedSnapshot } from "@/types/research";

let makeVerifiedSnapshot: (typeof import("@/lib/snapshots"))["makeVerifiedSnapshot"];
let validateVerifiedSnapshot: (typeof import("@/lib/snapshots"))["validateVerifiedSnapshot"];
let snapshotEvidenceCoverageIssues: (typeof import("@/lib/snapshots"))["snapshotEvidenceCoverageIssues"];
let snapshotVideoCountsByIntent: (typeof import("@/lib/snapshots"))["snapshotVideoCountsByIntent"];
let MIN_SNAPSHOT_DISTINCT_VIDEOS: (typeof import("@/lib/snapshots"))["MIN_SNAPSHOT_DISTINCT_VIDEOS"];
let finalizeLocalSnapshotResearch: (typeof import("@/lib/research-server"))["finalizeLocalSnapshotResearch"];
let localYtDlpStatus: (typeof import("@/lib/research-server"))["localYtDlpStatus"];
let researchPlace: (typeof import("@/lib/research-server"))["researchPlace"];
let YouTubeBotChallengeError: (typeof import("@/lib/research-server"))["YouTubeBotChallengeError"];
let isRecentPublishedAt: (typeof import("@/lib/research-core"))["isRecentPublishedAt"];

async function main() {
  loadEnvConfig(process.cwd());
  if (process.env.TRIPTRACE_RUNTIME === "production" || process.env.K_SERVICE) {
    throw new Error("snapshots:generate is local-only and refuses to run in Cloud Run production.");
  }
  if (process.env.TRIPTRACE_TEST_MODE === "fixture") {
    throw new Error("Clear TRIPTRACE_TEST_MODE=fixture before generating snapshots. Fixture data is legacy-only and cannot become a verified snapshot.");
  }
  // The research server reads this before doing any batched YouTube work.
  process.env.TRIPTRACE_SNAPSHOT_GENERATOR = "1";
  ({ makeVerifiedSnapshot, validateVerifiedSnapshot, snapshotEvidenceCoverageIssues, snapshotVideoCountsByIntent, MIN_SNAPSHOT_DISTINCT_VIDEOS } = await import("@/lib/snapshots"));
  ({ finalizeLocalSnapshotResearch, localYtDlpStatus, researchPlace, YouTubeBotChallengeError } = await import("@/lib/research-server"));
  ({ isRecentPublishedAt } = await import("@/lib/research-core"));
  await runGenerator();
}

const PLACES = [
  { place: "Taipei 101", city: "Taipei" },
  { place: "Ximending", city: "Taipei" },
  { place: "Dadaocheng", city: "Taipei" },
  { place: "Shilin Night Market", city: "Taipei" }
] as const;

type GeneratorStatus = "verified" | "draft" | "failed" | "blocked";
type Summary = {
  place: string;
  city: string;
  status: GeneratorStatus;
  reason?: string;
  videoCount: number;
  categoryVideoCounts: Record<ResearchIntent, number>;
  usedOpenAI: boolean;
  models: string[];
};

const root = process.cwd();
const snapshotsDir = path.join(root, "data", "snapshots");
const verifiedDir = path.join(snapshotsDir, "verified");
const draftsDir = path.join(snapshotsDir, "drafts");
const registryPath = path.join(snapshotsDir, "registry.json");

function slugFor(place: string, city: string) {
  return `${city}-${place}`
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function emptyCategoryVideoCounts(): Record<ResearchIntent, number> {
  return { why_visit: 0, activity: 0, food: 0, practical_tip: 0 };
}

function categoryVideoCounts(result: PlaceResearchResult | null) {
  return result ? snapshotVideoCountsByIntent(result.clips) : emptyCategoryVideoCounts();
}

function videoCount(result: PlaceResearchResult | null) {
  return result ? new Set(result.clips.map((clip) => clip.video.id)).size : 0;
}

function deterministicReadinessIssues(result: PlaceResearchResult) {
  const issues: string[] = [];
  if (videoCount(result) < MIN_SNAPSHOT_DISTINCT_VIDEOS) issues.push(`fewer than ${MIN_SNAPSHOT_DISTINCT_VIDEOS} different source videos`);
  issues.push(...snapshotEvidenceCoverageIssues(result.clips).issues);
  for (const clip of result.clips) {
    if (!isRecentPublishedAt(clip.video.publishedAt, new Date(result.generatedAt))) issues.push(`video ${clip.video.id} is outside the rolling two-year source window`);
    if (clip.endSeconds <= clip.startSeconds || !clip.exactQuote.trim()) issues.push(`clip ${clip.id} has incomplete timestamp or transcript evidence`);
  }
  return [...new Set(issues)];
}

async function writeDraft(place: string, city: string, result: PlaceResearchResult | null, reason: string) {
  await fs.mkdir(draftsDir, { recursive: true });
  const target = path.join(draftsDir, `${slugFor(place, city)}.json`);
  await fs.writeFile(target, `${JSON.stringify({
    snapshotStatus: "draft",
    place,
    city,
    generatedAt: result?.generatedAt || new Date().toISOString(),
    reason,
    sourceCount: videoCount(result),
    clipCount: result?.clips.length || 0,
    categories: result ? [...new Set(result.clips.map((clip) => clip.intent))] : [],
    categoryVideoCounts: categoryVideoCounts(result),
    result
  }, null, 2)}\n`, "utf8");
  return target;
}

async function registerSnapshot(snapshot: VerifiedSnapshot) {
  await fs.mkdir(verifiedDir, { recursive: true });
  const slug = slugFor(snapshot.place, snapshot.city);
  const file = `verified/${slug}.json`;
  await fs.writeFile(path.join(snapshotsDir, file), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  let registry: { entries: Array<{ place: string; city: string; file: string; snapshot: VerifiedSnapshot }> } = { entries: [] };
  try {
    const parsed = JSON.parse(await fs.readFile(registryPath, "utf8")) as Partial<typeof registry>;
    if (Array.isArray(parsed.entries)) registry.entries = parsed.entries;
  } catch {
    // A new registry is created below.
  }
  registry.entries = registry.entries
    .filter((entry) => !(entry.place.toLocaleLowerCase() === snapshot.place.toLocaleLowerCase() && entry.city.toLocaleLowerCase() === snapshot.city.toLocaleLowerCase()))
    .concat({ place: snapshot.place, city: snapshot.city, file, snapshot })
    .sort((a, b) => `${a.city}:${a.place}`.localeCompare(`${b.city}:${b.place}`));
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

function printSummary(items: Summary[]) {
  console.log("\nSnapshot generator summary");
  for (const item of items) {
    const coverageLabel = (Object.entries(item.categoryVideoCounts) as Array<[ResearchIntent, number]>).map(([intent, count]) => `${intent} ${count}/2`).join(", ");
    console.log(`- ${item.place}, ${item.city}: ${item.status}; ${item.videoCount} videos; coverage: ${coverageLabel}; OpenAI: ${item.usedOpenAI ? item.models.join(" → ") : "not called"}${item.reason ? `; ${item.reason}` : ""}`);
  }
}

async function runGenerator() {
const ytDlp = await localYtDlpStatus();
if (!ytDlp.available) {
  const summary = PLACES.map(({ place, city }) => ({
    place,
    city,
    status: "failed" as const,
    reason: ytDlp.reason || "yt-dlp is not available locally.",
    videoCount: 0,
    categoryVideoCounts: emptyCategoryVideoCounts(),
    usedOpenAI: false,
    models: []
  }));
  printSummary(summary);
  process.exitCode = 1;
} else {
  console.log(`Using local yt-dlp ${ytDlp.version}. Places are processed one at a time.`);
  const summary: Summary[] = [];
  let botChallengeSeen = false;

  for (const target of PLACES) {
    if (botChallengeSeen) {
      summary.push({
        ...target,
        status: "blocked",
        reason: "Skipped after a local YouTube bot-verification response; no further live retries were attempted.",
        videoCount: 0,
        categoryVideoCounts: emptyCategoryVideoCounts(),
        usedOpenAI: false,
        models: []
      });
      continue;
    }

    let partial: PlaceResearchResult | null = null;
    const models: string[] = [];
    const recordModelUse = (model: string) => {
      if (!models.includes(model)) models.push(model);
    };
    try {
      const developmentResult = await researchPlace({
        ...target,
        force: true,
        localSnapshotGeneration: true,
        signal: new AbortController().signal,
        onProgress(stage, message) {
          console.log(`[${target.place}] ${stage}: ${message}`);
        },
        onPartialResult(result) {
          partial = result;
        },
        onModelUse(model) {
          recordModelUse(model);
        }
      });
      const readiness = deterministicReadinessIssues(developmentResult);
      if (readiness.length) {
        await writeDraft(target.place, target.city, developmentResult, `Deterministic validation stopped before production-model review: ${readiness.join("; ")}.`);
        summary.push({ ...target, status: "draft", reason: readiness.join("; "), videoCount: videoCount(developmentResult), categoryVideoCounts: categoryVideoCounts(developmentResult), usedOpenAI: models.length > 0, models });
        continue;
      }

      const finalResult = await finalizeLocalSnapshotResearch(developmentResult, new AbortController().signal, recordModelUse);
      const snapshot = makeVerifiedSnapshot(finalResult);
      const validation = validateVerifiedSnapshot(snapshot);
      if (!validation.valid) {
        await writeDraft(target.place, target.city, finalResult, `Final snapshot validation failed: ${validation.issues.join("; ")}.`);
        summary.push({ ...target, status: "draft", reason: validation.issues.join("; "), videoCount: videoCount(finalResult), categoryVideoCounts: categoryVideoCounts(finalResult), usedOpenAI: models.length > 0, models });
        continue;
      }
      await registerSnapshot(snapshot);
      summary.push({ ...target, status: "verified", videoCount: videoCount(finalResult), categoryVideoCounts: categoryVideoCounts(finalResult), usedOpenAI: models.length > 0, models });
    } catch (error) {
      if (error instanceof YouTubeBotChallengeError) {
        botChallengeSeen = true;
        const reason = "YouTube requested bot verification. The generator stopped live fetching and did not attempt a bypass.";
        await writeDraft(target.place, target.city, partial, reason);
        summary.push({ ...target, status: "blocked", reason, videoCount: videoCount(partial), categoryVideoCounts: categoryVideoCounts(partial), usedOpenAI: models.length > 0, models });
      } else {
        const reason = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 220) : "Unknown generator failure.";
        await writeDraft(target.place, target.city, partial, reason);
        summary.push({ ...target, status: "failed", reason, videoCount: videoCount(partial), categoryVideoCounts: categoryVideoCounts(partial), usedOpenAI: models.length > 0, models });
      }
    }
  }
  printSummary(summary);
  if (summary.some((item) => item.status !== "verified")) process.exitCode = 1;
}
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Snapshot generator failed.");
  process.exitCode = 1;
});
