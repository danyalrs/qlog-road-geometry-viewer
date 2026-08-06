'use strict';

const { config } = require('./stage19_spec/config');
const {
  deriveAutomaticContinuationDecision,
  THRESHOLD_CAP_M,
  THRESHOLD_OPERATOR,
} = require('./stage20_b_motion_baseline_compare');
const {
  ANCHOR_MODEL_X_M,
  anchorPointOnLane,
  rotateToVehicleFrame,
  boundaryRejection,
} = require('./stage22_b_motion_shadow_evaluation');

const DECISION_MODES = Object.freeze({
  LEGACY_SCALAR: 'legacy_scalar',
  VECTOR_SHADOW: 'vector_shadow',
  VECTOR_LIMITED: 'vector_limited',
});

const DEFAULT_VECTOR_CONFIG = Object.freeze({
  featureEnabled: false,
  decisionMode: DECISION_MODES.LEGACY_SCALAR,
});

const COORDINATE_FRAME = 'east/north metres';
const ROAD_EDGE_OVERLAP_M = 0.35;

function resolveVectorConfig(overrides = {}) {
  const envEnabled = process.env.B_MOTION_VECTOR_ENABLED;
  const envMode = process.env.B_MOTION_VECTOR_MODE;
  let featureEnabled = DEFAULT_VECTOR_CONFIG.featureEnabled;
  if (overrides.featureEnabled != null) featureEnabled = overrides.featureEnabled;
  else if (envEnabled === '1' || envEnabled === 'true') featureEnabled = true;
  else if (envEnabled === '0' || envEnabled === 'false') featureEnabled = false;

  const decisionMode = overrides.decisionMode ?? envMode ?? DEFAULT_VECTOR_CONFIG.decisionMode;
  return { featureEnabled, decisionMode };
}

function vec2(x, y) {
  return { x, y };
}

function vecSub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function vecMag(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

function round4(v) {
  return v == null ? null : +v.toFixed(4);
}

/**
 * Pure vector-residual computation from anchor and pose evidence.
 * Does not substitute zero for missing geometry.
 */
function computeVectorResidual({
  anchorA,
  anchorB,
  poseA,
  poseB,
  headingDegA,
  headingDegB,
  scalarPoseDisplacementM,
}) {
  const unavailable = (reason) => ({
    targetDisplacementEastM: null,
    targetDisplacementNorthM: null,
    poseDisplacementEastM: null,
    poseDisplacementNorthM: null,
    compensatedEastM: null,
    compensatedNorthM: null,
    longitudinalResidualM: null,
    lateralResidualM: null,
    vectorResidualM: null,
    headingCompensatedResidualM: null,
    headingCompensatedUnavailableReason: reason,
    geometryAvailable: false,
    unavailableReason: reason,
    coordinateFrame: COORDINATE_FRAME,
    anchorModelXM: ANCHOR_MODEL_X_M,
  });

  if (!anchorA?.available || !anchorB?.available) {
    return unavailable('anchor_geometry_unavailable');
  }

  const targetDisp = vecSub(
    vec2(anchorB.east, anchorB.north),
    vec2(anchorA.east, anchorA.north),
  );

  let poseDisp = null;
  let poseSource = null;
  if (poseA?.east != null && poseB?.east != null && poseA?.north != null && poseB?.north != null) {
    poseDisp = vecSub(vec2(poseB.east, poseB.north), vec2(poseA.east, poseA.north));
    poseSource = 'pose_vectors';
  } else if (scalarPoseDisplacementM != null && Number.isFinite(scalarPoseDisplacementM) && headingDegA != null) {
    const rad = (headingDegA * Math.PI) / 180;
    poseDisp = vec2(
      scalarPoseDisplacementM * Math.cos(rad),
      scalarPoseDisplacementM * Math.sin(rad),
    );
    poseSource = 'scalar_pose_inferred_from_heading_at_A';
  } else {
    return unavailable('pose_vector_unavailable');
  }

  const compensated = vecSub(targetDisp, poseDisp);
  const euclidean = vecMag(compensated);
  const vehicle = rotateToVehicleFrame(compensated, headingDegA ?? 0);

  let headingCompensatedResidualM = null;
  let headingCompensatedUnavailableReason = null;
  if (headingDegA != null && headingDegB != null) {
    const rotated = rotateToVehicleFrame(targetDisp, headingDegA);
    headingCompensatedResidualM = round4(Math.abs(rotated.lateral));
  } else {
    headingCompensatedUnavailableReason = 'heading_timestamps_not_aligned';
  }

  return {
    targetDisplacementEastM: round4(targetDisp.x),
    targetDisplacementNorthM: round4(targetDisp.y),
    poseDisplacementEastM: round4(poseDisp.x),
    poseDisplacementNorthM: round4(poseDisp.y),
    compensatedEastM: round4(compensated.x),
    compensatedNorthM: round4(compensated.y),
    longitudinalResidualM: round4(vehicle.longitudinal),
    lateralResidualM: round4(vehicle.lateral),
    vectorResidualM: round4(euclidean),
    headingCompensatedResidualM,
    headingCompensatedUnavailableReason,
    geometryAvailable: true,
    unavailableReason: null,
    coordinateFrame: COORDINATE_FRAME,
    anchorModelXM: ANCHOR_MODEL_X_M,
    poseSource,
    rotationOrder: vehicle.rotationOrder,
  };
}

function deriveLegacyScalarDecision(pair, boundary) {
  if (boundary?.reject) {
    return {
      decision: 'negative',
      source: 'boundary_rejection',
      scalarResidualM: pair.residualAfterPoseM ?? null,
      thresholdM: THRESHOLD_CAP_M,
      comparisonOperator: THRESHOLD_OPERATOR,
    };
  }
  const legacy = deriveAutomaticContinuationDecision(pair);
  return {
    decision: legacy.automaticContinuationDecision === 'positive' ? 'positive' : 'negative',
    source: legacy.automaticDecisionSource,
    scalarResidualM: pair.residualAfterPoseM ?? null,
    thresholdM: THRESHOLD_CAP_M,
    comparisonOperator: THRESHOLD_OPERATOR,
  };
}

function deriveVectorCandidateDecision(vectorResidual, boundary, thresholdM = THRESHOLD_CAP_M) {
  if (boundary?.reject) {
    return {
      decision: 'negative',
      source: 'boundary_rejection',
      vectorResidualM: vectorResidual.vectorResidualM,
      thresholdM,
      comparisonOperator: THRESHOLD_OPERATOR,
      geometryAvailable: vectorResidual.geometryAvailable,
    };
  }
  if (!vectorResidual.geometryAvailable) {
    return {
      decision: null,
      source: 'geometry_unavailable',
      vectorResidualM: null,
      thresholdM,
      comparisonOperator: THRESHOLD_OPERATOR,
      geometryAvailable: false,
    };
  }
  const accept = vectorResidual.vectorResidualM <= thresholdM;
  return {
    decision: accept ? 'positive' : 'negative',
    source: 'vector_pose_compensated_anchor_residual',
    vectorResidualM: vectorResidual.vectorResidualM,
    thresholdM,
    comparisonOperator: THRESHOLD_OPERATOR,
    geometryAvailable: true,
  };
}

function buildConceptFields({
  legacyDecision,
  vectorDecision,
  roadEdgeOverlap,
  geometryAvailable,
  boundary,
}) {
  const temporalContinuation = vectorDecision?.decision ?? legacyDecision.decision;
  return {
    temporalContinuation,
    identitySwap: false,
    roadEdgeOverlap: roadEdgeOverlap === true,
    geometryIssue: !geometryAvailable || boundary?.reject === true,
    evidenceAvailable: geometryAvailable,
    note: 'roadEdgeOverlap alone does not imply identitySwap; rank/crossing/side gates are not applied in Stage 23 limited implementation',
  };
}

/**
 * Evaluate B-motion continuation with explicit decision mode.
 * Legacy production path remains authoritative unless mode is vector_limited
 * and all required geometry/pose evidence is available.
 */
function evaluateBMotionDecision(pair, geometryContext = {}, options = {}) {
  const vectorConfig = resolveVectorConfig(options);
  const mode = options.decisionMode ?? vectorConfig.decisionMode;
  const boundary = geometryContext.boundary ?? boundaryRejection(pair);

  const legacy = deriveLegacyScalarDecision(pair, boundary);

  const vectorResidual = geometryContext.vectorResidual
    ?? computeVectorResidual({
      anchorA: geometryContext.anchorA,
      anchorB: geometryContext.anchorB,
      poseA: geometryContext.poseA,
      poseB: geometryContext.poseB,
      headingDegA: geometryContext.headingDegA,
      headingDegB: geometryContext.headingDegB,
      scalarPoseDisplacementM: geometryContext.scalarPoseDisplacementM ?? pair.poseDisplacementM,
    });

  const vectorCandidate = deriveVectorCandidateDecision(
    vectorResidual,
    boundary,
    options.thresholdM ?? THRESHOLD_CAP_M,
  );

  let authoritativeDecision = legacy.decision;
  let fallbackUsed = false;
  let fallbackReason = null;

  if (mode === DECISION_MODES.LEGACY_SCALAR) {
    authoritativeDecision = legacy.decision;
  } else if (mode === DECISION_MODES.VECTOR_SHADOW) {
    authoritativeDecision = legacy.decision;
    if (!vectorCandidate.geometryAvailable || vectorCandidate.decision == null) {
      fallbackUsed = true;
      fallbackReason = vectorResidual.unavailableReason ?? 'vector_geometry_unavailable';
    }
  } else if (mode === DECISION_MODES.VECTOR_LIMITED) {
    if (vectorCandidate.geometryAvailable && vectorCandidate.decision != null) {
      authoritativeDecision = vectorCandidate.decision;
    } else {
      authoritativeDecision = legacy.decision;
      fallbackUsed = true;
      fallbackReason = vectorResidual.unavailableReason ?? 'vector_geometry_unavailable';
    }
  }

  const roadEdgeOverlap = geometryContext.roadEdgeOverlap === true
    || (geometryContext.roadEdgeDistanceB != null && geometryContext.roadEdgeDistanceB <= ROAD_EDGE_OVERLAP_M);

  const concepts = buildConceptFields({
    legacyDecision: legacy,
    vectorDecision: vectorCandidate,
    roadEdgeOverlap,
    geometryAvailable: vectorResidual.geometryAvailable,
    boundary,
  });

  const decisionChanged = legacy.decision !== vectorCandidate.decision
    && vectorCandidate.decision != null;

  return {
    reviewPairId: pair.reviewPairId,
    mode,
    featureEnabled: options.featureEnabled ?? vectorConfig.featureEnabled,
    legacy,
    vectorCandidate,
    vectorResidual,
    authoritativeDecision,
    fallbackUsed,
    fallbackReason,
    decisionChanged,
    concepts,
    comparisonDiagnostics: {
      reviewPairId: pair.reviewPairId,
      legacyDecision: legacy.decision,
      legacyScalarResidualM: legacy.scalarResidualM,
      vectorCandidateDecision: vectorCandidate.decision,
      vectorResidualM: vectorResidual.vectorResidualM,
      decisionChanged,
      fallbackUsed,
      coordinateFrame: COORDINATE_FRAME,
      anchorModelXM: ANCHOR_MODEL_X_M,
      thresholdM: THRESHOLD_CAP_M,
      comparisonOperator: THRESHOLD_OPERATOR,
      geometryAvailable: vectorResidual.geometryAvailable,
      roadEdgeOverlap,
      roadEdgeOverlapAloneImpliesIdentitySwap: false,
    },
  };
}

function buildGeometryContextFromShadowMeas(meas, pair) {
  const ctx = {
    boundary: meas.boundary,
    roadEdgeOverlap: meas.identity?.roadEdgeOverlap,
    roadEdgeDistanceB: meas.identity?.roadEdgeDistanceB,
  };

  if (meas.vectors?.vectorAvailable) {
    ctx.vectorResidual = {
      targetDisplacementEastM: meas.vectors.targetDisplacement?.east ?? null,
      targetDisplacementNorthM: meas.vectors.targetDisplacement?.north ?? null,
      poseDisplacementEastM: meas.vectors.vehiclePoseDisplacement?.east ?? null,
      poseDisplacementNorthM: meas.vectors.vehiclePoseDisplacement?.north ?? null,
      compensatedEastM: meas.vectors.poseCompensatedTarget?.east ?? null,
      compensatedNorthM: meas.vectors.poseCompensatedTarget?.north,
      longitudinalResidualM: meas.vectors.longitudinalResidual ?? null,
      lateralResidualM: meas.vectors.lateralResidual ?? null,
      vectorResidualM: meas.vectors.euclideanPoseCompensatedAnchorResidual ?? null,
      headingCompensatedResidualM: meas.vectors.headingCompensatedResidual?.lateralAfterHeadingAlign ?? null,
      headingCompensatedUnavailableReason: meas.vectors.headingCompensatedResidual?.available === false
        ? 'heading_timestamps_not_aligned'
        : null,
      geometryAvailable: true,
      unavailableReason: null,
      coordinateFrame: COORDINATE_FRAME,
      anchorModelXM: ANCHOR_MODEL_X_M,
    };
    return ctx;
  }

  ctx.anchorA = meas.targetAnchorA
    ? { available: true, east: meas.targetAnchorA.east, north: meas.targetAnchorA.north }
    : { available: false };
  ctx.anchorB = meas.targetAnchorB
    ? { available: true, east: meas.targetAnchorB.east, north: meas.targetAnchorB.north }
    : { available: false };
  ctx.scalarPoseDisplacementM = pair.poseDisplacementM;
  return ctx;
}

module.exports = {
  ANCHOR_MODEL_X_M,
  COORDINATE_FRAME,
  DECISION_MODES,
  DEFAULT_VECTOR_CONFIG,
  THRESHOLD_CAP_M,
  THRESHOLD_OPERATOR,
  ROAD_EDGE_OVERLAP_M,
  resolveVectorConfig,
  computeVectorResidual,
  anchorPointOnLane,
  deriveLegacyScalarDecision,
  deriveVectorCandidateDecision,
  evaluateBMotionDecision,
  buildGeometryContextFromShadowMeas,
  rotateToVehicleFrame,
  vecSub,
  vecMag,
};
