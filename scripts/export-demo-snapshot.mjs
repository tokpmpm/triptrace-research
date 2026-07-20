import fs from "node:fs/promises";
import path from "node:path";

const sourcePath = process.argv[2];
if (!sourcePath) {
  throw new Error("Usage: node scripts/export-demo-snapshot.mjs /absolute/path/to/result.json");
}

const projectRoot = process.cwd();
const frameDir = path.join(projectRoot, "public", "demo", "taipei-101");
const dataDir = path.join(projectRoot, "data");
const selectedIds = new Set([
  "LdH71ZCeeXc-why_visit-120",
  "gJueucOQT5M-activity-101",
  "fJJjbqRjZtM-food-176",
  "mPs0tvAbWno-practical_tip-485"
]);
const thumbnailFallbackIds = new Set(["fJJjbqRjZtM-food-176"]);

const source = JSON.parse(await fs.readFile(sourcePath, "utf8"));
const selected = source.clips.filter((clip) => selectedIds.has(clip.id));
if (selected.length !== selectedIds.size || new Set(selected.map((clip) => clip.video.id)).size !== 4) {
  throw new Error("The source result does not contain four independently sourced demo clips.");
}

await fs.rm(frameDir, { recursive: true, force: true });
await fs.mkdir(frameDir, { recursive: true });
await fs.mkdir(dataDir, { recursive: true });

const practicalTip = selected.find((clip) => clip.id === "mPs0tvAbWno-practical_tip-485");
practicalTip.title = "Creator tip: Take the red line to Taipei 101 station";

const relationships = {
  "LdH71ZCeeXc-why_visit-120": ["queried_place", "overall Taipei 101 is a remarkable feat of engineering and design"],
  "gJueucOQT5M-activity-101": ["inside", "it's home to lots of trendy shopping malls just inside that complex"],
  "fJJjbqRjZtM-food-176": ["inside", "Taipei 101 also has a massive shopping mall in the basement with many fancy restaurants"],
  "mPs0tvAbWno-practical_tip-485": ["queried_place", "take the red line to station Taipei 101 and then take exit four or five"]
};

for (const clip of selected) {
  const [relationship, evidence] = relationships[clip.id];
  clip.locationVerification = {
    poiName: "Taipei 101",
    relationship,
    evidence,
    status: "same_place",
    distanceMeters: 0
  };
}

for (const clip of selected) {
  if (thumbnailFallbackIds.has(clip.id)) {
    delete clip.frameDataUrl;
    delete clip.frameSeconds;
    continue;
  }
  const match = /^data:image\/jpeg;base64,(.+)$/.exec(clip.frameDataUrl || "");
  if (!match) throw new Error(`Clip ${clip.id} is missing a JPEG storyboard frame.`);
  const filename = `${clip.id}.jpg`;
  await fs.writeFile(path.join(frameDir, filename), Buffer.from(match[1], "base64"));
  clip.frameDataUrl = `/demo/taipei-101/${filename}`;
}

const snapshot = {
  ...source,
  cacheHit: true,
  sourceCount: 4,
  clipCount: selected.length,
  clips: selected,
  suggestedPlan: selected
    .filter((clip) => ["practical_tip", "activity", "food"].includes(clip.intent))
    .map((clip) => clip.title),
  overview: "Legacy Taipei 101 sample evidence kept only for local fixture and regression testing. It is not a current public verified snapshot.",
  warnings: [
    `Legacy demo generated ${source.generatedAt}. It cannot enter the public verified snapshot registry because its sources may be outside the current two-year window.`,
    ...source.warnings.filter((warning) => /opening hours|prices|reservations|closures/i.test(warning))
  ],
  verification: {
    videosFound: source.sourceCount,
    captionedVideos: source.sourceCount,
    candidateClips: source.clipCount,
    evidenceMatches: selected.length,
    verifiedClips: selected.length,
    rejectedEvidenceOrRanking: Math.max(0, source.clipCount - selected.length),
    rejectedLocation: 0
  },
  demoSnapshot: false,
  legacySnapshot: true,
  sourceStatus: "legacy_fixture"
};

await fs.writeFile(path.join(dataDir, "taipei-101-demo.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(`Exported ${selected.length} clips and storyboard frames from ${sourcePath}.`);
