import "server-only";

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { applySemanticClipAnalyses, buildExtractiveResearchResult, buildVerifiedResearchResult, extractResearchClips, normalizeResearchText, parseResearchJson3, type ResearchVideoTranscript, type SemanticClipAnalysis } from "@/lib/research-core";
import { getOpenAIClient, OPENAI_MODEL } from "@/lib/openai";
import type { PlaceResearchResult, ResearchClip, ResearchIntent } from "@/types/research";

const execFileAsync = promisify(execFile);
const CACHE_VERSION = "v12-research-site";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CANDIDATES_TO_PROBE = 14;
const MAX_SELECTED_VIDEOS = 8;
const ALL_INTENTS: ResearchIntent[] = ["why_visit", "activity", "food", "practical_tip"];
const MIN_VERIFIED_SOURCES = 4;
const CACHE_ROOT = process.env.TRIPTRACE_CACHE_DIR || path.join(/*turbopackIgnore: true*/ os.tmpdir(), "triptrace-research");

type ProgressCallback = (stage: "search" | "screen" | "captions" | "extract" | "synthesize" | "complete", message: string, completed: number, total: number) => void;

type SearchCandidate = {
  id: string;
  title: string;
  channelName: string;
  score: number;
  intents: Set<ResearchIntent>;
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
    confidence: z.number().min(0).max(1)
  })).min(1).max(16)
});

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

async function runYtDlp(args: string[], signal: AbortSignal, timeout = 35_000) {
  const binary = await resolveYtDlp();
  const { stdout } = await execFileAsync(binary, ["--js-runtimes", `node:${process.execPath}`, "--no-warnings", ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout,
    signal
  });
  return stdout;
}

function parseJsonLines<T>(value: string): T[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as T]; } catch { return []; }
  });
}

function englishTrack(record: Record<string, unknown> | undefined) {
  if (!record) return undefined;
  const keys = Object.keys(record);
  return ["en", "en-GB", "en-US", "en-orig"].find((key) => keys.includes(key)) || keys.find((key) => /^en(?:-|$)/i.test(key));
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

async function searchCandidates(place: string, city: string, signal: AbortSignal, options: {
  intents?: ResearchIntent[];
  excludeIds?: Set<string>;
  refill?: boolean;
  maxCandidates?: number;
  relatedTerms?: string[];
} = {}) {
  const intents = options.intents?.length ? options.intents : ALL_INTENTS;
  const searchLimit = options.refill ? 14 : 10;
  const querySuffixes: Record<ResearchIntent, string[]> = {
    why_visit: ["history culture architecture worth visiting", "travel guide atmosphere heritage"],
    activity: ["things to do walking tour attractions", "shops temple pier sunset itinerary"],
    food: ["food guide street food restaurants", "what to eat local food market"],
    practical_tip: ["travel tips crowds queue transport", "best time visit opening hours how to get there"]
  };
  const refillSuffixes: Record<ResearchIntent, string> = {
    why_visit: "why visit history heritage local guide",
    activity: "walking tour itinerary attractions experience",
    food: "food tour breakfast restaurants local dishes",
    practical_tip: "walking tour advice arrive early queue station"
  };
  const searches = intents.flatMap((intent) => [...querySuffixes[intent], ...(options.refill ? [refillSuffixes[intent]] : [])]
    .map((suffix) => ({ intent, query: `${place} ${city} ${suffix}` })));
  if (options.refill) {
    for (const intent of intents) {
      for (const term of (options.relatedTerms || []).slice(0, 2)) {
        searches.push({ intent, query: `${place} ${term} ${city} ${refillSuffixes[intent]}` });
      }
    }
  }
  const resultSets = await inBatches(searches, 4, async ({ intent, query }) => {
    const output = await runYtDlp(["--flat-playlist", "--playlist-end", String(searchLimit), "--dump-json", `ytsearch${searchLimit}:${query}`], signal, 30_000);
    return { intent, entries: parseJsonLines<{ id?: string; title?: string; channel?: string }>(output) };
  });

  const byId = new Map<string, SearchCandidate>();
  for (const { intent, entries } of resultSets) {
    entries.forEach((entry, index) => {
      if (!entry.id || !entry.title) return;
      if (options.excludeIds?.has(entry.id)) return;
      const placeTitleBonus = normalizeResearchText(entry.title).includes(normalizeResearchText(place)) ? 8 : 0;
      const existing = byId.get(entry.id);
      if (existing) {
        existing.intents.add(intent);
        existing.score += Math.max(1, searchLimit - index) + placeTitleBonus;
      } else {
        byId.set(entry.id, {
          id: entry.id,
          title: entry.title,
          channelName: entry.channel || "Unknown channel",
          score: Math.max(1, searchLimit - index) + placeTitleBonus,
          intents: new Set([intent])
        });
      }
    });
  }

  const ranked = [...byId.values()].sort((a, b) => b.score - a.score);
  const selected: SearchCandidate[] = [];
  const maxCandidates = options.maxCandidates || MAX_CANDIDATES_TO_PROBE;
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
    const output = await runYtDlp(["--skip-download", "--no-playlist", "--dump-single-json", `https://www.youtube.com/watch?v=${candidate.id}`], signal, 32_000);
    const info = JSON.parse(output) as {
      id?: string; title?: string; channel?: string; thumbnail?: string; upload_date?: string; duration?: number; playable_in_embed?: boolean;
      subtitles?: Record<string, unknown>; automatic_captions?: Record<string, unknown>;
      formats?: unknown;
    };
    if (!info.id || !info.title || !info.channel || info.playable_in_embed === false || !info.duration || info.duration < 90 || info.duration > 3600) return null;
    const creatorLanguage = englishTrack(info.subtitles);
    const automaticLanguage = englishTrack(info.automatic_captions);
    const language = creatorLanguage || automaticLanguage;
    if (!language || !/^[a-zA-Z0-9_-]+$/.test(language)) return null;
    return {
      id: info.id,
      title: info.title,
      channelName: info.channel,
      thumbnailUrl: info.thumbnail || `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`,
      publishedAt: info.upload_date ? `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}` : undefined,
      duration: info.duration,
      language,
      captionTrack: creatorLanguage ? "creator" : "automatic",
      searchIntents: [...candidate.intents],
      score: candidate.score + (creatorLanguage ? 8 : 0),
      storyboard: bestStoryboard(info.formats)
    };
  } catch {
    return null;
  }
}

function chooseVideos(videos: ProbedVideo[], intents: ResearchIntent[] = ALL_INTENTS, maxVideos = MAX_SELECTED_VIDEOS) {
  const ranked = [...videos].sort((a, b) => b.score - a.score);
  const selected: ProbedVideo[] = [];
  for (const intent of intents) {
    const candidate = ranked.find((video) => video.searchIntents.includes(intent) && !selected.some((item) => item.id === video.id) && !selected.some((item) => item.channelName === video.channelName));
    if (candidate) selected.push(candidate);
  }
  for (const candidate of ranked) {
    if (selected.length >= maxVideos) break;
    if (!selected.some((item) => item.id === candidate.id)) selected.push(candidate);
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
      ], signal, 45_000);
    } catch {
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
  const byVideoId = new Map(videos.map((video) => [video.id, video]));
  const spriteCache = new Map<string, Promise<Buffer | null>>();
  const loadSprite = (url: string) => {
    const existing = spriteCache.get(url);
    if (existing) return existing;
    const request = fetch(url, { signal }).then(async (response) => response.ok ? Buffer.from(await response.arrayBuffer()) : null).catch(() => null);
    spriteCache.set(url, request);
    return request;
  };

  return Promise.all(clips.map(async (clip) => {
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
  }));
}

const SEMANTIC_PROMPT_VERSION = "semantic-v4";

function semanticEvidenceHash(result: PlaceResearchResult, clip: ResearchClip) {
  return crypto.createHash("sha256").update(JSON.stringify({
    version: SEMANTIC_PROMPT_VERSION,
    model: OPENAI_MODEL,
    place: result.place,
    city: result.city,
    clip: { id: clip.id, title: clip.video.title, quote: clip.exactQuote, context: clip.contextText }
  })).digest("hex");
}

async function synthesizeResult(result: PlaceResearchResult, semanticCachePath: string) {
  if (!result.clips.length) return result;
  type SemanticCacheEntry = { evidenceHash: string; analysis: SemanticClipAnalysis };
  let cacheEntries: SemanticCacheEntry[] = [];
  try {
    const cached = JSON.parse(await fs.readFile(semanticCachePath, "utf8")) as { version?: string; model?: string; entries?: unknown };
    if (cached.version === SEMANTIC_PROMPT_VERSION && cached.model === OPENAI_MODEL && Array.isArray(cached.entries)) {
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
    const analysis = cachedByHash.get(semanticEvidenceHash(result, clip));
    return analysis ? [analysis] : [];
  });
  const pendingClips = result.clips.filter((clip) => !cachedByHash.has(semanticEvidenceHash(result, clip)));
  if (!pendingClips.length) return applySemanticClipAnalyses(result, cachedAnalyses);

  const client = getOpenAIClient();
  if (!client) return cachedAnalyses.length ? applySemanticClipAnalyses(result, cachedAnalyses) : result;
  try {
    const response = await client.responses.parse({
      model: OPENAI_MODEL,
      max_output_tokens: 3_000,
      input: [
        { role: "system", content: `Analyze travel-video clips conservatively. Use only the supplied video title, exact quote, and nearby context. Location relevance is the first gate: set placeRelevant=false for generic city-wide advice or a different neighborhood, attraction, museum, or market. A video title that lists several locations does not prove its current clip is about the requested place. A title focused only on the requested place can be supporting location context unless the transcript clearly moves elsewhere. Use these user-facing intents strictly: why_visit means a reason the place itself is worth visiting (history, atmosphere, architecture, significance), never a restaurant or dish; activity means a concrete experience or stop; food means a named dish, drink, shop, or food recommendation; practical_tip means actionable timing, queue, transport, access, payment, or crowd advice, never a food description. For every clipId, identify the main subject—not a casually mentioned keyword—and reclassify the intent when needed. primarySubject must be one short, contiguous phrase copied exactly from exactQuote, never the video title. Write a specific 3–12 word title containing that complete primarySubject phrase verbatim and without inserting words inside it; never copy the video title. supportQuote must be one contiguous verbatim excerpt from exactQuote that directly supports both the title and takeaway. The takeaway must be 12–30 words, include the primarySubject wording, reuse at least four meaningful content words from exactQuote, and make no claim that is absent from exactQuote. Do not import details from nearbyContext into the title or takeaway; nearbyContext is only for deciding location relevance. Every highlight must be copied exactly from the takeaway. Set mentionOnly=true when the tempting label is only incidental. Examples: use "Arrive before 11 to avoid the sashimi queue", not "How to approach the area"; describe the named noodle dish, not "Seafood mentioned nearby", when seafood is only a flavoring. Do not state current prices, hours, availability, awards, or ratings as facts unless exactQuote explicitly says them; even then, attribute time-sensitive advice to the creator. Return exactly one item for every supplied clipId.` },
        { role: "user", content: JSON.stringify({ place: result.place, city: result.city, clips: pendingClips.map((clip) => ({ clipId: clip.id, candidateIntent: clip.intent, videoTitle: clip.video.title, exactQuote: clip.exactQuote, nearbyContext: clip.contextText })) }) }
      ],
      text: { format: zodTextFormat(semanticAnalysisSchema, "clip_semantic_analysis") }
    });
    if (!response.output_parsed) throw new Error("The model returned no structured semantic analysis.");
    const newEntries = pendingClips.flatMap((clip) => {
      const analysis = response.output_parsed?.items.find((item) => item.clipId === clip.id);
      return analysis ? [{ evidenceHash: semanticEvidenceHash(result, clip), analysis }] : [];
    });
    if (newEntries.length !== pendingClips.length) throw new Error("The model returned an incomplete semantic analysis.");
    const mergedEntries = new Map([...cacheEntries, ...newEntries].map((entry) => [entry.evidenceHash, entry]));
    await fs.writeFile(semanticCachePath, `${JSON.stringify({ version: SEMANTIC_PROMPT_VERSION, model: OPENAI_MODEL, entries: [...mergedEntries.values()] }, null, 2)}\n`, "utf8");
    return applySemanticClipAnalyses(result, [...cachedAnalyses, ...response.output_parsed.items]);
  } catch (error) {
    console.warn("[research-place] synthesis failed", error instanceof Error ? error.message : "unknown error");
    throw new Error("AI synthesis could not produce verified summaries. Please retry this place.");
  }
}

function cachePaths(place: string, city: string) {
  const cacheKey = crypto.createHash("sha256").update(`${CACHE_VERSION}:${city.trim().toLowerCase()}:${place.trim().toLowerCase()}`).digest("hex").slice(0, 24);
  const cacheDir = path.join(/*turbopackIgnore: true*/ CACHE_ROOT, cacheKey);
  return {
    cacheDir,
    resultPath: path.join(/*turbopackIgnore: true*/ cacheDir, "result.json"),
    semanticCachePath: path.join(/*turbopackIgnore: true*/ cacheDir, "semantic-analysis.json")
  };
}

function missingIntents(result: PlaceResearchResult) {
  const covered = new Set(result.clips.map((clip) => clip.intent));
  return ALL_INTENTS.filter((intent) => !covered.has(intent));
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

export async function researchPlace({ place, city, force = false, signal, onProgress }: { place: string; city: string; force?: boolean; signal: AbortSignal; onProgress: ProgressCallback }) {
  const { cacheDir, resultPath, semanticCachePath } = cachePaths(place, city);
  await fs.mkdir(cacheDir, { recursive: true });
  let savedResult: PlaceResearchResult | null = null;
  try {
    const cached = JSON.parse(await fs.readFile(resultPath, "utf8")) as PlaceResearchResult;
    if (Date.now() - new Date(cached.generatedAt).getTime() < CACHE_TTL_MS) {
      savedResult = qualifyPracticalClaims(cached);
      if (!force) {
        onProgress("complete", `Loaded ${cached.sourceCount} previously verified video sources.`, 5, 5);
        return { ...savedResult, cacheHit: true };
      }
    }
  } catch {
    // A missing or invalid cache simply starts a fresh research run.
  }

  onProgress("search", `Searching travel videos for ${place}…`, 0, 5);
  const candidates = await searchCandidates(place, city, signal);
  if (candidates.length < 3) throw new Error("Too few relevant YouTube candidates were found for this place.");

  onProgress("screen", `Found ${candidates.length} candidates. Checking captions, channels, and embed access…`, 1, 5);
  const probed = await inBatches(candidates, 4, (candidate) => probeCandidate(candidate, signal));
  const selectedVideos = chooseVideos(probed);
  if (selectedVideos.length < 3) throw new Error("TripTrace could not find at least three embeddable videos with English captions.");

  onProgress("captions", `Reading timed captions from ${selectedVideos.length} videos…`, 2, 5);
  const transcripts = await inBatches(selectedVideos, 3, (video) => downloadTranscript(video, cacheDir, signal));
  if (transcripts.length < 3) throw new Error("Fewer than three usable timed transcripts could be downloaded.");

  onProgress("extract", "Matching distinct clips for why to visit, what to do, food, and practical tips…", 3, 5);
  let clips = extractResearchClips(place, transcripts);
  if (new Set(clips.map((clip) => clip.video.id)).size < 3) throw new Error("The captions did not produce three independent, relevant source clips.");
  clips = await attachStoryboardFrames(clips, selectedVideos, signal);
  let result = buildExtractiveResearchResult(place, city, clips, new Date().toISOString());

  onProgress("synthesize", "Building a source-backed visit outline without changing any timestamps…", 4, 5);
  result = await synthesizeResult(result, semanticCachePath);

  const firstMissing = missingIntents(result);
  if (firstMissing.length || result.sourceCount < MIN_VERIFIED_SOURCES) {
    const refillIntents = firstMissing.length ? firstMissing : ALL_INTENTS;
    onProgress("extract", `Adding new video sources for ${firstMissing.length ? intentLabels(firstMissing) : "source diversity"}…`, 4, 5);
    const extraCandidates = await searchCandidates(place, city, signal, {
      intents: refillIntents,
      excludeIds: new Set(selectedVideos.map((video) => video.id)),
      refill: true,
      maxCandidates: 10,
      relatedTerms: relatedPlaceTerms(result)
    });
    const extraProbed = await inBatches(extraCandidates, 4, (candidate) => probeCandidate(candidate, signal));
    const extraVideos = chooseVideos(extraProbed, refillIntents, 5);
    const extraTranscripts = await inBatches(extraVideos, 4, (video) => downloadTranscript(video, cacheDir, signal));
    let refillClips = extractResearchClips(place, extraTranscripts)
      .filter((clip) => refillIntents.includes(clip.intent) && !clips.some((existing) => existing.id === clip.id));
    refillClips = await attachStoryboardFrames(refillClips, extraVideos, signal);
    if (refillClips.length) {
      const refillBase = buildExtractiveResearchResult(place, city, refillClips, result.generatedAt);
      const refillResult = await synthesizeResult(refillBase, semanticCachePath);
      const combinedCandidates = [...clips, ...refillClips];
      if (result.mode === "ai" && refillResult.mode === "ai") {
        const verified = [...result.clips, ...refillResult.clips].filter((clip, index, items) => items.findIndex((item) => item.id === clip.id) === index);
        const combinedBase = buildExtractiveResearchResult(place, city, combinedCandidates, result.generatedAt);
        result = buildVerifiedResearchResult(combinedBase, verified, combinedCandidates.length - verified.length);
      } else if (result.mode === "extractive" && refillResult.mode === "extractive") {
        result = buildExtractiveResearchResult(place, city, combinedCandidates, result.generatedAt);
      }
      clips = combinedCandidates;
    }
  }

  const remainingMissing = missingIntents(result);
  if (savedResult && (remainingMissing.length || result.sourceCount < MIN_VERIFIED_SOURCES)) {
    const savedFill = savedResult.clips.filter((clip) => remainingMissing.length ? remainingMissing.includes(clip.intent) : true);
    if (savedFill.length) {
      const verified = [...result.clips, ...savedFill].filter((clip, index, items) => items.findIndex((item) => item.id === clip.id) === index);
      result = buildVerifiedResearchResult({ ...result, clips: verified }, verified, 0);
      result.warnings = ["Reused still-valid evidence from the previous seven-day research cache where live YouTube results had a category gap.", ...result.warnings];
    }
  }

  const finalMissing = missingIntents(result);
  if (finalMissing.length || result.sourceCount < MIN_VERIFIED_SOURCES) {
    const missingMessage = finalMissing.length ? ` Missing: ${intentLabels(finalMissing)}.` : "";
    throw new Error(`TripTrace could not verify four complete categories from at least ${MIN_VERIFIED_SOURCES} independent videos.${missingMessage}`);
  }
  result = qualifyPracticalClaims(result);
  await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  onProgress("complete", `Finished with ${result.sourceCount} videos and ${result.clipCount} verified clips.`, 5, 5);
  return result;
}
