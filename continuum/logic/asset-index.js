// logic/asset-index.js
// Image asset lookup only.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const INDEX_PATH = path.join(ROOT, "data", "asset_index.json");

const IMAGE_FALLBACKS = Object.freeze({
  triangle: "assets/poses/triangle.png",
});

let _cache = null;

export function loadAssetIndex() {
  if (_cache) return _cache;

  if (!fs.existsSync(INDEX_PATH)) {
    throw new Error("asset_index.json not found. Run the asset index build script or add data/asset_index.json.");
  }

  const parsed = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));

  _cache = {
    ...parsed,
    imagesById: {
      ...(parsed.imagesById || {}),
      ...IMAGE_FALLBACKS,
    },
  };

  return _cache;
}

export function getImagePath(poseId) {
  const id = String(poseId || "").trim();
  if (!id) return null;

  const idx = loadAssetIndex();
  return idx.imagesById?.[id] || IMAGE_FALLBACKS[id] || null;
}

export function isTransitionStep(poseId) {
  const idx = loadAssetIndex();
  const meta = idx.metaById?.[poseId];
  return meta?.difficultyBand === 0 || (meta?.patterns || []).includes("transition");
}
