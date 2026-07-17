import { describe, expect, it } from "vitest";
import { distanceMeters, maximumDistanceMeters } from "@/lib/geospatial";

describe("geospatial verification", () => {
  it("calculates a stable short distance between nearby Taipei landmarks", () => {
    const distance = distanceMeters(
      { latitude: 25.033968, longitude: 121.564468 },
      { latitude: 25.032963, longitude: 121.565427 }
    );

    expect(distance).toBeGreaterThan(100);
    expect(distance).toBeLessThan(200);
  });

  it("uses a strict radius for numbered landmarks and a wider neighborhood radius", () => {
    expect(maximumDistanceMeters("Taipei 101")).toBe(800);
    expect(maximumDistanceMeters("Shilin Night Market")).toBe(1_500);
    expect(maximumDistanceMeters("Longshan Temple")).toBe(1_000);
  });
});
