import "server-only";

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import sharp from "sharp";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import taipei101Demo from "@/data/taipei-101-demo.json";
import { applySemanticClipAnalyses, buildExtractiveResearchResult, buildVerifiedResearchResult, extractResearchClips, hasRequiredEnglishPresentation, inScopePlaceAliases, isRecentPublishedAt, normalizeResearchText, parseResearchJson3, reconcileVerificationCounts, selectBalancedEvidenceClips, selectSnapshotEvidenceClips, type ResearchVideoTranscript, type SemanticClipAnalysis } from "@/lib/research-core";
import { verifyResearchLocations } from "@/lib/geospatial";
import { getOpenAIClient, OPENAI_MODEL, PRODUCTION_OPENAI_MODEL, TRIPTRACE_RUNTIME, TRIPTRACE_TEST_MODE } from "@/lib/openai";
import { getVerifiedSnapshot, MIN_SNAPSHOT_DISTINCT_VIDEOS, MIN_SNAPSHOT_VIDEOS_PER_INTENT, REQUIRED_SNAPSHOT_INTENTS, snapshotResultForReplay, snapshotVideoCountsByIntent } from "@/lib/snapshots";
import type { PlaceResearchResult, ResearchClip, ResearchIntent, VerifiedSnapshot } from "@/types/research";

const execFileAsync = promisify(execFile);
const CACHE_VERSION = "v14-recent-video-timestamps";
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CANDIDATES_TO_PROBE = 32;
const MAX_SELECTED_VIDEOS = 10;
const SNAPSHOT_SEARCH_RESULT_LIMIT = 50;
// Snapshot creation is intentionally broader than a normal live research
// request. It remains serial, but screens enough independent sources to meet
// the two-videos-per-category publication bar without recycling a cache.
const SNAPSHOT_MAX_CANDIDATES_TO_PROBE = 32;
const SNAPSHOT_MAX_SELECTED_VIDEOS = 18;
const ALL_INTENTS: ResearchIntent[] = ["why_visit", "activity", "food", "practical_tip"];
const MIN_VERIFIED_SOURCES = 4;
const TARGET_VERIFIED_SOURCES = 6;
const CACHE_ROOT = process.env.TRIPTRACE_CACHE_DIR || path.join(/*turbopackIgnore: true*/ os.tmpdir(), "triptrace-research");

export class YouTubeBotChallengeError extends Error {
  constructor() {
    super("YouTube requested bot verification. TripTrace will not bypass that protection.");
    this.name = "YouTubeBotChallengeError";
  }
}

export function isCloudRunProduction() {
  return TRIPTRACE_RUNTIME === "production" || Boolean(process.env.K_SERVICE);
}

type ProgressCallback = (stage: "search" | "screen" | "captions" | "extract" | "synthesize" | "complete", message: string, completed: number, total: number) => void;

const CACHED_PROGRESS_REPLAY = [
  ["search", "Checking the saved research for this place…", 0],
  ["screen", "Rechecking the saved video-source coverage…", 1],
  ["captions", "Loading the saved timed-caption evidence…", 2],
  ["extract", "Restoring the verified transcript matches…", 3],
  ["synthesize", "Preparing the saved source-backed visit outline…", 4]
] as const;

async function replayCachedProgress(onProgress: ProgressCallback, signal: AbortSignal) {
  for (const [stage, message, completed] of CACHED_PROGRESS_REPLAY) {
    onProgress(stage, message, completed, 5);
    await wait(800, undefined, { signal });
  }
}

type SearchCandidate = {
  id: string;
  title: string;
  channelName: string;
  publishedAt?: string;
  score: number;
  intents: Set<ResearchIntent>;
  pinned?: boolean;
};

type ProbedVideo = {
  id: string;
  title: string;
  channelName: string;
  thumbnailUrl: string;
  publishedAt?: string;
  duration: number;
  language: string;
  captionTrack: "creator" | "automatic";
  searchIntents: ResearchIntent[];
  score: number;
  pinned?: boolean;
  storyboard?: StoryboardFormat;
};

type StoryboardFormat = {
  width: number;
  height: number;
  fps: number;
  rows: number;
  columns: number;
  fragments: Array<{ url: string; duration: number }>;
};

const PLACE_ALIASES: Array<{ match: string[]; terms: string[] }> = [
  { match: ["ximending", "ximen", "西門町"], terms: ["Ximending", "Ximen", "Ximen Pedestrian Area", "西門町"] },
  { match: ["dadaocheng", "大稻埕"], terms: ["Dadaocheng", "Dadaocheng Wharf", "大稻埕"] },
  { match: ["shilin night market", "士林夜市"], terms: ["Shilin Night Market", "Shilin", "士林夜市"] },
  { match: ["taipei 101", "taipei101"], terms: ["Taipei 101", "Taipei 101 Observatory"] }
];

// These are discovery-only public-search queries for the four demo places.
// They are deliberately split by intent rather than cramming every term into
// one query. Semantic and geospatial checks still reject a video when its
// transcript is actually about somewhere else.
const SNAPSHOT_DISCOVERY_QUERIES: Record<string, Record<ResearchIntent, { initial: string[]; refill: string[] }>> = {
  "taipei 101": {
    why_visit: { initial: ["Taipei 101 observatory travel guide", "Taipei 101 architecture skyline tour"], refill: ["Taipei 101 view Taiwan travel vlog", "Taipei 101 landmark city skyline"] },
    activity: { initial: ["Taipei 101 observation deck elevator tour", "Taipei 101 damper terrace observatory"], refill: ["Taipei 101 observatory wind damper tour", "Taipei 101 observation deck experience"] },
    food: { initial: ["Taipei 101 food court", "Taipei 101 restaurants food tour"], refill: ["Taipei 101 food hall Taiwan vlog", "Taipei 101 Taiwanese restaurant food"] },
    practical_tip: { initial: ["Taipei 101 tickets queue MRT visit tips", "Taipei 101 opening hours ticket guide"], refill: ["Taipei 101 Metro travel guide", "Taipei 101 visit planning tips"] }
  },
  ximending: {
    why_visit: { initial: ["Ximending Taipei travel guide nightlife", "Ximending pedestrian district tour"], refill: ["Ximending history culture travel", "Ximending Taipei district guide"] },
    activity: { initial: ["Ximending shopping Red House things to do", "Ximending walking tour attractions"], refill: ["Ximending Red House theater shopping tour", "Ximending youth shopping experience"] },
    food: { initial: ["Ximending Taipei food tour", "Ximending street food Taipei"], refill: ["Ximending Taiwanese snacks food vlog", "Ximending restaurant local food"] },
    practical_tip: { initial: ["Ximending MRT crowds travel tips", "Ximending visit guide late night"], refill: ["Ximending Taipei how to get there MRT", "西門町 捷運 人潮 交通"] }
  },
  dadaocheng: {
    why_visit: { initial: ["Dadaocheng Taipei history travel guide", "Dadaocheng Dihua Street heritage tour"], refill: ["Dadaocheng old Taipei travel", "Dadaocheng heritage district tour"] },
    activity: { initial: ["Dadaocheng Wharf sunset travel", "Dadaocheng Dihua Street walking tour"], refill: ["Dadaocheng Dihua Street walking tour 2025", "大稻埕 迪化街 散步 景點"] },
    food: { initial: ["Dadaocheng Dihua Street food tour", "Dadaocheng Taipei food snacks"], refill: ["大稻埕 迪化街 蚵嗲 油飯 美食", "大稻埕 迪化街 必吃 小吃 2025"] },
    practical_tip: { initial: ["Dadaocheng Wharf MRT ferry travel tips", "Dadaocheng visit guide opening hours"], refill: ["大稻埕 迪化街 怎麼去 捷運 北門站", "大稻埕 碼頭 怎麼去 捷運 大橋頭站"] }
  },
  "shilin night market": {
    why_visit: { initial: ["Shilin Night Market Taipei travel guide", "Shilin Night Market walking tour"], refill: ["Shilin Night Market famous Taipei guide", "Shilin Night Market atmosphere Taipei"] },
    activity: { initial: ["Shilin Night Market games shopping tour", "Shilin Night Market things to do"], refill: ["Shilin Night Market arcade claw games", "Shilin Night Market shopping clothes"] },
    food: { initial: ["Shilin Night Market food tour Taipei", "Shilin Night Market street food"], refill: ["Shilin Night Market oyster omelette food", "Shilin Night Market snacks tour"] },
    practical_tip: { initial: ["Shilin Night Market MRT crowds travel tips", "Shilin Night Market visit guide hours"], refill: ["Shilin Night Market Jiantan MRT exit", "Shilin Night Market crowds visit tips"] }
  }
};

// These IDs were found through the same ordinary public search path used by
// the generator, then independently checked for recency and caption metadata.
// They are discovery hints only: every one still goes through the normal probe,
// timed-caption extraction, semantic review, and location verification before
// it can become snapshot evidence.
const SNAPSHOT_PINNED_CANDIDATES: Record<string, Partial<Record<ResearchIntent, string[]>>> = {
  dadaocheng: {
    food: ["2xMEkcpCgqA"],
    // Recent public candidates discovered locally. They remain hints only;
    // extraction, deterministic validation, semantic review, and geographic
    // verification below decide whether any evidence is retained.
    activity: ["gBV3XgzzBC0", "_8C7a7m6CdY"],
    practical_tip: ["gBV3XgzzBC0", "_8C7a7m6CdY", "2xMEkcpCgqA", "E8g7sl65TyM"]
  }
};

function placeSearchTerms(place: string) {
  const normalized = normalizeResearchText(place);
  const alias = PLACE_ALIASES.find((entry) => entry.match.some((term) => normalized.includes(normalizeResearchText(term))));
  return [...new Set([place.trim(), ...(alias?.terms || [])].filter(Boolean))].slice(0, 3);
}

function snapshotDiscoveryQueries(place: string, intent: ResearchIntent, refill: boolean) {
  const configured = SNAPSHOT_DISCOVERY_QUERIES[normalizeResearchText(place)]?.[intent];
  return configured?.[refill ? "refill" : "initial"] || [];
}

function snapshotPinnedCandidates(place: string, intent: ResearchIntent) {
  return SNAPSHOT_PINNED_CANDIDATES[normalizeResearchText(place)]?.[intent] || [];
}

const semanticAnalysisSchema = z.object({
  items: z.array(z.object({
    clipId: z.string(),
    intent: z.enum(["why_visit", "activity", "food", "practical_tip"]),
    primarySubject: z.string().min(3).max(50),
    title: z.string().min(4).max(80),
    takeaway: z.string().min(12).max(220),
    supportQuote: z.string().min(12).max(260),
    highlights: z.array(z.string().min(2).max(50)).max(3),
    mentionOnly: z.boolean(),
    placeRelevant: z.boolean(),
    confidence: z.number().min(0).max(1),
    poiName: z.string().min(2).max(100).nullable(),
    locationRelationship: z.enum(["queried_place", "inside", "nearby", "different_area", "unknown"]),
    locationEvidence: z.string().min(3).max(260).nullable(),
    locationEvidenceSource: z.enum(["transcript", "video_title"]).nullable(),
    englishPresentation: z.object({
      title: z.string().min(4).max(100),
      takeaway: z.string().min(12).max(260),
      exactQuote: z.string().min(12).max(320),
      highlights: z.array(z.string().min(2).max(80)).min(1).max(4),
      channelName: z.string().min(2).max(120)
    }).nullable()
  })).min(1).max(16)
});
// Keep each structured response comfortably below the schema's 16-item
// maximum. Snapshot generation can legitimately collect more evidence before
// the final selection, so semantic verification must process it serially.
const SEMANTIC_BATCH_SIZE = 12;
const PRODUCTION_SEMANTIC_BATCH_SIZE = 8;

async function resolveYtDlp() {
  if (process.env.YT_DLP_BIN) return process.env.YT_DLP_BIN;
  const userInstall = path.join(/*turbopackIgnore: true*/ os.homedir(), ".local/bin/yt-dlp");
  try {
    await fs.access(userInstall);
    return userInstall;
  } catch {
    return "yt-dlp";
  }
}

function errorDetails(error: unknown) {
  const candidate = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
  return [candidate?.message, candidate?.stdout, candidate?.stderr]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function isBotChallenge(error: unknown) {
  return /sign in to confirm you(?:'|’)re not a bot|confirm you(?:'|’)re not a bot|bot verification/i.test(errorDetails(error));
}

export async function localYtDlpStatus() {
  if (isCloudRunProduction()) return { available: false, reason: "Local snapshot generation is disabled in Cloud Run production." };
  const binary = await resolveYtDlp();
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
    return { available: true, version: stdout.trim() };
  } catch (error) {
    return { available: false, reason: errorDetails(error).split("\n")[0] || "yt-dlp is not available." };
  }
}

async function runYtDlp(args: string[], signal: AbortSignal, timeout = 35_000) {
  if (isCloudRunProduction()) {
    throw new Error("Live YouTube research is disabled in Cloud Run production. Use a verified snapshot or a valid runtime cache.");
  }
  const binary = await resolveYtDlp();
  try {
    // Use yt-dlp's ordinary default behavior only. Do not select alternative
    // player clients, inject cookies, or otherwise try to work around a
    // platform-protection response.
    const { stdout } = await execFileAsync(binary, ["--no-warnings", ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout,
      signal
    });
    return stdout;
  } catch (error) {
    if (isBotChallenge(error)) throw new YouTubeBotChallengeError();
    throw error;
  }
}

function parseJsonLines<T>(value: string): T[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as T]; } catch { return []; }
  });
}

function preferredCaptionTrack(record: Record<string, unknown> | undefined) {
  if (!record) return undefined;
  const keys = Object.keys(record);
  const preferred = ["en", "en-GB", "en-US", "en-orig", "zh-Hant", "zh-TW", "zh-Hans", "zh-CN", "zh"];
  return preferred.find((key) => keys.includes(key))
    || keys.find((key) => /^en(?:-|$)/i.test(key))
    || keys.find((key) => /^zh(?:-|$)/i.test(key));
}

function bestStoryboard(formats: unknown): StoryboardFormat | undefined {
  if (!Array.isArray(formats)) return undefined;
  return formats.flatMap((format) => {
    const item = format as Partial<StoryboardFormat> & { format_note?: string };
    if (item.format_note !== "storyboard" || !item.width || !item.height || !item.fps || !item.rows || !item.columns || !Array.isArray(item.fragments)) return [];
    const fragments = item.fragments.flatMap((fragment) => fragment && typeof fragment.url === "string" && typeof fragment.duration === "number" ? [{ url: fragment.url, duration: fragment.duration }] : []);
    if (!fragments.length) return [];
    return [{ width: item.width, height: item.height, fps: item.fps, rows: item.rows, columns: item.columns, fragments }];
  }).sort((a, b) => b.width - a.width)[0];
}

async function inBatches<T, R>(items: T[], batchSize: number, task: (item: T) => Promise<R | null>) {
  const output: R[] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = await Promise.all(items.slice(index, index + batchSize).map(task));
    for (const item of batch) {
      if (item !== null) output.push(item);
    }
  }
  return output;
}

function researchBatchSize(defaultSize: number) {
  return process.env.TRIPTRACE_SNAPSHOT_GENERATOR === "1" ? 1 : defaultSize;
}

function isSnapshotGeneratorRun() {
  return process.env.TRIPTRACE_SNAPSHOT_GENERATOR === "1";
}

async function searchCandidates(place: string, city: string, signal: AbortSignal, options: {
  intents?: ResearchIntent[];
  excludeIds?: Set<string>;
  refill?: boolean;
  maxCandidates?: number;
  relatedTerms?: string[];
} = {}) {
  const intents = options.intents?.length ? options.intents : ALL_INTENTS;
  const snapshotGenerator = isSnapshotGeneratorRun();
  const searchLimit = options.refill ? 22 : snapshotGenerator ? SNAPSHOT_SEARCH_RESULT_LIMIT : 20;
  const searchPlaces = placeSearchTerms(place);
  const activeSearchPlaces = snapshotGenerator ? searchPlaces.slice(0, 1) : searchPlaces;
  const querySuffixes: Record<ResearchIntent, string[]> = {
    why_visit: ["history culture architecture worth visiting", "travel guide atmosphere heritage local experience"],
    activity: ["things to do walking tour attractions", "shops temple pier sunset itinerary nightlife experience"],
    food: ["food guide street food restaurants", "what to eat local food market dishes"],
    practical_tip: ["travel tips crowds queue transport", "best time visit opening hours how to get there"]
  };
  const refillSuffixes: Record<ResearchIntent, string> = {
    why_visit: "why visit history heritage local guide",
    activity: "walking tour itinerary attractions experience",
    food: "food tour breakfast restaurants local dishes",
    practical_tip: "walking tour advice arrive early queue station"
  };
  const searches = intents.flatMap((intent) => {
    if (snapshotGenerator) {
      const targetedQueries = snapshotDiscoveryQueries(place, intent, Boolean(options.refill));
      if (targetedQueries.length) return targetedQueries.map((query) => ({ intent, query }));
    }
    const suffixes = options.refill
      ? snapshotGenerator
        ? [querySuffixes[intent][1], refillSuffixes[intent]]
        : [...querySuffixes[intent], refillSuffixes[intent]]
      : querySuffixes[intent];
    const activeSuffixes = suffixes;
    return activeSuffixes.flatMap((suffix) => activeSearchPlaces.map((searchPlace) => ({ intent, query: `${searchPlace} ${city} ${suffix}` })));
  });
  if (options.refill && !snapshotGenerator) {
    for (const intent of intents) {
      for (const term of (options.relatedTerms || []).slice(0, snapshotGenerator ? 1 : 2)) {
        searches.push({ intent, query: `${searchPlaces[0]} ${term} ${city} ${refillSuffixes[intent]}` });
      }
    }
  }
  const resultSets = await inBatches(searches, researchBatchSize(4), async ({ intent, query }) => {
    // ytsearch treats an `after:` string as ordinary text, so date eligibility
    // is enforced from each video's actual metadata after discovery instead.
    const output = await runYtDlp(["--flat-playlist", "--playlist-end", String(searchLimit), "--dump-json", `ytsearch${searchLimit}:${query}`], signal, snapshotGenerator ? 15_000 : 30_000);
    return { intent, entries: parseJsonLines<{ id?: string; title?: string; channel?: string; upload_date?: string }>(output) };
  });

  const byId = new Map<string, SearchCandidate>();
  for (const { intent, entries } of resultSets) {
    entries.forEach((entry, index) => {
      if (!entry.id || !entry.title) return;
      const publishedAt = entry.upload_date && /^\d{8}$/.test(entry.upload_date)
        ? `${entry.upload_date.slice(0, 4)}-${entry.upload_date.slice(4, 6)}-${entry.upload_date.slice(6, 8)}`
        : undefined;
      if (publishedAt && !isRecentPublishedAt(publishedAt)) return;
      if (options.excludeIds?.has(entry.id)) return;
      const normalizedTitle = normalizeResearchText(entry.title);
      const placeTitleBonus = searchPlaces.some((term) => normalizedTitle.includes(normalizeResearchText(term))) ? 8 : 0;
      const existing = byId.get(entry.id);
      if (existing) {
        existing.intents.add(intent);
        existing.score += Math.max(1, searchLimit - index) + placeTitleBonus;
        existing.publishedAt ||= publishedAt;
      } else {
        byId.set(entry.id, {
          id: entry.id,
          title: entry.title,
          channelName: entry.channel || "Unknown channel",
          publishedAt,
          score: Math.max(1, searchLimit - index) + placeTitleBonus,
          intents: new Set([intent])
        });
      }
    });
  }
  if (snapshotGenerator) {
    for (const intent of intents) {
      for (const id of snapshotPinnedCandidates(place, intent)) {
        if (options.excludeIds?.has(id)) continue;
        const existing = byId.get(id);
        if (existing) {
          existing.intents.add(intent);
          existing.score += searchLimit + 30;
          existing.pinned = true;
          continue;
        }
        byId.set(id, {
          id,
          title: `Direct public candidate for ${place}`,
          channelName: "Unknown channel",
          score: searchLimit + 30,
          intents: new Set([intent]),
          pinned: true
        });
      }
    }
  }

  // Locally inspected public candidates are intentionally considered before
  // broad search results. They still pass every metadata, caption, semantic,
  // and location gate below; this merely prevents a repeated query from
  // crowding a known candidate out of the bounded serial probe budget.
  const ranked = [...byId.values()].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.score - a.score);
  const selected: SearchCandidate[] = [];
  const maxCandidates = options.maxCandidates || (snapshotGenerator ? SNAPSHOT_MAX_CANDIDATES_TO_PROBE : MAX_CANDIDATES_TO_PROBE);
  for (const intent of intents) {
    for (const candidate of ranked.filter((item) => item.intents.has(intent)).slice(0, 4)) {
      if (!selected.some((item) => item.id === candidate.id)) selected.push(candidate);
      if (selected.length >= maxCandidates) break;
    }
    if (selected.length >= maxCandidates) break;
  }
  for (const candidate of ranked) {
    if (selected.length >= maxCandidates) break;
    if (!selected.some((item) => item.id === candidate.id)) selected.push(candidate);
  }
  return selected;
}

async function probeCandidate(candidate: SearchCandidate, signal: AbortSignal): Promise<ProbedVideo | null> {
  try {
    const output = await runYtDlp(["--skip-download", "--no-playlist", "--dump-single-json", `https://www.youtube.com/watch?v=${candidate.id}`], signal, isSnapshotGeneratorRun() ? 15_000 : 32_000);
    const info = JSON.parse(output) as {
      id?: string; title?: string; channel?: string; thumbnail?: string; upload_date?: string; duration?: number; playable_in_embed?: boolean;
      subtitles?: Record<string, unknown>; automatic_captions?: Record<string, unknown>;
      formats?: unknown;
    };
    if (!info.id || !info.title || !info.channel || info.playable_in_embed === false || !info.duration || info.duration < 90 || info.duration > 3600) return null;
    const publishedAt = info.upload_date && /^\d{8}$/.test(info.upload_date)
      ? `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}`
      : candidate.publishedAt;
    if (!isRecentPublishedAt(publishedAt)) return null;
    const creatorLanguage = preferredCaptionTrack(info.subtitles);
    const automaticLanguage = preferredCaptionTrack(info.automatic_captions);
    const language = creatorLanguage || automaticLanguage;
    if (!language || !/^[a-zA-Z0-9_-]+$/.test(language)) return null;
    return {
      id: info.id,
      title: info.title,
      channelName: info.channel,
      thumbnailUrl: info.thumbnail || `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`,
      publishedAt,
      duration: info.duration,
      language,
      captionTrack: creatorLanguage ? "creator" : "automatic",
      searchIntents: [...candidate.intents],
      score: candidate.score + (creatorLanguage ? 8 : 0),
      pinned: candidate.pinned,
      storyboard: bestStoryboard(info.formats)
    };
  } catch (error) {
    if (error instanceof YouTubeBotChallengeError) throw error;
    const message = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 500) : "unknown error";
    console.warn("[research-place] video probe failed", { videoId: candidate.id, message });
    return null;
  }
}

function chooseVideos(videos: ProbedVideo[], intents: ResearchIntent[] = ALL_INTENTS, maxVideos = MAX_SELECTED_VIDEOS) {
  const ranked = [...videos].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.score - a.score);
  const selected: ProbedVideo[] = [];
  const addCandidate = (candidate: ProbedVideo) => {
    if (selected.length >= maxVideos || selected.some((item) => item.id === candidate.id)) return;
    selected.push(candidate);
  };
  for (const intent of intents) {
    const candidate = ranked.find((video) => video.searchIntents.includes(intent) && !selected.some((item) => item.id === video.id) && !selected.some((item) => item.channelName === video.channelName));
    if (candidate) addCandidate(candidate);
  }
  for (const candidate of ranked) {
    if (selected.length >= maxVideos) break;
    if (!selected.some((item) => item.id === candidate.id) && !selected.some((item) => item.channelName === candidate.channelName)) addCandidate(candidate);
  }
  for (const candidate of ranked) {
    if (selected.length >= maxVideos) break;
    addCandidate(candidate);
  }
  return selected;
}

async function downloadTranscript(video: ProbedVideo, cacheDir: string, signal: AbortSignal): Promise<ResearchVideoTranscript | null> {
  const subtitlePath = path.join(/*turbopackIgnore: true*/ cacheDir, `${video.id}.${video.language}.json3`);
  try {
    await fs.access(subtitlePath);
  } catch {
    const captionFlag = video.captionTrack === "creator" ? "--write-subs" : "--write-auto-subs";
    try {
      await runYtDlp([
        "--skip-download", captionFlag, "--sub-langs", video.language, "--sub-format", "json3", "--force-overwrites",
        "-o", path.join(/*turbopackIgnore: true*/ cacheDir, "%(id)s.%(ext)s"), `https://www.youtube.com/watch?v=${video.id}`
      ], signal, isSnapshotGeneratorRun() ? 25_000 : 45_000);
    } catch (error) {
      if (error instanceof YouTubeBotChallengeError) throw error;
      return null;
    }
  }
  try {
    const document = JSON.parse(await fs.readFile(subtitlePath, "utf8"));
    const cues = parseResearchJson3(document);
    if (cues.length < 8) return null;
    return {
      id: video.id,
      title: video.title,
      channelName: video.channelName,
      thumbnailUrl: video.thumbnailUrl,
      publishedAt: video.publishedAt,
      captionTrack: video.captionTrack,
      language: video.language,
      searchIntents: video.searchIntents,
      cues
    };
  } catch {
    return null;
  }
}

async function attachStoryboardFrames(clips: ResearchClip[], videos: ProbedVideo[], signal: AbortSignal) {
  // A thumbnail is already retained for every clip. Snapshot generation avoids
  // a second network fan-out for optional storyboards and remains strictly
  // sequential; the final validator accepts either evidence frame or thumbnail.
  if (isSnapshotGeneratorRun()) return clips;
  const byVideoId = new Map(videos.map((video) => [video.id, video]));
  const spriteCache = new Map<string, Promise<Buffer | null>>();
  const loadSprite = (url: string) => {
    const existing = spriteCache.get(url);
    if (existing) return existing;
    const request = fetch(url, { signal }).then(async (response) => response.ok ? Buffer.from(await response.arrayBuffer()) : null).catch(() => null);
    spriteCache.set(url, request);
    return request;
  };

  return inBatches(clips, researchBatchSize(3), async (clip) => {
    const storyboard = byVideoId.get(clip.video.id)?.storyboard;
    if (!storyboard) return clip;
    let elapsed = 0;
    const fragment = storyboard.fragments.find((item) => {
      const containsTime = clip.startSeconds < elapsed + item.duration;
      if (!containsTime) elapsed += item.duration;
      return containsTime;
    });
    if (!fragment) return clip;
    const frameCount = storyboard.rows * storyboard.columns;
    const frameIndex = Math.min(frameCount - 1, Math.max(0, Math.round((clip.startSeconds - elapsed) * storyboard.fps)));
    const sprite = await loadSprite(fragment.url);
    if (!sprite) return clip;
    try {
      const frame = await sharp(sprite).extract({
        left: (frameIndex % storyboard.columns) * storyboard.width,
        top: Math.floor(frameIndex / storyboard.columns) * storyboard.height,
        width: storyboard.width,
        height: storyboard.height
      }).jpeg({ quality: 84 }).toBuffer();
      return {
        ...clip,
        frameDataUrl: `data:image/jpeg;base64,${frame.toString("base64")}`,
        frameSeconds: Math.round(elapsed + frameIndex / storyboard.fps)
      };
    } catch {
      return clip;
    }
  });
}

// Bump whenever the evidence contract or source-language instructions change;
// cached model output must never outlive the rules used to validate it.
const SEMANTIC_PROMPT_VERSION = "semantic-v12-english-presentation";

function semanticCachePathForModel(cachePath: string, model: string) {
  const extension = path.extname(cachePath) || ".json";
  const base = path.basename(cachePath, extension);
  const modelSlug = model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return path.join(path.dirname(cachePath), `${base}.${modelSlug}${extension}`);
}

function semanticEvidenceHash(result: PlaceResearchResult, clip: ResearchClip, model: string) {
  return crypto.createHash("sha256").update(JSON.stringify({
    version: SEMANTIC_PROMPT_VERSION,
    model,
    place: result.place,
    city: result.city,
    clip: { id: clip.id, title: clip.video.title, quote: clip.exactQuote, context: clip.contextText }
  })).digest("hex");
}

async function synthesizeResult(result: PlaceResearchResult, semanticCachePath: string, model = OPENAI_MODEL, onModelUse?: (model: string) => void): Promise<PlaceResearchResult> {
  if (!result.clips.length) return result;
  // Development exploration and Luna final verification must never overwrite
  // each other's cached assessments. They have different prompts and quality
  // gates even when they review the same timed-caption clip.
  const modelSemanticCachePath = semanticCachePathForModel(semanticCachePath, model);
  type SemanticCacheEntry = { evidenceHash: string; analysis: SemanticClipAnalysis };
  let cacheEntries: SemanticCacheEntry[] = [];
  try {
    const cached = JSON.parse(await fs.readFile(modelSemanticCachePath, "utf8")) as { version?: string; model?: string; entries?: unknown };
    if (cached.version === SEMANTIC_PROMPT_VERSION && cached.model === model && Array.isArray(cached.entries)) {
      cacheEntries = cached.entries.flatMap((entry) => {
        const candidate = entry as Partial<SemanticCacheEntry>;
        const parsed = semanticAnalysisSchema.safeParse({ items: [candidate.analysis] });
        return typeof candidate.evidenceHash === "string" && parsed.success
          ? [{ evidenceHash: candidate.evidenceHash, analysis: parsed.data.items[0] }]
          : [];
      });
    }
  } catch {
    // No reusable per-clip semantic cache exists yet.
  }
  const cachedByHash = new Map(cacheEntries.map((entry) => [entry.evidenceHash, entry.analysis]));
  const cachedAnalyses = result.clips.flatMap((clip) => {
    const analysis = cachedByHash.get(semanticEvidenceHash(result, clip, model));
    return analysis ? [analysis] : [];
  });
  const pendingClips = result.clips.filter((clip) => !cachedByHash.has(semanticEvidenceHash(result, clip, model)));
  if (!pendingClips.length) return { ...applySemanticClipAnalyses(result, cachedAnalyses), aiModel: model };

  const client = getOpenAIClient();
  if (!client) {
    return {
      ...result,
      warnings: ["AI verification was skipped; showing exact transcript matches without model-written claims.", ...result.warnings],
      aiModel: undefined,
      mode: "extractive" as const
    };
  }
  try {
    const newEntries: SemanticCacheEntry[] = [];
    const scopeAliases = inScopePlaceAliases(result.place);
    const persistSemanticEntries = async () => {
      const mergedEntries = new Map([...cacheEntries, ...newEntries].map((entry) => [entry.evidenceHash, entry]));
      await fs.writeFile(modelSemanticCachePath, `${JSON.stringify({ version: SEMANTIC_PROMPT_VERSION, model, entries: [...mergedEntries.values()] }, null, 2)}\n`, "utf8");
    };
    const batchSize = model === PRODUCTION_OPENAI_MODEL ? PRODUCTION_SEMANTIC_BATCH_SIZE : SEMANTIC_BATCH_SIZE;
    for (let offset = 0; offset < pendingClips.length; offset += batchSize) {
      const batch = pendingClips.slice(offset, offset + batchSize);
      onModelUse?.(model);
      const response = await client.responses.parse({
        model,
        // Keep enough room for the structured payload. GPT-5 models count hidden
        // reasoning against this limit, which previously left Luna with no JSON.
        reasoning: { effort: "low" },
        max_output_tokens: 8_000,
        prompt_cache_key: `triptrace-semantic-${model}`,
        ...(model === PRODUCTION_OPENAI_MODEL ? { prompt_cache_options: { mode: "implicit" as const, ttl: "30m" as const } } : {}),
        input: [
          { role: "system", content: `Analyze travel-video clips conservatively. Use only the supplied video title, exact quote, and nearby context. Location relevance is the first gate: set placeRelevant=false for generic city-wide advice or a different neighborhood, attraction, museum, or market. A video title that lists several locations does not prove its current clip is about the requested place. A title focused only on the requested place can be supporting location context unless the transcript clearly moves elsewhere. The user payload may provide inScopeAliases: a specific named street or sub-place inside the requested place. Treat one only as inside when that exact alias appears in a narrowly focused video title or the supplied transcript context; never treat generic city wording as an alias. Classify locationRelationship as queried_place when the claim is about the requested place itself, inside when the transcript explicitly places the subject inside it or a specific inScopeAliases value directly identifies it, nearby only when a separate named POI is explicitly presented as nearby, different_area for another neighborhood or attraction, and unknown when the relationship is not supported. For nearby, poiName must be the exact separately named POI from the supplied text; otherwise use null. For queried_place or inside, use the requested place as poiName. Set locationEvidenceSource to transcript and make locationEvidence one contiguous excerpt from exactQuote or nearbyContext, except for a narrowly focused exact inScopeAliases match in videoTitle: then set locationEvidenceSource to video_title and copy that exact title phrase into locationEvidence. Use these user-facing intents strictly: why_visit means a reason the place itself is worth visiting (history, atmosphere, architecture, significance), never a restaurant or dish; activity means a concrete experience or stop; food means a named dish, drink, shop, or food recommendation; practical_tip means actionable timing, queue, transport, access, payment, or crowd advice, never a food description. When candidateIntent is practical_tip and exactQuote explicitly states a queue, waiting time, arrival time, station, exit, route, crowd level, busy or quiet day, or time of day, keep it as practical_tip even if the same clip names a food or walking activity; make primarySubject, title, and takeaway about the queue, timing, route, or crowd advice. For every clipId, identify the main subject—not a casually mentioned keyword—and reclassify the intent when needed. primarySubject must be one short, contiguous phrase copied exactly from exactQuote, never the video title. Write a specific 3–12 word title containing that complete primarySubject phrase verbatim and without inserting words inside it; never copy the video title. supportQuote must be one contiguous verbatim excerpt from exactQuote that directly supports both the title and takeaway. Before returning, verify that the takeaway repeats at least four meaningful content words from exactQuote and introduces no place, station, time, route, benefit, or activity that is absent from exactQuote; if that cannot be done, set mentionOnly=true. Keep primarySubject, title, supportQuote, takeaway, and highlights in the source language even when it is not English; never translate those inspectable evidence fields. For a clip whose captionLanguage is not English or whose videoChannelName uses a non-Latin script, populate englishPresentation with an English title, takeaway, exactQuote translation, highlights, and English channel-name transliteration. Translate only the supplied evidence, introduce no new facts, ensure every English highlight appears in the English takeaway, and use no source-language characters in englishPresentation. For ordinary English caption and channel metadata, set englishPresentation to null. Do not import details from nearbyContext into the title or takeaway; nearbyContext is only for deciding location relevance. Every source-language highlight must be copied exactly from the source-language takeaway. Set mentionOnly=true when the tempting label is only incidental. Examples: for "there's a lot of DIY craft workshops here," write "The creator says there are a lot of DIY craft workshops here," not a generic hands-on-benefit claim; use "Arrive before 11 to avoid the sashimi queue", not "How to approach the area"; describe the named noodle dish, not "Seafood mentioned nearby", when seafood is only a flavoring. Do not state current prices, hours, availability, awards, or ratings as facts unless exactQuote explicitly says them; even then, attribute time-sensitive advice to the creator. Return exactly one item for every supplied clipId.` },
          { role: "user", content: JSON.stringify({ place: result.place, city: result.city, inScopeAliases: scopeAliases, clips: batch.map((clip) => ({ clipId: clip.id, candidateIntent: clip.intent, videoTitle: clip.video.title, videoChannelName: clip.video.channelName, captionLanguage: clip.language, exactQuote: clip.exactQuote, nearbyContext: clip.contextText })) }) }
        ],
        text: { format: zodTextFormat(semanticAnalysisSchema, "clip_semantic_analysis") }
      });
      if (response.usage) {
        console.info("[research-place] semantic usage", {
          model,
          inputTokens: response.usage.input_tokens,
          cachedInputTokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
          cacheWriteTokens: response.usage.input_tokens_details?.cache_write_tokens ?? 0,
          outputTokens: response.usage.output_tokens
        });
      }
      if (!response.output_parsed) {
        const outputTypes = response.output.map((item) => item.type).join(",") || "none";
        throw new Error(`The model returned no structured semantic analysis (status=${response.status}, incomplete=${response.incomplete_details?.reason || "none"}, output=${outputTypes}).`);
      }
      const analysesByClipId = new Map(response.output_parsed.items.map((analysis) => [analysis.clipId, analysis]));
      if (analysesByClipId.size !== batch.length || batch.some((clip) => !analysesByClipId.has(clip.id))) {
        throw new Error("The model returned an incomplete semantic analysis.");
      }
      newEntries.push(...batch.map((clip) => ({
        evidenceHash: semanticEvidenceHash(result, clip, model),
        analysis: analysesByClipId.get(clip.id)!
      })));
      // Save each completed serial batch. If a later request is interrupted,
      // a local rerun can reuse verified analysis instead of charging for the
      // completed batches again.
      await persistSemanticEntries();
    }
    return { ...applySemanticClipAnalyses(result, [...cachedAnalyses, ...newEntries.map((entry) => entry.analysis)]), aiModel: model };
  } catch (error) {
    console.warn("[research-place] synthesis failed", error instanceof Error ? error.message : "unknown error");
    return {
      ...result,
      warnings: ["AI verification was unavailable for this pass; showing exact transcript matches while preserving the source timestamp.", ...result.warnings],
      aiModel: undefined,
      mode: "extractive" as const
    };
  }
}

async function applyGeospatialVerification(result: PlaceResearchResult, cacheDir: string, signal: AbortSignal) {
  if (result.mode !== "ai" || !result.clips.length) return result;
  const { verified, rejectedCount } = await verifyResearchLocations(result, cacheDir, signal);
  const checked = buildVerifiedResearchResult(result, verified, 0);
  return {
    ...checked,
    overview: `${checked.overview} Named places are also checked against the requested location.`,
    warnings: [
      ...(rejectedCount ? [`${rejectedCount} clips were omitted because their place or distance could not be verified.`] : []),
      ...checked.warnings
    ]
  };
}

function cachePaths(place: string, city: string, scope: "runtime" | "snapshot-generator" = "runtime") {
  // Snapshot generation must never read from or overwrite the public runtime
  // cache. It starts with freshly fetched local evidence in a separate namespace.
  const cacheIdentity = scope === "runtime"
    // Keep the established runtime identity unchanged so existing seven-day
    // GCS FUSE cache entries remain readable after this migration.
    ? `${CACHE_VERSION}:${OPENAI_MODEL}:${city.trim().toLowerCase()}:${place.trim().toLowerCase()}`
    : `${CACHE_VERSION}:${scope}:${OPENAI_MODEL}:${city.trim().toLowerCase()}:${place.trim().toLowerCase()}`;
  const cacheKey = crypto.createHash("sha256").update(cacheIdentity).digest("hex").slice(0, 24);
  const cacheDir = path.join(/*turbopackIgnore: true*/ CACHE_ROOT, cacheKey);
  return {
    cacheDir,
    resultPath: path.join(/*turbopackIgnore: true*/ cacheDir, "result.json"),
    semanticCachePath: path.join(/*turbopackIgnore: true*/ cacheDir, "semantic-analysis.json")
  };
}

/**
 * Local snapshot generation does a cheap development-model pass first, then
 * reruns only those surviving clips through the production-quality verifier.
 * This function is intentionally unavailable in Cloud Run.
 */
export async function finalizeLocalSnapshotResearch(candidate: PlaceResearchResult, signal: AbortSignal, onModelUse?: (model: string) => void) {
  if (isCloudRunProduction()) {
    throw new Error("Verified snapshots can only be generated locally, never in Cloud Run production.");
  }
  const { cacheDir, semanticCachePath } = cachePaths(candidate.place, candidate.city, "snapshot-generator");
  await fs.mkdir(cacheDir, { recursive: true });
  // Keep a small, diverse fallback pool for each category. Continuation runs
  // put newly fetched gap evidence first, so this does not discard it before
  // Luna can decide whether it is genuinely source-backed. Eight-card serial
  // batches retain enough local context without weakening the publication bar.
  const balancedClips = REQUIRED_SNAPSHOT_INTENTS.flatMap((intent) => candidate.clips
    .filter((clip) => clip.intent === intent)
    .slice(0, 5));
  const base = buildExtractiveResearchResult(candidate.place, candidate.city, balancedClips, candidate.generatedAt);
  const synthesized = await synthesizeResult(base, semanticCachePath, PRODUCTION_OPENAI_MODEL, onModelUse);
  const checked = await applyGeospatialVerification(synthesized, cacheDir, signal);
  // A public snapshot has a precise publication bar: two different video
  // sources per category. Retain exactly that verified, diverse set rather
  // than allowing a third fallback card with weaker title/takeaway alignment
  // to invalidate an otherwise complete snapshot.
  const publicationClips = checked.mode === "ai" ? selectSnapshotEvidenceClips(checked.clips) : checked.clips;
  const published = checked.mode === "ai"
    ? buildVerifiedResearchResult({
      ...checked,
      clips: publicationClips,
      clipCount: publicationClips.length,
      sourceCount: new Set(publicationClips.map((clip) => clip.video.id)).size
    }, publicationClips, 0)
    : checked;
  const candidateClips = base.clips.length;
  const evidenceMatches = synthesized.mode === "ai" ? synthesized.clipCount : 0;
  const rejectedLocation = synthesized.mode === "ai" ? Math.max(0, evidenceMatches - checked.clipCount) : 0;
  const verification = reconcileVerificationCounts({
    videosFound: Math.max(candidate.verification?.videosFound || 0, candidate.sourceCount),
    captionedVideos: Math.max(candidate.verification?.captionedVideos || 0, candidate.sourceCount),
    candidateClips,
    evidenceMatches,
    verifiedClips: published.mode === "ai" ? published.clipCount : 0,
    rejectedEvidenceOrRanking: Math.max(0, candidateClips - evidenceMatches),
    rejectedLocation
  }, published.mode === "ai" ? published.clipCount : 0);
  return {
    ...published,
    aiModel: published.mode === "ai" ? PRODUCTION_OPENAI_MODEL : undefined,
    sourceStatus: "local_research" as const,
    verification
  };
}

function missingIntents(result: PlaceResearchResult) {
  const covered = new Set(result.clips.map((clip) => clip.intent));
  return ALL_INTENTS.filter((intent) => !covered.has(intent));
}

function snapshotCoverageGaps(result: PlaceResearchResult, intents: ResearchIntent[] = REQUIRED_SNAPSHOT_INTENTS) {
  const counts = snapshotVideoCountsByIntent(result.clips);
  return intents.filter((intent) => counts[intent] < MIN_SNAPSHOT_VIDEOS_PER_INTENT);
}

function intentLabels(intents: ResearchIntent[]) {
  const labels: Record<ResearchIntent, string> = {
    why_visit: "why it is worth going",
    activity: "what to do",
    food: "what to eat",
    practical_tip: "good to know"
  };
  return intents.map((intent) => labels[intent]).join(", ");
}

function relatedPlaceTerms(result: PlaceResearchResult) {
  const pattern = /\b[A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+)?\s+(?:Street|Market|District|Neighborhood|Pier|Station|Park)\b/g;
  const matches = result.clips.flatMap((clip) => `${clip.title} ${clip.takeaway} ${clip.exactQuote}`.match(pattern) || []);
  return [...new Set(matches)].filter((term) => normalizeResearchText(term) !== normalizeResearchText(result.place)).slice(0, 3);
}

function qualifyPracticalClaims(result: PlaceResearchResult) {
  const replacements = new Map<string, string>();
  const clips = result.clips.map((clip) => {
    if (clip.intent !== "practical_tip" || /^creator tip:/i.test(clip.title)) return clip;
    const title = `Creator tip: ${clip.title}`;
    replacements.set(clip.title, title);
    return {
      ...clip,
      title,
      takeaway: /^the creator/i.test(clip.takeaway)
        ? clip.takeaway
        : `The creator observed: ${clip.takeaway.charAt(0).toLowerCase()}${clip.takeaway.slice(1)}`
    };
  });
  return { ...result, clips, suggestedPlan: result.suggestedPlan.map((item) => replacements.get(item) || item) };
}

function keepRequestedSnapshotIntents(result: PlaceResearchResult, intents: ResearchIntent[]) {
  if (result.mode !== "ai") return result;
  const requested = result.clips.filter((clip) => intents.includes(clip.intent));
  if (requested.length === result.clips.length) return result;
  return buildVerifiedResearchResult({ ...result, clips: requested }, requested, result.clips.length - requested.length);
}

export function isValidRuntimeCache(value: unknown, now = Date.now()): value is PlaceResearchResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<PlaceResearchResult>;
  const generatedAt = typeof result.generatedAt === "string" ? Date.parse(result.generatedAt) : Number.NaN;
  const generatedDate = new Date(generatedAt);
  const validIntent = (intent: unknown): intent is ResearchIntent => typeof intent === "string" && ALL_INTENTS.includes(intent as ResearchIntent);
  const clipsAreWellFormed = Array.isArray(result.clips) && result.clips.every((clip) => {
    if (!clip || typeof clip !== "object") return false;
    const candidate = clip as Partial<ResearchClip>;
    const video = candidate.video;
    return typeof candidate.id === "string"
      && validIntent(candidate.intent)
      && typeof candidate.title === "string" && candidate.title.trim().length >= 4
      && typeof candidate.takeaway === "string" && candidate.takeaway.trim().length >= 8
      && typeof candidate.exactQuote === "string" && candidate.exactQuote.trim().length >= 12
      && typeof candidate.startSeconds === "number" && typeof candidate.endSeconds === "number" && candidate.startSeconds >= 0 && candidate.endSeconds > candidate.startSeconds
      && typeof candidate.language === "string"
      && typeof video?.id === "string" && /^[A-Za-z0-9_-]{11}$/.test(video.id)
      && typeof video?.title === "string" && typeof video?.channelName === "string"
      && typeof video?.publishedAt === "string" && isRecentPublishedAt(video.publishedAt, generatedDate)
      && hasRequiredEnglishPresentation(candidate as ResearchClip);
  });
  const sourceCount = Array.isArray(result.clips)
    ? new Set(result.clips.map((clip) => clip.video.id)).size
    : 0;
  return Number.isFinite(generatedAt)
    && generatedAt <= now
    && now - generatedAt < CACHE_TTL_MS
    && typeof result.place === "string"
    && typeof result.city === "string"
    && typeof result.sourceCount === "number"
    && result.sourceCount === sourceCount
    && typeof result.clipCount === "number"
    && result.clipCount === result.clips?.length
    && clipsAreWellFormed
    && ["ai", "extractive"].includes(result.mode || "");
}

async function readValidRuntimeCache(resultPath: string) {
  try {
    const cached = JSON.parse(await fs.readFile(resultPath, "utf8")) as unknown;
    if (!isValidRuntimeCache(cached)) return null;
    const result = cached as PlaceResearchResult;
    return qualifyPracticalClaims({
      ...result,
      verification: result.verification ? reconcileVerificationCounts(result.verification, result.clipCount) : undefined
    });
  } catch {
    return null;
  }
}

export function sourceUnavailableResult(place: string, city: string): PlaceResearchResult {
  return {
    place,
    city,
    overview: "No saved source-backed brief is available for this place yet.",
    generatedAt: new Date().toISOString(),
    cacheHit: false,
    sourceCount: 0,
    clipCount: 0,
    clips: [],
    suggestedPlan: [],
    warnings: ["TripTrace cannot obtain new verifiable source material from the public demo at this time. It shows a clear data-unavailable state rather than generating generic travel claims."],
    mode: "source_unavailable",
    sourceStatus: "source_unavailable",
    sourceUnavailable: {
      code: "no_snapshot_or_cache",
      message: "There is no verified snapshot or still-valid seven-day research cache for this place."
    }
  };
}

type CacheFirstResolutionOptions = {
  place: string;
  city: string;
  runtime: "development" | "production";
  snapshot?: VerifiedSnapshot | null;
  cachedResult?: PlaceResearchResult | null;
  force?: boolean;
  replaySaved?: (kind: "snapshot" | "runtime_cache") => Promise<void>;
  liveResearch?: () => Promise<PlaceResearchResult>;
};

/** The public resolver is deliberately side-effect free until local research is explicitly allowed. */
export async function resolveCacheFirstResult(options: CacheFirstResolutionOptions): Promise<PlaceResearchResult | null> {
  const replay = options.replaySaved || (async () => undefined);
  if (options.snapshot) {
    await replay("snapshot");
    return snapshotResultForReplay(options.snapshot);
  }
  if (options.cachedResult && (!options.force || options.runtime === "production")) {
    await replay("runtime_cache");
    return { ...options.cachedResult, cacheHit: true, sourceStatus: "runtime_cache" };
  }
  if (options.runtime === "production") return sourceUnavailableResult(options.place, options.city);
  return options.liveResearch ? options.liveResearch() : null;
}

function fixtureResultFor(place: string, city: string): PlaceResearchResult {
  if (normalizeResearchText(place) !== "taipei 101" || normalizeResearchText(city) !== "taipei") {
    throw new Error("Local fixture mode currently includes the Taipei 101 demo only. Clear TRIPTRACE_TEST_MODE to research another place.");
  }
  const demo = taipei101Demo as PlaceResearchResult;
  return {
    ...demo,
    place,
    city,
    generatedAt: new Date().toISOString(),
    cacheHit: false,
    mode: "fixture",
    demoSnapshot: false,
    sourceStatus: "legacy_fixture",
    aiModel: "fixture (no API call)",
    warnings: ["Local fixture mode: this is legacy sample evidence, not a current public verified snapshot. It avoids yt-dlp and OpenAI charges; live research still enforces the two-year video filter.", ...demo.warnings]
  };
}

async function replayFixtureProgress(onProgress: ProgressCallback, signal: AbortSignal) {
  const stages: Array<["search" | "screen" | "captions" | "extract" | "synthesize", string]> = [
    ["search", "Loading the local verified demo…"],
    ["screen", "Restoring the saved source checks…"],
    ["captions", "Restoring timed-caption evidence…"],
    ["extract", "Restoring category matches…"],
    ["synthesize", "Restoring the source-backed outline…"]
  ];
  for (const [index, [stage, message]] of stages.entries()) {
    onProgress(stage, message, index, 5);
    await wait(800, undefined, { signal });
  }
}

function canStreamResult(result: PlaceResearchResult) {
  if (!result.clips.length) return false;
  if (result.mode === "extractive") return true;
  return result.clips.every((clip) => clip.locationVerification && clip.locationVerification.status !== "pending");
}

export async function researchPlace({ place, city, force = false, signal, onProgress, onPartialResult, onModelUse, localSnapshotGeneration = false, snapshotIntents, excludeVideoIds, snapshotSearchRefillOnly = false }: { place: string; city: string; force?: boolean; signal: AbortSignal; onProgress: ProgressCallback; onPartialResult?: (result: PlaceResearchResult) => void; onModelUse?: (model: string) => void; localSnapshotGeneration?: boolean; snapshotIntents?: ResearchIntent[]; excludeVideoIds?: Set<string>; snapshotSearchRefillOnly?: boolean }) {
  if (localSnapshotGeneration && isCloudRunProduction()) {
    throw new Error("Local snapshot generation is disabled in Cloud Run production.");
  }
  const { cacheDir, resultPath, semanticCachePath } = cachePaths(place, city, localSnapshotGeneration ? "snapshot-generator" : "runtime");
  const savedResult = localSnapshotGeneration ? null : await readValidRuntimeCache(resultPath);
  const snapshot = localSnapshotGeneration ? null : getVerifiedSnapshot(place, city);
  const cachedOrSnapshot = localSnapshotGeneration ? null : await resolveCacheFirstResult({
    place,
    city,
    runtime: isCloudRunProduction() ? "production" : "development",
    snapshot,
    cachedResult: savedResult,
    force,
    replaySaved: async () => replayCachedProgress(onProgress, signal)
  });
  if (cachedOrSnapshot) {
    const sourceMessage = cachedOrSnapshot.sourceStatus === "verified_snapshot"
      ? `Loaded ${cachedOrSnapshot.sourceCount} verified snapshot video sources.`
      : cachedOrSnapshot.sourceStatus === "runtime_cache"
        ? `Loaded ${cachedOrSnapshot.sourceCount} previously verified video sources from the seven-day cache.`
        : cachedOrSnapshot.sourceUnavailable?.message || "No verified snapshot or valid seven-day cache is available for this place.";
    onProgress("complete", sourceMessage, 5, 5);
    return cachedOrSnapshot;
  }
  if (TRIPTRACE_TEST_MODE) {
    const fixture = fixtureResultFor(place, city);
    await replayFixtureProgress(onProgress, signal);
    onProgress("complete", "Loaded the local legacy fixture without external API calls.", 5, 5);
    onPartialResult?.(fixture);
    return fixture;
  }
  await fs.mkdir(cacheDir, { recursive: true });
  const targetedSnapshotIntents = localSnapshotGeneration && snapshotIntents?.length
    ? [...new Set(snapshotIntents)]
    : ALL_INTENTS;
  const isTargetedSnapshotContinuation = localSnapshotGeneration && targetedSnapshotIntents.length < ALL_INTENTS.length;

  onProgress("search", `Searching travel videos for ${place}…`, 0, 5);
  const candidates = await searchCandidates(place, city, signal, {
    intents: targetedSnapshotIntents,
    excludeIds: excludeVideoIds,
    refill: snapshotSearchRefillOnly
  });
  if (!candidates.length) throw new Error("No recent YouTube candidates were found for this place.");

  onProgress("screen", `Found ${candidates.length} candidates. Checking captions, channels, and embed access…`, 1, 5);
  const probed = await inBatches(candidates, researchBatchSize(4), (candidate) => probeCandidate(candidate, signal));
  const selectedVideos = chooseVideos(probed, targetedSnapshotIntents, isSnapshotGeneratorRun() ? SNAPSHOT_MAX_SELECTED_VIDEOS : MAX_SELECTED_VIDEOS);
  if (!selectedVideos.length) throw new Error("TripTrace could not find a recent embeddable source with usable timed captions.");
  if (isSnapshotGeneratorRun()) {
    const pinned = selectedVideos.filter((video) => video.pinned).map((video) => video.id);
    console.log(`[snapshot-generator] ${place}: selected ${selectedVideos.length} caption candidates${pinned.length ? `; pinned: ${pinned.join(", ")}` : ""}.`);
  }

  onProgress("captions", `Reading timed captions from ${selectedVideos.length} videos…`, 2, 5);
  const transcripts = await inBatches(selectedVideos, researchBatchSize(3), (video) => downloadTranscript(video, cacheDir, signal));
  if (!transcripts.length) throw new Error("No usable recent timed transcript could be downloaded.");

  onProgress("extract", "Matching distinct clips for why to visit, what to do, food, and practical tips…", 3, 5);
  let clips = extractResearchClips(place, transcripts).filter((clip) => targetedSnapshotIntents.includes(clip.intent));
  if (!clips.length) throw new Error("The recent captions did not produce a relevant, source-backed clip.");
  clips = await attachStoryboardFrames(clips, selectedVideos, signal);
  let result = buildExtractiveResearchResult(place, city, clips, new Date().toISOString());
  const earlyCoverageWarnings = [
    ...(selectedVideos.length < 3 ? [`Only ${selectedVideos.length} recent video source${selectedVideos.length === 1 ? " was" : "s were"} available after screening.`] : []),
    ...(transcripts.length < selectedVideos.length ? [`${selectedVideos.length - transcripts.length} screened source${selectedVideos.length - transcripts.length === 1 ? " lost" : "s lost"} its timed captions.`] : []),
    ...(new Set(clips.map((clip) => clip.video.id)).size < 3 ? ["Fewer than three independent recent videos produced relevant clips; the result is shown as partial research."] : [])
  ];
  result = { ...result, warnings: [...earlyCoverageWarnings, ...result.warnings] };
  let verification = {
    videosFound: candidates.length,
    captionedVideos: transcripts.length,
    candidateClips: clips.length,
    evidenceMatches: 0,
    verifiedClips: 0,
    rejectedEvidenceOrRanking: 0,
    rejectedLocation: 0
  };

  onProgress("synthesize", "Building a source-backed visit outline without changing any timestamps…", 4, 5);
  const synthesizedInitial = await synthesizeResult(result, semanticCachePath, OPENAI_MODEL, onModelUse);
  verification.evidenceMatches = synthesizedInitial.mode === "ai" ? synthesizedInitial.clipCount : 0;
  verification.rejectedEvidenceOrRanking = Math.max(0, verification.candidateClips - verification.evidenceMatches);
  result = await applyGeospatialVerification(synthesizedInitial, cacheDir, signal);
  if (isTargetedSnapshotContinuation) result = keepRequestedSnapshotIntents(result, targetedSnapshotIntents);
  verification.verifiedClips = result.mode === "ai" ? result.clipCount : 0;
  verification.rejectedLocation = result.mode === "ai" ? Math.max(0, verification.evidenceMatches - verification.verifiedClips) : 0;
  verification = reconcileVerificationCounts(verification, result.clipCount);
  result = { ...result, aiModel: result.mode === "ai" ? OPENAI_MODEL : undefined, sourceStatus: "local_research", verification: { ...verification } };
  if (canStreamResult(result)) onPartialResult?.(result);

  const snapshotGeneration = isSnapshotGeneratorRun();
  const firstMissing = snapshotGeneration ? snapshotCoverageGaps(result, targetedSnapshotIntents) : missingIntents(result);
  const requiredSourceCount = snapshotGeneration
    ? isTargetedSnapshotContinuation ? 0 : MIN_SNAPSHOT_DISTINCT_VIDEOS
    : TARGET_VERIFIED_SOURCES;
  const shouldRefill = snapshotGeneration || process.env.TRIPTRACE_ALLOW_DEV_REFILL === "1";
  if (shouldRefill && result.mode === "ai" && (firstMissing.length || result.sourceCount < requiredSourceCount)) {
    const refillIntents = firstMissing.length ? firstMissing : ALL_INTENTS;
    onProgress("extract", `Adding new video sources for ${firstMissing.length ? intentLabels(firstMissing) : "source diversity"}…`, 4, 5);
    const extraCandidates = await searchCandidates(place, city, signal, {
      intents: refillIntents,
      excludeIds: new Set([...(excludeVideoIds || []), ...candidates.map((candidate) => candidate.id), ...selectedVideos.map((video) => video.id)]),
      refill: true,
      maxCandidates: snapshotGeneration ? SNAPSHOT_MAX_CANDIDATES_TO_PROBE : 18,
      relatedTerms: relatedPlaceTerms(result)
    });
    const extraProbed = await inBatches(extraCandidates, researchBatchSize(4), (candidate) => probeCandidate(candidate, signal));
    const extraVideos = chooseVideos(extraProbed, refillIntents, snapshotGeneration ? SNAPSHOT_MAX_SELECTED_VIDEOS : 7);
    const extraTranscripts = await inBatches(extraVideos, researchBatchSize(4), (video) => downloadTranscript(video, cacheDir, signal));
    verification.videosFound += extraCandidates.length;
    verification.captionedVideos += extraTranscripts.length;
    let refillClips = extractResearchClips(place, extraTranscripts)
      .filter((clip) => refillIntents.includes(clip.intent) && !clips.some((existing) => existing.id === clip.id));
    refillClips = await attachStoryboardFrames(refillClips, extraVideos, signal);
    verification.candidateClips += refillClips.length;
    if (refillClips.length) {
      const refillBase = buildExtractiveResearchResult(place, city, refillClips, result.generatedAt);
      const synthesizedRefill = await synthesizeResult(refillBase, semanticCachePath, OPENAI_MODEL, onModelUse);
      verification.evidenceMatches += synthesizedRefill.mode === "ai" ? synthesizedRefill.clipCount : 0;
      verification.rejectedEvidenceOrRanking = Math.max(0, verification.candidateClips - verification.evidenceMatches);
      let refillResult = await applyGeospatialVerification(synthesizedRefill, cacheDir, signal);
      if (isTargetedSnapshotContinuation) refillResult = keepRequestedSnapshotIntents(refillResult, refillIntents);
      if (synthesizedRefill.mode === "ai") verification.rejectedLocation += Math.max(0, synthesizedRefill.clipCount - refillResult.clipCount);
      const combinedCandidates = [...clips, ...refillClips];
      if (result.mode === "ai" && refillResult.mode === "ai") {
        const verified = [...result.clips, ...refillResult.clips].filter((clip, index, items) => items.findIndex((item) => item.id === clip.id) === index);
        const combinedBase = buildExtractiveResearchResult(place, city, combinedCandidates, result.generatedAt);
        result = buildVerifiedResearchResult(combinedBase, verified, combinedCandidates.length - verified.length);
      } else {
        result = {
          ...buildExtractiveResearchResult(place, city, combinedCandidates, result.generatedAt),
          warnings: ["The refill pass could not be semantically verified; showing the exact caption matches collected so far.", ...result.warnings]
        };
      }
      clips = combinedCandidates;
      verification = reconcileVerificationCounts(verification, result.clipCount);
      result = { ...result, aiModel: result.mode === "ai" ? OPENAI_MODEL : undefined, sourceStatus: "local_research", verification: { ...verification } };
      if (canStreamResult(result)) onPartialResult?.(result);
    }
  }

  const remainingMissing = snapshotGeneration ? snapshotCoverageGaps(result, targetedSnapshotIntents) : missingIntents(result);
  if (savedResult && (remainingMissing.length || result.sourceCount < MIN_VERIFIED_SOURCES)) {
    const savedFill = savedResult.clips.filter((clip) => remainingMissing.length ? remainingMissing.includes(clip.intent) : true);
    if (savedFill.length) {
      const savedVideoCount = new Set(savedFill.map((clip) => clip.video.id)).size;
      verification.videosFound += savedVideoCount;
      verification.captionedVideos += savedVideoCount;
      verification.candidateClips += savedFill.length;
      verification.evidenceMatches += savedFill.length;
      const verified = [...result.clips, ...savedFill].filter((clip, index, items) => items.findIndex((item) => item.id === clip.id) === index);
      result = result.mode === "ai"
        ? buildVerifiedResearchResult({ ...result, clips: verified }, verified, 0)
        : buildExtractiveResearchResult(place, city, verified, result.generatedAt);
      result.warnings = ["Reused still-valid evidence from the previous seven-day research cache where live YouTube results had a category gap.", ...result.warnings];
    }
  }

  if (!result.clips.length && clips.length) {
    result = {
      ...buildExtractiveResearchResult(place, city, clips, result.generatedAt),
      warnings: ["No clip passed semantic verification in this pass; showing the exact caption matches so the research does not stop empty.", ...result.warnings]
    };
  }
  if (!result.clips.length) throw new Error("TripTrace could not find any usable caption matches for this place.");
  if (result.mode === "ai" && result.clips.some((clip) => !clip.locationVerification || clip.locationVerification.status === "pending")) {
    result = {
      ...result,
      mode: "extractive",
      aiModel: undefined,
      warnings: ["Some location checks were unresolved; showing transcript evidence without presenting those clips as location-verified.", ...result.warnings]
    };
  }
  const finalMissing = snapshotGeneration ? snapshotCoverageGaps(result) : missingIntents(result);
  if (finalMissing.length || result.sourceCount < requiredSourceCount) {
    const coverage = finalMissing.length ? ` Missing: ${intentLabels(finalMissing)}.` : "";
    const sourceGap = result.sourceCount < requiredSourceCount
      ? result.mode === "ai"
        ? ` Only ${result.sourceCount} recent independent videos passed all checks; the research did not fill the target of ${requiredSourceCount}.`
        : ` Only ${result.sourceCount} recent independent videos produced transcript matches; the research did not fill the target of ${requiredSourceCount}.`
      : "";
    const resultKind = result.mode === "ai" ? "verified clips" : "timestamped transcript matches";
    result = {
      ...result,
      warnings: [
        `Partial research: ${result.sourceCount} independent videos produced ${result.clipCount} ${resultKind}.${coverage}${sourceGap}`,
        ...result.warnings
      ]
    };
  }
  verification = reconcileVerificationCounts(verification, result.clipCount);
  result = { ...result, aiModel: result.mode === "ai" ? OPENAI_MODEL : undefined, sourceStatus: "local_research", verification: { ...verification } };
  result = qualifyPracticalClaims(result);
  await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  const completionKind = result.mode === "ai" ? "verified" : "timestamped";
  onProgress("complete", `Finished with ${result.sourceCount} videos and ${result.clipCount} ${completionKind} clips.`, 5, 5);
  return result;
}
