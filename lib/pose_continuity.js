/**
 * Pose continuity validation and pose-section assignment.
 * Separates poseSection (valid localization continuity) from temporalPass (movement).
 */
const { dist2d, timeGapSec } = require('./chunking');
const { bearingFromDelta, normalizeDeg } = require('./alignment');

const DEFAULT_POSE_CONTINUITY_CONFIG = {
  maxImpliedSpeedMps: 55,
  maxPositionJumpM: 35,
  absoluteMaxPositionJumpM: 65,
  stationaryMaxPositionJumpM: 8,
  positionJumpSpeedSlack: 1.35,
  positionJumpBufferM: 10,
  conservativeFallbackSpeedMps: 12,
  speedHistoryWindow: 5,
  maxTimeGapSec: 3.5,
  stationaryMaxSpeedMps: 2.0,
  minDisplacementForHeadingM: 1.0,
  maxHeadingChangeLowSpeedDeg: 20,
  maxHeadingMotionDisagreementDeg: 45,
  maxHeadingMotionDisagreementSparseDeg: 65,
  speedConsistencyRatioMax: 0.6,
  maxHeadingChangeMovingDeg: 90,
};

function bearingDelta(a, b) {
  const ba = normalizeDeg(a ?? 0);
  const bb = normalizeDeg(b ?? 0);
  let d = Math.abs(bb - ba);
  if (d > 180) d = 360 - d;
  return d;
}

function resolveConfig(options = {}) {
  return { ...DEFAULT_POSE_CONTINUITY_CONFIG, ...options.poseContinuity, ...options };
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function hasReportedSpeed(point) {
  return Number.isFinite(point?.speed) && point.speed > 0;
}

function reportedSpeedMps(prev, cur) {
  const speeds = [prev?.speed, cur?.speed].filter((s) => Number.isFinite(s) && s > 0);
  return speeds.length ? Math.max(...speeds) : null;
}

/**
 * Collect speed estimates from accepted history and neighbouring steps only.
 * Never uses the candidate transition's own implied speed.
 */
function independentSpeedEstimates(prev, context, cfg) {
  const estimates = [];
  const history = context?.acceptedHistory ?? [];

  for (const entry of history.slice(-(cfg.speedHistoryWindow ?? 5))) {
    if (entry.reportedSpeed > cfg.stationaryMaxSpeedMps) {
      estimates.push(entry.reportedSpeed);
    } else if (entry.impliedSpeed > cfg.stationaryMaxSpeedMps) {
      estimates.push(entry.impliedSpeed);
    }
  }

  if (context?.neighborPrevStepM != null && context?.neighborPrevDt != null) {
    const neighborSpeed = context.neighborPrevStepM / Math.max(context.neighborPrevDt, 0.001);
    if (neighborSpeed > cfg.stationaryMaxSpeedMps) {
      estimates.push(neighborSpeed);
    }
  }

  if (hasReportedSpeed(prev) && prev.speed > cfg.stationaryMaxSpeedMps) {
    estimates.push(prev.speed);
  }

  return estimates;
}

/**
 * Estimate expected speed for thresholding without using the candidate step's implied speed.
 */
function estimateExpectedSpeedMps(prev, cur, context, cfg) {
  const reported = reportedSpeedMps(prev, cur);
  const neighbors = independentSpeedEstimates(prev, context, cfg);
  const neighborMedian = median(neighbors);

  if (reported != null && reported > cfg.stationaryMaxSpeedMps) {
    if (neighborMedian != null && neighborMedian > cfg.stationaryMaxSpeedMps
      && reported < neighborMedian) {
      const ratio = (neighborMedian - reported) / Math.max(neighborMedian, 0.5);
      if (ratio > cfg.speedConsistencyRatioMax) {
        return { speed: neighborMedian, source: 'neighborMedianOverridesReported' };
      }
    }
    return { speed: reported, source: 'reported' };
  }

  if (neighborMedian != null && neighborMedian > cfg.stationaryMaxSpeedMps) {
    return { speed: neighborMedian, source: 'neighborMedian' };
  }

  if (hasReportedSpeed(prev) && prev.speed > cfg.stationaryMaxSpeedMps) {
    return { speed: prev.speed, source: 'prevReported' };
  }

  return {
    speed: cfg.conservativeFallbackSpeedMps ?? 12,
    source: neighbors.length ? 'conservativeFallbackWithPartialHistory' : 'conservativeFallback',
  };
}

/**
 * Speed- and time-adaptive maximum step from independently estimated speed.
 */
function maxAllowedPositionJumpM(expectedSpeedMps, cfg, dt) {
  if (expectedSpeedMps <= cfg.stationaryMaxSpeedMps) {
    return cfg.stationaryMaxPositionJumpM ?? 8;
  }
  const fromSpeed = expectedSpeedMps * dt * cfg.positionJumpSpeedSlack + cfg.positionJumpBufferM;
  return Math.min(
    Math.max(fromSpeed, cfg.maxPositionJumpM),
    cfg.absoluteMaxPositionJumpM
  );
}

function headingMotionDisagreementLimit(prev, cur, cfg, referenceSpeedMps, implied) {
  const reportedSpeed = reportedSpeedMps(prev, cur) ?? 0;
  const compareSpeed = reportedSpeed > cfg.stationaryMaxSpeedMps ? reportedSpeed : referenceSpeedMps;
  const speedConsistent = compareSpeed > cfg.stationaryMaxSpeedMps
    && Math.abs(implied - compareSpeed) / Math.max(compareSpeed, 0.5) <= cfg.speedConsistencyRatioMax;
  return speedConsistent
    ? cfg.maxHeadingMotionDisagreementSparseDeg
    : cfg.maxHeadingMotionDisagreementDeg;
}

function validatePoseTransition(prev, cur, options = {}, context = {}) {
  if (!prev || !cur) return { ok: true, reason: null };
  const cfg = resolveConfig(options);
  const step = dist2d(prev, cur);
  const dt = Math.max(timeGapSec(prev, cur), 0.001);
  const implied = step / dt;
  const reportedSpeed = reportedSpeedMps(prev, cur);
  const { speed: expectedSpeed, source: expectedSpeedSource } = estimateExpectedSpeedMps(prev, cur, context, cfg);
  const maxAllowedStepM = maxAllowedPositionJumpM(expectedSpeed, cfg, dt);
  const headingContinuityDeg = bearingDelta(prev.headingDeg, cur.headingDeg);
  const operationalSpeed = reportedSpeed != null && reportedSpeed > cfg.stationaryMaxSpeedMps
    ? reportedSpeed
    : expectedSpeed;

  const base = {
    step,
    dt,
    impliedSpeed: implied,
    maxAllowedStepM,
    reportedSpeed: reportedSpeed ?? 0,
    expectedSpeedMps: expectedSpeed,
    expectedSpeedSource,
    headingContinuityDeg,
  };

  if (!Number.isFinite(cur.east) || !Number.isFinite(cur.north)
    || !Number.isFinite(prev.east) || !Number.isFinite(prev.north)) {
    return { ok: false, reason: 'nonFiniteCoordinates', ...base };
  }
  if (dt > cfg.maxTimeGapSec) {
    return { ok: false, reason: 'timeGapExceeded', ...base };
  }
  if (implied > cfg.maxImpliedSpeedMps) {
    return { ok: false, reason: 'impliedSpeedExceeded', ...base };
  }
  if (step > maxAllowedStepM && operationalSpeed > cfg.stationaryMaxSpeedMps) {
    return { ok: false, reason: 'positionJump', ...base };
  }

  const headingDelta = headingContinuityDeg;
  const de = cur.east - prev.east;
  const dn = cur.north - prev.north;
  const motionBearing = bearingFromDelta(de, dn);
  const motionDisagreement = motionBearing != null
    ? bearingDelta(motionBearing, cur.headingDeg ?? prev.headingDeg)
    : 0;
  const disagreementLimit = headingMotionDisagreementLimit(prev, cur, cfg, expectedSpeed, implied);

  if (operationalSpeed <= cfg.stationaryMaxSpeedMps && step < cfg.minDisplacementForHeadingM
    && headingDelta > cfg.maxHeadingChangeLowSpeedDeg) {
    return {
      ok: false,
      reason: 'headingChangeWithoutDisplacement',
      headingDelta,
      motionDisagreement,
      disagreementLimitDeg: disagreementLimit,
      ...base,
    };
  }

  if (operationalSpeed > cfg.stationaryMaxSpeedMps && step >= cfg.minDisplacementForHeadingM
    && motionDisagreement > disagreementLimit) {
    return {
      ok: false,
      reason: 'headingMotionDisagreement',
      headingDelta,
      motionDisagreement,
      disagreementLimitDeg: disagreementLimit,
      ...base,
    };
  }

  if (operationalSpeed > cfg.stationaryMaxSpeedMps && headingDelta > cfg.maxHeadingChangeMovingDeg && step < 5) {
    return {
      ok: false,
      reason: 'suddenHeadingRotation',
      headingDelta,
      motionDisagreement,
      disagreementLimitDeg: disagreementLimit,
      ...base,
    };
  }

  return {
    ok: true,
    reason: null,
    headingDelta,
    motionDisagreement,
    disagreementLimitDeg: disagreementLimit,
    ...base,
  };
}

/**
 * Assign pose sections to ordered path points (frame-aligned vehicle path).
 */
function assignPoseSections(pathPoints, options = {}) {
  const cfg = resolveConfig(options);
  if (!pathPoints?.length) {
    return {
      sections: [],
      transitions: [],
      rejectedTransitions: [],
      annotatedPoints: [],
      poseSectionCount: 0,
    };
  }

  let poseSectionId = 0;
  const annotatedPoints = [];
  const transitions = [];
  const rejectedTransitions = [];
  const acceptedHistory = [];

  for (let i = 0; i < pathPoints.length; i++) {
    const pt = { ...pathPoints[i] };
    let continuityStatus = 'valid';
    let rejectionReason = null;

    if (i > 0) {
      const prev = annotatedPoints[i - 1];
      const neighborPrevStep = i >= 2 ? dist2d(annotatedPoints[i - 2], prev) : null;
      const neighborPrevDt = i >= 2
        ? Math.max(timeGapSec(annotatedPoints[i - 2], prev), 0.001)
        : null;

      const context = {
        acceptedHistory,
        neighborPrevStepM: neighborPrevStep,
        neighborPrevDt,
        index: i,
      };

      const check = validatePoseTransition(prev, pt, cfg, context);

      transitions.push({
        index: i,
        fromFrameId: prev.frameId,
        toFrameId: pt.frameId,
        fromLogMonoTime: prev.logMonoTime,
        toLogMonoTime: pt.logMonoTime,
        movementState: pt.movementState ?? prev.movementState ?? null,
        gpsSamplingIntervalSec: check.dt,
        neighborPrevStepM: neighborPrevStep,
        neighborPrevImpliedSpeedMps: neighborPrevStep != null && neighborPrevDt
          ? neighborPrevStep / neighborPrevDt
          : null,
        ...check,
      });

      if (!check.ok) {
        poseSectionId++;
        continuityStatus = 'sectionStartAfterRejection';
        rejectionReason = check.reason;
        rejectedTransitions.push(transitions[transitions.length - 1]);
        acceptedHistory.length = 0;
      } else {
        acceptedHistory.push({
          impliedSpeed: check.impliedSpeed,
          reportedSpeed: check.reportedSpeed,
          step: check.step,
          dt: check.dt,
        });
        if (acceptedHistory.length > cfg.speedHistoryWindow * 2) {
          acceptedHistory.splice(0, acceptedHistory.length - cfg.speedHistoryWindow);
        }
      }
    }

    annotatedPoints.push({
      ...pt,
      poseSectionId,
      temporalPassId: pt.passId ?? pt.temporalPassId ?? 0,
      poseContinuityStatus: continuityStatus,
      poseRejectionReason: rejectionReason,
    });
  }

  const sectionIds = [...new Set(annotatedPoints.map((p) => p.poseSectionId))];
  const sections = sectionIds.map((id) => {
    const pts = annotatedPoints.filter((p) => p.poseSectionId === id);
    return {
      poseSectionId: id,
      pointCount: pts.length,
      startFrameId: pts[0]?.frameId,
      endFrameId: pts[pts.length - 1]?.frameId,
      startLogMonoTime: pts[0]?.logMonoTime,
      endLogMonoTime: pts[pts.length - 1]?.logMonoTime,
    };
  });

  return {
    sections,
    transitions,
    rejectedTransitions,
    annotatedPoints,
    poseSectionCount: sections.length,
    config: cfg,
  };
}

function applyPoseSectionsToFrames(frames, annotatedPath) {
  const byFrame = new Map(annotatedPath.map((p) => [p.frameId, p]));
  return frames.map((f) => {
    const p = byFrame.get(f.frameId);
    if (!p) return { ...f, poseSectionId: 0, temporalPassId: f.passId ?? 0 };
    return {
      ...f,
      temporalPassId: f.passId ?? p.temporalPassId ?? 0,
      poseSectionId: p.poseSectionId,
      movementState: p.movementState,
      poseContinuityStatus: p.poseContinuityStatus ?? 'valid',
      poseRejectionReason: p.poseRejectionReason ?? null,
    };
  });
}

/** Build trajectory polylines without connectors across pose-section or rejection gaps. */
function buildSectionedTrajectories(annotatedPoints) {
  if (!annotatedPoints?.length) return { segments: [], hiddenConnectorLengthM: 0 };

  const segments = [];
  let current = [annotatedPoints[0]];
  let hiddenConnectorLengthM = 0;

  for (let i = 1; i < annotatedPoints.length; i++) {
    const prev = annotatedPoints[i - 1];
    const cur = annotatedPoints[i];
    const sectionBreak = cur.poseSectionId !== prev.poseSectionId;
    const rejected = cur.poseContinuityStatus === 'sectionStartAfterRejection';

    if (sectionBreak || rejected) {
      if (current.length) segments.push(current);
      hiddenConnectorLengthM += dist2d(prev, cur);
      current = [cur];
    } else {
      current.push(cur);
    }
  }
  if (current.length) segments.push(current);

  return { segments, hiddenConnectorLengthM };
}

function diagnoseFirstRejection(poseResult) {
  const first = poseResult.rejectedTransitions?.[0];
  if (!first) return null;
  return {
    fromFrameId: first.fromFrameId,
    toFrameId: first.toFrameId,
    fromLogMonoTime: first.fromLogMonoTime,
    toLogMonoTime: first.toLogMonoTime,
    reason: first.reason,
    stepM: first.step,
    timeDiffSec: first.dt,
    impliedSpeedMps: first.impliedSpeed,
    expectedSpeedMps: first.expectedSpeedMps,
    expectedSpeedSource: first.expectedSpeedSource,
    headingDeltaDeg: first.headingDelta,
    headingContinuityDeg: first.headingContinuityDeg,
    motionDisagreementDeg: first.motionDisagreement,
    maxAllowedStepM: first.maxAllowedStepM,
    reportedSpeedMps: first.reportedSpeed,
    gpsSamplingIntervalSec: first.gpsSamplingIntervalSec,
    movementState: first.movementState,
  };
}

function classifyRejectionTransition(transition) {
  if (transition.ok) return 'accepted';
  const reported = transition.reportedSpeed ?? 0;
  const implied = transition.impliedSpeed ?? 0;
  const expected = transition.expectedSpeedMps ?? 0;
  const step = transition.step ?? 0;
  const maxAllowed = transition.maxAllowedStepM ?? 0;
  const referenceSpeed = reported > 2 ? reported : expected;
  const speedConsistent = referenceSpeed > 2
    && Math.abs(implied - referenceSpeed) / Math.max(referenceSpeed, 0.5) <= 0.6;

  if (transition.reason === 'positionJump' && speedConsistent && step <= maxAllowed * 1.05) {
    return 'false_sparse_gps_threshold';
  }
  if (['impliedSpeedExceeded', 'positionJump', 'timeGapExceeded'].includes(transition.reason)
    && !speedConsistent && step > maxAllowed * 1.2) {
    return 'genuine_localization_failure';
  }
  if (transition.reason === 'headingMotionDisagreement' && speedConsistent) {
    return 'false_sparse_heading_noise';
  }
  return 'genuine_localization_failure';
}

module.exports = {
  DEFAULT_POSE_CONTINUITY_CONFIG,
  estimateExpectedSpeedMps,
  maxAllowedPositionJumpM,
  validatePoseTransition,
  assignPoseSections,
  applyPoseSectionsToFrames,
  buildSectionedTrajectories,
  diagnoseFirstRejection,
  classifyRejectionTransition,
};
