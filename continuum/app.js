import { loadJSON, normalizePoseMeta, buildAssetResolver } from "./utils/assets.js";
import { buildSession } from "./logic/flow-engine.js";
import { getTodaysEmphasis, setStage, canonicalizeStage, toISODate } from "./logic/decision-engine.js";
import { loadProgress, applySessionCompletion } from "./logic/progression-engine.js";

const root = document.getElementById("app");
const STORE_KEY = "continuum.grid.v3";
const RESET_AFTER_DAYS = 28;
const FIXED_POSE_COUNT = 13;

const EMPHASIS_LABELS = {
  full_body: "full body",
  spine: "spine",
  hips: "hips",
  shoulders_upper_back: "shoulders / upper back",
  posterior_chain: "back body",
  quads_legs: "legs",
  core_balance: "core / balance",
  restore_full_body: "restore / full body",
};

const INJURY_OPTIONS = [
  ["wrists", "Wrists"],
  ["lower_back", "Lower back"],
  ["knees", "Knees"],
  ["hips", "Hips"],
  ["shoulders", "Shoulders"],
  ["neck", "Neck"],
  ["ankles", "Ankles"],
  ["hamstrings", "Hamstrings"],
];

const state = {
  screen: "home",
  poseMeta: null,
  resolver: null,
  session: null,
  settings: loadStore(),
};

function loadStore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return {
      mood: saved.mood ?? 3,
      energy: saved.energy ?? 3,
      stage: canonicalizeStage(saved.stage || "foundation"),
      injuryTags: Array.isArray(saved.injuryTags) ? saved.injuryTags : [],
      completedSessions: Number(saved.completedSessions || 0),
      lastUseISO: saved.lastUseISO || null,
      lastCompletedISO: saved.lastCompletedISO || null,
      lastSession: saved.lastSession || null,
      lastStartedISO: saved.lastStartedISO || null,
    };
  } catch {
    return {
      mood: 3,
      energy: 3,
      stage: "foundation",
      injuryTags: [],
      completedSessions: 0,
      lastUseISO: null,
      lastCompletedISO: null,
      lastSession: null,
      lastStartedISO: null,
    };
  }
}

function saveStore() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state.settings));
}

function daysBetween(aISO, bISO) {
  if (!aISO || !bISO) return 0;
  return Math.floor((new Date(bISO + "T00:00:00") - new Date(aISO + "T00:00:00")) / 86400000);
}

function checkLongBreakReset() {
  const today = toISODate();
  if (state.settings.lastUseISO && daysBetween(state.settings.lastUseISO, today) >= RESET_AFTER_DAYS) {
    state.settings.completedSessions = 0;
    state.settings.stage = "foundation";
  }
  state.settings.lastUseISO = today;
  saveStore();
}

function getResolvedStage() {
  return state.settings.completedSessions < 28 ? "foundation" : "build";
}

function titleCase(id = "") {
  return String(id).replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function isBothSides(step) {
  if (step?.bothSides) return true;
  const text = `${step.poseId} ${step.meta?.patterns?.join(" ") || ""}`.toLowerCase();
  return ["side", "twist", "hamstring", "lunge", "gate", "warrior", "triangle", "pigeon", "runner", "dancer", "tree", "three_legged"].some((x) => text.includes(x));
}

function sessionSubtitle(session) {
  if (!session) return "No session yet";
  const stage = session.stage === "foundation" ? "Foundation" : "Full body";
  const emphasis = EMPHASIS_LABELS[session.emphasisKey] || "full body";
  return session.stage === "foundation" ? `${stage} · full body` : `${stage} · emphasis: ${emphasis}`;
}

function buildTodaysSession() {
  const stage = getResolvedStage();
  setStage(stage);
  const emphasisKey = stage === "foundation" ? "full_body" : getTodaysEmphasis({ isoDate: toISODate(), stage });
  const injuryTags = state.settings.injuryTags;

  const session = buildSession({
    poseMeta: state.poseMeta,
    emphasisKey,
    stage,
    mood: Number(state.settings.mood),
    energy: Number(state.settings.energy),
    injuryTags,
    recentPoseIds: state.settings.lastSession?.steps?.map((s) => s.poseId) || [],
    targetPoseCount: FIXED_POSE_COUNT,
  });

  state.session = {
    ...session,
    id: `session-${Date.now()}`,
    startedISO: toISODate(),
    poseCount: FIXED_POSE_COUNT,
  };

  state.settings.stage = stage;
  state.settings.lastStartedISO = toISODate();
  state.settings.lastSession = state.session;
  saveStore();
}

function route(screen) {
  state.screen = screen;
  render();
}

function updateSetting(key, value) {
  state.settings[key] = value;
  saveStore();
  render();
}

function toggleInjury(tag) {
  const set = new Set(state.settings.injuryTags);
  set.has(tag) ? set.delete(tag) : set.add(tag);
  state.settings.injuryTags = [...set];
  saveStore();
  render();
}

function completeSession() {
  if (!state.session) return;
  applySessionCompletion({
    stage: state.session.stage,
    emphasisKey: state.session.emphasisKey,
    mood: Number(state.settings.mood),
    energy: Number(state.settings.energy),
    completed: true,
  });
  state.settings.completedSessions += 1;
  state.settings.lastCompletedISO = toISODate();
  state.settings.lastSession = { ...state.session, completedISO: toISODate() };
  saveStore();
  route("home");
}

function render() {
  if (state.screen === "builder") renderBuilder();
  else if (state.screen === "session") renderSession();
  else renderHome();
}

function renderHome() {
  const hasLast = !!state.settings.lastSession;
  root.innerHTML = `
    <main class="app-bg home-bg home-simple">
      <section class="home-actions" aria-label="Continuum home">
        <button class="home-btn primary" type="button" data-action="builder">Today's session</button>
        <button class="home-btn" type="button" data-action="last" ${hasLast ? "" : "disabled"}>Last session</button>
      </section>
    </main>
  `;
}

function renderBuilder() {
  const stage = getResolvedStage();
  const progress = loadProgress();
  const foundationDone = Math.min(28, state.settings.completedSessions);
  const emphasisKey = stage === "foundation" ? "full_body" : getTodaysEmphasis({ isoDate: toISODate(), stage });

  const energyOptions = [
    { value: 1, label: "1 (Very low)" },
    { value: 2, label: "2 (Low)" },
    { value: 3, label: "3 (Moderate)" },
    { value: 4, label: "4 (High)" },
    { value: 5, label: "5 (Very high)" }
  ];

  root.innerHTML = `
    <main class="app-bg session-bg builder-bg">
      <header class="builder-header">
        <button class="back-btn" type="button" data-action="home">Back</button>
        <div><h1>Session builder</h1>
        </div>
      </header>

      <section class="panel builder-panel">
        <div class="builder-grid">
          <label>Energy
            <select data-setting="energy">
              ${energyOptions.map(o => `
                <option value="${o.value}" ${Number(state.settings.energy) === o.value ? 'selected' : ''}>
                  ${o.label}
                </option>
              `).join("")}
            </select>
          </label>

          <label>Mood
            <select data-setting="mood">
              ${energyOptions.map(o => `
                <option value="${o.value}" ${Number(state.settings.mood) === o.value ? 'selected' : ''}>
                  ${o.label}
                </option>
              `).join("")}
            </select>
          </label>

          <div class="builder-status">
            <strong>
              ${stage === "foundation"
                ? `${foundationDone} / 28`
                : `${Math.round(progress.score * 100)}%`}
            </strong>
            <span>
              ${stage === "foundation"
                ? "Foundation"
                : "Progression"}
            </span>
          </div>
        </div>

        <p class="section-label injury-label">Injury / exclusion bias</p>
        <div class="chips">
          ${INJURY_OPTIONS.map(([tag,label]) => `
            <button type="button"
              class="chip ${state.settings.injuryTags.includes(tag) ? 'active' : ''}"
              data-injury="${tag}">
              ${label}
            </button>
          `).join("")}
        </div>
      </section>

      <button class="big-start" type="button" data-action="generate">
        Build today's session
      </button>
    </main>
  `;
}
function renderSession() {
  const s = state.session || state.settings.lastSession;
  if (!s) return route("builder");

  const cards = [
    `<article class="session-card intro-card"><h2>${EMPHASIS_LABELS[s.emphasisKey] || "Full body"}</h2><span>${s.phase === "foundation" ? "Foundation" : "Weekly emphasis"}</span></article>`,
    ...s.steps.map((step, i) => {
      const img = state.resolver.getImagePath(step.poseId);
      return `<article class="session-card pose-card">
        <span class="card-num">${i + 1}</span>
        ${img ? `<img src="${img}" alt="${titleCase(step.poseId)}" />` : `<div class="missing-img">${titleCase(step.poseId)}</div>`}
        <div class="pose-caption"><strong>${titleCase(step.poseId)}</strong>${isBothSides(step) ? `<small>Repeat on both sides</small>` : ""}</div>
      </article>`;
    }),
    `<button class="session-card complete-card" type="button" data-action="complete">Tap to complete</button>`
  ].join("");

  root.innerHTML = `
    <main class="app-bg session-bg">
      <header class="session-header">
        <button class="back-btn" type="button" data-action="home">Back</button>
        <div><h1>${new Date().toLocaleDateString("en-GB", { weekday: "long" })} yoga</h1
        </div>
      </header>
      <section class="session-grid">${cards}</section>
    </main>
  `;
}

root.addEventListener("click", (e) => {
  const target = e.target.closest("[data-action], [data-injury]");
  if (!target) return;
  if (target.dataset.injury) return toggleInjury(target.dataset.injury);

  const action = target.dataset.action;
  if (action === "builder") route("builder");
  if (action === "generate") { buildTodaysSession(); route("session"); }
  if (action === "last") { state.session = state.settings.lastSession; route("session"); }
  if (action === "home") route("home");
  if (action === "complete") completeSession();
});

root.addEventListener("change", (e) => {
  const target = e.target.closest("[data-setting]");
  if (!target) return;
  const key = target.dataset.setting;
  let value = target.value;
  if (["mood", "energy"].includes(key)) value = Number(value);
  updateSetting(key, value);
});

async function init() {
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("./service-worker.js"); } catch {}
  }
  checkLongBreakReset();
  const [metaRaw, assetIndex] = await Promise.all([
    loadJSON("./data/pose_meta.json"),
    loadJSON("./data/asset_index.json"),
  ]);
  state.poseMeta = normalizePoseMeta(metaRaw);
  state.resolver = buildAssetResolver(assetIndex);
  render();
}

init().catch((err) => {
  console.error(err);
  root.innerHTML = `<main class="app-bg home-bg"><section class="panel error"><h1>Continuum failed to load</h1><p>${err.message}</p></section></main>`;
});
