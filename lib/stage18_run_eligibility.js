/**
 * Stage 18 — supported-run eligibility filtering (read-only Stage 17 input).
 */
const {
  RUN_USAGE_OUTCOMES,
  DEFAULT_INTERVAL_ASSESSMENT,
} = require('./stage18_lane_interval_schema');

function meanRouteD(run) {
  const pts = (run.representativeRouteD || []).filter((p) => Number.isFinite(p.s) && Number.isFinite(p.d));
  if (!pts.length) return null;
  return pts.reduce((s, p) => s + p.d, 0) / pts.length;
}

function assessRunEligibility(run, track, context, options = {}) {
  const o = { ...DEFAULT_INTERVAL_ASSESSMENT, ...options };
  const reasons = [];

  if (!run || !track) {
    return { eligible: false, reasons: ['missing_run_or_track'] };
  }
  if (run.interpolationMetadata?.permitted) {
    return { eligible: false, reasons: ['interpolation_permitted'] };
  }
  if (!run.provenance?.pipelineStage) {
    return { eligible: false, reasons: ['incomplete_provenance'] };
  }
  if (track.temporalPassId == null || track.poseSectionId == null) {
    return { eligible: false, reasons: ['missing_pass_or_section'] };
  }
  const pts = (run.representativeRouteD || []).filter((p) => Number.isFinite(p.s) && Number.isFinite(p.d));
  if (pts.length < 2) {
    return { eligible: false, reasons: ['insufficient_route_points'] };
  }
  const sStart = Math.min(...pts.map((p) => p.s));
  const sEnd = Math.max(...pts.map((p) => p.s));
  if (!Number.isFinite(sStart) || !Number.isFinite(sEnd) || sEnd <= sStart) {
    return { eligible: false, reasons: ['invalid_route_s_range'] };
  }

  for (const id of run.observationIds || []) {
    if (context.rejectedAmbiguousObservationIds?.has(id)) {
      reasons.push(`rejected_ambiguous_observation:${id}`);
    }
    const ob = context.observationById?.get(id);
    if (!ob) {
      reasons.push(`missing_stage16_observation:${id}`);
    } else if (!ob.provenance?.pipelineStage) {
      reasons.push(`incomplete_stage16_provenance:${id}`);
    }
  }
  if (reasons.some((r) => r.startsWith('rejected_ambiguous'))) {
    return { eligible: false, reasons };
  }

  const conf = run.confidenceSummary?.mean ?? track.confidence ?? 1;
  const unc = run.uncertaintySummary?.mean ?? track.uncertainty ?? 0;
  if (conf < o.minConfidence) reasons.push('insufficient_confidence');
  if (unc > o.maxUncertaintyM) reasons.push('excessive_uncertainty');
  if (reasons.length) return { eligible: false, reasons };

  return {
    eligible: true,
    reasons: [],
    enriched: {
      ...run,
      parentTrack: track,
      chunkId: track.chunkId,
      temporalPassId: track.temporalPassId,
      poseSectionId: track.poseSectionId,
      meanD: meanRouteD(run),
      routeSStart: sStart,
      routeSEnd: sEnd,
      routeSpanM: sEnd - sStart,
      segmentIds: track.segmentIds || [],
      precedingGapId: run.precedingGapId ?? null,
      followingGapId: run.followingGapId ?? null,
    },
  };
}

function filterEligibleRuns(context, options = {}) {
  const usageRecords = [];
  const eligibleRuns = [];

  const sortedRuns = [...context.supportedRuns].sort((a, b) => a.dividerRunId.localeCompare(b.dividerRunId));
  for (const run of sortedRuns) {
    const track = context.trackById.get(run.parentTrackId);
    const result = assessRunEligibility(run, track, context, options);
    if (result.eligible) {
      eligibleRuns.push(result.enriched);
      usageRecords.push({
        dividerRunId: run.dividerRunId,
        parentTrackId: run.parentTrackId,
        outcome: null,
        eligibility: 'eligible',
        reasons: [],
      });
    } else {
      usageRecords.push({
        dividerRunId: run.dividerRunId,
        parentTrackId: run.parentTrackId,
        outcome: RUN_USAGE_OUTCOMES.EXCLUDED_INELIGIBLE,
        eligibility: 'excluded',
        reasons: result.reasons,
      });
    }
  }

  return { eligibleRuns, usageRecords, eligibleCount: eligibleRuns.length };
}

function boundaryGroupKey(run) {
  return `${run.chunkId}:${run.temporalPassId}:${run.poseSectionId}`;
}

function groupEligibleRuns(eligibleRuns) {
  const groups = new Map();
  for (const run of eligibleRuns) {
    const key = boundaryGroupKey(run);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => b.meanD - a.meanD || a.dividerRunId.localeCompare(b.dividerRunId));
  }
  return groups;
}

module.exports = {
  assessRunEligibility,
  filterEligibleRuns,
  boundaryGroupKey,
  groupEligibleRuns,
  meanRouteD,
};
