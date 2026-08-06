/**
 * Stage 18 orchestrator — lane-interval construction and prototype count assessment audit.
 */
const path = require('path');
const { summarizeNumeric } = require('./stage15_distributions');
const { FROZEN_ROAD_SURFACE_VERSION } = require('./stage15_lane_counting_design');
const { PROCESSING_VERSION } = require('./version');
const {
  INTERVAL_SCHEMA_VERSION,
  STAGE18_PROCESSING_VERSION,
  PAIRING_OUTCOMES,
  COUNT_ASSESSMENT_STATUS,
  COUNT_TRANSITION_LABELS,
  COUNTING_SEMANTICS,
  PAIRING_MODEL_DOCS,
  DEFAULT_INTERVAL_ASSESSMENT,
  BEV_REQUIRED_CATEGORIES,
} = require('./stage18_lane_interval_schema');
const { WIDTH_TOLERANCE_DOCS } = require('./stage18_width_tolerance');
const { buildStage18InputContext } = require('./stage18_stage17_loader');
const { filterEligibleRuns, groupEligibleRuns } = require('./stage18_run_eligibility');
const { constructLaneIntervals } = require('./stage18_boundary_pairing');
const {
  assessMultiIntervalCounts,
  recordUnsupportedRegionsFromGaps,
  verifyGapPreservation,
  finalizeRunUsage,
} = require('./stage18_lane_count_assessment');
const {
  summarizeNonPositiveRejections,
  buildCandidateGenerationAccounting,
  summarizeCrossingCandidates,
} = require('./stage18_pairing_diagnostics');
const { isPositiveSignedWidth } = require('./stage18_width_tolerance');
const { gapOverlapsInterval } = require('./stage18_gap_checks');

const EXPECTED_SUPPORTED_RUN_COUNT = 878;
const EXPECTED_GAP_COUNT = 136;

function pct(n, d) {
  return d ? { numerator: n, denominator: d, rate: n / d, label: `${n} / ${d}` } : { numerator: n, denominator: d, rate: 0, label: `${n} / ${d}` };
}

function summarizePairingDecisions(decisions) {
  const byOutcome = {};
  for (const d of decisions) {
    byOutcome[d.outcome] = (byOutcome[d.outcome] || 0) + 1;
  }
  return byOutcome;
}

function acceptedRouteSCoverage(intervals) {
  return intervals.reduce((sum, iv) => sum + (iv.overlappingSupportLengthM || 0), 0);
}


function verifyStage18Consistency(result, expectedRunCount = EXPECTED_SUPPORTED_RUN_COUNT, context = {}) {
  const errors = [];
  const usage = result.runUsageRecords || [];
  const intervals = result.acceptedIntervals || [];
  const assessments = result.countAssessments || [];
  const gaps = context.gaps || [];

  if (usage.length !== expectedRunCount) {
    errors.push(`run usage records ${usage.length} != ${expectedRunCount}`);
  }
  const withoutOutcome = usage.filter((u) => !u.outcome);
  if (withoutOutcome.length) {
    errors.push(`${withoutOutcome.length} supported runs missing usage outcome`);
  }

  for (const iv of intervals) {
    if (!iv.leftDividerRunId || !iv.rightDividerRunId) errors.push(`interval missing boundaries ${iv.laneIntervalId}`);
    if ((iv.overlappingSupportLengthM ?? 0) <= 0) errors.push(`interval no overlap ${iv.laneIntervalId}`);
    if (iv.widthStats?.nonPositiveCount > 0) errors.push(`accepted interval non-positive width ${iv.laneIntervalId}`);
    if (iv.leftDividerRunId === iv.rightDividerRunId) errors.push(`self-paired interval ${iv.laneIntervalId}`);
    for (const w of iv.widthSamples || []) {
      if (!isPositiveSignedWidth(w.widthM)) errors.push(`accepted interval non-positive sample ${iv.laneIntervalId}@${w.s}`);
    }
    if ((iv.assessmentReasons || []).includes('geometric_crossing_candidate')) {
      errors.push(`accepted interval retains crossing flag ${iv.laneIntervalId}`);
    }
    for (const g of gaps) {
      if (gapOverlapsInterval(iv, g)) errors.push(`accepted interval overlaps parent-track gap ${iv.laneIntervalId} gap ${g.gapId}`);
    }
  }

  for (const a of assessments) {
    if (a.laneCountCandidate != null) {
      if (!a.supportingLaneIntervalIds?.length) errors.push(`numeric count without intervals ${a.countAssessmentId}`);
      if (a.laneCountCandidate !== a.supportingLaneIntervalIds.length) {
        errors.push(`lane count != interval count ${a.countAssessmentId}`);
      }
    }
    if (a.status !== COUNT_ASSESSMENT_STATUS.ASSESSED && a.laneCountCandidate != null) {
      errors.push(`numeric count with non-assessed status ${a.countAssessmentId}`);
    }
    if (a.laneCountCandidate == null) {
      const transition = (result.countTransitions || []).find((t) => t.groupKey === `${a.chunkId}:${a.temporalPassId}:${a.poseSectionId}`);
      if (transition?.label === COUNT_TRANSITION_LABELS.STABLE_NUMERIC_SUPPORTED_COUNT) {
        errors.push(`null count labelled stable numeric ${a.countAssessmentId}`);
      }
    }
  }

  if (result.gapPreservationAudit && !result.gapPreservationAudit.allGapsPreserved) {
    errors.push('gap preservation failed');
  }
  if (result.nonPositiveWidthInvestigation && !result.nonPositiveWidthInvestigation.reconstructsAggregate) {
    errors.push('non-positive subcategories do not reconstruct aggregate');
  }
  if (result.candidateGenerationAccounting && !result.candidateGenerationAccounting.usageReconstructsFromPairing) {
    errors.push('run usage does not reconstruct from pairing records');
  }

  return { passed: errors.length === 0, errors };
}

function summarizeSensitivityRow(built, context, param, value) {
  const pairingByOutcome = summarizePairingDecisions(built.pairingDecisions);
  const transitions = built.countTransitions || [];
  const widths = built.acceptedIntervals.flatMap((iv) => (iv.widthSamples || []).map((w) => w.widthM));
  const numeric = built.countAssessments.filter((a) => a.laneCountCandidate != null);

  return {
    parameter: param,
    value,
    prototypeAssessment: true,
    eligibleRuns: built.eligibleRuns.length,
    excludedRuns: context.supportedRunCount - built.eligibleRuns.length,
    candidatePairs: built.pairingDecisions.length,
    acceptedIntervals: built.acceptedIntervals.length,
    pairingByOutcome,
    rejectedPairings: built.pairingDecisions.length - (pairingByOutcome[PAIRING_OUTCOMES.ACCEPTED] || 0),
    ambiguousPairings: pairingByOutcome[PAIRING_OUTCOMES.REJECTED_AMBIGUOUS] || 0,
    nonPositiveSubcategories: summarizeNonPositiveRejections(built.pairingDecisions).bySubcategory,
    assessedNumericCounts: numeric.length,
    incompleteAssessments: built.countAssessments.filter((a) => a.status === COUNT_ASSESSMENT_STATUS.INCOMPLETE_OUTER_BOUNDARY).length,
    unsupportedAssessments: built.countAssessments.filter((a) => a.status !== COUNT_ASSESSMENT_STATUS.ASSESSED).length,
    acceptedRouteSCoverageM: acceptedRouteSCoverage(built.acceptedIntervals),
    widthSampleCount: widths.length,
    laneCountDistribution: summarizeNumeric(numeric.map((a) => a.laneCountCandidate)),
    countTransitionLabels: transitions.reduce((acc, t) => {
      acc[t.label] = (acc[t.label] || 0) + 1;
      return acc;
    }, {}),
    repeatedPassConflicts: transitions.filter((t) => t.label === COUNT_TRANSITION_LABELS.CONFLICTING_PASS_EVIDENCE).length,
    sampleSStepNote: param === 'sampleSStepM'
      ? 'Coarser sampling may skip local width/order failures; compare nonPositiveSubcategories and crossing counts alongside accepted intervals.'
      : undefined,
  };
}

function runSensitivitySweep(context, options = {}) {
  const params = [
    ['minSharedRouteSM', [3, 5, 8]],
    ['sampleSStepM', [1, 2, 4]],
    ['minPrototypeWidthM', [1.8, 2.0, 2.5]],
    ['maxPrototypeWidthM', [5.0, 5.5, 6.0]],
    ['maxWidthVariationM', [0.8, 1.2, 1.8]],
    ['maxWidthStdM', [0.5, 0.8, 1.2]],
    ['maxTangentDiffDeg', [15, 25, 35]],
    ['minConfidence', [0.3, 0.5, 0.7]],
    ['maxUncertaintyM', [1.0, 1.5, 2.0]],
    ['requireTemporalOverlap', [true, false]],
    ['intervalContinuationGapM', [1, 3, 6]],
    ['minCountRunSpanM', [5, 10, 20]],
    ['minCountStabilitySpanM', [10, 15, 25]],
  ];
  const results = [];
  for (const [param, values] of params) {
    for (const value of values) {
      const settings = { ...DEFAULT_INTERVAL_ASSESSMENT, ...options, [param]: value };
      const built = buildStage18FromContext(context, settings);
      results.push(summarizeSensitivityRow(built, context, param, value));
    }
  }
  return results;
}

function buildStage18FromContext(context, options = {}) {
  const createdAt = options.createdAt || new Date().toISOString();
  const { eligibleRuns, usageRecords } = filterEligibleRuns(context, options);
  const eligibleGroups = groupEligibleRuns(eligibleRuns);
  const intervalResult = constructLaneIntervals(eligibleGroups, { ...options, createdAt, gaps: context.gaps });
  const countResult = assessMultiIntervalCounts(eligibleGroups, intervalResult.acceptedIntervals, context, { ...options, createdAt });
  const unsupportedRegions = recordUnsupportedRegionsFromGaps(context.gaps, options);
  const runUsageRecords = finalizeRunUsage(usageRecords, intervalResult.acceptedIntervals, eligibleRuns);

  return {
    eligibleRuns,
    eligibleGroups,
    runUsageRecords,
    pairingDecisions: intervalResult.pairingDecisions,
    acceptedIntervals: intervalResult.acceptedIntervals,
    rejectedIntervals: intervalResult.rejectedIntervals,
    countAssessments: countResult.assessments,
    countTransitions: countResult.transitions,
    unsupportedRegions,
    createdAt,
  };
}

function buildStage18LaneIntervalAudit(root, options = {}) {
  const context = buildStage18InputContext(root, options);
  const built = buildStage18FromContext(context, options);
  const pairingByOutcome = summarizePairingDecisions(built.pairingDecisions);
  const widths = built.acceptedIntervals.flatMap((iv) => (iv.widthSamples || []).map((w) => w.widthM));
  const numericCounts = built.countAssessments.filter((a) => a.laneCountCandidate != null).map((a) => a.laneCountCandidate);
  const membership = {
    inputSupportedRuns: context.supportedRunCount,
    eligibleSupportedRuns: built.eligibleRuns.length,
    excludedSupportedRuns: context.supportedRunCount - built.eligibleRuns.length,
    dividerPairCandidates: built.pairingDecisions.length,
    acceptedPairings: pairingByOutcome[PAIRING_OUTCOMES.ACCEPTED] || 0,
    rejectedPairings: built.pairingDecisions.length - (pairingByOutcome[PAIRING_OUTCOMES.ACCEPTED] || 0),
    ambiguousPairings: pairingByOutcome[PAIRING_OUTCOMES.REJECTED_AMBIGUOUS] || 0,
    laneIntervalsCreated: built.acceptedIntervals.length,
    rejectedIntervalRecords: built.rejectedIntervals.length,
    assessedCountRuns: built.countAssessments.filter((a) => a.status === COUNT_ASSESSMENT_STATUS.ASSESSED).length,
    unsupportedCountRuns: built.countAssessments.filter((a) => a.status !== COUNT_ASSESSMENT_STATUS.ASSESSED).length,
  };

  const nonPositiveInvestigation = summarizeNonPositiveRejections(built.pairingDecisions);
  const candidateGenerationAccounting = buildCandidateGenerationAccounting(
    built.eligibleGroups,
    built.pairingDecisions,
    built.acceptedIntervals,
    built.runUsageRecords,
  );
  const crossingInvestigation = summarizeCrossingCandidates(
    built.pairingDecisions,
    built.acceptedIntervals,
    built.countAssessments,
  );
  const gapPreservation = verifyGapPreservation(context.gaps, built.unsupportedRegions);
  const countAssessmentReviews = built.countAssessments.map((a) => a.reviewRecord);

  const result = {
    ...built,
    context,
    membership,
    pairingByOutcome,
    nonPositiveInvestigation,
    candidateGenerationAccounting,
    crossingInvestigation,
    gapPreservation,
    countAssessmentReviews,
  };
  const consistency = verifyStage18Consistency(result, context.supportedRunCount, context);

  const sensitivity = options.skipSensitivity ? [] : runSensitivitySweep(context, options);

  const runUsageByOutcome = built.runUsageRecords.reduce((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] || 0) + 1;
    return acc;
  }, {});

  const transitionLabelCounts = built.countTransitions.reduce((acc, t) => {
    acc[t.label] = (acc[t.label] || 0) + 1;
    return acc;
  }, {});

  return {
    auditedAt: built.createdAt,
    stage18Status: 'approved',
    stage18ApprovedAt: options.approvedAt || built.createdAt,
    stage19Status: 'pending_authorization',
    stagePurpose: 'lane_interval_construction_and_prototype_lane_count_assessment',
    productionLaneCountImplemented: false,
    physicalRoadValidationComplete: false,
    v11GeometryModified: false,
    stage17InputModified: false,
    frozenRoadSurfaceVersion: FROZEN_ROAD_SURFACE_VERSION,
    frozenV11ProcessingVersion: PROCESSING_VERSION,
    intervalSchemaVersion: INTERVAL_SCHEMA_VERSION,
    stage18ProcessingVersion: STAGE18_PROCESSING_VERSION,
    stage17InputVersion: context.stage17RunsEnvelope.schemaVersion,
    stage17ProcessingVersion: context.stage17RunsEnvelope.processingVersion,
    stage16InputChecksum: context.stage16Checksum,
    stage17SupportedRunCount: context.supportedRunCount,
    stage17GapCount: context.gapCount,
    stage17TrackCount: context.trackCount,
    pairingModel: PAIRING_MODEL_DOCS,
    countingSemantics: COUNTING_SEMANTICS,
    widthTolerancePolicy: WIDTH_TOLERANCE_DOCS,
    signedWidthConvention: WIDTH_TOLERANCE_DOCS.signedWidthConvention,
    intervalAssessment: { ...DEFAULT_INTERVAL_ASSESSMENT, ...options, prototypeAssessment: true },
    supportedRunMembership: membership,
    runUsageByOutcome,
    pairingByOutcome,
    pairingOutcomeReconciliation: {
      dividerPairCandidates: membership.dividerPairCandidates,
      sumOfOutcomes: Object.values(pairingByOutcome).reduce((a, b) => a + b, 0),
      reconciles: Object.values(pairingByOutcome).reduce((a, b) => a + b, 0) === membership.dividerPairCandidates,
      legacyRejectedNonPositiveWidthNote: 'The pre-review aggregate rejected_non_positive_width count (704) is superseded by local-adjacency and crossing classifications. Current legacy aggregate is 0; see widthOrderFailureInvestigation.',
    },
    rejectedPairingsByReason: Object.fromEntries(
      Object.entries(pairingByOutcome).filter(([k]) => k !== PAIRING_OUTCOMES.ACCEPTED),
    ),
    nonPositiveWidthInvestigation: nonPositiveInvestigation,
    candidateGenerationAccounting,
    geometricCrossingInvestigation: crossingInvestigation,
    gapPreservationAudit: gapPreservation,
    countAssessmentReviews,
    laneIntervalCount: built.acceptedIntervals.length,
    countAssessmentCount: built.countAssessments.length,
    numericCountDistribution: summarizeNumeric(numericCounts),
    laneWidthDistributionM: summarizeNumeric(widths),
    countAssessmentStatusCounts: built.countAssessments.reduce((acc, a) => {
      acc[a.status] = (acc[a.status] || 0) + 1;
      return acc;
    }, {}),
    countTransitions: built.countTransitions,
    countTransitionLabelCounts: transitionLabelCounts,
    unsupportedRegions: built.unsupportedRegions,
    acceptedRouteSCoverageM: acceptedRouteSCoverage(built.acceptedIntervals),
    coverageBySegment: coverageFromIntervals(built.acceptedIntervals, 'sourceSegmentIds'),
    thresholdSensitivity: sensitivity,
    trackingConsistency: consistency,
    performanceNote: {
      optimizedBuildSecondsApprox: 5,
      priorUnoptimizedProfilingSecondsApprox: '438–473 (historical pre-fix; 538 pair candidates — superseded)',
      optimizations: [
        'cached sorted interpolation geometry',
        'shared-overlap sampling capped at 250 samples',
        'lightweight mean-d candidate checks in findRightNeighbor()',
        'full sampled validation reserved for evaluatePair()',
      ],
    },
    bevRequiredCategories: BEV_REQUIRED_CATEGORIES,
    acceptedIntervals: options.includeAllIntervals ? built.acceptedIntervals : undefined,
    countAssessments: options.includeAllAssessments ? built.countAssessments : undefined,
    rejectedIntervals: options.includeAllRejected ? built.rejectedIntervals : undefined,
  };
}

function coverageFromIntervals(intervals, field) {
  const buckets = new Map();
  for (const iv of intervals) {
    const keys = iv[field] || [];
    for (const k of keys) {
      if (!buckets.has(String(k))) buckets.set(String(k), 0);
      buckets.set(String(k), buckets.get(String(k)) + 1);
    }
  }
  return Object.fromEntries([...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function generateStage18Markdown(audit) {
  const m = audit.supportedRunMembership || {};
  const np = audit.nonPositiveWidthInvestigation || {};
  const lines = [
    '# Stage 18 — Lane-Interval Construction & Prototype Lane-Count Assessment',
    '',
    `**Date:** ${audit.auditedAt?.slice(0, 10)}`,
    `**Status:** ${audit.stage18Status}`,
    `**Approved:** ${audit.stage18ApprovedAt?.slice(0, 10) ?? '—'}`,
    `**Schema:** \`${audit.intervalSchemaVersion}\``,
    `**Stage 17 input:** ${audit.stage17SupportedRunCount} supported runs, ${audit.stage17GapCount} gaps`,
    '',
    '## Scope',
    '',
    'Stage 18 constructs evidence-supported lane interval candidates from approved Stage 17 supported divider runs',
    'and produces offline prototype **supported same-direction interval counts**.',
    'It does **not** claim production-ready, physical-road-validated, HD-map-grade, or total physical road lane counts.',
    '',
    '## Signed-width convention',
    '',
    `- ${audit.signedWidthConvention}`,
    `- Comparison tolerance: ${audit.widthTolerancePolicy?.widthComparisonToleranceM?.value} m`,
    `- Positive floor tolerance: ${audit.widthTolerancePolicy?.widthPositiveToleranceM?.value} m`,
    '',
    '## Supported-run accounting',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Stage 17 supported runs (input) | ${m.inputSupportedRuns ?? audit.stage17SupportedRunCount} |`,
    `| Eligible supported runs | ${m.eligibleSupportedRuns ?? '—'} |`,
    `| Divider-pair candidates | ${m.dividerPairCandidates ?? '—'} |`,
    `| Accepted pairings | ${m.acceptedPairings ?? '—'} |`,
    `| Lane intervals created | ${m.laneIntervalsCreated ?? audit.laneIntervalCount} |`,
    `| Assessed numeric interval counts | ${m.assessedCountRuns ?? '—'} |`,
    '',
    '## Pairing outcomes',
    '',
  ];
  for (const [k, v] of Object.entries(audit.pairingByOutcome || {}).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${k}\`: ${v}`);
  }
  lines.push(
    '',
    `Pairing outcomes reconcile: ${audit.pairingOutcomeReconciliation?.reconciles ? '**yes**' : 'no'} (${audit.pairingOutcomeReconciliation?.sumOfOutcomes ?? '—'} / ${audit.pairingOutcomeReconciliation?.dividerPairCandidates ?? '—'})`,
    '',
    '## Width/order failure investigation',
    '',
    'The pre-review `rejected_non_positive_width` aggregate (704) is **superseded** by local-adjacency and crossing classifications.',
    `Current legacy \`rejected_non_positive_width\` outcome count: ${audit.pairingByOutcome?.rejected_non_positive_width ?? 0}.`,
    '',
  );
  const wo = np.widthOrderFailureInvestigation || {};
  lines.push(`Width/order failures with per-pair records: ${wo.totalWidthOrOrderFailures ?? '—'}`);
  for (const [k, v] of Object.entries(wo.bySubcategory || {}).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${k}\`: ${v} (${wo.subcategoryRates?.[k]?.label ?? v})`);
  }

  lines.push(
    '',
    '## Count transition labels',
    '',
  );
  for (const [k, v] of Object.entries(audit.countTransitionLabelCounts || {})) {
    lines.push(`- \`${k}\`: ${v}`);
  }

  lines.push(
    '',
    '## Gap preservation',
    '',
    `- Stage 17 gaps: ${audit.gapPreservationAudit?.stage17GapCount ?? '—'}`,
    `- Stage 18 referenced: ${audit.gapPreservationAudit?.stage18ReferencedGapCount ?? '—'}`,
    `- All preserved: ${audit.gapPreservationAudit?.allGapsPreserved ? 'yes' : 'no'}`,
    '',
    '## Consistency',
    '',
    `- Stage 18 consistency: ${audit.trackingConsistency?.passed ? '**passed**' : '**FAILED**'}`,
    '',
    '## Limitations',
    '',
    '- Prototype assessment settings only — not Malaysian road-design limits',
    '- Supported same-direction interval counts only; total physical road lanes not inferred',
    '- Production lane counting **not implemented**',
    '- Stage 19 **pending authorization** — not started',
    '',
    '## Performance',
    '',
    ...(audit.performanceNote?.optimizations || []).map((o) => `- ${o}`),
    `- Optimized full build: ~${audit.performanceNote?.optimizedBuildSecondsApprox ?? 5} s (tested system)`,
    `- Historical pre-fix profiling (~438–473 s, 538 candidates) is superseded by the canonical 834-candidate total`,
  );
  return lines.join('\n');
}

module.exports = {
  EXPECTED_SUPPORTED_RUN_COUNT,
  EXPECTED_GAP_COUNT,
  buildStage18LaneIntervalAudit,
  buildStage18FromContext,
  generateStage18Markdown,
  verifyStage18Consistency,
  runSensitivitySweep,
};
