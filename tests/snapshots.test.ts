import { describe, expect, it } from "vitest";
import { createVerifiedSnapshotRegistry, getVerifiedSnapshot, validateVerifiedSnapshot } from "@/lib/snapshots";
import { isValidRuntimeCache, resolveCacheFirstResult } from "@/lib/research-server";
import type { PlaceResearchResult, ResearchIntent, VerifiedSnapshot } from "@/types/research";

const intents: ResearchIntent[] = ["why_visit", "activity", "food", "practical_tip"];
const videoIds = ["snap0000001", "snap0000002", "snap0000003", "snap0000004", "snap0000005", "snap0000006", "snap0000007", "snap0000008"];

function validSnapshot(): VerifiedSnapshot {
  const clips = intents.flatMap((intent, intentIndex) => [0, 1].map((sourceOffset) => {
    const index = intentIndex * 2 + sourceOffset;
    const startSeconds = 40 + index * 30;
    const id = videoIds[index];
    return {
      id: `${id}-${intent}-${startSeconds}`,
      intent,
      title: `Taipei 101 ${intent.replace("_", " ")} detail ${sourceOffset + 1}`,
      takeaway: `A creator describes a specific ${intent.replace("_", " ")} detail at Taipei 101 with a timestamped source.`,
      exactQuote: `At Taipei 101, this creator gives a specific ${intent.replace("_", " ")} observation that is useful for a visit.`,
      contextText: `This section remains focused on Taipei 101 and the visitor experience there.`,
      startSeconds,
      endSeconds: startSeconds + 22,
      captionTrack: "creator" as const,
      language: "en",
      video: {
        id,
        title: `Taipei 101 verified source ${index + 1}`,
        channelName: `Creator ${index + 1}`,
        thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        publishedAt: "2025-07-18"
      },
      youtubeTimestampSource: `https://www.youtube.com/watch?v=${id}&t=${startSeconds}s`,
      locationVerification: {
        poiName: "Taipei 101",
        relationship: "queried_place" as const,
        evidence: "Taipei 101",
        status: "same_place" as const,
        distanceMeters: 0
      }
    };
  }));
  return {
    snapshotVersion: 1,
    snapshotStatus: "verified",
    place: "Taipei 101",
    city: "Taipei",
    overview: "Eight independently verified source cards are available for Taipei 101.",
    generatedAt: "2026-07-18T09:00:00.000Z",
    sourceCutoffDate: "2024-07-18",
    reviewAfter: "2026-07-25",
    demoSnapshot: true,
    sourceStatus: "verified_snapshot",
    cacheHit: true,
    sourceCount: 8,
    clipCount: 8,
    clips,
    suggestedPlan: clips.slice(1).map((clip) => clip.title),
    warnings: [],
    mode: "ai",
    aiModel: "gpt-5.6-luna",
    verification: {
      videosFound: 8,
      captionedVideos: 8,
      candidateClips: 8,
      evidenceMatches: 8,
      verifiedClips: 8,
      rejectedEvidenceOrRanking: 0,
      rejectedLocation: 0
    }
  };
}

function asCachedResult(snapshot: VerifiedSnapshot): PlaceResearchResult {
  return { ...snapshot, sourceStatus: "runtime_cache", cacheHit: false };
}

describe("verified snapshots", () => {
  it("enforces the rolling two-year cutoff for every source", () => {
    const snapshot = validSnapshot();
    expect(validateVerifiedSnapshot(snapshot)).toEqual({ valid: true, issues: [] });
    snapshot.clips[0].video.publishedAt = "2024-07-17";
    expect(validateVerifiedSnapshot(snapshot).issues.join(" ")).toMatch(/two-year source window/i);
  });

  it("requires two different video sources for every category", () => {
    const snapshot = validSnapshot();
    const duplicatedVideoId = snapshot.clips[0].video.id;
    snapshot.clips[1] = {
      ...snapshot.clips[1],
      id: `${duplicatedVideoId}-why_visit-${snapshot.clips[1].startSeconds}`,
      video: { ...snapshot.clips[1].video, id: duplicatedVideoId },
      youtubeTimestampSource: `https://www.youtube.com/watch?v=${duplicatedVideoId}&t=${snapshot.clips[1].startSeconds}s`
    };
    snapshot.sourceCount = 7;
    const issues = validateVerifiedSnapshot(snapshot).issues.join(" ");
    expect(issues).toMatch(/2 different video sources for why_visit/i);
  });

  it("requires all eight cards implied by the two-source-per-category policy", () => {
    const snapshot = validSnapshot();
    snapshot.clips.pop();
    snapshot.clipCount = 7;
    snapshot.sourceCount = 7;
    snapshot.verification = { ...snapshot.verification, videosFound: 7, captionedVideos: 7, candidateClips: 7, evidenceMatches: 7, verifiedClips: 7 };
    expect(validateVerifiedSnapshot(snapshot).issues.join(" ")).toMatch(/at least 8 evidence cards/i);
  });

  it("keeps title, quote, timestamp, and YouTube video identity aligned", () => {
    const snapshot = validSnapshot();
    expect(validateVerifiedSnapshot(snapshot).valid).toBe(true);
    snapshot.clips[1].youtubeTimestampSource = "https://www.youtube.com/watch?v=snap0000001&t=0s";
    snapshot.clips[2].title = "Unrelated mountain hiking advice";
    snapshot.clips[3].id = "not-the-video-id";
    const issues = validateVerifiedSnapshot(snapshot).issues.join(" ");
    expect(issues).toMatch(/matching YouTube timestamp source/i);
    expect(issues).toMatch(/title does not align/i);
    expect(issues).toMatch(/does not map its card ID/i);
  });

  it("accepts a CJK title and takeaway only when they retain a verbatim source phrase", () => {
    const snapshot = validSnapshot();
    snapshot.clips[0] = {
      ...snapshot.clips[0],
      title: "台北101觀景台",
      takeaway: "台北101觀景台可欣賞城市夜景與山景，傍晚參觀能看到城市燈光。",
      exactQuote: "台北101觀景台可欣賞城市夜景與山景，傍晚參觀能看到城市燈光，也能感受高樓視野。",
      contextText: "影片此段持續介紹台北101觀景台與城市視野。",
      locationVerification: {
        poiName: "Taipei 101",
        relationship: "queried_place",
        evidence: "台北101觀景台",
        status: "same_place",
        distanceMeters: 0
      }
    };

    expect(validateVerifiedSnapshot(snapshot)).toEqual({ valid: true, issues: [] });
  });

  it("requires English display copy when a public source is not in English", () => {
    const snapshot = validSnapshot();
    snapshot.clips[0] = {
      ...snapshot.clips[0],
      title: "台北101觀景台",
      takeaway: "台北101觀景台可欣賞城市夜景與山景，傍晚參觀能看到城市燈光。",
      exactQuote: "台北101觀景台可欣賞城市夜景與山景，傍晚參觀能看到城市燈光，也能感受高樓視野。",
      contextText: "影片此段持續介紹台北101觀景台與城市視野。",
      language: "zh-TW",
      video: { ...snapshot.clips[0].video, channelName: "旅遊頻道" },
      englishPresentation: {
        title: "See the Taipei 101 observatory",
        takeaway: "The Taipei 101 observatory offers city and mountain views, especially in the evening.",
        exactQuote: "The Taipei 101 observatory offers city and mountain views. Visit in the evening to see the city lights and the skyscraper view.",
        highlights: ["city and mountain views", "visit in the evening", "city lights"],
        channelName: "Travel Channel"
      },
      locationVerification: {
        poiName: "Taipei 101",
        relationship: "queried_place",
        evidence: "台北101觀景台",
        status: "same_place",
        distanceMeters: 0
      }
    };

    expect(validateVerifiedSnapshot(snapshot)).toEqual({ valid: true, issues: [] });
    delete snapshot.clips[0].englishPresentation;
    expect(validateVerifiedSnapshot(snapshot).issues.join(" ")).toMatch(/English display/i);
  });

  it("keeps English display copy on every saved non-English public card", () => {
    const snapshot = getVerifiedSnapshot("Dadaocheng", "Taipei");
    const nonEnglishCards = snapshot?.clips.filter((clip) => !/^en(?:[-_]|$)/i.test(clip.language)) || [];

    expect(nonEnglishCards).toHaveLength(2);
    expect(nonEnglishCards.every((clip) => clip.englishPresentation?.title && clip.englishPresentation.takeaway && clip.englishPresentation.exactQuote && clip.englishPresentation.highlights?.length && clip.englishPresentation.channelName)).toBe(true);
  });

  it("keeps English display channel names when saved creator metadata uses Han characters", () => {
    const snapshots = ["Taipei 101", "Ximending", "Dadaocheng", "Shilin Night Market"]
      .map((place) => getVerifiedSnapshot(place, "Taipei"))
      .filter((snapshot): snapshot is VerifiedSnapshot => Boolean(snapshot));
    const cardsWithHanChannelNames = snapshots.flatMap((snapshot) => snapshot.clips.filter((clip) => /[\u3400-\u9fff]/u.test(clip.video.channelName)));

    expect(cardsWithHanChannelNames.length).toBeGreaterThan(0);
    expect(cardsWithHanChannelNames.every((clip) => /^[A-Za-z]/.test(clip.englishPresentation?.channelName || ""))).toBe(true);
  });

  it("records when completed location verification is supported by narrow video-title metadata", () => {
    const snapshot = validSnapshot();
    const clip = snapshot.clips[0];
    clip.locationVerification = {
      poiName: "Taipei 101",
      relationship: "queried_place",
      evidence: clip.video.title,
      evidenceSource: "video_title",
      status: "same_place",
      distanceMeters: 0
    };

    expect(validateVerifiedSnapshot(snapshot)).toEqual({ valid: true, issues: [] });
    clip.locationVerification!.evidence = "A different title";
    expect(validateVerifiedSnapshot(snapshot).issues.join(" ")).toMatch(/video title/i);
  });

  it("refuses invalid data in the typed public registry", () => {
    const invalid = { ...validSnapshot(), demoSnapshot: false };
    const registry = createVerifiedSnapshotRegistry([validSnapshot(), invalid]);
    expect(registry.snapshots.size).toBe(1);
    expect(registry.rejected).toHaveLength(1);
    expect([...registry.snapshots.values()][0]?.demoSnapshot).toBe(true);
  });

  it("rejects a duplicate place and city instead of silently replacing a snapshot", () => {
    const registry = createVerifiedSnapshotRegistry([validSnapshot(), validSnapshot()]);
    expect(registry.snapshots.size).toBe(1);
    expect(registry.rejected[0]?.issues).toContain("Duplicate public snapshot place and city.");
  });
});

describe("cache-first resolver", () => {
  it("accepts only a well-formed result inside the seven-day cache TTL", () => {
    const cached = asCachedResult(validSnapshot());
    const now = Date.parse("2026-07-18T10:00:00.000Z");
    expect(isValidRuntimeCache(cached, now)).toBe(true);
    expect(isValidRuntimeCache({ ...cached, generatedAt: "2026-07-10T09:00:00.000Z" }, now)).toBe(false);
    expect(isValidRuntimeCache({ ...cached, clips: [{ ...cached.clips[0], video: { ...cached.clips[0].video, id: "not-a-youtube-id" } }], clipCount: 1 }, now)).toBe(false);
    expect(isValidRuntimeCache({ ...cached, mode: "fixture" as const }, now)).toBe(false);
    expect(isValidRuntimeCache({
      ...cached,
      clips: cached.clips.map((clip, index) => index === 0 ? { ...clip, video: { ...clip.video, publishedAt: "2020-01-01" } } : clip)
    }, now)).toBe(false);
    const untranslated = {
      ...cached,
      clips: cached.clips.map((clip, index) => index === 0 ? {
        ...clip,
        language: "zh-TW",
        video: { ...clip.video, channelName: "台北散步頻道" }
      } : clip)
    };
    expect(isValidRuntimeCache(untranslated, now)).toBe(false);
    untranslated.clips[0] = {
      ...untranslated.clips[0],
      englishPresentation: {
        title: "Taipei 101 source detail",
        takeaway: "A creator shares a specific Taipei 101 detail with a timestamped source.",
        exactQuote: "At Taipei 101, this creator gives a specific observation that is useful for a visit.",
        highlights: ["Taipei 101 detail"],
        channelName: "Taipei Walking Channel"
      }
    };
    expect(isValidRuntimeCache(untranslated, now)).toBe(true);
  });

  it("always returns a verified snapshot before a runtime cache", async () => {
    const snapshot = validSnapshot();
    const replayed: string[] = [];
    const result = await resolveCacheFirstResult({
      place: "Taipei 101",
      city: "Taipei",
      runtime: "production",
      snapshot,
      cachedResult: asCachedResult(snapshot),
      replaySaved: async (kind) => { replayed.push(kind); }
    });
    expect(result?.sourceStatus).toBe("verified_snapshot");
    expect(replayed).toEqual(["snapshot"]);
  });

  it("returns a valid cache before source-unavailable, even when force is requested in production", async () => {
    const cached = asCachedResult(validSnapshot());
    const result = await resolveCacheFirstResult({
      place: "Taipei 101",
      city: "Taipei",
      runtime: "production",
      cachedResult: cached,
      force: true,
      replaySaved: async () => undefined
    });
    expect(result?.sourceStatus).toBe("runtime_cache");
  });

  it("does not run yt-dlp or any live fetch when a Cloud Run cache miss occurs", async () => {
    let liveCalls = 0;
    const result = await resolveCacheFirstResult({
      place: "Dadaocheng",
      city: "Taipei",
      runtime: "production",
      liveResearch: async () => {
        liveCalls += 1;
        return asCachedResult(validSnapshot());
      }
    });
    expect(liveCalls).toBe(0);
    expect(result?.mode).toBe("source_unavailable");
    expect(result?.sourceUnavailable?.code).toBe("no_snapshot_or_cache");
  });
});
