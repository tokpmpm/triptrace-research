import fs from "node:fs/promises";
import path from "node:path";
import type { PlaceResearchResult, ResearchClip } from "@/types/research";

type Coordinates = { latitude: number; longitude: number; displayName: string };
type GeocodeCache = Record<string, Coordinates | null>;

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "TripTraceResearch/0.1 (https://github.com/tokpmpm/triptrace-research)";
let nextRequestAt = 0;
let rateLimitQueue: Promise<void> = Promise.resolve();

export function distanceMeters(a: Pick<Coordinates, "latitude" | "longitude">, b: Pick<Coordinates, "latitude" | "longitude">) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const earthRadius = 6_371_000;
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const latitudeA = radians(a.latitude);
  const latitudeB = radians(b.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
  return Math.round(2 * earthRadius * Math.asin(Math.sqrt(haversine)));
}

export function maximumDistanceMeters(place: string) {
  if (/\d/.test(place)) return 800;
  if (/market|street|district|neighbou?rhood|old town/i.test(place)) return 1_500;
  return 1_000;
}

async function waitForRateLimit() {
  const scheduled = rateLimitQueue.then(async () => {
    const waitMs = Math.max(0, nextRequestAt - Date.now());
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    nextRequestAt = Date.now() + 1_050;
  });
  rateLimitQueue = scheduled.catch(() => undefined);
  await scheduled;
}

async function readCache(cachePath: string): Promise<GeocodeCache> {
  try {
    return JSON.parse(await fs.readFile(cachePath, "utf8")) as GeocodeCache;
  } catch {
    return {};
  }
}

async function geocode(query: string, city: string, cache: GeocodeCache, cachePath: string, signal: AbortSignal) {
  const key = `${query.trim().toLowerCase()}|${city.trim().toLowerCase()}`;
  if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];

  await waitForRateLimit();
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", `${query}, ${city}`);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "3");
  url.searchParams.set("addressdetails", "1");
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" }
    });
    if (!response.ok) throw new Error(`Nominatim returned ${response.status}`);
    const candidates = await response.json() as Array<{ lat?: string; lon?: string; display_name?: string }>;
    const normalizedCity = city.toLowerCase();
    const match = candidates.find((candidate) => candidate.display_name?.toLowerCase().includes(normalizedCity));
    const latitude = Number(match?.lat);
    const longitude = Number(match?.lon);
    cache[key] = Number.isFinite(latitude) && Number.isFinite(longitude)
      ? { latitude, longitude, displayName: match?.display_name || query }
      : null;
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
  await fs.writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  return cache[key];
}

function samePlaceVerification(clip: ResearchClip) {
  const candidate = clip.locationVerification;
  if (!candidate || !["queried_place", "inside"].includes(candidate.relationship)) return null;
  return { ...clip, locationVerification: { ...candidate, status: "same_place" as const, distanceMeters: 0 } };
}

export async function verifyResearchLocations(result: PlaceResearchResult, cacheDir: string, signal: AbortSignal) {
  const cachePath = path.join(cacheDir, "geocoding.json");
  const cache = await readCache(cachePath);
  const origin = await geocode(result.place, result.city, cache, cachePath, signal);
  const rejected: string[] = [];
  const verified: ResearchClip[] = [];

  for (const clip of result.clips) {
    const samePlace = samePlaceVerification(clip);
    if (samePlace) {
      verified.push(samePlace);
      continue;
    }
    const candidate = clip.locationVerification;
    if (!candidate || candidate.relationship !== "nearby" || !candidate.poiName || !origin) {
      rejected.push(clip.id);
      continue;
    }
    const destination = await geocode(candidate.poiName, result.city, cache, cachePath, signal);
    if (!destination) {
      rejected.push(clip.id);
      continue;
    }
    const distance = distanceMeters(origin, destination);
    if (distance > maximumDistanceMeters(result.place)) {
      rejected.push(clip.id);
      continue;
    }
    verified.push({
      ...clip,
      locationVerification: { ...candidate, status: "verified_nearby", distanceMeters: distance }
    });
  }

  return { verified, rejectedCount: rejected.length };
}
