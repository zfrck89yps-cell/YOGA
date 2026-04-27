// logic/progression-engine.js
// Slow, lifetime progression. Difficulty rises gradually as sessions are completed.

const KEY = "continuum.engine.progress.v1";

function getStorage() {
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  const mem = new Map();
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
  };
}

const storage = getStorage();

const DEFAULT_PROGRESS = {
  score: 0.20,
  completedCount: 0,
};

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

export function canonicalizeStage(stage) {
  const s = String(stage || "").trim().toLowerCase();
  if (!s) return "foundation";
  if (["foundation", "build", "maintain"].includes(s)) return s;
  if (s === "stage-1-foundations") return "foundation";
  if (["stage-2-upright", "stage-3-grounded", "stage-4-bridges", "stage-5-rotations"].includes(s)) return "build";
  if (s === "stage-6-transitions") return "maintain";
  return "foundation";
}

export function loadProgress() {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PROGRESS };
    return { ...DEFAULT_PROGRESS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PROGRESS };
  }
}

export function saveProgress(p) {
  storage.setItem(KEY, JSON.stringify(p));
}

export function stageCap(stage) {
  const s = canonicalizeStage(stage);
  if (s === "foundation") return 0.40;
  if (s === "build") return 0.72;
  return 0.92;
}

export function effectiveDifficulty(score, stage) {
  return clamp(Math.min(Number(score) || 0, stageCap(stage)), 0.12, stageCap(stage));
}

export function computeSessionDifficulty({
  progressScore = null,
  stage,
  mood = 3,
  energy = 3,
  injuryTags = [],
} = {}) {
  const baseScore = progressScore == null ? loadProgress().score : Number(progressScore) || DEFAULT_PROGRESS.score;
  const cap = stageCap(stage);
  let eff = effectiveDifficulty(baseScore, stage);

  eff += (Number(energy) - 3) * 0.08;
  eff += (Number(mood) - 3) * 0.04;
  if ((injuryTags || []).length) eff -= 0.07;

  return clamp(eff, 0.12, cap);
}

export function maxBandFromEffectiveDifficulty(eff) {
  if (eff < 0.24) return 1;
  if (eff < 0.55) return 2;
  return 3;
}

export function scoreProgress({ stage, mood = 3, energy = 3, injuryTags = [], progressScore = null } = {}) {
  const progress = loadProgress();
  const eff = computeSessionDifficulty({
    progressScore: progressScore ?? progress.score,
    stage,
    mood,
    energy,
    injuryTags,
  });
  return { progress, effDifficulty: eff, maxBand: maxBandFromEffectiveDifficulty(eff) };
}

export function applySessionCompletion({
  stage,
  emphasisKey,
  mood = 3,
  energy = 3,
  completed = true,
} = {}) {
  const p = loadProgress();
  if (!completed) return p;

  const resolvedStage = canonicalizeStage(stage);
  let delta = 0.0012;
  if (Number(mood) === 1 || Number(energy) === 1) delta *= 0.35;
  if (emphasisKey === "restore_full_body") delta *= 0.25;

  p.score = Math.min(Math.max(0, p.score + delta), stageCap(resolvedStage));
  p.completedCount += 1;
  saveProgress(p);
  return p;
}
