'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { config } = require('./stage19_spec/config');
const { parseObservationEndpoint, finitePoints, serializePlaybackFrame } = require('./stage20_b_motion_review_playback');
const {
  joinAutomaticAndManual,
  deriveAutomaticContinuationDecision,
  manualLabelToBinary,
  buildConfusionMatrix,
  THRESHOLD_CAP_M,
} = require('./stage20_b_motion_baseline_compare');

const MANUAL_RECHECK_INDEX = 207;
const ANCHOR_MODEL_X_M = 15;
const PRODUCTION_RESIDUAL_CAP_M = THRESHOLD_CAP_M;
const OFFLINE_VECTOR_THRESHOLD_SWEEP_M = Object.freeze([3, 5, 8, 10, 12, 15, 20]);
const ROAD_EDGE_PROXIMITY_M = 0.5;
const ROAD_EDGE_OVERLAP_M = 0.35;

const DEFAULT_INPUTS = Object.freeze({
  manualReviewsPath: 'deliverables/stage20-b-motion-manual-reviews-qc-v1.json',
  automaticManifestPath: 'deliverables/stage20-b-motion-evidence-review-manifest.json',
  baselineComparisonPath: 'deliverables/stage20-b-motion-baseline-comparison.json',
  baselineDisagreementsPath: 'deliverables/stage20-b-motion-baseline-disagreements.json',
  stage21ErrorAnalysisPath: 'deliverables/stage21-b-motion-error-analysis.json',
  stage21RecheckListPath: 'deliverables/stage21-b-motion-manual-recheck-list.json',
});

const CANDIDATE_CONFIGS = Object.freeze([
  { id: 'A', name: 'existing_baseline_rule', description: 'Production shadow: boundary gates + scalar residualAfterPoseM <= 12 m' },
  { id: 'B', name: 'vector_pose_compensated_anchor_only', description: 'Boundary gates + Euclidean pose-compensated anchor residual <= 12 m' },
  { id: 'C', name: 'baseline_plus_strong_crossing', description: 'Baseline accept AND NOT strong crossing evidence' },
  { id: 'D', name: 'vector_plus_strong_crossing', description: 'Config B accept AND NOT strong crossing evidence' },
  { id: 'E', name: 'vector_plus_side_swap', description: 'Config B accept AND NOT strong side-swap evidence' },
  { id: 'F', name: 'vector_plus_rank_soft', description: 'Config B accept unless rank unstable AND vector residual <= 12 m (soft, not unconditional)' },
  { id: 'G', name: 'multi_signal_candidate', description: 'Vector residual + crossing + side + soft rank + road-edge association (no unconditional rank reject)' },
]);

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function rotateToVehicleFrame(v, headingDeg) {
  const rad = (headingDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    longitudinal: v.x * cos + v.y * sin,
    lateral: -v.x * sin + v.y * cos,
    rotationOrder: 'heading_at_frame_A_counterclockwise_from_east_north',
  };
}

function findNearestFrameIndex(timeline, logMonoTime) {
  if (!timeline?.length || logMonoTime == null) return null;
  const target = BigInt(logMonoTime);
  let best = 0;
  let bestDiff = null;
  for (let i = 0; i < timeline.length; i++) {
    const t = BigInt(timeline[i].logMonoTime);
    const diff = t > target ? t - target : target - t;
    if (bestDiff == null || diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

function tryLoadQlogPayloadWithPose(root, qlogReference) {
  if (!qlogReference) return { ok: false, reason: 'no_qlog_reference' };
  const filePath = path.join(root, qlogReference);
  if (!fs.existsSync(filePath)) return { ok: false, reason: 'qlog_not_in_workspace' };

  try {
    const { processRoute, buildTimeline } = require('./process_route');
    const { extractFromFile: extractModel } = require('../extract_modelv2');
    const { extractFromFile: extractGps } = require('../extract_gps');
    const modelEvents = extractModel(filePath).map((e) => ({ ...e, sourceFile: qlogReference }));
    const gpsEvents = extractGps(filePath).map((e) => ({ ...e, sourceFile: qlogReference }));
    const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
    const timeline = buildTimeline(result.frames);
    const frames = (result.frames || []).map((f, i) => {
      const serialized = serializePlaybackFrame(f, i);
      serialized.pose = f.pose
        ? {
          east: f.pose.east,
          north: f.pose.north,
          headingDeg: f.pose.headingDeg,
          speed: f.pose.speed,
        }
        : null;
      return serialized;
    });
    return {
      ok: true,
      frames,
      timeline: (timeline || []).map((f, i) => ({ index: i, logMonoTime: String(f.logMonoTime) })),
    };
  } catch (err) {
    return { ok: false, reason: 'qlog_processing_failed', error: err.message };
  }
}

function anchorPointOnLane(lane, anchorX = ANCHOR_MODEL_X_M) {
  const points = finitePoints(lane.points);
  if (!points.length) return { available: false, reason: 'no_finite_points' };
  if (points.length === 1) {
    return {
      available: true,
      east: points[0].x,
      north: points[0].y,
      method: 'single_point_fallback',
      interpolated: false,
    };
  }

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const minX = Math.min(p0.x, p1.x);
    const maxX = Math.max(p0.x, p1.x);
    if (anchorX >= minX && anchorX <= maxX && p1.x !== p0.x) {
      const t = (anchorX - p0.x) / (p1.x - p0.x);
      return {
        available: true,
        east: +(p0.x + t * (p1.x - p0.x)).toFixed(6),
        north: +(p0.y + t * (p1.y - p0.y)).toFixed(6),
        method: 'linear_interpolation_along_lane_polyline',
        interpolated: true,
      };
    }
  }

  let best = points[0];
  let bestDist = Math.abs(points[0].x - anchorX);
  for (const p of points) {
    const d = Math.abs(p.x - anchorX);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return {
    available: true,
    east: best.x,
    north: best.y,
    method: 'nearest_point_fallback',
    interpolated: false,
    nearestDeltaX: +bestDist.toFixed(6),
  };
}

function findLaneBySlot(frame, sourceSlotIndex) {
  for (const lane of frame?.laneLines || []) {
    if (lane.laneIndex === sourceSlotIndex) return lane;
  }
  return null;
}

function laneLateralsAtAnchor(frame) {
  const out = [];
  for (const lane of frame?.laneLines || []) {
    const anchor = anchorPointOnLane(lane);
    if (anchor.available) out.push({ laneIndex: lane.laneIndex, lateral: anchor.north, east: anchor.east });
  }
  out.sort((a, b) => b.lateral - a.lateral);
  return out;
}

function deriveRankFromLaterals(laterals, sourceSlotIndex) {
  const idx = laterals.findIndex((l) => l.laneIndex === sourceSlotIndex);
  if (idx < 0) return { available: false, reason: 'target_not_in_laterals' };
  return {
    available: true,
    rankFromTop: idx,
    dividerCount: laterals.length,
    rankOrderLaneIndices: laterals.map((l) => l.laneIndex),
  };
}

function minDistanceToRoadEdges(point, frame) {
  let minDist = null;
  for (const edge of frame?.roadEdges || []) {
    for (const p of finitePoints(edge.points)) {
      const d = Math.hypot(p.x - point.east, p.y - point.north);
      if (minDist == null || d < minDist) minDist = d;
    }
  }
  return minDist;
}

function detectCrossing(lateralsA, lateralsB, slotA, slotB) {
  const targetA = lateralsA.find((l) => l.laneIndex === slotA);
  const targetB = lateralsB.find((l) => l.laneIndex === slotB);
  if (!targetA || !targetB) return { available: false, strong: false };

  let crossings = 0;
  const checked = new Set();
  for (const other of lateralsA) {
    if (other.laneIndex === slotA) continue;
    const otherB = lateralsB.find((l) => l.laneIndex === other.laneIndex);
    if (!otherB) continue;
    const relA = targetA.lateral - other.lateral;
    const relB = targetB.lateral - otherB.lateral;
    if (relA * relB < 0) {
      crossings += 1;
      checked.add(other.laneIndex);
    }
  }
  return {
    available: true,
    strong: crossings > 0,
    crossingCount: crossings,
    crossedLaneIndices: [...checked],
    evidence: 'sign_change_of_relative_lateral_offset_at_anchor',
  };
}

function detectSideSwap(lateralsA, lateralsB, slotA, slotB) {
  const targetA = lateralsA.find((l) => l.laneIndex === slotA);
  const targetB = lateralsB.find((l) => l.laneIndex === slotB);
  if (!targetA || !targetB || lateralsA.length < 2 || lateralsB.length < 2) {
    return { available: false, strong: false };
  }

  const refA = lateralsA.find((l) => l.laneIndex !== slotA);
  const refB = lateralsB.find((l) => l.laneIndex === refA?.laneIndex);
  if (!refA || !refB) return { available: false, strong: false };

  const sideA = Math.sign(targetA.lateral - refA.lateral);
  const sideB = Math.sign(targetB.lateral - refB.lateral);
  return {
    available: true,
    strong: sideA !== 0 && sideB !== 0 && sideA !== sideB,
    referenceLaneIndex: refA.laneIndex,
    evidence: 'target_side_relative_to_reference_lane_flipped',
  };
}

function boundaryRejection(pair) {
  const reasons = pair.applicableRejectionConditions || [];
  const parsedA = parseObservationEndpoint(pair.observationIdA);
  const parsedB = parseObservationEndpoint(pair.observationIdB);
  const segA = parsedA?.segmentId;
  const segB = parsedB?.segmentId;
  if (segA != null && segB != null && segA !== segB) return { reject: true, reason: 'session_boundary' };
  if (reasons.includes('chunk_boundary')) return { reject: true, reason: 'chunk_boundary' };
  if (reasons.includes('pose_section_boundary')) return { reject: true, reason: 'pose_section_boundary' };
  if (reasons.includes('pass_boundary')) return { reject: true, reason: 'pass_boundary' };
  if (reasons.includes('stage17_gap') || pair.stage17GapIntersection) return { reject: true, reason: 'stage17_gap' };
  if (reasons.includes('timestamp_discontinuity')) return { reject: true, reason: 'timestamp_discontinuity' };
  if (pair.deltaTimeS != null && pair.deltaTimeS < 0) return { reject: true, reason: 'timestamp_discontinuity' };
  return { reject: false, reason: null };
}

function buildShadowMeasurements(pair, manual, root, qlogCache) {
  const parsedA = parseObservationEndpoint(pair.observationIdA);
  const parsedB = parseObservationEndpoint(pair.observationIdB);
  const slotA = parsedA?.sourceSlotIndex;
  const slotB = parsedB?.sourceSlotIndex;

  const boundary = boundaryRejection(pair);
  const baseline = deriveAutomaticContinuationDecision(pair);

  const out = {
    recordIndex: null,
    reviewPairId: pair.reviewPairId,
    manualReferenceLabel: manual.reviewerLabel,
    manualBinaryLabel: manualLabelToBinary(manual.reviewerLabel),
    baselineDecision: baseline.automaticContinuationDecision,
    scalarResidualAfterPoseM: pair.residualAfterPoseM,
    scalarResidualBeforePoseM: pair.spatialM,
    poseDisplacementScalarM: pair.poseDisplacementM,
    boundary,
    anchor: {
      modelXM: ANCHOR_MODEL_X_M,
      coordinateFrame: 'east/north metres (modelX/modelY mapped to east/north in playback helpers)',
      units: 'metres',
      stage21Anchor: ANCHOR_MODEL_X_M,
    },
    targetAnchorA: null,
    targetAnchorB: null,
    vectors: {
      targetDisplacement: null,
      vehiclePoseDisplacement: null,
      poseCompensatedTarget: null,
      euclideanPoseCompensatedAnchorResidual: null,
      longitudinalResidual: null,
      lateralResidual: null,
      headingCompensatedResidual: null,
      vectorAvailable: false,
    },
    identity: {
      rankA: null,
      rankB: null,
      rankStable: null,
      rankDelta: null,
      sideSwap: null,
      crossing: null,
      roadEdgeDistanceA: null,
      roadEdgeDistanceB: null,
      roadEdgeOverlap: false,
      roadEdgeAssociationChange: false,
      evidenceAvailable: manual.evidenceMode !== 'insufficient' && Boolean(pair.qlogReference),
    },
    coordinateFrameChecks: {
      targetAndPoseSameFrame: null,
      scalarHidesOppositeVectors: null,
      translationDirectionTest: null,
      rotationApplicationOrder: 'heading_at_frame_A_counterclockwise_from_east_north',
      assumptions: [
        'Target anchor points use east/north from lane model geometry',
        'Vehicle pose displacement uses GPS-interpolated east/north at nearest frames',
        'Pose compensation subtracts vehicle translation vector from target displacement vector',
      ],
    },
    unavailableFields: [],
  };

  if (!pair.qlogReference) {
    out.unavailableFields.push('qlog_reference');
    return out;
  }

  let qlog = qlogCache.get(pair.qlogReference);
  if (!qlog) {
    qlog = tryLoadQlogPayloadWithPose(root, pair.qlogReference);
    qlogCache.set(pair.qlogReference, qlog);
  }
  if (!qlog.ok) {
    out.unavailableFields.push('qlog_payload');
    return out;
  }

  const idxA = findNearestFrameIndex(qlog.timeline, pair.logMonoTimeA);
  const idxB = findNearestFrameIndex(qlog.timeline, pair.logMonoTimeB);
  if (idxA == null || idxB == null) {
    out.unavailableFields.push('frame_timestamps');
    return out;
  }

  const frameA = qlog.frames[idxA];
  const frameB = qlog.frames[idxB];
  const laneA = findLaneBySlot(frameA, slotA);
  const laneB = findLaneBySlot(frameB, slotB);
  if (!laneA || !laneB) {
    out.unavailableFields.push('target_lane_geometry');
    return out;
  }

  const anchorA = anchorPointOnLane(laneA);
  const anchorB = anchorPointOnLane(laneB);
  out.targetAnchorA = anchorA.available ? { east: anchorA.east, north: anchorA.north, method: anchorA.method } : null;
  out.targetAnchorB = anchorB.available ? { east: anchorB.east, north: anchorB.north, method: anchorB.method } : null;

  if (!anchorA.available || !anchorB.available) {
    out.unavailableFields.push('anchor_interpolation');
    return out;
  }

  const lateralsA = laneLateralsAtAnchor(frameA);
  const lateralsB = laneLateralsAtAnchor(frameB);
  const rankA = deriveRankFromLaterals(lateralsA, slotA);
  const rankB = deriveRankFromLaterals(lateralsB, slotB);
  out.identity.rankA = rankA.available ? rankA.rankFromTop : null;
  out.identity.rankB = rankB.available ? rankB.rankFromTop : null;
  out.identity.rankStable = rankA.available && rankB.available ? rankA.rankFromTop === rankB.rankFromTop : null;
  out.identity.rankDelta = rankA.available && rankB.available ? rankB.rankFromTop - rankA.rankFromTop : null;
  out.identity.sideSwap = detectSideSwap(lateralsA, lateralsB, slotA, slotB);
  out.identity.crossing = detectCrossing(lateralsA, lateralsB, slotA, slotB);

  const edgeDistA = minDistanceToRoadEdges({ east: anchorA.east, north: anchorA.north }, frameA);
  const edgeDistB = minDistanceToRoadEdges({ east: anchorB.east, north: anchorB.north }, frameB);
  out.identity.roadEdgeDistanceA = edgeDistA != null ? +edgeDistA.toFixed(4) : null;
  out.identity.roadEdgeDistanceB = edgeDistB != null ? +edgeDistB.toFixed(4) : null;
  out.identity.roadEdgeOverlap = edgeDistB != null && edgeDistB <= ROAD_EDGE_OVERLAP_M;
  out.identity.roadEdgeAssociationChange = edgeDistA != null && edgeDistB != null
    && edgeDistA > ROAD_EDGE_PROXIMITY_M && edgeDistB <= ROAD_EDGE_PROXIMITY_M;
  out.identity.roadEdgeOverlapAloneImpliesIdentitySwap = false;

  const targetDisp = vecSub(
    vec2(anchorB.east, anchorB.north),
    vec2(anchorA.east, anchorA.north),
  );

  let poseDisp = null;
  if (frameA.pose?.east != null && frameB.pose?.east != null) {
    poseDisp = vecSub(
      vec2(frameB.pose.east, frameB.pose.north),
      vec2(frameA.pose.east, frameA.pose.north),
    );
    out.coordinateFrameChecks.targetAndPoseSameFrame = true;
  } else if (pair.poseDisplacementM != null && frameA.pose?.headingDeg != null) {
    const rad = (frameA.pose.headingDeg * Math.PI) / 180;
    poseDisp = vec2(
      pair.poseDisplacementM * Math.cos(rad),
      pair.poseDisplacementM * Math.sin(rad),
    );
    out.coordinateFrameChecks.targetAndPoseSameFrame = 'inferred_from_scalar_pose_and_heading_at_A';
    out.unavailableFields.push('pose_vector_inferred');
  } else {
    out.unavailableFields.push('pose_vector');
  }

  if (poseDisp) {
    const compensated = vecSub(targetDisp, poseDisp);
    const euclidean = vecMag(compensated);
    const vehicle = rotateToVehicleFrame(compensated, frameA.pose?.headingDeg ?? 0);

    out.vectors.targetDisplacement = { east: +targetDisp.x.toFixed(4), north: +targetDisp.y.toFixed(4) };
    out.vectors.vehiclePoseDisplacement = { east: +poseDisp.x.toFixed(4), north: +poseDisp.y.toFixed(4) };
    out.vectors.poseCompensatedTarget = { east: +compensated.x.toFixed(4), north: +compensated.y.toFixed(4) };
    out.vectors.euclideanPoseCompensatedAnchorResidual = +euclidean.toFixed(4);
    out.vectors.longitudinalResidual = +vehicle.longitudinal.toFixed(4);
    out.vectors.lateralResidual = +vehicle.lateral.toFixed(4);
    out.vectors.vectorAvailable = true;

    const scalarResidual = pair.residualAfterPoseM;
    const dot = targetDisp.x * poseDisp.x + targetDisp.y * poseDisp.y;
    out.coordinateFrameChecks.scalarHidesOppositeVectors = scalarResidual != null
      && Math.abs(vecMag(targetDisp) - pair.poseDisplacementM) < 1
      && dot < 0;
    out.coordinateFrameChecks.translationDirectionTest = {
      targetMagnitude: +vecMag(targetDisp).toFixed(4),
      poseMagnitude: +vecMag(poseDisp).toFixed(4),
      dotProduct: +dot.toFixed(4),
      oppositeDirection: dot < 0,
    };

    if (frameA.pose?.headingDeg != null && frameB.pose?.headingDeg != null) {
      const headingDelta = ((frameB.pose.headingDeg - frameA.pose.headingDeg) + 540) % 360 - 180;
      const rotated = rotateToVehicleFrame(targetDisp, frameA.pose.headingDeg);
      out.vectors.headingCompensatedResidual = {
        headingDeltaDeg: +headingDelta.toFixed(2),
        lateralAfterHeadingAlign: rotated.lateral,
        available: true,
      };
    } else {
      out.vectors.headingCompensatedResidual = { available: false };
    }
  }

  return out;
}

function decideBaseline(meas) {
  if (meas.boundary.reject) return 'negative';
  if (meas.baselineDecision === 'positive') return 'positive';
  return 'negative';
}

function decideVector(meas, thresholdM = PRODUCTION_RESIDUAL_CAP_M) {
  if (meas.boundary.reject) return 'negative';
  if (!meas.vectors.vectorAvailable) return decideBaseline(meas);
  return meas.vectors.euclideanPoseCompensatedAnchorResidual <= thresholdM ? 'positive' : 'negative';
}

function decideConfig(configId, meas) {
  const vector = decideVector(meas);
  const baseline = decideBaseline(meas);
  const crossing = meas.identity.crossing?.strong === true;
  const sideSwap = meas.identity.sideSwap?.strong === true;
  const rankUnstable = meas.identity.rankStable === false;
  const vectorResidual = meas.vectors.euclideanPoseCompensatedAnchorResidual;
  const roadEdgeChange = meas.identity.roadEdgeAssociationChange === true;

  switch (configId) {
    case 'A':
      return baseline;
    case 'B':
      return vector;
    case 'C':
      return baseline === 'positive' && crossing ? 'negative' : baseline;
    case 'D':
      return vector === 'positive' && crossing ? 'negative' : vector;
    case 'E':
      return vector === 'positive' && sideSwap ? 'negative' : vector;
    case 'F':
      if (vector === 'positive' && rankUnstable && vectorResidual != null && vectorResidual <= PRODUCTION_RESIDUAL_CAP_M) {
        return 'negative';
      }
      return vector;
    case 'G': {
      if (meas.boundary.reject) return 'negative';
      if (!meas.vectors.vectorAvailable) return baseline;
      if (vectorResidual > PRODUCTION_RESIDUAL_CAP_M) return 'negative';
      if (crossing || sideSwap) return 'negative';
      if (rankUnstable && vectorResidual <= 8) return 'negative';
      if (roadEdgeChange && rankUnstable) return 'negative';
      return 'positive';
    }
    default:
      return baseline;
  }
}

function calculateMetricsZeroDiv(confusion) {
  const { tp, tn, fp, fn } = confusion;
  const safeDiv = (n, d) => (d > 0 ? n / d : 0);
  const posPrec = safeDiv(tp, tp + fp);
  const posRec = safeDiv(tp, tp + fn);
  const negPrec = safeDiv(tn, tn + fn);
  const negRec = safeDiv(tn, tn + fp);
  const f1 = (p, r) => (p + r > 0 ? (2 * p * r) / (p + r) : 0);
  const posF1 = f1(posPrec, posRec);
  const negF1 = f1(negPrec, negRec);
  return {
    confusionMatrix: confusion,
    accuracy: { rate: +safeDiv(tp + tn, tp + tn + fp + fn).toFixed(4), numerator: tp + tn, denominator: tp + tn + fp + fn },
    positivePrecision: { rate: +posPrec.toFixed(4), numerator: tp, denominator: tp + fp },
    positiveRecall: { rate: +posRec.toFixed(4), numerator: tp, denominator: tp + fn },
    positiveF1: { rate: +posF1.toFixed(4) },
    negativePrecision: { rate: +negPrec.toFixed(4), numerator: tn, denominator: tn + fn },
    negativeRecall: { rate: +negRec.toFixed(4), numerator: tn, denominator: tn + fp },
    negativeF1: { rate: +negF1.toFixed(4) },
    balancedAccuracy: { rate: +((posRec + negRec) / 2).toFixed(4) },
    macroF1: { rate: +((posF1 + negF1) / 2).toFixed(4) },
    classSupport: { manualPositive: tp + fn, manualNegative: tn + fp, totalResolved: tp + tn + fp + fn },
    metricConvention: 'zero_division_equals_zero',
  };
}

function evaluateConfig(records, configId) {
  const decisions = records.map((r) => ({
    recordIndex: r.recordIndex,
    manual: r.manualBinaryLabel,
    baseline: r.candidateDecisions.A,
    candidate: r.candidateDecisions[configId],
  }));

  const resolved = decisions.filter((d) => d.manual != null);
  const rows = resolved.map((d) => ({
    manualBinaryLabel: d.manual,
    automaticContinuationDecision: d.candidate,
  }));
  const confusion = buildConfusionMatrix(rows);
  const metrics = calculateMetricsZeroDiv(confusion);

  const baselineRows = resolved.map((d) => ({
    manualBinaryLabel: d.manual,
    automaticContinuationDecision: d.baseline,
  }));
  const baselineConfusion = buildConfusionMatrix(baselineRows);

  const corrected = [];
  const damaged = [];
  for (const d of resolved) {
    const baseCorrect = d.baseline === d.manual;
    const candCorrect = d.candidate === d.manual;
    if (!baseCorrect && candCorrect) corrected.push(d.recordIndex);
    if (baseCorrect && !candCorrect) damaged.push(d.recordIndex);
  }

  const truePositiveProtection = {
    baselineTpRetained: resolved.filter((d) => d.manual === 'positive' && d.baseline === 'positive' && d.candidate === 'positive').length,
    baselineTpTotal: resolved.filter((d) => d.manual === 'positive' && d.baseline === 'positive').length,
    allManualPositiveRetained: resolved.filter((d) => d.manual === 'positive' && d.candidate === 'positive').length,
    allManualPositiveTotal: resolved.filter((d) => d.manual === 'positive').length,
  };

  return {
    configId,
    ...metrics,
    deltaFromBaseline: {
      tp: confusion.tp - baselineConfusion.tp,
      tn: confusion.tn - baselineConfusion.tn,
      fp: confusion.fp - baselineConfusion.fp,
      fn: confusion.fn - baselineConfusion.fn,
    },
    correctedRecordIndices: corrected.sort((a, b) => a - b),
    newlyDamagedRecordIndices: damaged.sort((a, b) => a - b),
    truePositiveProtection,
  };
}

function rankRuleImpact(records) {
  const fixed = [];
  const damaged = [];
  for (const r of records) {
    const base = r.candidateDecisions.A;
    const withRank = r.candidateDecisions.F;
    const manual = r.manualBinaryLabel;
    if (base !== manual && withRank === manual) fixed.push(r.recordIndex);
    if (base === manual && withRank !== manual) damaged.push(r.recordIndex);
  }
  return { fixes: fixed, damages: damaged };
}

function verifyInputIntegrity(root, inputs = {}) {
  const merged = { ...DEFAULT_INPUTS, ...inputs };
  const paths = {
    manualReviews: path.resolve(root, merged.manualReviewsPath),
    automaticManifest: path.resolve(root, merged.automaticManifestPath),
    baselineComparison: path.resolve(root, merged.baselineComparisonPath),
    baselineDisagreements: path.resolve(root, merged.baselineDisagreementsPath),
    stage21ErrorAnalysis: path.resolve(root, merged.stage21ErrorAnalysisPath),
    stage21RecheckList: path.resolve(root, merged.stage21RecheckListPath),
  };
  const hashes = Object.fromEntries(
    Object.entries(paths).map(([k, p]) => [k, sha256File(p)]),
  );

  const manual = loadJson(paths.manualReviews);
  const manifest = loadJson(paths.automaticManifest);
  const join = joinAutomaticAndManual({
    automaticPairs: manifest.reviewPairs,
    manualReviews: manual.reviews,
  });
  const resolved = join.joined.filter((r) => manualLabelToBinary(r.manual.reviewerLabel) != null);

  return {
    ok: resolved.length === 175
      && join.unmatchedManual.length === 0
      && join.duplicateManualPairIds.length === 0
      && join.duplicateAutomaticPairIds.length === 0,
    hashes,
    paths: Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, path.relative(root, p)])),
    resolvedCount: resolved.length,
    joinSummary: {
      unmatchedManual: join.unmatchedManual,
      unmatchedAutomatic: join.unmatchedAutomatic,
      duplicateManualPairIds: join.duplicateManualPairIds,
      duplicateAutomaticPairIds: join.duplicateAutomaticPairIds,
    },
    manualFilePreserved: true,
  };
}

function buildRecommendation(configResults, coordinateFindings, rankImpact) {
  const baseline = configResults.find((c) => c.configId === 'A');
  const best = [...configResults]
    .filter((c) => c.configId !== 'A')
    .sort((a, b) => {
      const score = (m) => m.balancedAccuracy.rate * 0.5 + m.macroF1.rate * 0.5 - m.newlyDamagedRecordIndices.length * 0.01;
      return score(b) - score(a);
    })[0];

  if (coordinateFindings.oppositeDirectionCount >= 5) {
    return {
      decision: 'repair_coordinate_transform_first',
      rationale: 'Multiple records show opposite target/pose vector directions where scalar residual masks the mismatch',
      evidence: coordinateFindings,
    };
  }

  const netCorrectImprovement = best.correctedRecordIndices.length - best.newlyDamagedRecordIndices.length;
  const baselineCorrect = baseline.confusionMatrix.tp + baseline.confusionMatrix.tn;
  const candidateCorrect = best.confusionMatrix.tp + best.confusionMatrix.tn;
  const tpLoss = baseline.truePositiveProtection.baselineTpRetained - best.truePositiveProtection.baselineTpRetained;

  if (best.configId === 'G' && netCorrectImprovement > 0 && tpLoss <= 3 && best.correctedRecordIndices.length >= 5) {
    return {
      decision: 'proceed_to_limited_implementation',
      rationale: `Config ${best.configId} improves balanced accuracy/macro-F1 with acceptable TP loss in shadow mode`,
      bestCandidate: best.configId,
      evidence: {
        netCorrectImprovement,
        baselineCorrect,
        candidateCorrect,
        tpLoss,
        corrected: best.correctedRecordIndices.length,
        damaged: best.newlyDamagedRecordIndices.length,
      },
    };
  }

  if (best.newlyDamagedRecordIndices.length > best.correctedRecordIndices.length) {
    return {
      decision: 'collect_more_negative_examples',
      rationale: 'Candidate signals damage more baseline-correct records than they fix; class imbalance limits negative detection',
      bestCandidate: best.configId,
      evidence: { corrected: best.correctedRecordIndices.length, damaged: best.newlyDamagedRecordIndices.length, rankImpact },
    };
  }

  if (netCorrectImprovement <= 0) {
    return {
      decision: 'candidate_not_supported',
      rationale: 'No shadow configuration improves net correct-decision count vs baseline across all 175 resolved references',
      bestCandidate: best.configId,
      evidence: { netCorrectImprovement, baselineCorrect, candidateCorrect, rankImpact },
    };
  }

  return {
    decision: 'proceed_to_limited_implementation',
    rationale: `Config ${best.configId} shows shadow improvement without catastrophic TP loss`,
    bestCandidate: best.configId,
    evidence: {
      netCorrectImprovement,
      baselineCorrect,
      candidateCorrect,
      corrected: best.correctedRecordIndices.length,
      damaged: best.newlyDamagedRecordIndices.length,
      tpLoss,
      rankImpact,
    },
  };
}

function runShadowEvaluation(options = {}) {
  const root = options.root || process.cwd();
  const inputs = { ...DEFAULT_INPUTS, ...options.inputs };
  const integrity = verifyInputIntegrity(root, inputs);

  const manual = loadJson(path.resolve(root, inputs.manualReviewsPath));
  const manifest = loadJson(path.resolve(root, inputs.automaticManifestPath));
  const join = joinAutomaticAndManual({
    automaticPairs: manifest.reviewPairs,
    manualReviews: manual.reviews,
  });

  const resolvedRows = join.joined.filter((r) => manualLabelToBinary(r.manual.reviewerLabel) != null);
  const qlogCache = new Map();
  const records = resolvedRows.map((row) => {
    const meas = buildShadowMeasurements(row.automatic, row.manual, root, qlogCache);
    meas.recordIndex = row.manualRecordIndex;
    const candidateDecisions = Object.fromEntries(
      CANDIDATE_CONFIGS.map((c) => [c.id, decideConfig(c.id, meas)]),
    );
    return { ...meas, candidateDecisions };
  });

  const configResults = CANDIDATE_CONFIGS.map((c) => evaluateConfig(records, c.id));
  const configResultsExcluding207 = CANDIDATE_CONFIGS.map((c) => evaluateConfig(
    records.filter((r) => r.recordIndex !== MANUAL_RECHECK_INDEX),
    c.id,
  ));

  const thresholdSweep = OFFLINE_VECTOR_THRESHOLD_SWEEP_M.map((thresholdM) => {
    const rows = records.map((r) => {
      const decision = decideVector(r, thresholdM);
      return { manualBinaryLabel: r.manualBinaryLabel, automaticContinuationDecision: decision };
    });
    const confusion = buildConfusionMatrix(rows);
    return { thresholdM, metrics: calculateMetricsZeroDiv(confusion), notApproved: true };
  });

  const coordinateFindings = {
    oppositeDirectionCount: records.filter((r) => r.coordinateFrameChecks.scalarHidesOppositeVectors === true).length,
    inferredPoseVectorCount: records.filter((r) => r.unavailableFields.includes('pose_vector_inferred')).length,
    vectorUnavailableCount: records.filter((r) => !r.vectors.vectorAvailable).length,
    formula: 'poseCompensatedTarget = targetAnchorB - targetAnchorA - (poseB - poseA); euclidean residual = |poseCompensatedTarget|',
    frames: 'east/north metres',
    note: 'Scalar abs(spatialM - poseDisplacementM) can hide opposite vector directions when magnitudes are similar',
  };

  const rankImpact = rankRuleImpact(records);
  const recommendation = buildRecommendation(configResults, coordinateFindings, rankImpact);

  const perRecordDiagnostics = records.map((r) => ({
    recordIndex: r.recordIndex,
    reviewPairId: r.reviewPairId,
    manualReferenceLabel: r.manualReferenceLabel,
    baselineDecision: r.candidateDecisions.A,
    candidateDecisions: r.candidateDecisions,
    anchorA: r.targetAnchorA,
    anchorB: r.targetAnchorB,
    vehicleMotionVector: r.vectors.vehiclePoseDisplacement,
    poseCompensatedTargetVector: r.vectors.poseCompensatedTarget,
    longitudinalResidual: r.vectors.longitudinalResidual,
    lateralResidual: r.vectors.lateralResidual,
    euclideanPoseCompensatedAnchorResidual: r.vectors.euclideanPoseCompensatedAnchorResidual,
    rankA: r.identity.rankA,
    rankB: r.identity.rankB,
    rankStable: r.identity.rankStable,
    sideChangeEvidence: r.identity.sideSwap,
    crossingEvidence: r.identity.crossing,
    roadEdgeRelationship: {
      distanceA: r.identity.roadEdgeDistanceA,
      distanceB: r.identity.roadEdgeDistanceB,
      overlap: r.identity.roadEdgeOverlap,
      associationChange: r.identity.roadEdgeAssociationChange,
      overlapAloneImpliesIdentitySwap: false,
    },
    evidenceAvailable: r.identity.evidenceAvailable,
    correctedOrDamaged: Object.fromEntries(
      CANDIDATE_CONFIGS.filter((c) => c.id !== 'A').map((c) => {
        const evalRes = configResults.find((x) => x.configId === c.id);
        const status = evalRes.correctedRecordIndices.includes(r.recordIndex)
          ? 'corrected'
          : evalRes.newlyDamagedRecordIndices.includes(r.recordIndex)
            ? 'damaged'
            : 'unchanged';
        return [c.id, status];
      }),
    ),
    coordinateFrameChecks: r.coordinateFrameChecks,
    unavailableFields: r.unavailableFields,
  }));

  const sensitivity207 = {
    recordIndex: MANUAL_RECHECK_INDEX,
    includedInPrimary: true,
    excludedFromSensitivity: false,
    metricDelta: Object.fromEntries(
      CANDIDATE_CONFIGS.map((c) => {
        const primary = configResults.find((x) => x.configId === c.id);
        const sens = configResultsExcluding207.find((x) => x.configId === c.id);
        return [c.id, {
          accuracyDelta: +(sens.accuracy.rate - primary.accuracy.rate).toFixed(4),
          macroF1Delta: +(sens.macroF1.rate - primary.macroF1.rate).toFixed(4),
          correctedCountDelta: sens.correctedRecordIndices.length - primary.correctedRecordIndices.length,
          damagedCountDelta: sens.newlyDamagedRecordIndices.length - primary.newlyDamagedRecordIndices.length,
        }];
      }),
    ),
    labelUnchanged: true,
  };

  return {
    generatedAt: new Date().toISOString(),
    stage: 'stage22-b-motion-shadow-evaluation',
    terminology: 'Development-set shadow evaluation — not final model performance',
    productionUnchanged: {
      residualCapM: PRODUCTION_RESIDUAL_CAP_M,
      note: 'Production 12 m cap not modified; offline sweeps are analysis-only',
    },
    inputIntegrity: integrity,
    vectorCompensation: coordinateFindings,
    coordinateFrameFindings: coordinateFindings,
    candidateConfigurations: CANDIDATE_CONFIGS,
    configResultsPrimary: configResults,
    configResultsExcludingRecord207: configResultsExcluding207,
    record207Sensitivity: sensitivity207,
    offlineThresholdSweep: {
      testedValuesM: OFFLINE_VECTOR_THRESHOLD_SWEEP_M,
      notApproved: true,
      results: thresholdSweep,
    },
    rankSoftSignalImpact: rankImpact,
    recommendation,
    perRecordDiagnostics,
    overfittingGuard: {
      evaluatedAcrossAllResolved: 175,
      notTunedOnDisagreementsOnly: true,
      truePositiveBehaviour: configResults.find((c) => c.configId === 'A')?.truePositiveProtection,
    },
  };
}

module.exports = {
  ANCHOR_MODEL_X_M,
  MANUAL_RECHECK_INDEX,
  PRODUCTION_RESIDUAL_CAP_M,
  CANDIDATE_CONFIGS,
  anchorPointOnLane,
  rotateToVehicleFrame,
  vecSub,
  vecMag,
  decideConfig,
  decideVector,
  calculateMetricsZeroDiv,
  buildShadowMeasurements,
  verifyInputIntegrity,
  runShadowEvaluation,
  boundaryRejection,
};
