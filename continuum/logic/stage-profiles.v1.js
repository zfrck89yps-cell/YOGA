// logic/stage-profiles.v1.js
// Stage profiles = “training wheels” for sequencing + progression rules.
// Keep this file boring + deterministic.

export const STAGES = Object.freeze({
  FOUNDATION: "foundation",
  BUILD: "build",
  MAINTAIN: "maintain",
});

// Backward/forward compatibility:
// - older code reads stageProfile.transitionCaps.maxInserts
// - newer code can read stageProfile.transitionPolicy.maxTransitions
function withCompatTransitionCaps(p) {
  const max =
    p?.transitionCaps?.maxInserts ??
    p?.transitionPolicy?.maxTransitions ??
    0;

  const macroOnly =
    p?.transitionCaps?.macroOnly ??
    p?.transitionPolicy?.macroOnly ??
    false;

  return {
    ...p,
    transitionCaps: Object.freeze({
      maxInserts: Number.isFinite(max) ? max : 0,
      macroOnly: !!macroOnly,
    }),
    transitionPolicy: Object.freeze({
      maxTransitions: Number.isFinite(max) ? max : 0,
      macroOnly: !!macroOnly,
    }),
  };
}

const PROFILES = Object.freeze({
  [STAGES.FOUNDATION]: withCompatTransitionCaps(Object.freeze({
    id: STAGES.FOUNDATION,
    label: "Foundation",
    difficultyCapBias: 0.85, // conservative
    intensityWave: Object.freeze({
      enabled: true,
      peakCap: 3,
    }),
    // Foundation: allow transitions freely to keep it safe + coherent
    transitionPolicy: Object.freeze({
      maxTransitions: 10,
      macroOnly: false,
    }),
  })),

  [STAGES.BUILD]: withCompatTransitionCaps(Object.freeze({
    id: STAGES.BUILD,
    label: "Build",
    difficultyCapBias: 1.0,
    intensityWave: Object.freeze({
      enabled: true,
      peakCap: 4,
    }),
    // Build: still allow transitions, but slightly tighter so it doesn’t become a “transition soup”
    transitionPolicy: Object.freeze({
      maxTransitions: 8,
      macroOnly: false,
    }),
  })),

  [STAGES.MAINTAIN]: withCompatTransitionCaps(Object.freeze({
    id: STAGES.MAINTAIN,
    label: "Maintain",
    difficultyCapBias: 1.0,
    intensityWave: Object.freeze({
      enabled: true,
      peakCap: 5,
    }),
    // Maintain: minimal transitions; you can assume competence + flow
    transitionPolicy: Object.freeze({
      maxTransitions: 6,
      macroOnly: false,
    }),
  })),
});

export function getStageProfile(stage) {
  const key = String(stage || "").toLowerCase();
  return (
    PROFILES[key] ||
    PROFILES[STAGES.FOUNDATION]
  );
}