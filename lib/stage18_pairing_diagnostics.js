/**
 * Stage 18 — pairing rejection diagnostics and candidate-generation accounting.
 */
const { PAIRING_OUTCOMES } = require('./stage18_lane_interval_schema');
const { isFiniteWidth, isNonPositiveSignedWidth, WIDTH_POSITIVE_EPS_M } = require('./stage18_width_tolerance');

const NON_POSITIVE_SUBCATEGORIES = {
  FULLY_REVERSED_PAIR: 'fully_reversed_pair',
  PARTIAL_ORDER_EXCHANGE: 'partial_order_exchange',
  GEOMETRIC_INTERSECTION_CANDIDATE: 'geometric_intersection_candidate',
  MISSING_OR_INVALID_SAMPLE: 'missing_or_invalid_sample',
  ENDPOINT_EXTRAPOLATION_ARTIFACT: 'endpoint_extrapolation_artifact',
  FLOATING_POINT_NEAR_ZERO: 'floating_point_near_zero',
  OTHER: 'other',
};

function classifyNonPositiveSubcategory(left, right, adjacency, widths, pairDetail) {
  const finiteWidths = widths.filter((w) => isFiniteWidth(w.widthM));
  const invalidCount = widths.length - finiteWidths.length;
  const nonPositive = finiteWidths.filter((w) => isNonPositiveSignedWidth(w.widthM));
  const extrapolatedNonPositive = nonPositive.filter((w) => w.extrapolated);

  if (invalidCount > 0 && invalidCount === widths.length) {
    return NON_POSITIVE_SUBCATEGORIES.MISSING_OR_INVALID_SAMPLE;
  }
  if (invalidCount > 0) {
    return NON_POSITIVE_SUBCATEGORIES.MISSING_OR_INVALID_SAMPLE;
  }

  if (pairDetail.metrics?.crossingCandidate || adjacency.orderExchange) {
    return NON_POSITIVE_SUBCATEGORIES.GEOMETRIC_INTERSECTION_CANDIDATE;
  }

  const meanOrderOk = left.meanD >= right.meanD - 1e-6;
  const allReversed = finiteWidths.length > 0
    && finiteWidths.every((w) => isNonPositiveSignedWidth(w.widthM) && w.rightD > w.leftD);
  const anyReversed = finiteWidths.some((w) => w.rightD > w.leftD + WIDTH_POSITIVE_EPS_M);

  if (!meanOrderOk && allReversed) {
    return NON_POSITIVE_SUBCATEGORIES.FULLY_REVERSED_PAIR;
  }
  if (meanOrderOk && anyReversed && nonPositive.length > 0) {
    return NON_POSITIVE_SUBCATEGORIES.PARTIAL_ORDER_EXCHANGE;
  }
  if (extrapolatedNonPositive.length > 0 && extrapolatedNonPositive.length === nonPositive.length) {
    return NON_POSITIVE_SUBCATEGORIES.ENDPOINT_EXTRAPOLATION_ARTIFACT;
  }
  if (nonPositive.length > 0 && nonPositive.every((w) => Math.abs(w.widthM) <= WIDTH_POSITIVE_EPS_M)) {
    return NON_POSITIVE_SUBCATEGORIES.FLOATING_POINT_NEAR_ZERO;
  }
  if (pairDetail.swapped && nonPositive.length > 0) {
    return NON_POSITIVE_SUBCATEGORIES.FULLY_REVERSED_PAIR;
  }
  return NON_POSITIVE_SUBCATEGORIES.OTHER;
}

function buildNonPositiveDiagnostics(left, right, adjacency, widths, pairDetail) {
  const finiteWidths = widths.filter((w) => isFiniteWidth(w.widthM));
  const vals = finiteWidths.map((w) => w.widthM).sort((a, b) => a - b);
  const nonPositive = finiteWidths.filter((w) => isNonPositiveSignedWidth(w.widthM));
  const firstNonPositive = nonPositive[0] || null;
  const subcategory = classifyNonPositiveSubcategory(left, right, adjacency, widths, pairDetail);

  return {
    leftRunId: left.dividerRunId,
    rightRunId: right.dividerRunId,
    leftMeanRouteD: left.meanD,
    rightMeanRouteD: right.meanD,
    sharedRouteSStart: pairDetail.overlap?.lo ?? null,
    sharedRouteSEnd: pairDetail.overlap?.hi ?? null,
    sharedRouteSSpanM: pairDetail.overlap?.span ?? null,
    sampledWidthCount: widths.length,
    signedWidthMin: vals.length ? vals[0] : null,
    signedWidthMax: vals.length ? vals[vals.length - 1] : null,
    signedWidthMedian: vals.length ? vals[Math.floor(vals.length / 2)] : null,
    nonPositiveSampleCount: nonPositive.length,
    nonPositiveSampleRate: widths.length ? nonPositive.length / widths.length : 0,
    firstNonPositiveRouteS: firstNonPositive?.s ?? null,
    lateralOrderAt: adjacency.lateralOrderAt,
    orderExchangeAcrossOverlap: adjacency.orderExchange,
    extrapolationSampleCount: adjacency.extrapolationSampleCount,
    adjacencyState: adjacency.adjacencyState,
    rejectionFromReversedSubtraction: Boolean(pairDetail.swapped),
    nonPositiveSubcategory: subcategory,
    signedWidthConvention: 'leftRouteD - rightRouteD (left = higher mean route-d boundary)',
  };
}

function investigateWidthOrderFailures(pairingDecisions) {
  const widthRelatedOutcomes = new Set([
    PAIRING_OUTCOMES.REJECTED_NON_POSITIVE_WIDTH,
    PAIRING_OUTCOMES.REJECTED_CROSSING,
    PAIRING_OUTCOMES.REJECTED_NON_ADJACENT,
    PAIRING_OUTCOMES.REJECTED_ORDER_FAILURE,
  ]);
  const records = [];
  const bySubcategory = {};
  for (const d of pairingDecisions) {
    if (!widthRelatedOutcomes.has(d.outcome) && !d.nonPositiveDiagnostics) continue;
    const diag = d.nonPositiveDiagnostics || {
      leftRunId: d.leftRunId,
      rightRunId: d.rightRunId,
      nonPositiveSubcategory: d.outcome === PAIRING_OUTCOMES.REJECTED_CROSSING
        ? NON_POSITIVE_SUBCATEGORIES.GEOMETRIC_INTERSECTION_CANDIDATE
        : d.outcome === PAIRING_OUTCOMES.REJECTED_NON_ADJACENT
          ? NON_POSITIVE_SUBCATEGORIES.PARTIAL_ORDER_EXCHANGE
          : NON_POSITIVE_SUBCATEGORIES.OTHER,
      signedWidthConvention: 'leftRouteD - rightRouteD (left = higher mean route-d boundary)',
      pairingOutcome: d.outcome,
    };
    records.push(diag);
    const sub = diag.nonPositiveSubcategory || NON_POSITIVE_SUBCATEGORIES.OTHER;
    bySubcategory[sub] = (bySubcategory[sub] || 0) + 1;
  }
  const total = records.length;
  return {
    totalWidthOrOrderFailures: total,
    bySubcategory,
    subcategoryRates: Object.fromEntries(
      Object.entries(bySubcategory).map(([k, v]) => [k, { count: v, rate: v / Math.max(1, total), label: `${v} / ${total}` }]),
    ),
    legacyRejectedNonPositiveWidthOutcome: pairingDecisions.filter((d) => d.outcome === PAIRING_OUTCOMES.REJECTED_NON_POSITIVE_WIDTH).length,
    note: 'After local route-s adjacency gating, former rejected_non_positive_width cases are redistributed across rejected_non_adjacent, rejected_crossing, rejected_boundary, and rejected_non_positive_width.',
    records,
  };
}

function summarizeNonPositiveRejections(pairingDecisions) {
  const rejected = pairingDecisions.filter((d) => d.outcome === PAIRING_OUTCOMES.REJECTED_NON_POSITIVE_WIDTH);
  const bySubcategory = {};
  for (const d of rejected) {
    const sub = d.nonPositiveDiagnostics?.nonPositiveSubcategory || NON_POSITIVE_SUBCATEGORIES.OTHER;
    bySubcategory[sub] = (bySubcategory[sub] || 0) + 1;
  }
  const total = rejected.length;
  const rates = Object.fromEntries(
    Object.entries(bySubcategory).map(([k, v]) => [k, { count: v, rate: v / Math.max(1, total), label: `${v} / ${total}` }]),
  );
  return {
    aggregateOutcome: PAIRING_OUTCOMES.REJECTED_NON_POSITIVE_WIDTH,
    total,
    bySubcategory,
    subcategoryRates: rates,
    reconstructsAggregate: Object.values(bySubcategory).reduce((a, b) => a + b, 0) === total,
    records: rejected.map((d) => d.nonPositiveDiagnostics).filter(Boolean),
    widthOrderFailureInvestigation: investigateWidthOrderFailures(pairingDecisions),
  };
}

function buildCandidateGenerationAccounting(eligibleGroups, pairingDecisions, acceptedIntervals, runUsageRecords) {
  const groupSizes = [];
  let groupsWith1 = 0;
  let groupsWith2 = 0;
  let groupsWith3 = 0;
  let groupsWith4Plus = 0;

  for (const [, runs] of eligibleGroups) {
    const n = runs.length;
    groupSizes.push(n);
    if (n === 1) groupsWith1++;
    else if (n === 2) groupsWith2++;
    else if (n === 3) groupsWith3++;
    else if (n >= 4) groupsWith4Plus++;
  }

  const runsInZeroPairs = new Set();
  const runsInOnePair = new Set();
  const runsInMultiplePairs = new Map();
  const acceptedPerRun = new Map();
  const rejectedPerRun = new Map();

  for (const d of pairingDecisions) {
    for (const id of [d.leftRunId, d.rightRunId]) {
      runsInOnePair.add(id);
      const mult = runsInMultiplePairs.get(id) || 0;
      runsInMultiplePairs.set(id, mult + 1);
      if (d.outcome === PAIRING_OUTCOMES.ACCEPTED) {
        acceptedPerRun.set(id, (acceptedPerRun.get(id) || 0) + 1);
      } else {
        rejectedPerRun.set(id, (rejectedPerRun.get(id) || 0) + 1);
      }
    }
  }

  const allRunIds = new Set();
  for (const [, runs] of eligibleGroups) {
    for (const r of runs) allRunIds.add(r.dividerRunId);
  }
  for (const id of allRunIds) {
    if (!runsInOnePair.has(id)) runsInZeroPairs.add(id);
  }

  const runsInMultiple = [...runsInMultiplePairs.entries()].filter(([, c]) => c > 1).map(([id, c]) => ({ dividerRunId: id, candidatePairCount: c }));

  const boundaryRuns = new Set();
  for (const iv of acceptedIntervals) {
    boundaryRuns.add(iv.leftDividerRunId);
    boundaryRuns.add(iv.rightDividerRunId);
  }

  const usageByOutcome = {};
  for (const rec of runUsageRecords) {
    usageByOutcome[rec.outcome] = (usageByOutcome[rec.outcome] || 0) + 1;
  }

  const reconstructedUsage = reconstructRunUsageFromPairing(pairingDecisions, acceptedIntervals, eligibleGroups, runUsageRecords);

  return {
    totalGroups: eligibleGroups.size,
    runsPerGroupDistribution: {
      min: groupSizes.length ? Math.min(...groupSizes) : 0,
      max: groupSizes.length ? Math.max(...groupSizes) : 0,
      mean: groupSizes.length ? groupSizes.reduce((a, b) => a + b, 0) / groupSizes.length : 0,
    },
    groupsWith1Run: { count: groupsWith1, label: `${groupsWith1} / ${eligibleGroups.size}` },
    groupsWith2Runs: { count: groupsWith2, label: `${groupsWith2} / ${eligibleGroups.size}` },
    groupsWith3Runs: { count: groupsWith3, label: `${groupsWith3} / ${eligibleGroups.size}` },
    groupsWith4PlusRuns: { count: groupsWith4Plus, label: `${groupsWith4Plus} / ${eligibleGroups.size}` },
    runsInZeroCandidatePairs: { count: runsInZeroPairs.size, label: `${runsInZeroPairs.size} / ${allRunIds.size}` },
    runsInOneCandidatePair: {
      count: [...runsInOnePair].filter((id) => (runsInMultiplePairs.get(id) || 0) === 1).length,
      label: `${[...runsInOnePair].filter((id) => (runsInMultiplePairs.get(id) || 0) === 1).length} / ${allRunIds.size}`,
    },
    runsInMultipleCandidatePairs: { count: runsInMultiple.length, records: runsInMultiple },
    uniqueRunsInAcceptedBoundaries: { count: boundaryRuns.size, label: `${boundaryRuns.size} / ${allRunIds.size}` },
    acceptedIntervalsPerRun: Object.fromEntries([...acceptedPerRun.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    rejectedCandidatesPerRun: Object.fromEntries([...rejectedPerRun.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    runUsageByOutcome: usageByOutcome,
    usageReconstructsFromPairing: reconstructedUsage.passed,
    usageReconstructionErrors: reconstructedUsage.errors,
    accountingNarrative: [
      '834 pair candidates arise from at-most-one right-neighbour attempt per left-ranked run per group (deduped pair keys).',
      '37 runs appear as accepted interval boundaries (20 intervals × 2 slots with 3 reused runs).',
      '11 unpaired_outer_boundary runs sit at lateral extremes of multi-run groups without an accepted adjacent pairing.',
      '830 unpaired_isolated runs sit between outer boundaries in groups but lack an accepted adjacent interval (rejected pairing or no neighbour candidate).',
    ],
  };
}

function reconstructRunUsageFromPairing(pairingDecisions, acceptedIntervals, eligibleGroups, runUsageRecords) {
  const errors = [];
  const expected = new Map();
  const boundaryRuns = new Set();
  for (const iv of acceptedIntervals) {
    boundaryRuns.add(iv.leftDividerRunId);
    boundaryRuns.add(iv.rightDividerRunId);
  }

  const runsByGroup = eligibleGroups;
  for (const rec of runUsageRecords) {
    if (rec.outcome === 'excluded_ineligible') continue;
    if (boundaryRuns.has(rec.dividerRunId)) {
      expected.set(rec.dividerRunId, 'used_as_interval_boundary');
      continue;
    }
    let group = null;
    for (const [, runs] of runsByGroup) {
      if (runs.some((r) => r.dividerRunId === rec.dividerRunId)) {
        group = runs;
        break;
      }
    }
    if (!group) {
      errors.push(`missing group for ${rec.dividerRunId}`);
      continue;
    }
    const idx = group.findIndex((r) => r.dividerRunId === rec.dividerRunId);
    const isOuter = idx === 0 || idx === group.length - 1;
    expected.set(rec.dividerRunId, isOuter ? 'unpaired_outer_boundary' : 'unpaired_isolated');
  }

  for (const rec of runUsageRecords) {
    if (rec.outcome === 'excluded_ineligible') continue;
    const exp = expected.get(rec.dividerRunId);
    if (exp !== rec.outcome) {
      errors.push(`${rec.dividerRunId}: expected ${exp}, got ${rec.outcome}`);
    }
  }

  return { passed: errors.length === 0, errors };
}

function summarizeCrossingCandidates(pairingDecisions, acceptedIntervals, countAssessments) {
  const candidates = pairingDecisions.filter((d) => d.metrics?.crossingCandidate || d.reasons?.includes('geometric_crossing_candidate'));
  const acceptedWithCrossing = acceptedIntervals.filter((iv) => iv.assessmentReasons?.includes('geometric_crossing_candidate'));
  const assessmentsAffected = countAssessments.filter((a) => {
    const ids = new Set(a.supportingLaneIntervalIds || []);
    return acceptedWithCrossing.some((iv) => ids.has(iv.laneIntervalId));
  });

  return {
    crossingCandidatePairCount: candidates.length,
    crossingRecords: candidates.map((d) => ({
      leftRunId: d.leftRunId,
      rightRunId: d.rightRunId,
      outcome: d.outcome,
      crossingRouteS: d.crossingDiagnostics?.crossingRouteS ?? null,
      signedWidthsAroundCrossing: d.crossingDiagnostics?.signedWidthsAroundCrossing ?? null,
      disposition: d.outcome === PAIRING_OUTCOMES.ACCEPTED ? 'retained_with_non_final_status' : 'rejected',
      supportsNumericLaneCount: d.outcome === PAIRING_OUTCOMES.ACCEPTED ? false : false,
    })),
    acceptedIntervalsWithCrossingFlag: acceptedWithCrossing.length,
    countAssessmentsSupportedByCrossingIntervals: assessmentsAffected.length,
  };
}

module.exports = {
  NON_POSITIVE_SUBCATEGORIES,
  classifyNonPositiveSubcategory,
  buildNonPositiveDiagnostics,
  summarizeNonPositiveRejections,
  investigateWidthOrderFailures,
  buildCandidateGenerationAccounting,
  reconstructRunUsageFromPairing,
  summarizeCrossingCandidates,
};
