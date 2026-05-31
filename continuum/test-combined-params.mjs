// test-combined-params.mjs
// Tests the interaction of mood, energy, and injuryTags together.
//
// Covers:
//   1. Effective difficulty is fully additive across all three contributions
//   2. Injury band cap always overrides energy's maxBand boost
//   3. Restore bias is driven by energy/mood only — injury tags alone do not trigger it
//   4. Energy intensity filter and injury pose filter apply simultaneously and independently
//   5. Minimum constraint session (energy=1, mood=1, structural injury) still produces 13 poses
//   6. Full combination grid — all energy × mood pairings × injury scenarios produce valid sessions

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { loadJSON, normalizePoseMeta } from "./utils/assets.js";
import { buildSession } from "./logic/flow-engine.js";
import { computeSessionDifficulty } from "./logic/progression-engine.js";
import { filterContraindicated } from "./logic/safety-guards.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POSE_COUNT = 13;
const PROGRESS_SCORE = 0.40;

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
    progressScore: PROGRESS_SCORE,
    targetPoseCount: POSE_COUNT,
    ...overrides,
  });
}

// ——————————————————————————————
// TEST 1 — combined effective difficulty is fully additive
// ——————————————————————————————

function testAdditiveFormula(errors, results) {
  // eff = clamp(base + energyDelta + moodDelta + injuryDelta, 0.12, cap)
  // base = PROGRESS_SCORE (0.40) with neutral energy/mood/no-injury in build stage
  // energyDelta  = (energy - 3) * 0.08
  // moodDelta    = (mood   - 3) * 0.04
  // injuryDelta  = injuryTags.length > 0 ? -0.07 : 0
  const cap  = 0.72;
  const floor = 0.12;

  const cases = [
    // [energy, mood, injuryTags]
    [5, 5, ["lower_back"]],   // high energy + high mood + injury: 0.40+0.16+0.08-0.07 = 0.57
    [4, 2, ["hips"]],         // boosted energy, low mood, soft-tissue: 0.40+0.08-0.04-0.07 = 0.37
    [2, 4, ["wrists"]],       // low energy, boosted mood, structural: 0.40-0.08+0.04-0.07 = 0.29
    [1, 1, ["knees"]],        // all suppressed: 0.40-0.16-0.08-0.07 = 0.09 → clamped to 0.12
    [5, 5, []],               // max energy+mood, no injury: 0.40+0.16+0.08 = 0.64
    [1, 1, []],               // min energy+mood, no injury: 0.40-0.16-0.08 = 0.16
    [3, 3, ["shoulders"]],    // neutral energy+mood, soft-tissue: 0.40-0.07 = 0.33
    [4, 4, ["lower_back"]],   // both boosted, structural: 0.40+0.08+0.04-0.07 = 0.45
  ];

  const base = computeSessionDifficulty({
    progressScore: PROGRESS_SCORE, stage: "build", mood: 3, energy: 3, injuryTags: [],
  });

  for (const [energy, mood, injuryTags] of cases) {
    const energyDelta = (energy - 3) * 0.08;
    const moodDelta   = (mood   - 3) * 0.04;
    const injuryDelta = injuryTags.length > 0 ? -0.07 : 0;
    const expected    = +Math.min(cap, Math.max(floor, base + energyDelta + moodDelta + injuryDelta)).toFixed(3);

    const actual = +computeSessionDifficulty({
      progressScore: PROGRESS_SCORE, stage: "build", energy, mood, injuryTags,
    }).toFixed(3);

    if (Math.abs(actual - expected) > 0.001) {
      errors.push(
        `[additive] energy=${energy}, mood=${mood}, injury=${JSON.stringify(injuryTags)}: ` +
        `expected eff=${expected}, got ${actual}`
      );
    }
  }

  results.push({
    test: "1. Effective difficulty: energy (+0.08/step) + mood (+0.04/step) + injury (−0.07 flat) are additive",
    base_eff: +base.toFixed(3),
    casesChecked: cases.length,
    clampingConfirmed: "energy=1, mood=1, injury → raw=0.09 clamped to 0.12",
  });
}

// ——————————————————————————————
// TEST 2 — injury band cap overrides energy's maxBand boost
// ——————————————————————————————

function testInjuryCapOverridesEnergyBoost(errors, results, poseMeta) {
  // Resolution order in buildSession (lines 403-406 flow-engine.js):
  //   1. maxBand from eff
  //   2. energy ≥ 4 → +1 (build stage only)
  //   3. safety bias cap → overrides both

  const base = { progressScore: PROGRESS_SCORE, stage: "build", mood: 3 };

  // energy=4 without injury: maxBand should be boosted to 3
  const sE4NoInjury = session(poseMeta, { ...base, energy: 4, injuryTags: [] });
  if (sE4NoInjury.maxBand !== 3) {
    errors.push(`[cap-override] energy=4, no injury: expected maxBand=3, got ${sE4NoInjury.maxBand}`);
  }

  // energy=4 + structural injury: safety bias cap=1 overrides the boost → maxBand=1
  for (const tag of ["lower_back", "knees", "wrists", "neck"]) {
    const s = session(poseMeta, { ...base, energy: 4, injuryTags: [tag] });
    if (s.maxBand !== 1) {
      errors.push(
        `[cap-override] energy=4 + structural "${tag}": ` +
        `injury cap should override energy boost → maxBand=1, got ${s.maxBand}`
      );
    }
  }

  // energy=5 + structural injury: still maxBand=1 (no energy value escapes the cap)
  const sE5Structural = session(poseMeta, { ...base, energy: 5, injuryTags: ["lower_back"] });
  if (sE5Structural.maxBand !== 1) {
    errors.push(`[cap-override] energy=5 + lower_back: expected maxBand=1, got ${sE5Structural.maxBand}`);
  }

  // energy=4 + soft-tissue injury (cap=2): energy boost partially overridden → maxBand=2
  for (const tag of ["hips", "shoulders", "ankles", "hamstrings"]) {
    const s = session(poseMeta, { ...base, energy: 4, injuryTags: [tag] });
    if (s.maxBand !== 2) {
      errors.push(
        `[cap-override] energy=4 + soft-tissue "${tag}": ` +
        `expected maxBand=2 (partial override), got ${s.maxBand}`
      );
    }
  }

  results.push({
    test: "2. Injury band cap always overrides energy's maxBand boost (injury wins last)",
    energy4_noInjury_maxBand: sE4NoInjury.maxBand,
    energy4_structural_maxBand: 1,
    energy4_softTissue_maxBand: 2,
    energy5_structural_maxBand: sE5Structural.maxBand,
  });
}

// ——————————————————————————————
// TEST 3 — restore bias is driven by energy/mood only, not injury tags
// ——————————————————————————————

function testRestoreBiasNotTriggeredByInjury(errors, results, poseMeta) {
  // lowerEnergy = energy<=2 || mood<=2
  // Injury tags play no role in this condition.
  //
  // We test via arcProfile, which uses the same lowerEnergy condition
  // and is deterministic (no pool-depletion noise):
  //   energy=3, mood=3, any injury → arcProfile "B"  (injury doesn't change it)
  //   energy=2, mood=3, any injury → arcProfile "D"  (energy is the driver)
  //   energy=3, mood=2, any injury → arcProfile "D"  (mood is the driver)
  //
  // Note: injuries like lower_back DO reduce the actual upright pose count in a
  // session via pool depletion (warriors/lunges are blocked), but that is a
  // separate effect from restore bias — the phase plan slot count is unchanged.

  const allTags = ["lower_back", "knees", "wrists", "neck", "hips", "shoulders", "ankles", "hamstrings"];

  // Normal energy + mood + any injury → arc stays "B"
  for (const tag of allTags) {
    const s = session(poseMeta, { energy: 3, mood: 3, injuryTags: [tag] });
    if (s.arcProfile !== "B") {
      errors.push(
        `[restore-bias] energy=3, mood=3, injury="${tag}": ` +
        `arcProfile should be "B" (injury must not trigger restore bias), got "${s.arcProfile}"`
      );
    }
  }

  // Low energy + injury → "D"  (energy is the driver, injury is along for the ride)
  const sLowE = session(poseMeta, { energy: 2, mood: 3, injuryTags: ["lower_back"] });
  if (sLowE.arcProfile !== "D") {
    errors.push(`[restore-bias] energy=2, mood=3, lower_back: expected arcProfile "D", got "${sLowE.arcProfile}"`);
  }

  // Low mood + injury → "D"  (mood is the driver)
  const sLowM = session(poseMeta, { energy: 3, mood: 2, injuryTags: ["hips"] });
  if (sLowM.arcProfile !== "D") {
    errors.push(`[restore-bias] energy=3, mood=2, hips: expected arcProfile "D", got "${sLowM.arcProfile}"`);
  }

  // Low energy + low mood + structural injury → "D"  (all three suppressing together)
  const sAll = session(poseMeta, { energy: 1, mood: 1, injuryTags: ["knees"] });
  if (sAll.arcProfile !== "D") {
    errors.push(`[restore-bias] energy=1, mood=1, knees: expected arcProfile "D", got "${sAll.arcProfile}"`);
  }

  results.push({
    test: "3. Restore bias: triggered by energy≤2 or mood≤2 only — injury alone does not trigger it",
    allInjuries_normalEnergyMood_arcProfile: "B (confirmed for all 8 injury types)",
    lowEnergy_injury_arcProfile: sLowE.arcProfile,
    lowMood_injury_arcProfile:   sLowM.arcProfile,
    allSuppressed_arcProfile:    sAll.arcProfile,
    note: "injuries may reduce actual upright pose count via pool depletion — that is distinct from restore bias",
  });
}

// ——————————————————————————————
// TEST 4 — energy intensity filter + injury pose filter apply simultaneously
// ——————————————————————————————

function testDualPoolFiltering(errors, results, poseMeta, poseArr) {
  // Use energy=2 (activates intensity≥4 filter) + soft-tissue injury (filters contraindicated poses)
  // Soft-tissue chosen so maxBand=2 doesn't remove all interesting poses.
  // With progressScore=0.65, energy=2, injury=["hamstrings"]:
  //   eff = 0.65 - 0.08 - 0.07 = 0.50 → maxBand=2; safetyBias cap=2 → maxBand=2

  const injuryTag = "hamstrings";
  const { blocked } = filterContraindicated(poseArr, [injuryTag]);
  const blockedIds = new Set(blocked.map((p) => String(p?.id ?? p?.poseId ?? "")));

  const REPS = 15;

  for (let i = 0; i < REPS; i++) {
    const s = session(poseMeta, {
      energy: 2,
      mood: 3,
      injuryTags: [injuryTag],
      progressScore: 0.65,
      emphasisKey: ["full_body", "hips", "spine", "core_balance"][i % 4],
    });

    // Working poses only (skip easy_seat anchor + corpse anchor)
    const working = s.steps.slice(1, -1);

    for (const step of working) {
      // Energy filter: no intensity-4 poses
      if (getIntensity(step) >= 4) {
        errors.push(
          `[dual-filter] session ${i}: "${step.poseId}" has intensity ${getIntensity(step)} ` +
          `(energy=2 should block intensity≥4)`
        );
      }
      // Injury filter: no contraindicated poses
      if (blockedIds.has(step.poseId)) {
        errors.push(
          `[dual-filter] session ${i}: "${step.poseId}" is contraindicated for ${injuryTag} ` +
          `but appeared in session`
        );
      }
    }
  }

  results.push({
    test: "4. Energy intensity filter (energy≤2) and injury pose filter apply simultaneously",
    injuryUsed: injuryTag,
    blockedByInjury: blockedIds.size,
    sessionsChecked: REPS,
  });
}

// ——————————————————————————————
// TEST 5 — minimum constraint session
// ——————————————————————————————

function testMinimumConstraintSession(errors, results, poseMeta) {
  // energy=1, mood=1, structural injury = hardest possible constraints:
  //   - eff clamped to 0.12 (minimum floor)
  //   - maxBand=1 (structural injury cap)
  //   - restore bias active (energy≤2 AND mood≤2)
  //   - intensity≥4 filter active (energy=1)
  //   - significant portion of pose pool filtered by injury

  const structuralTags = ["lower_back", "knees", "wrists", "neck"];
  const REPS = 8;

  for (const tag of structuralTags) {
    for (let i = 0; i < REPS; i++) {
      const stage = i < 4 ? "foundation" : "build";
      const s = session(poseMeta, {
        energy: 1,
        mood: 1,
        injuryTags: [tag],
        stage,
        progressScore: 0.20,
      });

      if (s.steps.length !== POSE_COUNT) {
        errors.push(
          `[min-constraint] energy=1, mood=1, injury=${tag}, stage=${stage}: ` +
          `expected ${POSE_COUNT} poses, got ${s.steps.length}`
        );
      }

      const ids = s.steps.map((st) => st.poseId);
      const dupes = ids.filter((id, idx) => ids.indexOf(id) !== idx);
      if (dupes.length) {
        errors.push(
          `[min-constraint] energy=1, mood=1, injury=${tag}, session ${i}: ` +
          `duplicate poses: ${[...new Set(dupes)].join(", ")}`
        );
      }

      if (s.effectiveDifficulty < 0.12 - 0.001) {
        errors.push(
          `[min-constraint] eff=${s.effectiveDifficulty} below minimum floor 0.12`
        );
      }
    }
  }

  results.push({
    test: "5. Minimum constraints (energy=1, mood=1, structural injury) still produce 13 valid poses",
    sessionsChecked: structuralTags.length * REPS,
  });
}

// ——————————————————————————————
// TEST 6 — full combination grid
// ——————————————————————————————

function testCombinationGrid(errors, results, poseMeta) {
  // Spot-check a representative grid of (energy, mood, injuryTags) combinations.
  // Every session must produce exactly POSE_COUNT poses with no duplicates.

  const injuryScenarios = [
    [],
    ["lower_back"],
    ["hips"],
    ["wrists", "ankles"],
    ["knees", "shoulders"],
  ];

  const combinations = [
    { energy: 1, mood: 1 },
    { energy: 1, mood: 5 },
    { energy: 5, mood: 1 },
    { energy: 5, mood: 5 },
    { energy: 2, mood: 3 },
    { energy: 3, mood: 2 },
    { energy: 4, mood: 4 },
    { energy: 3, mood: 3 },
  ];

  let totalChecked = 0;

  for (const { energy, mood } of combinations) {
    for (const injuryTags of injuryScenarios) {
      for (const stage of ["foundation", "build"]) {
        const s = session(poseMeta, { energy, mood, injuryTags, stage, progressScore: PROGRESS_SCORE });

        if (s.steps.length !== POSE_COUNT) {
          errors.push(
            `[grid] energy=${energy}, mood=${mood}, injury=${JSON.stringify(injuryTags)}, ` +
            `stage=${stage}: expected ${POSE_COUNT} poses, got ${s.steps.length}`
          );
        }

        const ids = s.steps.map((st) => st.poseId);
        const dupes = ids.filter((id, idx) => ids.indexOf(id) !== idx);
        if (dupes.length) {
          errors.push(
            `[grid] energy=${energy}, mood=${mood}, injury=${JSON.stringify(injuryTags)}, ` +
            `stage=${stage}: duplicates: ${[...new Set(dupes)].join(", ")}`
          );
        }

        totalChecked++;
      }
    }
  }

  results.push({
    test: "6. Full combination grid — 8 energy/mood pairs × 5 injury scenarios × 2 stages all produce valid sessions",
    sessionsChecked: totalChecked,
  });
}

// ——————————————————————————————
// MAIN
// ——————————————————————————————

async function main() {
  const metaRaw = await loadJSON("./data/pose_meta.json");
  const poseMeta = normalizePoseMeta(metaRaw);
  const poseArr = Array.isArray(poseMeta) ? poseMeta : Object.values(poseMeta);

  const errors  = [];
  const results = [];

  testAdditiveFormula(errors, results);
  testInjuryCapOverridesEnergyBoost(errors, results, poseMeta);
  testRestoreBiasNotTriggeredByInjury(errors, results, poseMeta);
  testDualPoolFiltering(errors, results, poseMeta, poseArr);
  testMinimumConstraintSession(errors, results, poseMeta);
  testCombinationGrid(errors, results, poseMeta);

  const output = {
    testedAt: new Date().toISOString(),
    parameter: "mood × energy × injuryTags",
    errors,
    results,
  };

  fs.writeFileSync(
    path.join(__dirname, "engine-test-combined-params.json"),
    JSON.stringify(output, null, 2)
  );

  console.log("\nCOMBINED PARAMETER TESTS (mood × energy × injuryTags)");
  console.log("======================================================");
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

  console.log("\n✅ All combined parameter tests passed.");
}

function labelOf(testTitle) {
  const map = {
    "1. Effective difficulty: energy (+0.08/step) + mood (+0.04/step) + injury (−0.07 flat) are additive": "additive",
    "2. Injury band cap always overrides energy's maxBand boost (injury wins last)": "cap-override",
    "3. Restore bias: triggered by energy≤2 or mood≤2 only — injury alone has no effect": "restore-bias",
    "4. Energy intensity filter (energy≤2) and injury pose filter apply simultaneously": "dual-filter",
    "5. Minimum constraints (energy=1, mood=1, structural injury) still produce 13 valid poses": "min-constraint",
    "6. Full combination grid — 8 energy/mood pairs × 5 injury scenarios × 2 stages all produce valid sessions": "grid",
  };
  return map[testTitle] ?? testTitle;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
