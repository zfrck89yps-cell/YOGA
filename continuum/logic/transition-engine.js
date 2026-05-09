// logic/transition-engine.js
import { TRANSITION_FLOWS } from "./transition-flows.v1.js";

function toNum(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function isTransitionStep(step) {
  return !!step?.isTransition || (step?.meta?.patterns || []).includes("transition");
}

function normPosture(p) {
  // if your derivePosture returns "restore" for corpse, treat as supine for flows
  if (p === "restore") return "supine";
  return p;
}

function flowKey(from, to) {
  return `${normPosture(from)}->${normPosture(to)}`;
}

function stepPatterns(step, poseById) {
  const meta = step?.meta ?? poseById?.get(step?.poseId) ?? null;
  return meta?.patterns || [];
}

function looksLikeTableOrPlank(patterns = []) {
  return (
    patterns.includes("plank") ||
    patterns.includes("table") ||
    patterns.includes("tabletop") ||
    patterns.includes("beast") ||
    patterns.includes("vinyasa") ||
    patterns.includes("all_fours")
  );
}

// ---- scoring ----
// Lower score = better
function scoreSequence(ids, ctx) {
  const {
    usedSet,
    poseById,
    fromPatterns,
    toPatterns,
    allowReuseTransitions = true,
  } = ctx;

  let score = 0;

  // 1) Prefer shorter, but not *aggressively* (lets nicer 2–3 step bridges win)
  score += (ids.length - 1) * 4;

  // 2) Validity check + reuse policy
  for (const id of ids) {
    if (!id) return 1e9;
    if (poseById && !poseById.get(id)) return 1e9;

    // If reuse allowed, small penalty (variety), not a hard block
    if (usedSet?.has(id)) score += allowReuseTransitions ? 6 : 1000;
  }

  // 3) Context preferences

  // If target is table/plank-y, prefer getting there like a human
  const wantsGroundedPlankish = looksLikeTableOrPlank(toPatterns);
  if (wantsGroundedPlankish) {
    if (ids.includes("step_back_to_plank")) score -= 10;
    if (ids.includes("swing_legs_back")) score -= 7;
    if (ids.includes("hands_to_floor")) score -= 3;
  }
  const nextIsTableOrPlankish = looksLikeTableOrPlank(toPatterns);
  if (!nextIsTableOrPlankish) {
    if (ids.includes("swing_legs_back")) score += 25;
    if (ids.includes("step_back_to_plank")) score += 25;
  }

  // If coming from fold-ish, avoid roll_down (redundant)
  const comingFromFoldish =
    fromPatterns.includes("fold") ||
    fromPatterns.includes("forward_fold") ||
    fromPatterns.includes("wide_leg_forward_fold");

  if (comingFromFoldish && ids.includes("roll_down")) score += 8;

  // Gentle "nice" micro-adjustments
  if (ids.includes("shift_weight_back") || ids.includes("shift_weight_forward")) score -= 1;
  if (ids.includes("step_feet_wider") || ids.includes("step_feet_together")) score -= 1;

  // Seated-to-grounded: prefer press-up transitions over "teleporting"
  if (
    (fromPatterns.includes("seated") || fromPatterns.includes("sit")) &&
    looksLikeTableOrPlank(toPatterns)
  ) {
    if (ids.includes("press_up_to_tabletop")) score -= 4;
    if (ids.includes("press_to_table")) score -= 3;
  }

  return score;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Choose among the best few (adds variety)
function chooseBestSequence(sequences, ctx) {
  if (!Array.isArray(sequences) || !sequences.length) return null;

  const scored = [];

  for (const seq of sequences) {
    const ids = Array.isArray(seq) ? seq : [seq];
    const s = scoreSequence(ids, ctx);
    if (s < 900) scored.push({ ids, s });
  }

  if (!scored.length) return null;

  scored.sort((a, b) => a.s - b.s);

  // pick from top 3 to avoid same bridge every time
  const top = scored.slice(0, Math.min(3, scored.length));
  return pickRandom(top).ids;
}

export function insertTransitions({
  steps,
  poseById,
  arcProfile,
  derivePosture,
  usedSet,
  supineLock = true,
  maxInserts = 999,
  maxConsecutive = 3,
  allowReuseTransitions = true, // ✅ new (and your flow-engine already passes it)
}) {
  const out = [];
  let inserts = 0;
  let consecutive = 0;
  let sawSupineOrProne = false;

  const maxIns = toNum(maxInserts, 999);
  const maxConsec = toNum(maxConsecutive, 3);

  for (let i = 0; i < (steps?.length || 0); i++) {
    const cur = steps[i];
    const next = steps[i + 1];

    out.push(cur);

    if (!next) continue;
    if (inserts >= maxIns) continue;

    // don't insert between transitions
    if (isTransitionStep(cur) || isTransitionStep(next)) {
      consecutive = isTransitionStep(next) ? consecutive + 1 : 0;
      continue;
    }

    const fromPost = normPosture(
      derivePosture(cur?.meta ?? poseById.get(cur.poseId) ?? cur)
    );
    const toPost = normPosture(
      derivePosture(next?.meta ?? poseById.get(next.poseId) ?? next)
    );

    // supineLock: once in supine/prone, don't go back to upright/grounded (seated allowed)
    if (supineLock) {
      if (fromPost === "supine" || fromPost === "prone") sawSupineOrProne = true;
      if (sawSupineOrProne && (toPost === "upright" || toPost === "grounded")) {
        continue;
      }
    }

    if (fromPost === toPost) {
      consecutive = 0;
      continue;
    }

    if (consecutive >= maxConsec) continue;

    const key = flowKey(fromPost, toPost);
    const sequences = TRANSITION_FLOWS[key];

    const chosen = chooseBestSequence(sequences, {
      usedSet,
      poseById,
      fromPatterns: stepPatterns(cur, poseById),
      toPatterns: stepPatterns(next, poseById),
      allowReuseTransitions,
    });

    if (!chosen) {
      consecutive = 0;
      continue;
    }

    for (const tid of chosen) {
      const tp = poseById.get(tid) || null;

      out.push({
        poseId: tid,
        isTransition: true,
        meta: {
          regions: tp?.regions ?? [],
          patterns: Array.from(new Set([...(tp?.patterns ?? []), "transition"])),
          difficultyBand: tp?.difficultyBand ?? 0,
          biomech: tp?.biomech ?? null,
          derived: {
            posture: normPosture(derivePosture(tp || { id: tid, patterns: ["transition"] })),
            intensity: 1,
            spine: "neutral",
          },
          arcProfile,
        },
      });

      // Track usage for variety (even if reuse allowed)
      usedSet?.add(tid);

      inserts++;
      consecutive++;

      if (inserts >= maxIns) break;
      if (consecutive >= maxConsec) break;
    }
  }

  return out;
}