// logic/decision-engine.js
// Persists stage + emphasis rotation state.
// Storage default: localStorage (browser). Falls back to in-memory (node/tests).

const DEFAULTS = {
  stage: "foundation", // "foundation" | "build" | "maintain"
  foundationIndex: 0,
  buildWeekIndex: 0,
  maintainWeekIndex: 0,
  lastDayISO: null,        // for foundation daily tick
  lastWeekCounter: null,   // for build/maintain weekly tick (counter-based)
};

export const EMPHASIS_CYCLE = [
  "spine",
  "hips",
  "shoulders_upper_back",
  "posterior_chain",
  "quads_legs",
  "core_balance",
  "restore_full_body",
];

// ---------- storage adapter ----------
function getStorage() {
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;

  const mem = new Map();
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
    removeItem: (k) => mem.delete(k),
  };
}

const storage = getStorage();
const KEY = "continuum.engine.state.v1";

// ---------- stage alias handling ----------
export function canonicalizeStage(stage) {
  const s = String(stage || "").trim().toLowerCase();

  if (!s) return "foundation";
  if (["foundation", "build", "maintain"].includes(s)) return s;

  if (s === "stage-1-foundations") return "foundation";
  if (
    s === "stage-2-upright" ||
    s === "stage-3-grounded" ||
    s === "stage-4-bridges" ||
    s === "stage-5-rotations"
  ) {
    return "build";
  }
  if (s === "stage-6-transitions") return "maintain";

  return "foundation";
}

export function loadEngineState() {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed, stage: canonicalizeStage(parsed?.stage) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveEngineState(state) {
  storage.setItem(KEY, JSON.stringify({
    ...state,
    stage: canonicalizeStage(state?.stage),
  }));
}

export function setStage(stage) {
  const s = canonicalizeStage(stage);
  const st = loadEngineState();
  st.stage = s;
  saveEngineState(st);
  return st;
}

export function getStage() {
  return canonicalizeStage(loadEngineState().stage);
}

// ---------- helpers ----------
export function toISODate(d = new Date()) {
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * We use a simple "week counter" (every 7 days) for Build/Maintain.
 */
export function getWeekCounter(isoDate, startISO = null) {
  const base = startISO ? new Date(startISO + "T00:00:00") : new Date("2026-01-01T00:00:00");
  const now = new Date(isoDate + "T00:00:00");
  const days = Math.floor((now - base) / (24 * 3600 * 1000));
  return Math.floor(days / 7);
}

// ---------- public: get today's emphasis ----------
export function getTodaysEmphasis({
  isoDate = toISODate(),
  weekAnchorISO = null,
  stage = null,
} = {}) {
  const st = loadEngineState();
  const resolvedStage = stage ? canonicalizeStage(stage) : canonicalizeStage(st.stage);

  if (resolvedStage === "foundation") {
    if (st.lastDayISO !== isoDate) {
      st.foundationIndex = (st.foundationIndex + 1) % EMPHASIS_CYCLE.length;
      st.lastDayISO = isoDate;
      if (!stage) saveEngineState(st);
    }
    return EMPHASIS_CYCLE[st.foundationIndex];
  }

  const counter = getWeekCounter(isoDate, weekAnchorISO);

  if (st.lastWeekCounter !== counter) {
    if (resolvedStage === "build") {
      st.buildWeekIndex = (st.buildWeekIndex + 1) % EMPHASIS_CYCLE.length;
    }
    if (resolvedStage === "maintain") {
      st.maintainWeekIndex = (st.maintainWeekIndex + 1) % EMPHASIS_CYCLE.length;
    }
    st.lastWeekCounter = counter;
    if (!stage) saveEngineState(st);
  }

  const idx = resolvedStage === "build" ? st.buildWeekIndex : st.maintainWeekIndex;
  return EMPHASIS_CYCLE[idx];
}

/**
 * decideSessionInputs()
 * Normalises/derives session inputs in one place.
 */
export function decideSessionInputs({
  stage = null,
  emphasisKey = null,
  isoDate = null,
  weekAnchorISO = null,

  mood = 2,
  energy = 2,
  injuryTags = [],
  progressScore = null,
} = {}) {
  const resolvedStage = stage ? canonicalizeStage(stage) : getStage();
  const resolvedISO = isoDate || toISODate();

  const resolvedEmphasis =
    emphasisKey ||
    getTodaysEmphasis({
      isoDate: resolvedISO,
      weekAnchorISO,
      stage: resolvedStage,
    });

  return {
    stage: resolvedStage,
    emphasisKey: resolvedEmphasis,
    isoDate: resolvedISO,
    weekAnchorISO,

    mood: Number(mood) || 2,
    energy: Number(energy) || 2,
    injuryTags: Array.isArray(injuryTags) ? injuryTags : [],
    progressScore,
  };
}