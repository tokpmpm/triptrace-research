import type { PlaceResearchResult, ResearchClip, ResearchIntent, ResearchVideo } from "@/types/research";

export type TranscriptCue = { startSeconds: number; endSeconds: number; text: string };

export type ResearchVideoTranscript = ResearchVideo & {
  captionTrack: "creator" | "automatic";
  language: string;
  searchIntents: ResearchIntent[];
  cues: TranscriptCue[];
};

export const MAX_VIDEO_AGE_YEARS = 2;

export function recentVideoCutoffDate(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - MAX_VIDEO_AGE_YEARS);
  return cutoff.toISOString().slice(0, 10);
}

export function isRecentPublishedAt(publishedAt: string | undefined, now = new Date()) {
  if (!publishedAt || !/^\d{4}-\d{2}-\d{2}$/.test(publishedAt)) return false;
  const publishedTime = Date.parse(`${publishedAt}T00:00:00.000Z`);
  if (!Number.isFinite(publishedTime)) return false;
  if (new Date(publishedTime).toISOString().slice(0, 10) !== publishedAt) return false;
  const nowTime = now.getTime();
  return publishedTime >= Date.parse(`${recentVideoCutoffDate(now)}T00:00:00.000Z`) && publishedTime <= nowTime;
}

export function reconcileVerificationCounts(
  verification: NonNullable<PlaceResearchResult["verification"]>,
  verifiedClipCount: number
) {
  const verifiedClips = Math.min(verification.candidateClips, Math.max(0, verifiedClipCount));
  const rejectedLocation = Math.min(
    Math.max(0, verification.candidateClips - verifiedClips),
    Math.max(0, verification.rejectedLocation)
  );
  const evidenceMatches = verifiedClips + rejectedLocation;
  return {
    ...verification,
    evidenceMatches,
    verifiedClips,
    rejectedEvidenceOrRanking: verification.candidateClips - evidenceMatches,
    rejectedLocation
  };
}

type ClipCandidate = Omit<ResearchClip, "title" | "takeaway"> & { score: number; matchedKeywords: string[]; intentSearchMatch: boolean };

const KEYWORDS: Record<ResearchIntent, string[]> = {
  why_visit: ["worth", "must visit", "must see", "beautiful", "historic", "history", "heritage", "culture", "architecture", "oldest", "traditional", "preserved", "atmosphere", "charming", "special", "unique", "favorite", "popular", "famous", "largest", "best", "vibrant", "lively", "energy", "nightlife", "character", "iconic", "landmark", "significance", "experience", "shopping district", "pedestrian"],
  activity: ["explore", "museum", "temple", "shrine", "gardens", "garden", "tour", "visit", "walk", "stroll", "browse", "shopping", "shop", "view", "sunset", "pier", "waterfront", "exhibition", "craft", "building", "park", "street", "market", "nightlife", "arcade", "cinema", "theater", "theatre", "pedestrian", "experience", "people watching"],
  food: ["delicious", "specialty", "speciality", "sushi", "seafood", "ramen", "noodle", "noodles", "rice", "pork", "sausage", "shrimp", "dumpling", "dumplings", "tea", "dessert", "pastry", "breakfast", "stall", "vendor", "drink", "croquette", "snack", "dish", "taste", "tasty", "restaurant", "street food", "food", "eat", "cafe", "lunch", "dinner", "coffee", "flavor", "flavour", "sweet", "savory", "savoury", "crispy", "crunchy", "filling", "ingredient", "custard", "cream", "bite", "texture"],
  practical_tip: ["reservation", "restroom", "photography", "not allowed", "cash only", "payment", "card", "station", "exit", "early", "before", "after", "morning", "weekday", "weekdays", "crowded", "crowds", "crowd", "avoid", "hours", "closing", "closed", "close", "open", "ticket", "minutes", "wait", "line", "train", "metro", "bus", "ferry", "weekend", "queue", "busy"]
};

const KEYWORD_WEIGHTS: Record<ResearchIntent, Record<string, number>> = {
  why_visit: { worth: 5, "must visit": 5, "must see": 5, beautiful: 3, historic: 4, history: 3, heritage: 4, culture: 3, architecture: 4, oldest: 4, traditional: 3, preserved: 3, atmosphere: 3, charming: 3, special: 3, unique: 4, favorite: 3, popular: 2, famous: 1, largest: 2, best: 2, vibrant: 4, lively: 4, energy: 3, nightlife: 3, character: 3, iconic: 4, landmark: 4, significance: 4, experience: 2, "shopping district": 4, pedestrian: 2 },
  activity: { explore: 5, museum: 5, temple: 5, shrine: 5, gardens: 5, garden: 5, tour: 4, visit: 3, walk: 2, stroll: 3, browse: 3, shopping: 3, shop: 2, view: 3, sunset: 4, pier: 4, waterfront: 4, exhibition: 4, craft: 3, building: 2, park: 4, street: 1, market: 1, nightlife: 3, arcade: 4, cinema: 4, theater: 4, theatre: 4, pedestrian: 2, experience: 3, "people watching": 3 },
  food: { delicious: 5, specialty: 4, speciality: 4, sushi: 5, seafood: 5, ramen: 5, noodle: 5, noodles: 5, rice: 4, pork: 4, sausage: 5, shrimp: 4, dumpling: 5, dumplings: 5, tea: 2, dessert: 4, pastry: 4, breakfast: 3, stall: 3, vendor: 2, drink: 2, croquette: 5, snack: 4, dish: 4, taste: 4, tasty: 4, restaurant: 3, "street food": 4, food: 2, eat: 1, cafe: 3, lunch: 2, dinner: 2, coffee: 3, flavor: 3, flavour: 3, sweet: 2, savory: 3, savoury: 3, crispy: 3, crunchy: 3, filling: 3, ingredient: 2, custard: 3, cream: 2, bite: 2, texture: 2 },
  practical_tip: { reservation: 5, restroom: 5, photography: 4, "not allowed": 5, "cash only": 5, payment: 4, card: 3, station: 4, exit: 5, early: 4, before: 3, after: 2, morning: 2, weekday: 3, weekdays: 3, crowded: 4, crowds: 4, crowd: 4, avoid: 4, hours: 4, closing: 4, closed: 4, close: 4, open: 2, ticket: 4, minutes: 2, wait: 3, line: 3, train: 3, metro: 3, bus: 3, ferry: 3, weekend: 3, queue: 4, busy: 2 }
};

const STOPWORDS = new Set(["tokyo", "japan", "the", "and", "area", "guide"]);
const STRONG_TIP_TERMS = ["reservation", "restroom", "photography", "not allowed", "cash only", "payment", "card", "station", "exit", "arrive", "early", "before 11", "weekday", "weekdays", "crowded", "crowds", "crowd", "avoid", "opening hours", "closing", "closed", "ticket", "minutes", "train", "metro", "bus", "ferry", "weekend", "queue"];
const ACTIONABLE_TIP_OUTPUT_TERMS = ["reservation", "restroom", "photography", "cash", "payment", "card", "station", "exit", "arrive", "early", "before", "weekday", "crowd", "avoid", "hours", "closing", "closed", "ticket", "minutes", "train", "metro", "bus", "ferry", "weekend", "queue", "walk from", "how to reach", "how to get"];
const WHY_REASON_TERMS = ["worth", "must visit", "must see", "beautiful", "historic", "history", "heritage", "culture", "architecture", "oldest", "traditional", "preserved", "atmosphere", "charming", "special", "unique", "favorite", "popular", "famous", "largest", "vibrant", "lively", "energy", "nightlife", "character", "iconic", "landmark", "significance", "shopping district", "pedestrian"];
const WHY_TITLE_TERMS = ["why", "worth", "remarkable", "engineering", "design", "history", "heritage", "culture", "architecture", "significance", "oldest", "unique", "vibrant", "lively", "nightlife", "iconic", "landmark", "character", "atmosphere"];

const TOPIC_LOOKBACK_SECONDS = 36;
const EVIDENCE_WINDOW_SECONDS = 26;
const CONTEXT_WINDOW_SECONDS = 52;
const TOPIC_BREAK_PATTERN = /\b(?:next|moving on|after that|finally|back to|we(?:'re| are) leaving|heading to|arriving at)\b/i;
const TOPIC_LEAD_IN_PATTERN = /\b(?:our|the)\s+(?:last|first)\b/i;

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeResearchText(value: string) {
  return cleanText(value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " "));
}

export function parseResearchJson3(document: unknown): TranscriptCue[] {
  const input = document as { events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }> };
  if (!Array.isArray(input?.events)) throw new Error("Subtitle JSON is missing timed events.");
  return input.events.flatMap((event) => {
    if (typeof event.tStartMs !== "number") return [];
    const text = cleanText((event.segs || []).map((segment) => segment.utf8 || "").join(""));
    if (!text) return [];
    const durationMs = typeof event.dDurationMs === "number" ? event.dDurationMs : 0;
    return [{ startSeconds: event.tStartMs / 1000, endSeconds: (event.tStartMs + durationMs) / 1000, text }];
  });
}

function textBetween(cues: TranscriptCue[], start: number, end: number) {
  return cleanText(cues.filter((cue) => cue.endSeconds >= start && cue.startSeconds < end).map((cue) => cue.text).join(" "));
}

function placeTokens(place: string) {
  return normalizeResearchText(place).split(" ").filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function getPrimaryPlaceToken(tokens: string[]) {
  return tokens.find((token) => /\d/.test(token)) || [...tokens].sort((a, b) => b.length - a.length)[0];
}

function includesKeyword(normalized: string, keyword: string) {
  return ` ${normalized} `.includes(` ${normalizeResearchText(keyword)} `);
}

function supportMatchesQuote(quote: string, supportQuote: string) {
  const candidates = [normalizeResearchText(supportQuote)];
  if (/(?:\.{2,}|…)[\s]*$/u.test(supportQuote)) {
    const withoutEllipsis = supportQuote.replace(/(?:\.{2,}|…)[\s]*$/u, "").trim();
    const words = withoutEllipsis.split(/\s+/);
    if ((words.at(-1) || "").length < 3) words.pop();
    candidates.push(normalizeResearchText(words.join(" ")));
  }
  return candidates.some((candidate) => candidate.length >= 12 && quote.includes(candidate));
}

const ALIGNMENT_STOPWORDS = new Set([
  ...STOPWORDS,
  "about", "after", "also", "because", "before", "being", "could", "from", "have", "into", "more", "most", "only", "over", "some", "than", "that", "their", "there", "these", "they", "this", "through", "very", "what", "when", "where", "which", "with", "would"
]);

function meaningfulTokens(value: string) {
  return normalizeResearchText(value).split(" ").filter((token) => token.length >= 4 && !ALIGNMENT_STOPWORDS.has(token));
}

function meaningfulBigrams(value: string) {
  const tokens = meaningfulTokens(value);
  return tokens.slice(0, -1).map((token, index) => `${token} ${tokens[index + 1]}`);
}

function findTopicStartIndex(cues: TranscriptCue[], anchorIndex: number, intent: ResearchIntent, anchorQuote: string) {
  const anchor = cues[anchorIndex];
  if (TOPIC_LEAD_IN_PATTERN.test(anchorQuote)) return anchorIndex;
  const topicTokens = new Set(meaningfulTokens(anchorQuote));
  const topicPhrases = meaningfulBigrams(anchorQuote);
  let startIndex = anchorIndex;
  let connected = false;
  let bridgeUsed = false;
  let phraseMatches = 0;

  for (let index = anchorIndex - 1; index >= 0; index -= 1) {
    const cue = cues[index];
    if (anchor.startSeconds - cue.endSeconds > TOPIC_LOOKBACK_SECONDS) break;
    if (TOPIC_BREAK_PATTERN.test(cue.text)) break;
    const cueText = normalizeResearchText(cue.text);
    const overlap = meaningfulTokens(cue.text).filter((token) => topicTokens.has(token)).length;
    const categoryScore = semanticScores(normalizeResearchText(cue.text))[intent];
    const hasTopicPhrase = topicPhrases.some((phrase) => includesKeyword(cueText, phrase));
    if (hasTopicPhrase) phraseMatches += 1;
    if (phraseMatches >= 2 && !hasTopicPhrase) break;
    if (overlap >= 1 || categoryScore >= 2) {
      startIndex = index;
      connected = true;
      continue;
    }
    if (connected && !bridgeUsed && cue.text.length <= 70) {
      startIndex = index;
      bridgeUsed = true;
      continue;
    }
    break;
  }
  return startIndex;
}

function takeawayMatchesEvidence(quote: string, supportQuote: string, takeaway: string, subject: string) {
  const sourceTokens = new Set(meaningfulTokens(`${quote} ${supportQuote}`));
  const takeawayTokens = meaningfulTokens(takeaway);
  const sharedTokens = [...new Set(takeawayTokens)].filter((token) => sourceTokens.has(token));
  const subjectTokens = meaningfulTokens(subject);
  const subjectShared = subjectTokens.filter((token) => takeawayTokens.includes(token));
  return sharedTokens.length >= 3 && (!subjectTokens.length || subjectShared.length > 0);
}

function placeFocusedTitle(place: string, title: string) {
  const primaryToken = getPrimaryPlaceToken(placeTokens(place));
  if (!primaryToken) return true;
  const titleTokens = normalizeResearchText(title).split(" ").filter(Boolean);
  const placeIndex = titleTokens.findIndex((token) => token === primaryToken);
  return placeIndex >= 0 && (placeIndex <= 4 || titleTokens.length <= 12);
}

function semanticScores(normalized: string) {
  return Object.fromEntries((Object.keys(KEYWORD_WEIGHTS) as ResearchIntent[]).map((intent) => [
    intent,
    Object.entries(KEYWORD_WEIGHTS[intent]).reduce((sum, [keyword, weight]) => sum + (includesKeyword(normalized, keyword) ? weight : 0), 0)
  ])) as Record<ResearchIntent, number>;
}

function fallbackTitle(intent: ResearchIntent, quote: string, keywords: string[]) {
  const words = quote.replace(/[“”]/g, "").split(/\s+/).filter(Boolean);
  const normalizedQuote = normalizeResearchText(quote);
  const focus = normalizeResearchText(keywords[0] || "");
  const focusTokens = focus.split(" ").filter(Boolean);
  let focusIndex = focusTokens.length
    ? words.findIndex((_, index) => focusTokens.every((token, offset) => normalizeResearchText(words[index + offset] || "") === token))
    : -1;
  if (focusIndex < 0) focusIndex = 0;
  const start = Math.max(0, focusIndex - 3);
  const end = Math.min(words.length, start + 9);
  const phrase = words.slice(start, end).join(" ").replace(/[,.!?;:]+$/g, "");
  const labels: Record<ResearchIntent, string> = {
    why_visit: "Why visit",
    activity: "Try",
    food: "Eat",
    practical_tip: "Good to know"
  };
  if (phrase.length >= 8 && normalizedQuote.includes(normalizeResearchText(phrase))) return `${labels[intent]}: ${phrase}`;
  return `${labels[intent]}: ${words.slice(0, 9).join(" ").replace(/[,.!?;:]+$/g, "")}`;
}

function fallbackTakeaway(intent: ResearchIntent, quote: string, keywords: string[]) {
  const words = quote.split(/\s+/).filter(Boolean);
  const keywordTokens = normalizeResearchText(keywords[0] || "").split(" ").filter(Boolean);
  const normalizedWords = words.map((word) => normalizeResearchText(word));
  let focusIndex = normalizedWords.findIndex((word, index) => keywordTokens.every((token, offset) => normalizedWords[index + offset] === token));
  if (focusIndex < 0) focusIndex = 0;
  const start = Math.max(0, focusIndex - 5);
  const end = Math.min(words.length, focusIndex + 19);
  const phrase = `${start > 0 ? "…" : ""}${words.slice(start, end).join(" ")}${end < words.length ? "…" : ""}`;
  const label: Record<ResearchIntent, string> = {
    why_visit: "Why it stands out",
    activity: "Suggested experience",
    food: "Food highlight",
    practical_tip: "Planning takeaway"
  };
  return `${label[intent]}: ${phrase}`;
}

export function extractResearchClips(place: string, videos: ResearchVideoTranscript[]): ResearchClip[] {
  const tokens = placeTokens(place);
  const candidates: ClipCandidate[] = [];

  for (const video of videos) {
    const normalizedTitle = normalizeResearchText(video.title);
    const titleLocationScore = tokens.filter((token) => normalizedTitle.includes(token)).length * 4;
    const primaryPlaceToken = getPrimaryPlaceToken(tokens);
    const locationContext = textBetween(video.cues, 0, 60);
    const videoPlaceFocused = !primaryPlaceToken
      || placeFocusedTitle(place, video.title)
      || includesKeyword(normalizeResearchText(locationContext), primaryPlaceToken);
    for (const intent of Object.keys(KEYWORDS) as ResearchIntent[]) {
      for (let index = 0; index < video.cues.length; index += 1) {
        const cue = video.cues[index];
        const anchorQuote = textBetween(video.cues, cue.startSeconds, cue.startSeconds + 18);
        const topicStartIndex = findTopicStartIndex(video.cues, index, intent, anchorQuote);
        const evidenceStart = video.cues[topicStartIndex]?.startSeconds ?? cue.startSeconds;
        const quote = textBetween(video.cues, evidenceStart, evidenceStart + EVIDENCE_WINDOW_SECONDS);
        const context = textBetween(video.cues, evidenceStart, evidenceStart + CONTEXT_WINDOW_SECONDS);
        const anchorContext = textBetween(video.cues, cue.startSeconds, cue.startSeconds + 38);
        const normalizedQuote = normalizeResearchText(quote);
        const normalizedContext = normalizeResearchText(context);
        const normalizedAnchorContext = normalizeResearchText(anchorContext);
        if (normalizeResearchText(anchorQuote).length < 45 || normalizedQuote.length < 45) continue;
        if (primaryPlaceToken && !videoPlaceFocused && !includesKeyword(`${normalizeResearchText(anchorQuote)} ${normalizedAnchorContext}`, primaryPlaceToken)) continue;
        const categoryScores = semanticScores(normalizeResearchText(anchorQuote));
        const semanticScore = categoryScores[intent];
        const strongestOtherScore = Math.max(...(Object.keys(categoryScores) as ResearchIntent[]).filter((category) => category !== intent).map((category) => categoryScores[category]));
        const hasStrongPracticalEvidence = intent === "practical_tip" && STRONG_TIP_TERMS.some((term) => includesKeyword(normalizeResearchText(anchorQuote), term));
        if (semanticScore < 3) continue;
        if (semanticScore + 1 < strongestOtherScore && !hasStrongPracticalEvidence) continue;
        const matchedKeywords = KEYWORDS[intent].filter((keyword) => includesKeyword(normalizeResearchText(anchorQuote), keyword));
        if (!matchedKeywords.length) continue;
        const locationMentions = tokens.filter((token) => normalizedAnchorContext.includes(token)).length;
        const intentSearchBonus = video.searchIntents.includes(intent) ? 2 : 0;
        const score = semanticScore * 4 + locationMentions * 5 + titleLocationScore + intentSearchBonus;
        if (score < 9) continue;
        const startSeconds = Math.max(0, Math.floor(evidenceStart) - 1);
        candidates.push({
          id: `${video.id}-${intent}-${startSeconds}`,
          intent,
          startSeconds,
          endSeconds: Math.ceil(evidenceStart + CONTEXT_WINDOW_SECONDS),
          exactQuote: quote,
          contextText: context,
          locationContext,
          captionTrack: video.captionTrack,
          language: video.language,
          video: { id: video.id, title: video.title, channelName: video.channelName, thumbnailUrl: video.thumbnailUrl, publishedAt: video.publishedAt },
          score,
          matchedKeywords,
          intentSearchMatch: video.searchIntents.includes(intent)
        });
      }
    }
  }

  const selected: ClipCandidate[] = [];
  const usedRanges = new Map<string, number[]>();
  const intents = ["why_visit", "activity", "food", "practical_tip"] as ResearchIntent[];
  const rankedFor = (intent: ResearchIntent) => candidates
    .filter((candidate) => candidate.intent === intent)
    .sort((a, b) => Number(b.intentSearchMatch) - Number(a.intentSearchMatch) || b.score - a.score || a.startSeconds - b.startSeconds);
  const canUse = (candidate: ClipCandidate) => {
    const videoRanges = usedRanges.get(candidate.video.id) || [];
    if (videoRanges.some((start) => Math.abs(start - candidate.startSeconds) < 32)) return false;
    return !selected.some((item) => item.intent === candidate.intent && item.video.id === candidate.video.id);
  };
  const addCandidate = (candidate: ClipCandidate) => {
    const videoRanges = usedRanges.get(candidate.video.id) || [];
    selected.push(candidate);
    usedRanges.set(candidate.video.id, [...videoRanges, candidate.startSeconds]);
  };

  // Reserve one purpose-matched, non-overlapping clip per intent before any
  // category can consume a second source. This prevents broad words such as
  // "market" from making every section point to the same moment.
  for (const intent of intents) {
    const first = rankedFor(intent).find(canUse);
    if (first) addCandidate(first);
  }
  for (const intent of intents) {
    for (const candidate of rankedFor(intent)) {
      if (selected.filter((item) => item.intent === intent).length >= 3) break;
      if (canUse(candidate)) addCandidate(candidate);
    }
  }

  const selectedVideoIds = new Set(selected.map((item) => item.video.id));
  if (selectedVideoIds.size < 3) {
    const diversityCandidates = [...candidates].sort((a, b) => b.score - a.score);
    for (const candidate of diversityCandidates) {
      if (selectedVideoIds.has(candidate.video.id)) continue;
      const videoRanges = usedRanges.get(candidate.video.id) || [];
      if (videoRanges.some((start) => Math.abs(start - candidate.startSeconds) < 32)) continue;
      selected.push(candidate);
      selectedVideoIds.add(candidate.video.id);
      usedRanges.set(candidate.video.id, [...videoRanges, candidate.startSeconds]);
      if (selectedVideoIds.size >= 3) break;
    }
  }

  return selected.map(({ score: _score, matchedKeywords, intentSearchMatch: _intentSearchMatch, ...clip }) => ({
    ...clip,
    title: fallbackTitle(clip.intent, clip.exactQuote, matchedKeywords),
    takeaway: fallbackTakeaway(clip.intent, clip.exactQuote, matchedKeywords),
    highlights: [...new Set(matchedKeywords)].slice(0, 4)
  }));
}

export function buildExtractiveResearchResult(place: string, city: string, clips: ResearchClip[], generatedAt: string): PlaceResearchResult {
  const sourceCount = new Set(clips.map((clip) => clip.video.id)).size;
  const covered = new Set(clips.map((clip) => clip.intent));
  const warnings = [
    ...(!covered.has("why_visit") ? ["No reliable why-visit segment was found in the selected captions."] : []),
    ...(!covered.has("activity") ? ["No reliable activity segment was found in the selected captions."] : []),
    ...(!covered.has("food") ? ["No reliable food segment was found in the selected captions."] : []),
    ...(!covered.has("practical_tip") ? ["No reliable practical-tip segment was found in the selected captions."] : []),
    "Opening hours, prices, reservations, and temporary closures still require a current check."
  ];
  const planOrder: ResearchIntent[] = ["practical_tip", "activity", "food"];
  const suggestedPlan = planOrder.flatMap((intent) => clips.filter((clip) => clip.intent === intent).slice(0, intent === "activity" ? 2 : 1).map((clip) => clip.title));
  return {
    place,
    city,
    overview: `${sourceCount} captioned travel videos produced ${clips.length} distinct, timestamped clips for ${place}. Review the creator quotes below before using the suggested visit outline.`,
    generatedAt,
    cacheHit: false,
    sourceCount,
    clipCount: clips.length,
    clips,
    suggestedPlan,
    warnings,
    mode: "extractive"
  };
}

export type SemanticClipAnalysis = {
  clipId: string;
  intent: ResearchIntent;
  primarySubject: string;
  title: string;
  takeaway: string;
  supportQuote: string;
  highlights: string[];
  mentionOnly: boolean;
  placeRelevant: boolean;
  confidence: number;
  poiName?: string | null;
  locationRelationship?: "queried_place" | "inside" | "nearby" | "different_area" | "unknown";
  locationEvidence?: string | null;
};

function limitVerifiedClips(clips: ResearchClip[]) {
  const intents = ["why_visit", "activity", "food", "practical_tip"] as ResearchIntent[];
  const selected: ResearchClip[] = [];
  const usedVideos = new Set<string>();
  for (let round = 0; round < 3; round += 1) {
    for (const intent of intents) {
      const candidates = clips.filter((clip) => clip.intent === intent && !selected.some((item) => item.id === clip.id));
      const candidate = candidates.find((clip) => !usedVideos.has(clip.video.id)) || candidates[0];
      if (candidate) {
        selected.push(candidate);
        usedVideos.add(candidate.video.id);
      }
    }
  }
  return intents.flatMap((intent) => selected.filter((clip) => clip.intent === intent));
}

export function buildVerifiedResearchResult(result: PlaceResearchResult, verifiedClips: ResearchClip[], rejectedCount: number): PlaceResearchResult {
  const limited = limitVerifiedClips(verifiedClips);
  const sourceCount = new Set(limited.map((clip) => clip.video.id)).size;
  const covered = new Set(limited.map((clip) => clip.intent));
  const planOrder: ResearchIntent[] = ["practical_tip", "activity", "food"];
  return {
    ...result,
    overview: `${sourceCount} captioned travel videos produced ${limited.length} semantically verified clips for ${result.place}. Each title is tied to an exact supporting quote.`,
    sourceCount,
    clipCount: limited.length,
    clips: limited,
    suggestedPlan: planOrder.flatMap((intent) => limited.filter((clip) => clip.intent === intent).slice(0, intent === "activity" ? 2 : 1).map((clip) => clip.title)),
    warnings: [
      ...(rejectedCount ? [`${rejectedCount} keyword-matched clips were omitted because their main subject or title support was not strong enough.`] : []),
      ...(!covered.has("why_visit") ? ["No reliable why-visit segment passed semantic verification."] : []),
      ...(!covered.has("activity") ? ["No reliable activity segment passed semantic verification."] : []),
      ...(!covered.has("food") ? ["No reliable food segment passed semantic verification."] : []),
      ...(!covered.has("practical_tip") ? ["No reliable practical-tip segment passed semantic verification."] : []),
      "Opening hours, prices, reservations, and temporary closures still require a current check."
    ],
    mode: "ai"
  };
}

export function applySemanticClipAnalyses(result: PlaceResearchResult, analyses: SemanticClipAnalysis[]): PlaceResearchResult {
  const byId = new Map(analyses.map((analysis) => [analysis.clipId, analysis]));
  const placeTokensForResult = placeTokens(result.place);
  const primaryPlaceToken = getPrimaryPlaceToken(placeTokensForResult);
  const requiresSpecificLandmark = placeTokensForResult.some((token) => /\d/.test(token));
  const accepted = result.clips.flatMap((clip) => {
    const analysis = byId.get(clip.id);
    if (!analysis || analysis.mentionOnly || !analysis.placeRelevant || analysis.confidence < 0.76) return [];
    const locationRelationship = analysis.locationRelationship || "queried_place";
    if (locationRelationship === "different_area" || locationRelationship === "unknown") return [];
    if (analysis.locationEvidence !== undefined) {
      const locationProof = normalizeResearchText(analysis.locationEvidence || "");
      const suppliedLocationText = normalizeResearchText(`${clip.exactQuote} ${clip.contextText}`);
      if (locationProof.length < 8 || !suppliedLocationText.includes(locationProof)) return [];
      if (locationRelationship === "nearby" && (!analysis.poiName || !locationProof.includes(normalizeResearchText(analysis.poiName)))) return [];
    }
    const quoteText = normalizeResearchText(clip.exactQuote);
    const subject = normalizeResearchText(analysis.primarySubject);
    const support = normalizeResearchText(analysis.supportQuote);
    const normalizedTitle = normalizeResearchText(analysis.title);
    const titleWordCount = normalizedTitle.split(" ").filter(Boolean).length;
    const subjectTokens = subject.split(" ").filter((token) => token.length > 2);
    const quoteTokens = new Set(quoteText.split(" ").filter(Boolean));
    const titleTokens = new Set(normalizedTitle.split(" ").filter(Boolean));
    const subjectTitleOverlap = subjectTokens.length ? subjectTokens.filter((token) => titleTokens.has(token)).length / subjectTokens.length : 0;
    const subjectQuoteOverlap = subjectTokens.length ? subjectTokens.filter((token) => quoteTokens.has(token)).length / subjectTokens.length : 0;
    const locationEvidence = normalizeResearchText(`${clip.contextText} ${clip.locationContext || ""}`);
    if (primaryPlaceToken && !includesKeyword(locationEvidence, primaryPlaceToken) && !placeFocusedTitle(result.place, clip.video.title)) return [];
    const titleScores = semanticScores(normalizedTitle);
    const quoteAndTitleScores = semanticScores(`${quoteText} ${normalizedTitle}`);
    if (analysis.intent !== "food" && titleScores.food >= 4) return [];
    if (requiresSpecificLandmark && !includesKeyword(normalizeResearchText(`${analysis.title} ${analysis.primarySubject} ${clip.exactQuote}`), primaryPlaceToken || "")) return [];
    const hasWhyReason = WHY_REASON_TERMS.some((term) => includesKeyword(`${quoteText} ${normalizedTitle}`, term));
    const hasSpecificWhyTitle = WHY_TITLE_TERMS.some((term) => includesKeyword(normalizedTitle, term));
    const titleNamesPlaceOrSubject = normalizedTitle.includes(subject) || subjectTitleOverlap >= 0.5 || placeFocusedTitle(result.place, analysis.title);
    if (analysis.intent === "why_visit" && (quoteAndTitleScores.why_visit < 3 || !hasWhyReason || (!hasSpecificWhyTitle && !titleNamesPlaceOrSubject))) return [];
    if (analysis.intent === "activity" && quoteAndTitleScores.activity < 3) return [];
    if (analysis.intent === "food" && quoteAndTitleScores.food < 3) return [];
    if (analysis.intent === "practical_tip") {
      if (!STRONG_TIP_TERMS.some((term) => includesKeyword(quoteText, term))) return [];
      const outputText = normalizeResearchText(`${analysis.title} ${analysis.takeaway}`);
      if (!ACTIONABLE_TIP_OUTPUT_TERMS.some((term) => includesKeyword(outputText, term))) return [];
    }
    if (subject.length < 3 || support.length < 12 || (!quoteText.includes(subject) && subjectQuoteOverlap < 0.5) || !supportMatchesQuote(quoteText, analysis.supportQuote)) return [];
    if (!takeawayMatchesEvidence(clip.exactQuote, analysis.supportQuote, analysis.takeaway, analysis.primarySubject)) return [];
    if ((!normalizedTitle.includes(subject) && subjectTitleOverlap < 0.5) || titleWordCount < 3 || titleWordCount > 14) return [];
    if (normalizedTitle === normalizeResearchText(clip.video.title)) return [];
    const highlights = analysis.highlights.filter((term) => normalizeResearchText(analysis.takeaway).includes(normalizeResearchText(term))).slice(0, 3);
    const title = analysis.intent === "practical_tip" && !/^creator tip:/i.test(analysis.title) ? `Creator tip: ${analysis.title}` : analysis.title;
    const takeaway = analysis.intent === "practical_tip" && !/^the creator/i.test(analysis.takeaway)
      ? `The creator observed: ${analysis.takeaway.charAt(0).toLowerCase()}${analysis.takeaway.slice(1)}`
      : analysis.takeaway;
    return [{
      ...clip,
      intent: analysis.intent,
      title,
      takeaway,
      highlights,
      locationVerification: {
        poiName: analysis.poiName?.trim() || result.place,
        relationship: locationRelationship,
        evidence: analysis.locationEvidence?.trim() || analysis.supportQuote,
        status: "pending" as const,
        distanceMeters: 0
      }
    }];
  });
  return buildVerifiedResearchResult(result, accepted, result.clips.length - accepted.length);
}
