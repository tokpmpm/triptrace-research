export type ResearchIntent = "why_visit" | "activity" | "food" | "practical_tip";

export type ResearchSourceStatus = "verified_snapshot" | "runtime_cache" | "local_research" | "source_unavailable" | "legacy_fixture";

export type ResearchVideo = {
  id: string;
  title: string;
  channelName: string;
  thumbnailUrl: string;
  publishedAt?: string;
};

/**
 * English display copy for a source whose original captions or creator metadata
 * are not in English. The original title, transcript, and timestamp remain on
 * the clip for validation and source inspection.
 */
export type EnglishPresentation = {
  title?: string;
  takeaway?: string;
  exactQuote?: string;
  highlights?: string[];
  channelName?: string;
};

export type ResearchClip = {
  id: string;
  intent: ResearchIntent;
  title: string;
  takeaway: string;
  startSeconds: number;
  endSeconds: number;
  exactQuote: string;
  contextText: string;
  locationContext?: string;
  highlights?: string[];
  frameDataUrl?: string;
  frameSeconds?: number;
  captionTrack: "creator" | "automatic";
  language: string;
  englishPresentation?: EnglishPresentation;
  video: ResearchVideo;
  locationVerification?: {
    poiName: string;
    relationship: "queried_place" | "inside" | "nearby";
    evidence: string;
    /** Whether the inspectable location proof came from captions or title metadata. */
    evidenceSource?: "transcript" | "video_title";
    status: "pending" | "same_place" | "verified_nearby";
    distanceMeters: number;
  };
};

export type PlaceResearchResult = {
  place: string;
  city: string;
  overview: string;
  generatedAt: string;
  cacheHit: boolean;
  sourceCount: number;
  clipCount: number;
  clips: ResearchClip[];
  suggestedPlan: string[];
  warnings: string[];
  mode: "ai" | "extractive" | "fixture" | "source_unavailable";
  aiModel?: string;
  verification?: {
    videosFound: number;
    captionedVideos: number;
    candidateClips: number;
    evidenceMatches: number;
    verifiedClips: number;
    rejectedEvidenceOrRanking: number;
    rejectedLocation: number;
  };
  demoSnapshot?: boolean;
  sourceStatus?: ResearchSourceStatus;
  sourceUnavailable?: {
    code: "no_snapshot_or_cache";
    message: string;
  };
};

export type SnapshotResearchClip = ResearchClip & {
  /** A stable, inspectable YouTube URL for the same timestamp as startSeconds. */
  youtubeTimestampSource: string;
};

export type VerifiedSnapshot = Omit<PlaceResearchResult, "clips" | "verification" | "demoSnapshot"> & {
  snapshotVersion: 1;
  snapshotStatus: "verified";
  /** The strict rolling two-year date used while collecting sources. */
  sourceCutoffDate: string;
  /** A date after which the saved research should be regenerated locally. */
  reviewAfter: string;
  /** Public snapshots are deliberately labelled as saved demo research. */
  demoSnapshot: true;
  clips: SnapshotResearchClip[];
  verification: NonNullable<PlaceResearchResult["verification"]>;
};

export type ResearchStage = "search" | "screen" | "captions" | "extract" | "synthesize" | "complete";

export type ResearchStreamEvent =
  | { type: "progress"; stage: ResearchStage; message: string; completed: number; total: number; elapsedMs: number }
  | { type: "partial_result"; result: PlaceResearchResult }
  | { type: "result"; result: PlaceResearchResult }
  | { type: "error"; message: string; recoverable: boolean };
