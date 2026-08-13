'use strict';

/**
 * Experimental multi-input mapping reliability indicator (display-only).
 *
 * This is an experiment, NOT a calibrated confidence model. It produces a
 * deterministic score in [0,1] from information available at or before the
 * current observation, intended to tint Point-accumulated geometry. It never
 * filters, removes, moves, connects or snaps points, and never changes
 * coordinates or laneTrackId.
 *
 * Causal inputs (each documented below):
 *   1. Lane-line probability            (prob)
 *   2. modelX forward distance          (modelX)
 *   3. Turning state from recent heading history (turnRateDegPerSec)
 *   4. Temporal disagreement against earlier observations of the same
 *      predicted physical area         (temporalDisagreementM)
 *   5. Pose/time quality                (poseAccuracyM, headingSource)
 *
 * The future vehicle trajectory and future-path residual are NEVER inputs.
 * Future-path results are used only for offline evaluation (see the ablation
 * script), never inside this module.
 */

// --- Documented candidate weight sets (A..F) -------------------------------
// Derived from the accepted dataset-wide audit: turning is the dominant error
// driver, then lane probability, then distance and temporal disagreement.
// Order is [probability, distance, turning, temporalAgreement, poseQuality].
const RELIABILITY_CANDIDATES = {
  A: { name: 'probability only', weights: [1.0, 0, 0, 0, 0] },
  B: { name: 'distance only', weights: [0, 1.0, 0, 0, 0] },
  C: { name: 'probability + distance', weights: [0.5, 0.5, 0, 0, 0] },
  D: { name: 'probability + distance + turning', weights: [0.35, 0.25, 0.4, 0, 0] },
  E: { name: 'probability + distance + turning + temporal agreement', weights: [0.3, 0.2, 0.3, 0.2, 0] },
  F: { name: 'all supported live inputs', weights: [0.28, 0.17, 0.3, 0.18, 0.07] },
};

// Selected experimental formula (evidence-backed; see ablation report).
// Candidate E (probability + distance + turning + temporal agreement) beat F in
// within-bin Spearman (e.g. 60-80: -0.415 vs -0.414; 100-120: -0.277 vs -0.283),
// leave-segments-out CV mean (-0.5602 vs -0.5452), band separation (high-band
// p95 residual 5.28 m vs 6.21 m) and probability-bin discrimination, while
// omitting the weakest, least-well-defined input (pose quality). Simpler is
// better here: the most complex formula is NOT the best.
const SELECTED_CANDIDATE = 'E';

// --- Component normalization references ------------------------------------
const PROB_REFERENCE = 0.5;     // minLaneProb used by the pipeline
const MAX_FORWARD_M = 120;      // pipeline maxForwardM
const TURN_RATE_REFERENCE_DPS = 25; // deg/s considered strongly turning
const TEMPORAL_REFERENCE_M = 20;    // m of spatial disagreement = strongly unreliable
const POSE_ACCURACY_REFERENCE_M = 30; // m; 30+ m GPS accuracy = poor

// --- Tuning fallbacks (documented) -----------------------------------------
// When temporal agreement is unavailable (no earlier compatible observation),
// the temporal component is set to its fallback and its weight is renormalized
// away; the component value used is reported via hasTemporalAgreement=false.
const TEMPORAL_UNAVAILABLE_FALLBACK = 0.5;

function clamp01(v) {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}

/** Linear ramp so prob=minProb -> 0, prob=1 -> 1. */
function probabilityComponent(prob) {
  if (!Number.isFinite(prob)) return 0;
  return clamp01((prob - PROB_REFERENCE) / (1 - PROB_REFERENCE));
}

/** 1 at modelX=0, 0 at modelX >= MAX_FORWARD_M. */
function distanceComponent(modelX) {
  if (!Number.isFinite(modelX)) return 0;
  return clamp01(1 - modelX / MAX_FORWARD_M);
}

/** 1 when straight, 0 at |turnRate| >= TURN_RATE_REFERENCE. */
function turningComponent(turnRateDegPerSec) {
  if (turnRateDegPerSec == null || !Number.isFinite(turnRateDegPerSec)) return 0.5; // missing heading -> neutral
  return clamp01(1 - Math.abs(turnRateDegPerSec) / TURN_RATE_REFERENCE_DPS);
}

/** 1 when no spatial disagreement, 0 at >= TEMPORAL_REFERENCE. */
function temporalAgreementComponent(disagreementM, available) {
  if (!available || disagreementM == null || !Number.isFinite(disagreementM)) {
    return TEMPORAL_UNAVAILABLE_FALLBACK;
  }
  return clamp01(1 - Math.abs(disagreementM) / TEMPORAL_REFERENCE_M);
}

/** 1 at accurate pose, 0 at >= POSE_ACCURACY_REFERENCE. Missing -> neutral. */
function poseQualityComponent(accuracyM, headingSource) {
  if (accuracyM == null || !Number.isFinite(accuracyM)) return 0.5;
  const source = headingSource || '';
  if (source === 'default' || source === 'motion' || source === 'gps_fallback') return 0.25;
  if (source === 'gps' || source === 'interpolated') {
    // interpolated is slightly less certain than a direct gps fix
    const base = clamp01(1 - accuracyM / POSE_ACCURACY_REFERENCE_M);
    return source === 'interpolated' ? base * 0.9 : base;
  }
  return clamp01(1 - accuracyM / POSE_ACCURACY_REFERENCE_M);
}

/**
 * Combine components with a candidate weight vector. Weight vector order:
 * [probability, distance, turning, temporalAgreement, poseQuality].
 * Unavailable temporal agreement renormalizes away its weight so it never
 * silently depresses the score.
 */
function combineComponents(components, weights, hasTemporalAgreement) {
  const w = [...weights];
  if (!hasTemporalAgreement) {
    const tw = w[3];
    w[3] = 0;
    const sum = w.reduce((a, b) => a + b, 0);
    if (sum > 0) {
      for (let i = 0; i < w.length; i++) w[i] = w[i] / sum;
    }
  }
  const denom = w.reduce((a, b) => a + b, 0) || 1;
  const values = [
    components.probability ?? 0,
    components.distance ?? 0,
    components.turning ?? 0.5,
    components.temporalAgreement ?? TEMPORAL_UNAVAILABLE_FALLBACK,
    components.poseQuality ?? 0.5,
  ];
  const combined = values.reduce((acc, v, i) => acc + (w[i] || 0) * v, 0) / denom;
  return clamp01(combined);
}

/**
 * Compute the experimental reliability for one point observation.
 *
 * @param {object} input
 *   prob          lane-line probability (0..1)
 *   modelX        forward distance (m)
 *   turnRateDegPerSec  turning state (may be null)
 *   temporalDisagreementM  spatial disagreement vs earlier obs (may be null)
 *   hasTemporalAgreement   whether a valid earlier comparison exists
 *   poseAccuracyM  GPS horizontal accuracy (m)
 *   headingSource  'gps' | 'interpolated' | 'default' | 'motion' | ...
 *   candidate     candidate key ('A'..'F') or null to use SELECTED_CANDIDATE
 *
 * @returns {object} component values + combinedScore + candidate + bands.
 */
function computeReliability(input = {}) {
  const candidateKey = input.candidate || SELECTED_CANDIDATE;
  const candidate = RELIABILITY_CANDIDATES[candidateKey] || RELIABILITY_CANDIDATES[SELECTED_CANDIDATE];

  const probability = probabilityComponent(input.prob);
  const distance = distanceComponent(input.modelX);
  const turning = turningComponent(input.turnRateDegPerSec);
  const hasTemporal = !!input.hasTemporalAgreement;
  const temporalAgreement = temporalAgreementComponent(input.temporalDisagreementM, hasTemporal);
  const poseQuality = poseQualityComponent(input.poseAccuracyM, input.headingSource);

  const components = { probability, distance, turning, temporalAgreement, poseQuality };
  const combinedScore = combineComponents(components, candidate.weights, hasTemporal);

  return {
    candidate: candidateKey,
    combinedScore,
    components,
    hasTemporalAgreement: hasTemporal,
    temporalUnavailableFallback: !hasTemporal,
    band: bandForScore(combinedScore),
    bandLabel: bandLabel(combinedScore),
    // Explicit "experimental, not calibrated" marker for display/debug.
    experimental: true,
    calibrated: false,
  };
}

function bandForScore(score) {
  if (score >= 0.7) return 'high';
  if (score >= 0.4) return 'medium';
  return 'low';
}

function bandLabel(score) {
  if (score >= 0.7) return 'High reliability (0.70–1.00)';
  if (score >= 0.4) return 'Medium reliability (0.40–0.70)';
  return 'Low reliability (0.00–0.40)';
}

/** Tint colour for a score (display-only). Returns rgba string. */
function tintColorForScore(score, alpha = 0.9) {
  const s = clamp01(score);
  // green (reliable) -> yellow -> red (unreliable)
  const r = Math.round(255 * (1 - s));
  const g = Math.round(200 * s);
  const b = Math.round(80 + 60 * (1 - s));
  return `rgba(${r},${g},${b},${alpha})`;
}

function candidateSummary() {
  return Object.fromEntries(
    Object.entries(RELIABILITY_CANDIDATES).map(([k, c]) => [k, { name: c.name, weights: c.weights }]),
  );
}

module.exports = {
  RELIABILITY_CANDIDATES,
  SELECTED_CANDIDATE,
  PROB_REFERENCE,
  MAX_FORWARD_M,
  TURN_RATE_REFERENCE_DPS,
  TEMPORAL_REFERENCE_M,
  POSE_ACCURACY_REFERENCE_M,
  TEMPORAL_UNAVAILABLE_FALLBACK,
  probabilityComponent,
  distanceComponent,
  turningComponent,
  temporalAgreementComponent,
  poseQualityComponent,
  combineComponents,
  computeReliability,
  bandForScore,
  bandLabel,
  tintColorForScore,
  candidateSummary,
};
if (typeof window !== 'undefined') {
  window.MappingReliability = module.exports;
}
