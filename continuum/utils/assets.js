export async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

export function normalizePoseMeta(raw) {
  return Array.isArray(raw) ? raw : (raw?.poses ?? raw?.items ?? Object.values(raw ?? {}));
}

const FALLBACK_IMAGES = {
  triangle: "assets/images/poses/stage-2-upright/triangle.png",
};

export function buildAssetResolver(assetIndexJson) {
  const idx = assetIndexJson || {};
  return {
    getImagePath(poseId) {
      const id = String(poseId || "").trim();
      if (!id) return null;
      return idx.imagesById?.[id] ?? FALLBACK_IMAGES[id] ?? null;
    }
  };
}
