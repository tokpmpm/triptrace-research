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
  why_visit: ["worth", "must visit", "must see", "beautiful", "historic", "history", "heritage", "culture", "architecture", "oldest", "traditional", "preserved", "atmosphere", "charming", "special", "unique", "favorite", "popular", "famous", "largest", "best", "vibrant", "lively", "energy", "nightlife", "character", "iconic", "landmark", "significance", "experience", "shopping district", "pedestrian", "必去", "必訪", "歷史", "文化", "特色", "地標", "古蹟", "老街", "風景", "氛圍", "值得", "著名", "知名"],
  activity: ["explore", "museum", "temple", "shrine", "gardens", "garden", "tour", "visit", "walk", "stroll", "browse", "shopping", "shop", "view", "sunset", "pier", "waterfront", "exhibition", "craft", "building", "park", "street", "market", "nightlife", "arcade", "cinema", "theater", "theatre", "pedestrian", "experience", "people watching", "逛", "散步", "拍照", "購物", "參觀", "體驗", "觀景", "遊戲", "碼頭", "市集", "逛街"],
  food: ["delicious", "specialty", "speciality", "sushi", "seafood", "ramen", "noodle", "noodles", "rice", "pork", "sausage", "shrimp", "dumpling", "dumplings", "tea", "dessert", "pastry", "breakfast", "stall", "vendor", "drink", "croquette", "snack", "dish", "taste", "tasty", "restaurant", "street food", "food", "eat", "cafe", "lunch", "dinner", "coffee", "flavor", "flavour", "sweet", "savory", "savoury", "crispy", "crunchy", "filling", "ingredient", "custard", "cream", "bite", "texture", "美食", "小吃", "餐廳", "攤位", "牛肉麵", "蚵仔煎", "珍珠奶茶", "雞排", "滷肉飯", "茶", "糕餅", "點心", "咖啡", "油飯", "潤餅", "蚵嗲", "蚵仔", "魚丸湯", "豆花", "肉圓", "古早味", "麵線", "糕點", "吃", "喝"],
  practical_tip: ["reservation", "restroom", "photography", "not allowed", "cash only", "payment", "card", "station", "exit", "early", "before", "after", "morning", "weekday", "weekdays", "crowded", "crowds", "crowd", "avoid", "hours", "closing", "closed", "close", "open", "ticket", "minutes", "wait", "line", "train", "metro", "bus", "ferry", "weekend", "queue", "busy", "捷運", "出口", "營業", "排隊", "人潮", "建議", "注意", "交通", "時間", "晚上", "早上", "週末", "現金", "刷卡", "票", "預約", "怎麼去", "抵達", "步行", "走路", "轉乘", "下車", "路線", "前往", "北門站", "大橋頭站"]
};

const KEYWORD_WEIGHTS: Record<ResearchIntent, Record<string, number>> = {
  why_visit: { worth: 5, "must visit": 5, "must see": 5, beautiful: 3, historic: 4, history: 3, heritage: 4, culture: 3, architecture: 4, oldest: 4, traditional: 3, preserved: 3, atmosphere: 3, charming: 3, special: 3, unique: 4, favorite: 3, popular: 2, famous: 1, largest: 2, best: 2, vibrant: 4, lively: 4, energy: 3, nightlife: 3, character: 3, iconic: 4, landmark: 4, significance: 4, experience: 2, "shopping district": 4, pedestrian: 2, 必去: 5, 必訪: 5, 歷史: 4, 文化: 4, 特色: 3, 地標: 4, 古蹟: 4, 老街: 3, 風景: 3, 氛圍: 4, 值得: 4, 著名: 3, 知名: 3 },
  activity: { explore: 5, museum: 5, temple: 5, shrine: 5, gardens: 5, garden: 5, tour: 4, visit: 3, walk: 2, stroll: 3, browse: 3, shopping: 3, shop: 2, view: 3, sunset: 4, pier: 4, waterfront: 4, exhibition: 4, craft: 3, building: 2, park: 4, street: 1, market: 1, nightlife: 3, arcade: 4, cinema: 4, theater: 4, theatre: 4, pedestrian: 2, experience: 3, "people watching": 3, 逛: 3, 散步: 3, 拍照: 4, 購物: 4, 參觀: 4, 體驗: 3, 觀景: 4, 遊戲: 4, 碼頭: 4, 市集: 3, 逛街: 3 },
  food: { delicious: 5, specialty: 4, speciality: 4, sushi: 5, seafood: 5, ramen: 5, noodle: 5, noodles: 5, rice: 4, pork: 4, sausage: 5, shrimp: 4, dumpling: 5, dumplings: 5, tea: 2, dessert: 4, pastry: 4, breakfast: 3, stall: 3, vendor: 2, drink: 2, croquette: 5, snack: 4, dish: 4, taste: 4, tasty: 4, restaurant: 3, "street food": 4, food: 2, eat: 1, cafe: 3, lunch: 2, dinner: 2, coffee: 3, flavor: 3, flavour: 3, sweet: 2, savory: 3, savoury: 3, crispy: 3, crunchy: 3, filling: 3, ingredient: 2, custard: 3, cream: 2, bite: 2, texture: 2, 美食: 4, 小吃: 4, 餐廳: 3, 攤位: 3, 牛肉麵: 5, 蚵仔煎: 5, 珍珠奶茶: 4, 雞排: 5, 滷肉飯: 5, 茶: 2, 糕餅: 4, 點心: 4, 咖啡: 3, 油飯: 5, 潤餅: 5, 蚵嗲: 5, 蚵仔: 4, 魚丸湯: 5, 豆花: 5, 肉圓: 5, 古早味: 3, 麵線: 4, 糕點: 4, 吃: 1, 喝: 1 },
  practical_tip: { reservation: 5, restroom: 5, photography: 4, "not allowed": 5, "cash only": 5, payment: 4, card: 3, station: 4, exit: 5, early: 4, before: 3, after: 2, morning: 2, weekday: 3, weekdays: 3, crowded: 4, crowds: 4, crowd: 4, avoid: 4, hours: 4, closing: 4, closed: 4, close: 4, open: 2, ticket: 4, minutes: 2, wait: 3, line: 3, train: 3, metro: 3, bus: 3, ferry: 3, weekend: 3, queue: 4, busy: 2, 捷運: 5, 出口: 5, 營業: 4, 排隊: 4, 人潮: 4, 建議: 3, 注意: 3, 交通: 4, 時間: 2, 晚上: 2, 早上: 2, 週末: 3, 現金: 5, 刷卡: 4, 票: 4, 預約: 5, 怎麼去: 5, 抵達: 3, 步行: 4, 走路: 3, 轉乘: 5, 下車: 4, 路線: 4, 前往: 3, 北門站: 5, 大橋頭站: 5 }
};

const STOPWORDS = new Set(["tokyo", "japan", "the", "and", "area", "guide"]);
const STRONG_TIP_TERMS = ["reservation", "restroom", "photography", "not allowed", "cash only", "payment", "card", "station", "exit", "arrive", "early", "before 11", "weekday", "weekdays", "crowded", "crowds", "crowd", "busy", "avoid", "opening hours", "closing", "closed", "ticket", "minutes", "train", "metro", "bus", "ferry", "weekend", "queue", "捷運", "出口", "營業", "排隊", "人潮", "交通", "現金", "刷卡", "預約", "怎麼去", "建議", "轉乘", "下車", "路線", "北門站", "大橋頭站"];
const ACTIONABLE_TIP_OUTPUT_TERMS = ["reservation", "restroom", "photography", "cash", "payment", "card", "station", "exit", "arrive", "early", "before", "weekday", "crowd", "busy", "avoid", "hours", "closing", "closed", "ticket", "minutes", "train", "metro", "bus", "ferry", "weekend", "queue", "walk from", "how to reach", "how to get", "捷運", "出口", "營業", "排隊", "人潮", "交通", "現金", "刷卡", "預約", "怎麼去", "建議", "步行", "走路", "轉乘", "下車", "路線", "前往", "北門站", "大橋頭站"];
const WHY_REASON_TERMS = ["worth", "must visit", "must see", "beautiful", "historic", "history", "heritage", "culture", "architecture", "oldest", "traditional", "preserved", "atmosphere", "charming", "special", "unique", "favorite", "popular", "famous", "largest", "vibrant", "lively", "energy", "nightlife", "character", "iconic", "landmark", "significance", "shopping district", "pedestrian", "必去", "必訪", "歷史", "文化", "特色", "地標", "古蹟", "老街", "風景", "氛圍", "值得", "著名", "知名"];
const WHY_TITLE_TERMS = ["why", "worth", "remarkable", "engineering", "design", "history", "heritage", "culture", "architecture", "significance", "oldest", "unique", "vibrant", "lively", "nightlife", "iconic", "landmark", "character", "atmosphere", "必去", "必訪", "歷史", "文化", "特色", "地標", "古蹟", "老街", "風景", "氛圍", "值得", "著名", "知名"];

const TOPIC_LOOKBACK_SECONDS = 36;
const EVIDENCE_WINDOW_SECONDS = 26;
const CONTEXT_WINDOW_SECONDS = 52;
const TOPIC_BREAK_PATTERN = /\b(?:next|moving on|after that|finally|back to|we(?:'re| are) leaving|heading to|arriving at)\b/i;
const TOPIC_LEAD_IN_PATTERN = /\b(?:our|the)\s+(?:last|first)\b/i;
const CJK_PATTERN = /\p{Script=Han}/u;
const NON_ENGLISH_SCRIPT_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Cyrillic}]/u;
type PlaceTokenAlias = { match: string[]; terms: string[]; inScopeAliases?: string[] };

function isEnglishCaptionLanguage(value: string) {
  return /^en(?:[-_]|$)/i.test(value.trim());
}

function isEnglishDisplayCopy(value: unknown) {
  return typeof value === "string" && /[A-Za-z]{3}/.test(value) && !NON_ENGLISH_SCRIPT_PATTERN.test(value);
}

/**
 * The original transcript remains the validation source. When the source is
 * not English, the UI must have separate English display copy rather than
 * falling back to raw non-English text. The same applies to non-Latin creator
 * names shown in source metadata.
 */
export function hasRequiredEnglishPresentation(clip: Pick<ResearchClip, "language" | "video" | "englishPresentation">) {
  const presentation = clip.englishPresentation;
  if (!isEnglishCaptionLanguage(clip.language)) {
    if (!presentation
      || !isEnglishDisplayCopy(presentation.title)
      || !isEnglishDisplayCopy(presentation.takeaway)
      || !isEnglishDisplayCopy(presentation.exactQuote)
      || !Array.isArray(presentation.highlights)
      || !presentation.highlights.length
      || !presentation.highlights.every(isEnglishDisplayCopy)) return false;
  }
  if (NON_ENGLISH_SCRIPT_PATTERN.test(clip.video.channelName) && !isEnglishDisplayCopy(presentation?.channelName)) return false;
  return true;
}

const PLACE_TOKEN_ALIASES: PlaceTokenAlias[] = [
  { match: ["ximending", "ximen", "西門町"], terms: ["西門町", "西門", "ximending", "ximen"] },
  // Dihua Street is inside the Dadaocheng district. Include the usual Latin
  // spelling and the common automatic-caption misspelling, but do not accept
  // generic Taipei evidence; semantic and geospatial validation still apply.
  {
    match: ["dadaocheng", "大稻埕"],
    terms: ["大稻埕", "迪化街", "dadaocheng", "dihua", "dihwa"],
    inScopeAliases: ["Dihua Street", "Dihwa Street"]
  },
  { match: ["shilin night market", "士林夜市"], terms: ["士林夜市", "士林", "shilin"] },
  { match: ["taipei 101", "taipei101", "台北101", "臺北101"], terms: ["台北101", "臺北101", "taipei 101"] }
];

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

function containsCjk(value: string) {
  return CJK_PATTERN.test(value);
}

function placeTokens(place: string) {
  const normalizedPlace = normalizeResearchText(place);
  const alias = PLACE_TOKEN_ALIASES.find((entry) => entry.match.some((term) => normalizedPlace.includes(normalizeResearchText(term))));
  const terms = alias ? [...alias.terms, normalizedPlace] : normalizedPlace.split(" ");
  return [...new Set(terms)]
    .map(normalizeResearchText)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/**
 * Explicitly scoped sub-place names that may be used as location metadata for
 * a requested place. This is intentionally not a broad city alias list.
 */
export function inScopePlaceAliases(place: string) {
  const normalizedPlace = normalizeResearchText(place);
  const alias = PLACE_TOKEN_ALIASES.find((entry) => entry.match.some((term) => normalizedPlace.includes(normalizeResearchText(term))));
  return alias?.inScopeAliases || [];
}

function includesKeyword(normalized: string, keyword: string) {
  const normalizedKeyword = normalizeResearchText(keyword);
  if (!normalizedKeyword) return false;
  return containsCjk(normalizedKeyword)
    ? normalized.includes(normalizedKeyword)
    : ` ${normalized} `.includes(` ${normalizedKeyword} `);
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
  const normalizedQuote = normalizeResearchText(quote);
  const normalizedTakeaway = normalizeResearchText(takeaway);
  const normalizedSubject = normalizeResearchText(subject);
  // CJK subtitles do not have reliable word boundaries. Require the model to
  // keep an exact subject or support phrase rather than weakening the source
  // link to character-level keyword matching.
  if (containsCjk(`${normalizedQuote} ${normalizedTakeaway} ${normalizedSubject}`)) {
    const sourcePhrases = [normalizedSubject, normalizeResearchText(supportQuote)]
      .filter((phrase) => phrase.length >= 3 && normalizedQuote.includes(phrase));
    return sourcePhrases.some((phrase) => normalizedTakeaway.includes(phrase));
  }
  const sourceTokens = new Set(meaningfulTokens(`${quote} ${supportQuote}`));
  const takeawayTokens = meaningfulTokens(takeaway);
  const sharedTokens = [...new Set(takeawayTokens)].filter((token) => sourceTokens.has(token));
  const subjectTokens = meaningfulTokens(subject);
  const subjectShared = subjectTokens.filter((token) => takeawayTokens.includes(token));
  return sharedTokens.length >= 3 && (!subjectTokens.length || subjectShared.length > 0);
}

function placeFocusedTitle(place: string, title: string) {
  const tokens = placeTokens(place);
  if (!tokens.length) return true;
  const normalizedTitle = normalizeResearchText(title);
  return tokens.some((token) => includesKeyword(normalizedTitle, token));
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
    const locationContext = textBetween(video.cues, 0, 60);
    const hasPlaceMention = (text: string) => tokens.some((token) => includesKeyword(normalizeResearchText(text), token));
    const videoPlaceFocused = !tokens.length
      || placeFocusedTitle(place, video.title)
      || hasPlaceMention(locationContext);
    for (const intent of Object.keys(KEYWORDS) as ResearchIntent[]) {
      for (let index = 0; index < video.cues.length; index += 1) {
        const cue = video.cues[index];
        const anchorQuote = textBetween(video.cues, cue.startSeconds, cue.startSeconds + 18);
        const topicStartIndex = findTopicStartIndex(video.cues, index, intent, anchorQuote);
        const evidenceStart = video.cues[topicStartIndex]?.startSeconds ?? cue.startSeconds;
        // Route, queue, and timing instructions frequently finish in the next
        // caption sentence. Keep the full practical context as the exact quote
        // so semantic verification never has to rely on unseen continuation.
        const evidenceWindowSeconds = intent === "practical_tip" ? CONTEXT_WINDOW_SECONDS : EVIDENCE_WINDOW_SECONDS;
        const quote = textBetween(video.cues, evidenceStart, evidenceStart + evidenceWindowSeconds);
        const context = textBetween(video.cues, evidenceStart, evidenceStart + CONTEXT_WINDOW_SECONDS);
        const anchorContext = textBetween(video.cues, cue.startSeconds, cue.startSeconds + 38);
        const normalizedQuote = normalizeResearchText(quote);
        const normalizedContext = normalizeResearchText(context);
        const normalizedAnchorContext = normalizeResearchText(anchorContext);
        const minimumEvidenceTextLength = containsCjk(`${anchorQuote} ${quote}`) ? 24 : 45;
        if (normalizeResearchText(anchorQuote).length < minimumEvidenceTextLength || normalizedQuote.length < minimumEvidenceTextLength) continue;
        if (tokens.length && !videoPlaceFocused && !hasPlaceMention(`${anchorQuote} ${anchorContext}`)) continue;
        const categoryScores = semanticScores(normalizeResearchText(anchorQuote));
        const semanticScore = categoryScores[intent];
        const strongestOtherScore = Math.max(...(Object.keys(categoryScores) as ResearchIntent[]).filter((category) => category !== intent).map((category) => categoryScores[category]));
        const hasStrongPracticalEvidence = intent === "practical_tip" && STRONG_TIP_TERMS.some((term) => includesKeyword(normalizeResearchText(anchorQuote), term));
        if (semanticScore < 3) continue;
        if (semanticScore + 1 < strongestOtherScore && !hasStrongPracticalEvidence) continue;
        const matchedKeywords = KEYWORDS[intent].filter((keyword) => includesKeyword(normalizeResearchText(anchorQuote), keyword));
        if (!matchedKeywords.length) continue;
        const locationMentions = tokens.filter((token) => includesKeyword(normalizedAnchorContext, token)).length;
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
  locationEvidenceSource?: "transcript" | "video_title" | null;
  /** Separate UI translation; the original source-language fields above stay inspectable. */
  englishPresentation?: NonNullable<ResearchClip["englishPresentation"]> | null;
};

/**
 * Keep the semantic request within its structured-output limit while retaining
 * diverse evidence for every visitor-intent category. A video is not reused
 * until a different video is unavailable for that selection round.
 */
export function selectBalancedEvidenceClips(clips: ResearchClip[]) {
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

/**
 * Final public-snapshot review needs exactly the publication bar: two diverse
 * sources per category. Keeping that request to eight clips gives the
 * production verifier room to assess every source without diluting it with a
 * third, weaker candidate from the same category.
 */
export function selectSnapshotEvidenceClips(clips: ResearchClip[]) {
  const intents = ["why_visit", "activity", "food", "practical_tip"] as ResearchIntent[];
  const selected: ResearchClip[] = [];
  const usedVideos = new Set<string>();
  for (const intent of intents) {
    const selectedForIntent: ResearchClip[] = [];
    for (let slot = 0; slot < 2; slot += 1) {
      const candidates = clips.filter((clip) => clip.intent === intent && !selectedForIntent.some((item) => item.id === clip.id));
      const candidate = candidates.find((clip) => !usedVideos.has(clip.video.id))
        || candidates.find((clip) => !selectedForIntent.some((item) => item.video.id === clip.video.id));
      if (!candidate) break;
      selectedForIntent.push(candidate);
      usedVideos.add(candidate.video.id);
    }
    selected.push(...selectedForIntent);
  }
  return selected;
}

export function buildVerifiedResearchResult(result: PlaceResearchResult, verifiedClips: ResearchClip[], rejectedCount: number): PlaceResearchResult {
  const limited = selectBalancedEvidenceClips(verifiedClips);
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
  const requiresSpecificLandmark = placeTokensForResult.some((token) => /\d/.test(token));
  const hasPlaceEvidence = (text: string) => placeTokensForResult.some((token) => includesKeyword(normalizeResearchText(text), token));
  const hasNarrowPlaceFocusedTitle = (title: string) => {
    if (!placeFocusedTitle(result.place, title)) return false;
    // A title that explicitly joins multiple destinations cannot safely supply
    // the location proof for an arbitrary timestamp in the same video.
    return !/[|→]|\b(?:and|vs)\b|&/i.test(title);
  };
  const accepted = result.clips.flatMap((clip) => {
    const analysis = byId.get(clip.id);
    if (!analysis || analysis.mentionOnly || !analysis.placeRelevant || analysis.confidence < 0.76) return [];
    const locationRelationship = analysis.locationRelationship || "queried_place";
    if (locationRelationship === "different_area" || locationRelationship === "unknown") return [];
    const locationEvidenceSource = analysis.locationEvidenceSource || "transcript";
    if (locationEvidenceSource === "video_title" && locationRelationship !== "inside") return [];
    if (analysis.locationEvidence !== undefined) {
      const locationProof = normalizeResearchText(analysis.locationEvidence || "");
      const suppliedLocationText = normalizeResearchText(`${clip.exactQuote} ${clip.contextText}`);
      const titleLocationText = normalizeResearchText(clip.video.title);
      const minimumLocationProofLength = containsCjk(locationProof) ? 3 : 8;
      const titleProofIsAllowed = locationEvidenceSource === "video_title"
        && hasNarrowPlaceFocusedTitle(clip.video.title)
        && titleLocationText.includes(locationProof);
      if (locationProof.length < minimumLocationProofLength || (!suppliedLocationText.includes(locationProof) && !titleProofIsAllowed)) return [];
      if (locationRelationship === "nearby" && (!analysis.poiName || !locationProof.includes(normalizeResearchText(analysis.poiName)))) return [];
    }
    const quoteText = normalizeResearchText(clip.exactQuote);
    const subject = normalizeResearchText(analysis.primarySubject);
    const support = normalizeResearchText(analysis.supportQuote);
    const normalizedTitle = normalizeResearchText(analysis.title);
    const cjkEvidence = containsCjk(`${quoteText} ${subject} ${normalizedTitle}`);
    const titleWordCount = cjkEvidence
      ? [...normalizedTitle].filter((character) => /\S/u.test(character)).length
      : normalizedTitle.split(" ").filter(Boolean).length;
    const subjectTokens = subject.split(" ").filter((token) => token.length > 2);
    const quoteTokens = new Set(quoteText.split(" ").filter(Boolean));
    const titleTokens = new Set(normalizedTitle.split(" ").filter(Boolean));
    const subjectTitleOverlap = cjkEvidence
      ? Number(normalizedTitle.includes(subject))
      : subjectTokens.length ? subjectTokens.filter((token) => titleTokens.has(token)).length / subjectTokens.length : 0;
    const subjectQuoteOverlap = cjkEvidence
      ? Number(quoteText.includes(subject))
      : subjectTokens.length ? subjectTokens.filter((token) => quoteTokens.has(token)).length / subjectTokens.length : 0;
    const locationEvidence = normalizeResearchText(`${clip.contextText} ${clip.locationContext || ""}`);
    if (placeTokensForResult.length && !hasPlaceEvidence(locationEvidence) && !placeFocusedTitle(result.place, clip.video.title)) return [];
    const titleScores = semanticScores(normalizedTitle);
    const quoteAndTitleScores = semanticScores(`${quoteText} ${normalizedTitle}`);
    if (analysis.intent !== "food" && titleScores.food >= 4) return [];
    if (requiresSpecificLandmark && !hasPlaceEvidence(`${analysis.title} ${analysis.primarySubject} ${clip.exactQuote}`)) return [];
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
    const titleTooShort = cjkEvidence ? titleWordCount < 4 : titleWordCount < 3;
    const titleTooLong = cjkEvidence ? titleWordCount > 48 : titleWordCount > 14;
    if ((!normalizedTitle.includes(subject) && subjectTitleOverlap < 0.5) || titleTooShort || titleTooLong) return [];
    if (normalizedTitle === normalizeResearchText(clip.video.title)) return [];
    const highlights = analysis.highlights.filter((term) => normalizeResearchText(analysis.takeaway).includes(normalizeResearchText(term))).slice(0, 3);
    const title = analysis.intent === "practical_tip" && !/^creator tip:/i.test(analysis.title) ? `Creator tip: ${analysis.title}` : analysis.title;
    const takeaway = analysis.intent === "practical_tip" && !/^the creator/i.test(analysis.takeaway)
      ? `The creator observed: ${analysis.takeaway.charAt(0).toLowerCase()}${analysis.takeaway.slice(1)}`
      : analysis.takeaway;
    const englishPresentation = analysis.englishPresentation || undefined;
    const acceptedClip: ResearchClip = {
      ...clip,
      intent: analysis.intent,
      title,
      takeaway,
      highlights,
      englishPresentation,
      locationVerification: {
        poiName: analysis.poiName?.trim() || result.place,
        relationship: locationRelationship,
        evidence: analysis.locationEvidence?.trim() || analysis.supportQuote,
        evidenceSource: locationEvidenceSource,
        status: "pending" as const,
        distanceMeters: 0
      }
    };
    if (!hasRequiredEnglishPresentation(acceptedClip)) return [];
    return [acceptedClip];
  });
  return buildVerifiedResearchResult(result, accepted, result.clips.length - accepted.length);
}
