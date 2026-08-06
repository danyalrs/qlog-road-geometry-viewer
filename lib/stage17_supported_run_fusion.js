/**
 * Stage 17 — supported-run fusion and explicit gap recording.
 */
const {
  TRACKING_SCHEMA_VERSION,
  STAGE17_PROCESSING_VERSION,
  GAP_REASONS,
  DEFAULT_FUSION_ASSESSMENT,
  buildSupportedRunTemplate,
  buildGapTemplate,
} = require('./stage17_tracking_schema');
const { observationId, timeGapSec } = require('./stage17_divider_association');
const {
  SUPPORTED_RUNS_V1_SCHEMA_VERSION,
  buildV1SupportedRunTemplate,
  buildBoundaryProvenance,
  buildDividerCorridorId,
  resolveTrackIndex,
} = require('./stage20_amendment_a_schema');
const {
  validateRunForEmission,
} = require('./stage20_amendment_a_validation');

function observationByIdMap(observations) {
  const m = new Map();
  for (const ob of observations) m.set(observationId(ob), ob);
  return m;
}

function fuseTrackSupportedRuns(track, observations, options = {}) {
  const o = { ...DEFAULT_FUSION_ASSESSMENT, ...options };
  const amendmentA = options.amendmentA === true;
  const obMap = observationByIdMap(observations);
  const obsList = track.observationIds
    .map((id) => ({ id, ob: obMap.get(id) }))
    .filter((x) => x.ob)
    .sort((a, b) => (BigInt(a.ob.logMonoTime) < BigInt(b.ob.logMonoTime) ? -1 : 1));

  const runs = [];
  const gaps = [];
  const rejectedRuns = [];
  let runIndex = 0;
  let gapIndex = 0;
  let current = null;

  const flushRun = () => {
    if (!current || !current.observationIds.length) return;
    const sStart = Math.min(...current.sMins);
    const sEnd = Math.max(...current.sMaxs);
    const span = sEnd - sStart;
    if (span < o.minRunSpanM && current.observationIds.length < 2) {
      current = null;
      return;
    }
    const runId = `${track.trackId}:run:${runIndex++}`;
    const frames = new Set(current.frameTimes);
    const dPoints = current.dPoints.sort((a, b) => a.s - b.s);

    const base = amendmentA ? buildV1SupportedRunTemplate() : buildSupportedRunTemplate();
    const run = {
      ...base,
      schemaVersion: amendmentA ? SUPPORTED_RUNS_V1_SCHEMA_VERSION : TRACKING_SCHEMA_VERSION,
      dividerRunId: runId,
      parentTrackId: track.trackId,
      routeSStart: sStart,
      routeSEnd: sEnd,
      routeSpanM: span,
      representativeRouteD: dPoints,
      observationIds: [...current.observationIds],
      observationCount: current.observationIds.length,
      sourceFrameCount: frames.size,
      supportDensity: span > 0 ? current.observationIds.length / span : current.observationIds.length,
      confidenceSummary: { mean: current.confSum / current.observationIds.length },
      uncertaintySummary: { mean: current.uncSum / current.observationIds.length },
      interpolationMetadata: { permitted: o.interpolationPermitted, method: null },
      provenance: { pipelineStage: 'stage17_supported_run_fusion', createdAt: options.createdAt || null },
    };

    if (amendmentA) {
      const trackIndex = resolveTrackIndex(track);
      run.segmentId = null;
      run.chunkId = track.chunkId;
      run.temporalPassId = track.temporalPassId;
      run.poseSectionId = track.poseSectionId;
      run.trackIndex = trackIndex;
      run.dividerCorridorId = buildDividerCorridorId(track);

      const memberSegIds = run.observationIds.map((id) => obMap.get(id)?.segmentId);
      const uniqueSeg = [...new Set(memberSegIds.filter((x) => x != null))];
      if (uniqueSeg.length === 1) run.segmentId = uniqueSeg[0];

      run.boundaryProvenance = buildBoundaryProvenance(track, run.segmentId, options.createdAt || null);

      const emissionError = validateRunForEmission(run, track, obMap);
      if (emissionError) {
        rejectedRuns.push({ dividerRunId: runId, ...emissionError, observationIds: [...run.observationIds] });
        current = null;
        return;
      }
    }

    runs.push(run);
    current = null;
  };

  const addGap = (prev, next, sStart, sEnd, reason, splitTrigger) => {
    const gapId = `${track.trackId}:gap:${gapIndex++}`;
    const gap = {
      ...buildGapTemplate(),
      schemaVersion: TRACKING_SCHEMA_VERSION,
      gapId,
      parentTrackId: track.trackId,
      routeSStart: sStart,
      routeSEnd: sEnd,
      gapLengthM: Math.max(0, sEnd - sStart),
      timeSpanNs: prev && next ? Math.abs(Number(BigInt(next.ob.logMonoTime) - BigInt(prev.ob.logMonoTime))) : null,
      lastSupportingObservationId: prev?.id ?? null,
      nextSupportingObservationId: next?.id ?? null,
      reason,
      splitTrigger: splitTrigger || reason,
      interpolationPermitted: false,
      provenance: { pipelineStage: 'stage17_gap_policy', createdAt: options.createdAt || null },
    };
    gaps.push(gap);
    if (runs.length) runs[runs.length - 1].followingGapId = gapId;
    if (runs.length > gaps.length) gap.precedingRunId = runs[runs.length - 1]?.dividerRunId;
    return gapId;
  };

  let prevObs = null;
  for (const item of obsList) {
    const ob = item.ob;
    const pts = (ob.projectedRoutePoints || []).filter((p) => Number.isFinite(p.s) && Number.isFinite(p.d));
    const sMin = Math.min(...pts.map((p) => p.s));
    const sMax = Math.max(...pts.map((p) => p.s));

    if (prevObs) {
      const prevPts = (prevObs.ob.projectedRoutePoints || []).filter((p) => Number.isFinite(p.s));
      const prevSMax = Math.max(...prevPts.map((p) => p.s));
      const prevSMin = Math.min(...prevPts.map((p) => p.s));
      const sGap = sMin - prevSMax;
      const dt = timeGapSec(prevObs.ob.logMonoTime, ob.logMonoTime);
      const noOverlap = sMin > prevSMax + 0.5;
      const temporalDisconnect = dt > (options.runSplitTimeGapSec ?? o.runSplitTimeGapSec ?? 3.5);
      const geometricDisconnect = noOverlap && sGap > o.maxSupportedGapM;
      const disconnected = geometricDisconnect || temporalDisconnect;
      if (disconnected && current) {
        flushRun();
        const reason = geometricDisconnect ? GAP_REASONS.DISCONNECTED_SUPPORT : GAP_REASONS.TEMPORAL_GAP;
        const splitTrigger = geometricDisconnect ? 'route_s_discontinuity' : 'time_gap';
        addGap(prevObs, item, noOverlap ? prevSMax : prevSMin, noOverlap ? sMin : sMax, reason, splitTrigger);
      }
    }

    if (!current) {
      current = {
        observationIds: [],
        frameTimes: [],
        sMins: [],
        sMaxs: [],
        dPoints: [],
        confSum: 0,
        uncSum: 0,
      };
    }
    current.observationIds.push(item.id);
    current.frameTimes.push(ob.logMonoTime);
    current.sMins.push(sMin);
    current.sMaxs.push(sMax);
    current.confSum += ob.laneLineProb ?? 1;
    current.uncSum += ob.laneLineStd ?? 0;
    for (const p of pts) current.dPoints.push({ s: p.s, d: p.d, observationId: item.id });

    prevObs = item;
  }
  flushRun();

  if (runs.length > 1) {
    for (let i = 1; i < runs.length; i++) {
      runs[i].precedingGapId = gaps[i - 1]?.gapId ?? null;
      gaps[i - 1].followingRunId = runs[i].dividerRunId;
    }
  }

  return { runs, gaps, rejectedRuns };
}

function fuseAllTracks(tracks, observations, options = {}) {
  const allRuns = [];
  const allGaps = [];
  const allRejected = [];
  const trackRecords = [];

  for (const track of [...tracks].sort((a, b) => a.trackId.localeCompare(b.trackId))) {
    const { runs, gaps, rejectedRuns = [] } = fuseTrackSupportedRuns(track, observations, options);
    allRuns.push(...runs);
    allGaps.push(...gaps);
    allRejected.push(...rejectedRuns);
    trackRecords.push({
      ...track,
      chunkIds: track.chunkIds || [track.chunkId],
      chunkBoundaryContinuations: track.chunkBoundaryContinuations || [],
      supportedRunIds: runs.map((r) => r.dividerRunId),
      gapIds: gaps.map((g) => g.gapId),
      routeSStart: track.sMin,
      routeSEnd: track.sMax,
      routeSpanM: track.sMax - track.sMin,
      observationCount: track.observationIds.length,
      sourceFrameCount: new Set(track.frameTimes).size,
      segmentIdRange: { min: Math.min(...track.segmentIds), max: Math.max(...track.segmentIds) },
      confidenceSummary: { mean: track.confidence },
      uncertaintySummary: { mean: track.uncertainty },
      lateralRouteDSamples: track.dProfile || [],
    });
  }

  return { tracks: trackRecords, supportedRuns: allRuns, gaps: allGaps, rejectedRuns: allRejected };
}

function auditCrossingsAndOrdering(tracks, observations) {
  const obMap = observationByIdMap(observations);
  let crossingCount = 0;
  let lateralOrderChangeCount = 0;
  let duplicateTrackEvidence = 0;
  const issues = [];

  const byGroup = new Map();
  for (const t of tracks) {
    const key = `${t.chunkId}:${t.temporalPassId}:${t.poseSectionId}`;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(t);
  }

  for (const [key, groupTracks] of byGroup.entries()) {
    const frameOrder = new Map();
    for (const t of groupTracks) {
      for (const id of t.observationIds) {
        const ob = obMap.get(id);
        if (!ob) continue;
        const meanD = (ob.projectedRoutePoints || []).reduce((s, p) => s + p.d, 0) / (ob.projectedRoutePoints?.length || 1);
        if (!frameOrder.has(ob.logMonoTime)) frameOrder.set(ob.logMonoTime, []);
        frameOrder.get(ob.logMonoTime).push({ trackId: t.trackId, meanD, slot: ob.sourceSlotIndex });
      }
    }
    const times = [...frameOrder.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    let prevOrder = null;
    for (const t of times) {
      const ranked = frameOrder.get(t).sort((a, b) => b.meanD - a.meanD).map((x) => x.trackId);
      if (prevOrder) {
        for (let i = 0; i < Math.min(prevOrder.length, ranked.length); i++) {
          if (prevOrder[i] !== ranked[i]) lateralOrderChangeCount++;
        }
      }
      prevOrder = ranked;
    }
  }

  const obsToTrack = new Map();
  for (const t of tracks) {
    for (const id of t.observationIds) {
      if (obsToTrack.has(id)) {
        duplicateTrackEvidence++;
        issues.push(`observation ${id} in multiple tracks`);
      }
      obsToTrack.set(id, t.trackId);
    }
  }

  return {
    crossingCount,
    lateralOrderChangeCount,
    duplicateTrackEvidence,
    fragmentationCount: tracks.filter((t) => t.observationIds.length === 1).length,
    issues,
  };
}

module.exports = {
  fuseTrackSupportedRuns,
  fuseAllTracks,
  auditCrossingsAndOrdering,
};
