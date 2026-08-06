/**
 * Stage 16 — projected lane-line observation prototype (read-only).
 * Projects modelV2 lane-line slots into route coordinates without v11 mutation.
 */
const {
  ASSESSMENT_THRESHOLDS,
  evaluateLineObservation,
  buildSlotSemantics,
  classifyFrameLines,
} = require('./stage15a_classification_audit');
const { modelToGlobal } = require('./transform');
const { interpolateGpsAtTime } = require('./alignment');
const { buildReferenceTrajectory } = require('./trajectory');
const { projectPointTemporal, vehicleSAtTimeTemporal } = require('./temporal_projection');
const { dist2d } = require('./chunking');
const {
  PROJECTION_SCHEMA_VERSION,
  STAGE16_PROCESSING_VERSION,
  PROJECTION_STATUSES,
  POINT_OUTCOMES,
  DEFAULT_FRAGMENT_ASSESSMENT,
  TRANSFORM_CONVENTIONS,
} = require('./stage16_projection_schema');
const { summarizeNumeric } = require('./stage15_distributions');

const SLOT_COUNT = 4;

function emptyPointAudit() {
  return {
    rawSourcePointCount: 0,
    rawNonfiniteCount: 0,
    rejectedByXWindowCount: 0,
    afterXWindowCount: 0,
    submittedToProjectionCount: 0,
    projectedPointCount: 0,
    rejectedPerpDistCount: 0,
    rejectedPoseUnavailableCount: 0,
    rejectedForwardWindowCount: 0,
    rejectedNonfiniteCount: 0,
    rejectedFragmentDiscardedCount: 0,
    inObservationRejectedCount: 0,
    retainedPointFraction: 0,
    firstRetainedDeviceX: null,
    lastRetainedDeviceX: null,
    firstProjectedRouteS: null,
    lastProjectedRouteS: null,
    projectedRouteSpanM: null,
    isContiguousSourceRun: false,
    fragmentedRunCount: 0,
    nonMonotonicRouteS: false,
    coordinateJumpCount: 0,
    pointOutcomes: {},
  };
}

function countRawDevicePoints(line) {
  const xs = line?.x || [];
  const ys = line?.y || [];
  let rawFinite = 0;
  let rawNonfinite = 0;
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) rawNonfinite++;
    else rawFinite++;
  }
  return { rawFiniteCount: rawFinite, rawNonfiniteCount: rawNonfinite, totalArrayLength: xs.length };
}

function bumpOutcome(audit, outcome, n = 1) {
  audit.pointOutcomes[outcome] = (audit.pointOutcomes[outcome] || 0) + n;
}

function segmentIdFromFilename(filename) {
  const m = String(filename || '').match(/_(\d+)\.bz2$/i);
  return m ? parseInt(m[1], 10) : null;
}

function frameKey(sourceFile, logMonoTime) {
  return `${sourceFile}|${logMonoTime}`;
}

function hasMonotonicForwardX(xs) {
  if (!xs || xs.length < 2) return xs?.length >= 1;
  let increasing = 0;
  let decreasing = 0;
  for (let i = 1; i < xs.length; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(xs[i - 1])) continue;
    if (xs[i] > xs[i - 1]) increasing++;
    else if (xs[i] < xs[i - 1]) decreasing++;
  }
  return increasing >= decreasing;
}

function extractDevicePointsWithAudit(line, options = {}) {
  const maxForwardM = options.maxForwardM ?? DEFAULT_FRAGMENT_ASSESSMENT.maxForwardM;
  const minForwardM = options.minForwardM ?? DEFAULT_FRAGMENT_ASSESSMENT.minForwardM;
  const xs = line?.x || [];
  const ys = line?.y || [];
  const zs = line?.z || [];
  const ts = line?.t || [];
  const audit = emptyPointAudit();
  const raw = countRawDevicePoints(line);
  audit.rawSourcePointCount = raw.totalArrayLength;
  audit.rawNonfiniteCount = raw.rawNonfiniteCount;
  bumpOutcome(audit, POINT_OUTCOMES.RAW_NONFINITE, raw.rawNonfiniteCount);

  const points = [];
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
    if (xs[i] < minForwardM || xs[i] > maxForwardM) {
      audit.rejectedByXWindowCount++;
      bumpOutcome(audit, POINT_OUTCOMES.REJECTED_X_WINDOW);
      continue;
    }
    points.push({
      sourceIndex: i,
      x: xs[i],
      y: ys[i],
      z: Number.isFinite(zs[i]) ? zs[i] : 0,
      t: ts[i] ?? null,
    });
  }
  audit.afterXWindowCount = points.length;
  return { points, audit };
}

function extractDevicePoints(line, options = {}) {
  return extractDevicePointsWithAudit(line, options).points;
}

function findContiguousSourceRuns(points, maxGap = 1) {
  if (!points.length) return [];
  const sorted = [...points].sort((a, b) => a.sourceIndex - b.sourceIndex);
  const runs = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].sourceIndex - sorted[i - 1].sourceIndex;
    if (gap <= maxGap) current.push(sorted[i]);
    else {
      runs.push(current);
      current = [sorted[i]];
    }
  }
  runs.push(current);
  return runs;
}

function finalizePointAudit(audit, retainedPoints, projectedPoints) {
  const retained = retainedPoints || [];
  const projected = projectedPoints || [];
  audit.projectedPointCount = projected.length;
  audit.retainedPointFraction = audit.submittedToProjectionCount
    ? projected.length / audit.submittedToProjectionCount
    : 0;
  if (retained.length) {
    audit.firstRetainedDeviceX = retained[0].modelX ?? retained[0].x;
    audit.lastRetainedDeviceX = retained[retained.length - 1].modelX ?? retained[retained.length - 1].x;
  }
  if (projected.length) {
    audit.firstProjectedRouteS = projected[0].s;
    audit.lastProjectedRouteS = projected[projected.length - 1].s;
    audit.projectedRouteSpanM = audit.lastProjectedRouteS - audit.firstProjectedRouteS;
    const runs = findContiguousSourceRuns(projected);
    audit.fragmentedRunCount = runs.length;
    audit.isContiguousSourceRun = runs.length === 1;
    audit.nonMonotonicRouteS = false;
    audit.coordinateJumpCount = 0;
    for (let i = 1; i < projected.length; i++) {
      if (projected[i].s < projected[i - 1].s - 0.01) audit.nonMonotonicRouteS = true;
      const ds = Math.abs(projected[i].s - projected[i - 1].s);
      const idxGap = projected[i].sourceIndex - projected[i - 1].sourceIndex;
      if (idxGap > 1 && ds > 20) audit.coordinateJumpCount++;
    }
  }
  return audit;
}

function buildFragmentRecord(run, fragmentIndex, assessment) {
  const sVals = run.map((p) => p.s);
  const span = Math.max(...sVals) - Math.min(...sVals);
  const sourceIndices = run.map((p) => p.sourceIndex);
  return {
    fragmentIndex,
    pointCount: run.length,
    sourceIndexStart: Math.min(...sourceIndices),
    sourceIndexEnd: Math.max(...sourceIndices),
    routeSpanM: span,
    firstRouteS: Math.min(...sVals),
    lastRouteS: Math.max(...sVals),
    retainedPointFraction: null,
    passesAssessment: run.length >= assessment.minProjectedPoints
      && span >= assessment.minProjectedRouteSpanM,
    assessmentChecks: {
      minProjectedPoints: assessment.minProjectedPoints,
      minProjectedRouteSpanM: assessment.minProjectedRouteSpanM,
      maxInternalSourceIndexGap: assessment.maxInternalSourceIndexGap,
      requireMonotonicRouteS: assessment.requireMonotonicRouteS,
    },
    points: run.map((p) => ({
      sourceIndex: p.sourceIndex,
      s: p.s,
      d: p.d,
      east: p.east,
      north: p.north,
      modelX: p.modelX,
      modelY: p.modelY,
      perpDist: p.perpDist,
    })),
  };
}

function selectPrimaryFragment(fragments, assessment, submittedCount) {
  for (const f of fragments) {
    f.retainedPointFraction = submittedCount ? f.pointCount / submittedCount : 0;
  }
  const passing = fragments.filter((f) => f.pointCount >= assessment.minProjectedPoints
    && f.retainedPointFraction >= assessment.minRetainedPointFraction
    && f.routeSpanM >= assessment.minProjectedRouteSpanM);
  if (!passing.length) return { ok: false, primary: null, reason: 'no_fragment_passes_assessment' };
  passing.sort((a, b) => b.routeSpanM - a.routeSpanM || b.pointCount - a.pointCount);
  return { ok: true, primary: passing[0], all: fragments };
}

function assessSourceLine(index, line, prob, std, opts = {}) {
  const o = { ...ASSESSMENT_THRESHOLDS, ...opts };
  const ob = evaluateLineObservation(index, line, prob, std, o);
  const extracted = extractDevicePointsWithAudit(line, o);
  const deviceFramePoints = extracted.points;
  const extractionAudit = extracted.audit;
  const reasons = [];

  if (ob.malformed) reasons.push('malformed_geometry');
  if (ob.missingEval) reasons.push('unevaluable_at_10m');
  if (ob.crossing) reasons.push('ordering_or_crossing');
  if (!hasMonotonicForwardX(line?.x || [])) reasons.push('non_monotonic_forward_x');
  if (deviceFramePoints.length < 2) reasons.push('insufficient_points');

  let status = null;
  if (ob.malformed || ob.missingEval || ob.crossing || deviceFramePoints.length < 2) {
    status = PROJECTION_STATUSES.REJECTED_INVALID_GEOMETRY;
  } else if (ob.prob < o.assessmentMinProb) {
    status = PROJECTION_STATUSES.REJECTED_LOW_ASSESSMENT_CONFIDENCE;
    reasons.push('confidence_below_assessment_threshold');
  } else if (ob.std != null && ob.std > o.assessmentMaxStdM) {
    status = PROJECTION_STATUSES.REJECTED_EXCESSIVE_ASSESSMENT_UNCERTAINTY;
    reasons.push('uncertainty_above_assessment_threshold');
  }

  return {
    observation: ob,
    deviceFramePoints,
    extractionAudit,
    rejectionReasons: [...new Set(reasons)],
    preProjectionStatus: status,
    assessmentValidity: {
      eligibleGeometry: ob.eligibleGeometry && deviceFramePoints.length >= 2,
      passesAssessmentConfidence: ob.prob >= o.assessmentMinProb,
      passesAssessmentUncertainty: ob.std == null || ob.std <= o.assessmentMaxStdM,
      assessmentThresholdsLabel: 'Stage15A assessment-only (not production)',
      assessmentMinProb: o.assessmentMinProb,
      assessmentMaxStdM: o.assessmentMaxStdM,
    },
  };
}

function buildFrameContextIndex(routeResult) {
  const index = new Map();
  for (const chunk of routeResult.routeChunks || []) {
    for (const frame of chunk.frames || []) {
      index.set(frameKey(frame.sourceFile, frame.logMonoTime), {
        chunkId: frame.chunkId ?? chunk.chunkId,
        temporalPassId: frame.passId ?? frame.temporalPassId ?? 0,
        poseSectionId: frame.poseSectionId ?? 0,
        pose: frame.pose || null,
        frameId: frame.frameId,
        sourceEventIndex: frame.sourceEventIndex,
        poseContinuityStatus: frame.poseContinuityStatus,
        poseRejectionReason: frame.poseRejectionReason,
        movementState: frame.movementState,
        vehicleRelative: !!frame.vehicleRelative,
      });
    }
  }
  return index;
}

function buildSectionTrajectoryMap(chunk) {
  const map = new Map();
  const path = chunk.vehiclePath || [];
  const groups = new Map();
  for (const pt of path) {
    const passId = pt.passId ?? pt.temporalPassId ?? 0;
    const sectionId = pt.poseSectionId ?? 0;
    const key = `${passId}:${sectionId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pt);
  }
  for (const [key, pts] of groups.entries()) {
    if (pts.length >= 2) {
      map.set(key, buildReferenceTrajectory(pts));
    }
  }
  return map;
}

function projectDevicePointsDetailed(deviceFramePoints, pose, trajectory, logMonoTime, options = {}) {
  const assessment = { ...DEFAULT_FRAGMENT_ASSESSMENT, ...options };
  const audit = emptyPointAudit();
  audit.submittedToProjectionCount = deviceFramePoints.length;
  const vehicleS = vehicleSAtTimeTemporal(trajectory, logMonoTime);
  const projectedCandidates = [];
  const pointResults = [];

  for (let i = 0; i < deviceFramePoints.length; i++) {
    const pt = deviceFramePoints[i];
    const sourceIndex = pt.sourceIndex ?? i;
    const g = modelToGlobal(pt.x, pt.y, pose.east, pose.north, pose.headingDeg ?? 0);
    if (!Number.isFinite(g.east) || !Number.isFinite(g.north)) {
      audit.rejectedNonfiniteCount++;
      bumpOutcome(audit, POINT_OUTCOMES.REJECTED_NONFINITE_OUTPUT);
      pointResults.push({ sourceIndex, outcome: POINT_OUTCOMES.REJECTED_NONFINITE_OUTPUT });
      continue;
    }
    const proj = projectPointTemporal(trajectory, g.east, g.north, logMonoTime, options);
    if (!proj.valid || proj.ambiguous) {
      audit.rejectedPoseUnavailableCount++;
      bumpOutcome(audit, POINT_OUTCOMES.REJECTED_POSE_UNAVAILABLE);
      pointResults.push({ sourceIndex, outcome: POINT_OUTCOMES.REJECTED_POSE_UNAVAILABLE, reason: proj.reason });
      continue;
    }
    if (proj.perpDist > assessment.maxProjectionDistM) {
      audit.rejectedPerpDistCount++;
      bumpOutcome(audit, POINT_OUTCOMES.REJECTED_PERP_DIST);
      pointResults.push({ sourceIndex, outcome: POINT_OUTCOMES.REJECTED_PERP_DIST, perpDist: proj.perpDist });
      continue;
    }
    if (proj.s < vehicleS - assessment.backwardToleranceM || proj.s > vehicleS + assessment.maxForwardM) {
      audit.rejectedForwardWindowCount++;
      bumpOutcome(audit, POINT_OUTCOMES.REJECTED_FORWARD_WINDOW);
      pointResults.push({ sourceIndex, outcome: POINT_OUTCOMES.REJECTED_FORWARD_WINDOW });
      continue;
    }
    const projected = {
      sourceIndex,
      east: g.east,
      north: g.north,
      s: proj.s,
      d: proj.d,
      modelX: pt.x,
      modelY: pt.y,
      modelZ: pt.z,
      perpDist: proj.perpDist,
    };
    projectedCandidates.push(projected);
    pointResults.push({ sourceIndex, outcome: POINT_OUTCOMES.PROJECTED, pendingFragment: true });
  }

  const runs = findContiguousSourceRuns(projectedCandidates, assessment.maxInternalSourceIndexGap);
  const fragments = runs.map((run, i) => buildFragmentRecord(run, i, assessment));
  const selection = selectPrimaryFragment(fragments, assessment, deviceFramePoints.length);

  if (!selection.ok) {
    for (const c of projectedCandidates) {
      audit.rejectedFragmentDiscardedCount++;
      bumpOutcome(audit, POINT_OUTCOMES.REJECTED_FRAGMENT_DISCARDED);
    }
    finalizePointAudit(audit, [], []);
    return {
      ok: false,
      reason: PROJECTION_STATUSES.REJECTED_FRAGMENT_POLICY,
      detail: selection.reason,
      pointAudit: audit,
      projectionFragments: fragments,
      pointResults,
      skippedPointCount: deviceFramePoints.length - projectedCandidates.length,
    };
  }

  const primary = selection.primary;
  const primarySourceIndices = new Set(primary.points.map((p) => p.sourceIndex));
  const retained = projectedCandidates.filter((p) => primarySourceIndices.has(p.sourceIndex));
  const discarded = projectedCandidates.filter((p) => !primarySourceIndices.has(p.sourceIndex));
  for (const d of discarded) {
    audit.rejectedFragmentDiscardedCount++;
    bumpOutcome(audit, POINT_OUTCOMES.REJECTED_FRAGMENT_DISCARDED);
    const pr = pointResults.find((r) => r.sourceIndex === d.sourceIndex && r.pendingFragment);
    if (pr) pr.outcome = POINT_OUTCOMES.REJECTED_FRAGMENT_DISCARDED;
  }
  bumpOutcome(audit, POINT_OUTCOMES.PROJECTED, retained.length);

  if (assessment.requireMonotonicRouteS) {
    for (let i = 1; i < retained.length; i++) {
      if (retained[i].s < retained[i - 1].s - 0.01) {
        finalizePointAudit(audit, retained, retained);
        return {
          ok: false,
          reason: PROJECTION_STATUSES.REJECTED_FRAGMENT_POLICY,
          detail: 'non_monotonic_route_s',
          pointAudit: audit,
          projectionFragments: fragments,
          pointResults,
        };
      }
    }
  }

  if (retained.length < assessment.minProjectedPoints) {
    finalizePointAudit(audit, retained, retained);
    return {
      ok: false,
      reason: PROJECTION_STATUSES.REJECTED_FRAGMENT_POLICY,
      detail: 'insufficient_primary_fragment_points',
      pointAudit: audit,
      projectionFragments: fragments,
      pointResults,
    };
  }

  for (const p of retained) {
    if (!Number.isFinite(p.s) || !Number.isFinite(p.d) || !Number.isFinite(p.east) || !Number.isFinite(p.north)) {
      return { ok: false, reason: PROJECTION_STATUSES.REJECTED_NONFINITE_OUTPUT, pointAudit: audit };
    }
  }

  audit.projectedPointCount = retained.length;
  finalizePointAudit(audit, retained, retained);

  return {
    ok: true,
    projectedRoutePoints: retained,
    projectionFragments: fragments,
    primaryFragmentIndex: primary.fragmentIndex,
    pointAudit: audit,
    pointResults,
    vehicleS,
    skippedPointCount: deviceFramePoints.length - retained.length,
  };
}

function projectDevicePoints(deviceFramePoints, pose, trajectory, logMonoTime, options = {}) {
  const r = projectDevicePointsDetailed(deviceFramePoints, pose, trajectory, logMonoTime, options);
  if (!r.ok) {
    return {
      ok: false,
      reason: r.reason,
      detail: r.detail,
      skippedCount: r.skippedPointCount,
    };
  }
  return {
    ok: true,
    projectedRoutePoints: r.projectedRoutePoints,
    vehicleS: r.vehicleS,
    skippedPointCount: r.skippedPointCount,
  };
}

function mergePointAudits(extraction, projection) {
  if (!projection) return extraction;
  const merged = { ...extraction, ...projection };
  merged.rawSourcePointCount = extraction.rawSourcePointCount;
  merged.rawNonfiniteCount = extraction.rawNonfiniteCount;
  merged.rejectedByXWindowCount = extraction.rejectedByXWindowCount;
  merged.afterXWindowCount = extraction.afterXWindowCount;
  merged.pointOutcomes = { ...extraction.pointOutcomes };
  for (const [k, v] of Object.entries(projection.pointOutcomes || {})) {
    merged.pointOutcomes[k] = (merged.pointOutcomes[k] || 0) + v;
  }
  merged.submittedToProjectionCount = projection.submittedToProjectionCount ?? extraction.submittedToProjectionCount;
  return merged;
}

function decodeAndProjectObservation({
  segmentId,
  modelEvent,
  slotIndex,
  inferredSlotRole,
  frameContext,
  sectionTrajectories,
  options = {},
}) {
  const mv = modelEvent.modelV2 || {};
  const lines = mv.laneLines || [];
  const probs = mv.laneLineProbs || [];
  const stds = mv.laneLineStds || [];
  const line = lines[slotIndex] || null;
  const assessment = assessSourceLine(slotIndex, line, probs[slotIndex], stds[slotIndex], options);
  const pointAudit = { ...assessment.extractionAudit, pointOutcomes: { ...assessment.extractionAudit.pointOutcomes } };

  const record = {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    processingVersion: STAGE16_PROCESSING_VERSION,
    frozenBaselineVersion: options.frozenBaselineVersion,
    frozenV11ProcessingVersion: options.frozenV11ProcessingVersion,
    segmentId,
    chunkId: frameContext?.chunkId ?? null,
    sourceFile: modelEvent.sourceFile,
    sourceEventIndex: modelEvent.sourceEventIndex,
    sourceFrameId: frameContext?.frameId ?? mv.frameId ?? null,
    logMonoTime: modelEvent.logMonoTime,
    temporalPassId: frameContext?.temporalPassId ?? null,
    poseSectionId: frameContext?.poseSectionId ?? null,
    sourceSlotIndex: slotIndex,
    inferredSlotRole: inferredSlotRole || 'unknown',
    laneLineProb: probs[slotIndex] ?? null,
    laneLineStd: stds[slotIndex] ?? null,
    assessmentValidity: assessment.assessmentValidity,
    projectionStatus: assessment.preProjectionStatus,
    rejectionReasons: [...assessment.rejectionReasons],
    pointAudit,
    projectionFragments: [],
    deviceFramePoints: assessment.deviceFramePoints.map((p) => ({ ...p })),
    projectedRoutePoints: [],
    poseRecord: null,
    transformMetadata: {
      ...TRANSFORM_CONVENTIONS,
      assessmentThresholds: { ...ASSESSMENT_THRESHOLDS },
      fragmentAssessment: { ...DEFAULT_FRAGMENT_ASSESSMENT },
    },
    provenance: {
      pipelineStage: 'stage16_lane_line_projection',
      createdAt: options.createdAt || new Date().toISOString(),
      notes: 'Dataset-specific slot role metadata; not universal truth',
    },
  };

  if (assessment.preProjectionStatus) {
    pointAudit.inObservationRejectedCount = pointAudit.afterXWindowCount;
    pointAudit.submittedToProjectionCount = 0;
    bumpOutcome(pointAudit, POINT_OUTCOMES.IN_OBSERVATION_REJECTED, pointAudit.afterXWindowCount);
    return record;
  }

  if (!frameContext) {
    record.projectionStatus = PROJECTION_STATUSES.REJECTED_MISSING_POSE;
    record.rejectionReasons.push('no_matching_processed_frame');
    pointAudit.inObservationRejectedCount = pointAudit.afterXWindowCount;
    bumpOutcome(pointAudit, POINT_OUTCOMES.IN_OBSERVATION_REJECTED, pointAudit.afterXWindowCount);
    return record;
  }

  if (frameContext.vehicleRelative || !frameContext.pose) {
    record.projectionStatus = PROJECTION_STATUSES.REJECTED_MISSING_POSE;
    record.rejectionReasons.push('global_pose_unavailable');
    pointAudit.inObservationRejectedCount = pointAudit.afterXWindowCount;
    bumpOutcome(pointAudit, POINT_OUTCOMES.IN_OBSERVATION_REJECTED, pointAudit.afterXWindowCount);
    return record;
  }

  if (frameContext.poseRejectionReason || frameContext.poseContinuityStatus === 'sectionStartAfterRejection') {
    record.projectionStatus = PROJECTION_STATUSES.REJECTED_POSE_GAP;
    record.rejectionReasons.push(frameContext.poseRejectionReason || 'pose_section_break');
    pointAudit.inObservationRejectedCount = pointAudit.afterXWindowCount;
    bumpOutcome(pointAudit, POINT_OUTCOMES.IN_OBSERVATION_REJECTED, pointAudit.afterXWindowCount);
    return record;
  }

  const trajKey = `${frameContext.temporalPassId}:${frameContext.poseSectionId}`;
  const trajectory = sectionTrajectories.get(trajKey);
  if (!trajectory) {
    record.projectionStatus = PROJECTION_STATUSES.REJECTED_POSE_SECTION_BOUNDARY;
    record.rejectionReasons.push('no_section_trajectory');
    pointAudit.inObservationRejectedCount = pointAudit.afterXWindowCount;
    bumpOutcome(pointAudit, POINT_OUTCOMES.IN_OBSERVATION_REJECTED, pointAudit.afterXWindowCount);
    return record;
  }

  record.poseRecord = {
    east: frameContext.pose.east,
    north: frameContext.pose.north,
    headingDeg: frameContext.pose.headingDeg,
    headingSource: frameContext.pose.headingSource,
    speed: frameContext.pose.speed,
    horizontalAccuracy: frameContext.pose.horizontalAccuracy,
    interpolated: frameContext.pose.interpolated ?? null,
    trajectoryKey: trajKey,
  };

  const proj = projectDevicePointsDetailed(
    assessment.deviceFramePoints,
    frameContext.pose,
    trajectory,
    modelEvent.logMonoTime,
    options,
  );

  record.pointAudit = mergePointAudits(pointAudit, proj.pointAudit);
  record.projectionFragments = proj.projectionFragments || [];

  if (!proj.ok) {
    record.projectionStatus = proj.reason;
    record.rejectionReasons.push(proj.detail || proj.reason);
    if (record.pointAudit.pointOutcomes?.[POINT_OUTCOMES.PROJECTED]) {
      const orphan = record.pointAudit.pointOutcomes[POINT_OUTCOMES.PROJECTED];
      delete record.pointAudit.pointOutcomes[POINT_OUTCOMES.PROJECTED];
      record.pointAudit.pointOutcomes[POINT_OUTCOMES.REJECTED_FRAGMENT_DISCARDED] =
        (record.pointAudit.pointOutcomes[POINT_OUTCOMES.REJECTED_FRAGMENT_DISCARDED] || 0) + orphan;
    }
    record.pointAudit.projectedPointCount = 0;
    if (!record.pointAudit.inObservationRejectedCount) {
      record.pointAudit.submittedToProjectionCount = assessment.deviceFramePoints.length;
    }
    return record;
  }

  record.projectionStatus = PROJECTION_STATUSES.PROJECTED;
  record.projectedRoutePoints = proj.projectedRoutePoints;
  record.primaryFragmentIndex = proj.primaryFragmentIndex;
  return record;
}

function projectSegment({
  segmentId,
  filename,
  modelEvents,
  routeResult,
  slotRoleByIndex,
  options = {},
}) {
  const frameIndex = buildFrameContextIndex(routeResult);
  const observations = [];
  const chunkTrajectoryMaps = new Map();

  for (const chunk of routeResult.routeChunks || []) {
    chunkTrajectoryMaps.set(chunk.chunkId, buildSectionTrajectoryMap(chunk));
  }

  for (const ev of modelEvents) {
    if (ev.sourceFile !== filename) continue;
    const ctx = frameIndex.get(frameKey(ev.sourceFile, ev.logMonoTime));
    const chunkId = ctx?.chunkId ?? 0;
    const sectionTrajectories = chunkTrajectoryMaps.get(chunkId) || new Map();

    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      observations.push(decodeAndProjectObservation({
        segmentId,
        modelEvent: ev,
        slotIndex: slot,
        inferredSlotRole: slotRoleByIndex?.[slot] || 'unknown',
        frameContext: ctx,
        sectionTrajectories,
        options,
      }));
    }
  }

  return observations;
}

function summarizePointLevelAccounting(observations) {
  const totals = {
    rawDecodedDevicePoints: 0,
    rawNonfinitePoints: 0,
    rejectedByXWindow: 0,
    afterXWindow: 0,
    inObservationRejected: 0,
    submittedToProjection: 0,
    projected: 0,
    rejectedPerpDist: 0,
    rejectedPoseUnavailable: 0,
    rejectedForwardWindow: 0,
    rejectedNonfiniteOutput: 0,
    rejectedFragmentDiscarded: 0,
    byOutcome: {},
  };

  for (const ob of observations) {
    const pa = ob.pointAudit || {};
    totals.rawDecodedDevicePoints += pa.rawSourcePointCount || 0;
    totals.rawNonfinitePoints += pa.rawNonfiniteCount || 0;
    totals.rejectedByXWindow += pa.rejectedByXWindowCount || 0;
    totals.afterXWindow += pa.afterXWindowCount || 0;
    totals.inObservationRejected += pa.inObservationRejectedCount || 0;
    totals.submittedToProjection += pa.submittedToProjectionCount || 0;
    totals.projected += pa.projectedPointCount || 0;
    totals.rejectedPerpDist += pa.rejectedPerpDistCount || 0;
    totals.rejectedPoseUnavailable += pa.rejectedPoseUnavailableCount || 0;
    totals.rejectedForwardWindow += pa.rejectedForwardWindowCount || 0;
    totals.rejectedNonfiniteOutput += pa.rejectedNonfiniteCount || 0;
    totals.rejectedFragmentDiscarded += pa.rejectedFragmentDiscardedCount || 0;
    for (const [k, v] of Object.entries(pa.pointOutcomes || {})) {
      totals.byOutcome[k] = (totals.byOutcome[k] || 0) + v;
    }
  }

  const accounted = Object.values(totals.byOutcome).reduce((a, b) => a + b, 0);
  const expected = totals.rawDecodedDevicePoints;
  const reconciliationDelta = expected - accounted;

  return {
    ...totals,
    accountedPoints: accounted,
    expectedRawPoints: expected,
    reconciliationPassed: reconciliationDelta === 0,
    reconciliationDelta,
    pctProjectedOfSubmitted: totals.submittedToProjection
      ? `${totals.projected} / ${totals.submittedToProjection} (${(totals.projected / totals.submittedToProjection * 100).toFixed(1)}%)`
      : '0 / 0',
    pctAfterXWindowOfRaw: totals.rawDecodedDevicePoints
      ? `${totals.afterXWindow} / ${totals.rawDecodedDevicePoints} (${(totals.afterXWindow / totals.rawDecodedDevicePoints * 100).toFixed(1)}%)`
      : '0 / 0',
  };
}

function medianOf(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function accumulateQualityBucket(map, key, ob) {
  if (!map.has(key)) {
    map.set(key, {
      totalObservations: 0,
      projectedObservations: 0,
      sourcePointsAfterX: 0,
      projectedPoints: 0,
      routeSpans: [],
      retainedFractions: [],
      fragmentedRunCount: 0,
      nonMonotonicRouteSCount: 0,
      coordinateJumpCount: 0,
    });
  }
  const b = map.get(key);
  b.totalObservations++;
  const pa = ob.pointAudit || {};
  b.sourcePointsAfterX += pa.afterXWindowCount || 0;
  if (ob.projectionStatus === PROJECTION_STATUSES.PROJECTED) {
    b.projectedObservations++;
    b.projectedPoints += pa.projectedPointCount || 0;
    if (pa.projectedRouteSpanM != null) b.routeSpans.push(pa.projectedRouteSpanM);
    if (pa.retainedPointFraction != null) b.retainedFractions.push(pa.retainedPointFraction);
    if ((pa.fragmentedRunCount || 0) > 1) b.fragmentedRunCount++;
    if (pa.nonMonotonicRouteS) b.nonMonotonicRouteSCount++;
    b.coordinateJumpCount += pa.coordinateJumpCount || 0;
  }
}

function finalizeQualityBucket(b) {
  return {
    totalObservations: b.totalObservations,
    projectedObservations: b.projectedObservations,
    observationProjectionRate: b.totalObservations ? b.projectedObservations / b.totalObservations : 0,
    sourcePointsAfterX: b.sourcePointsAfterX,
    projectedPoints: b.projectedPoints,
    pointRetentionRate: b.sourcePointsAfterX ? b.projectedPoints / b.sourcePointsAfterX : 0,
    medianProjectedRouteSpanM: medianOf(b.routeSpans),
    medianRetainedPointFraction: medianOf(b.retainedFractions),
    fragmentedRunCount: b.fragmentedRunCount,
    nonMonotonicRouteSCount: b.nonMonotonicRouteSCount,
    coordinateJumpCount: b.coordinateJumpCount,
  };
}

function computeProjectionQualitySummaries(observations) {
  const bySegment = new Map();
  const byChunk = new Map();
  const bySlot = new Map();
  const byPass = new Map();
  const bySection = new Map();

  for (const ob of observations) {
    accumulateQualityBucket(bySegment, ob.segmentId ?? 'unknown', ob);
    accumulateQualityBucket(byChunk, ob.chunkId ?? 'unknown', ob);
    accumulateQualityBucket(bySlot, ob.sourceSlotIndex ?? 'unknown', ob);
    accumulateQualityBucket(byPass, ob.temporalPassId ?? 'unknown', ob);
    accumulateQualityBucket(bySection, ob.poseSectionId ?? 'unknown', ob);
  }

  const toObj = (m) => Object.fromEntries([...m.entries()].map(([k, v]) => [k, finalizeQualityBucket(v)]));
  return {
    bySegment: toObj(bySegment),
    byChunk: toObj(byChunk),
    bySlot: toObj(bySlot),
    byPass: toObj(byPass),
    byPoseSection: toObj(bySection),
  };
}

function summarizeObservations(observations) {
  const byStatus = {};
  const bySlot = {};
  const byRole = {};
  const byChunk = {};
  const byPass = {};
  const bySection = {};
  let projectedPoints = 0;
  let sourcePoints = 0;
  let rawDecodedPoints = 0;
  let nonfinite = 0;
  let fragmentedProjected = 0;

  const framesProjected = new Set();
  const framesWithAny = new Set();

  for (const ob of observations) {
    byStatus[ob.projectionStatus] = (byStatus[ob.projectionStatus] || 0) + 1;
    const slot = ob.sourceSlotIndex;
    bySlot[slot] = bySlot[slot] || { total: 0, projected: 0 };
    bySlot[slot].total++;
    if (ob.projectionStatus === PROJECTION_STATUSES.PROJECTED) bySlot[slot].projected++;

    const role = ob.inferredSlotRole || 'unknown';
    byRole[role] = byRole[role] || { total: 0, projected: 0 };
    byRole[role].total++;
    if (ob.projectionStatus === PROJECTION_STATUSES.PROJECTED) byRole[role].projected++;

    const ck = ob.chunkId ?? 'unknown';
    byChunk[ck] = byChunk[ck] || { total: 0, projected: 0 };
    byChunk[ck].total++;
    if (ob.projectionStatus === PROJECTION_STATUSES.PROJECTED) byChunk[ck].projected++;

    const pk = ob.temporalPassId ?? 'unknown';
    byPass[pk] = byPass[pk] || { total: 0, projected: 0 };
    byPass[pk].total++;
    if (ob.projectionStatus === PROJECTION_STATUSES.PROJECTED) byPass[pk].projected++;

    const sk = ob.poseSectionId ?? 'unknown';
    bySection[sk] = bySection[sk] || { total: 0, projected: 0 };
    bySection[sk].total++;
    if (ob.projectionStatus === PROJECTION_STATUSES.PROJECTED) bySection[sk].projected++;

    const pa = ob.pointAudit || {};
    sourcePoints += pa.afterXWindowCount || ob.deviceFramePoints.length;
    rawDecodedPoints += pa.rawSourcePointCount || 0;
    if (ob.projectionStatus === PROJECTION_STATUSES.PROJECTED) {
      projectedPoints += ob.projectedRoutePoints.length;
      if (pa.fragmentedRunCount > 1 || pa.isContiguousSourceRun === false) fragmentedProjected++;
      framesProjected.add(`${ob.sourceFile}|${ob.logMonoTime}`);
    }
    framesWithAny.add(`${ob.sourceFile}|${ob.logMonoTime}`);
    if (ob.projectionStatus === PROJECTION_STATUSES.REJECTED_NONFINITE_OUTPUT) nonfinite++;
  }

  const total = observations.length;
  const projected = byStatus[PROJECTION_STATUSES.PROJECTED] || 0;
  const pointAccounting = summarizePointLevelAccounting(observations);
  const qualitySummaries = computeProjectionQualitySummaries(observations);

  return {
    decodedObservations: total,
    projectedObservations: projected,
    rejectedObservations: total - projected,
    projectedFrames: framesProjected.size,
    framesWithObservations: framesWithAny.size,
    byStatus,
    bySlot,
    byRole,
    byChunk,
    byPass,
    bySection,
    rawDecodedDevicePointCount: rawDecodedPoints,
    sourcePointCount: sourcePoints,
    projectedPointCount: projectedPoints,
    pointAccounting,
    qualitySummaries,
    fragmentedProjectedObservations: fragmentedProjected,
    nonfiniteOutputCount: nonfinite,
    poseGapCount: byStatus[PROJECTION_STATUSES.REJECTED_POSE_GAP] || 0,
    fragmentPolicyRejections: byStatus[PROJECTION_STATUSES.REJECTED_FRAGMENT_POLICY] || 0,
    boundaryRejectionCount:
      (byStatus[PROJECTION_STATUSES.REJECTED_PASS_BOUNDARY] || 0)
      + (byStatus[PROJECTION_STATUSES.REJECTED_POSE_SECTION_BOUNDARY] || 0),
    pctProjected: total ? projected / total : 0,
  };
}

function verifyProjectionConsistency(observations, options = {}) {
  const errors = [];
  const seen = new Map();
  const expectedProjected = options.expectedProjectedObservations;
  const expectedTotal = options.expectedTotalObservations;
  const expectedProjectedPoints = options.expectedProjectedPoints;

  let projectedCount = 0;
  let projectedPointCount = 0;

  for (const ob of observations) {
    const id = `${ob.segmentId}:${ob.chunkId}:${ob.logMonoTime}:${ob.sourceSlotIndex}`;
    if (seen.has(id)) errors.push(`duplicate observation ${id}`);
    seen.set(id, ob);

    if (ob.projectionStatus === PROJECTION_STATUSES.PROJECTED) {
      projectedCount++;
      projectedPointCount += ob.projectedRoutePoints.length;
      if (ob.projectedRoutePoints.length < 2) errors.push(`projected status with <2 points: ${id}`);
      if (!ob.pointAudit?.isContiguousSourceRun) {
        errors.push(`projected polyline not contiguous source run: ${id}`);
      }
      for (const p of ob.projectedRoutePoints) {
        if (!Number.isFinite(p.s) || !Number.isFinite(p.d)) errors.push(`nonfinite s/d: ${id}`);
      }
      for (const frag of ob.projectionFragments || []) {
        const pass = ob.temporalPassId;
        const section = ob.poseSectionId;
        if (frag.crossesPassBoundary || frag.crossesPoseSectionBoundary) {
          errors.push(`fragment crosses boundary: ${id}`);
        }
        void pass; void section;
      }
    } else if (ob.projectedRoutePoints.length > 0) {
      errors.push(`rejected status with projected points: ${id}`);
    }

    const pa = ob.pointAudit || {};
    const outcomeSum = Object.values(pa.pointOutcomes || {}).reduce((a, b) => a + b, 0);
    if (pa.rawSourcePointCount > 0 && outcomeSum !== pa.rawSourcePointCount) {
      errors.push(`point outcome mismatch for ${id}: ${outcomeSum} vs ${pa.rawSourcePointCount}`);
    }
  }

  const pointAccounting = summarizePointLevelAccounting(observations);
  if (!pointAccounting.reconciliationPassed) {
    errors.push(`dataset point reconciliation failed: delta=${pointAccounting.reconciliationDelta}`);
  }

  if (expectedTotal != null && observations.length !== expectedTotal) {
    errors.push(`observation count ${observations.length} != ${expectedTotal}`);
  }
  if (expectedProjected != null && projectedCount !== expectedProjected) {
    errors.push(`projected observation count ${projectedCount} != ${expectedProjected}`);
  }
  if (expectedProjectedPoints != null && projectedPointCount !== expectedProjectedPoints) {
    errors.push(`projected point count ${projectedPointCount} != ${expectedProjectedPoints}`);
  }

  return {
    passed: errors.length === 0,
    errors,
    projectedObservationCount: projectedCount,
    projectedPointCount,
    pointAccounting,
  };
}

module.exports = {
  SLOT_COUNT,
  segmentIdFromFilename,
  frameKey,
  assessSourceLine,
  buildFrameContextIndex,
  buildSectionTrajectoryMap,
  projectDevicePoints,
  projectDevicePointsDetailed,
  decodeAndProjectObservation,
  projectSegment,
  summarizeObservations,
  summarizePointLevelAccounting,
  computeProjectionQualitySummaries,
  verifyProjectionConsistency,
  hasMonotonicForwardX,
  extractDevicePoints,
  extractDevicePointsWithAudit,
  findContiguousSourceRuns,
  emptyPointAudit,
  countRawDevicePoints,
  DEFAULT_FRAGMENT_ASSESSMENT,
  POINT_OUTCOMES,
};
