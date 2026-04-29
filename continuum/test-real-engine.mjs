import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { loadJSON, normalizePoseMeta, buildAssetResolver } from "./utils/assets.js";
import { buildSession } from "./logic/flow-engine.js";
import { getTodaysEmphasis } from "./logic/decision-engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXED_POSE_COUNT = 13;
const TEST_SESSIONS = 140;

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

const injuryScenarios = [
  [],
  ["wrists"],
  ["lower_back"],
  ["knees"],
  ["hips"],
  ["shoulders"],
  ["neck"],
  ["ankles"],
  ["hamstrings"],
];

function isoFromIndex(i) {
  const d = new Date(Date.UTC(2026, 0, 1 + i));
  return d.toISOString().slice(0, 10);
}

function getStage(completedSessions) {
  return completedSessions < 28 ? "foundation" : "build";
}

function getEmphasis(stage, isoDate) {
  return stage === "foundation"
    ? "full_body"
    : getTodaysEmphasis({ isoDate, stage });
}

function hasForbiddenFields(value, pathName = "") {
  const forbidden = new Set([
    "audio",
    "cueKey",
    "holdSeconds",
    "duration",
    "timer",
    "seconds",
  ]);

  if (!value || typeof value !== "object") return [];

  let found = [];

  for (const [key, child] of Object.entries(value)) {
    const nextPath = pathName ? `${pathName}.${key}` : key;

    if (forbidden.has(key)) {
      found.push(nextPath);
    }

    found = found.concat(hasForbiddenFields(child, nextPath));
  }

  return found;
}

function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function getDifficulty(step) {
  return Number(step?.meta?.difficultyBand ?? step?.difficultyBand ?? 0);
}

function getContra(step) {
  return step?.meta?.contra || step?.contra || [];
}

function getPatterns(step) {
  return step?.meta?.patterns || step?.patterns || [];
}

function getRegions(step) {
  return step?.meta?.regions || step?.regions || [];
}

function classifyPosture(step) {
  const patterns = getPatterns(step).map(String);

  if (patterns.includes("supine") || patterns.includes("prone")) return "floor";
  if (patterns.includes("seated")) return "seated";

  if (
    patterns.includes("tabletop") ||
    patterns.includes("kneel") ||
    patterns.includes("plank") ||
    patterns.includes("beast")
  ) {
    return "grounded";
  }

  if (
    patterns.includes("standing") ||
    patterns.includes("lunge") ||
    patterns.includes("squat") ||
    patterns.includes("balance") ||
    patterns.includes("hinge")
  ) {
    return "standing";
  }

  if (patterns.includes("transition")) return "transition";

  return "unknown";
}

function isBadJump(a, b) {
  const pair = `${a}>${b}`;

  return new Set([
    "floor>standing",
    "standing>floor",
    "floor>grounded",
    "standing>seated",
    "seated>standing",
  ]).has(pair);
}

function assertImageExists(resolver, poseId, errors, sessionNumber) {
  const img = resolver.getImagePath(poseId);

  if (!img) {
    errors.push(`Session ${sessionNumber}: missing resolver image path for ${poseId}`);
    return;
  }

  const filePath = path.join(__dirname, img);

  if (!fs.existsSync(filePath)) {
    errors.push(`Session ${sessionNumber}: image file does not exist for ${poseId}: ${img}`);
  }
}

async function main() {
  const [metaRaw, assetIndex] = await Promise.all([
    loadJSON("./data/pose_meta.json"),
    loadJSON("./data/asset_index.json"),
  ]);

  const poseMeta = normalizePoseMeta(metaRaw);
  const resolver = buildAssetResolver(assetIndex);

  const errors = [];
  const warnings = [];
  const summaries = [];

  let recentPoseIds = [];

  for (let completedSessions = 0; completedSessions < TEST_SESSIONS; completedSessions++) {
    const isoDate = isoFromIndex(completedSessions);
    const stage = getStage(completedSessions);
    const emphasisKey = getEmphasis(stage, isoDate);
    const injuryTags = injuryScenarios[completedSessions % injuryScenarios.length];

    const session = buildSession({
      poseMeta,
      emphasisKey,
      stage,
      mood: (completedSessions % 5) + 1,
      energy: ((completedSessions + 2) % 5) + 1,
      injuryTags,
      recentPoseIds,
      targetPoseCount: FIXED_POSE_COUNT,
    });

    const steps = session.steps || [];
    const poseIds = steps.map((s) => s.poseId);

    if (steps.length !== FIXED_POSE_COUNT) {
      errors.push(
        `Session ${completedSessions}: expected ${FIXED_POSE_COUNT} poses, got ${steps.length}`
      );
    }

    const duplicates = poseIds.filter((id, index) => poseIds.indexOf(id) !== index);
    if (duplicates.length) {
      warnings.push(
        `Session ${completedSessions}: duplicate poses: ${[...new Set(duplicates)].join(", ")}`
      );
    }

    if (stage === "foundation" && emphasisKey !== "full_body") {
      errors.push(
        `Session ${completedSessions}: foundation should be full_body, got ${emphasisKey}`
      );
    }

    if (stage !== "foundation" && emphasisKey === "full_body") {
      warnings.push(
        `Session ${completedSessions}: build session has full_body only, no weekly emphasis`
      );
    }

    const forbiddenFields = hasForbiddenFields(session);
    if (forbiddenFields.length) {
      errors.push(
        `Session ${completedSessions}: forbidden audio/timer/cue fields found: ${forbiddenFields.join(", ")}`
      );
    }

    for (const step of steps) {
      assertImageExists(resolver, step.poseId, errors, completedSessions);

      for (const injury of injuryTags) {
        if (getContra(step).includes(injury)) {
          errors.push(
            `Session ${completedSessions}: injury exclusion failed. ${step.poseId} includes ${injury}`
          );
        }
      }
    }

    const postures = steps.map(classifyPosture);
    for (let i = 0; i < postures.length - 1; i++) {
      if (isBadJump(postures[i], postures[i + 1])) {
        warnings.push(
          `Session ${completedSessions}: awkward flow jump ${postures[i]} → ${postures[i + 1]} between ${poseIds[i]} and ${poseIds[i + 1]}`
        );
      }
    }

    const emphasisCount = steps.filter((step) =>
      getRegions(step).includes(emphasisKey)
    ).length;

    if (stage !== "foundation" && emphasisKey !== "full_body" && emphasisCount < 2) {
      warnings.push(
        `Session ${completedSessions}: weak emphasis weighting for ${emphasisKey}, only ${emphasisCount} matching poses`
      );
    }

    summaries.push({
      sessionNumber: completedSessions,
      isoDate,
      stage,
      emphasisKey,
      emphasisLabel: EMPHASIS_LABELS[emphasisKey] || emphasisKey,
      poseCount: steps.length,
      avgDifficulty: Number(avg(steps.map(getDifficulty)).toFixed(2)),
      postures,
      poseIds,
    });

    recentPoseIds = poseIds;
  }

  const trianglePath = resolver.getImagePath("triangle");
  if (!trianglePath) {
    errors.push("triangle image path missing from asset resolver");
  } else if (!fs.existsSync(path.join(__dirname, trianglePath))) {
    errors.push(`triangle image path exists in resolver but file missing: ${trianglePath}`);
  }

  const foundation = summaries.slice(0, 28);
  const later = summaries.slice(28);

  const uniqueFoundationEmphases = [...new Set(foundation.map((s) => s.emphasisKey))];
  const uniqueBuildEmphases = [...new Set(later.map((s) => s.emphasisKey))];
  const uniquePoses = [...new Set(summaries.flatMap((s) => s.poseIds))];

  const output = {
    testedAt: new Date().toISOString(),
    sessionsTested: TEST_SESSIONS,
    errors,
    warnings,
    summary: {
      fixedPoseCount: FIXED_POSE_COUNT,
      foundationEmphases: uniqueFoundationEmphases,
      buildEmphases: uniqueBuildEmphases,
      uniquePoseCountUsed: uniquePoses.length,
      averageDifficultyFirst28: Number(avg(foundation.map((s) => s.avgDifficulty)).toFixed(2)),
      averageDifficultyLast28: Number(avg(summaries.slice(-28).map((s) => s.avgDifficulty)).toFixed(2)),
      trianglePath,
    },
    sessions: summaries,
  };

  fs.writeFileSync(
    path.join(__dirname, "engine-test-output.json"),
    JSON.stringify(output, null, 2)
  );

  console.log("\nREAL CONTINUUM ENGINE TEST");
  console.log("==========================");
  console.log(`Sessions tested: ${TEST_SESSIONS}`);
  console.log(`Errors: ${errors.length}`);
  console.log(`Warnings: ${warnings.length}`);
  console.log(`Foundation emphases: ${uniqueFoundationEmphases.join(", ")}`);
  console.log(`Build emphases: ${uniqueBuildEmphases.join(", ")}`);
  console.log(`Unique poses used: ${uniquePoses.length}`);
  console.log(`Average difficulty first 28: ${output.summary.averageDifficultyFirst28}`);
  console.log(`Average difficulty last 28:  ${output.summary.averageDifficultyLast28}`);
  console.log(`Triangle path: ${trianglePath || "MISSING"}`);
  console.log("\nDetailed output written to: continuum/engine-test-output.json");

  if (errors.length) {
    console.log("\nERRORS");
    console.log("------");
    errors.slice(0, 50).forEach((e) => console.log(`❌ ${e}`));
    if (errors.length > 50) console.log(`...and ${errors.length - 50} more`);
    process.exit(1);
  }

  if (warnings.length) {
    console.log("\nWARNINGS");
    console.log("--------");
    warnings.slice(0, 50).forEach((w) => console.log(`⚠️ ${w}`));
    if (warnings.length > 50) console.log(`...and ${warnings.length - 50} more`);
  }

  console.log("\n✅ Real engine passed hard checks.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});