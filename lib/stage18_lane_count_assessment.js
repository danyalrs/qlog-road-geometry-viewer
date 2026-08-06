/**
 * Stage 18 — prototype same-direction lane-count assessment from supported intervals.
 */
const {
  COUNT_ASSESSMENT_STATUS,
  COUNT_TRANSITION_LABELS,
  DEFAULT_INTERVAL_ASSESSMENT,
  INTERVAL_ASSESSMENT_STATUS,
  buildCountAssessmentTemplate,
  buildUnsupportedRegionTemplate,
  STAGE18_PROCESSING_VERSION,
  INTERVAL_SCHEMA_VERSION,
  PAIRING_OUTCOMES,
  RUN_USAGE_OUTCOMES,
} = require('./stage18_lane_interval_schema');
const { gapOverlapsInterval } = require('./stage18_gap_checks');
const { boundaryGroupKey } = require('./stage18_run_eligibility');
const { isPositiveSignedWidth } = require('./stage18_width_tolerance');

function acceptedIntervalsOnly(intervals) {
  return intervals.filter((i) => i.pairingOutcome === PAIRING_OUTCOMES.ACCEPTED
    && i.assessmentStatus === INTERVAL_ASSESSMENT_STATUS.PLAUSIBLE_PROTOTYPE
    && !(i.assessmentReasons || []).includes('geometric_crossing_candidate'));
}

function intervalsOverlapGap(iv, gap) {
  return gapOverlapsInterval(iv, gap);
}

function classifyTransitionLabel(assessment, groupAccepted) {
  if (assessment.status === COUNT_ASSESSMENT_STATUS.ASSESSED && assessment.laneCountCandidate != null) {
    return COUNT_TRANSITION_LABELS.STABLE_NUMERIC_SUPPORTED_COUNT;
  }
  if (assessment.status === COUNT_ASSESSMENT_STATUS.INCOMPLETE_OUTER_BOUNDARY) {
    return COUNT_TRANSITION_LABELS.STABLE_INCOMPLETE_BOUNDARY_EVIDENCE;
  }
  if (!groupAccepted.length) {
    return COUNT_TRANSITION_LABELS.STABLE_UNSUPPORTED_EVIDENCE;
  }
  if (assessment.status === COUNT_ASSESSMENT_STATUS.INSUFFICIENT_BOUNDARY_EVIDENCE) {
    return COUNT_TRANSITION_LABELS.INSUFFICIENT_EVIDENCE;
  }
  return COUNT_TRANSITION_LABELS.STABLE_UNSUPPORTED_EVIDENCE;
}

function buildAssessmentReview(assessment, groupAccepted, boundaryRuns, gaps, options = {}) {
  const o = { ...DEFAULT_INTERVAL_ASSESSMENT, ...options };
  const leftOuter = boundaryRuns[0]?.dividerRunId ?? null;
  const rightOuter = boundaryRuns[boundaryRuns.length - 1]?.dividerRunId ?? null;
  const usedBoundaries = new Set(groupAccepted.flatMap((iv) => [iv.leftDividerRunId, iv.rightDividerRunId]));
  const internalGaps = gaps.filter((g) => groupAccepted.some((iv) => intervalsOverlapGap(iv, g)));

  const numericProof = assessment.laneCountCandidate === 2 ? {
    adjacentIntervalCount: groupAccepted.length,
    orderedBoundaryCount: boundaryRuns.length,
    threeBoundariesSimultaneouslySupported: boundaryRuns.length >= 3,
    intervalsFormConnectedOrderedSet: groupAccepted.length === boundaryRuns.length - 1,
    internalStage17GapsInIntervals: internalGaps.map((g) => g.gapId),
    crossingOrOrderFailureInAssessedSpan: groupAccepted.some((iv) => iv.assessmentStatus !== INTERVAL_ASSESSMENT_STATUS.PLAUSIBLE_PROTOTYPE),
    countSemantics: 'supported_same_direction_interval_count_not_total_road_lanes',
  } : null;

  return {
    countAssessmentId: assessment.countAssessmentId,
    routeSSpan: { start: assessment.routeSStart, end: assessment.routeSEnd, spanM: assessment.routeSpanM },
    supportingLaneIntervalIds: assessment.supportingLaneIntervalIds,
    orderedDividerRunIds: assessment.orderedBoundaryRunIds,
    supportedSameDirectionIntervalCount: assessment.laneCountCandidate,
    status: assessment.status,
    outerBoundaryCompleteness: {
      leftOuterBoundaryPresent: usedBoundaries.has(leftOuter),
      rightOuterBoundaryPresent: usedBoundaries.has(rightOuter),
      leftOuterRunId: leftOuter,
      rightOuterRunId: rightOuter,
    },
    unsupportedNeighbouringRegions: assessment.unsupportedNeighbouringRegions,
    minimumSupportedSpanM: o.minCountRunSpanM,
    stabilitySpanM: o.minCountStabilitySpanM,
    confidenceSummary: assessment.confidenceSummary,
    uncertaintySummary: assessment.uncertaintySummary,
    structuredReasons: assessment.structuredReasons,
    numericCountProof: numericProof,
  };
}

function assessMultiIntervalCounts(eligibleGroups, acceptedIntervals, context = {}, options = {}) {
  const o = { ...DEFAULT_INTERVAL_ASSESSMENT, ...options };
  const assessments = [];
  const transitions = [];
  const gaps = context.gaps || [];

  for (const [groupKey, runs] of [...eligibleGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const groupAccepted = acceptedIntervalsOnly(acceptedIntervals).filter((iv) => boundaryGroupKey(iv) === groupKey);
    if (!groupAccepted.length && runs.length < 2) continue;

    const sMin = groupAccepted.length ? Math.min(...groupAccepted.map((iv) => iv.routeSStart)) : Math.min(...runs.map((r) => r.routeSStart));
    const sMax = groupAccepted.length ? Math.max(...groupAccepted.map((iv) => iv.routeSEnd)) : Math.max(...runs.map((r) => r.routeSEnd));
    const span = sMax - sMin;
    const [chunkId, passId, sectionId] = groupKey.split(':').map((x) => parseInt(x, 10));

    const boundaryRuns = [...runs].sort((a, b) => b.meanD - a.meanD);
    const acceptedCount = groupAccepted.length;
    const expectedIntervals = Math.max(0, boundaryRuns.length - 1);

    let status = COUNT_ASSESSMENT_STATUS.ASSESSED;
    const reasons = [];
    if (acceptedCount < expectedIntervals) {
      status = COUNT_ASSESSMENT_STATUS.INCOMPLETE_OUTER_BOUNDARY;
      reasons.push('missing_adjacent_intervals_for_full_boundary_set');
    }
    if (span < o.minCountRunSpanM) {
      status = COUNT_ASSESSMENT_STATUS.INSUFFICIENT_BOUNDARY_EVIDENCE;
      reasons.push('insufficient_route_s_span');
    }
    for (const iv of groupAccepted) {
      for (const g of gaps) {
        if (gapOverlapsInterval(iv, g)) {
          status = COUNT_ASSESSMENT_STATUS.UNSUPPORTED_GAP;
          reasons.push(`interval_overlaps_parent_track_gap:${g.gapId}`);
        }
      }
    }
    for (const iv of groupAccepted) {
      for (const w of iv.widthSamples || []) {
        if (!isPositiveSignedWidth(w.widthM)) {
          status = COUNT_ASSESSMENT_STATUS.DIVIDER_CROSSING_OR_ORDER_FAILURE;
          reasons.push(`non_positive_width_in_interval:${iv.laneIntervalId}`);
        }
      }
    }

    const laneCount = status === COUNT_ASSESSMENT_STATUS.ASSESSED ? acceptedCount : null;

    const assessment = {
      ...buildCountAssessmentTemplate(),
      schemaVersion: INTERVAL_SCHEMA_VERSION,
      processingVersion: STAGE18_PROCESSING_VERSION,
      countAssessmentId: `${chunkId}:${passId}:${sectionId}:assess:${sMin.toFixed(1)}:${sMax.toFixed(1)}`,
      temporalPassId: passId,
      poseSectionId: sectionId,
      chunkId,
      routeSStart: sMin,
      routeSEnd: sMax,
      routeSpanM: span,
      supportingLaneIntervalIds: groupAccepted.map((iv) => iv.laneIntervalId).sort(),
      supportingDividerRunIds: boundaryRuns.map((r) => r.dividerRunId),
      supportingTrackIds: [...new Set(boundaryRuns.map((r) => r.parentTrackId))].sort(),
      orderedBoundaryRunIds: boundaryRuns.map((r) => r.dividerRunId),
      intervalWidthsM: groupAccepted.map((iv) => iv.widthStats?.median ?? iv.widthStats?.mean),
      laneCountCandidate: laneCount,
      supportedSameDirectionIntervalCount: laneCount,
      evidenceCompleteness: acceptedCount / Math.max(1, expectedIntervals),
      confidenceSummary: groupAccepted.length
        ? { mean: groupAccepted.reduce((s, iv) => s + (iv.confidenceSummary?.mean ?? 1), 0) / groupAccepted.length }
        : null,
      uncertaintySummary: groupAccepted.length
        ? { mean: groupAccepted.reduce((s, iv) => s + (iv.uncertaintySummary?.mean ?? 0), 0) / groupAccepted.length }
        : null,
      ambiguityFlags: [],
      unsupportedNeighbouringRegions: [],
      status,
      structuredReasons: reasons,
      provenance: { pipelineStage: 'stage18_lane_count_assessment', createdAt: options.createdAt || new Date().toISOString() },
    };

    assessment.reviewRecord = buildAssessmentReview(assessment, groupAccepted, boundaryRuns, gaps, o);
    assessments.push(assessment);

    transitions.push({
      groupKey,
      label: classifyTransitionLabel(assessment, groupAccepted),
      laneCountCandidate: assessment.laneCountCandidate,
      supportedSameDirectionIntervalCount: assessment.supportedSameDirectionIntervalCount,
      routeSpanM: span,
      status: assessment.status,
    });
  }

  return { assessments, transitions };
}

function recordUnsupportedRegionsFromGaps(gaps, options = {}) {
  return [...gaps].sort((a, b) => a.gapId.localeCompare(b.gapId)).map((g) => ({
    ...buildUnsupportedRegionTemplate(),
    routeSStart: g.routeSStart,
    routeSEnd: g.routeSEnd,
    lengthM: Math.max(0, (g.routeSEnd ?? 0) - (g.routeSStart ?? 0)) || g.gapLengthM,
    affectedBoundaryOrIntervalId: g.parentTrackId,
    sourceGapIds: [g.gapId],
    reason: g.reason,
    interpolationPermitted: false,
  }));
}

function verifyGapPreservation(stage17Gaps, unsupportedRegions) {
  const stage17Ids = new Set(stage17Gaps.map((g) => g.gapId));
  const stage18Ids = unsupportedRegions.flatMap((r) => r.sourceGapIds || []);
  const stage18Set = new Set(stage18Ids);
  const missing = [...stage17Ids].filter((id) => !stage18Set.has(id));
  const extra = [...stage18Set].filter((id) => !stage17Ids.has(id));
  const duplicated = stage18Ids.length !== stage18Set.size;
  return {
    stage17GapCount: stage17Ids.size,
    stage18ReferencedGapCount: stage18Set.size,
    allGapsPreserved: missing.length === 0 && extra.length === 0 && !duplicated,
    missingGapIds: missing,
    extraGapIds: extra,
    duplicatedGapReferences: duplicated,
    interpolationPermittedAllFalse: unsupportedRegions.every((r) => r.interpolationPermitted === false),
  };
}

function finalizeRunUsage(usageRecords, acceptedIntervals, eligibleRuns) {
  const usedAsBoundary = new Set();
  for (const iv of acceptedIntervals) {
    usedAsBoundary.add(iv.leftDividerRunId);
    usedAsBoundary.add(iv.rightDividerRunId);
  }

  const eligibleIds = new Set(eligibleRuns.map((r) => r.dividerRunId));
  const runsByGroup = new Map();
  for (const r of eligibleRuns) {
    const key = boundaryGroupKey(r);
    if (!runsByGroup.has(key)) runsByGroup.set(key, []);
    runsByGroup.get(key).push(r);
  }
  for (const arr of runsByGroup.values()) {
    arr.sort((a, b) => b.meanD - a.meanD || a.dividerRunId.localeCompare(b.dividerRunId));
  }

  for (const rec of usageRecords) {
    if (rec.outcome === RUN_USAGE_OUTCOMES.EXCLUDED_INELIGIBLE) continue;
    if (usedAsBoundary.has(rec.dividerRunId)) {
      rec.outcome = RUN_USAGE_OUTCOMES.USED_AS_INTERVAL_BOUNDARY;
      continue;
    }
    if (!eligibleIds.has(rec.dividerRunId)) continue;
    const run = eligibleRuns.find((r) => r.dividerRunId === rec.dividerRunId);
    const group = runsByGroup.get(boundaryGroupKey(run)) || [];
    const idx = group.findIndex((r) => r.dividerRunId === rec.dividerRunId);
    const isOuter = idx === 0 || idx === group.length - 1;
    rec.outcome = isOuter ? RUN_USAGE_OUTCOMES.UNPAIRED_OUTER_BOUNDARY : RUN_USAGE_OUTCOMES.UNPAIRED_ISOLATED;
  }

  return usageRecords;
}

module.exports = {
  assessMultiIntervalCounts,
  recordUnsupportedRegionsFromGaps,
  verifyGapPreservation,
  finalizeRunUsage,
  acceptedIntervalsOnly,
  buildAssessmentReview,
  classifyTransitionLabel,
};
