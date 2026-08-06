/**
 * Stage 15A — ego-boundary classification audit (read-only).
 * Documents slot semantics, validates candidate selection, corrects road-edge metrics.
 */
const { lateralAtForwardX } = require('./stage15_geometry');
const { summarizeNumeric } = require('./stage15_distributions');

/** Assessment-only thresholds — NOT production lane-counting thresholds. */
const ASSESSMENT_THRESHOLDS = {
  evalForwardXM: 10,
  centerEpsilonM: 0.05,
  assessmentMinProb: 0.5,
  assessmentMaxStdM: 1.5,
  assessmentMinProbHigh: 0.75,
  assessmentMinProbLow: 0.5,
};

/** Where v11 frozen pipeline uses minLaneProb = 0.5 */
const V11_MIN_LANE_PROB_USAGE = {
  value: 0.5,
  configField: 'minLaneProb',
  codePaths: [
    { file: 'lib/transform.js', function: 'extractModelGeometry', default: 0.5, effect: 'Filters lane lines before transform; lines with prob < minLaneProb excluded from geometry' },
    { file: 'lib/transform.js', function: 'transformXyztLine', default: 0.5, effect: 'Per-line prob check during point projection' },
    { file: 'lib/process_route.js', function: 'processRoute', default: 0.5, effect: 'Passed to extractModelGeometry for frame building and fusion input' },
    { file: 'dataset_audit.js', function: 'DEFAULT_OPTS', default: 0.5, effect: 'Audit CLI default matching production pipeline' },
    { file: 'lib/frame_stats.js', function: 'buildFrameStats', default: 0.5, effect: 'validLaneFrames counting' },
  ],
  note: 'Stage 15 assessment tooling reuses the same default when calling extractModelGeometry for prob-filtered frame counts; this matches v11, not a separate Stage 15 invention.',
};

function detectCenterCrossing(line, opts = {}) {
  const xs = line.x || [];
  const ys = line.y || [];
  const xRange = opts.forwardRange || [5, 15];
  let hasPositive = false;
  let hasNegative = false;
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
    if (xs[i] < xRange[0] || xs[i] > xRange[1]) continue;
    if (ys[i] > (opts.centerEpsilonM ?? 0.05)) hasPositive = true;
    if (ys[i] < -(opts.centerEpsilonM ?? 0.05)) hasNegative = true;
  }
  return hasPositive && hasNegative;
}

function isMalformedLine(line) {
  if (!line) return true;
  const xs = line.x || [];
  const ys = line.y || [];
  if (!xs.length || xs.length !== ys.length) return true;
  return !xs.some((x, i) => Number.isFinite(x) && Number.isFinite(ys[i]));
}

function evaluateLineObservation(index, line, prob, std, opts = {}) {
  const o = { ...ASSESSMENT_THRESHOLDS, ...opts };
  const malformed = isMalformedLine(line);
  const lateralAtEvalM = malformed ? null : lateralAtForwardX(line, o.evalForwardXM);
  const missingEval = lateralAtEvalM == null;
  const crossing = !malformed && detectCenterCrossing(line, o);

  let side = 'center';
  if (lateralAtEvalM != null) {
    if (lateralAtEvalM > o.centerEpsilonM) side = 'left';
    else if (lateralAtEvalM < -o.centerEpsilonM) side = 'right';
  }

  return {
    index,
    prob: prob ?? 0,
    std: std ?? null,
    lateralAtEvalM,
    side,
    malformed,
    missingEval,
    crossing,
    eligibleSide: side === 'left' || side === 'right',
    eligibleGeometry: !malformed && !missingEval && !crossing && (side === 'left' || side === 'right'),
  };
}

function selectEgoCandidate(observations, side, opts = {}) {
  const o = { ...ASSESSMENT_THRESHOLDS, ...opts };
  const pool = observations.filter((ob) => ob.side === side && ob.eligibleGeometry);
  if (!pool.length) return { candidate: null, rejectionReason: 'no_eligible_line_on_side' };

  const nearest = side === 'left'
    ? pool.reduce((best, c) => (c.lateralAtEvalM < best.lateralAtEvalM ? c : best))
    : pool.reduce((best, c) => (c.lateralAtEvalM > best.lateralAtEvalM ? c : best));

  if (nearest.prob < o.assessmentMinProb) {
    return { candidate: nearest, rejectionReason: 'confidence_below_assessment_threshold', validEgo: false };
  }
  if (nearest.std != null && nearest.std > o.assessmentMaxStdM) {
    return { candidate: nearest, rejectionReason: 'uncertainty_excessive', validEgo: false };
  }
  return { candidate: nearest, rejectionReason: null, validEgo: true };
}

function classifyFrameLinesBeforeFix(modelV2, opts = {}) {
  const o = { ...ASSESSMENT_THRESHOLDS, ...opts };
  const lines = modelV2.laneLines || [];
  const probs = modelV2.laneLineProbs || [];
  const stds = modelV2.laneLineStds || [];

  const observations = lines.map((line, i) => evaluateLineObservation(i, line, probs[i], stds[i], o));
  const validObs = observations.filter((ob) => !ob.malformed && ob.lateralAtEvalM != null);
  validObs.sort((a, b) => b.lateralAtEvalM - a.lateralAtEvalM);

  const leftPool = validObs.filter((ob) => ob.side === 'left');
  const rightPool = validObs.filter((ob) => ob.side === 'right');

  const egoLeft = leftPool.length
    ? leftPool.reduce((best, c) => (c.lateralAtEvalM < best.lateralAtEvalM ? c : best))
    : null;
  // Bug: outermost right (most negative), not nearest to centre
  const egoRight = rightPool.length
    ? rightPool.reduce((best, c) => (c.lateralAtEvalM < best.lateralAtEvalM ? c : best))
    : null;

  return buildFrameClassificationResult(observations, egoLeft, egoRight, o, 'before_fix_outermost_right');
}

function classifyFrameLines(modelV2, opts = {}) {
  const o = { ...ASSESSMENT_THRESHOLDS, ...opts };
  const lines = modelV2.laneLines || [];
  const probs = modelV2.laneLineProbs || [];
  const stds = modelV2.laneLineStds || [];

  const observations = lines.map((line, i) => evaluateLineObservation(i, line, probs[i], stds[i], o));
  const leftSel = selectEgoCandidate(observations, 'left', o);
  const rightSel = selectEgoCandidate(observations, 'right', o);

  return buildFrameClassificationResult(
    observations,
    leftSel.validEgo ? leftSel.candidate : null,
    rightSel.validEgo ? rightSel.candidate : null,
    o,
    'corrected_nearest_eligible',
    { leftSel, rightSel },
  );
}

function buildFrameClassificationResult(observations, egoLeft, egoRight, opts, method, selectionMeta = {}) {
  const o = { ...ASSESSMENT_THRESHOLDS, ...opts };
  const classifications = {
    ego_lane_boundaries: [],
    probable_adjacent_dividers: [],
    uncertain_outer_lines: [],
    unclassifiable: [],
  };

  const egoIndices = new Set([
    ...(egoLeft ? [egoLeft.index] : []),
    ...(egoRight ? [egoRight.index] : []),
  ]);

  for (const ob of observations) {
    if (ob.malformed || ob.missingEval) {
      classifications.unclassifiable.push(ob.index);
    } else if (egoIndices.has(ob.index)) {
      classifications.ego_lane_boundaries.push(ob.index);
    } else if (ob.prob >= o.assessmentMinProbHigh && (ob.std == null || ob.std < 0.3)) {
      classifications.probable_adjacent_dividers.push(ob.index);
    } else if (ob.prob >= o.assessmentMinProbLow) {
      classifications.uncertain_outer_lines.push(ob.index);
    } else {
      classifications.unclassifiable.push(ob.index);
    }
  }

  const validObs = observations.filter((ob) => ob.eligibleGeometry);
  validObs.sort((a, b) => b.lateralAtEvalM - a.lateralAtEvalM);

  const frameOutcome = deriveFrameOutcome(egoLeft, egoRight, selectionMeta, observations);
  const candidateAvailability = deriveCandidateAvailability(selectionMeta.leftSel, selectionMeta.rightSel);
  const assessment = deriveFrameAssessmentReason(selectionMeta.leftSel, selectionMeta.rightSel, observations);

  const outerRight = validObs.filter((ob) => ob.side === 'right')
    .reduce((best, c) => (!best || c.lateralAtEvalM < best.lateralAtEvalM ? c : best), null);

  return {
    method,
    rawLineCount: observations.length,
    candidateCount: validObs.length,
    lateralOrder: validObs.map((ob) => ob.index),
    observations,
    egoLeft: egoLeft ? formatEgoRecord(egoLeft, outerRight) : null,
    egoRight: egoRight ? formatEgoRecord(egoRight, outerRight) : null,
    classifications,
    frameOutcome,
    candidateAvailability,
    frameAssessmentReason: assessment.primary,
    frameAssessmentSecondaryReasons: assessment.secondary,
    retainedEgoCandidateCount: retainedEgoCount(selectionMeta.leftSel, selectionMeta.rightSel),
    selectionMeta,
    egoLaneWidthM: egoLeft && egoRight
      ? Math.abs(egoLeft.lateralAtEvalM - egoRight.lateralAtEvalM)
      : null,
    evalForwardXM: o.evalForwardXM,
  };
}

function formatEgoRecord(ob, outerRight) {
  return {
    index: ob.index,
    lateralAtEvalM: ob.lateralAtEvalM,
    distanceFromCentreM: Math.abs(ob.lateralAtEvalM),
    prob: ob.prob,
    std: ob.std,
    outerRightIndex: outerRight?.index ?? null,
    outerRightLateralM: outerRight?.lateralAtEvalM ?? null,
    distanceToOuterRightM: outerRight ? Math.abs(ob.lateralAtEvalM - outerRight.lateralAtEvalM) : null,
    isNearestToCentreOnSide: true,
  };
}

function deriveCandidateAvailability(leftSel, rightSel) {
  const leftValid = !!leftSel?.validEgo;
  const rightValid = !!rightSel?.validEgo;
  if (leftValid && rightValid) return 'both_valid';
  if (leftValid) return 'left_only_valid';
  if (rightValid) return 'right_only_valid';
  return 'neither_valid';
}

function deriveFrameAssessmentReason(leftSel, rightSel, observations) {
  const secondary = [];
  const leftConf = leftSel?.rejectionReason === 'confidence_below_assessment_threshold';
  const rightConf = rightSel?.rejectionReason === 'confidence_below_assessment_threshold';
  const leftUnc = leftSel?.rejectionReason === 'uncertainty_excessive';
  const rightUnc = rightSel?.rejectionReason === 'uncertainty_excessive';
  const hasCrossing = observations.some((ob) => ob.crossing);
  const hasMalformed = observations.some((ob) => ob.malformed);
  const allUnevaluable = observations.length > 0
    && observations.every((ob) => ob.malformed || ob.missingEval);

  if (leftConf) secondary.push('rejected_left_confidence');
  if (rightConf) secondary.push('rejected_right_confidence');
  if (leftUnc) secondary.push('rejected_left_uncertainty');
  if (rightUnc) secondary.push('rejected_right_uncertainty');
  if (hasCrossing) secondary.push('ordering_or_crossing');
  if (hasMalformed) secondary.push('malformed_geometry');
  if (allUnevaluable) secondary.push('unevaluable_at_10m');

  if (leftSel?.validEgo && rightSel?.validEgo) {
    return { primary: 'accepted_both', secondary: [...new Set(secondary)] };
  }
  if (leftConf && rightConf) return { primary: 'rejected_both_confidence', secondary: [...new Set(secondary)] };
  if (leftUnc && rightUnc) return { primary: 'rejected_both_uncertainty', secondary: [...new Set(secondary)] };
  if (leftSel?.validEgo && rightConf) return { primary: 'rejected_right_confidence', secondary: [...new Set(secondary)] };
  if (rightSel?.validEgo && leftConf) return { primary: 'rejected_left_confidence', secondary: [...new Set(secondary)] };
  if (leftSel?.validEgo && rightUnc) return { primary: 'rejected_right_uncertainty', secondary: [...new Set(secondary)] };
  if (rightSel?.validEgo && leftUnc) return { primary: 'rejected_left_uncertainty', secondary: [...new Set(secondary)] };
  if (leftConf && !rightSel?.validEgo) return { primary: 'rejected_left_confidence', secondary: [...new Set(secondary)] };
  if (rightConf && !leftSel?.validEgo) return { primary: 'rejected_right_confidence', secondary: [...new Set(secondary)] };
  if (leftUnc && !rightSel?.validEgo) return { primary: 'rejected_left_uncertainty', secondary: [...new Set(secondary)] };
  if (rightUnc && !leftSel?.validEgo) return { primary: 'rejected_right_uncertainty', secondary: [...new Set(secondary)] };
  if (hasCrossing) return { primary: 'ordering_or_crossing', secondary: [...new Set(secondary)] };
  if (hasMalformed) return { primary: 'malformed_geometry', secondary: [...new Set(secondary)] };
  if (allUnevaluable) return { primary: 'unevaluable_at_10m', secondary: [...new Set(secondary)] };
  return { primary: 'neither_valid_no_assessment_match', secondary: [...new Set(secondary)] };
}

function deriveFrameOutcome(egoLeft, egoRight, selectionMeta, observations) {
  const availability = deriveCandidateAvailability(selectionMeta.leftSel, selectionMeta.rightSel);
  const reason = deriveFrameAssessmentReason(selectionMeta.leftSel, selectionMeta.rightSel, observations);
  if (availability === 'both_valid') return 'two_valid_ego_candidates';
  if (availability === 'left_only_valid') return 'left_only_valid';
  if (availability === 'right_only_valid') return 'right_only_valid';
  if (reason.primary === 'rejected_both_confidence' || reason.primary === 'rejected_left_confidence' || reason.primary === 'rejected_right_confidence') {
    return 'uncertain_confidence';
  }
  if (reason.primary === 'rejected_both_uncertainty' || reason.primary === 'rejected_left_uncertainty' || reason.primary === 'rejected_right_uncertainty') {
    return 'uncertain_uncertainty';
  }
  if (reason.primary === 'ordering_or_crossing') return 'uncertain_ordering_or_crossing';
  if (reason.primary === 'malformed_geometry' || reason.primary === 'unevaluable_at_10m') return 'uncertain_geometry';
  return 'neither_valid';
}

function retainedEgoCount(leftSel, rightSel) {
  return (leftSel?.validEgo ? 1 : 0) + (rightSel?.validEgo ? 1 : 0);
}

function inferSlotRoleFromStats(pctLeft, pctRight, medianY, egoRate) {
  if (pctLeft > 0.8 && medianY > 0 && egoRate > 0.5) return 'inner_left_ego';
  if (pctRight > 0.8 && medianY < 0 && egoRate > 0.5) return 'inner_right_ego';
  if (pctLeft > 0.8 && medianY > 2) return 'outer_left';
  if (pctRight > 0.8 && medianY < -2) return 'outer_right';
  return 'mixed_or_other';
}

function egoCandidateStatusForIndex(index, frameClass) {
  const leftIdx = frameClass.selectionMeta?.leftSel?.candidate?.index;
  const rightIdx = frameClass.selectionMeta?.rightSel?.candidate?.index;
  const leftValid = frameClass.selectionMeta?.leftSel?.validEgo;
  const rightValid = frameClass.selectionMeta?.rightSel?.validEgo;
  if (index === leftIdx && leftValid) return 'valid_retained_ego';
  if (index === rightIdx && rightValid) return 'valid_retained_ego';
  if (index === leftIdx || index === rightIdx) return 'rejected_ego_candidate';
  return 'not_ego_candidate';
}

function roadEdgeIntervalMetrics(modelV2, frameClass, opts = {}, slotRoleByIndex = {}) {
  const o = { ...ASSESSMENT_THRESHOLDS, ...opts };
  const edges = modelV2.roadEdges || [];
  const edgeStds = modelV2.roadEdgeStds || [];

  const edgeLaterals = [];
  for (let i = 0; i < edges.length; i++) {
    const lat = lateralAtForwardX(edges[i], o.evalForwardXM);
    if (lat != null) edgeLaterals.push({ index: i, lateral: lat, std: edgeStds[i] ?? null });
  }

  if (!edgeLaterals.length) {
    return {
      comparable: false,
      reason: 'missing_road_edges_at_eval_distance',
      evalForwardXM: o.evalForwardXM,
    };
  }

  const leftEdgeY = Math.max(...edgeLaterals.map((e) => e.lateral));
  const rightEdgeY = Math.min(...edgeLaterals.map((e) => e.lateral));
  const crossingEdges = leftEdgeY < rightEdgeY;

  const lineResults = [];
  for (const ob of frameClass?.observations || []) {
    if (ob.malformed || ob.missingEval) continue;
    const inside = !crossingEdges && ob.lateralAtEvalM >= rightEdgeY && ob.lateralAtEvalM <= leftEdgeY;
    const heuristicClass = classifyObservationHeuristic(ob, frameClass);
    const egoStatus = egoCandidateStatusForIndex(ob.index, frameClass);
    lineResults.push({
      index: ob.index,
      inferredSlotRole: slotRoleByIndex[ob.index] || 'unknown',
      lateralAtEvalM: ob.lateralAtEvalM,
      insideRoadEdgeInterval: inside,
      heuristicClass,
      egoCandidateStatus: egoStatus,
      prob: ob.prob,
      std: ob.std,
    });
  }

  const retainedLeftInside = frameClass?.egoLeft
    && lineResults.find((l) => l.index === frameClass.egoLeft.index && l.egoCandidateStatus === 'valid_retained_ego')?.insideRoadEdgeInterval;
  const retainedRightInside = frameClass?.egoRight
    && lineResults.find((l) => l.index === frameClass.egoRight.index && l.egoCandidateStatus === 'valid_retained_ego')?.insideRoadEdgeInterval;

  return {
    comparable: lineResults.length > 0,
    evalForwardXM: o.evalForwardXM,
    leftEdgeLateralM: leftEdgeY,
    rightEdgeLateralM: rightEdgeY,
    crossingOrMalformedEdges: crossingEdges,
    comparableLineObservations: lineResults.length,
    lineObservationsInsideInterval: lineResults.filter((l) => l.insideRoadEdgeInterval).length,
    pctLineObservationsInside: lineResults.length
      ? lineResults.filter((l) => l.insideRoadEdgeInterval).length / lineResults.length
      : null,
    bothRetainedEgoCandidatesInside: retainedLeftInside === true && retainedRightInside === true,
    atLeastOneRetainedEgoCandidateInside: retainedLeftInside === true || retainedRightInside === true,
    lineResults,
    note: 'Road edges are not ground-truth lane-divider labels; frame inside metrics use retained valid ego candidates only.',
  };
}

function classifyObservationHeuristic(ob, frameClass) {
  const cls = frameClass?.classifications || {};
  for (const [k, ids] of Object.entries(cls)) {
    if (ids.includes(ob.index)) return k;
  }
  return 'unclassified';
}

function buildSlotSemantics(modelEvents, opts = {}) {
  const o = { ...ASSESSMENT_THRESHOLDS, ...opts };
  const slots = [0, 1, 2, 3].map((index) => ({
    index,
    lateralAtEvalM: [],
    probs: [],
    stds: [],
    leftOfCentre: 0,
    rightOfCentre: 0,
    atCentre: 0,
    selectedAsEgoBoundary: 0,
    selectedAsAdjacentDivider: 0,
    malformedOrMissing: 0,
    totalObservations: 0,
  }));

  for (const ev of modelEvents) {
    const mv = ev.modelV2 || {};
    const lines = mv.laneLines || [];
    const probs = mv.laneLineProbs || [];
    const stds = mv.laneLineStds || [];
    const frame = classifyFrameLines(mv, o);

    for (let i = 0; i < Math.max(lines.length, 4); i++) {
      if (i > 3) break;
      const slot = slots[i];
      slot.totalObservations++;
      const line = lines[i];
      const ob = evaluateLineObservation(i, line, probs[i], stds[i], o);

      if (ob.malformed || ob.missingEval) {
        slot.malformedOrMissing++;
        continue;
      }
      slot.lateralAtEvalM.push(ob.lateralAtEvalM);
      slot.probs.push(ob.prob);
      if (ob.std != null) slot.stds.push(ob.std);
      if (ob.side === 'left') slot.leftOfCentre++;
      else if (ob.side === 'right') slot.rightOfCentre++;
      else slot.atCentre++;

      if (frame.classifications.ego_lane_boundaries.includes(i)) slot.selectedAsEgoBoundary++;
      if (frame.classifications.probable_adjacent_dividers.includes(i)) slot.selectedAsAdjacentDivider++;
    }
  }

  return slots.map((slot) => ({
    index: slot.index,
    totalObservations: slot.totalObservations,
    lateralAtEvalM: summarizeNumeric(slot.lateralAtEvalM),
    laneLineProb: summarizeNumeric(slot.probs),
    laneLineStd: summarizeNumeric(slot.stds),
    sideFrequency: {
      leftOfCentre: slot.leftOfCentre,
      rightOfCentre: slot.rightOfCentre,
      atCentre: slot.atCentre,
      pctLeft: slot.totalObservations ? slot.leftOfCentre / slot.totalObservations : 0,
      pctRight: slot.totalObservations ? slot.rightOfCentre / slot.totalObservations : 0,
    },
    selectedAsEgoBoundary: slot.selectedAsEgoBoundary,
    selectedAsAdjacentDivider: slot.selectedAsAdjacentDivider,
    malformedOrMissing: slot.malformedOrMissing,
    inferredRole: inferSlotRole(slot),
  }));
}

function inferSlotRole(slot) {
  const total = slot.totalObservations - slot.malformedOrMissing;
  if (!total) return 'unknown_malformed';
  const lat = summarizeNumeric(slot.lateralAtEvalM);
  const pctLeft = slot.leftOfCentre / total;
  const pctRight = slot.rightOfCentre / total;
  const egoRate = slot.selectedAsEgoBoundary / total;
  const adjRate = slot.selectedAsAdjacentDivider / total;

  if (pctLeft > 0.8 && lat.median > 0 && egoRate > 0.5) return 'predominantly_inner_left_ego_candidate';
  if (pctRight > 0.8 && lat.median < 0 && egoRate > 0.5) return 'predominantly_inner_right_ego_candidate';
  if (pctLeft > 0.8 && lat.median > 2) return 'predominantly_outer_left';
  if (pctRight > 0.8 && lat.median < -2) return 'predominantly_outer_right';
  if (adjRate > 0.3) return 'frequently_adjacent_divider_candidate';
  return 'mixed_or_uncertain_slot_semantics';
}

function emptyMatrixCell() {
  return {
    frameCount: 0,
    retainedClassificationCount: 0,
    rejectionReasonCounts: {},
    leftSlotIndexCounts: {},
    rightSlotIndexCounts: {},
    probs: [],
    stds: [],
  };
}

function recordMatrixCell(cell, frame, side) {
  cell.frameCount++;
  cell.retainedClassificationCount += frame.retainedEgoCandidateCount;
  const reason = frame.frameAssessmentReason;
  cell.rejectionReasonCounts[reason] = (cell.rejectionReasonCounts[reason] || 0) + 1;
  if (frame.egoLeft) {
    const k = String(frame.egoLeft.index);
    cell.leftSlotIndexCounts[k] = (cell.leftSlotIndexCounts[k] || 0) + 1;
    if (side === 'left' || side === 'both') {
      if (frame.egoLeft.prob != null) cell.probs.push(frame.egoLeft.prob);
      if (frame.egoLeft.std != null) cell.stds.push(frame.egoLeft.std);
    }
  }
  if (frame.egoRight) {
    const k = String(frame.egoRight.index);
    cell.rightSlotIndexCounts[k] = (cell.rightSlotIndexCounts[k] || 0) + 1;
    if (side === 'right' || side === 'both') {
      if (frame.egoRight.prob != null) cell.probs.push(frame.egoRight.prob);
      if (frame.egoRight.std != null) cell.stds.push(frame.egoRight.std);
    }
  }
}

function finalizeMatrixCell(cell) {
  const topReason = Object.entries(cell.rejectionReasonCounts).sort((a, b) => b[1] - a[1])[0];
  return {
    frameCount: cell.frameCount,
    retainedClassificationCount: cell.retainedClassificationCount,
    mostCommonAssessmentReason: topReason ? topReason[0] : null,
    mostCommonAssessmentReasonCount: topReason ? topReason[1] : 0,
    leftSlotIndexDistribution: cell.leftSlotIndexCounts,
    rightSlotIndexDistribution: cell.rightSlotIndexCounts,
    prob: summarizeNumeric(cell.probs),
    std: summarizeNumeric(cell.stds),
  };
}

function buildRoadEdgeBreakdown(lineAccumulator) {
  const byIndex = {};
  const bySlotRole = {};
  const byHeuristicClass = {};
  const byEgoStatus = {};

  for (const row of lineAccumulator) {
    for (const key of [
      ['byIndex', row.index],
      ['bySlotRole', row.inferredSlotRole],
      ['byHeuristicClass', row.heuristicClass],
      ['byEgoStatus', row.egoCandidateStatus],
    ]) {
      const map = key[0] === 'byIndex' ? byIndex : key[0] === 'bySlotRole' ? bySlotRole : key[0] === 'byHeuristicClass' ? byHeuristicClass : byEgoStatus;
      const k = String(key[1]);
      if (!map[k]) map[k] = { comparable: 0, inside: 0 };
      map[k].comparable++;
      if (row.inside) map[k].inside++;
    }
  }

  const finalize = (map) => Object.fromEntries(
    Object.entries(map).map(([k, v]) => [k, {
      comparableLineObservations: v.comparable,
      insideInterval: v.inside,
      pctInside: v.comparable ? v.inside / v.comparable : null,
    }]),
  );

  return {
    byLineIndex: finalize(byIndex),
    byInferredSlotRole: finalize(bySlotRole),
    byHeuristicClass: finalize(byHeuristicClass),
    byEgoCandidateStatus: finalize(byEgoStatus),
    totals: {
      comparableLineObservations: lineAccumulator.length,
      insideInterval: lineAccumulator.filter((r) => r.inside).length,
    },
  };
}

function verifyAccountingInvariants(audit) {
  const errors = [];
  const totalFrames = audit.egoBoundaryReconciliation?.totalFrames ?? 0;
  const avail = audit.candidateAvailability || {};
  const reasons = audit.frameAssessmentReasons || {};
  const availSum = Object.values(avail).reduce((a, b) => a + b, 0);
  const reasonSum = Object.values(reasons).reduce((a, b) => a + b, 0);
  const egoTotal = audit.classificationTotals?.ego_lane_boundaries ?? 0;

  if (availSum !== totalFrames) errors.push(`availability sum ${availSum} !== ${totalFrames}`);
  if (reasonSum !== totalFrames) errors.push(`reason sum ${reasonSum} !== ${totalFrames}`);

  const recon = audit.egoBoundaryReconciliation?.reconstructedRetainedClassifications;
  if (recon != null && recon !== egoTotal) {
    errors.push(`reconstructed retained ${recon} !== ego total ${egoTotal}`);
  }

  const formula = 2 * (avail.both_valid || 0) + (avail.left_only_valid || 0) + (avail.right_only_valid || 0);
  if (formula !== egoTotal) {
    errors.push(`2*both_valid+left_only+right_only = ${formula} !== ${egoTotal}`);
  }

  const re = audit.roadEdgeIntervalMetrics;
  if (re?.breakdown?.totals) {
    const t = re.breakdown.totals;
    if (t.insideInterval !== re.lineObservationsInsideInterval) {
      errors.push('road-edge breakdown inside total mismatch');
    }
    if (t.comparableLineObservations !== re.comparableLineObservations) {
      errors.push('road-edge breakdown comparable total mismatch');
    }
  }

  return { passed: errors.length === 0, errors };
}

function buildClassificationAudit(modelEvents, opts = {}) {
  const o = { ...ASSESSMENT_THRESHOLDS, ...opts };
  const slotSemantics = buildSlotSemantics(modelEvents, o);
  const slotRoleByIndex = Object.fromEntries(
    slotSemantics.map((s) => [s.index, s.inferredRole]),
  );

  const candidateAvailability = {
    both_valid: 0,
    left_only_valid: 0,
    right_only_valid: 0,
    neither_valid: 0,
  };
  const frameAssessmentReasons = {};
  const confidenceFailureSides = { left_only: 0, right_only: 0, both: 0 };
  const frameOutcomes = {};
  const classificationTotals = {
    ego_lane_boundaries: 0,
    probable_adjacent_dividers: 0,
    uncertain_outer_lines: 0,
    unclassifiable: 0,
  };

  const matrix = {
    both_valid: { left_valid_right_valid: emptyMatrixCell() },
    left_only_valid: { left_valid_right_invalid: emptyMatrixCell() },
    right_only_valid: { left_invalid_right_valid: emptyMatrixCell() },
    neither_valid: { left_invalid_right_invalid: emptyMatrixCell() },
  };

  let roadEdgeComparableFrames = 0;
  let roadEdgeComparableLineObs = 0;
  let roadEdgeInsideLineObs = 0;
  let framesBothRetainedEgoInside = 0;
  let framesAtLeastOneRetainedEgoInside = 0;
  let framesWithCrossingEdges = 0;
  const roadEdgeLineAccumulator = [];

  const beforeAfterSamples = [];
  const correctionDiffs = { indexChanged: 0, lateralDistanceChanged: 0, unchanged: 0 };

  for (const ev of modelEvents) {
    const mv = ev.modelV2 || {};
    const before = classifyFrameLinesBeforeFix(mv, o);
    const after = classifyFrameLines(mv, o);

    const avail = after.candidateAvailability;
    candidateAvailability[avail] = (candidateAvailability[avail] || 0) + 1;
    frameAssessmentReasons[after.frameAssessmentReason] = (frameAssessmentReasons[after.frameAssessmentReason] || 0) + 1;
    frameOutcomes[after.frameOutcome] = (frameOutcomes[after.frameOutcome] || 0) + 1;

    const leftConf = after.selectionMeta?.leftSel?.rejectionReason === 'confidence_below_assessment_threshold';
    const rightConf = after.selectionMeta?.rightSel?.rejectionReason === 'confidence_below_assessment_threshold';
    if (leftConf && rightConf) confidenceFailureSides.both++;
    else if (leftConf) confidenceFailureSides.left_only++;
    else if (rightConf) confidenceFailureSides.right_only++;

    for (const [k, ids] of Object.entries(after.classifications)) {
      classificationTotals[k] += ids.length;
    }

    const leftValid = !!after.selectionMeta?.leftSel?.validEgo;
    const rightValid = !!after.selectionMeta?.rightSel?.validEgo;
    if (avail === 'both_valid') recordMatrixCell(matrix.both_valid.left_valid_right_valid, after, 'both');
    else if (avail === 'left_only_valid') recordMatrixCell(matrix.left_only_valid.left_valid_right_invalid, after, 'left');
    else if (avail === 'right_only_valid') recordMatrixCell(matrix.right_only_valid.left_invalid_right_valid, after, 'right');
    else recordMatrixCell(matrix.neither_valid.left_invalid_right_invalid, after, 'neither');

    const bRight = before.egoRight?.index;
    const aRight = after.egoRight?.index;
    if (bRight !== aRight) correctionDiffs.indexChanged++;
    else if (before.egoRight && after.egoRight
      && Math.abs(before.egoRight.lateralAtEvalM - after.egoRight.lateralAtEvalM) > 0.01) {
      correctionDiffs.lateralDistanceChanged++;
    } else correctionDiffs.unchanged++;

    const edge = roadEdgeIntervalMetrics(mv, after, o, slotRoleByIndex);
    if (edge.comparable) {
      roadEdgeComparableFrames++;
      roadEdgeComparableLineObs += edge.comparableLineObservations;
      roadEdgeInsideLineObs += edge.lineObservationsInsideInterval;
      for (const lr of edge.lineResults) {
        roadEdgeLineAccumulator.push({
          index: lr.index,
          inferredSlotRole: lr.inferredSlotRole,
          heuristicClass: lr.heuristicClass,
          egoCandidateStatus: lr.egoCandidateStatus,
          inside: lr.insideRoadEdgeInterval,
        });
      }
      if (edge.bothRetainedEgoCandidatesInside) framesBothRetainedEgoInside++;
      if (edge.atLeastOneRetainedEgoCandidateInside) framesAtLeastOneRetainedEgoInside++;
    }
    if (edge.crossingOrMalformedEdges) framesWithCrossingEdges++;

    if (beforeAfterSamples.length < 5 && bRight !== aRight) {
      beforeAfterSamples.push({
        logMonoTime: ev.logMonoTime,
        before: { rightIndex: bRight, rightLateralM: before.egoRight?.lateralAtEvalM },
        after: { rightIndex: aRight, rightLateralM: after.egoRight?.lateralAtEvalM },
        outerRightIndex: after.egoRight?.outerRightIndex,
      });
    }
  }

  const totalFrames = modelEvents.length;
  const egoBoundaryTotal = classificationTotals.ego_lane_boundaries;
  const reconstructedRetained = 2 * candidateAvailability.both_valid
    + candidateAvailability.left_only_valid
    + candidateAvailability.right_only_valid;

  const candidateValidityMatrix = {
    rows: ['left_valid', 'left_invalid'],
    cols: ['right_valid', 'right_invalid'],
    cells: {
      left_valid_right_valid: finalizeMatrixCell(matrix.both_valid.left_valid_right_valid),
      left_valid_right_invalid: finalizeMatrixCell(matrix.left_only_valid.left_valid_right_invalid),
      left_invalid_right_valid: finalizeMatrixCell(matrix.right_only_valid.left_invalid_right_valid),
      left_invalid_right_invalid: finalizeMatrixCell(matrix.neither_valid.left_invalid_right_invalid),
    },
    rowTotals: {
      left_valid: candidateAvailability.both_valid + candidateAvailability.left_only_valid,
      left_invalid: candidateAvailability.right_only_valid + candidateAvailability.neither_valid,
      right_valid: candidateAvailability.both_valid + candidateAvailability.right_only_valid,
      right_invalid: candidateAvailability.left_only_valid + candidateAvailability.neither_valid,
    },
    columnTotals: {
      right_valid: candidateAvailability.both_valid + candidateAvailability.right_only_valid,
      right_invalid: candidateAvailability.left_only_valid + candidateAvailability.neither_valid,
    },
    grandTotal: totalFrames,
  };

  const roadEdgeBreakdown = buildRoadEdgeBreakdown(roadEdgeLineAccumulator);

  const result = {
    assessmentThresholds: ASSESSMENT_THRESHOLDS,
    v11MinLaneProbUsage: V11_MIN_LANE_PROB_USAGE,
    slotSemantics,
    candidateAvailability,
    candidateAvailabilityRates: Object.fromEntries(
      Object.entries(candidateAvailability).map(([k, v]) => [k, totalFrames ? v / totalFrames : 0]),
    ),
    frameAssessmentReasons,
    frameAssessmentReasonRates: Object.fromEntries(
      Object.entries(frameAssessmentReasons).map(([k, v]) => [k, totalFrames ? v / totalFrames : 0]),
    ),
    confidenceFailureSideBreakdown: confidenceFailureSides,
    frameOutcomes,
    frameOutcomeRates: Object.fromEntries(
      Object.entries(frameOutcomes).map(([k, v]) => [k, totalFrames ? v / totalFrames : 0]),
    ),
    classificationTotals,
    candidateValidityMatrix,
    egoBoundaryReconciliation: {
      totalFrames,
      totalLineObservations: totalFrames * 4,
      egoBoundaryClassifications: egoBoundaryTotal,
      retainedEgoClassifications: egoBoundaryTotal,
      egoBoundariesPerFrameMean: totalFrames ? egoBoundaryTotal / totalFrames : 0,
      bothValidFrames: candidateAvailability.both_valid,
      bothValidRetainedClassifications: 2 * candidateAvailability.both_valid,
      singleValidFrames: candidateAvailability.left_only_valid + candidateAvailability.right_only_valid,
      singleValidRetainedClassifications: candidateAvailability.left_only_valid + candidateAvailability.right_only_valid,
      reconstructedRetainedClassifications: reconstructedRetained,
      reconstructionFormula: '2 × both_valid + left_only_valid + right_only_valid',
      reconstructionMatchesTotal: reconstructedRetained === egoBoundaryTotal,
      exactlyTwoEgoPerFrame: egoBoundaryTotal === totalFrames * 2,
      explanation: reconstructedRetained === egoBoundaryTotal
        ? `Retained ego classifications reconcile: 2×${candidateAvailability.both_valid} + ${candidateAvailability.left_only_valid} + ${candidateAvailability.right_only_valid} = ${reconstructedRetained}. Single-valid frames (${candidateAvailability.left_only_valid + candidateAvailability.right_only_valid}) account for classifications beyond both-valid frames.`
        : 'Retained classification reconstruction failed — see invariants.',
    },
    rightBoundaryCorrection: {
      framesCompared: totalFrames,
      correctionDiffs,
      sampleChanges: beforeAfterSamples,
      rule: 'Before: outermost right (most negative y). After: nearest eligible right-side line (max y among y<0).',
    },
    roadEdgeIntervalMetrics: {
      evalForwardXM: o.evalForwardXM,
      comparableFrames: roadEdgeComparableFrames,
      comparableLineObservations: roadEdgeComparableLineObs,
      lineObservationsInsideInterval: roadEdgeInsideLineObs,
      pctLineObservationsInside: roadEdgeComparableLineObs
        ? roadEdgeInsideLineObs / roadEdgeComparableLineObs
        : null,
      framesBothRetainedEgoInside,
      framesBothRetainedEgoInsideDenominator: candidateAvailability.both_valid,
      framesBothRetainedEgoInsideRate: candidateAvailability.both_valid
        ? framesBothRetainedEgoInside / candidateAvailability.both_valid
        : null,
      framesAtLeastOneRetainedEgoInside,
      framesAtLeastOneRetainedEgoInsideDenominator: candidateAvailability.both_valid
        + candidateAvailability.left_only_valid
        + candidateAvailability.right_only_valid,
      framesAtLeastOneRetainedEgoInsideRate: (candidateAvailability.both_valid + candidateAvailability.left_only_valid + candidateAvailability.right_only_valid)
        ? framesAtLeastOneRetainedEgoInside / (candidateAvailability.both_valid + candidateAvailability.left_only_valid + candidateAvailability.right_only_valid)
        : null,
      framesWithCrossingOrMalformedEdges: framesWithCrossingEdges,
      breakdown: roadEdgeBreakdown,
      note: 'Line-level inside uses all comparable observations. Frame-level inside metrics use retained valid ego candidates only; denominators are availability-based.',
    },
  };

  result.accountingInvariants = verifyAccountingInvariants(result);
  return result;
}

/** Deterministic fixtures for validation */
const CLASSIFICATION_FIXTURES = {
  normalFourLineOrdering: {
    description: 'Standard inner-left, inner-right, outer-left, outer-right',
    modelV2: {
      laneLines: [
        { x: [5, 10, 20], y: [1.8, 1.7, 1.6], z: [], t: [] },
        { x: [5, 10, 20], y: [-1.8, -1.7, -1.6], z: [], t: [] },
        { x: [5, 10, 20], y: [5.0, 4.9, 4.8], z: [], t: [] },
        { x: [5, 10, 20], y: [-5.0, -4.9, -4.8], z: [], t: [] },
      ],
      laneLineProbs: [0.95, 0.92, 0.85, 0.15],
      laneLineStds: [0.08, 0.09, 0.12, 0.45],
    },
    expect: { rightEgoIndex: 1, beforeRightIndex: 3, frameOutcome: 'two_valid_ego_candidates' },
  },
  rightEgoCloserThanOuter: {
    description: 'Right ego at index 1 closer to centre than outer-right at index 3',
    modelV2: {
      laneLines: [
        { x: [10], y: [2.0], z: [], t: [] },
        { x: [10], y: [-1.5], z: [], t: [] },
        { x: [10], y: [5.0], z: [], t: [] },
        { x: [10], y: [-5.5], z: [], t: [] },
      ],
      laneLineProbs: [0.9, 0.88, 0.7, 0.6],
      laneLineStds: [0.1, 0.1, 0.2, 0.2],
    },
    expect: { rightEgoIndex: 1, beforeRightIndex: 3 },
  },
  missingRightEgoCandidate: {
    description: 'No eligible line on right side',
    modelV2: {
      laneLines: [
        { x: [10], y: [1.8], z: [], t: [] },
        { x: [10], y: [2.5], z: [], t: [] },
        { x: [10], y: [5.0], z: [], t: [] },
        { x: [10], y: [4.5], z: [], t: [] },
      ],
      laneLineProbs: [0.9, 0.85, 0.8, 0.7],
      laneLineStds: [0.1, 0.1, 0.1, 0.1],
    },
    expect: { rightEgoIndex: null, availability: 'left_only_valid', frameOutcome: 'left_only_valid' },
  },
  lowConfidenceInnerRight: {
    description: 'Inner right below assessment prob threshold',
    modelV2: {
      laneLines: [
        { x: [10], y: [1.8], z: [], t: [] },
        { x: [10], y: [-1.8], z: [], t: [] },
        { x: [10], y: [5.0], z: [], t: [] },
        { x: [10], y: [-5.0], z: [], t: [] },
      ],
      laneLineProbs: [0.9, 0.3, 0.85, 0.2],
      laneLineStds: [0.1, 0.1, 0.1, 0.1],
    },
    expect: {
      rightEgoIndex: null,
      availability: 'left_only_valid',
      frameOutcome: 'left_only_valid',
      assessmentReason: 'rejected_right_confidence',
    },
  },
  lineCrossingCentre: {
    description: 'Line spans vehicle centre in forward range',
    modelV2: {
      laneLines: [
        { x: [5, 10, 15], y: [2.0, -0.5, -2.0], z: [], t: [] },
        { x: [10], y: [-1.8], z: [], t: [] },
        { x: [10], y: [5.0], z: [], t: [] },
        { x: [10], y: [-5.0], z: [], t: [] },
      ],
      laneLineProbs: [0.9, 0.9, 0.8, 0.2],
      laneLineStds: [0.1, 0.1, 0.1, 0.1],
    },
    expect: { crossingLineIndex: 0 },
  },
  laneChangeLikeGeometry: {
    description: 'Asymmetric lateral offsets suggesting lane change',
    modelV2: {
      laneLines: [
        { x: [10], y: [0.3], z: [], t: [] },
        { x: [10], y: [-3.5], z: [], t: [] },
        { x: [10], y: [3.5], z: [], t: [] },
        { x: [10], y: [-5.5], z: [], t: [] },
      ],
      laneLineProbs: [0.85, 0.8, 0.75, 0.5],
      laneLineStds: [0.2, 0.2, 0.2, 0.3],
    },
    expect: { note: 'left candidate near centre; outcomes depend on side classification' },
  },
  malformedUnequalArrays: {
    description: 'Mismatched x/y array lengths',
    modelV2: {
      laneLines: [
        { x: [10, 15], y: [1.8], z: [], t: [] },
        { x: [10], y: [-1.8], z: [], t: [] },
        { x: [], y: [], z: [], t: [] },
        { x: [10], y: [-5.0], z: [], t: [] },
      ],
      laneLineProbs: [0.9, 0.9, 0.5, 0.5],
      laneLineStds: [0.1, 0.1, 0.1, 0.1],
    },
    expect: { malformedIndices: [0, 2] },
  },
};

module.exports = {
  ASSESSMENT_THRESHOLDS,
  V11_MIN_LANE_PROB_USAGE,
  detectCenterCrossing,
  isMalformedLine,
  evaluateLineObservation,
  selectEgoCandidate,
  classifyFrameLinesBeforeFix,
  classifyFrameLines,
  roadEdgeIntervalMetrics,
  buildSlotSemantics,
  buildClassificationAudit,
  verifyAccountingInvariants,
  deriveCandidateAvailability,
  deriveFrameAssessmentReason,
  CLASSIFICATION_FIXTURES,
  deriveFrameOutcome,
};
