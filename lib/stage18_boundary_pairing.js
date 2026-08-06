/**
 * Stage 18 — adjacent divider-run pairing and lane-interval construction.
 */
const {
  PAIRING_OUTCOMES,
  INTERVAL_ASSESSMENT_STATUS,
  DEFAULT_INTERVAL_ASSESSMENT,
  WIDTH_ASSESSMENT_BANDS,
  buildLaneIntervalTemplate,
  STAGE18_PROCESSING_VERSION,
  INTERVAL_SCHEMA_VERSION,
} = require('./stage18_lane_interval_schema');
const {
  isFiniteWidth,
  isPositiveSignedWidth,
  isNonPositiveSignedWidth,
  widthBelowThreshold,
  widthAboveThreshold,
  widthWithinBand,
  WIDTH_TOLERANCE_DOCS,
} = require('./stage18_width_tolerance');
const {
  computeOverlap,
  evaluateLocalAdjacency,
  buildWidthProfileFromSamples,
  interpolateDAtS,
  assignLeftRight,
} = require('./stage18_local_adjacency');
const { gapOverlapsInterval } = require('./stage18_gap_checks');
const { buildNonPositiveDiagnostics } = require('./stage18_pairing_diagnostics');

function widthStats(widths) {
  const vals = widths.map((w) => w.widthM).filter(isFiniteWidth);
  if (!vals.length) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const mad = vals.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const robustSpread = mad[Math.floor(mad.length / 2)] * 1.4826;
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median,
    mean,
    std: Math.sqrt(variance),
    robustSpread,
    finiteSampleRate: vals.length / Math.max(1, widths.length),
    nonPositiveCount: vals.filter((w) => isNonPositiveSignedWidth(w)).length,
    invalidSampleCount: widths.length - vals.length,
    coordinateJumpCount: 0,
    bandRates: Object.fromEntries(WIDTH_ASSESSMENT_BANDS.map((b) => [b.label, 0])),
  };
}

function applyBandRates(stats, widths) {
  if (!stats) return stats;
  const total = widths.length || 1;
  for (const b of WIDTH_ASSESSMENT_BANDS) {
    const n = widths.filter((w) => widthWithinBand(w.widthM, b.min, b.max)).length;
    stats.bandRates[b.label] = n / total;
  }
  return stats;
}

function findCrossingRouteS(samples) {
  let prevSign = null;
  for (const sample of samples) {
    if (!isFiniteWidth(sample.widthM)) continue;
    const sign = sample.widthM > 0 ? 1 : sample.widthM < 0 ? -1 : 0;
    if (prevSign != null && sign !== 0 && prevSign !== 0 && sign !== prevSign) {
      return sample.s;
    }
    if (sign !== 0) prevSign = sign;
  }
  return null;
}

function crossingDiagnostics(samples, crossingS) {
  if (crossingS == null) return null;
  const idx = samples.findIndex((s) => s.s === crossingS);
  const around = samples.slice(Math.max(0, idx - 1), Math.min(samples.length, idx + 2));
  return {
    crossingRouteS: crossingS,
    signedWidthsAroundCrossing: around.map((s) => ({ s: s.s, widthM: s.widthM, leftD: s.leftD, rightD: s.rightD })),
  };
}

function classifyIntervalStatus(stats, pairingOutcome, pairResult, options = {}) {
  const o = { ...DEFAULT_INTERVAL_ASSESSMENT, ...options };
  if (pairResult.metrics?.crossingCandidate) {
    return INTERVAL_ASSESSMENT_STATUS.CROSSING_OR_INVALID_ORDER;
  }
  if (pairingOutcome !== PAIRING_OUTCOMES.ACCEPTED) {
    if (pairingOutcome === PAIRING_OUTCOMES.REJECTED_AMBIGUOUS) return INTERVAL_ASSESSMENT_STATUS.AMBIGUOUS;
    if (pairingOutcome === PAIRING_OUTCOMES.REJECTED_CROSSING || pairingOutcome === PAIRING_OUTCOMES.REJECTED_ORDER_FAILURE) {
      return INTERVAL_ASSESSMENT_STATUS.CROSSING_OR_INVALID_ORDER;
    }
    return INTERVAL_ASSESSMENT_STATUS.INSUFFICIENT_SUPPORT;
  }
  if (!stats || stats.nonPositiveCount > 0 || stats.invalidSampleCount > 0) {
    return INTERVAL_ASSESSMENT_STATUS.CROSSING_OR_INVALID_ORDER;
  }
  if (widthBelowThreshold(stats.min, o.narrowWidthThresholdM)) return INTERVAL_ASSESSMENT_STATUS.NARROW_WIDTH_OUTLIER;
  if (widthAboveThreshold(stats.max, o.wideWidthThresholdM)) return INTERVAL_ASSESSMENT_STATUS.WIDE_WIDTH_OUTLIER;
  if (stats.std > o.maxWidthStdM || (stats.max - stats.min) > o.maxWidthVariationM) {
    return INTERVAL_ASSESSMENT_STATUS.UNSTABLE_WIDTH;
  }
  return INTERVAL_ASSESSMENT_STATUS.PLAUSIBLE_PROTOTYPE;
}

function evaluatePair(leftInput, rightInput, allRuns, options = {}) {
  const o = { ...DEFAULT_INTERVAL_ASSESSMENT, ...options };
  const overlap = options.overlap || computeOverlap(leftInput, rightInput);
  const detail = {
    leftRunId: leftInput.dividerRunId,
    rightRunId: rightInput.dividerRunId,
    outcome: PAIRING_OUTCOMES.ACCEPTED,
    reasons: [],
    metrics: { routeSOverlapM: overlap.span },
    overlap,
    widths: [],
    leftPts: [],
    rightPts: [],
    swapped: false,
  };

  if (leftInput.temporalPassId !== rightInput.temporalPassId || leftInput.poseSectionId !== rightInput.poseSectionId) {
    detail.outcome = PAIRING_OUTCOMES.REJECTED_BOUNDARY;
    detail.reasons.push('pass_or_section_mismatch');
    return detail;
  }
  if (leftInput.chunkId !== rightInput.chunkId) {
    detail.outcome = PAIRING_OUTCOMES.REJECTED_BOUNDARY;
    detail.reasons.push('chunk_boundary');
    return detail;
  }
  if (leftInput.meanD < rightInput.meanD - o.lateralOrderToleranceM) {
    detail.outcome = PAIRING_OUTCOMES.REJECTED_ORDER_FAILURE;
    detail.reasons.push('invalid_mean_lateral_order');
    return detail;
  }

  const adjacency = evaluateLocalAdjacency(leftInput, rightInput, allRuns, overlap, o);
  const left = adjacency.left;
  const right = adjacency.right;
  detail.leftRunId = left.dividerRunId;
  detail.rightRunId = right.dividerRunId;
  detail.swapped = adjacency.swapped;
  detail.adjacency = {
    adjacencyState: adjacency.adjacencyState,
    lateralOrderAt: adjacency.lateralOrderAt,
    orderExchangeAcrossOverlap: adjacency.orderExchange,
    validSubrangeCount: adjacency.validSubranges.length,
  };

  if (left.meanD < right.meanD - o.lateralOrderToleranceM) {
    detail.outcome = PAIRING_OUTCOMES.REJECTED_ORDER_FAILURE;
    detail.reasons.push('invalid_lateral_order_after_assignment');
    return detail;
  }

  if (overlap.span < o.minSharedRouteSM) {
    detail.outcome = PAIRING_OUTCOMES.REJECTED_INSUFFICIENT_SUPPORT;
    detail.reasons.push('insufficient_route_s_overlap');
    return detail;
  }

  const gaps = options.gaps || [];
  const pseudoIv = {
    leftParentTrackId: left.parentTrackId,
    rightParentTrackId: right.parentTrackId,
    routeSStart: detail.overlap.lo,
    routeSEnd: detail.overlap.hi,
  };
  const overlappingGaps = gaps.filter((g) => gapOverlapsInterval(pseudoIv, g));
  if (overlappingGaps.length) {
    detail.outcome = PAIRING_OUTCOMES.REJECTED_BOUNDARY;
    detail.reasons.push(`parent_track_gap:${overlappingGaps.map((g) => g.gapId).join(',')}`);
    return detail;
  }

  if (adjacency.adjacencyState === 'none') {
    if (adjacency.interveningSampleCount > 0) {
      detail.outcome = PAIRING_OUTCOMES.REJECTED_INTERVENING_DIVIDER;
      detail.reasons.push('intervening_divider_across_overlap');
      return detail;
    }
    detail.outcome = PAIRING_OUTCOMES.REJECTED_NON_ADJACENT;
    detail.reasons.push('no_locally_adjacent_samples');
    return detail;
  }

  if (adjacency.adjacencyState === 'partial_span') {
    if (!adjacency.validSubranges.length) {
      detail.outcome = PAIRING_OUTCOMES.REJECTED_NON_ADJACENT;
      detail.reasons.push('partial_span_no_valid_subrange');
      return detail;
    }
    detail.reasons.push('partial_span_adjacency');
  }

  const activeSubrange = options.activeSubrange
    || adjacency.validSubranges[0]
    || { lo: overlap.lo, hi: overlap.hi, span: overlap.span };
  const activeSamples = adjacency.samples.filter((s) => s.s >= activeSubrange.lo && s.s <= activeSubrange.hi);
  detail.overlap = { lo: activeSubrange.lo, hi: activeSubrange.hi, span: activeSubrange.hi - activeSubrange.lo };
  detail.metrics.routeSOverlapM = detail.overlap.span;

  if (adjacency.orderExchange) {
    detail.reasons.push('geometric_crossing_candidate');
    detail.metrics.crossingCandidate = true;
    detail.crossingDiagnostics = crossingDiagnostics(adjacency.samples, findCrossingRouteS(adjacency.samples));
  }

  const adjacentSamples = activeSamples.filter((s) => s.adjacent);
  const { widths, leftPts, rightPts } = buildWidthProfileFromSamples(adjacentSamples.length ? adjacentSamples : activeSamples);
  let stats = widthStats(widths);
  stats = applyBandRates(stats, widths);
  detail.metrics.widthStats = stats;
  detail.metrics.widthSamples = widths.length;

  const hasNonPositive = widths.some((w) => isNonPositiveSignedWidth(w.widthM));
  const hasInvalid = widths.some((w) => !isFiniteWidth(w.widthM));

  if (!stats || hasNonPositive || hasInvalid) {
    detail.outcome = PAIRING_OUTCOMES.REJECTED_NON_POSITIVE_WIDTH;
    detail.reasons.push('non_positive_width');
    detail.nonPositiveDiagnostics = buildNonPositiveDiagnostics(left, right, adjacency, widths, detail);
    return { ...detail, widths, leftPts, rightPts };
  }

  if (detail.metrics.crossingCandidate) {
    detail.outcome = PAIRING_OUTCOMES.REJECTED_CROSSING;
    detail.reasons.push('geometric_crossing_rejected');
    return { ...detail, widths, leftPts, rightPts };
  }

  if (widthBelowThreshold(stats.min, o.narrowWidthThresholdM) || widthAboveThreshold(stats.max, o.wideWidthThresholdM)) {
    detail.outcome = PAIRING_OUTCOMES.REJECTED_WIDTH_OUTLIER;
    detail.reasons.push('width_outlier');
    return { ...detail, widths, leftPts, rightPts };
  }
  if (stats.std > o.maxWidthStdM || (stats.max - stats.min) > o.maxWidthVariationM) {
    detail.outcome = PAIRING_OUTCOMES.REJECTED_UNSTABLE_WIDTH;
    detail.reasons.push('unstable_width');
    return { ...detail, widths, leftPts, rightPts };
  }

  for (const w of widths) {
    if (!isPositiveSignedWidth(w.widthM)) {
      detail.outcome = PAIRING_OUTCOMES.REJECTED_NON_POSITIVE_WIDTH;
      detail.reasons.push('non_positive_width_at_required_sample');
      detail.nonPositiveDiagnostics = buildNonPositiveDiagnostics(left, right, adjacency, widths, detail);
      return { ...detail, widths, leftPts, rightPts };
    }
  }

  return { ...detail, widths, leftPts, rightPts };
}

function makeIntervalId(left, right, overlap) {
  return `${left.chunkId}:${left.temporalPassId}:${left.poseSectionId}:interval:${left.dividerRunId}:${right.dividerRunId}:${overlap.lo.toFixed(1)}:${overlap.hi.toFixed(1)}`;
}

function buildIntervalFromPair(left, right, pairResult, options = {}) {
  const createdAt = options.createdAt || new Date().toISOString();
  const overlap = pairResult.overlap || computeOverlap(left, right);
  const assessmentStatus = classifyIntervalStatus(pairResult.metrics.widthStats, pairResult.outcome, pairResult, options);
  const obsIds = [...new Set([...(left.observationIds || []), ...(right.observationIds || [])])].sort();
  return {
    ...buildLaneIntervalTemplate(),
    schemaVersion: INTERVAL_SCHEMA_VERSION,
    processingVersion: STAGE18_PROCESSING_VERSION,
    laneIntervalId: makeIntervalId(left, right, overlap),
    leftDividerRunId: left.dividerRunId,
    rightDividerRunId: right.dividerRunId,
    leftParentTrackId: left.parentTrackId,
    rightParentTrackId: right.parentTrackId,
    temporalPassId: left.temporalPassId,
    poseSectionId: left.poseSectionId,
    chunkId: left.chunkId,
    routeSStart: overlap.lo,
    routeSEnd: overlap.hi,
    routeSpanM: overlap.span,
    leftRouteD: pairResult.leftPts || [],
    rightRouteD: pairResult.rightPts || [],
    widthSamples: pairResult.widths || [],
    widthStats: pairResult.metrics?.widthStats || null,
    overlappingSupportLengthM: overlap.span,
    supportingObservationIds: obsIds,
    supportingFrameCount: new Set(obsIds.map((id) => id.split(':')[2])).size,
    confidenceSummary: {
      mean: ((left.confidenceSummary?.mean ?? 1) + (right.confidenceSummary?.mean ?? 1)) / 2,
    },
    uncertaintySummary: {
      mean: ((left.uncertaintySummary?.mean ?? 0) + (right.uncertaintySummary?.mean ?? 0)) / 2,
    },
    boundaryContinuityState: pairResult.adjacency?.adjacencyState === 'partial_span'
      ? 'partial_span_adjacent_overlap'
      : 'full_span_adjacent_overlap',
    sourceSegmentIds: [...new Set([...(left.segmentIds || []), ...(right.segmentIds || [])])].sort((a, b) => a - b),
    sourceChunkIds: [left.chunkId],
    assessmentStatus,
    assessmentReasons: pairResult.reasons,
    pairingOutcome: pairResult.outcome,
    adjacencyReport: pairResult.adjacency || null,
    provenance: { pipelineStage: 'stage18_lane_interval_construction', createdAt },
  };
}

function hasMeanDInterveningDivider(left, right, allRuns, overlap, options = {}) {
  const o = { ...DEFAULT_INTERVAL_ASSESSMENT, ...options };
  const lo = Math.min(left.meanD, right.meanD);
  const hi = Math.max(left.meanD, right.meanD);
  for (const mid of allRuns) {
    if (mid.dividerRunId === left.dividerRunId || mid.dividerRunId === right.dividerRunId) continue;
    if (mid.meanD <= lo + o.lateralOrderToleranceM || mid.meanD >= hi - o.lateralOrderToleranceM) continue;
    const ov = computeOverlap(mid, { routeSStart: overlap.lo, routeSEnd: overlap.hi });
    if (ov.span > 0) return mid;
  }
  return null;
}

function findRightNeighbor(left, runs, options = {}) {
  const o = { ...DEFAULT_INTERVAL_ASSESSMENT, ...options };
  const candidates = runs
    .filter((r) => r.dividerRunId !== left.dividerRunId && r.meanD < left.meanD - o.lateralOrderToleranceM)
    .map((r) => ({ run: r, overlap: computeOverlap(left, r) }))
    .filter((x) => x.overlap.span >= o.minSharedRouteSM)
    .sort((a, b) => b.run.meanD - a.run.meanD || a.run.dividerRunId.localeCompare(b.run.dividerRunId));

  for (const { run: right, overlap } of candidates) {
    if (hasMeanDInterveningDivider(left, right, runs, overlap, o)) continue;
    const assigned = assignLeftRight(left, right, o);
    return { right: assigned.right, left: assigned.left, overlap, activeSubrange: overlap };
  }
  return null;
}

function pairAdjacentRunsInGroup(runs, options = {}) {
  const pairingDecisions = [];
  const acceptedIntervals = [];
  const rejectedIntervals = [];
  const paired = new Set();

  for (const left of [...runs].sort((a, b) => b.meanD - a.meanD || a.dividerRunId.localeCompare(b.dividerRunId))) {
    const neighbor = findRightNeighbor(left, runs, options);
    if (!neighbor) continue;
    const { right, activeSubrange } = neighbor;
    const pairKey = [left.dividerRunId, right.dividerRunId].sort().join('|');
    if (paired.has(pairKey)) continue;
    paired.add(pairKey);

    const pairResult = evaluatePair(left, right, runs, { ...options, overlap: neighbor.overlap, activeSubrange });
    pairingDecisions.push(pairResult);
    const interval = buildIntervalFromPair(neighbor.left, neighbor.right, pairResult, options);
    if (pairResult.outcome === PAIRING_OUTCOMES.ACCEPTED) acceptedIntervals.push(interval);
    else rejectedIntervals.push(interval);
  }

  return { pairingDecisions, acceptedIntervals, rejectedIntervals };
}

function constructLaneIntervals(eligibleGroups, options = {}) {
  const allPairingDecisions = [];
  const acceptedIntervals = [];
  const rejectedIntervals = [];

  const sortedKeys = [...eligibleGroups.keys()].sort();
  for (const key of sortedKeys) {
    const result = pairAdjacentRunsInGroup(eligibleGroups.get(key), options);
    for (const d of result.pairingDecisions) allPairingDecisions.push(d);
    for (const iv of result.acceptedIntervals) acceptedIntervals.push(iv);
    for (const iv of result.rejectedIntervals) rejectedIntervals.push(iv);
  }

  acceptedIntervals.sort((a, b) => a.laneIntervalId.localeCompare(b.laneIntervalId));
  rejectedIntervals.sort((a, b) => a.laneIntervalId.localeCompare(b.laneIntervalId));

  return {
    pairingDecisions: allPairingDecisions,
    acceptedIntervals,
    rejectedIntervals,
    allIntervals: [...acceptedIntervals, ...rejectedIntervals],
  };
}

module.exports = {
  evaluatePair,
  pairAdjacentRunsInGroup,
  constructLaneIntervals,
  computeOverlap,
  widthStats,
  interpolateDAtS,
  findRightNeighbor,
  WIDTH_TOLERANCE_DOCS,
};
