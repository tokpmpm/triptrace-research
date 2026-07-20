import snapshotRegistryData from "@/data/snapshots/registry.json";
import { hasRequiredEnglishPresentation, isRecentPublishedAt, normalizeResearchText, recentVideoCutoffDate } from "@/lib/research-core";
import type { PlaceResearchResult, ResearchClip, ResearchIntent, SnapshotResearchClip, VerifiedSnapshot } from "@/types/research";

export const REQUIRED_SNAPSHOT_INTENTS: ResearchIntent[] = ["why_visit", "activity", "food", "practical_tip"];
export const MIN_SNAPSHOT_VIDEOS_PER_INTENT = 2;
export const MIN_SNAPSHOT_EVIDENCE_CARDS = REQUIRED_SNAPSHOT_INTENTS.length * MIN_SNAPSHOT_VIDEOS_PER_INTENT;
export const MIN_SNAPSHOT_DISTINCT_VIDEOS = 4;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const GENERIC_TITLE_PATTERN = /(?:evidence\s+(?:from|for)\s+(?:this|the)\s+clip|generic\s+(?:travel|food|activity)|^(?:why\s+(?:visit|go)|what\s+to\s+(?:do|eat)|good\s+to\s+know)\s*[:.!]?$)/i;
const CJK_PATTERN = /\p{Script=Han}/u;

export type SnapshotValidation = {
  valid: boolean;
  issues: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function normalizedIncludes(haystack: string, needle: string) {
  const normalizedNeedle = normalizeResearchText(needle);
  const minimumLength = CJK_PATTERN.test(normalizedNeedle) ? 3 : 8;
  return normalizedNeedle.length >= minimumLength && normalizeResearchText(haystack).includes(normalizedNeedle);
}

function contentTokens(value: string) {
  const ignored = new Set(["about", "after", "and", "at", "before", "creator", "from", "have", "into", "that", "the", "this", "with"]);
  return normalizeResearchText(value).split(" ").filter((token) => token.length >= 3 && !ignored.has(token));
}

function hasTranscriptOverlap(summary: string, quote: string, minimumSharedTokens: number) {
  const normalizedSummary = normalizeResearchText(summary);
  const normalizedQuote = normalizeResearchText(quote);
  if (CJK_PATTERN.test(`${normalizedSummary} ${normalizedQuote}`)) {
    const summaryWithoutSpaces = normalizedSummary.replace(/\s+/g, "");
    const quoteWithoutSpaces = normalizedQuote.replace(/\s+/g, "");
    // Chinese does not have stable word boundaries. A six-character verbatim
    // phrase is still specific enough for a takeaway while avoiding false
    // rejection of a source-backed sentence that joins adjacent clauses.
    const minimumPhraseLength = Math.max(4, minimumSharedTokens * 3);
    for (let index = 0; index <= summaryWithoutSpaces.length - minimumPhraseLength; index += 1) {
      if (quoteWithoutSpaces.includes(summaryWithoutSpaces.slice(index, index + minimumPhraseLength))) return true;
    }
    return false;
  }
  const quoteTokens = new Set(contentTokens(quote));
  return [...new Set(contentTokens(summary))].filter((token) => quoteTokens.has(token)).length >= minimumSharedTokens;
}

function snapshotKey(place: string, city: string) {
  return `${normalizeResearchText(city)}::${normalizeResearchText(place)}`;
}

export function snapshotVideoCountsByIntent(clips: ReadonlyArray<Pick<ResearchClip, "intent" | "video">>) {
  const videoIdsByIntent = new Map<ResearchIntent, Set<string>>(
    REQUIRED_SNAPSHOT_INTENTS.map((intent) => [intent, new Set<string>()])
  );
  for (const clip of clips) {
    videoIdsByIntent.get(clip.intent)?.add(clip.video.id);
  }
  return Object.fromEntries(REQUIRED_SNAPSHOT_INTENTS.map((intent) => [intent, videoIdsByIntent.get(intent)?.size || 0])) as Record<ResearchIntent, number>;
}

export function snapshotEvidenceCoverageIssues(clips: ReadonlyArray<Pick<ResearchClip, "intent" | "video">>) {
  const counts = snapshotVideoCountsByIntent(clips);
  const issues: string[] = [];
  if (clips.length < MIN_SNAPSHOT_EVIDENCE_CARDS) {
    issues.push(`A verified snapshot needs at least ${MIN_SNAPSHOT_EVIDENCE_CARDS} evidence cards.`);
  }
  for (const intent of REQUIRED_SNAPSHOT_INTENTS) {
    if (counts[intent] < MIN_SNAPSHOT_VIDEOS_PER_INTENT) {
      issues.push(`Snapshot needs at least ${MIN_SNAPSHOT_VIDEOS_PER_INTENT} different video sources for ${intent} evidence.`);
    }
  }
  return { counts, issues };
}

export function validateVerifiedSnapshot(input: unknown): SnapshotValidation {
  const issues: string[] = [];
  const snapshot = asRecord(input);
  if (!snapshot) return { valid: false, issues: ["Snapshot must be a JSON object."] };

  const place = typeof snapshot.place === "string" ? snapshot.place.trim() : "";
  const city = typeof snapshot.city === "string" ? snapshot.city.trim() : "";
  const generatedAt = typeof snapshot.generatedAt === "string" ? snapshot.generatedAt : "";
  const generatedDate = new Date(generatedAt);
  const sourceCutoffDate = snapshot.sourceCutoffDate;
  const reviewAfter = snapshot.reviewAfter;
  const clips = Array.isArray(snapshot.clips) ? snapshot.clips : [];
  const verification = asRecord(snapshot.verification);

  if (!place || !city) issues.push("Snapshot requires a place and city.");
  if (snapshot.snapshotVersion !== 1) issues.push("Snapshot must declare snapshotVersion 1.");
  if (snapshot.snapshotStatus !== "verified") issues.push("Only snapshotStatus=verified can enter the public registry.");
  if (snapshot.demoSnapshot !== true) issues.push("Public snapshots must declare demoSnapshot: true.");
  if (snapshot.mode !== "ai") issues.push("A public verified snapshot must complete production-quality semantic verification.");
  if (snapshot.aiModel !== "gpt-5.6-luna") issues.push("A public verified snapshot must record the production-quality final verification model.");
  if (Number.isNaN(generatedDate.getTime())) issues.push("generatedAt must be a valid ISO timestamp.");
  if (!isDate(sourceCutoffDate)) issues.push("sourceCutoffDate must be a valid YYYY-MM-DD date.");
  if (!isDate(reviewAfter)) issues.push("reviewAfter must be a valid YYYY-MM-DD date.");
  if (isDate(sourceCutoffDate) && !Number.isNaN(generatedDate.getTime()) && sourceCutoffDate < recentVideoCutoffDate(generatedDate)) {
    issues.push("sourceCutoffDate cannot be older than the generated-at two-year cutoff.");
  }
  if (isDate(reviewAfter) && !Number.isNaN(generatedDate.getTime()) && reviewAfter < generatedAt.slice(0, 10)) {
    issues.push("reviewAfter cannot be before generatedAt.");
  }
  if (clips.length < MIN_SNAPSHOT_EVIDENCE_CARDS) issues.push(`A verified snapshot needs at least ${MIN_SNAPSHOT_EVIDENCE_CARDS} evidence cards.`);
  if (snapshot.clipCount !== clips.length) issues.push("clipCount must equal the number of snapshot cards.");

  const videoIds = new Set<string>();
  const intents = new Set<ResearchIntent>();
  const coverageClips: Array<Pick<ResearchClip, "intent" | "video">> = [];
  for (const [index, rawClip] of clips.entries()) {
    const clip = asRecord(rawClip);
    if (!clip) {
      issues.push(`Card ${index + 1} is not an object.`);
      continue;
    }
    const video = asRecord(clip.video);
    const title = typeof clip.title === "string" ? clip.title.trim() : "";
    const takeaway = typeof clip.takeaway === "string" ? clip.takeaway.trim() : "";
    const quote = typeof clip.exactQuote === "string" ? clip.exactQuote.trim() : "";
    const context = `${typeof clip.contextText === "string" ? clip.contextText : ""} ${typeof clip.locationContext === "string" ? clip.locationContext : ""}`;
    const englishPresentation = asRecord(clip.englishPresentation);
    const startSeconds = clip.startSeconds;
    const endSeconds = clip.endSeconds;
    const videoId = typeof video?.id === "string" ? video.id : "";
    const publishedAt = video?.publishedAt;
    const timestampSource = typeof clip.youtubeTimestampSource === "string" ? clip.youtubeTimestampSource : "";
    const location = asRecord(clip.locationVerification);

    if (!REQUIRED_SNAPSHOT_INTENTS.includes(clip.intent as ResearchIntent)) issues.push(`Card ${index + 1} has an invalid category.`);
    else intents.add(clip.intent as ResearchIntent);
    const minimumTitleLength = CJK_PATTERN.test(normalizeResearchText(title)) ? 4 : 8;
    if (title.length < minimumTitleLength || GENERIC_TITLE_PATTERN.test(title)) issues.push(`Card ${index + 1} has a generic or missing title.`);
    if (typeof video?.title === "string" && normalizeResearchText(title) === normalizeResearchText(video.title)) issues.push(`Card ${index + 1} copies its video title instead of naming evidence.`);
    if (takeaway.length < 12) issues.push(`Card ${index + 1} needs a specific takeaway.`);
    if (quote.length < 24) issues.push(`Card ${index + 1} needs an exact transcript quote.`);
    if (title && quote && !hasTranscriptOverlap(title, quote, 1)) issues.push(`Card ${index + 1} title does not align with its exact transcript quote.`);
    if (takeaway && quote && !hasTranscriptOverlap(takeaway, quote, 2)) issues.push(`Card ${index + 1} takeaway does not align with its exact transcript quote.`);
    if (typeof startSeconds !== "number" || typeof endSeconds !== "number" || startSeconds < 0 || endSeconds <= startSeconds) issues.push(`Card ${index + 1} has invalid timestamps.`);
    if (!VIDEO_ID_PATTERN.test(videoId)) issues.push(`Card ${index + 1} has an invalid YouTube video ID.`);
    else {
      videoIds.add(videoId);
      if (REQUIRED_SNAPSHOT_INTENTS.includes(clip.intent as ResearchIntent)) {
        coverageClips.push({ intent: clip.intent as ResearchIntent, video: { id: videoId } } as Pick<ResearchClip, "intent" | "video">);
      }
    }
    if (typeof clip.id !== "string" || !clip.id.startsWith(`${videoId}-`)) issues.push(`Card ${index + 1} does not map its card ID to its YouTube video ID.`);
    if (typeof video?.title !== "string" || !video.title.trim() || typeof video.channelName !== "string" || !video.channelName.trim()) issues.push(`Card ${index + 1} is missing video or channel metadata.`);
    const presentationCandidate: Pick<ResearchClip, "language" | "video" | "englishPresentation"> = {
      language: typeof clip.language === "string" ? clip.language : "",
      video: {
        id: videoId,
        title: typeof video?.title === "string" ? video.title : "",
        channelName: typeof video?.channelName === "string" ? video.channelName : "",
        thumbnailUrl: typeof video?.thumbnailUrl === "string" ? video.thumbnailUrl : ""
      },
      englishPresentation: englishPresentation || undefined
    };
    if (!hasRequiredEnglishPresentation(presentationCandidate)) {
      issues.push(`Card ${index + 1} needs complete English display translations for a non-English source or channel.`);
    }
    if (!isDate(publishedAt)) issues.push(`Card ${index + 1} is missing a valid publication date.`);
    else if (!Number.isNaN(generatedDate.getTime()) && (!isRecentPublishedAt(publishedAt, generatedDate) || (isDate(sourceCutoffDate) && publishedAt < sourceCutoffDate))) issues.push(`Card ${index + 1} uses a video outside the two-year source window.`);
    if (!timestampSource || !timestampSource.includes(videoId) || !timestampSource.includes(`t=${Math.floor(Number(startSeconds))}`)) issues.push(`Card ${index + 1} lacks a matching YouTube timestamp source.`);
    if (typeof clip.frameDataUrl !== "string" && (typeof video?.thumbnailUrl !== "string" || !video.thumbnailUrl.trim())) issues.push(`Card ${index + 1} needs a frame or thumbnail.`);
    if (!location || !["same_place", "verified_nearby"].includes(location.status as string)) issues.push(`Card ${index + 1} has no completed location verification.`);
    else {
      const evidence = typeof location.evidence === "string" ? location.evidence : "";
      const evidenceSource = location.evidenceSource;
      if (evidenceSource !== undefined && evidenceSource !== "transcript" && evidenceSource !== "video_title") {
        issues.push(`Card ${index + 1} has an invalid location-evidence source.`);
      }
      const locationSourceText = evidenceSource === "video_title"
        ? typeof video?.title === "string" ? video.title : ""
        : `${quote} ${context}`;
      if (!normalizedIncludes(locationSourceText, evidence)) {
        issues.push(`Card ${index + 1} location evidence does not match its saved ${evidenceSource === "video_title" ? "video title" : "transcript context"}.`);
      }
    }
  }

  if (videoIds.size < MIN_SNAPSHOT_DISTINCT_VIDEOS) issues.push(`A verified snapshot needs evidence from at least ${MIN_SNAPSHOT_DISTINCT_VIDEOS} different videos.`);
  if (snapshot.sourceCount !== videoIds.size) issues.push("sourceCount must equal the distinct video count used by the cards.");
  const coverage = snapshotEvidenceCoverageIssues(coverageClips);
  issues.push(...coverage.issues);
  for (const intent of REQUIRED_SNAPSHOT_INTENTS) {
    if (!intents.has(intent)) issues.push(`Snapshot is missing required ${intent} evidence.`);
  }

  if (!verification) {
    issues.push("Snapshot requires verification-funnel totals.");
  } else {
    const candidateClips = verification.candidateClips;
    const evidenceMatches = verification.evidenceMatches;
    const verifiedClips = verification.verifiedClips;
    const rejectedEvidence = verification.rejectedEvidenceOrRanking;
    const rejectedLocation = verification.rejectedLocation;
    if (![candidateClips, evidenceMatches, verifiedClips, rejectedEvidence, rejectedLocation].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
      issues.push("Verification funnel totals must be non-negative numbers.");
    } else {
      const candidateCount = candidateClips as number;
      const evidenceCount = evidenceMatches as number;
      const verifiedCount = verifiedClips as number;
      const rejectedEvidenceCount = rejectedEvidence as number;
      const rejectedLocationCount = rejectedLocation as number;
      if (verifiedCount !== clips.length || evidenceCount - verifiedCount !== rejectedLocationCount || candidateCount - evidenceCount !== rejectedEvidenceCount) {
        issues.push("Verification funnel totals do not reconcile with the saved cards.");
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

export function makeVerifiedSnapshot(result: PlaceResearchResult): VerifiedSnapshot {
  const generatedAt = result.generatedAt;
  const generatedDate = new Date(generatedAt);
  const reviewAfter = new Date(generatedDate);
  reviewAfter.setUTCDate(reviewAfter.getUTCDate() + 7);
  const clips: SnapshotResearchClip[] = result.clips.map((clip) => ({
    ...clip,
    youtubeTimestampSource: `https://www.youtube.com/watch?v=${clip.video.id}&t=${Math.floor(clip.startSeconds)}s`
  }));
  return {
    ...result,
    snapshotVersion: 1,
    snapshotStatus: "verified",
    sourceCutoffDate: recentVideoCutoffDate(generatedDate),
    reviewAfter: reviewAfter.toISOString().slice(0, 10),
    demoSnapshot: true,
    cacheHit: true,
    sourceStatus: "verified_snapshot",
    clips,
    verification: result.verification || {
      videosFound: result.sourceCount,
      captionedVideos: result.sourceCount,
      candidateClips: result.clipCount,
      evidenceMatches: result.clipCount,
      verifiedClips: result.clipCount,
      rejectedEvidenceOrRanking: 0,
      rejectedLocation: 0
    }
  };
}

export function createVerifiedSnapshotRegistry(inputs: unknown[]) {
  const snapshots = new Map<string, VerifiedSnapshot>();
  const rejected: Array<{ snapshot: unknown; issues: string[] }> = [];
  for (const input of inputs) {
    const validation = validateVerifiedSnapshot(input);
    if (!validation.valid) {
      rejected.push({ snapshot: input, issues: validation.issues });
      continue;
    }
    const snapshot = input as VerifiedSnapshot;
    const key = snapshotKey(snapshot.place, snapshot.city);
    if (snapshots.has(key)) {
      rejected.push({ snapshot: input, issues: ["Duplicate public snapshot place and city."] });
      continue;
    }
    snapshots.set(key, snapshot);
  }
  return { snapshots, rejected };
}

const registryEntries = asRecord(snapshotRegistryData)?.entries;
const publicSnapshotInputs = Array.isArray(registryEntries)
  ? registryEntries.flatMap((entry) => {
    const record = asRecord(entry);
    return record?.snapshot ? [record.snapshot] : [];
  })
  : [];

const parsedRegistry = createVerifiedSnapshotRegistry(publicSnapshotInputs);

/** Invalid data is never exposed through this registry. Diagnostics stay server-side for tests and generator QA. */
export const verifiedSnapshotRegistry = parsedRegistry.snapshots;
export const rejectedRegistrySnapshots = parsedRegistry.rejected;

export function getVerifiedSnapshot(place: string, city: string) {
  return verifiedSnapshotRegistry.get(snapshotKey(place, city)) || null;
}

export function snapshotResultForReplay(snapshot: VerifiedSnapshot): PlaceResearchResult {
  return {
    ...snapshot,
    cacheHit: true,
    sourceStatus: "verified_snapshot"
  };
}
