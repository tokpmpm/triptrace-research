import { describe, expect, it, vi } from "vitest";
import type { PlaceResearchResult } from "@/types/research";

const partialResult: PlaceResearchResult = {
  place: "Taipei 101",
  city: "Taipei",
  overview: "One verified result is ready while research continues.",
  generatedAt: "2026-07-17T00:00:00.000Z",
  cacheHit: false,
  sourceCount: 1,
  clipCount: 1,
  clips: [{
    id: "partial-101",
    intent: "why_visit",
    title: "Taipei 101 engineering",
    takeaway: "Taipei 101 has engineering details supported by this creator's exact transcript.",
    startSeconds: 10,
    endSeconds: 20,
    exactQuote: "Taipei 101 has engineering details that make the building worth visiting.",
    contextText: "This segment is about Taipei 101.",
    captionTrack: "creator",
    language: "en",
    video: { id: "partial101x", title: "Taipei 101 guide", channelName: "Test channel", thumbnailUrl: "https://example.com/thumb.jpg" },
    locationVerification: { poiName: "Taipei 101", relationship: "queried_place", evidence: "This segment is about Taipei 101.", status: "same_place", distanceMeters: 0 }
  }],
  suggestedPlan: [],
  warnings: [],
  mode: "ai"
};

vi.mock("@/lib/research-server", () => ({
  researchPlace: vi.fn(async ({ onPartialResult }: { onPartialResult?: (result: PlaceResearchResult) => void }) => {
    onPartialResult?.(partialResult);
    throw new Error("No practical-tip source passed verification.");
  })
}));

describe("research stream partial results", () => {
  it("keeps verified clips when later category research fails", async () => {
    const { POST } = await import("@/app/api/research-place/route");
    const response = await POST(new Request("http://localhost/api/research-place", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ place: "Taipei 101", city: "Taipei" })
    }));
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(events.map((event) => event.type)).toEqual(["partial_result", "result"]);
    expect(events.at(-1).result.clips).toHaveLength(1);
    expect(events.at(-1).result.warnings[0]).toMatch(/ended early/i);
  });
});
