// test-session-structure.mjs
// Tests the internal pose structure of built sessions.
//
// Covers:
//   1. Fixed anchors — easy_seat always first, corpse always last
//   2. No forbidden posture transitions — none of the 6 banned consecutive-posture pairs appear
//   3. Required successors — camel immediately precedes childs_pose;
//                            three_legged_dog immediately precedes low_lunge
//   4. Required predecessors — restricted poses (wild_thing, hover, lizard, half_pigeon,
//                              bird_dog, three_legged_dog) always follow a valid predecessor
//   5. Step schema completeness — all required fields present with correct types on every step
//   6. bothSides accuracy — known unilateral poses are true, bilateral poses are false

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { loadJSON, normalizePoseMeta } from "./utils/assets.js";
import { buildSession } from "./logic/flow-engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POSE_COUNT = 13;

// Mirror of flow-engine.js sequencing rule tables (tested against these expected values)
const REQUIRED_PREDECESSORS = {
  wild_thing:       ["downward_dog", "three_legged_dog", "side_plank"],
  hover:            ["plank"],
  three_legged_dog: ["downward_dog"],
  lizard:           ["runners_lunge", "low_lunge", "downward_dog"],
  half_pigeon:      ["downward_dog", "three_legged_dog", "low_lunge", "lizard"],
  bird_dog:         ["table_top", "cat_cow"],
};

const REQUIRED_SUCCESSORS = {
  camel:            "childs_pose",
  three_legged_dog: "low_lunge",
};

const FORBIDDEN_POSTURE_TRANSITIONS = new Set([
  "upright>supine",
  "upright>restore",
  "supine>upright",
  "restore>upright",
  "prone>upright",
  "upright>prone",
]);

// Known bilateral poses → bothSides must be false
const KNOWN_BILATERAL = new Set([
  "mountain", "plank", "hover", "cat_cow", "table_top", "downward_dog",
  "forward_fold", "wide_leg_forward_fold", "half_way_lift",
  "chair", "mountain_climbers", "sphinx", "cobra", "locust",
  "bridge", "happy_baby", "staff_pose", "easy_seat", "corpse",
  "childs_pose", "puppy_pose", "squat", "wide_leg_squat",
]);

// Known unilateral poses → bothSides must be true
const KNOWN_UNILATERAL = new Set([
  "warrior_one", "warrior_two", "warrior_three",
  "tree", "dancer", "triangle", "extended_side_angle",
  "runners_lunge", "low_lunge", "crescent_lunge", "lizard", "side_lunge",
  "half_pigeon", "wild_thing", "bird_dog", "side_plank",
  "gate_pose", "seated_side_bend", "standing_side_bend",
  "seated_twist", "supine_twist", "reverse_warrior",
  "three_legged_dog", "supine_leg_stretch",
]);

// ——————————————————————————————
// SESSION FACTORY
// ——————————————————————————————

function makeSession(poseMeta, overrides) {
  return buildSession({
    poseMeta,
    emphasisKey: "full_body",
    stage: "build",
    mood: 3,
    energy: 3,
    injuryTags: [],
    recentPoseIds: [],
    progressScore: 0.40,
    targetPoseCount: POSE_COUNT,
    ...overrides,
  });
}

// Build a broad grid of sessions for structural checks
function buildGrid(poseMeta) {
  const sessions = [];
  const emphases = ["full_body", "spine", "hips", "quads_legs", "core_balance", "restore_full_body"];
  const stages   = ["foundation", "build"];
  const energies = [1, 3, 5];
  const moods    = [1, 3, 5];

  for (const emphasisKey of emphases) {
    for (const stage of stages) {
      for (const energy of energies) {
        for (const mood of moods) {
          sessions.push(makeSession(poseMeta, { emphasisKey, stage, energy, mood }));
        }
      }
    }
  }
  return sessions;
}

// ——————————————————————————————
// TEST 1 — fixed anchors
// ——————————————————————————————

function testFixedAnchors(errors, results, sessions) {
  let checked = 0;

  for (const s of sessions) {
    const first = s.steps[0];
    const last  = s.steps[s.steps.length - 1];

    if (first?.poseId !== "easy_seat") {
      errors.push(`[anchors] session first pose is "${first?.poseId}", expected "easy_seat"`);
    }
    if (last?.poseId !== "corpse") {
      errors.push(`[anchors] session last pose is "${last?.poseId}", expected "corpse"`);
    }
    checked++;
  }

  results.push({
    test: "1. easy_seat always first, corpse always last",
    sessionsChecked: checked,
  });
}

// ——————————————————————————————
// TEST 2 — no forbidden posture transitions
// ——————————————————————————————

function testNoForbiddenTransitions(errors, results, sessions) {
  let pairsChecked = 0;
  let violations   = 0;

  for (const s of sessions) {
    for (let i = 0; i < s.steps.length - 1; i++) {
      const from = s.steps[i].meta?.derived?.posture ?? "";
      const to   = s.steps[i + 1].meta?.derived?.posture ?? "";
      const pair = `${from}>${to}`;
      pairsChecked++;

      if (FORBIDDEN_POSTURE_TRANSITIONS.has(pair)) {
        violations++;
        errors.push(
          `[posture-transitions] forbidden transition "${pair}" between ` +
          `"${s.steps[i].poseId}" and "${s.steps[i + 1].poseId}"`
        );
      }
    }
  }

  results.push({
    test: "2. No forbidden posture transitions between any consecutive pair",
    forbiddenPairs: [...FORBIDDEN_POSTURE_TRANSITIONS],
    consecutivePairsChecked: pairsChecked,
    violations,
  });
}

// ——————————————————————————————
// TEST 3 — required successors
// ——————————————————————————————

function testRequiredSuccessors(errors, results, sessions) {
  const seen    = { camel: 0, three_legged_dog: 0 };
  const correct = { camel: 0, three_legged_dog: 0 };

  for (const s of sessions) {
    for (let i = 0; i < s.steps.length - 1; i++) {
      const id       = s.steps[i].poseId;
      const nextId   = s.steps[i + 1].poseId;
      const required = REQUIRED_SUCCESSORS[id];

      if (required) {
        seen[id] = (seen[id] || 0) + 1;
        if (nextId === required) {
          correct[id] = (correct[id] || 0) + 1;
        } else {
          errors.push(
            `[required-successors] "${id}" must be immediately followed by "${required}", ` +
            `but was followed by "${nextId}"`
          );
        }
      }
    }

    // Also catch if the trigger pose is the last working pose (successor must still appear)
    const lastWorking = s.steps[s.steps.length - 2]; // second-to-last (before corpse)
    const triggerId   = lastWorking?.poseId;
    if (REQUIRED_SUCCESSORS[triggerId]) {
      // The successor would need to be corpse or missing — flag it
      const requiredId = REQUIRED_SUCCESSORS[triggerId];
      if (s.steps[s.steps.length - 1].poseId !== requiredId) {
        errors.push(
          `[required-successors] "${triggerId}" is the last working pose but ` +
          `its required successor "${requiredId}" does not follow`
        );
      }
    }
  }

  results.push({
    test: "3. Required successors: camel → childs_pose, three_legged_dog → low_lunge (when triggered)",
    camel_appearances: seen.camel || 0,
    three_legged_dog_appearances: seen.three_legged_dog || 0,
    camel_ruleCorrect: correct.camel || 0,
    three_legged_dog_ruleCorrect: correct.three_legged_dog || 0,
  });
}

// ——————————————————————————————
// TEST 4 — required predecessors
// ——————————————————————————————

function testRequiredPredecessors(errors, results, sessions) {
  const stats = {};
  for (const id of Object.keys(REQUIRED_PREDECESSORS)) stats[id] = { seen: 0, correct: 0 };

  for (const s of sessions) {
    for (let i = 1; i < s.steps.length; i++) {
      const id    = s.steps[i].poseId;
      const prevId = s.steps[i - 1].poseId;
      const validPreds = REQUIRED_PREDECESSORS[id];

      if (validPreds) {
        stats[id].seen++;
        if (validPreds.includes(prevId)) {
          stats[id].correct++;
        } else {
          errors.push(
            `[required-predecessors] "${id}" appeared after "${prevId}" — ` +
            `must follow one of: ${validPreds.join(", ")}`
          );
        }
      }
    }
  }

  const summary = {};
  for (const [id, st] of Object.entries(stats)) {
    if (st.seen > 0) summary[id] = `seen ${st.seen}×, rule satisfied ${st.correct}×`;
  }

  results.push({
    test: "4. Required predecessors satisfied whenever a restricted pose appears",
    restrictedPoses: Object.keys(REQUIRED_PREDECESSORS),
    appearances: summary,
  });
}

// ——————————————————————————————
// TEST 5 — step schema completeness
// ——————————————————————————————

function testStepSchema(errors, results, sessions) {
  const ARC_PROFILES = new Set(["A", "B", "D"]);
  let stepsChecked = 0;

  for (const s of sessions) {
    for (const step of s.steps) {
      stepsChecked++;
      const id = step.poseId ?? "(missing)";

      if (typeof step.poseId !== "string" || step.poseId === "") {
        errors.push(`[schema] step missing poseId`);
      }
      if (typeof step.bothSides !== "boolean") {
        errors.push(`[schema] "${id}": bothSides is ${JSON.stringify(step.bothSides)}, expected boolean`);
      }
      if (!Array.isArray(step.meta?.regions)) {
        errors.push(`[schema] "${id}": meta.regions missing or not an array`);
      }
      if (!Array.isArray(step.meta?.patterns)) {
        errors.push(`[schema] "${id}": meta.patterns missing or not an array`);
      }
      if (typeof step.meta?.difficultyBand !== "number") {
        errors.push(`[schema] "${id}": meta.difficultyBand is ${JSON.stringify(step.meta?.difficultyBand)}, expected number`);
      }
      if (typeof step.meta?.derived?.posture !== "string" || step.meta.derived.posture === "") {
        errors.push(`[schema] "${id}": meta.derived.posture missing or empty`);
      }
      if (typeof step.meta?.derived?.intensity !== "number") {
        errors.push(`[schema] "${id}": meta.derived.intensity is ${JSON.stringify(step.meta?.derived?.intensity)}, expected number`);
      }
      if (typeof step.meta?.derived?.spine !== "string" || step.meta.derived.spine === "") {
        errors.push(`[schema] "${id}": meta.derived.spine missing or empty`);
      }
      if (!ARC_PROFILES.has(step.meta?.arcProfile)) {
        errors.push(`[schema] "${id}": meta.arcProfile is "${step.meta?.arcProfile}", expected A/B/D`);
      }
    }
  }

  results.push({
    test: "5. Every step has poseId, bothSides (bool), regions[], patterns[], difficultyBand, derived.posture/intensity/spine, arcProfile",
    stepsChecked,
  });
}

// ——————————————————————————————
// TEST 6 — bothSides accuracy
// ——————————————————————————————

function testBothSides(errors, results, sessions) {
  const wrongBilateral  = [];
  const wrongUnilateral = [];
  let bilateralChecked  = 0;
  let unilateralChecked = 0;

  for (const s of sessions) {
    for (const step of s.steps) {
      const id = step.poseId;

      if (KNOWN_BILATERAL.has(id)) {
        bilateralChecked++;
        if (step.bothSides !== false) {
          wrongBilateral.push(id);
          errors.push(`[both-sides] "${id}" is bilateral — bothSides should be false, got ${step.bothSides}`);
        }
      }

      if (KNOWN_UNILATERAL.has(id)) {
        unilateralChecked++;
        if (step.bothSides !== true) {
          wrongUnilateral.push(id);
          errors.push(`[both-sides] "${id}" is unilateral — bothSides should be true, got ${step.bothSides}`);
        }
      }
    }
  }

  results.push({
    test: "6. bothSides is false for known bilateral poses, true for known unilateral poses",
    bilateralChecked,
    unilateralChecked,
    wrongBilateral:  [...new Set(wrongBilateral)],
    wrongUnilateral: [...new Set(wrongUnilateral)],
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

  const sessions = buildGrid(poseMeta);

  testFixedAnchors(errors, results, sessions);
  testNoForbiddenTransitions(errors, results, sessions);
  testRequiredSuccessors(errors, results, sessions);
  testRequiredPredecessors(errors, results, sessions);
  testStepSchema(errors, results, sessions);
  testBothSides(errors, results, sessions);

  const output = {
    testedAt: new Date().toISOString(),
    suite: "session-structure",
    sessionCount: sessions.length,
    errors,
    results,
  };

  fs.writeFileSync(
    path.join(__dirname, "engine-test-session-structure.json"),
    JSON.stringify(output, null, 2)
  );

  console.log("\nSESSION POSE STRUCTURE TESTS");
  console.log("=============================");
  console.log(`Sessions built: ${sessions.length}`);
  console.log(`Tests run:      ${results.length}`);
  console.log(`Errors:         ${errors.length}`);
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

  console.log("\n✅ All session structure tests passed.");
}

function labelOf(testTitle) {
  const map = {
    "1. easy_seat always first, corpse always last": "anchors",
    "2. No forbidden posture transitions between any consecutive pair": "posture-transitions",
    "3. Required successors: camel → childs_pose, three_legged_dog → low_lunge (when triggered)": "required-successors",
    "4. Required predecessors satisfied whenever a restricted pose appears": "required-predecessors",
    "5. Every step has poseId, bothSides (bool), regions[], patterns[], difficultyBand, derived.posture/intensity/spine, arcProfile": "schema",
    "6. bothSides is false for known bilateral poses, true for known unilateral poses": "both-sides",
  };
  return map[testTitle] ?? testTitle;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
