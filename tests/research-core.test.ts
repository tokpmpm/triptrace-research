import { describe, expect, it } from "vitest";
import { applySemanticClipAnalyses, buildExtractiveResearchResult, extractResearchClips, parseResearchJson3, type ResearchVideoTranscript } from "@/lib/research-core";
import { researchPlaceRequestSchema } from "@/lib/schemas";
import type { ResearchClip } from "@/types/research";

const baseVideo = (overrides: Partial<ResearchVideoTranscript> & Pick<ResearchVideoTranscript, "id" | "title" | "channelName" | "searchIntents" | "cues">): ResearchVideoTranscript => ({
  thumbnailUrl: `https://i.ytimg.com/vi/${overrides.id}/hqdefault.jpg`,
  captionTrack: "creator",
  language: "en",
  ...overrides
});

const videos: ResearchVideoTranscript[] = [
  baseVideo({
    id: "why1234567",
    title: "Why Yanaka Ginza is a special historic Tokyo neighborhood",
    channelName: "Tokyo Walks",
    searchIntents: ["why_visit"],
    cues: [{ startSeconds: 42, endSeconds: 51, text: "Yanaka Ginza is a beautiful historic shopping street and one of our favorite old Tokyo neighborhoods worth visiting." }]
  }),
  baseVideo({
    id: "do12345678",
    title: "Things to do around Yanaka Ginza",
    channelName: "Japan Explorer",
    searchIntents: ["activity"],
    cues: [{ startSeconds: 118, endSeconds: 129, text: "Walk through the shopping street, explore the small shops, and visit the nearby temple before continuing through the neighborhood." }]
  }),
  baseVideo({
    id: "food123456",
    title: "Yanaka Ginza street food guide",
    channelName: "Eat Japan",
    searchIntents: ["food"],
    cues: [{ startSeconds: 203, endSeconds: 216, text: "This street food stop is famous for tasty croquettes and snacks, so come hungry and eat them while they are hot." }]
  }),
  baseVideo({
    id: "tips123456",
    title: "Yanaka Ginza station and crowd tips",
    channelName: "Tokyo Transit",
    searchIntents: ["practical_tip"],
    cues: [{ startSeconds: 66, endSeconds: 78, text: "Arrive early in the morning to avoid the weekend crowd, then walk from Nippori Station in about ten minutes." }]
  })
];

describe("new-place transcript research", () => {
  it("parses timed YouTube JSON3 events without inventing timestamps", () => {
    expect(parseResearchJson3({ events: [
      { tStartMs: 12500, dDurationMs: 2500, segs: [{ utf8: "Timed " }, { utf8: "caption" }] },
      { segs: [{ utf8: "untimed noise" }] }
    ] })).toEqual([{ startSeconds: 12.5, endSeconds: 15, text: "Timed caption" }]);
  });

  it("selects distinct timestamped clips from at least three videos", () => {
    const clips = extractResearchClips("Yanaka Ginza", videos);
    const sources = new Set(clips.map((clip) => clip.video.id));
    const intents = new Set(clips.map((clip) => clip.intent));

    expect(sources.size).toBeGreaterThanOrEqual(3);
    expect(intents).toEqual(new Set(["why_visit", "activity", "food", "practical_tip"]));
    expect(clips.every((clip) => clip.startSeconds >= 0 && clip.endSeconds > clip.startSeconds)).toBe(true);
    expect(clips.every((clip) => clip.exactQuote.length > 40)).toBe(true);
    expect(clips.every((clip) => clip.takeaway !== clip.exactQuote)).toBe(true);
    expect(clips.every((clip) => (clip.highlights?.length || 0) > 0)).toBe(true);
    expect(clips.every((clip) => !/evidence from this clip/i.test(clip.title))).toBe(true);
    expect(clips.every((clip) => clip.title.split(": ")[1] && clip.exactQuote.includes(clip.title.split(": ")[1].split(" ").slice(0, 3).join(" ")))).toBe(true);
  });

  it("builds a usable fallback brief when AI synthesis is unavailable", () => {
    const clips = extractResearchClips("Yanaka Ginza", videos);
    const result = buildExtractiveResearchResult("Yanaka Ginza", "Tokyo", clips, "2026-07-15T00:00:00.000Z");

    expect(result.mode).toBe("extractive");
    expect(result.sourceCount).toBeGreaterThanOrEqual(3);
    expect(result.suggestedPlan.length).toBeGreaterThanOrEqual(3);
    expect(result.warnings.at(-1)).toMatch(/hours|prices|reservations/i);
  });

  it("classifies the same excerpt users see and avoids substring false positives", () => {
    const ruleVideo = baseVideo({
      id: "rules123456",
      title: "Yanaka Ginza visitor rules",
      channelName: "Careful Traveler",
      searchIntents: ["food", "practical_tip"],
      cues: [{ startSeconds: 90, endSeconds: 104, text: "Eating while walking is not allowed here, and some shops do not allow photography during the busy weekend." }]
    });
    const falseFoodVideo = baseVideo({
      id: "false123456",
      title: "Yanaka Ginza market seating",
      channelName: "Walking Tokyo",
      searchIntents: ["food"],
      cues: [{ startSeconds: 20, endSeconds: 32, text: "There is a great seat beside the market street where visitors can rest and watch people walk past." }]
    });
    const clips = extractResearchClips("Yanaka Ginza", [ruleVideo, falseFoodVideo]);

    expect(clips.some((clip) => clip.intent === "practical_tip" && clip.video.id === ruleVideo.id)).toBe(true);
    expect(clips.some((clip) => clip.intent === "food" && clip.video.id === ruleVideo.id)).toBe(false);
    expect(clips.some((clip) => clip.intent === "food" && clip.video.id === falseFoodVideo.id)).toBe(false);
  });

  it("does not extract a city-wide keyword hit when the requested place is absent from both the clip and video opening", () => {
    const broadVideo = baseVideo({
      id: "broad123456",
      title: "Taipei museums, stations, food, and day trips",
      channelName: "City Overview",
      searchIntents: ["why_visit", "activity"],
      cues: [
        { startSeconds: 0, endSeconds: 10, text: "This guide starts at Taipei Main Station and travels across the whole city." },
        { startSeconds: 80, endSeconds: 95, text: "The beautiful museum is popular and worth visiting for its history and gardens." },
        { startSeconds: 130, endSeconds: 140, text: "Much later, the route briefly passes Dadaocheng and then moves on." }
      ]
    });

    expect(extractResearchClips("Dadaocheng", [broadVideo])).toEqual([]);
  });

  it("uses the numeric landmark token for Taipei 101 instead of accepting every Taipei clip", () => {
    const cityGuide = baseVideo({
      id: "taipei-city-123",
      title: "Taipei travel guide: museums, markets, and neighborhoods",
      channelName: "Taipei Overview",
      searchIntents: ["why_visit", "activity"],
      cues: [
        { startSeconds: 0, endSeconds: 12, text: "This Taipei guide covers the city's history and architecture from north to south." },
        { startSeconds: 80, endSeconds: 96, text: "The old street is beautiful, historic, and worth visiting for its preserved buildings." }
      ]
    });

    const landmarkGuide = baseVideo({
      id: "taipei-101-123",
      title: "Taipei 101 observatory travel guide",
      channelName: "Taipei Heights",
      searchIntents: ["why_visit"],
      cues: [
        { startSeconds: 0, endSeconds: 12, text: "Today we are visiting Taipei 101, the landmark tower in central Taipei." },
        { startSeconds: 80, endSeconds: 96, text: "The observatory gives a beautiful city view and is worth visiting at sunset." }
      ]
    });

    expect(extractResearchClips("Taipei 101", [cityGuide])).toEqual([]);
    expect(extractResearchClips("Taipei 101", [landmarkGuide]).length).toBeGreaterThan(0);
  });

  it("requires the numeric landmark to reappear in the semantic evidence", () => {
    const clip: ResearchClip = {
      id: "generic-101", intent: "why_visit", title: "Keyword fallback", takeaway: "fallback", startSeconds: 160, endSeconds: 200,
      exactQuote: "Taipei has a rich cultural heritage with historic architecture and museums worth visiting.",
      contextText: "Taipei has a rich cultural heritage with historic architecture and museums worth visiting.",
      locationContext: "Today we are visiting Taipei 101.", captionTrack: "creator", language: "en",
      video: { id: "generic-101-video", title: "Taipei 101 travel guide", channelName: "Fixture channel", thumbnailUrl: "https://i.ytimg.com/vi/fixture/hqdefault.jpg" }
    };
    const result = buildExtractiveResearchResult("Taipei 101", "Taipei", [clip], "2026-07-15T00:00:00.000Z");
    const verified = applySemanticClipAnalyses(result, [{
      clipId: "generic-101",
      intent: "why_visit",
      primarySubject: "Taipei's cultural heritage",
      title: "Explore Taipei's cultural heritage",
      takeaway: "Taipei's cultural heritage includes historic architecture and museums worth visiting.",
      supportQuote: "rich cultural heritage with historic architecture",
      highlights: ["cultural heritage"],
      mentionOnly: false,
      placeRelevant: true,
      confidence: 0.95
    }]);

    expect(verified.clips).toEqual([]);
  });

  it("accepts a structured support quote truncated with an ellipsis at a word boundary", () => {
    const clip: ResearchClip = {
      id: "ellipsis-101", intent: "why_visit", title: "Keyword fallback", takeaway: "fallback", startSeconds: 120, endSeconds: 160,
      exactQuote: "Overall Taipei 101 is a remarkable feat of engineering and design with many fascinating features that are worth exploring.",
      contextText: "Overall Taipei 101 is a remarkable feat of engineering and design with many fascinating features that are worth exploring.",
      locationContext: "Today we are visiting Taipei 101.", captionTrack: "creator", language: "en",
      video: { id: "ellipsis-101-video", title: "Taipei 101 engineering guide", channelName: "Fixture channel", thumbnailUrl: "https://i.ytimg.com/vi/fixture/hqdefault.jpg" }
    };
    const result = buildExtractiveResearchResult("Taipei 101", "Taipei", [clip], "2026-07-15T00:00:00.000Z");
    const verified = applySemanticClipAnalyses(result, [{
      clipId: "ellipsis-101",
      intent: "why_visit",
      primarySubject: "Taipei 101 is a remarkable feat of engineering",
      title: "Why Taipei 101 is a remarkable feat of engineering",
      takeaway: "Taipei 101 combines innovative engineering and design with details worth exploring.",
      supportQuote: "Overall Taipei 101 is a remarkable feat of engineering and design with many fascinating features that are w...",
      highlights: ["engineering", "design"],
      mentionOnly: false,
      placeRelevant: true,
      confidence: 0.95
    }]);

    expect(verified.clips.map((item) => item.id)).toEqual(["ellipsis-101"]);
  });

  it("keeps three independently sourced candidates per category so semantic rejection has backups", () => {
    const foodVideos = ["one", "two", "three"].map((suffix, index) => baseVideo({
      id: `food-${suffix}-123`,
      title: `Dadaocheng food walk ${suffix}`,
      channelName: `Food channel ${suffix}`,
      searchIntents: ["food"],
      cues: [{
        startSeconds: 60 + index * 30,
        endSeconds: 75 + index * 30,
        text: `Dadaocheng has a delicious local ${["pork sausage", "noodle dish", "rice snack"][index]} that this street food vendor serves hot.`
      }]
    }));

    const foodClips = extractResearchClips("Dadaocheng", foodVideos).filter((clip) => clip.intent === "food");
    expect(foodClips).toHaveLength(3);
    expect(new Set(foodClips.map((clip) => clip.video.id)).size).toBe(3);
  });

  it("keeps actionable queue advice even when the same quote contains stronger food terms", () => {
    const queueVideo = baseVideo({
      id: "queue-food-123",
      title: "Dadaocheng food and queue guide",
      channelName: "Local Queue Guide",
      searchIntents: ["food", "practical_tip"],
      cues: [{
        startSeconds: 160,
        endSeconds: 177,
        text: "This famous pork bun has a very long queue, but we only waited about five minutes before getting one." 
      }]
    });

    const clips = extractResearchClips("Dadaocheng", [queueVideo]);
    expect(clips.some((clip) => clip.intent === "practical_tip" && clip.video.id === queueVideo.id)).toBe(true);
  });
});

describe("new-place request validation", () => {
  it("accepts place names but rejects URLs and shell-like search expressions", () => {
    expect(researchPlaceRequestSchema.parse({ place: "Tsukiji Outer Market", city: "Tokyo" }).place).toBe("Tsukiji Outer Market");
    expect(() => researchPlaceRequestSchema.parse({ place: "https://example.com", city: "Tokyo" })).toThrow();
    expect(() => researchPlaceRequestSchema.parse({ place: "Tokyo; rm -rf", city: "Tokyo" })).toThrow();
  });
});

describe("semantic title verification", () => {
  const makeClip = (id: string, intent: ResearchClip["intent"], videoTitle: string, exactQuote: string): ResearchClip => ({
    id, intent, title: "Keyword fallback", takeaway: exactQuote, startSeconds: 160, endSeconds: 200,
    exactQuote, contextText: exactQuote, locationContext: "This morning we came to Dadaocheng.", captionTrack: "creator", language: "en",
    video: { id: `${id}-video`, title: videoTitle, channelName: "Fixture channel", thumbnailUrl: "https://i.ytimg.com/vi/fixture/hqdefault.jpg" }
  });

  it("uses the main dish instead of an incidental seafood keyword and names the real queue tip", () => {
    const clips = [
      makeClip("noodles", "food", "Breakfast buffet and Danzai noodles in Taiwan", "These Danzai noodles used dry shrimp as the base, just a little seafood to flavor the whole bowl of noodles."),
      makeClip("queue", "practical_tip", "Dihua Street walking tour", "Be here before 11 in the morning. At 11:45 there is a very long sashimi queue, so be sure to come early."),
      makeClip("irrelevant", "activity", "General Taipei guide", "The National Palace Museum has history and art inside and is a beautiful building.")
    ];
    const result = buildExtractiveResearchResult("Dadaocheng", "Taipei", clips, "2026-07-15T00:00:00.000Z");
    const verified = applySemanticClipAnalyses(result, [
      { clipId: "noodles", intent: "food", primarySubject: "Danzai noodles", title: "Danzai noodles with dried-shrimp broth", takeaway: "Danzai noodles use a small amount of dried shrimp to flavor the broth.", supportQuote: "dry shrimp as the base", highlights: ["Danzai noodles"], mentionOnly: false, placeRelevant: true, confidence: 0.94 },
      { clipId: "queue", intent: "practical_tip", primarySubject: "sashimi queue", title: "Arrive before 11 to avoid the sashimi queue", takeaway: "Come before 11 because the sashimi queue is already long by 11:45.", supportQuote: "there is a very long sashimi queue", highlights: ["before 11", "sashimi queue"], mentionOnly: false, placeRelevant: true, confidence: 0.96 },
      { clipId: "irrelevant", intent: "activity", primarySubject: "National Palace Museum", title: "Visit the National Palace Museum", takeaway: "The museum contains history and art in a beautiful building.", supportQuote: "National Palace Museum has history and art", highlights: ["National Palace Museum"], mentionOnly: false, placeRelevant: false, confidence: 0.91 }
    ]);

    expect(verified.clips.map((clip) => clip.title)).toEqual([
      "Danzai noodles with dried-shrimp broth",
      "Creator tip: Arrive before 11 to avoid the sashimi queue"
    ]);
    expect(verified.clips.some((clip) => /seafood mentioned|approach the area/i.test(clip.title))).toBe(false);
    expect(verified.warnings[0]).toMatch(/omitted/i);
  });

  it("rejects a model answer that copies a broad video title instead of naming transcript evidence", () => {
    const clip = makeClip(
      "broad",
      "why_visit",
      "Taipei Travel Guide: Museums, Stations, Markets, and Day Trips",
      "Taipei main station connects travelers with buses and trains across the city."
    );
    delete clip.locationContext;
    const result = buildExtractiveResearchResult("Dadaocheng", "Taipei", [clip], "2026-07-15T00:00:00.000Z");
    const verified = applySemanticClipAnalyses(result, [{
      clipId: "broad",
      intent: "why_visit",
      primarySubject: "Taipei Travel Guide: Museums, Stations, Markets, and Day Trips",
      title: "Taipei Travel Guide: Museums, Stations, Markets, and Day Trips",
      takeaway: "This broad guide covers transport across Taipei rather than evidence about Dadaocheng.",
      supportQuote: "Taipei main station connects travelers",
      highlights: [],
      mentionOnly: false,
      placeRelevant: true,
      confidence: 0.99
    }]);

    expect(verified.clips).toEqual([]);
  });

  it("rejects a different neighborhood and a food description mislabeled as practical advice", () => {
    const ningxia = makeClip(
      "ningxia",
      "food",
      "Taipei travel vlog Taiwanese street food at Ningxia Night Market evening walk and Dadaocheng Taiwan itinerary",
      "The Jasmine guava is really good and you can taste the tea after mixing in the ice."
    );
    delete ningxia.locationContext;
    const pepperRice = makeClip(
      "pepper-rice",
      "practical_tip",
      "Dadaocheng food tour",
      "This is very peppery rice with a rich flavor and a soft egg mixed through it."
    );
    const result = buildExtractiveResearchResult("Dadaocheng", "Taipei", [ningxia, pepperRice], "2026-07-15T00:00:00.000Z");
    const verified = applySemanticClipAnalyses(result, [
      { clipId: "ningxia", intent: "food", primarySubject: "Jasmine guava", title: "Try the Jasmine guava at Ningxia Night Market", takeaway: "The tea-infused guava is served over ice at Ningxia Night Market.", supportQuote: "Jasmine guava is really good", highlights: ["Jasmine guava"], mentionOnly: false, placeRelevant: true, confidence: 0.95 },
      { clipId: "pepper-rice", intent: "practical_tip", primarySubject: "peppery rice", title: "Enjoy the peppery rice", takeaway: "The rice has a peppery flavor and is served with a soft egg.", supportQuote: "very peppery rice", highlights: ["peppery rice"], mentionOnly: false, placeRelevant: true, confidence: 0.95 }
    ]);

    expect(verified.clips).toEqual([]);
  });

  it("does not mistake a matchmaking red line for queue advice", () => {
    const clip = makeClip(
      "red-line",
      "practical_tip",
      "Exploring Dadaocheng temples",
      "The matchmaking god has a red line and worshippers use incense while praying at this Taoist temple."
    );
    const result = buildExtractiveResearchResult("Dadaocheng", "Taipei", [clip], "2026-07-15T00:00:00.000Z");
    const verified = applySemanticClipAnalyses(result, [{
      clipId: "red-line",
      intent: "practical_tip",
      primarySubject: "red line",
      title: "Learn about the red line",
      takeaway: "The red line represents matchmaking during prayers at this Taoist temple.",
      supportQuote: "matchmaking god has a red line",
      highlights: ["red line"],
      mentionOnly: false,
      placeRelevant: true,
      confidence: 0.95
    }]);

    expect(verified.clips).toEqual([]);
  });

  it("accepts a concise routing subject when its exact support quote and key place words are present", () => {
    const clip = makeClip(
      "routing",
      "practical_tip",
      "Dadaocheng Taipei walking guide",
      "Take Exit 1A and walk along Taipei Bridge to Yinzan Night Market and the nearby historical area."
    );
    const result = buildExtractiveResearchResult("Dadaocheng", "Taipei", [clip], "2026-07-15T00:00:00.000Z");
    const verified = applySemanticClipAnalyses(result, [{
      clipId: "routing",
      intent: "practical_tip",
      primarySubject: "how to reach Yinzan Night Market",
      title: "How to reach Yinzan Night Market",
      takeaway: "Take MRT Exit 1A, then walk along Taipei Bridge to reach the market and nearby historical area.",
      supportQuote: "Take Exit 1A and walk along Taipei Bridge to Yinzan Night Market",
      highlights: ["Exit 1A", "Yinzan Night Market"],
      mentionOnly: false,
      placeRelevant: true,
      confidence: 0.95
    }]);

    expect(verified.clips.map((item) => item.id)).toEqual(["routing"]);
  });

  it("rejects a title-supported clip when the key takeaway is about a different subject", () => {
    const clip = makeClip(
      "misaligned-takeaway",
      "why_visit",
      "Dadaocheng historic street guide",
      "Dadaocheng is a beautiful historic street with preserved shop houses and a calm atmosphere."
    );
    const result = buildExtractiveResearchResult("Dadaocheng", "Taipei", [clip], "2026-07-15T00:00:00.000Z");
    const verified = applySemanticClipAnalyses(result, [{
      clipId: "misaligned-takeaway",
      intent: "why_visit",
      primarySubject: "beautiful historic street",
      title: "Why the beautiful historic street is worth visiting",
      takeaway: "The unrelated tower offers a convenient observation deck with a wide city view.",
      supportQuote: "beautiful historic street with preserved shop houses",
      highlights: ["historic street"],
      mentionOnly: false,
      placeRelevant: true,
      confidence: 0.95
    }]);

    expect(verified.clips).toEqual([]);
  });
});
