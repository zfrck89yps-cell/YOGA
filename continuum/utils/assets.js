export async function loadJSON(path) {
  // If running in Node (no window object)
  if (typeof window === "undefined") {
    const fs = await import("fs/promises");
    const { fileURLToPath } = await import("url");
    const { dirname, resolve } = await import("path");

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    // resolve relative to /continuum folder
    const fullPath = resolve(__dirname, "..", path);

    const data = await fs.readFile(fullPath, "utf-8");
    return JSON.parse(data);
  }

  // Browser (your app)
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  return res.json();
}

export function normalizePoseMeta(raw) {
  return Array.isArray(raw) ? raw : (raw?.poses ?? raw?.items ?? Object.values(raw ?? {}));
}

const FALLBACK_IMAGES = {
  triangle: "assets/poses/triangle.png",
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
