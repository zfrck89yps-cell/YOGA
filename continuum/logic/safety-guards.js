// logic/safety-guards.js
// v2 safety helpers used by flow-engine.js

const toSet = (arr) => new Set((arr || []).map((x) => String(x).trim().toLowerCase()));

function getId(p) {
  return String(p?.id ?? p?.poseId ?? "").toLowerCase();
}

function getPatterns(p) {
  return (p?.patterns || []).map((x) => String(x).toLowerCase());
}

function hasAny(list, tagsSet) {
  for (const x of (list || [])) {
    if (tagsSet.has(String(x).trim().toLowerCase())) return true;
  }
  return false;
}

export function normalizeInjuryTags(tags = []) {
  return Array.from(toSet(tags));
}

function blocksForLowerBack(p) {
  const id = getId(p);
  const patterns = getPatterns(p);
  const spine = String(p?.biomech?.spine || "").toLowerCase();

  return (
    spine === "extension" ||
    patterns.includes("backbend") ||
    patterns.includes("deep_backbend") ||
    patterns.includes("twist") ||
    patterns.includes("rotation") ||
    id.includes("cobra") ||
    id.includes("locust") ||
    id.includes("wheel") ||
    id.includes("bridge")
  );
}

function blocksForKnees(p) {
  const id = getId(p);
  const patterns = getPatterns(p);

  return (
    patterns.includes("kneel") ||
    patterns.includes("tabletop") ||
    patterns.includes("all_fours") ||
    id.includes("lunge") ||
    id.includes("hero") ||
    id.includes("camel")
  );
}

function blocksForWrists(p) {
  const id = getId(p);
  const patterns = getPatterns(p);

  return (
    patterns.includes("plank") ||
    patterns.includes("table") ||
    patterns.includes("tabletop") ||
    patterns.includes("all_fours") ||
    patterns.includes("beast") ||
    patterns.includes("vinyasa") ||
    id.includes("plank") ||
    id.includes("table") ||
    id.includes("cat_cow") ||
    id.includes("puppy_pose")
  );
}

/**
 * Return {allowed, blocked} so flow-engine can debug/print blocked.
 * Convention: pose.contra is an array of tags (wrists/knees/lower_back etc)
 */
export function filterContraindicated(poses = [], injuryTags = []) {
  const tags = toSet(injuryTags);
  if (!tags.size) return { allowed: poses, blocked: [] };

  const allowed = [];
  const blocked = [];

  for (const p of poses) {
    const explicitContra = hasAny(p?.contra, tags);

    const lowerBackBlock =
      (tags.has("lower_back") || tags.has("low_back")) && blocksForLowerBack(p);

    const kneeBlock =
      (tags.has("knees") || tags.has("knee")) && blocksForKnees(p);

    const wristBlock =
      (tags.has("wrists") || tags.has("wrist")) && blocksForWrists(p);

    if (explicitContra || lowerBackBlock || kneeBlock || wristBlock) {
      blocked.push(p);
    } else {
      allowed.push(p);
    }
  }

  return { allowed, blocked };
}

/**
 * This is the function flow-engine imports as getSafetyBias()
 */
export function getSafetyBias(injuryTags = []) {
  const tags = toSet(injuryTags);

  const bias = {
    difficultyBandMaxOverride: null,
  };

  if (tags.has("lower_back") || tags.has("low_back")) {
    bias.difficultyBandMaxOverride = 1;
  }

  if (tags.has("knees") || tags.has("knee")) {
    bias.difficultyBandMaxOverride = Math.min(bias.difficultyBandMaxOverride ?? 99, 1);
  }

  if (tags.has("wrists") || tags.has("wrist")) {
    bias.difficultyBandMaxOverride = Math.min(bias.difficultyBandMaxOverride ?? 99, 1);
  }

  return bias;
}