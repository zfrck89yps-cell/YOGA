// test-emphasis-params.mjs
// Focused tests for the emphasisKey parameter in buildSession.
//
// Covers:
//   1. Foundation stage always overrides emphasisKey to full_body for pose picking
//   2. Each non-full_body emphasis produces more matching-region poses than a full_body session
//   3. restore_full_body triggers arc "D" and restore bias regardless of energy/mood
//   4. session.emphasisKey is preserved correctly in output
//   5. All 7 emphases produce valid sessions (13 poses, no duplicates)
//   6. EMPHASIS_CYCLE contains all 7 keys; getTodaysEmphasis rotates through them

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { loadJSON, normalizePoseMeta } from "./utils/assets.js";
import { buildSession } from "./logic/flow-engine.js";
import {
  EMPHASIS_CYCLE,
  getTodaysEmphasis,
  saveEngineState,
  setStage,
} from "./logic/decision-engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POSE_COUNT = 13;
const PROGRESS_SCORE = 0.40;

const ALL_EMPHASES = [
  "full_body",
  "spine",
  "hips",
  "shoulders_upper_back",
  "posterior_chain",
  "quads_legs",
  "core_balance",
  "restore_full_body",
];

// ——————————————————————————————
// HELPERS
// ——————————————————————————————

function getRegions(step) {
  return step?.meta?.regions ?? [];
}

function getPosture(step) {
  return step?.meta?.derived?.posture ?? "";
}

function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function countMatchingRegion(steps, emphasisKey) {
  return steps.filter((st) => getRegions(st).includes(emphasisKey)).length;
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
    progressScore: PROGRESS_SCORE,
    targetPoseCount: POSE_COUNT,
    ...overrides,
  });
}

// ——————————————————————————————
// TEST 1 — foundation overrides emphasisKey to full_body for pose picking
// ——————————————————————————————

function testFoundationOverride(errors, results, poseMeta) {
  // In pickForPhase, the emphasisKey is forced to "full_body" when stage="foundation".
  // So a foundation session with emphasisKey="hips" should produce a similar pose
  // distribution to emphasisKey="full_body" — no hips emphasis bias in pick scoring.
  //
  // We verify this by comparing average hips-matching pose count between:
  //   - foundation + emphasisKey="hips"   (override → no bias)
  //   - build      + emphasisKey="hips"   (bias applied → more hips poses)
  // The build session should have significantly more hips-region poses.

  const N = 30;
  const foundationCounts = [];
  const buildCounts = [];

  for (let i = 0; i < N; i++) {
    const sf = session(poseMeta, { stage: "foundation", emphasisKey: "hips" });
    foundationCounts.push(countMatchingRegion(sf.steps, "hips"));

    const sb = session(poseMeta, { stage: "build", emphasisKey: "hips" });
    buildCounts.push(countMatchingRegion(sb.steps, "hips"));
  }

  const avgFoundation = +avg(foundationCounts).toFixed(2);
  const avgBuild      = +avg(buildCounts).toFixed(2);

  // Build sessions (bias active) must have more hips poses than foundation (no bias)
  if (avgBuild <= avgFoundation) {
    errors.push(
      `[foundation-override] build+hips avg hips-matches (${avgBuild}) should exceed ` +
      `foundation+hips (${avgFoundation}) — bias is suppressed in foundation`
    );
  }

  // Foundation sessions with emphasisKey="hips" must still produce a valid session
  for (let i = 0; i < 5; i++) {
    const s = session(poseMeta, { stage: "foundation", emphasisKey: "hips" });
    if (s.steps.length !== POSE_COUNT) {
      errors.push(`[foundation-override] foundation+hips session ${i}: expected ${POSE_COUNT} poses, got ${s.steps.length}`);
    }
    if (s.emphasisKey !== "hips") {
      errors.push(`[foundation-override] session.emphasisKey should be preserved as "hips", got "${s.emphasisKey}"`);
    }
  }

  results.push({
    test: "1. Foundation overrides emphasisKey to full_body for pose picking (bias suppressed)",
    avgHipsMatches_foundation: avgFoundation,
    avgHipsMatches_build:      avgBuild,
    note: "build sessions have more hips-region poses because the bias is active there",
  });
}

// ——————————————————————————————
// TEST 2 — each emphasis biases pose selection toward matching regions
// ——————————————————————————————

function testEmphasisBias(errors, results, poseMeta) {
  const N = 30;
  const SCORED_EMPHASES = ["spine", "hips", "shoulders_upper_back", "posterior_chain", "quads_legs", "core_balance"];

  // Baseline: full_body sessions (no bias)
  const baselineCounts = {};
  for (const ek of SCORED_EMPHASES) {
    baselineCounts[ek] = [];
    for (let i = 0; i < N; i++) {
      const s = session(poseMeta, { emphasisKey: "full_body", stage: "build" });
      baselineCounts[ek].push(countMatchingRegion(s.steps, ek));
    }
  }

  const biasedAvgs    = {};
  const baselineAvgs  = {};

  for (const ek of SCORED_EMPHASES) {
    const biasedCounts = [];
    for (let i = 0; i < N; i++) {
      const s = session(poseMeta, { emphasisKey: ek, stage: "build" });
      biasedCounts.push(countMatchingRegion(s.steps, ek));
    }

    const biasedAvg   = +avg(biasedCounts).toFixed(2);
    const baselineAvg = +avg(baselineCounts[ek]).toFixed(2);

    biasedAvgs[ek]   = biasedAvg;
    baselineAvgs[ek] = baselineAvg;

    if (biasedAvg <= baselineAvg) {
      errors.push(
        `[emphasis-bias] "${ek}": biased avg (${biasedAvg}) should exceed full_body baseline (${baselineAvg})`
      );
    }
  }

  results.push({
    test: "2. Each emphasis produces more matching-region poses than a full_body session",
    avgMatchingPoses_biased:   biasedAvgs,
    avgMatchingPoses_baseline: baselineAvgs,
  });
}

// ——————————————————————————————
// TEST 3 — restore_full_body triggers arc "D" and restore bias
// ——————————————————————————————

function testRestoreEmphasis(errors, results, poseMeta) {
  // restore_full_body is one of the three conditions that forces arc "D" and restoreBias.
  // This is independent of energy and mood.

  // Arc "D" at all energy/mood combinations
  const arcCases = [
    { energy: 3, mood: 3 },
    { energy: 5, mood: 5 },
    { energy: 1, mood: 1 },
    { energy: 4, mood: 4 },
  ];

  for (const { energy, mood } of arcCases) {
    const s = session(poseMeta, { emphasisKey: "restore_full_body", energy, mood });
    if (s.arcProfile !== "D") {
      errors.push(
        `[restore-emphasis] energy=${energy}, mood=${mood}, restore_full_body: ` +
        `expected arcProfile "D", got "${s.arcProfile}"`
      );
    }
  }

  // Restore bias → upright phase count = 2 (not 3) in build stage
  const N = 20;
  const uprightRestore   = [];
  const uprightFullBody  = [];

  for (let i = 0; i < N; i++) {
    const sr = session(poseMeta, { emphasisKey: "restore_full_body", energy: 3, mood: 3 });
    const sf = session(poseMeta, { emphasisKey: "full_body",         energy: 3, mood: 3 });
    uprightRestore.push(sr.steps.filter((st) => getPosture(st) === "upright").length);
    uprightFullBody.push(sf.steps.filter((st) => getPosture(st) === "upright").length);
  }

  const avgRestore  = +avg(uprightRestore).toFixed(2);
  const avgFullBody = +avg(uprightFullBody).toFixed(2);

  if (avgRestore >= avgFullBody) {
    errors.push(
      `[restore-emphasis] restore_full_body should produce fewer upright poses than full_body: ` +
      `restore=${avgRestore}, full_body=${avgFullBody}`
    );
  }

  results.push({
    test: "3. restore_full_body forces arcProfile 'D' and shallower upright phase regardless of energy/mood",
    arcProfileCasesChecked: arcCases.length,
    avgUprightPoses_restore:   avgRestore,
    avgUprightPoses_full_body: avgFullBody,
  });
}

// ——————————————————————————————
// TEST 4 — session.emphasisKey is preserved in output
// ——————————————————————————————

function testEmphasisKeyPreserved(errors, results, poseMeta) {
  for (const ek of ALL_EMPHASES) {
    for (const stage of ["foundation", "build"]) {
      const s = session(poseMeta, { emphasisKey: ek, stage });
      if (s.emphasisKey !== ek) {
        errors.push(
          `[key-preserved] emphasisKey="${ek}", stage=${stage}: ` +
          `session.emphasisKey is "${s.emphasisKey}", expected "${ek}"`
        );
      }
    }
  }

  results.push({
    test: "4. session.emphasisKey is preserved exactly as passed (all 8 keys × 2 stages)",
    casesChecked: ALL_EMPHASES.length * 2,
  });
}

// ——————————————————————————————
// TEST 5 — all 7 emphases produce valid sessions
// ——————————————————————————————

function testSessionValidity(errors, results, poseMeta) {
  const REPS = 8;
  let totalChecked = 0;

  for (const ek of ALL_EMPHASES) {
    for (const stage of ["foundation", "build"]) {
      for (let i = 0; i < REPS; i++) {
        const s = session(poseMeta, {
          emphasisKey: ek,
          stage,
          energy: (i % 5) + 1,
          mood: ((i + 2) % 5) + 1,
          progressScore: PROGRESS_SCORE,
        });

        if (s.steps.length !== POSE_COUNT) {
          errors.push(
            `[validity] emphasisKey="${ek}", stage=${stage}, session ${i}: ` +
            `expected ${POSE_COUNT} poses, got ${s.steps.length}`
          );
        }

        const ids = s.steps.map((st) => st.poseId);
        const dupes = ids.filter((id, idx) => ids.indexOf(id) !== idx);
        if (dupes.length) {
          errors.push(
            `[validity] emphasisKey="${ek}", stage=${stage}, session ${i}: ` +
            `duplicate poses: ${[...new Set(dupes)].join(", ")}`
          );
        }

        totalChecked++;
      }
    }
  }

  results.push({
    test: "5. All 8 emphasis keys produce valid sessions (13 poses, no duplicates)",
    sessionsChecked: totalChecked,
  });
}

// ——————————————————————————————
// TEST 6 — EMPHASIS_CYCLE and getTodaysEmphasis rotation
// ——————————————————————————————

function testEmphasisCycle(errors, results) {
  // 1. EMPHASIS_CYCLE must contain exactly the 7 non-full_body emphases
  const expected = new Set(["spine", "hips", "posterior_chain", "quads_legs", "shoulders_upper_back", "core_balance", "restore_full_body"]);

  if (EMPHASIS_CYCLE.length !== 7) {
    errors.push(`[cycle] EMPHASIS_CYCLE length should be 7, got ${EMPHASIS_CYCLE.length}`);
  }

  for (const key of EMPHASIS_CYCLE) {
    if (!expected.has(key)) {
      errors.push(`[cycle] EMPHASIS_CYCLE contains unexpected key "${key}"`);
    }
  }

  for (const key of expected) {
    if (!EMPHASIS_CYCLE.includes(key)) {
      errors.push(`[cycle] EMPHASIS_CYCLE missing "${key}"`);
    }
  }

  // 2. getTodaysEmphasis rotates across 7 consecutive weeks (build stage).
  // getTodaysEmphasis only advances & saves state when called WITHOUT an explicit
  // stage argument (passing stage bypasses persistence). So we reset state, set
  // the stage via setStage(), then call without stage.
  saveEngineState({ stage: "build", foundationIndex: 0, buildWeekIndex: 0, lastDayISO: null, lastWeekCounter: null });
  setStage("build");

  const buildSeen = new Set();
  for (let week = 0; week < 7; week++) {
    // June 2026 dates, 7 days apart — each maps to a different week counter
    const d = new Date(Date.UTC(2026, 5, 1 + week * 7));
    const iso = d.toISOString().slice(0, 10);
    const ek = getTodaysEmphasis({ isoDate: iso }); // no stage → saves state → index advances
    buildSeen.add(ek);
  }

  if (buildSeen.size < 7) {
    errors.push(`[cycle] build stage: expected 7 unique emphases across 7 weeks, got ${buildSeen.size}: ${JSON.stringify([...buildSeen])}`);
  }

  // 3. Foundation cycles daily.
  saveEngineState({ stage: "foundation", foundationIndex: 0, buildWeekIndex: 0, lastDayISO: null, lastWeekCounter: null });
  setStage("foundation");

  const foundationSeen = new Set();
  for (let day = 0; day < 7; day++) {
    // 7 consecutive days starting July 2026
    const d = new Date(Date.UTC(2026, 6, 1 + day));
    const iso = d.toISOString().slice(0, 10);
    const ek = getTodaysEmphasis({ isoDate: iso }); // no stage → saves state → index advances
    foundationSeen.add(ek);
  }

  if (foundationSeen.size < 7) {
    errors.push(`[cycle] foundation stage: expected 7 unique emphases across 7 days, got ${foundationSeen.size}: ${JSON.stringify([...foundationSeen])}`);
  }

  results.push({
    test: "6. EMPHASIS_CYCLE contains all 7 keys; getTodaysEmphasis rotates across weeks (build) and days (foundation)",
    cycleLength: EMPHASIS_CYCLE.length,
    cycleKeys: EMPHASIS_CYCLE,
    uniqueKeysAcross7Weeks_build: buildSeen.size,
    uniqueKeysAcross7Days_foundation: foundationSeen.size,
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

  testFoundationOverride(errors, results, poseMeta);
  testEmphasisBias(errors, results, poseMeta);
  testRestoreEmphasis(errors, results, poseMeta);
  testEmphasisKeyPreserved(errors, results, poseMeta);
  testSessionValidity(errors, results, poseMeta);
  testEmphasisCycle(errors, results);

  const output = {
    testedAt: new Date().toISOString(),
    parameter: "emphasisKey",
    errors,
    results,
  };

  fs.writeFileSync(
    path.join(__dirname, "engine-test-emphasis-params.json"),
    JSON.stringify(output, null, 2)
  );

  console.log("\nEMPHASIS KEY PARAMETER TESTS");
  console.log("=============================");
  console.log(`Tests run: ${results.length}`);
  console.log(`Errors:    ${errors.length}`);
  console.log();

  for (const result of results) {
    const label = labelOf(result.test);
    const testErrors = errors.filter((e) => e.startsWith(`[${label}]`));
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

  console.log("\n✅ All emphasis key parameter tests passed.");
}

function labelOf(testTitle) {
  const map = {
    "1. Foundation overrides emphasisKey to full_body for pose picking (bias suppressed)": "foundation-override",
    "2. Each emphasis produces more matching-region poses than a full_body session": "emphasis-bias",
    "3. restore_full_body forces arcProfile 'D' and shallower upright phase regardless of energy/mood": "restore-emphasis",
    "4. session.emphasisKey is preserved exactly as passed (all 8 keys × 2 stages)": "key-preserved",
    "5. All 8 emphasis keys produce valid sessions (13 poses, no duplicates)": "validity",
    "6. EMPHASIS_CYCLE contains all 7 keys; getTodaysEmphasis rotates across weeks (build) and days (foundation)": "cycle",
  };
  return map[testTitle] ?? testTitle;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
