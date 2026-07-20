import fs from "node:fs/promises";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import type { PlaceResearchResult, ResearchIntent, VerifiedSnapshot } from "@/types/research";

let isRecentPublishedAt: (typeof import("@/lib/research-core"))["isRecentPublishedAt"];
let reconcileVerificationCounts: (typeof import("@/lib/research-core"))["reconcileVerificationCounts"];
let makeVerifiedSnapshot: (typeof import("@/lib/snapshots"))["makeVerifiedSnapshot"];
let getVerifiedSnapshot: (typeof import("@/lib/snapshots"))["getVerifiedSnapshot"];
let MIN_SNAPSHOT_DISTINCT_VIDEOS: (typeof import("@/lib/snapshots"))["MIN_SNAPSHOT_DISTINCT_VIDEOS"];
let REQUIRED_SNAPSHOT_INTENTS: (typeof import("@/lib/snapshots"))["REQUIRED_SNAPSHOT_INTENTS"];
let snapshotEvidenceCoverageIssues: (typeof import("@/lib/snapshots"))["snapshotEvidenceCoverageIssues"];
let snapshotVideoCountsByIntent: (typeof import("@/lib/snapshots"))["snapshotVideoCountsByIntent"];
let validateVerifiedSnapshot: (typeof import("@/lib/snapshots"))["validateVerifiedSnapshot"];
let finalizeLocalSnapshotResearch: (typeof import("@/lib/research-server"))["finalizeLocalSnapshotResearch"];
let researchPlace: (typeof import("@/lib/research-server"))["researchPlace"];
let YouTubeBotChallengeError: (typeof import("@/lib/research-server"))["YouTubeBotChallengeError"];

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

type DraftFile = { snapshotStatus?: unknown; place?: unknown; city?: unknown; reason?: unknown; result?: unknown; finalAcceptedClipIds?: unknown };
type Summary = {
  place: string;
  city: string;
  status: "verified" | "draft" | "failed" | "blocked";
  videoCount: number;
  categoryVideoCounts: Record<ResearchIntent, number>;
  searchedIntents: ResearchIntent[];
  usedOpenAI: boolean;
  reason?: string;
};

function slugFor(place: string, city: string) {
  return `${city}-${place}`.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

function emptyCounts(): Record<ResearchIntent, number> {
  return { why_visit: 0, activity: 0, food: 0, practical_tip: 0 };
}

function videoCount(result: PlaceResearchResult | null) {
  return result ? new Set(result.clips.map((clip) => clip.video.id)).size : 0;
}

function categoryVideoCounts(result: PlaceResearchResult | null) {
  return result ? snapshotVideoCountsByIntent(result.clips) : emptyCounts();
}

function asResult(value: unknown): PlaceResearchResult | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PlaceResearchResult>;
  return typeof candidate.place === "string" && typeof candidate.city === "string" && typeof candidate.generatedAt === "string" && Array.isArray(candidate.clips)
    ? candidate as PlaceResearchResult
    : null;
}

function missingIntents(result: PlaceResearchResult) {
  const counts = snapshotVideoCountsByIntent(result.clips);
  return REQUIRED_SNAPSHOT_INTENTS.filter((intent) => counts[intent] < 2);
}

function finalReviewGaps(reason: unknown) {
  if (typeof reason !== "string") return [] as ResearchIntent[];
  const normalized = reason.toLocaleLowerCase();
  return REQUIRED_SNAPSHOT_INTENTS.filter((intent) => normalized.includes(`for ${intent} evidence`) || normalized.includes(`required ${intent} evidence`));
}

function deterministicIssues(result: PlaceResearchResult) {
  const issues: string[] = [];
  if (videoCount(result) < MIN_SNAPSHOT_DISTINCT_VIDEOS) issues.push(`fewer than ${MIN_SNAPSHOT_DISTINCT_VIDEOS} different source videos`);
  issues.push(...snapshotEvidenceCoverageIssues(result.clips).issues);
  const generatedAt = new Date(result.generatedAt);
  for (const clip of result.clips) {
    if (!isRecentPublishedAt(clip.video.publishedAt, generatedAt)) issues.push(`video ${clip.video.id} is outside the rolling two-year source window`);
    if (clip.endSeconds <= clip.startSeconds || !clip.exactQuote.trim()) issues.push(`clip ${clip.id} has incomplete timestamp or transcript evidence`);
  }
  return [...new Set(issues)];
}

function fallbackFunnel(result: PlaceResearchResult) {
  const count = result.clips.length;
  return result.verification || {
    videosFound: videoCount(result),
    captionedVideos: videoCount(result),
    candidateClips: count,
    evidenceMatches: count,
    verifiedClips: count,
    rejectedEvidenceOrRanking: 0,
    rejectedLocation: 0
  };
}

function locationVerifiedSourceIds(result: PlaceResearchResult) {
  return new Set(result.clips
    .filter((clip) => clip.locationVerification && ["same_place", "verified_nearby"].includes(clip.locationVerification.status))
    .map((clip) => clip.video.id));
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

function combinePartialResults(existing: PlaceResearchResult, fresh: PlaceResearchResult, acceptedIds: string[]) {
  // Preserve sources already accepted by a previous Luna review, then give
  // fresh gap evidence a chance before weaker old fallback candidates.
  const accepted = new Set(acceptedIds);
  const verifiedClips = [
    ...existing.clips.filter((clip) => accepted.has(clip.id)),
    ...fresh.clips,
    ...existing.clips.filter((clip) => !accepted.has(clip.id))
  ]
    .filter((clip, index, clips) => clips.findIndex((candidate) => candidate.id === clip.id) === index);
  const existingFunnel = fallbackFunnel(existing);
  const freshFunnel = fallbackFunnel(fresh);
  const base: PlaceResearchResult = {
    ...existing,
    generatedAt: fresh.generatedAt,
    cacheHit: false,
    sourceStatus: "local_research",
    clips: verifiedClips,
    clipCount: verifiedClips.length,
    sourceCount: new Set(verifiedClips.map((clip) => clip.video.id)).size
  };
  // Preserve every already verified partial clip in the draft. The production
  // reviewer performs its own bounded selection later; truncating here would
  // throw away the newly fetched fallback source before it can be assessed.
  const combined: PlaceResearchResult = {
    ...base,
    overview: `${base.sourceCount} captioned travel videos produced ${verifiedClips.length} locally verified partial clips for ${base.place}. Each title is tied to an exact supporting quote.`,
    mode: "ai",
    suggestedPlan: (["practical_tip", "activity", "food"] as ResearchIntent[])
      .flatMap((intent) => verifiedClips.filter((clip) => clip.intent === intent).slice(0, intent === "activity" ? 2 : 1).map((clip) => clip.title)),
    warnings: [...new Set([...fresh.warnings, ...existing.warnings])]
  };
  const candidateClips = existingFunnel.candidateClips + freshFunnel.candidateClips;
  const evidenceMatches = existingFunnel.evidenceMatches + freshFunnel.evidenceMatches;
  const verification = reconcileVerificationCounts({
    videosFound: existingFunnel.videosFound + freshFunnel.videosFound,
    captionedVideos: existingFunnel.captionedVideos + freshFunnel.captionedVideos,
    candidateClips,
    evidenceMatches,
    verifiedClips: combined.clipCount,
    rejectedEvidenceOrRanking: Math.max(0, candidateClips - evidenceMatches),
    rejectedLocation: Math.max(0, evidenceMatches - combined.clipCount)
  }, combined.clipCount);
  return { ...combined, aiModel: fresh.aiModel || existing.aiModel, sourceStatus: "local_research" as const, verification };
}

async function writeDraft(place: string, city: string, result: PlaceResearchResult, reason: string, acceptedIds: string[] = []) {
  await fs.mkdir(draftsDir, { recursive: true });
  await fs.writeFile(path.join(draftsDir, `${slugFor(place, city)}.json`), `${JSON.stringify({
    snapshotStatus: "draft",
    place,
    city,
    generatedAt: result.generatedAt,
    reason,
    sourceCount: videoCount(result),
    clipCount: result.clips.length,
    categories: [...new Set(result.clips.map((clip) => clip.intent))],
    categoryVideoCounts: categoryVideoCounts(result),
    finalAcceptedClipIds: acceptedIds,
    result
  }, null, 2)}\n`, "utf8");
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
    // The registry is created below.
  }
  registry.entries = registry.entries
    .filter((entry) => entry.place.toLocaleLowerCase() !== snapshot.place.toLocaleLowerCase() || entry.city.toLocaleLowerCase() !== snapshot.city.toLocaleLowerCase())
    .concat({ place: snapshot.place, city: snapshot.city, file, snapshot })
    .sort((a, b) => `${a.city}:${a.place}`.localeCompare(`${b.city}:${b.place}`));
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

function printSummary(items: Summary[]) {
  console.log("\nIncremental snapshot summary");
  for (const item of items) {
    const coverage = (Object.entries(item.categoryVideoCounts) as Array<[ResearchIntent, number]>).map(([intent, count]) => `${intent} ${count}/2`).join(", ");
    console.log(`- ${item.place}, ${item.city}: ${item.status}; ${item.videoCount} videos; searched: ${item.searchedIntents.join(",") || "none"}; coverage: ${coverage}; OpenAI: ${item.usedOpenAI ? "called" : "not called"}${item.reason ? `; ${item.reason}` : ""}`);
  }
}

async function main() {
  loadEnvConfig(root);
  if (process.env.TRIPTRACE_RUNTIME === "production" || process.env.K_SERVICE) throw new Error("snapshots:continue is local-only and refuses Cloud Run production.");
  if (process.env.TRIPTRACE_TEST_MODE === "fixture") throw new Error("Clear TRIPTRACE_TEST_MODE=fixture before continuing local snapshot drafts.");
  process.env.TRIPTRACE_SNAPSHOT_GENERATOR = "1";
  ({ isRecentPublishedAt, reconcileVerificationCounts } = await import("@/lib/research-core"));
  ({ makeVerifiedSnapshot, getVerifiedSnapshot, MIN_SNAPSHOT_DISTINCT_VIDEOS, REQUIRED_SNAPSHOT_INTENTS, snapshotEvidenceCoverageIssues, snapshotVideoCountsByIntent, validateVerifiedSnapshot } = await import("@/lib/snapshots"));
  ({ finalizeLocalSnapshotResearch, researchPlace, YouTubeBotChallengeError } = await import("@/lib/research-server"));

  const summary: Summary[] = [];
  let botChallengeSeen = false;
  for (const target of PLACES) {
    const existingSnapshot = getVerifiedSnapshot(target.place, target.city);
    if (existingSnapshot) {
      summary.push({ ...target, status: "verified", videoCount: videoCount(existingSnapshot), categoryVideoCounts: categoryVideoCounts(existingSnapshot), searchedIntents: [], usedOpenAI: false, reason: "Already verified; skipped without re-fetching sources." });
      continue;
    }
    const draftPath = path.join(draftsDir, `${slugFor(target.place, target.city)}.json`);
    let draft: DraftFile;
    try {
      draft = JSON.parse(await fs.readFile(draftPath, "utf8")) as DraftFile;
    } catch {
      summary.push({ ...target, status: "failed", videoCount: 0, categoryVideoCounts: emptyCounts(), searchedIntents: [], usedOpenAI: false, reason: "No local draft exists to continue." });
      continue;
    }
    const existing = asResult(draft.result);
    if (draft.snapshotStatus !== "draft" || !existing || existing.place !== target.place || existing.city !== target.city) {
      summary.push({ ...target, status: "failed", videoCount: 0, categoryVideoCounts: emptyCounts(), searchedIntents: [], usedOpenAI: false, reason: "The saved partial result is not a valid local draft." });
      continue;
    }
    // Keep the complete local draft (including raw candidates) so a stricter
    // extractor can revisit a saved caption without losing previous partial
    // work. Only completed location-verified sources are excluded from the
    // next fetch; unverified candidates remain eligible for re-validation.
    const acceptedIds = finalAcceptedClipIds(draft.finalAcceptedClipIds);
    const prioritizedPreserved = prioritizeFinalAcceptedClips(existing, acceptedIds);
    const verifiedSources = locationVerifiedSourceIds(prioritizedPreserved);
    const gaps = [...new Set([...missingIntents(prioritizedPreserved), ...finalReviewGaps(draft.reason)])];
    if (botChallengeSeen) {
      summary.push({ ...target, status: "blocked", videoCount: videoCount(prioritizedPreserved), categoryVideoCounts: categoryVideoCounts(prioritizedPreserved), searchedIntents: gaps, usedOpenAI: false, reason: "Skipped after a local YouTube bot-verification response." });
      continue;
    }
    let combined = prioritizedPreserved;
    let usedOpenAI = false;
    try {
      if (gaps.length) {
        console.log(`[${target.place}] Preserving ${prioritizedPreserved.clips.length} saved partial clips (${verifiedSources.size} location-verified source${verifiedSources.size === 1 ? "" : "s"}); searching only ${gaps.join(", ")}.`);
        const fresh = await researchPlace({
          ...target,
          force: true,
          localSnapshotGeneration: true,
          snapshotIntents: gaps,
          snapshotSearchRefillOnly: true,
          excludeVideoIds: verifiedSources,
          signal: new AbortController().signal,
          onProgress(stage, message) { console.log(`[${target.place}] ${stage}: ${message}`); },
          onModelUse() { usedOpenAI = true; }
        });
        combined = combinePartialResults(prioritizedPreserved, fresh, acceptedIds);
        await writeDraft(target.place, target.city, combined, `Incremental local search preserved existing evidence and added only missing-category candidates. Remaining gaps: ${missingIntents(combined).join(", ") || "none"}.`, acceptedIds);
      }
      const issues = deterministicIssues(combined);
      if (issues.length) {
        summary.push({ ...target, status: "draft", videoCount: videoCount(combined), categoryVideoCounts: categoryVideoCounts(combined), searchedIntents: gaps, usedOpenAI, reason: issues.join("; ") });
        continue;
      }
      const finalResult = await finalizeLocalSnapshotResearch(combined, new AbortController().signal, () => { usedOpenAI = true; });
      const snapshot = makeVerifiedSnapshot(finalResult);
      const validation = validateVerifiedSnapshot(snapshot);
      if (!validation.valid) {
        // A failed final review is not permission to discard a larger useful
        // local partial. Keep the pre-final verified evidence and add only new
        // sources on the next pass; only a fully valid Luna result may replace
        // it in the public registry.
        const retained = combined;
        const reason = `Final snapshot validation failed: ${validation.issues.join("; ")}. Retained the pre-final verified partial evidence for the next incremental pass.`;
        await writeDraft(target.place, target.city, retained, reason, finalResult.clips.map((clip) => clip.id));
        summary.push({ ...target, status: "draft", videoCount: videoCount(retained), categoryVideoCounts: categoryVideoCounts(retained), searchedIntents: gaps, usedOpenAI, reason });
        continue;
      }
      await registerSnapshot(snapshot);
      summary.push({ ...target, status: "verified", videoCount: videoCount(finalResult), categoryVideoCounts: categoryVideoCounts(finalResult), searchedIntents: gaps, usedOpenAI });
    } catch (error) {
      if (error instanceof YouTubeBotChallengeError) {
        botChallengeSeen = true;
        summary.push({ ...target, status: "blocked", videoCount: videoCount(combined), categoryVideoCounts: categoryVideoCounts(combined), searchedIntents: gaps, usedOpenAI, reason: "YouTube requested bot verification; no bypass or further live retries were attempted." });
      } else {
        const reason = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 220) : "Unknown continuation error.";
        summary.push({ ...target, status: "failed", videoCount: videoCount(combined), categoryVideoCounts: categoryVideoCounts(combined), searchedIntents: gaps, usedOpenAI, reason });
      }
    }
  }
  printSummary(summary);
  if (summary.some((item) => item.status !== "verified")) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Snapshot continuation failed.");
  process.exitCode = 1;
});
