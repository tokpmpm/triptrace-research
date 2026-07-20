import { describe, expect, it } from "vitest";
import taipei101Legacy from "@/data/taipei-101-demo.json";
import { getVerifiedSnapshot, validateVerifiedSnapshot } from "@/lib/snapshots";

describe("Taipei 101 legacy demo", () => {
  it("is retained only as a local fixture and cannot be mistaken for a current public snapshot", () => {
    expect(taipei101Legacy.legacySnapshot).toBe(true);
    expect(taipei101Legacy.demoSnapshot).toBe(false);
    expect(taipei101Legacy.clips.some((clip) => clip.video.publishedAt === "2018-05-29")).toBe(true);
    expect(validateVerifiedSnapshot(taipei101Legacy).valid).toBe(false);
    const publicSnapshot = getVerifiedSnapshot("Taipei 101", "Taipei");
    expect(publicSnapshot).not.toBe(taipei101Legacy);
    expect(publicSnapshot?.clips.some((clip) => clip.video.publishedAt === "2018-05-29")).not.toBe(true);
  });
});
