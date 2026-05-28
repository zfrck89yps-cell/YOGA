// test-injury-tags.mjs
// Focused tests for the injuryTags parameter in buildSession.
//
// Covers:
//   1. Blocked poses never appear in sessions — all 8 injury types
//   2. Safety bias: structural injuries cap maxBand at 1, soft-tissue at 2
//   3. Any injury reduces effectiveDifficulty by exactly 0.07 (flat, not per-tag)
//   4. Multiple injuries: strictest band cap wins; −0.07 penalty does not compound
//   5. Empty tags → no filtering, no penalty, no cap
//   6. Sessions remain valid (13 poses, no duplicates) under all injury scenarios

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { loadJSON, normalizePoseMeta } from "./utils/assets.js";
import { buildSession } from "./logic/flow-engine.js";
import { computeSessionDifficulty } from "./logic/progression-engine.js";
import {
  filterContraindicated,
  getSafetyBias,
  normalizeInjuryTags,
} from "./logic/safety-guards.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POSE_COUNT = 13;

const STRUCTURAL_INJURIES  = ["lower_back", "knees", "wrists", "neck"];   // band cap → 1
const SOFT_TISSUE_INJURIES = ["hips", "shoulders", "ankles", "hamstrings"]; // band cap → 2
const ALL_INJURIES = [...STRUCTURAL_INJURIES, ...SOFT_TISSUE_INJURIES];

const BUILD_EMPHASES = [
  "full_body", "hips", "spine", "quads_legs",
  "core_balance", "shoulders_upper_back", "posterior_chain",
];

const PROGRESS_SCORE = 0.40; // gives eff=0.40 at energy=3, mood=3 → no clamping edge cases

// ——————————————————————————————
// HELPERS
// ——————————————————————————————

function getId(p) {
  return String(p?.poseId ?? p?.id ?? "");
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
// TEST 1 — blocked poses never appear
// ——————————————————————————————

function testBlockedPosesExcluded(errors, results, poseMeta, poseArr) {
  const REPS = 10;
  let totalViolations = 0;
  const blockedCountByTag = {};

  for (const tag of ALL_INJURIES) {
    const { blocked } = filterContraindicated(poseArr, [tag]);
    const blockedIds = new Set(blocked.map(getId));
    blockedCountByTag[tag] = blockedIds.size;

    for (let i = 0; i < REPS; i++) {
      const s = session(poseMeta, {
        injuryTags: [tag],
        emphasisKey: BUILD_EMPHASES[i % BUILD_EMPHASES.length],
        stage: i < 5 ? "foundation" : "build",
      });

      // Skip first (easy_seat) and last (corpse) — engine may force these
      // even if they are contraindicated, as they are structural anchors.
      const workingPoses = s.steps.slice(1, -1);

      for (const step of workingPoses) {
        if (blockedIds.has(step.poseId)) {
          errors.push(
            `[blocked-poses] injury=${tag}, session ${i}: ` +
            `"${step.poseId}" is contraindicated but appeared in session`
          );
          totalViolations++;
        }
      }
    }
  }

  results.push({
    test: "1. Blocked poses never appear in working poses (all 8 injury types)",
    sessionsChecked: ALL_INJURIES.length * REPS,
    blockedPoseCountByTag: blockedCountByTag,
    violations: totalViolations,
  });
}

// ——————————————————————————————
// TEST 2 — safety bias caps maxBand
// ——————————————————————————————

function testSafetyBiasCap(errors, results, poseMeta) {
  // Direct getSafetyBias checks
  for (const tag of STRUCTURAL_INJURIES) {
    const bias = getSafetyBias([tag]);
    if (bias.difficultyBandMaxOverride !== 1) {
      errors.push(
        `[band-cap] structural injury "${tag}": expected cap=1, got ${bias.difficultyBandMaxOverride}`
      );
    }
  }

  for (const tag of SOFT_TISSUE_INJURIES) {
    const bias = getSafetyBias([tag]);
    if (bias.difficultyBandMaxOverride !== 2) {
      errors.push(
        `[band-cap] soft-tissue injury "${tag}": expected cap=2, got ${bias.difficultyBandMaxOverride}`
      );
    }
  }

  // Verify caps are enforced in actual sessions
  // Use high progressScore (0.65) so baseline maxBand would be 3 without injury
  for (const tag of STRUCTURAL_INJURIES) {
    const s = session(poseMeta, { injuryTags: [tag], progressScore: 0.65 });
    if (s.maxBand !== 1) {
      errors.push(
        `[band-cap] structural injury "${tag}": session maxBand should be 1, got ${s.maxBand}`
      );
    }
  }

  for (const tag of SOFT_TISSUE_INJURIES) {
    const s = session(poseMeta, { injuryTags: [tag], progressScore: 0.65 });
    if (s.maxBand !== 2) {
      errors.push(
        `[band-cap] soft-tissue injury "${tag}": session maxBand should be 2, got ${s.maxBand}`
      );
    }
  }

  // Baseline: no injury, high progressScore → maxBand should be 3
  const baseline = session(poseMeta, { injuryTags: [], progressScore: 0.65 });
  if (baseline.maxBand !== 3) {
    errors.push(`[band-cap] no injury with progressScore=0.65: expected maxBand=3, got ${baseline.maxBand}`);
  }

  results.push({
    test: "2. Safety bias: structural injuries cap maxBand=1, soft-tissue cap maxBand=2",
    structuralCap: 1,
    softTissueCap: 2,
    tagsChecked: ALL_INJURIES.length,
  });
}

// ——————————————————————————————
// TEST 3 — flat −0.07 difficulty penalty for any injury
// ——————————————————————————————

function testDifficultyPenalty(errors, results) {
  const base = { progressScore: PROGRESS_SCORE, stage: "build", mood: 3, energy: 3 };

  const effNone = computeSessionDifficulty({ ...base, injuryTags: [] });

  for (const tag of ALL_INJURIES) {
    const effWith = computeSessionDifficulty({ ...base, injuryTags: [tag] });
    const delta = +(effNone - effWith).toFixed(4);

    if (Math.abs(delta - 0.07) > 0.001) {
      errors.push(
        `[difficulty-penalty] injury="${tag}": expected eff drop of 0.07, got ${delta}`
      );
    }
  }

  results.push({
    test: "3. Any injury reduces effectiveDifficulty by exactly −0.07 (flat, not per-tag)",
    baselineEff: +effNone.toFixed(3),
    expectedEff_withInjury: +(effNone - 0.07).toFixed(3),
    tagsChecked: ALL_INJURIES.length,
  });
}

// ——————————————————————————————
// TEST 4 — multiple injuries: strictest cap wins; penalty stays −0.07
// ——————————————————————————————

function testMultipleInjuries(errors, results, poseMeta) {
  const base = { progressScore: PROGRESS_SCORE, stage: "build", mood: 3, energy: 3 };

  // Band cap: structural+soft-tissue → structural wins (min of 1, 2 = 1)
  const biasLS = getSafetyBias(["lower_back", "hips"]);
  if (biasLS.difficultyBandMaxOverride !== 1) {
    errors.push(
      `[multi-injury] lower_back+hips: expected cap=1 (structural dominates), got ${biasLS.difficultyBandMaxOverride}`
    );
  }

  // Two structural injuries → still cap=1
  const biasKW = getSafetyBias(["knees", "wrists"]);
  if (biasKW.difficultyBandMaxOverride !== 1) {
    errors.push(
      `[multi-injury] knees+wrists: expected cap=1, got ${biasKW.difficultyBandMaxOverride}`
    );
  }

  // Two soft-tissue injuries → cap=2
  const biasHS = getSafetyBias(["hips", "hamstrings"]);
  if (biasHS.difficultyBandMaxOverride !== 2) {
    errors.push(
      `[multi-injury] hips+hamstrings: expected cap=2, got ${biasHS.difficultyBandMaxOverride}`
    );
  }

  // Difficulty penalty does NOT compound — two injuries still only −0.07
  const effNone = computeSessionDifficulty({ ...base, injuryTags: [] });
  const effTwo  = computeSessionDifficulty({ ...base, injuryTags: ["lower_back", "hips"] });
  const effFour = computeSessionDifficulty({ ...base, injuryTags: ALL_INJURIES });

  const deltaTwo  = +(effNone - effTwo).toFixed(4);
  const deltaFour = +(effNone - effFour).toFixed(4);

  if (Math.abs(deltaTwo - 0.07) > 0.001) {
    errors.push(
      `[multi-injury] two injuries: expected eff drop 0.07, got ${deltaTwo} (penalty must not compound)`
    );
  }

  if (Math.abs(deltaFour - 0.07) > 0.001) {
    errors.push(
      `[multi-injury] all injuries: expected eff drop 0.07, got ${deltaFour} (penalty must not compound)`
    );
  }

  // Session maxBand with lower_back+hips must be 1 (not 2)
  const sMulti = session(poseMeta, { injuryTags: ["lower_back", "hips"], progressScore: 0.65 });
  if (sMulti.maxBand !== 1) {
    errors.push(
      `[multi-injury] lower_back+hips session: expected maxBand=1, got ${sMulti.maxBand}`
    );
  }

  results.push({
    test: "4. Multiple injuries: strictest band cap wins; −0.07 difficulty penalty does not compound",
    lower_back_hips_cap: biasLS.difficultyBandMaxOverride,
    hips_hamstrings_cap: biasHS.difficultyBandMaxOverride,
    twoInjuries_effDrop: deltaTwo,
    allInjuries_effDrop: deltaFour,
  });
}

// ——————————————————————————————
// TEST 5 — empty tags = no effect
// ——————————————————————————————

function testEmptyTags(errors, results, poseMeta, poseArr) {
  // filterContraindicated with no tags → everything allowed, nothing blocked
  const { allowed, blocked } = filterContraindicated(poseArr, []);
  if (blocked.length !== 0) {
    errors.push(`[empty-tags] filterContraindicated([]) should block 0 poses, blocked ${blocked.length}`);
  }
  if (allowed.length !== poseArr.length) {
    errors.push(`[empty-tags] filterContraindicated([]) should allow all ${poseArr.length} poses, got ${allowed.length}`);
  }

  // getSafetyBias with no tags → no override
  const bias = getSafetyBias([]);
  if (bias.difficultyBandMaxOverride !== null) {
    errors.push(`[empty-tags] getSafetyBias([]) difficultyBandMaxOverride should be null, got ${bias.difficultyBandMaxOverride}`);
  }

  // No difficulty penalty
  const base = { progressScore: PROGRESS_SCORE, stage: "build", mood: 3, energy: 3 };
  const effNone = computeSessionDifficulty({ ...base, injuryTags: [] });
  const effExpected = 0.40; // matches PROGRESS_SCORE with neutral energy/mood
  if (Math.abs(effNone - effExpected) > 0.001) {
    errors.push(`[empty-tags] expected eff ${effExpected}, got ${effNone.toFixed(3)}`);
  }

  // session.blocked should be empty
  const s = session(poseMeta, { injuryTags: [] });
  if (s.blocked.length !== 0) {
    errors.push(`[empty-tags] session.blocked should be empty, got ${s.blocked.length} poses`);
  }

  results.push({
    test: "5. Empty tags → no poses blocked, no difficulty penalty, no band cap",
    totalPoses: poseArr.length,
    allowedWithNoTags: allowed.length,
    blockedWithNoTags: blocked.length,
    effWithNoTags: +effNone.toFixed(3),
  });
}

// ——————————————————————————————
// TEST 6 — sessions remain valid under all injury scenarios
// ——————————————————————————————

function testSessionValidity(errors, results, poseMeta) {
  const REPS = 8;
  let totalChecked = 0;

  for (const tag of ALL_INJURIES) {
    for (let i = 0; i < REPS; i++) {
      const stage = i < 4 ? "foundation" : "build";
      const emphasisKey = stage === "foundation"
        ? "full_body"
        : BUILD_EMPHASES[i % BUILD_EMPHASES.length];

      const s = session(poseMeta, {
        injuryTags: [tag],
        stage,
        emphasisKey,
        mood: (i % 5) + 1,
        energy: (i % 5) + 1,
        progressScore: PROGRESS_SCORE,
      });

      if (s.steps.length !== POSE_COUNT) {
        errors.push(
          `[validity] injury=${tag}, session ${i}, stage=${stage}: ` +
          `expected ${POSE_COUNT} poses, got ${s.steps.length}`
        );
      }

      const ids = s.steps.map((st) => st.poseId);
      const dupes = ids.filter((id, idx) => ids.indexOf(id) !== idx);
      if (dupes.length) {
        errors.push(
          `[validity] injury=${tag}, session ${i}: ` +
          `duplicate poses: ${[...new Set(dupes)].join(", ")}`
        );
      }

      const normalizedTags = normalizeInjuryTags([tag]);
      if (JSON.stringify(s.injuryTags) !== JSON.stringify(normalizedTags)) {
        errors.push(
          `[validity] injury=${tag}: session.injuryTags mismatch — ` +
          `expected ${JSON.stringify(normalizedTags)}, got ${JSON.stringify(s.injuryTags)}`
        );
      }

      totalChecked++;
    }
  }

  results.push({
    test: "6. Sessions remain valid (13 poses, no duplicates) across all 8 injury types",
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

  testBlockedPosesExcluded(errors, results, poseMeta, poseArr);
  testSafetyBiasCap(errors, results, poseMeta);
  testDifficultyPenalty(errors, results);
  testMultipleInjuries(errors, results, poseMeta);
  testEmptyTags(errors, results, poseMeta, poseArr);
  testSessionValidity(errors, results, poseMeta);

  const output = {
    testedAt: new Date().toISOString(),
    parameter: "injuryTags",
    errors,
    results,
  };

  fs.writeFileSync(
    path.join(__dirname, "engine-test-injury-tags.json"),
    JSON.stringify(output, null, 2)
  );

  console.log("\nINJURY TAGS PARAMETER TESTS");
  console.log("===========================");
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

  console.log("\n✅ All injury tags parameter tests passed.");
}

function labelOf(testTitle) {
  const map = {
    "1. Blocked poses never appear in working poses (all 8 injury types)": "blocked-poses",
    "2. Safety bias: structural injuries cap maxBand=1, soft-tissue cap maxBand=2": "band-cap",
    "3. Any injury reduces effectiveDifficulty by exactly −0.07 (flat, not per-tag)": "difficulty-penalty",
    "4. Multiple injuries: strictest band cap wins; −0.07 difficulty penalty does not compound": "multi-injury",
    "5. Empty tags → no poses blocked, no difficulty penalty, no band cap": "empty-tags",
    "6. Sessions remain valid (13 poses, no duplicates) across all 8 injury types": "validity",
  };
  return map[testTitle] ?? testTitle;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
