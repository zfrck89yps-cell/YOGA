// logic/safety-guards.js
// v3 — full injury tag coverage for all 8 injury options shown in the UI.

const toSet = (arr) => new Set((arr || []).map((x) => String(x).trim().toLowerCase()));

function getId(p) {
return String(p?.id ?? p?.poseId ?? "").toLowerCase();
}

function getPatterns(p) {
return (p?.patterns || []).map((x) => String(x).toLowerCase());
}

function getRegions(p) {
return (p?.regions || []).map((x) => String(x).toLowerCase());
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

// —————————————————————————
// Per-injury block logic
// —————————————————————————

function blocksForLowerBack(p) {
const spine = String(p?.biomech?.spine || "").toLowerCase();
const patterns = getPatterns(p);
return (
spine === "extension" ||
patterns.includes("backbend") ||
patterns.includes("deep_backbend") ||
patterns.includes("twist") ||
patterns.includes("rotation") ||
["cobra", "locust", "wheel", "bridge", "camel"].some((id) => getId(p).includes(id))
);
}

function blocksForKnees(p) {
const patterns = getPatterns(p);
return (
patterns.includes("kneel") ||
patterns.includes("tabletop") ||
patterns.includes("all_fours") ||
["lunge", "hero", "camel", "squat"].some((id) => getId(p).includes(id))
);
}

function blocksForWrists(p) {
const patterns = getPatterns(p);
return (
patterns.includes("plank") ||
patterns.includes("table") ||
patterns.includes("tabletop") ||
patterns.includes("all_fours") ||
patterns.includes("beast") ||
patterns.includes("vinyasa") ||
["plank", "table", "cat_cow", "puppy_pose", "downward_dog", "hover"].some((id) => getId(p).includes(id))
);
}

function blocksForHips(p) {
const patterns = getPatterns(p);
const regions = getRegions(p);
return (
patterns.includes("hip_opener") ||
patterns.includes("lateral_lunge") ||
regions.includes("hips") ||
["pigeon", "lizard", "squat", "bound_angle", "cow_face", "wide_leg"].some((id) => getId(p).includes(id))
);
}

function blocksForShoulders(p) {
const patterns = getPatterns(p);
return (
patterns.includes("plank") ||
patterns.includes("side_plank") ||
patterns.includes("beast") ||
patterns.includes("shoulder_opener") ||
["plank", "hover", "downward_dog", "side_plank", "puppy_pose", "eagle", "cow_face"].some((id) => getId(p).includes(id))
);
}

function blocksForNeck(p) {
const spine = String(p?.biomech?.spine || "").toLowerCase();
const patterns = getPatterns(p);
return (
spine === "extension" ||
patterns.includes("inversion") ||
patterns.includes("backbend") ||
["camel", "cobra", "locust", "downward_dog", "three_legged_dog", "wild_thing"].some((id) => getId(p).includes(id))
);
}

function blocksForAnkles(p) {
const patterns = getPatterns(p);
return (
patterns.includes("lunge") ||
patterns.includes("squat") ||
patterns.includes("balance") ||
["lunge", "squat", "warrior", "chair", "tree", "dancer", "crescent"].some((id) => getId(p).includes(id))
);
}

function blocksForHamstrings(p) {
const patterns = getPatterns(p);
const spine = String(p?.biomech?.spine || "").toLowerCase();
return (
spine === "flexion" ||
patterns.includes("forward_fold") ||
patterns.includes("hinge") ||
patterns.includes("hamstring_stretch") ||
["forward_fold", "seated_forward_fold", "wide_leg_forward_fold", "downward_dog",
"three_legged_dog", "runners_lunge", "warrior_three"].some((id) => getId(p).includes(id))
);
}

// —————————————————————————
// Public API
// —————————————————————————

/**

- filterContraindicated({ allowed, blocked })
- Returns poses split by safety for the given injury tags.
  */
  export function filterContraindicated(poses = [], injuryTags = []) {
  const tags = toSet(injuryTags);
  if (!tags.size) return { allowed: poses, blocked: [] };

const allowed = [];
const blocked = [];

for (const p of poses) {
// First check explicit contra list on the pose itself
const explicitContra = hasAny(p?.contra, tags);

```
const lowerBackBlock   = (tags.has("lower_back") || tags.has("low_back"))   && blocksForLowerBack(p);
const kneeBlock        = (tags.has("knees")       || tags.has("knee"))       && blocksForKnees(p);
const wristBlock       = (tags.has("wrists")      || tags.has("wrist"))      && blocksForWrists(p);
const hipBlock         = tags.has("hips")                                    && blocksForHips(p);
const shoulderBlock    = (tags.has("shoulders")   || tags.has("shoulder"))   && blocksForShoulders(p);
const neckBlock        = tags.has("neck")                                    && blocksForNeck(p);
const ankleBlock       = (tags.has("ankles")      || tags.has("ankle"))      && blocksForAnkles(p);
const hamstringBlock   = (tags.has("hamstrings")  || tags.has("hamstring"))  && blocksForHamstrings(p);

if (
  explicitContra ||
  lowerBackBlock ||
  kneeBlock ||
  wristBlock ||
  hipBlock ||
  shoulderBlock ||
  neckBlock ||
  ankleBlock ||
  hamstringBlock
) {
  blocked.push(p);
} else {
  allowed.push(p);
}
```

}

return { allowed, blocked };
}

/**

- getSafetyBias — returns difficulty band cap overrides based on injury severity.
- Multiple injuries compound to the lowest cap.
  */
  export function getSafetyBias(injuryTags = []) {
  const tags = toSet(injuryTags);

const bias = {
difficultyBandMaxOverride: null,
};

function cap(n) {
bias.difficultyBandMaxOverride = Math.min(bias.difficultyBandMaxOverride ?? 99, n);
}

// Structural injuries → hard cap at band 1 (gentle only)
if (tags.has("lower_back") || tags.has("low_back")) cap(1);
if (tags.has("knees") || tags.has("knee"))           cap(1);
if (tags.has("wrists") || tags.has("wrist"))         cap(1);
if (tags.has("neck"))                                cap(1);

// Soft-tissue / mobility injuries → cap at band 2
if (tags.has("hips"))                                cap(2);
if (tags.has("shoulders") || tags.has("shoulder"))   cap(2);
if (tags.has("ankles") || tags.has("ankle"))         cap(2);
if (tags.has("hamstrings") || tags.has("hamstring")) cap(2);

return bias;
}
