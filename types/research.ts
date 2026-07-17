export type ResearchIntent = "why_visit" | "activity" | "food" | "practical_tip";

export type ResearchVideo = {
  id: string;
  title: string;
  channelName: string;
  thumbnailUrl: string;
  publishedAt?: string;
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
  video: ResearchVideo;
  locationVerification?: {
    poiName: string;
    relationship: "queried_place" | "inside" | "nearby";
    evidence: string;
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
  mode: "ai" | "extractive";
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
};

export type ResearchStage = "search" | "screen" | "captions" | "extract" | "synthesize" | "complete";

export type ResearchStreamEvent =
  | { type: "progress"; stage: ResearchStage; message: string; completed: number; total: number; elapsedMs: number }
  | { type: "partial_result"; result: PlaceResearchResult }
  | { type: "result"; result: PlaceResearchResult }
  | { type: "error"; message: string; recoverable: boolean };
