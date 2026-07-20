import fs from "node:fs/promises";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import type { PlaceResearchResult, ResearchIntent, VerifiedSnapshot } from "@/types/research";

let makeVerifiedSnapshot: (typeof import("@/lib/snapshots"))["makeVerifiedSnapshot"];
let getVerifiedSnapshot: (typeof import("@/lib/snapshots"))["getVerifiedSnapshot"];
let validateVerifiedSnapshot: (typeof import("@/lib/snapshots"))["validateVerifiedSnapshot"];
let snapshotEvidenceCoverageIssues: (typeof import("@/lib/snapshots"))["snapshotEvidenceCoverageIssues"];
let snapshotVideoCountsByIntent: (typeof import("@/lib/snapshots"))["snapshotVideoCountsByIntent"];
let MIN_SNAPSHOT_DISTINCT_VIDEOS: (typeof import("@/lib/snapshots"))["MIN_SNAPSHOT_DISTINCT_VIDEOS"];
let finalizeLocalSnapshotResearch: (typeof import("@/lib/research-server"))["finalizeLocalSnapshotResearch"];
let isRecentPublishedAt: (typeof import("@/lib/research-core"))["isRecentPublishedAt"];

const PLACES = [
  { place: "Taipei 101", city: "Taipei" },
  { place: "Ximending", city: "Taipei" },
  { place: "Dadaocheng", city: "Taipei" },
  { place: "Shilin Night Market", city: "Taipei" }
] as const;

const root = process.cwd();
const snapshotsDir = path.join(root, "data", "snapshots");
const draftsDir = path.join(snapshotsDir, "drafts");
const verifiedDir = path.join(snapshotsDir, "verified");
const registryPath = path.join(snapshotsDir, "registry.json");
const MAX_DRAFT_AGE_MS = 24 * 60 * 60 * 1000;

type DraftFile = {
  snapshotStatus?: unknown;
  place?: unknown;
  city?: unknown;
  generatedAt?: unknown;
  reason?: unknown;
  result?: unknown;
  finalAcceptedClipIds?: unknown;
};

type Summary = {
  place: string;
  city: string;
  status: "verified" | "draft" | "failed";
  videoCount: number;
  categoryVideoCounts: Record<ResearchIntent, number>;
  usedOpenAI: boolean;
  reason?: string;
};

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

function asPlaceResearchResult(value: unknown): PlaceResearchResult | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PlaceResearchResult>;
  return typeof candidate.place === "string"
    && typeof candidate.city === "string"
    && typeof candidate.generatedAt === "string"
    && Array.isArray(candidate.clips)
    ? candidate as PlaceResearchResult
    : null;
}

function finalAcceptedClipIds(value: unknown) {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))] : [];
}

function prioritizeFinalAcceptedClips(result: PlaceResearchResult, acceptedIds: string[]) {
  if (!acceptedIds.length) return result;
  const accepted = new Set(acceptedIds);
  return {
    ...result,
    clips: [...result.clips.filter((clip) => accepted.has(clip.id)), ...result.clips.filter((clip) => !accepted.has(clip.id))]
  };
}

function deterministicReadinessIssues(result: PlaceResearchResult) {
  const issues: string[] = [];
  const generatedAt = new Date(result.generatedAt);
  if (Number.isNaN(generatedAt.getTime())) {
    issues.push("the draft has an invalid generatedAt value");
  } else if (Date.now() - generatedAt.getTime() > MAX_DRAFT_AGE_MS) {
    issues.push("the draft is older than 24 hours and must be regenerated before final verification");
  }
  if (videoCount(result) < MIN_SNAPSHOT_DISTINCT_VIDEOS) {
    issues.push(`fewer than ${MIN_SNAPSHOT_DISTINCT_VIDEOS} different source videos`);
  }
  issues.push(...snapshotEvidenceCoverageIssues(result.clips).issues);
  for (const clip of result.clips) {
    if (!isRecentPublishedAt(clip.video.publishedAt, generatedAt)) {
      issues.push(`video ${clip.video.id} is outside the rolling two-year source window`);
    }
    if (clip.endSeconds <= clip.startSeconds || !clip.exactQuote.trim()) {
      issues.push(`clip ${clip.id} has incomplete timestamp or transcript evidence`);
    }
  }
  return [...new Set(issues)];
}

async function registerSnapshot(snapshot: VerifiedSnapshot) {
  await fs.mkdir(verifiedDir, { recursive: true });
  const file = `verified/${slugFor(snapshot.place, snapshot.city)}.json`;
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

async function updateDraftReason(draftPath: string, draft: DraftFile, reason: string, acceptedIds?: string[]) {
  // Keep the larger local partial result intact; this metadata lets the next
  // incremental pass search only categories that failed final verification.
  await fs.writeFile(draftPath, `${JSON.stringify({ ...draft, reason, ...(acceptedIds ? { finalAcceptedClipIds: acceptedIds } : {}) }, null, 2)}\n`, "utf8");
}

function printSummary(items: Summary[]) {
  console.log("\nSnapshot draft finalization summary");
  for (const item of items) {
    const coverage = (Object.entries(item.categoryVideoCounts) as Array<[ResearchIntent, number]>)
      .map(([intent, count]) => `${intent} ${count}/2`)
      .join(", ");
    console.log(`- ${item.place}, ${item.city}: ${item.status}; ${item.videoCount} videos; coverage: ${coverage}; OpenAI: ${item.usedOpenAI ? "gpt-5.6-luna" : "not called"}${item.reason ? `; ${item.reason}` : ""}`);
  }
}

async function main() {
  loadEnvConfig(root);
  if (process.env.TRIPTRACE_RUNTIME === "production" || process.env.K_SERVICE) {
    throw new Error("snapshots:finalize-drafts is local-only and refuses to run in Cloud Run production.");
  }
  if (process.env.TRIPTRACE_TEST_MODE === "fixture") {
    throw new Error("Clear TRIPTRACE_TEST_MODE=fixture before finalizing local snapshot drafts.");
  }
  ({ makeVerifiedSnapshot, getVerifiedSnapshot, validateVerifiedSnapshot, snapshotEvidenceCoverageIssues, snapshotVideoCountsByIntent, MIN_SNAPSHOT_DISTINCT_VIDEOS } = await import("@/lib/snapshots"));
  ({ finalizeLocalSnapshotResearch } = await import("@/lib/research-server"));
  ({ isRecentPublishedAt } = await import("@/lib/research-core"));

  const summary: Summary[] = [];
  for (const target of PLACES) {
    const existingSnapshot = getVerifiedSnapshot(target.place, target.city);
    if (existingSnapshot) {
      summary.push({ ...target, status: "verified", videoCount: videoCount(existingSnapshot), categoryVideoCounts: categoryVideoCounts(existingSnapshot), usedOpenAI: false, reason: "Already verified; skipped without re-running final verification." });
      continue;
    }
    const draftPath = path.join(draftsDir, `${slugFor(target.place, target.city)}.json`);
    let draft: DraftFile;
    try {
      draft = JSON.parse(await fs.readFile(draftPath, "utf8")) as DraftFile;
    } catch {
      summary.push({ ...target, status: "draft", videoCount: 0, categoryVideoCounts: emptyCategoryVideoCounts(), usedOpenAI: false, reason: "No fresh local draft is available." });
      continue;
    }
    const candidate = asPlaceResearchResult(draft.result);
    if (!candidate || draft.snapshotStatus !== "draft" || candidate.place !== target.place || candidate.city !== target.city) {
      summary.push({ ...target, status: "failed", videoCount: 0, categoryVideoCounts: emptyCategoryVideoCounts(), usedOpenAI: false, reason: "Draft structure or place identity is invalid." });
      continue;
    }
    const prioritizedCandidate = prioritizeFinalAcceptedClips(candidate, finalAcceptedClipIds(draft.finalAcceptedClipIds));
    const readiness = deterministicReadinessIssues(prioritizedCandidate);
    if (readiness.length) {
      summary.push({ ...target, status: "draft", videoCount: videoCount(prioritizedCandidate), categoryVideoCounts: categoryVideoCounts(prioritizedCandidate), usedOpenAI: false, reason: readiness.join("; ") });
      continue;
    }

    try {
      console.log(`[${target.place}] Final semantic and location verification from fresh local draft; no YouTube fetch.`);
      let usedOpenAI = false;
      const finalResult = await finalizeLocalSnapshotResearch(prioritizedCandidate, new AbortController().signal, () => {
        usedOpenAI = true;
      });
      const snapshot = makeVerifiedSnapshot(finalResult);
      const validation = validateVerifiedSnapshot(snapshot);
      if (!validation.valid) {
        const reason = `Final production verification gaps: ${validation.issues.join("; ")}. Existing local partial evidence was retained.`;
        await updateDraftReason(draftPath, draft, reason, finalResult.clips.map((clip) => clip.id));
        summary.push({ ...target, status: "draft", videoCount: videoCount(finalResult), categoryVideoCounts: categoryVideoCounts(finalResult), usedOpenAI, reason });
        continue;
      }
      await registerSnapshot(snapshot);
      summary.push({ ...target, status: "verified", videoCount: videoCount(finalResult), categoryVideoCounts: categoryVideoCounts(finalResult), usedOpenAI });
    } catch (error) {
      const reason = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 220) : "Unknown finalization error.";
      summary.push({ ...target, status: "failed", videoCount: videoCount(prioritizedCandidate), categoryVideoCounts: categoryVideoCounts(prioritizedCandidate), usedOpenAI: false, reason });
    }
  }
  printSummary(summary);
  if (summary.some((item) => item.status !== "verified")) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Snapshot draft finalization failed.");
  process.exitCode = 1;
});
