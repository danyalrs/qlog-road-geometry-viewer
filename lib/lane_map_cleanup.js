'use strict';

/**
 * Stationary local-playback lane map cleanup.
 * Builds evidence-based cleaned lane boundaries from fused tracks.
 */

const { dist2d } = require('./chunking');
const { polylineLength } = require('./geometry_sanity');
const {
  assignPhysicalBoundaryGroups,
  deriveAdaptiveJoinGapM,
  evaluateJoinEligibility,
  sourceFusedLength,
} = require('./lane_run_audit');
const {
  preserveSourcePolylinesForGaps,
  extendPartialTailPreservation,
  applyPreservedGeometryToCleaned,
  PROVENANCE_TYPE,
  SEGMENT2_D12_GAPS,
} = require('./source_polyline_preservation');
const { computeCoverageAccounting } = require('./coverage_accounting');
const { analyzeDrawablePaths } = require('./drawable_path');
const { buildReferenceTrajectory } = require('./trajectory');
const {
  applyVisibleGapReconstruction,
  computeCoordinateChecksum,
} = require('./visible_gap_reconstruction');

const DEFAULT_OPTS = {
  minTrackFrames: 2,
  minFragmentPoints: 2,
  minSupportedSpanM: 3,
  maxLateralJumpM: 2.5,
  maxEndpointExtensionM: 12,
  maxFragmentSdGapM: 12,
  maxAdaptiveJoinGapM: 18,
  dropoutScaleGapM: 30,
  duplicateMeanDM: 0.8,
  duplicateMinOverlapM: 15,
  complementaryMaxGapM: 250,
  minSeparationForNeighbourM: 1.2,
  maxJoinLateralDeltaM: 0.8,
  maxJoinHeadingDeltaDeg: 25,
  fusionIntervalM: 2,
};

function trackSdStats(fusedFragments) {
  const pts = (fusedFragments || []).flatMap((f) => f.sdPoints || []);
  if (!pts.length) return null;
  const ds = pts.map((p) => p.d);
  const ss = pts.map((p) => p.s);
  return {
    meanD: ds.reduce((a, b) => a + b, 0) / ds.length,
    minS: Math.min(...ss),
    maxS: Math.max(...ss),
    spanM: Math.max(...ss) - Math.min(...ss),
    pointCount: pts.length,
    fragmentCount: fusedFragments.length,
  };
}

function trackFrameSupport(track) {
  const frameIds = track?.frameIds || [];
  return { frameCount: frameIds.length, frameIds };
}

function enrichFragmentFromFrames(frag, frames) {
  const frameIdToIdx = new Map(frames.map((f, i) => [f.frameId, i]));
  const meta = frag.supportMeta || {};
  const frameIds = meta.supportingFrameIds
    || [...new Set((frag.sdPoints || []).flatMap(() => []))];
  const sMin = frag.sdPoints?.[0]?.s;
  const sMax = frag.sdPoints?.[frag.sdPoints.length - 1]?.s;

  let matchedFrameIds = frameIds;
  if (!matchedFrameIds.length) {
    matchedFrameIds = [];
    for (const frame of frames) {
      for (const lane of frame.lanes || []) {
        if (lane.laneTrackId !== frag.laneTrackId) continue;
        matchedFrameIds.push(frame.frameId);
        break;
      }
    }
  }

  const elapsedIdx = matchedFrameIds.map((id) => frameIdToIdx.get(id)).filter((x) => x != null);
  const obsCount = (frag.sdPoints || []).reduce((n, p) => n + (p.frameCount ?? 1), 0);

  return {
    ...frag,
    sourceFrameIds: matchedFrameIds,
    sourceElapsedIdx: elapsedIdx,
    contributingObservationCount: obsCount || meta.independentFrameCount || matchedFrameIds.length,
    distinctSupportingFrameCount: meta.independentFrameCount
      || new Set(matchedFrameIds).size
      || frag.supportingFrameCount
      || 0,
    meanConfidence: meta.meanConfidence ?? null,
    minConfidence: meta.minConfidence ?? null,
    sMin,
    sMax,
  };
}

function sRangeOverlap(a, b) {
  const start = Math.max(a.minS, b.minS);
  const end = Math.min(a.maxS, b.maxS);
  return Math.max(0, end - start);
}

function sameSide(a, b, minSepM = 1.2) {
  if (!a || !b) return false;
  if (Math.sign(a.meanD) !== Math.sign(b.meanD)) return false;
  return Math.abs(a.meanD - b.meanD) < minSepM;
}

function isDuplicateTrack(statsA, statsB, opts) {
  if (!statsA || !statsB) return false;
  if (!sameSide(statsA, statsB, opts.duplicateMeanDM)) return false;
  const overlap = sRangeOverlap(statsA, statsB);
  if (overlap < opts.duplicateMinOverlapM) return false;
  return Math.abs(statsA.meanD - statsB.meanD) <= opts.duplicateMeanDM;
}

function sortFragmentsByS(fragments) {
  return [...fragments].sort((a, b) => {
    const sa = a.sdPoints?.[0]?.s ?? 0;
    const sb = b.sdPoints?.[0]?.s ?? 0;
    return sa - sb;
  });
}

function fragmentSdSpanM(frag) {
  const sd = frag.sdPoints || [];
  if (sd.length < 2) return 0;
  return Math.max(...sd.map((p) => p.s)) - Math.min(...sd.map((p) => p.s));
}

function maxSdLateralJump(sdPoints) {
  let max = 0;
  for (let i = 1; i < (sdPoints || []).length; i++) {
    max = Math.max(max, Math.abs(sdPoints[i].d - sdPoints[i - 1].d));
  }
  return max;
}

function hasSdLateralSpike(sdPoints, maxJumpM) {
  if (!sdPoints || sdPoints.length < 3) return false;
  for (let i = 1; i < sdPoints.length - 1; i++) {
    const interp = (sdPoints[i - 1].d + sdPoints[i + 1].d) / 2;
    if (Math.abs(sdPoints[i].d - interp) > maxJumpM) return true;
  }
  return false;
}

function mergeFragmentsWithEvidence(fragments, context) {
  const sorted = sortFragmentsByS(fragments);
  const opts = context.options || DEFAULT_OPTS;
  const adaptive = context.adaptiveJoinGapM ?? opts.maxFragmentSdGapM;
  const runs = [];
  const mergeDecisions = [];
  let current = [];

  for (const frag of sorted) {
    if (!frag.points?.length) continue;
    if (!current.length) {
      current.push(frag);
      continue;
    }
    const prev = current[current.length - 1];
    const decision = evaluateJoinEligibility(prev, frag, {
      ...context,
      options: opts,
      adaptiveJoinGapM: adaptive,
      trackIds: context.trackIds,
      physicalBoundaryId: context.physicalBoundaryId,
      nextPhysicalBoundaryId: context.physicalBoundaryId,
    });
    decision.wasJoined = decision.safeToJoin;
    decision.endS = prev.sdPoints?.slice(-1)[0]?.s;
    decision.startS = frag.sdPoints?.[0]?.s;
    decision.trackIds = context.trackIds;
    decision.physicalBoundaryId = context.physicalBoundaryId;
    mergeDecisions.push(decision);

    if (decision.safeToJoin) {
      current.push(frag);
    } else {
      runs.push(current);
      current = [frag];
    }
  }
  if (current.length) runs.push(current);
  return { runs, mergeDecisions };
}

function flattenRunToPoints(run) {
  const pts = [];
  for (const frag of run) {
    for (const p of frag.points || []) {
      if (!pts.length) {
        pts.push({ ...p });
        continue;
      }
      const prev = pts[pts.length - 1];
      if (dist2d(prev, p) < 0.02) continue;
      pts.push({ ...p });
    }
  }
  return pts;
}

function flattenRunSdPoints(run) {
  const sd = [];
  for (const frag of run) {
    for (const p of frag.sdPoints || []) {
      if (sd.length && Math.abs(p.s - sd[sd.length - 1].s) < 0.05) continue;
      sd.push(p);
    }
  }
  return sd;
}

function removeLateralSpikes(points, sdPoints, maxJumpM) {
  if (!points?.length || points.length < 3 || !sdPoints || sdPoints.length !== points.length) {
    return points;
  }
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (i < points.length - 1) {
      const interp = (sdPoints[i - 1].d + sdPoints[i + 1].d) / 2;
      if (Math.abs(sdPoints[i].d - interp) > maxJumpM) continue;
    }
    out.push(points[i]);
  }
  return out;
}

function trimUnsupportedEndpoints(points, sdPoints, maxExtensionM) {
  if (points.length < 3) return points;
  let start = 0;
  let end = points.length - 1;
  while (start < end - 1) {
    const span = Math.abs((sdPoints[end]?.s ?? 0) - (sdPoints[start]?.s ?? 0));
    const nextSpan = Math.abs((sdPoints[end]?.s ?? 0) - (sdPoints[start + 1]?.s ?? 0));
    if (span - nextSpan > maxExtensionM) start++;
    else break;
  }
  while (end > start + 1) {
    const span = Math.abs((sdPoints[end]?.s ?? 0) - (sdPoints[start]?.s ?? 0));
    const prevSpan = Math.abs((sdPoints[end - 1]?.s ?? 0) - (sdPoints[start]?.s ?? 0));
    if (span - prevSpan > maxExtensionM) end--;
    else break;
  }
  return points.slice(start, end + 1);
}

function segmentCrosses(a, b) {
  if (!a?.length || !b?.length || a.length < 2 || b.length < 2) return false;
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      const cross = (o, p, q) => (p.east - o.east) * (q.north - o.north) - (p.north - o.north) * (q.east - o.east);
      const d1 = cross(a[i], a[i + 1], b[j]);
      const d2 = cross(a[i], a[i + 1], b[j + 1]);
      const d3 = cross(b[j], b[j + 1], a[i]);
      const d4 = cross(b[j], b[j + 1], a[i + 1]);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
        return true;
      }
    }
  }
  return false;
}

function buildTrackedPolylines(frames, tracks, chunkId, passId, referencePose, transformFn) {
  const out = [];
  for (const track of tracks || []) {
    if (track.chunkId != null && track.chunkId !== chunkId) continue;
    if (track.passId != null && passId != null && track.passId !== passId) continue;
    const obs = [];
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      if (frame.chunkId != null && frame.chunkId !== chunkId) continue;
      if (passId != null && (frame.passId ?? frame.temporalPassId ?? 0) !== passId) continue;
      for (const lane of frame.lanes || []) {
        if (lane.laneTrackId !== track.trackId) continue;
        const mid = lane.points?.[Math.floor((lane.points.length - 1) / 2)];
        if (!mid) continue;
        const pt = transformFn ? transformFn(mid) : mid;
        obs.push({ ...pt, sourceFrameIndex: i, frameId: frame.frameId });
      }
    }
    if (obs.length < 2) continue;
    out.push({
      points: obs,
      laneTrackId: track.trackId,
      fragmentKind: 'trackedLane',
      sourceFrameCount: obs.length,
      supportStatus: 'tracked',
      colorByTrack: true,
    });
  }
  return out;
}

function evaluateFragment(frag, opts) {
  const sd = frag.sdPoints || [];
  const pts = frag.points || [];
  const spanM = Math.max(fragmentSdSpanM(frag), polylineLength(pts));
  const reasons = [];
  if (pts.length < opts.minFragmentPoints) reasons.push('tooFewPoints');
  if (spanM < opts.minSupportedSpanM) reasons.push('tooShort');
  if (maxSdLateralJump(sd) > opts.maxLateralJumpM) reasons.push('lateralJump');
  if (hasSdLateralSpike(sd, opts.maxLateralJumpM)) reasons.push('lateralSpike');
  return { spanM, reasons, accepted: reasons.length === 0 };
}

function buildCleanedLaneMap({
  frames = [],
  fusedLanes = [],
  tracks = [],
  chunkId = 0,
  passId = 0,
  trajectory = null,
  vehiclePath = null,
  classDGaps = null,
  enableD12Preservation = true,
  laneObservations = null,
  options = {},
}) {
  const opts = { ...DEFAULT_OPTS, ...options };
  const traj = trajectory || (vehiclePath?.length >= 2 ? buildReferenceTrajectory(vehiclePath) : null);
  const filtered = (fusedLanes || [])
    .filter((f) => {
      if (f.chunkId != null && f.chunkId !== chunkId) return false;
      if (f.passId != null && passId != null && f.passId !== passId) return false;
      return f.laneTrackId != null;
    })
    .map((f) => enrichFragmentFromFrames(f, frames));

  const trackSupport = new Map();
  for (const track of tracks || []) {
    if (track.chunkId != null && track.chunkId !== chunkId) continue;
    if (track.passId != null && passId != null && track.passId !== passId) continue;
    trackSupport.set(track.trackId, trackFrameSupport(track));
  }

  const byTrack = new Map();
  for (const frag of filtered) {
    const tid = frag.laneTrackId;
    if (!byTrack.has(tid)) byTrack.set(tid, []);
    byTrack.get(tid).push(frag);
  }

  const trackStats = new Map();
  for (const [tid, frags] of byTrack) {
    trackStats.set(tid, trackSdStats(frags));
  }

  const { groups: physicalBoundaryGroups, trackToGroup } = assignPhysicalBoundaryGroups(
    trackStats,
    tracks,
    opts,
  );

  const suppressed = new Set();
  const mergeGroups = [];

  for (const group of physicalBoundaryGroups) {
    const tid = group.trackIds[0];
    const support = trackSupport.get(tid);
    if (support && support.frameCount < opts.minTrackFrames) {
      for (const t of group.trackIds) suppressed.add(t);
      mergeGroups.push({
        trackIds: group.trackIds,
        physicalBoundaryId: group.physicalBoundaryId,
        suppressed: true,
        reason: 'insufficientTrackFrames',
        complementary: group.complementary,
      });
      continue;
    }
    mergeGroups.push({
      trackIds: group.trackIds,
      physicalBoundaryId: group.physicalBoundaryId,
      suppressed: false,
      complementary: group.complementary,
      meanD: group.meanD,
      side: group.side,
    });
  }

  const cleaned = [];
  const rejected = [];
  const audit = [];
  const allMergeDecisions = [];

  for (const groupInfo of mergeGroups) {
    if (groupInfo.suppressed) {
      for (const tid of groupInfo.trackIds) {
        for (const frag of byTrack.get(tid) || []) {
          rejected.push({
            points: frag.points || [],
            laneTrackId: tid,
            physicalBoundaryId: groupInfo.physicalBoundaryId,
            fragmentKind: 'rejectedLane',
            supportStatus: 'rejected',
            rejectReason: groupInfo.reason,
            sourceFragmentIndex: frag.fragmentIndex,
          });
        }
      }
      continue;
    }

    const group = groupInfo.trackIds;
    const allFrags = group.flatMap((tid) => byTrack.get(tid) || []);
    const adaptiveInfo = deriveAdaptiveJoinGapM(allFrags, opts);
    const { runs, mergeDecisions } = mergeFragmentsWithEvidence(allFrags, {
      options: opts,
      adaptiveJoinGapM: adaptiveInfo.adaptiveJoinGapM,
      trackIds: group,
      physicalBoundaryId: groupInfo.physicalBoundaryId,
      allFragments: filtered,
    });
    allMergeDecisions.push(...mergeDecisions);

    const primaryTrackId = group.reduce((best, tid) => {
      const s = trackStats.get(tid);
      return !best || (s?.spanM ?? 0) > (trackStats.get(best)?.spanM ?? 0) ? tid : best;
    }, null);

    for (let ri = 0; ri < runs.length; ri++) {
      const run = runs[ri];
      for (const frag of run) {
        const evalResult = evaluateFragment(frag, opts);
        if (!evalResult.accepted) {
          rejected.push({
            points: frag.points || [],
            laneTrackId: frag.laneTrackId ?? primaryTrackId,
            physicalBoundaryId: groupInfo.physicalBoundaryId,
            fragmentKind: 'rejectedLane',
            supportStatus: 'rejected',
            rejectReason: evalResult.reasons.join(','),
            sourceFragmentIndex: frag.fragmentIndex,
            lengthM: evalResult.spanM,
          });
        }
      }

      const srcFusedLen = sourceFusedLength(run);
      const srcPtCount = run.reduce((n, f) => n + (f.points?.length || 0), 0);
      let points = flattenRunToPoints(run);
      let sdPoints = flattenRunSdPoints(run);
      const rawLen = points.length;
      points = removeLateralSpikes(points, sdPoints, opts.maxLateralJumpM);
      sdPoints = flattenRunSdPoints(run).slice(0, points.length);
      points = trimUnsupportedEndpoints(points, sdPoints, opts.maxEndpointExtensionM);
      sdPoints = sdPoints.slice(0, points.length);

      const lenM = Math.max(polylineLength(points), sdPoints.length >= 2
        ? Math.abs(sdPoints[sdPoints.length - 1].s - sdPoints[0].s)
        : 0);
      const sMin = sdPoints.length ? Math.min(...sdPoints.map((p) => p.s)) : null;
      const sMax = sdPoints.length ? Math.max(...sdPoints.map((p) => p.s)) : null;
      const obsCount = run.reduce((n, f) => n + (f.contributingObservationCount ?? 0), 0);
      const frameCount = new Set(run.flatMap((f) => f.sourceFrameIds || [])).size;
      const confs = run.flatMap((f) => (f.meanConfidence != null ? [f.meanConfidence] : []));
      const meanD = sdPoints.length
        ? sdPoints.reduce((s, p) => s + p.d, 0) / sdPoints.length
        : groupInfo.meanD;

      const entry = {
        points,
        sdPoints,
        laneTrackId: primaryTrackId,
        physicalBoundaryId: groupInfo.physicalBoundaryId,
        logicalGroupTrackIds: group,
        complementaryBoundary: groupInfo.complementary ?? false,
        runIndex: ri,
        runId: cleaned.length,
        fragmentKind: 'cleanedLane',
        supportStatus: 'supported',
        sourceFragments: run,
        sourceFragmentCount: run.length,
        sourceFusedLengthM: srcFusedLen,
        sourcePointCount: srcPtCount,
        contributingObservationCount: obsCount,
        distinctSupportingFrameCount: frameCount,
        meanConfidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
        lengthM: lenM,
        sMin,
        sMax,
        meanD,
        colorByPhysicalBoundary: true,
        chunkId,
        passId,
      };

      if (points.length < opts.minFragmentPoints || lenM < opts.minSupportedSpanM) {
        entry.supportStatus = 'rejected';
        entry.rejectReason = 'runTooShort';
        rejected.push(entry);
        continue;
      }
      if (maxSdLateralJump(sdPoints) > opts.maxLateralJumpM * 1.2) {
        entry.supportStatus = 'rejected';
        entry.rejectReason = 'lateralSpike';
        rejected.push(entry);
        continue;
      }
      if (rawLen !== points.length) {
        audit.push({ type: 'spikeRemoved', trackIds: group, runIndex: ri, removedPoints: rawLen - points.length });
      }
      cleaned.push(entry);
    }
  }

  let crossingCount = 0;
  for (let i = 0; i < cleaned.length; i++) {
    for (let j = i + 1; j < cleaned.length; j++) {
      if (segmentCrosses(cleaned[i].points, cleaned[j].points)) crossingCount++;
    }
  }

  const reconResult = applyVisibleGapReconstruction(cleaned, allMergeDecisions, {
    ...opts,
    laneObservations,
    visibleGapReconstructionEnabled: options.visibleGapReconstructionEnabled === true
      || opts.visibleGapReconstructionEnabled === true,
    positiveBoundaryContinuityBridgeEnabled: options.positiveBoundaryContinuityBridgeEnabled === true
      || opts.positiveBoundaryContinuityBridgeEnabled === true,
  });
  if (reconResult.stats.enabled) {
    cleaned.length = 0;
    cleaned.push(...reconResult.cleaned);
  }

  cleaned.sort((a, b) => (b.meanD ?? 0) - (a.meanD ?? 0));
  cleaned.forEach((lane, i) => { lane.lateralOrder = i; lane.runId = i; });

  let preservedIntervals = [];
  let preservationResults = [];
  let displayCleaned = cleaned;

  if (enableD12Preservation && traj) {
    const gapSource = classDGaps?.length ? classDGaps : SEGMENT2_D12_GAPS;

    const preservation = preserveSourcePolylinesForGaps({
      gaps: gapSource,
      frames,
      trajectory: traj,
      physicalBoundaryGroups,
      cleaned,
      chunkId,
      passId,
      options: opts,
    });
    preservedIntervals = preservation.preservedIntervals;
    preservationResults = preservation.results;

    const tailExtension = extendPartialTailPreservation({
      preservedIntervals,
      frames,
      trajectory: traj,
      cleaned,
      chunkId,
      passId,
    });
    if (tailExtension.extensions.length) {
      preservedIntervals = [...preservedIntervals, ...tailExtension.extensions];
      preservationResults = [...preservationResults, ...tailExtension.results];
    }

    if (preservedIntervals.length) {
      const applied = applyPreservedGeometryToCleaned(cleaned, preservedIntervals);
      displayCleaned = applied.displayCleaned;
    }
  }

  const preservedCoverageM = preservedIntervals.reduce((s, p) => s + p.preservedLengthM, 0);
  const coverageAccounting = computeCoverageAccounting({
    cleanedFusedOnly: cleaned,
    cleanedWithPreserved: displayCleaned,
    preservedIntervals,
  });
  const drawablePathAnalysis = analyzeDrawablePaths(displayCleaned, preservedIntervals);

  return {
    cleaned: displayCleaned,
    cleanedFusedOnly: cleaned,
    rejected,
    tracked: [],
    fused: filtered.map((f, i) => ({
      points: f.points || [],
      sdPoints: f.sdPoints || [],
      laneTrackId: f.laneTrackId,
      fragmentIndex: f.fragmentIndex ?? i,
      fragmentKind: 'fusedLane',
      supportStatus: 'fused',
      colorByTrack: true,
    })),
    suppressedTrackIds: [...suppressed],
    mergeGroups,
    physicalBoundaryGroups,
    mergeDecisions: allMergeDecisions,
    preservedIntervals,
    preservedGeometry: preservedIntervals,
    preservationResults,
    preservationAudit: preservationResults,
    tailExtensionResults: preservationResults.filter((r) => r.isTailExtension),
    coverageAccounting,
    drawablePathAnalysis,
    adaptiveJoinInfo: physicalBoundaryGroups.map((g) => {
      const frags = g.trackIds.flatMap((tid) => byTrack.get(tid) || []);
      return { physicalBoundaryId: g.physicalBoundaryId, ...deriveAdaptiveJoinGapM(frags, opts) };
    }),
    audit,
    trackStats: Object.fromEntries(trackStats),
    stats: {
      fusedFragmentCount: filtered.length,
      trackCount: byTrack.size,
      physicalBoundaryGroupCount: physicalBoundaryGroups.length,
      cleanedRunCount: cleaned.length,
      rejectedCount: rejected.length,
      crossingCount,
      suppressedTrackCount: suppressed.size,
      joinsPerformed: allMergeDecisions.filter((d) => d.wasJoined).length,
      joinsRejected: allMergeDecisions.filter((d) => !d.wasJoined).length,
      preservedIntervalCount: preservedIntervals.length,
      preservedCoverageM,
      fullyResolvedD12Count: preservedIntervals.filter((p) => p.fullCoverage && !p.isTailExtension).length,
      partiallyResolvedD12Count: preservedIntervals.filter((p) => !p.fullCoverage && p.preservedLengthM > 0 && !p.isTailExtension).length,
      tailExtensionCount: preservedIntervals.filter((p) => p.isTailExtension).length,
      acceptedFusedUnionM: coverageAccounting?.routeSIntervalCoverage?.acceptedFusedUnionM,
      d12PreservedUnionM: coverageAccounting?.routeSIntervalCoverage?.d12PreservedUnionM,
      combinedSupportedUnionM: coverageAccounting?.routeSIntervalCoverage?.combinedSupportedUnionM,
      overlapAcceptedAndPreservedM: coverageAccounting?.routeSIntervalCoverage?.overlapAcceptedAndPreservedM,
      visibleGapReconstruction: reconResult.stats,
      coordinateChecksum: computeCoordinateChecksum(displayCleaned),
    },
    visibleGapReconstruction: reconResult,
  };
}

function computeLaneChecksum(laneFragments) {
  let h = 2166136261;
  const mix = (n) => { h ^= n; h = Math.imul(h, 16777619); };
  for (const frag of laneFragments || []) {
    mix(frag.physicalBoundaryId ? frag.physicalBoundaryId.charCodeAt(2) : (frag.laneTrackId ?? 0));
    mix(frag.lateralOrder ?? 0);
    const pts = frag.points || [];
    if (pts.length) {
      mix(Math.round(pts[0].east * 1000));
      mix(Math.round(pts[0].north * 1000));
      const last = pts[pts.length - 1];
      mix(Math.round(last.east * 1000));
      mix(Math.round(last.north * 1000));
    }
  }
  return (h >>> 0).toString(16);
}

function filterRoadSurfaceForCleanedLanes(polygons, cleanedLanes, physicalBoundaryGroups) {
  const trackIds = new Set();
  for (const lane of cleanedLanes || []) {
    trackIds.add(lane.laneTrackId);
    for (const tid of lane.logicalGroupTrackIds || []) trackIds.add(tid);
  }
  return (polygons || []).filter((poly) => {
    const left = poly.sourceLeftTrackId;
    const right = poly.sourceRightTrackId;
    if (left == null || right == null) return false;
    return trackIds.has(left) && trackIds.has(right);
  });
}

function physicalBoundaryColorIndex(physicalBoundaryId) {
  const n = parseInt(String(physicalBoundaryId).replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

module.exports = {
  DEFAULT_OPTS,
  buildCleanedLaneMap,
  buildTrackedPolylines,
  computeLaneChecksum,
  computeCoordinateChecksum,
  filterRoadSurfaceForCleanedLanes,
  physicalBoundaryColorIndex,
  trackSdStats,
  removeLateralSpikes,
  trimUnsupportedEndpoints,
  segmentCrosses,
  maxSdLateralJump,
  evaluateFragment,
  enrichFragmentFromFrames,
  PROVENANCE_TYPE,
};
