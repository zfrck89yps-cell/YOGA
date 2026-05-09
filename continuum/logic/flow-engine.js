// logic/flow-engine.js
// Continuum grid-session engine — v2 with strict sequencing rules.
// Generates a fixed-size, logically ordered yoga session for free-paced grid display.
// Fixed-card sessions. Left/right work is shown as a note, not duplicate cards.

import {
filterContraindicated,
getSafetyBias,
normalizeInjuryTags,
} from “./safety-guards.js”;

import {
loadProgress,
computeSessionDifficulty,
maxBandFromEffectiveDifficulty,
} from “./progression-engine.js”;

const START_POSE_ID = “easy_seat”;
const END_POSE_ID = “corpse”;
const DEFAULT_POSE_COUNT = 13;

// —————————————————————————
// SEQUENCING RULE TABLES
// —————————————————————————

// Poses that may ONLY appear directly after one of their listed predecessors.
// If none of these predecessors are in the session, the pose is excluded.
const REQUIRED_PREDECESSORS = {
wild_thing:      [“downward_dog”, “three_legged_dog”, “side_plank”],
hover:           [“plank”],
three_legged_dog:[“downward_dog”],
lizard:          [“runners_lunge”, “low_lunge”, “downward_dog”],
half_pigeon:     [“downward_dog”, “three_legged_dog”, “low_lunge”, “lizard”],
bird_dog:        [“table_top”, “cat_cow”],
};

// After these poses, the listed pose MUST follow immediately (mandatory counter or pair).
const REQUIRED_SUCCESSORS = {
camel:           “childs_pose”,   // backbend → must be countered
three_legged_dog:“low_lunge”,     // step the lifted leg forward
};

// Forbidden direct transitions: [from_posture, to_posture].
// The posture values match biomech.posture in pose_meta.json.
const FORBIDDEN_POSTURE_TRANSITIONS = new Set([
“upright>supine”,
“upright>restore”,
“supine>upright”,
“restore>upright”,
“prone>upright”,
“upright>prone”,
]);

// —————————————————————————
// HELPERS
// —————————————————————————

function toNum(n, fallback = 0) {
const x = Number(n);
return Number.isFinite(x) ? x : fallback;
}

function clamp(n, lo, hi) {
return Math.max(lo, Math.min(hi, n));
}

function pickRandom(arr) {
return arr[Math.floor(Math.random() * arr.length)];
}

function getId(p) {
if (!p) return “”;
return String(p.id ?? p.poseId ?? p.pose_id ?? “”);
}

function asPoseArray(poseMeta) {
if (!poseMeta) return [];
if (Array.isArray(poseMeta)) return poseMeta;
if (Array.isArray(poseMeta.poses)) return poseMeta.poses;
if (Array.isArray(poseMeta.items)) return poseMeta.items;
return Object.values(poseMeta);
}

function patternsOf(p) {
return (p?.patterns || []).map((x) => String(x).toLowerCase());
}

function regionsOf(p) {
return (p?.regions || []).map((x) => String(x).toLowerCase());
}

function hasPattern(p, pat) {
return patternsOf(p).includes(pat);
}

function hasRegion(p, region) {
return regionsOf(p).includes(region);
}

function derivePosture(p) {
// Prefer explicit biomech data (set in pose_meta.json)
if (p?.biomech?.posture) return p.biomech.posture;

const id = getId(p).toLowerCase();
const pats = patternsOf(p);

if (id === END_POSE_ID) return “restore”;
if (pats.includes(“supine”)) return “supine”;
if (pats.includes(“prone”)) return “prone”;
if (pats.includes(“seated”)) return “seated”;
if (pats.includes(“tabletop”) || pats.includes(“kneel”) || pats.includes(“all_fours”)) return “grounded”;
if (pats.includes(“standing”) || pats.includes(“upright”) || pats.includes(“lunge”)) return “upright”;

if (id.includes(“warrior”) || id.includes(“lunge”) || id === “chair” || id === “mountain” || id.includes(“triangle”)) return “upright”;
if (id.includes(“plank”) || id.includes(“hover”) || id === “cat_cow” || id === “table_top” || id === “puppy_pose” || id === “childs_pose” || id === “downward_dog”) return “grounded”;
if (id.includes(“seated”) || id === “staff_pose” || id === “bound_angle” || id === “half_pigeon” || id === “cow_face”) return “seated”;
if (id.includes(“supine”) || id === “happy_baby” || id === “bridge”) return “supine”;
if ([“sphinx”, “cobra”, “locust”].includes(id)) return “prone”;

return “grounded”;
}

function deriveIntensity(p) {
if (p?.biomech?.intensity) return clamp(toNum(p.biomech.intensity, 2), 1, 5);
const band = toNum(p?.difficultyBand, 1);
if (getId(p) === START_POSE_ID || getId(p) === END_POSE_ID) return 1;
return clamp(band + 1, 1, 5);
}

function deriveSpine(p) {
return p?.biomech?.spine || “neutral”;
}

function isRealPose(p) {
const id = getId(p);
if (!id) return false;
if (toNum(p?.difficultyBand, 1) === 0) return false;
if (patternsOf(p).includes(“transition”)) return false;
return true;
}

function isUnilateralPose(p) {
const id = getId(p).toLowerCase();
const pats = patternsOf(p);
if (pats.includes(“bilateral”)) return false;
if (id === START_POSE_ID || id === END_POSE_ID) return false;
return (
pats.includes(“unilateral”) ||
pats.includes(“single_side”) ||
pats.includes(“lunge”) ||
pats.includes(“balance”) ||
id.includes(“warrior”) ||
id.includes(“lunge”) ||
id.includes(“triangle”) ||
id.includes(“side_angle”) ||
id.includes(“pigeon”) ||
id.includes(“dancer”) ||
id.includes(“tree”) ||
id.includes(“three_legged”) ||
id.includes(“gate”) ||
id.includes(“side_bend”) ||
id.includes(“twist”) ||
id.includes(“bird_dog”) ||
id.includes(“side_plank”)
);
}

// —————————————————————————
// SEQUENCING RULE VALIDATORS
// —————————————————————————

/**

- Returns true if transitioning directly from prevPosture → nextPosture is forbidden.
  */
  function isForbiddenPostureTransition(prevPosture, nextPosture) {
  return FORBIDDEN_POSTURE_TRANSITIONS.has(`${prevPosture}>${nextPosture}`);
  }

/**

- Returns true if pose p can legally follow prevPose given the sequencing rules.
- Checks:
- 1. No forbidden posture jumps (e.g. upright → supine)
- 1. Required predecessors for restricted poses
   */
   function canFollow(p, prevPose, sessionSoFar) {
   if (!prevPose) return true;

const id = getId(p);
const prevPosture = derivePosture(prevPose);
const nextPosture = derivePosture(p);

// Rule 1: forbidden posture transitions
if (isForbiddenPostureTransition(prevPosture, nextPosture)) return false;

// Rule 2: restricted predecessor poses
const requiredPreds = REQUIRED_PREDECESSORS[id];
if (requiredPreds) {
const prevId = getId(prevPose);
if (!requiredPreds.includes(prevId)) return false;
}

return true;
}

/**

- After placing pose p, check if a mandatory successor must follow.
- Returns the mandatory successor pose ID or null.
  */
  function getMandatorySuccessor(p) {
  return REQUIRED_SUCCESSORS[getId(p)] || null;
  }

/**

- Filters a pool to only poses that can legally follow prevPose.
  */
  function filterLegalFollowers(pool, prevPose, sessionSoFar) {
  return pool.filter((p) => canFollow(p, prevPose, sessionSoFar));
  }

// —————————————————————————
// EMPHASIS BIAS
// —————————————————————————

function getEmphasisBias(emphasisKey, pose) {
const key = String(emphasisKey || “”).toLowerCase();
if (!key || key === “full_body”) return 0;

let score = 0;
switch (key) {
case “hips”:
if (hasRegion(pose, “hips”)) score -= 6;
if (hasPattern(pose, “hip_opener”) || hasPattern(pose, “hip_opening”)) score -= 3;
break;
case “spine”:
if (hasRegion(pose, “spine”)) score -= 6;
if (hasPattern(pose, “twist”) || hasPattern(pose, “spine_mobility”) || hasPattern(pose, “side_bend”)) score -= 2;
break;
case “shoulders_upper_back”:
if (hasRegion(pose, “shoulders_upper_back”) || hasRegion(pose, “shoulders”) || hasRegion(pose, “upper_back”)) score -= 6;
if (hasPattern(pose, “shoulder_opener”)) score -= 3;
break;
case “posterior_chain”:
if (hasRegion(pose, “posterior_chain”)) score -= 6;
if (hasPattern(pose, “hinge”) || hasPattern(pose, “forward_fold”) || hasPattern(pose, “posterior_chain”)) score -= 2;
break;
case “quads_legs”:
if (hasRegion(pose, “quads_legs”)) score -= 6;
if (hasPattern(pose, “standing”) || hasPattern(pose, “squat”) || hasPattern(pose, “lunge”)) score -= 2;
break;
case “core_balance”:
if (hasRegion(pose, “core_balance”)) score -= 6;
if (hasPattern(pose, “core”) || hasPattern(pose, “balance”) || hasPattern(pose, “plank”)) score -= 3;
break;
case “restore_full_body”:
if (hasRegion(pose, “restore_full_body”)) score -= 5;
if (hasPattern(pose, “rest”) || hasPattern(pose, “supine”) || hasPattern(pose, “seated”)) score -= 2;
break;
default:
break;
}
return score;
}

// —————————————————————————
// PHASE SCORING
// —————————————————————————

function phaseScore(p, ctx) {
const id = getId(p);
const post = derivePosture(p);
const intensity = deriveIntensity(p);

let score = 0;
if (!ctx.allowedPostures.includes(post)) score += 50;
if (intensity > ctx.maxIntensity) score += 35 + intensity;
if (ctx.usedSet.has(id)) score += 500;
if (ctx.recentSet.has(id)) score += 7;
score += Math.max(0, intensity - ctx.targetIntensity) * 2;
score += getEmphasisBias(ctx.emphasisKey, p) * 1.5;
score += Math.random() * 1.0;

// Penalise if it can’t legally follow the last placed pose
if (ctx.lastPose && !canFollow(p, ctx.lastPose, ctx.sessionSoFar)) score += 200;

return score;
}

function pickForPhase(pool, ctx) {
const candidates = pool
.filter((p) => !ctx.usedSet.has(getId(p)))
.filter((p) => ctx.allowedPostures.includes(derivePosture(p)))
.filter((p) => deriveIntensity(p) <= ctx.maxIntensity)
.filter((p) => !ctx.lastPose || canFollow(p, ctx.lastPose, ctx.sessionSoFar));

if (!candidates.length) return null;
const scored = candidates
.map((p) => ({ p, score: phaseScore(p, ctx) }))
.sort((a, b) => a.score - b.score);
return pickRandom(scored.slice(0, Math.min(3, scored.length))).p;
}

// —————————————————————————
// PHASE PLAN BUILDER
// —————————————————————————

function buildPhasePlan({ stage, emphasisKey, energy, mood, maxBand, targetPoseCount }) {
const buildSlots = Math.max(0, targetPoseCount - 2); // start + corpse reserved
const lowerEnergy = Number(energy) <= 2 || Number(mood) <= 2;
const foundation = stage === “foundation”;
const restoreBias = emphasisKey === “restore_full_body” || lowerEnergy;

const buildMax = restoreBias ? Math.min(2, maxBand + 1) : Math.min(4, maxBand + 1);

// Ordered arc: seated/grounded warmup → upright peak → grounded downshift → supine/restore.
// This enforces the legal posture arc: seated→grounded→upright→grounded→seated→supine→restore.
const base = [
{ name: “arrival”,      count: 1, postures: [“seated”],                    maxI: 2,        targetI: 1 },
{ name: “warmup”,       count: 2, postures: [“seated”, “grounded”],        maxI: 2,        targetI: 2 },
{ name: “groundedBuild”,count: 2, postures: [“grounded”],                  maxI: buildMax, targetI: 2 },
{ name: “uprightBuild”, count: foundation || restoreBias ? 2 : 3,
postures: [“upright”],                   maxI: buildMax, targetI: 3 },
{ name: “downshift”,    count: foundation || restoreBias ? 2 : 1,
postures: [“grounded”, “seated”],        maxI: 3,        targetI: 2 },
{ name: “integration”,  count: 2, postures: [“seated”, “supine”],          maxI: 2,        targetI: 1 },
];

let total = base.reduce((sum, p) => sum + p.count, 0);
while (total < buildSlots) { base[3].count += 1; total += 1; }
while (total > buildSlots) {
const reducible = […base].reverse().find((p) => p.count > 1 && p.name !== “integration”) || base[0];
reducible.count -= 1;
total -= 1;
}

return base;
}

// —————————————————————————
// STEP MAPPER
// —————————————————————————

function mapStep(p, arcProfile) {
const id = getId(p);
return {
poseId: id,
bothSides: isUnilateralPose(p),
meta: {
regions: p?.regions ?? [],
patterns: p?.patterns ?? [],
difficultyBand: toNum(p?.difficultyBand, 1),
biomech: p?.biomech ?? null,
derived: {
posture: derivePosture(p),
intensity: deriveIntensity(p),
spine: deriveSpine(p),
},
arcProfile,
},
};
}

function chooseArcProfile({ mood, energy, emphasisKey }) {
if (emphasisKey === “restore_full_body” || Number(energy) <= 2 || Number(mood) <= 2) return “D”;
if (Number(energy) >= 4 && Number(mood) >= 3) return “A”;
return “B”;
}

// —————————————————————————
// MAIN SESSION BUILDER
// —————————————————————————

export function buildSession({
poseMeta,
emphasisKey = “full_body”,
stage = “foundation”,
mood = 3,
energy = 3,
injuryTags = [],
recentPoseIds = [],
progressScore = null,
targetPoseCount = DEFAULT_POSE_COUNT,
} = {}) {
const poseArr = asPoseArray(poseMeta).filter(isRealPose);
const tags = normalizeInjuryTags(injuryTags);
const safetyBias = getSafetyBias(tags);
const safetyResult = filterContraindicated(poseArr, tags) || {};
const allowed = Array.isArray(safetyResult.allowed) ? safetyResult.allowed.filter(isRealPose) : poseArr;
const blocked = Array.isArray(safetyResult.blocked) ? safetyResult.blocked : [];

const progress = loadProgress();
const eff = computeSessionDifficulty({
progressScore: progressScore ?? progress.score,
stage,
mood,
energy,
injuryTags: tags,
});

let maxBand = maxBandFromEffectiveDifficulty(eff);
maxBand = Math.max(1, maxBand);
if (stage !== “foundation” && Number(energy) >= 4) maxBand = Math.min(3, maxBand + 1);
if (safetyBias?.difficultyBandMaxOverride != null) maxBand = Math.min(maxBand, safetyBias.difficultyBandMaxOverride);

const startPose = allowed.find((p) => getId(p) === START_POSE_ID) || poseArr.find((p) => getId(p) === START_POSE_ID) || null;
const endPose   = allowed.find((p) => getId(p) === END_POSE_ID)   || poseArr.find((p) => getId(p) === END_POSE_ID)   || null;

const usablePool = allowed
.filter((p) => getId(p) !== START_POSE_ID && getId(p) !== END_POSE_ID)
.filter((p) => toNum(p?.difficultyBand, 1) <= maxBand)
.filter((p) => !(Number(energy) <= 2 && deriveIntensity(p) >= 4));

const target = Math.max(5, Number(targetPoseCount) || DEFAULT_POSE_COUNT);
const usedSet  = new Set();
const recentSet = new Set((recentPoseIds || []).slice(-30));
const arcProfile = chooseArcProfile({ mood, energy, emphasisKey });
const selected = [];

// — Opening: always easy_seat —
if (startPose) {
selected.push(startPose);
usedSet.add(getId(startPose));
}

const phasePlan = buildPhasePlan({ stage, emphasisKey, energy, mood, maxBand, targetPoseCount: target });

for (const phase of phasePlan) {
for (let i = 0; i < phase.count; i++) {
const lastPose = selected[selected.length - 1] || null;

```
  const picked = pickForPhase(usablePool, {
    usedSet,
    recentSet,
    allowedPostures: phase.postures,
    maxIntensity: phase.maxI,
    targetIntensity: phase.targetI,
    emphasisKey: stage === "foundation" ? "full_body" : emphasisKey,
    lastPose,
    sessionSoFar: selected,
  });

  if (!picked) continue;
  selected.push(picked);
  usedSet.add(getId(picked));

  // Insert mandatory successor immediately if required (e.g. camel → childs_pose)
  const successorId = getMandatorySuccessor(picked);
  if (successorId && !usedSet.has(successorId)) {
    const successorPose = usablePool.find((p) => getId(p) === successorId)
      || poseArr.find((p) => getId(p) === successorId);
    if (successorPose) {
      selected.push(successorPose);
      usedSet.add(successorId);
    }
  }
}
```

}

// — Backfill if injury/rule filtering left us short —
while (selected.length < target - (endPose ? 1 : 0)) {
const lastPose = selected[selected.length - 1] || null;

```
let fallback = usablePool
  .filter((p) => !usedSet.has(getId(p)))
  .filter((p) => !lastPose || canFollow(p, lastPose, selected))
  .sort((a, b) => Math.abs(deriveIntensity(a) - 2) - Math.abs(deriveIntensity(b) - 2))[0];

if (!fallback) {
  fallback = allowed
    .filter((p) => getId(p) !== START_POSE_ID && getId(p) !== END_POSE_ID)
    .filter((p) => !usedSet.has(getId(p)))
    .filter((p) => !(Number(energy) <= 2 && deriveIntensity(p) >= 4))
    .filter((p) => !lastPose || canFollow(p, lastPose, selected))
    .sort((a, b) => Math.abs(deriveIntensity(a) - 2) - Math.abs(deriveIntensity(b) - 2))[0];
}

if (!fallback) break;
selected.push(fallback);
usedSet.add(getId(fallback));
```

}

// — Closing: always corpse —
if (endPose) selected.push(endPose);

// — Trim to exact target while preserving start/end and legal transitions —
let final = selected.filter(Boolean);

while (final.length > target) {
let removeIdx = -1;

```
for (let i = 1; i < final.length - 1; i++) {
  const curr = final[i];
  if (getEmphasisBias(emphasisKey, curr) >= 0) {
    // Check removing this pose doesn't create a forbidden jump
    const prevPosture = derivePosture(final[i - 1]);
    const nextPosture = derivePosture(final[i + 1]);
    if (!isForbiddenPostureTransition(prevPosture, nextPosture)) {
      // Also check no required predecessor is broken
      const nextPose = final[i + 1];
      const nextId = getId(nextPose);
      const nextReqs = REQUIRED_PREDECESSORS[nextId];
      if (!nextReqs || nextReqs.includes(getId(final[i - 1]))) {
        removeIdx = i;
        break;
      }
    }
  }
}

if (removeIdx === -1) removeIdx = final.length - 2;
final.splice(removeIdx, 1);
```

}

return {
emphasisKey,
stage,
mood,
energy,
injuryTags: tags,
progressScore: progress.score,
effectiveDifficulty: eff,
maxBand,
arcProfile,
blocked,
poseCount: final.length,
steps: final.map((p) => mapStep(p, arcProfile)),
baseSteps: final.map((p) => mapStep(p, arcProfile)),
};
}
