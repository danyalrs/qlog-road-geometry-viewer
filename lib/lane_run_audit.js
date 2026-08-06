'use strict';

/**
 * Segment 2 cleaned-run audit, separation classification, and join diagnostics.
 */

const { dist2d } = require('./chunking');
const { polylineLength } = require('./geometry_sanity');
const { deriveSafeSurfaceBridgeGapM } = require('./fusion_bins');

const DEFAULT_AUDIT_OPTS = {
  maxFragmentSdGapM: 12,
  maxAdaptiveJoinGapM: 18,
  dropoutScaleGapM: 30,
  duplicateMeanDM: 0.8,
  duplicateMinOverlapM: 15,
  complementaryMaxGapM: 250,
  maxComplementaryLateralDriftM: 1.5,
  minSeparationForNeighbourM: 1.2,
  maxJoinLateralDeltaM: 0.8,
  maxJoinHeadingDeltaDeg: 25,
  fusionIntervalM: 2,
};

const SEP_CLASSES = {
  NO_DETECTION: 'A',
  TRACK_REJECTED: 'B',
  TRACK_ID_CHANGE: 'C',
  FUSION_INSUFFICIENT_OBS: 'D',
  FUSION_INSUFFICIENT_FRAMES: 'E',
  FUSION_SPIKE_OUTLIER: 'F',
  WITHIN_MERGE_LIMIT_NOT_MERGED: 'G',
  ABOVE_LIMIT_STRONG_EVIDENCE: 'H',
  DIFFERENT_BOUNDARY: 'I',
  CHUNK_BOUNDARY: 'J',
  PASS_BOUNDARY: 'K',
  RENDERING_SPLIT: 'L',
  SINGLE_LANE_END: 'M',
  OTHER: 'N',
};

function headingDegFromPoints(points) {
  if (!points || points.length < 2) return null;
  const a = points[0];
  const b = points[points.length - 1];
  return (Math.atan2(b.north - a.north, b.east - a.east) * 180) / Math.PI;
}

function headingFromSd(sdPoints) {
  if (!sdPoints || sdPoints.length < 2) return null;
  const ds = sdPoints[sdPoints.length - 1].s - sdPoints[0].s;
  const dd = sdPoints[sdPoints.length - 1].d - sdPoints[0].d;
  if (Math.abs(ds) < 0.01) return null;
  return (Math.atan2(dd, ds) * 180) / Math.PI;
}

function curvatureSummary(sdPoints) {
  if (!sdPoints || sdPoints.length < 3) return { maxHeadingDeltaDeg: 0, meanAbsCurvature: 0 };
  let maxDelta = 0;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < sdPoints.length - 1; i++) {
    const v1s = sdPoints[i].s - sdPoints[i - 1].s;
    const v1d = sdPoints[i].d - sdPoints[i - 1].d;
    const v2s = sdPoints[i + 1].s - sdPoints[i].s;
    const v2d = sdPoints[i + 1].d - sdPoints[i].d;
    const h1 = Math.atan2(v1d, v1s);
    const h2 = Math.atan2(v2d, v2s);
    let delta = ((h2 - h1) * 180) / Math.PI;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    maxDelta = Math.max(maxDelta, Math.abs(delta));
    sum += Math.abs(delta);
    n++;
  }
  return { maxHeadingDeltaDeg: maxDelta, meanAbsCurvature: n ? sum / n : 0 };
}

function frameIndexForFrameId(frames, frameId) {
  const idx = frames.findIndex((f) => f.frameId === frameId);
  return idx >= 0 ? idx : null;
}

function assignPhysicalBoundaryGroups(trackStats, tracks, opts = {}) {
  const groups = [];
  const trackToGroup = new Map();
  const trackIds = [...trackStats.keys()].sort((a, b) => a - b);

  for (const tid of trackIds) {
    if (trackToGroup.has(tid)) continue;
    const stats = trackStats.get(tid);
    const group = {
      physicalBoundaryId: `PB${groups.length}`,
      trackIds: [tid],
      meanD: stats?.meanD ?? 0,
      side: (stats?.meanD ?? 0) >= 0 ? 'left' : 'right',
      complementary: false,
    };

    for (const other of trackIds) {
      if (other === tid || trackToGroup.has(other)) continue;
      const statsB = trackStats.get(other);
      if (!stats || !statsB) continue;
      const sameSide = Math.sign(stats.meanD) === Math.sign(statsB.meanD);
      const overlap = Math.max(0, Math.min(stats.maxS, statsB.maxS) - Math.max(stats.minS, statsB.minS));
      const gap = Math.max(stats.minS, statsB.minS) - Math.min(stats.maxS, statsB.maxS);
      const dSep = Math.abs(stats.meanD - statsB.meanD);

      if (sameSide && dSep <= (opts.duplicateMeanDM ?? 0.8) && overlap >= (opts.duplicateMinOverlapM ?? 15)) {
        group.trackIds.push(other);
        trackToGroup.set(other, group.physicalBoundaryId);
      } else if (
        sameSide
        && dSep <= (opts.maxComplementaryLateralDriftM ?? 1.5)
        && gap > 0
        && overlap <= (opts.duplicateMinOverlapM ?? 15)
        && gap <= (opts.complementaryMaxGapM ?? 250)
      ) {
        group.trackIds.push(other);
        group.complementary = true;
        trackToGroup.set(other, group.physicalBoundaryId);
      }
    }
    trackToGroup.set(tid, group.physicalBoundaryId);
    groups.push(group);
  }
  return { groups, trackToGroup };
}

function deriveAdaptiveJoinGapM(fragments, opts = {}) {
  const allSd = fragments.flatMap((f) => f.sdPoints || []);
  const { safeBridgeGapM, p90IntraGapM, sampleCount } = deriveSafeSurfaceBridgeGapM(allSd, allSd, {
    fusionIntervalM: opts.fusionIntervalM ?? 2,
    dropoutScaleGapM: opts.dropoutScaleGapM ?? 30,
  });
  const hardCap = opts.maxAdaptiveJoinGapM ?? 18;
  return {
    adaptiveJoinGapM: Math.min(safeBridgeGapM, hardCap),
    p90IntraGapM,
    sampleCount,
    hardCap,
    defaultMergeGapM: opts.maxFragmentSdGapM ?? 12,
  };
}

function endpointCompatibility(fragA, fragB, opts = {}) {
  const sdA = fragA.sdPoints || [];
  const sdB = fragB.sdPoints || [];
  if (!sdA.length || !sdB.length) return { compatible: false, reason: 'missingSd' };
  const endA = sdA[sdA.length - 1];
  const startB = sdB[0];
  const gapM = startB.s - endA.s;
  const dDelta = Math.abs(startB.d - endA.d);
  const hA = headingFromSd(sdA.slice(-2).length >= 2 ? sdA.slice(-2) : sdA);
  const hB = headingFromSd(sdB.slice(0, 2).length >= 2 ? sdB.slice(0, 2) : sdB);
  let headingDelta = null;
  if (hA != null && hB != null) {
    headingDelta = Math.abs(((hB - hA + 540) % 360) - 180);
  }
  const maxD = opts.maxJoinLateralDeltaM ?? 0.8;
  const maxH = opts.maxJoinHeadingDeltaDeg ?? 25;
  if (dDelta > maxD) return { compatible: false, gapM, dDelta, headingDelta, reason: 'lateralMismatch' };
  if (headingDelta != null && headingDelta > maxH) {
    return { compatible: false, gapM, dDelta, headingDelta, reason: 'headingMismatch' };
  }
  return { compatible: true, gapM, dDelta, headingDelta, reason: null };
}

function hasCompetingBoundaryInGap(gapStartS, gapEndS, allFrags, excludeTrackIds, opts = {}) {
  const minSep = opts.minSeparationForNeighbourM ?? 1.2;
  for (const frag of allFrags) {
    if (excludeTrackIds.has(frag.laneTrackId)) continue;
    const sd = frag.sdPoints || [];
    if (!sd.length) continue;
    const minS = Math.min(...sd.map((p) => p.s));
    const maxS = Math.max(...sd.map((p) => p.s));
    if (maxS < gapStartS || minS > gapEndS) continue;
    const meanD = sd.reduce((s, p) => s + p.d, 0) / sd.length;
    const refD = (frag.sdPoints?.[0]?.d ?? 0);
    if (Math.abs(meanD - refD) < minSep) continue;
    return { competing: true, laneTrackId: frag.laneTrackId, meanD };
  }
  return { competing: false };
}

function evaluateJoinEligibility(prevFrag, nextFrag, context) {
  const opts = { ...DEFAULT_AUDIT_OPTS, ...context.options };
  const compat = endpointCompatibility(prevFrag, nextFrag, opts);
  const gapM = compat.gapM ?? Infinity;
  const dropoutScale = opts.dropoutScaleGapM ?? 30;
  const adaptive = context.adaptiveJoinGapM ?? opts.maxFragmentSdGapM ?? 12;

  if (prevFrag.chunkId != null && nextFrag.chunkId != null && prevFrag.chunkId !== nextFrag.chunkId) {
    return { safeToJoin: false, classification: SEP_CLASSES.CHUNK_BOUNDARY, gapM, reason: 'differentChunk' };
  }
  if (prevFrag.passId != null && nextFrag.passId != null && prevFrag.passId !== nextFrag.passId) {
    return { safeToJoin: false, classification: SEP_CLASSES.PASS_BOUNDARY, gapM, reason: 'differentPass' };
  }
  if (context.physicalBoundaryId && context.physicalBoundaryId !== context.nextPhysicalBoundaryId) {
    return { safeToJoin: false, classification: SEP_CLASSES.DIFFERENT_BOUNDARY, gapM, reason: 'differentPhysicalBoundary' };
  }
  if (gapM >= dropoutScale) {
    return { safeToJoin: false, classification: SEP_CLASSES.NO_DETECTION, gapM, reason: 'dropoutScaleGap' };
  }
  if (!compat.compatible) {
    return {
      safeToJoin: false,
      classification: compat.reason === 'headingMismatch' ? SEP_CLASSES.FUSION_SPIKE_OUTLIER : SEP_CLASSES.FUSION_SPIKE_OUTLIER,
      gapM,
      dDelta: compat.dDelta,
      headingDelta: compat.headingDelta,
      reason: compat.reason,
    };
  }
  const competitor = hasCompetingBoundaryInGap(
    (prevFrag.sdPoints?.slice(-1)[0]?.s ?? 0),
    (nextFrag.sdPoints?.[0]?.s ?? 0),
    context.allFragments || [],
    new Set(context.trackIds || []),
    opts,
  );
  if (competitor.competing) {
    return { safeToJoin: false, classification: SEP_CLASSES.DIFFERENT_BOUNDARY, gapM, reason: 'competingBoundaryInGap', competitor };
  }

  if (gapM <= opts.maxFragmentSdGapM) {
    return { safeToJoin: true, classification: SEP_CLASSES.WITHIN_MERGE_LIMIT_NOT_MERGED, gapM, reason: 'withinDefaultMergeLimit' };
  }
  if (gapM <= adaptive) {
    return { safeToJoin: true, classification: SEP_CLASSES.ABOVE_LIMIT_STRONG_EVIDENCE, gapM, reason: 'adaptiveEvidenceJoin' };
  }
  if (gapM > adaptive && gapM < dropoutScale) {
    return { safeToJoin: false, classification: SEP_CLASSES.FUSION_INSUFFICIENT_OBS, gapM, reason: 'sparseFusionGap' };
  }
  return { safeToJoin: false, classification: SEP_CLASSES.OTHER, gapM, reason: 'unclassified' };
}

function sourceFusedLength(runFrags) {
  let len = 0;
  for (const frag of runFrags) {
    len += polylineLength(frag.points || []);
  }
  return len;
}

function buildRunAuditRecord({
  run,
  runId,
  physicalBoundaryId,
  frames,
  frameById,
  prevRun,
  nextRun,
  joinToPrev,
  joinToNext,
}) {
  const sd = run.sdPoints || [];
  const ds = sd.map((p) => p.d);
  const frameIds = new Set();
  for (const frag of run.sourceFragments || []) {
    if (frag.supportingFrameCount) frameIds.add(frag.supportingFrameCount);
  }
  const elapsedIdx = (run.sourceFragments || [])
    .flatMap((f) => f.sourceElapsedIdx || [])
    .filter((x) => x != null);
  const startCoord = run.points?.[0] ? { east: run.points[0].east, north: run.points[0].north } : null;
  const endCoord = run.points?.length ? { east: run.points[run.points.length - 1].east, north: run.points[run.points.length - 1].north } : null;

  return {
    runId,
    physicalBoundaryId,
    sourceTrackIds: run.logicalGroupTrackIds || [run.laneTrackId],
    primaryTrackId: run.laneTrackId,
    chunkId: run.chunkId ?? 0,
    passId: run.passId ?? 0,
    laneSide: (run.meanD ?? 0) >= 0 ? 'left' : 'right',
    lateralOrder: run.lateralOrder,
    startElapsedIdx: elapsedIdx.length ? Math.min(...elapsedIdx) : null,
    endElapsedIdx: elapsedIdx.length ? Math.max(...elapsedIdx) : null,
    startFrameId: run.sourceFragments?.[0]?.sourceFrameIds?.[0] ?? null,
    endFrameId: run.sourceFragments?.slice(-1)[0]?.sourceFrameIds?.slice(-1)[0] ?? null,
    startS: run.sMin,
    endS: run.sMax,
    lengthM: run.lengthM,
    fusedBinCount: run.sourceFragmentCount,
    contributingObservationCount: run.contributingObservationCount ?? null,
    distinctSupportingFrameCount: run.distinctSupportingFrameCount ?? frameIds.size,
    meanConfidence: run.meanConfidence ?? null,
    minConfidence: run.minConfidence ?? null,
    meanD: run.meanD,
    lateralRangeD: ds.length ? { min: Math.min(...ds), max: Math.max(...ds) } : null,
    meanHeadingDeg: headingDegFromPoints(run.points),
    curvature: curvatureSummary(sd),
    startCoord,
    endCoord,
    gapToPrecedingCompatibleRunM: prevRun && run.sMin != null && prevRun.sMax != null ? run.sMin - prevRun.sMax : null,
    gapToNextCompatibleRunM: nextRun && run.sMax != null && nextRun.sMin != null ? nextRun.sMin - run.sMax : null,
    lateralDeltaAtPrecedingEndpoint: prevRun ? Math.abs((run.sdPoints?.[0]?.d ?? 0) - (prevRun.sdPoints?.slice(-1)[0]?.d ?? 0)) : null,
    headingDeltaAtPrecedingEndpoint: joinToPrev?.headingDelta ?? null,
    joinToPreceding: joinToPrev ? {
      safeToJoin: joinToPrev.safeToJoin,
      classification: joinToPrev.classification,
      reason: joinToPrev.reason,
      joined: joinToPrev.wasJoined ?? false,
    } : null,
    joinToNext: joinToNext ? {
      safeToJoin: joinToNext.safeToJoin,
      classification: joinToNext.classification,
      reason: joinToNext.reason,
      joined: joinToNext.wasJoined ?? false,
    } : null,
    sourceFusedLengthM: run.sourceFusedLengthM,
    cleanedLengthM: run.lengthM,
    renderedLengthM: run.lengthM,
    sourcePointCount: run.sourcePointCount,
    cleanedPointCount: run.points?.length ?? 0,
    renderedPointCount: run.points?.length ?? 0,
    supportStatus: run.supportStatus,
  };
}

function auditCleanedRuns({
  frames = [],
  fusedLanes = [],
  tracks = [],
  cleaned = [],
  mergeDecisions = [],
  physicalBoundaryGroups = [],
  chunkId = 0,
  passId = 0,
}) {
  const byPb = new Map();
  for (const run of cleaned) {
    const pb = run.physicalBoundaryId || `PB-${run.laneTrackId}`;
    if (!byPb.has(pb)) byPb.set(pb, []);
    byPb.get(pb).push(run);
  }
  for (const runs of byPb.values()) {
    runs.sort((a, b) => (a.sMin ?? 0) - (b.sMin ?? 0));
  }

  const runs = [];
  let runId = 0;
  const sortedPb = [...byPb.entries()].sort((a, b) => {
    const ma = a[1][0]?.meanD ?? 0;
    const mb = b[1][0]?.meanD ?? 0;
    return mb - ma;
  });

  for (const [pbId, pbRuns] of sortedPb) {
    for (let i = 0; i < pbRuns.length; i++) {
      const run = pbRuns[i];
      const prev = i > 0 ? pbRuns[i - 1] : null;
      const next = i < pbRuns.length - 1 ? pbRuns[i + 1] : null;
      const joinPrev = mergeDecisions.find((d) => d.runB === run && d.runA === prev) || null;
      const joinNext = mergeDecisions.find((d) => d.runA === run && d.runB === next) || null;
      runs.push(buildRunAuditRecord({
        run,
        runId: runId++,
        physicalBoundaryId: pbId,
        frames,
        prevRun: prev,
        nextRun: next,
        joinToPrev: joinPrev,
        joinToNext: joinNext,
      }));
    }
  }

  const separations = mergeDecisions.filter((d) => !d.wasJoined).map((d) => ({
    classification: d.classification,
    gapM: d.gapM,
    physicalBoundaryId: d.physicalBoundaryId,
    sourceTrackIds: d.trackIds,
    sourceEvidenceInGap: d.sourceEvidenceInGap ?? null,
    compatibleEndpoints: d.compatible,
    competingLaneEvidence: d.competitor ?? null,
    currentRejectionCondition: d.reason,
    safeToJoin: d.safeToJoin,
    reason: d.reason,
    prevRunS: d.endS,
    nextRunS: d.startS,
  }));

  const classSummary = {};
  for (const sep of separations) {
    const c = sep.classification || 'N';
    if (!classSummary[c]) classSummary[c] = { count: 0, totalGapM: 0 };
    classSummary[c].count++;
    classSummary[c].totalGapM += sep.gapM ?? 0;
  }

  return {
    generatedAt: new Date().toISOString(),
    segment: 'qlog_f449c_2.bz2',
    chunkId,
    passId,
    physicalBoundaryGroups,
    runCount: runs.length,
    separationCount: separations.length,
    runs,
    separations,
    classificationSummary: classSummary,
  };
}

module.exports = {
  SEP_CLASSES,
  assignPhysicalBoundaryGroups,
  deriveAdaptiveJoinGapM,
  endpointCompatibility,
  evaluateJoinEligibility,
  auditCleanedRuns,
  headingDegFromPoints,
  curvatureSummary,
  sourceFusedLength,
};
