// test-energy-params.mjs
// Focused tests for the energy parameter (1–5) in buildSession.
//
// Covers:
//   1. Effective difficulty scales +0.08 per energy step
//   2. Arc profile selected correctly (D / B / A) based on energy + mood
//   3. Intensity-4 poses are excluded when energy ≤ 2
//   4. maxBand is boosted by +1 for energy ≥ 4 in build/maintain stages
//   5. All energy levels produce valid sessions (count, no duplicates)
//   6. Low energy (≤2) produces a shallower upright-phase count than high energy (≥3)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { loadJSON, normalizePoseMeta } from "./utils/assets.js";
import { buildSession } from "./logic/flow-engine.js";
import {
  computeSessionDifficulty,
  maxBandFromEffectiveDifficulty,
} from "./logic/progression-engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POSE_COUNT = 13;
const ENERGY_LEVELS = [1, 2, 3, 4, 5];

// Chosen so energy 1–5 span 0.19–0.51 with no clamping (build stageCap=0.72)
const PROGRESS_SCORE_DIFF_TEST = 0.35;
// Chosen so energy=3 → maxBand=2 and energy=4 → maxBand=3 in build stage
const PROGRESS_SCORE_BAND_TEST = 0.40;
// Chosen so energy=2 still unlocks maxBand=3 (eff=0.57) to make intensity filter meaningful
const PROGRESS_SCORE_INTENSITY_TEST = 0.65;

const BUILD_EMPHASES = [
  "full_body", "hips", "spine", "quads_legs",
  "core_balance", "shoulders_upper_back", "posterior_chain",
];

// ——————————————————————————————
// HELPERS
// ——————————————————————————————

function getIntensity(step) {
  return step?.meta?.derived?.intensity ?? step?.meta?.biomech?.intensity ?? 0;
}

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
// TEST 1 — effective difficulty scales with energy
// ——————————————————————————————

function testEffectiveDifficulty(errors, results) {
  const stage = "build";
  const mood = 3;
  const progressScore = PROGRESS_SCORE_DIFF_TEST;

  const effValues = ENERGY_LEVELS.map((energy) =>
    computeSessionDifficulty({ progressScore, stage, mood, energy, injuryTags: [] })
  );

  // Must be strictly increasing
  for (let i = 0; i < effValues.length - 1; i++) {
    if (effValues[i] >= effValues[i + 1]) {
      errors.push(
        `[eff-scaling] energy ${ENERGY_LEVELS[i]} eff ${effValues[i].toFixed(3)} ` +
        `is not less than energy ${ENERGY_LEVELS[i + 1]} eff ${effValues[i + 1].toFixed(3)}`
      );
    }
  }

  // Each consecutive step must be exactly +0.08 (no clamping with this progressScore)
  for (let i = 0; i < effValues.length - 1; i++) {
    const delta = +(effValues[i + 1] - effValues[i]).toFixed(4);
    if (Math.abs(delta - 0.08) > 0.001) {
      errors.push(
        `[eff-scaling] energy ${ENERGY_LEVELS[i]}→${ENERGY_LEVELS[i + 1]}: ` +
        `expected delta 0.08, got ${delta}`
      );
    }
  }

  results.push({
    test: "1. Effective difficulty scales +0.08 per energy step",
    effByEnergy: Object.fromEntries(
      ENERGY_LEVELS.map((e, i) => [e, +effValues[i].toFixed(3)])
    ),
  });
}

// ——————————————————————————————
// TEST 2 — arc profile selection
// ——————————————————————————————

function testArcProfile(errors, results, poseMeta) {
  // [energy, mood, emphasisKey, expectedArc, description]
  const cases = [
    [1, 3, "full_body",         "D", "energy 1 → D"],
    [2, 3, "full_body",         "D", "energy 2 → D"],
    [2, 5, "full_body",         "D", "energy 2 high mood → still D"],
    [3, 3, "full_body",         "B", "energy 3, mood 3 → B"],
    [3, 5, "full_body",         "B", "energy 3 high mood → B (not A)"],
    [4, 3, "full_body",         "A", "energy 4, mood 3 → A"],
    [5, 5, "full_body",         "A", "energy 5, high mood → A"],
    [4, 2, "full_body",         "D", "energy 4 but mood ≤ 2 → D"],
    [5, 1, "full_body",         "D", "energy 5 but mood 1 → D"],
    [5, 4, "restore_full_body", "D", "restore emphasis always → D"],
  ];

  for (const [energy, mood, emphasisKey, expectedArc, desc] of cases) {
    const s = session(poseMeta, {
      energy, mood, emphasisKey,
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
    test: "2. Arc profile: energy ≤2 → D, energy ≥4 + mood ≥3 → A, else → B",
    casesChecked: cases.length,
  });
}

// ——————————————————————————————
// TEST 3 — intensity-4 poses excluded at energy ≤ 2
// ——————————————————————————————

function testIntensityFiltering(errors, results, poseMeta) {
  const REPS = 12;
  let intensity4PosesInDataset = 0;
  const violations = [];

  // Confirm dataset actually has intensity-4 poses (sanity check for the test itself)
  const allPoses = Array.isArray(poseMeta) ? poseMeta : Object.values(poseMeta);
  for (const p of allPoses) {
    const intensity = p?.biomech?.intensity
      ? Math.min(Math.max(Number(p.biomech.intensity), 1), 5)
      : Math.min(Math.max((Number(p?.difficultyBand) || 1) + 1, 1), 5);
    if (intensity >= 4) intensity4PosesInDataset++;
  }

  for (const energy of [1, 2]) {
    for (let i = 0; i < REPS; i++) {
      const s = session(poseMeta, {
        energy,
        stage: "build",
        mood: 3,
        emphasisKey: BUILD_EMPHASES[i % BUILD_EMPHASES.length],
        // High progressScore so band-3 poses pass the maxBand filter before hitting energy filter
        progressScore: PROGRESS_SCORE_INTENSITY_TEST,
      });

      for (const step of s.steps) {
        const intensity = getIntensity(step);
        if (intensity >= 4) {
          violations.push({ energy, sessionIndex: i, poseId: step.poseId, intensity });
          errors.push(
            `[intensity-filter] energy=${energy}, session ${i}: ` +
            `"${step.poseId}" has intensity ${intensity} (must be blocked)`
          );
        }
      }
    }
  }

  if (intensity4PosesInDataset === 0) {
    errors.push(
      "[intensity-filter] No intensity-4 poses found in dataset — this test cannot meaningfully verify the filter"
    );
  }

  results.push({
    test: "3. Intensity-4 poses excluded when energy ≤ 2",
    intensity4PosesInDataset,
    sessionsChecked: 2 * REPS,
    violations: violations.length,
  });
}

// ——————————————————————————————
// TEST 4 — maxBand boosted for energy ≥ 4 in build stage
// ——————————————————————————————

function testMaxBandBoost(errors, results, poseMeta) {
  // With PROGRESS_SCORE_BAND_TEST=0.40, build stage, mood=3:
  //   energy=3 → eff=0.40 → maxBand=2 (no boost)
  //   energy=4 → eff=0.48 → maxBand=2 base, +1 boost → maxBand=3

  const s3 = session(poseMeta, {
    energy: 3, stage: "build", mood: 3,
    progressScore: PROGRESS_SCORE_BAND_TEST,
  });
  const s4 = session(poseMeta, {
    energy: 4, stage: "build", mood: 3,
    progressScore: PROGRESS_SCORE_BAND_TEST,
  });
  const s5 = session(poseMeta, {
    energy: 5, stage: "build", mood: 3,
    progressScore: PROGRESS_SCORE_BAND_TEST,
  });

  if (s3.maxBand !== 2) {
    errors.push(
      `[maxband-boost] energy=3, progressScore=${PROGRESS_SCORE_BAND_TEST}: ` +
      `expected maxBand=2, got ${s3.maxBand}`
    );
  }
  if (s4.maxBand !== 3) {
    errors.push(
      `[maxband-boost] energy=4, progressScore=${PROGRESS_SCORE_BAND_TEST}: ` +
      `expected maxBand=3, got ${s4.maxBand}`
    );
  }
  if (s5.maxBand !== 3) {
    errors.push(
      `[maxband-boost] energy=5, progressScore=${PROGRESS_SCORE_BAND_TEST}: ` +
      `expected maxBand=3, got ${s5.maxBand}`
    );
  }

  // Foundation stage must NOT boost even at energy 4
  const sFoundation4 = session(poseMeta, {
    energy: 4, stage: "foundation", mood: 3,
    progressScore: PROGRESS_SCORE_BAND_TEST,
  });
  const baseMaxBand = maxBandFromEffectiveDifficulty(
    computeSessionDifficulty({ progressScore: PROGRESS_SCORE_BAND_TEST, stage: "foundation", mood: 3, energy: 4, injuryTags: [] })
  );
  if (sFoundation4.maxBand > baseMaxBand) {
    errors.push(
      `[maxband-boost] foundation stage energy=4 should not boost maxBand ` +
      `(base=${baseMaxBand}, got ${sFoundation4.maxBand})`
    );
  }

  results.push({
    test: "4. maxBand boosted +1 for energy ≥ 4 in build/maintain (not foundation)",
    energy3_eff: +s3.effectiveDifficulty.toFixed(3),
    energy3_maxBand: s3.maxBand,
    energy4_eff: +s4.effectiveDifficulty.toFixed(3),
    energy4_maxBand: s4.maxBand,
    energy5_maxBand: s5.maxBand,
    foundation_energy4_maxBand: sFoundation4.maxBand,
  });
}

// ——————————————————————————————
// TEST 5 — all energy levels produce valid sessions
// ——————————————————————————————

function testSessionValidity(errors, results, poseMeta) {
  const REPS = 10;
  let totalChecked = 0;

  for (const energy of ENERGY_LEVELS) {
    for (let i = 0; i < REPS; i++) {
      const stage = i < 5 ? "foundation" : "build";
      const emphasisKey = stage === "foundation"
        ? "full_body"
        : BUILD_EMPHASES[i % BUILD_EMPHASES.length];

      const s = session(poseMeta, {
        energy,
        stage,
        emphasisKey,
        mood: (i % 5) + 1,
        progressScore: 0.20,
      });

      if (s.steps.length !== POSE_COUNT) {
        errors.push(
          `[validity] energy=${energy}, session ${i}, stage=${stage}: ` +
          `expected ${POSE_COUNT} poses, got ${s.steps.length}`
        );
      }

      const ids = s.steps.map((step) => step.poseId);
      const dupes = ids.filter((id, idx) => ids.indexOf(id) !== idx);
      if (dupes.length) {
        errors.push(
          `[validity] energy=${energy}, session ${i}: ` +
          `duplicate poses: ${[...new Set(dupes)].join(", ")}`
        );
      }

      if (s.energy !== energy) {
        errors.push(
          `[validity] energy=${energy}, session ${i}: ` +
          `session.energy is ${s.energy}, expected ${energy}`
        );
      }

      totalChecked++;
    }
  }

  results.push({
    test: "5. All energy levels produce valid sessions (count, no duplicates, energy preserved)",
    sessionsChecked: totalChecked,
  });
}

// ——————————————————————————————
// TEST 6 — low energy produces shallower upright phase
// ——————————————————————————————

function testPhaseStructure(errors, results, poseMeta) {
  // buildPhasePlan sets uprightBuild.count = restoreBias ? 2 : 3 (build stage only).
  // restoreBias = true when energy ≤ 2. So build-stage sessions at energy 1–2 should
  // average fewer upright-posture poses than sessions at energy 3–5.
  const N = 20;
  const uprightCounts = {};

  for (const energy of ENERGY_LEVELS) {
    uprightCounts[energy] = [];
    for (let i = 0; i < N; i++) {
      const s = session(poseMeta, {
        energy,
        stage: "build",
        mood: 3,
        emphasisKey: "full_body",
        progressScore: 0.20,
      });
      const uprightCount = s.steps.filter((st) => getPosture(st) === "upright").length;
      uprightCounts[energy].push(uprightCount);
    }
  }

  const avgByEnergy = {};
  for (const energy of ENERGY_LEVELS) {
    avgByEnergy[energy] = +avg(uprightCounts[energy]).toFixed(2);
  }

  const avgLow  = avg([...uprightCounts[1], ...uprightCounts[2]]);
  const avgHigh = avg([...uprightCounts[3], ...uprightCounts[4], ...uprightCounts[5]]);

  if (avgLow >= avgHigh) {
    errors.push(
      `[phase-structure] avg upright poses at energy 1–2 (${avgLow.toFixed(2)}) ` +
      `should be less than energy 3–5 (${avgHigh.toFixed(2)})`
    );
  }

  results.push({
    test: "6. Low energy (≤2) produces shallower upright phase than high energy (≥3)",
    avgUprightByEnergy: avgByEnergy,
    avgLowEnergy_1_2:  +avgLow.toFixed(2),
    avgHighEnergy_3_5: +avgHigh.toFixed(2),
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
  testIntensityFiltering(errors, results, poseMeta);
  testMaxBandBoost(errors, results, poseMeta);
  testSessionValidity(errors, results, poseMeta);
  testPhaseStructure(errors, results, poseMeta);

  const output = {
    testedAt: new Date().toISOString(),
    parameter: "energy",
    errors,
    results,
  };

  fs.writeFileSync(
    path.join(__dirname, "engine-test-energy.json"),
    JSON.stringify(output, null, 2)
  );

  console.log("\nENERGY PARAMETER TESTS");
  console.log("======================");
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

  console.log("\n✅ All energy parameter tests passed.");
}

function labelOf(testTitle) {
  const map = {
    "1. Effective difficulty scales +0.08 per energy step": "eff-scaling",
    "2. Arc profile: energy ≤2 → D, energy ≥4 + mood ≥3 → A, else → B": "arc-profile",
    "3. Intensity-4 poses excluded when energy ≤ 2": "intensity-filter",
    "4. maxBand boosted +1 for energy ≥ 4 in build/maintain (not foundation)": "maxband-boost",
    "5. All energy levels produce valid sessions (count, no duplicates, energy preserved)": "validity",
    "6. Low energy (≤2) produces shallower upright phase than high energy (≥3)": "phase-structure",
  };
  return map[testTitle] ?? testTitle;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
