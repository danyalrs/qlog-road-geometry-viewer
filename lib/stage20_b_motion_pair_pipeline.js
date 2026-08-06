'use strict';

const fs = require('fs');
const path = require('path');
const { config, stage17Gaps } = require('./stage19_spec/config');
const {
  sLoM, wrappedAbs, tangentLoDeg, meanLateralOffsetUm, staticBranchCandidateEdge,
} = require('./stage19_spec/geometry');
const { buildStage19InputContext } = require('./stage19_stage18_loader');
const { injectStage17Gaps, clearStage17Gaps } = require('./stage19_runtime');
const { buildMatchRecords } = require('./stage19_match_builder');
const { parseObservationEndpoint } = require('./stage20_b_motion_review_playback');

const QLOG_PATTERN = /^qlog_f449c.*\.bz2$/i;

function euclideanHiDistanceM(a, b) {
  const dx = (a.eHiUm - b.eHiUm) / 1e6;
  const dy = (a.nHiUm - b.nHiUm) / 1e6;
  const dz = (a.uHiUm - b.uHiUm) / 1e6;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function gapIntersects(a, b) {
  const lo = Math.min(a.sLoUm, b.sLoUm);
  const hi = Math.max(a.sLoUm, b.sLoUm);
  for (const g of stage17Gaps) {
    if (g.intersectsLoOrHi(lo, hi)) return true;
  }
  return false;
}

function classifyPair(p) {
  const reasons = [];
  if (p.chunkIdA !== p.chunkIdB) reasons.push('chunk_boundary');
  if (p.poseSectionIdA !== p.poseSectionIdB) reasons.push('pose_section_boundary');
  if (p.temporalPassIdA !== p.temporalPassIdB) reasons.push('pass_boundary');
  const segA = parseInt(String(p.observationIdA).split(':')[0], 10);
  const segB = parseInt(String(p.observationIdB).split(':')[0], 10);
  if (segA !== segB) reasons.push('session_boundary');
  if (p.deltaTimeS != null && p.deltaTimeS < 0) reasons.push('timestamp_discontinuity');
  if (p.stage17GapIntersection) reasons.push('stage17_gap');
  if (p.headingDiffDeg > config.maxLocalHeadingDeltaDeg) reasons.push('pose_inconsistency_heading');
  if (p.lateralDeltaM > config.maxLateralOffsetDeltaM) reasons.push('lateral_inconsistency');

  let ruleDerivedClassification;
  if (reasons.includes('session_boundary')) ruleDerivedClassification = 'invalid_across_session_boundary';
  else if (reasons.includes('chunk_boundary')) ruleDerivedClassification = 'invalid_across_chunk_boundary';
  else if (reasons.includes('pose_section_boundary')) ruleDerivedClassification = 'invalid_across_pose_section_boundary';
  else if (reasons.includes('pass_boundary')) ruleDerivedClassification = 'possible_cross_pass_match';
  else if (reasons.includes('stage17_gap')) ruleDerivedClassification = 'invalid_across_stage17_gap';
  else if (reasons.includes('timestamp_discontinuity')) ruleDerivedClassification = 'invalid_timestamp_discontinuity';
  else if (p.rev37StaticEdgePass) ruleDerivedClassification = 'valid_same_track_continuation';
  else if (p.residualAfterPoseM != null && p.residualAfterPoseM <= config.maxSpatialJumpM) {
    ruleDerivedClassification = 'ambiguous_motion_residual_candidate';
  } else ruleDerivedClassification = 'ambiguous_spatial_cap_failure';

  return { ruleDerivedClassification, applicableRejectionConditions: reasons };
}

function pairMetrics(a, b, context) {
  const oa = context.observationById.get(a.observationId);
  const ob = context.observationById.get(b.observationId);
  const dt = (oa && ob)
    ? Math.abs(Number(BigInt(ob.logMonoTime) - BigInt(oa.logMonoTime))) / 1e9
    : null;
  const spatialM = euclideanHiDistanceM(a, b);
  const routeSGapM = Math.abs(sLoM(b) - sLoM(a));
  const headingDiffDeg = wrappedAbs(tangentLoDeg(b) - tangentLoDeg(a));
  const lateralDeltaM = Math.abs(meanLateralOffsetUm(b) - meanLateralOffsetUm(a)) / 1e6;
  const speed = oa?.poseRecord?.speed ?? null;
  const expectedMotionM = (speed != null && dt != null) ? speed * dt : null;
  const poseDisplacementM = (oa?.poseRecord && ob?.poseRecord)
    ? Math.sqrt((ob.poseRecord.east - oa.poseRecord.east) ** 2 + (ob.poseRecord.north - oa.poseRecord.north) ** 2)
    : null;
  const residualAfterPoseM = poseDisplacementM != null ? Math.abs(spatialM - poseDisplacementM) : null;
  const residualRouteSAfterSpeedM = expectedMotionM != null ? Math.abs(routeSGapM - expectedMotionM) : null;
  const segmentId = oa?.segmentId ?? null;
  const qlogFile = segmentId != null ? `qlog_f449c_${segmentId}.bz2` : null;
  const slotA = parseObservationEndpoint(a.observationId)?.sourceSlotIndex ?? null;
  const slotB = parseObservationEndpoint(b.observationId)?.sourceSlotIndex ?? null;
  return {
    reviewPairId: `${a.observationId}|${b.observationId}`,
    observationIdA: a.observationId,
    observationIdB: b.observationId,
    segmentId,
    parentTrackId: a.featurePairId,
    temporalPassIdA: oa?.temporalPassId ?? null,
    temporalPassIdB: ob?.temporalPassId ?? null,
    chunkIdA: oa?.chunkId ?? null,
    chunkIdB: ob?.chunkId ?? null,
    poseSectionIdA: oa?.poseSectionId ?? null,
    poseSectionIdB: ob?.poseSectionId ?? null,
    logMonoTimeA: oa?.logMonoTime ?? null,
    logMonoTimeB: ob?.logMonoTime ?? null,
    sourceSlotIndexA: slotA,
    sourceSlotIndexB: slotB,
    deltaTimeS: dt != null ? +dt.toFixed(3) : null,
    spatialM: +spatialM.toFixed(3),
    routeSGapM: +routeSGapM.toFixed(3),
    headingDiffDeg: +headingDiffDeg.toFixed(2),
    lateralDeltaM: +lateralDeltaM.toFixed(3),
    speedMps: speed != null ? +speed.toFixed(3) : null,
    expectedMotionM: expectedMotionM != null ? +expectedMotionM.toFixed(3) : null,
    poseDisplacementM: poseDisplacementM != null ? +poseDisplacementM.toFixed(3) : null,
    residualAfterPoseM: residualAfterPoseM != null ? +residualAfterPoseM.toFixed(3) : null,
    residualRouteSAfterSpeedM: residualRouteSAfterSpeedM != null ? +residualRouteSAfterSpeedM.toFixed(3) : null,
    stage17GapIntersection: gapIntersects(a, b),
    rev37StaticEdgePass: staticBranchCandidateEdge(a, b, 'inc'),
    qlogReference: qlogFile,
    videoReference: qlogFile ? `qlog:${qlogFile}:modelV2` : null,
  };
}

function bucketKey(p, cls) {
  if (cls.ruleDerivedClassification === 'invalid_across_stage17_gap') return 'gap_case';
  if (cls.ruleDerivedClassification === 'invalid_across_session_boundary') return 'session_boundary';
  if (cls.ruleDerivedClassification === 'invalid_across_chunk_boundary') return 'chunk_boundary';
  if (cls.ruleDerivedClassification === 'invalid_across_pose_section_boundary') return 'pose_section_boundary';
  if (cls.ruleDerivedClassification === 'possible_cross_pass_match') return 'pass_boundary';
  if (cls.ruleDerivedClassification === 'valid_same_track_continuation') return 'clear_continuation';
  if (p.speedMps != null && p.speedMps < 0.5) return 'stationary_or_drift';
  if (p.headingDiffDeg >= 15) return 'heading_change';
  if (p.spatialM < 12) return 'low_displacement';
  if (p.spatialM >= 12 && p.spatialM < 35) return 'mid_displacement';
  if (p.spatialM >= 35) return 'high_displacement';
  if (cls.ruleDerivedClassification === 'ambiguous_motion_residual_candidate') return 'motion_residual_candidate';
  return 'other_ambiguous';
}

function enumerateAllConsecutivePairs(root) {
  injectStage17Gaps();
  const context = buildStage19InputContext(root);
  const { matches } = buildMatchRecords(context);
  const pairs = [];
  const byUnit = new Map();
  for (const m of matches) {
    const key = m.featurePairId;
    if (!byUnit.has(key)) byUnit.set(key, []);
    byUnit.get(key).push(m);
  }
  for (const unit of byUnit.values()) {
    if (unit.length < 2) continue;
    unit.sort((a, b) => sLoM(a) - sLoM(b) || a.observationId.localeCompare(b.observationId));
    for (let i = 0; i < unit.length - 1; i++) {
      const base = pairMetrics(unit[i], unit[i + 1], context);
      const cls = classifyPair(base);
      pairs.push({ ...base, ...cls, stratificationBucket: bucketKey(base, cls) });
    }
  }
  clearStage17Gaps();
  return { pairs, context };
}

function discoverQlogSegments(root) {
  return fs.readdirSync(root)
    .filter((f) => QLOG_PATTERN.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/_(\d+)\.bz2$/i)[1], 10);
      const nb = parseInt(b.match(/_(\d+)\.bz2$/i)[1], 10);
      return na - nb;
    });
}

function segmentIdFromQlog(filename) {
  const m = filename.match(/_(\d+)\.bz2$/i);
  return m ? parseInt(m[1], 10) : null;
}

module.exports = {
  QLOG_PATTERN,
  classifyPair,
  pairMetrics,
  bucketKey,
  enumerateAllConsecutivePairs,
  discoverQlogSegments,
  segmentIdFromQlog,
};
