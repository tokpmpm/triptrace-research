import { describe, expect, it } from "vitest";
import taipei101Demo from "@/data/taipei-101-demo.json";

describe("Taipei 101 verified demo snapshot", () => {
  it("keeps four evidence categories tied to four different YouTube videos", () => {
    const clips = taipei101Demo.clips;

    expect(taipei101Demo.demoSnapshot).toBe(true);
    expect(taipei101Demo.place).toBe("Taipei 101");
    expect(taipei101Demo.city).toBe("Taipei");
    expect(clips).toHaveLength(4);
    expect(new Set(clips.map((clip) => clip.video.id)).size).toBe(4);
    expect(new Set(clips.map((clip) => clip.intent))).toEqual(
      new Set(["why_visit", "activity", "food", "practical_tip"])
    );
  });

  it("keeps every claim traceable to a timed transcript and YouTube source", () => {
    for (const clip of taipei101Demo.clips) {
      expect(clip.title).not.toMatch(/evidence from this clip/i);
      expect(clip.takeaway.length).toBeGreaterThan(20);
      expect(clip.exactQuote.length).toBeGreaterThan(40);
      expect(clip.endSeconds).toBeGreaterThan(clip.startSeconds);
      expect(clip.video.id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(clip.video.thumbnailUrl).toContain(clip.video.id);
      expect(clip.locationVerification.status).toBe("same_place");
      expect(clip.locationVerification.poiName).toBe("Taipei 101");
    }
  });

  it("ships truthful verification-funnel totals with the demo", () => {
    const verification = taipei101Demo.verification;

    expect(verification.verifiedClips).toBe(taipei101Demo.clips.length);
    expect(verification.evidenceMatches - verification.verifiedClips).toBe(verification.rejectedLocation);
    expect(verification.candidateClips - verification.evidenceMatches).toBe(verification.rejectedEvidenceOrRanking);
    expect(verification.captionedVideos).toBeGreaterThanOrEqual(new Set(taipei101Demo.clips.map((clip) => clip.video.id)).size);
  });
});
