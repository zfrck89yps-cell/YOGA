// test-mood-params.mjs
// Focused tests for the mood parameter (1–5) in buildSession.
//
// Covers:
//   1. Effective difficulty scales +0.04 per mood step (half of energy's +0.08)
//   2. Arc profile selected correctly (D / B / A) based on mood + energy
//   3. Mood ≤ 2 triggers restore bias — shallower upright phase, same as low energy
//   4. Mood does NOT boost maxBand (unlike energy ≥ 4)
//   5. All mood levels produce valid sessions (count, no duplicates)
//   6. mood=1 reduces completion progress delta to 35%; mood 2–5 are full weight

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { loadJSON, normalizePoseMeta } from "./utils/assets.js";
import { buildSession } from "./logic/flow-engine.js";
import {
  computeSessionDifficulty,
  loadProgress,
  applySessionCompletion,
} from "./logic/progression-engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POSE_COUNT = 13;
const MOOD_LEVELS = [1, 2, 3, 4, 5];

// No clamping: mood 1–5 spans 0.27–0.43 in build stage with this progressScore
const PROGRESS_SCORE_DIFF_TEST = 0.35;
// Chosen so energy=3 gives eff=0.40 → maxBand=2 regardless of mood
const PROGRESS_SCORE_BAND_TEST = 0.40;

const BUILD_EMPHASES = [
  "full_body", "hips", "spine", "quads_legs",
  "core_balance", "shoulders_upper_back", "posterior_chain",
];

// ——————————————————————————————
// HELPERS
// ——————————————————————————————

function getPosture(step) {
  return step?.meta?.derived?.posture ?? "";
}

function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function session(poseMeta, overrides) {
  return buildSession({
    poseMeta,
    emphasisKey: "full_body",
    stage: "build",
    mood: 3,
    energy: 3,
    injuryTags: [],
    recentPoseIds: [],
    progressScore: PROGRESS_SCORE_DIFF_TEST,
    targetPoseCount: POSE_COUNT,
    ...overrides,
  });
}

// ——————————————————————————————
// TEST 1 — effective difficulty scales +0.04 per mood step
// ——————————————————————————————

function testEffectiveDifficulty(errors, results) {
  const stage = "build";
  const energy = 3;
  const progressScore = PROGRESS_SCORE_DIFF_TEST;

  const effValues = MOOD_LEVELS.map((mood) =>
    computeSessionDifficulty({ progressScore, stage, mood, energy, injuryTags: [] })
  );

  // Must be strictly increasing
  for (let i = 0; i < effValues.length - 1; i++) {
    if (effValues[i] >= effValues[i + 1]) {
      errors.push(
        `[eff-scaling] mood ${MOOD_LEVELS[i]} eff ${effValues[i].toFixed(3)} ` +
        `is not less than mood ${MOOD_LEVELS[i + 1]} eff ${effValues[i + 1].toFixed(3)}`
      );
    }
  }

  // Each consecutive step must be exactly +0.04
  for (let i = 0; i < effValues.length - 1; i++) {
    const delta = +(effValues[i + 1] - effValues[i]).toFixed(4);
    if (Math.abs(delta - 0.04) > 0.001) {
      errors.push(
        `[eff-scaling] mood ${MOOD_LEVELS[i]}→${MOOD_LEVELS[i + 1]}: ` +
        `expected delta 0.04, got ${delta}`
      );
    }
  }

  // Mood's influence must be exactly half of energy's per step (0.04 vs 0.08)
  const moodDelta = +(effValues[1] - effValues[0]).toFixed(4);
  const energyDelta = 0.08;
  if (Math.abs(moodDelta - energyDelta / 2) > 0.001) {
    errors.push(
      `[eff-scaling] mood delta per step (${moodDelta}) should be half of energy delta (${energyDelta / 2})`
    );
  }

  results.push({
    test: "1. Effective difficulty scales +0.04 per mood step (half of energy)",
    effByMood: Object.fromEntries(
      MOOD_LEVELS.map((m, i) => [m, +effValues[i].toFixed(3)])
    ),
    deltaPerStep: 0.04,
  });
}

// ——————————————————————————————
// TEST 2 — arc profile selection
// ——————————————————————————————

function testArcProfile(errors, results, poseMeta) {
  // [mood, energy, emphasisKey, expectedArc, description]
  const cases = [
    [1, 3, "full_body",         "D", "mood 1 → D"],
    [2, 3, "full_body",         "D", "mood 2 → D"],
    [2, 5, "full_body",         "D", "mood 2 high energy → still D"],
    [3, 3, "full_body",         "B", "mood 3, energy 3 → B"],
    [5, 3, "full_body",         "B", "mood 5, energy 3 → B (energy not high enough for A)"],
    [3, 4, "full_body",         "A", "mood 3, energy 4 → A"],
    [5, 4, "full_body",         "A", "mood 5, energy 4 → A"],
    [2, 4, "full_body",         "D", "energy 4 but mood ≤ 2 → D"],
    [3, 5, "restore_full_body", "D", "restore emphasis always → D"],
    [5, 5, "restore_full_body", "D", "restore emphasis overrides both high mood + energy → D"],
  ];

  for (const [mood, energy, emphasisKey, expectedArc, desc] of cases) {
    const s = session(poseMeta, {
      mood, energy, emphasisKey,
      stage: "build",
      progressScore: 0.20,
    });
    if (s.arcProfile !== expectedArc) {
      errors.push(
        `[arc-profile] ${desc}: expected "${expectedArc}", got "${s.arcProfile}"`
      );
    }
  }

  results.push({
    test: "2. Arc profile: mood ≤2 → D; mood ≥3 + energy ≥4 → A; else → B",
    casesChecked: cases.length,
  });
}

// ——————————————————————————————
// TEST 3 — mood ≤ 2 triggers restore bias (shallower upright phase)
// ——————————————————————————————

function testPhaseStructure(errors, results, poseMeta) {
  // lowerEnergy = energy<=2 || mood<=2. With energy fixed at 3:
  //   mood ≤ 2 → lowerEnergy=true → uprightBuild count=2
  //   mood ≥ 3 → lowerEnergy=false → uprightBuild count=3
  const N = 20;
  const uprightCounts = {};

  for (const mood of MOOD_LEVELS) {
    uprightCounts[mood] = [];
    for (let i = 0; i < N; i++) {
      const s = session(poseMeta, {
        mood,
        energy: 3,
        stage: "build",
        emphasisKey: "full_body",
        progressScore: 0.20,
      });
      const uprightCount = s.steps.filter((st) => getPosture(st) === "upright").length;
      uprightCounts[mood].push(uprightCount);
    }
  }

  const avgByMood = {};
  for (const mood of MOOD_LEVELS) {
    avgByMood[mood] = +avg(uprightCounts[mood]).toFixed(2);
  }

  const avgLow  = avg([...uprightCounts[1], ...uprightCounts[2]]);
  const avgHigh = avg([...uprightCounts[3], ...uprightCounts[4], ...uprightCounts[5]]);

  if (avgLow >= avgHigh) {
    errors.push(
      `[phase-structure] avg upright poses at mood 1–2 (${avgLow.toFixed(2)}) ` +
      `should be less than mood 3–5 (${avgHigh.toFixed(2)})`
    );
  }

  results.push({
    test: "3. Mood ≤ 2 triggers restore bias — fewer upright poses (same mechanism as low energy)",
    avgUprightByMood: avgByMood,
    avgLowMood_1_2:  +avgLow.toFixed(2),
    avgHighMood_3_5: +avgHigh.toFixed(2),
  });
}

// ——————————————————————————————
// TEST 4 — mood does NOT boost maxBand
// ——————————————————————————————

function testMaxBandNotBoosted(errors, results, poseMeta) {
  // energy ≥ 4 boosts maxBand in build stage; mood ≥ 4 must NOT.
  // With PROGRESS_SCORE_BAND_TEST=0.40, energy=3:
  //   eff at mood=3 = 0.40 → maxBand=2
  //   eff at mood=5 = 0.48 → maxBand=2 (no boost applied)
  // Compare: energy=4, mood=3 → maxBand=3 (boost IS applied)

  const base = { stage: "build", progressScore: PROGRESS_SCORE_BAND_TEST };

  const sMood3 = session(poseMeta, { ...base, energy: 3, mood: 3 });
  const sMood5 = session(poseMeta, { ...base, energy: 3, mood: 5 });
  const sEnergy4 = session(poseMeta, { ...base, energy: 4, mood: 3 });

  if (sMood3.maxBand !== sMood5.maxBand) {
    errors.push(
      `[maxband-mood] maxBand should not change with mood: ` +
      `mood=3 → ${sMood3.maxBand}, mood=5 → ${sMood5.maxBand}`
    );
  }

  if (sMood5.maxBand >= sEnergy4.maxBand) {
    errors.push(
      `[maxband-mood] mood=5 maxBand (${sMood5.maxBand}) should be less than ` +
      `energy=4 maxBand (${sEnergy4.maxBand}) at same progressScore`
    );
  }

  results.push({
    test: "4. Mood does NOT boost maxBand (unlike energy ≥ 4)",
    energy3_mood3_maxBand: sMood3.maxBand,
    energy3_mood5_maxBand: sMood5.maxBand,
    energy4_mood3_maxBand: sEnergy4.maxBand,
    note: "mood varies → maxBand unchanged; energy=4 → maxBand increases",
  });
}

// ——————————————————————————————
// TEST 5 — all mood levels produce valid sessions
// ——————————————————————————————

function testSessionValidity(errors, results, poseMeta) {
  const REPS = 10;
  let totalChecked = 0;

  for (const mood of MOOD_LEVELS) {
    for (let i = 0; i < REPS; i++) {
      const stage = i < 5 ? "foundation" : "build";
      const emphasisKey = stage === "foundation"
        ? "full_body"
        : BUILD_EMPHASES[i % BUILD_EMPHASES.length];

      const s = session(poseMeta, {
        mood,
        energy: (i % 5) + 1,
        stage,
        emphasisKey,
        progressScore: 0.20,
      });

      if (s.steps.length !== POSE_COUNT) {
        errors.push(
          `[validity] mood=${mood}, session ${i}, stage=${stage}: ` +
          `expected ${POSE_COUNT} poses, got ${s.steps.length}`
        );
      }

      const ids = s.steps.map((step) => step.poseId);
      const dupes = ids.filter((id, idx) => ids.indexOf(id) !== idx);
      if (dupes.length) {
        errors.push(
          `[validity] mood=${mood}, session ${i}: ` +
          `duplicate poses: ${[...new Set(dupes)].join(", ")}`
        );
      }

      if (s.mood !== mood) {
        errors.push(
          `[validity] mood=${mood}, session ${i}: session.mood is ${s.mood}, expected ${mood}`
        );
      }

      totalChecked++;
    }
  }

  results.push({
    test: "5. All mood levels produce valid sessions (count, no duplicates, mood preserved)",
    sessionsChecked: totalChecked,
  });
}

// ——————————————————————————————
// TEST 6 — mood=1 reduces completion delta; mood 2–5 are full weight
// ——————————————————————————————

function testCompletionScoring(errors, results) {
  // applySessionCompletion: if mood===1, delta *= 0.35
  // mood 2–5 all receive the full 0.0012 delta

  const FULL_DELTA  = 0.0012;
  const LOW_DELTA   = +(FULL_DELTA * 0.35).toFixed(6);
  const TOLERANCE   = 0.000001;

  function measureDelta(mood, energy = 3) {
    const before = loadProgress().score;
    applySessionCompletion({ stage: "build", emphasisKey: "full_body", mood, energy });
    const after  = loadProgress().score;
    return +(after - before).toFixed(6);
  }

  // mood 3 → full delta
  const d3 = measureDelta(3);
  if (Math.abs(d3 - FULL_DELTA) > TOLERANCE) {
    errors.push(
      `[completion] mood=3: expected delta ${FULL_DELTA}, got ${d3}`
    );
  }

  // mood 2 → full delta (only exact mood=1 is penalised)
  const d2 = measureDelta(2);
  if (Math.abs(d2 - FULL_DELTA) > TOLERANCE) {
    errors.push(
      `[completion] mood=2: expected full delta ${FULL_DELTA}, got ${d2}`
    );
  }

  // mood 5 → full delta
  const d5 = measureDelta(5);
  if (Math.abs(d5 - FULL_DELTA) > TOLERANCE) {
    errors.push(
      `[completion] mood=5: expected full delta ${FULL_DELTA}, got ${d5}`
    );
  }

  // mood 1 → reduced delta (35%)
  const d1 = measureDelta(1);
  if (Math.abs(d1 - LOW_DELTA) > TOLERANCE) {
    errors.push(
      `[completion] mood=1: expected reduced delta ${LOW_DELTA} (35%), got ${d1}`
    );
  }

  // mood=1 must give less progress than mood=3
  if (d1 >= d3) {
    errors.push(
      `[completion] mood=1 delta (${d1}) should be less than mood=3 delta (${d3})`
    );
  }

  results.push({
    test: "6. mood=1 reduces completion delta to 35%; mood 2–5 are full weight",
    fullDelta: FULL_DELTA,
    mood1_delta:  d1,
    mood2_delta:  d2,
    mood3_delta:  d3,
    mood5_delta:  d5,
    reductionFactor: "35% (×0.35) for mood=1 only",
  });
}

// ——————————————————————————————
// MAIN
// ——————————————————————————————

async function main() {
  const metaRaw = await loadJSON("./data/pose_meta.json");
  const poseMeta = normalizePoseMeta(metaRaw);

  const errors  = [];
  const results = [];

  testEffectiveDifficulty(errors, results);
  testArcProfile(errors, results, poseMeta);
  testPhaseStructure(errors, results, poseMeta);
  testMaxBandNotBoosted(errors, results, poseMeta);
  testSessionValidity(errors, results, poseMeta);
  testCompletionScoring(errors, results);

  const output = {
    testedAt: new Date().toISOString(),
    parameter: "mood",
    errors,
    results,
  };

  fs.writeFileSync(
    path.join(__dirname, "engine-test-mood.json"),
    JSON.stringify(output, null, 2)
  );

  console.log("\nMOOD PARAMETER TESTS");
  console.log("====================");
  console.log(`Tests run: ${results.length}`);
  console.log(`Errors:    ${errors.length}`);
  console.log();

  for (const result of results) {
    const testErrors = errors.filter((e) => e.startsWith(`[${labelOf(result.test)}]`));
    const icon = testErrors.length ? "❌" : "✅";
    console.log(`${icon} ${result.test}`);
    for (const [k, v] of Object.entries(result)) {
      if (k === "test") continue;
      console.log(`     ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
    }
  }

  if (errors.length) {
    console.log("\nERRORS");
    console.log("------");
    errors.forEach((e) => console.log(`  ❌ ${e}`));
    process.exit(1);
  }

  console.log("\n✅ All mood parameter tests passed.");
}

function labelOf(testTitle) {
  const map = {
    "1. Effective difficulty scales +0.04 per mood step (half of energy)": "eff-scaling",
    "2. Arc profile: mood ≤2 → D; mood ≥3 + energy ≥4 → A; else → B": "arc-profile",
    "3. Mood ≤ 2 triggers restore bias — fewer upright poses (same mechanism as low energy)": "phase-structure",
    "4. Mood does NOT boost maxBand (unlike energy ≥ 4)": "maxband-mood",
    "5. All mood levels produce valid sessions (count, no duplicates, mood preserved)": "validity",
    "6. mood=1 reduces completion delta to 35%; mood 2–5 are full weight": "completion",
  };
  return map[testTitle] ?? testTitle;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
