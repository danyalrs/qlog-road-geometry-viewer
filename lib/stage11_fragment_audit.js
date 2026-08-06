/**
 * Stage 11 — polygon fragment quality audit (read-only instrumentation).
 * Does not change production geometry or thresholds.
 */
const { dist2d } = require('./chunking');
const {
  polygonArea,
  polylineLength,
  countSelfIntersections,
  maxConsecutiveVertexJump,
  projectOntoTrajectory,
} = require('./geometry_sanity');
const { polygonBounds } = require('./geometry_debug');
const { loadSegmentsData } = require('./qlog_data');
const { processRoute } = require('./process_route');
const { qualifySegments } = require('./segment_qualify');
const {
  collectEdgeObservations,
  fuseSideBoundary,
  resolveMaxInterpolationSpanM,
  sourceBinSpacing,
} = require('./sd_fusion');
const { buildReferenceTrajectory } = require('./trajectory');

const DEFAULT_OPTS = {
  minLaneProb: 0.5,
  maxAccuracyM: 50,
  maxModelGpsDeltaNs: 2e9,
  maxForwardM: 120,
  fusionIntervalM: 2,
  pipelineMode: 'C',
  laneTrackingEnabled: true,
  localSupportFilter: true,
  maxVertexJumpM: 15,
};

const MIN_MAPPING_COVERAGE_M = 6;
const TINY_AREA_M2 = 25;
const S_RANGE_OVERLAP_MERGE_HINT_M = 4;
const ENDPOINT_ALIGN_HINT_M = 3;

const REPRESENTATIVE_SEGMENTS = [2, 5, 10, 24, 46, 58, 99];
const CONTROL_SEGMENTS = [0, 6, 54];

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

function stablePolygonId(segmentId, chunkId, passId, poseSectionId, fragmentIndex) {
  return `${segmentId}:${chunkId ?? 0}:${passId ?? 0}:${poseSectionId ?? 0}:${fragmentIndex ?? 0}`;
}

function ringEndpoints(ring) {
  if (!ring?.length) return null;
  const half = Math.floor(ring.length / 2);
  return {
    leftStart: ring[0],
    leftEnd: ring[half - 1] ?? ring[0],
    rightEnd: ring[half] ?? ring[ring.length - 1],
    rightStart: ring[ring.length - 1],
  };
}

function headingDegAtS(vehiclePath, s) {
  if (!vehiclePath?.length) return null;
  let best = vehiclePath[0];
  let bestD = Infinity;
  for (const pt of vehiclePath) {
    const ds = Math.abs((pt.s ?? projectOntoTrajectory(vehiclePath, pt)) - s);
    if (ds < bestD) { bestD = ds; best = pt; }
  }
  return best.headingDeg ?? best.bearingDeg ?? null;
}

function sRangeOverlap(a, b) {
  if (!a?.length || !b?.length) return 0;
  const start = Math.max(a[0], b[0]);
  const end = Math.min(a[1], b[1]);
  return Math.max(0, end - start);
}

function bboxContains(outer, inner) {
  if (!outer || !inner) return false;
  return inner.minE >= outer.minE && inner.maxE <= outer.maxE
    && inner.minN >= outer.minN && inner.maxN <= outer.maxN;
}

function maxUnsupportedSpanInRange(fusedPoints, s0, s1, fusionIntervalM, maxSpan) {
  const pts = (fusedPoints || []).filter((p) => p.s >= s0 - 1e-6 && p.s <= s1 + 1e-6).sort((a, b) => a.s - b.s);
  let maxGap = 0;
  for (let i = 1; i < pts.length; i++) {
    const gap = sourceBinSpacing(pts[i - 1], pts[i], fusionIntervalM);
    if (gap > maxSpan) maxGap = Math.max(maxGap, gap);
  }
  return maxGap;
}

function countSupportingEvidence(frames, sRange, passId, poseSectionId, trajectory) {
  const [s0, s1] = sRange || [0, 0];
  const frameIds = new Set();
  const binKeys = new Set();
  const timestamps = [];
  for (const frame of frames || []) {
    if (frame.passId !== passId) continue;
    if ((frame.poseSectionId ?? 0) !== (poseSectionId ?? 0)) continue;
    const vehicleS = frame.vehicleS ?? projectOntoTrajectory(trajectory, frame.pose || frame);
    if (vehicleS < s0 - 5 || vehicleS > s1 + 5) continue;
    let hasEdge = false;
    for (const edge of frame.edges || []) {
      for (const pt of edge.points || []) {
        const s = pt.s ?? projectOntoTrajectory(trajectory, pt);
        if (s >= s0 - 2 && s <= s1 + 2) {
          hasEdge = true;
          if (pt.binKey != null) binKeys.add(pt.binKey);
        }
      }
    }
    if (hasEdge || (vehicleS >= s0 && vehicleS <= s1)) {
      frameIds.add(frame.frameId);
      if (frame.logMonoTime) timestamps.push(String(frame.logMonoTime));
    }
  }
  return {
    supportingFrameCount: frameIds.size,
    supportingBinCount: binKeys.size || Math.max(0, Math.ceil((s1 - s0) / (DEFAULT_OPTS.fusionIntervalM ?? 2))),
    sourceFrameIds: [...frameIds].sort((a, b) => a - b),
    sourceTimestamps: timestamps.sort(),
  };
}

function sortFragmentsForOrdering(fragments) {
  return [...fragments].sort((a, b) => {
    if ((a.passId ?? 0) !== (b.passId ?? 0)) return (a.passId ?? 0) - (b.passId ?? 0);
    if ((a.poseSectionId ?? 0) !== (b.poseSectionId ?? 0)) return (a.poseSectionId ?? 0) - (b.poseSectionId ?? 0);
    const as = a.sRange?.[0] ?? 0;
    const bs = b.sRange?.[0] ?? 0;
    if (as !== bs) return as - bs;
    return (a.fragmentIndex ?? 0) - (b.fragmentIndex ?? 0);
  });
}

function classifyFragment(fragment, allFragments, context) {
  const tags = [];
  const stats = fragment;
  const cov = stats.coverageM ?? 0;
  const validGeom = (stats.selfIntersections ?? 0) === 0
    && (stats.maxVertexJumpM ?? 0) <= (context.maxVertexJumpM ?? 15)
    && (stats.widthMin ?? 0) >= 2
    && (stats.widthMax ?? 0) <= 30;

  if (validGeom && cov >= MIN_MAPPING_COVERAGE_M) tags.push('independently_useful');
  if (validGeom && cov < MIN_MAPPING_COVERAGE_M) tags.push('valid_but_too_short_for_mapping');
  if ((stats.selfIntersections ?? 0) > 0 || (stats.maxVertexJumpM ?? 0) > (context.maxVertexJumpM ?? 15)) {
    tags.push('geometrically_inconsistent');
  }
  if ((stats.areaM2 ?? 0) > 0 && (stats.areaM2 ?? 0) < TINY_AREA_M2 && cov < MIN_MAPPING_COVERAGE_M) {
    tags.push('valid_but_too_short_for_mapping');
  }

  const peers = allFragments.filter((f) => f.polygonId !== fragment.polygonId
    && f.passId === fragment.passId
    && f.poseSectionId === fragment.poseSectionId);

  for (const other of peers) {
    const overlap = sRangeOverlap(fragment.sRange, other.sRange);
    const minLen = Math.min(fragment.coverageM || 1, other.coverageM || 1);
    if (overlap > 0 && overlap >= minLen * 0.5) tags.push('duplicate_or_overlapping');
    const fb = fragment.bounds;
    const ob = other.bounds;
    if (fb && ob && bboxContains(ob, fb) && fragment.coverageM <= other.coverageM) {
      tags.push('contained_inside_another');
    }
  }

  if ((fragment.gapToNextAlongTrackM ?? 0) > S_RANGE_OVERLAP_MERGE_HINT_M) {
    tags.push('separated_by_real_evidence_gap');
  }

  const align = fragment.boundaryEndpointAlignmentToNext;
  if (fragment.gapToNextAlongTrackM != null
    && fragment.gapToNextAlongTrackM <= S_RANGE_OVERLAP_MERGE_HINT_M
    && fragment.gapToNextAlongTrackM > 0
    && align
    && align.leftEndToNextStartM <= ENDPOINT_ALIGN_HINT_M
    && align.rightEndToNextStartM <= ENDPOINT_ALIGN_HINT_M
    && fragment.passId === fragment.nextPassId
    && fragment.poseSectionId === fragment.nextPoseSectionId) {
    tags.push('potentially_mergeable_direct_support_only');
  }

  return [...new Set(tags)];
}

function auditFragmentPolygon(poly, index, context) {
  const ring = poly.ring || [];
  const stats = poly.stats || {};
  const sRange = stats.sRange || [0, 0];
  const coverageM = sRange[1] - sRange[0];
  const areaM2 = stats.area ?? polygonArea(ring);
  const perimeterM = polylineLength(ring);
  const vertexCount = ring.length;
  const maxVertexJumpM = maxConsecutiveVertexJump(ring);
  const selfIntersections = countSelfIntersections(ring);
  const bounds = polygonBounds(ring);
  const maxSpan = resolveMaxInterpolationSpanM(context.opts);
  const unsupportedInterpM = maxUnsupportedSpanInRange(
    context.fusedLeftPoints,
    sRange[0],
    sRange[1],
    context.opts.fusionIntervalM ?? 2,
    maxSpan
  );
  const support = countSupportingEvidence(
    context.frames,
    sRange,
    poly.passId,
    poly.poseSectionId,
    context.vehiclePath
  );

  return {
    polygonId: stablePolygonId(
      context.segmentId,
      poly.chunkId,
      poly.passId,
      poly.poseSectionId,
      poly.fragmentIndex
    ),
    orderingIndex: index,
    segmentId: context.segmentId,
    chunkId: poly.chunkId ?? 0,
    passId: poly.passId ?? 0,
    poseSectionId: poly.poseSectionId ?? 0,
    fragmentIndex: poly.fragmentIndex ?? 0,
    sRange,
    coverageM,
    areaM2,
    perimeterM,
    vertexCount,
    supportingFrameCount: support.supportingFrameCount,
    supportingBinCount: support.supportingBinCount,
    widthMedian: stats.medianWidth,
    widthMin: stats.minWidth,
    widthMax: stats.maxWidth,
    selfIntersections,
    maxVertexJumpM,
    unsupportedInterpolationM: unsupportedInterpM,
    sourceFrameIds: support.sourceFrameIds,
    sourceTimestamps: support.sourceTimestamps,
    bounds,
    inChunkOutput: true,
    classifications: [],
  };
}

function enrichFragmentGaps(fragments, vehiclePath, rejections, poseTransitions) {
  const ordered = sortFragmentsForOrdering(fragments);
  for (let i = 0; i < ordered.length; i++) {
    const cur = ordered[i];
    const next = ordered[i + 1];
    if (!next || cur.passId !== next.passId || cur.poseSectionId !== next.poseSectionId) {
      cur.gapToNextAlongTrackM = null;
      cur.gapToPreviousAlongTrackM = null;
      cur.distanceToPreviousPolygonM = null;
      cur.distanceToNextPolygonM = null;
      cur.headingChangeAcrossGapDeg = null;
      cur.boundaryEndpointAlignmentToNext = null;
      cur.adjacentUnsupportedRejectionReason = null;
      continue;
    }
    const gap = (next.sRange?.[0] ?? 0) - (cur.sRange?.[1] ?? 0);
    cur.gapToNextAlongTrackM = gap;
    cur.gapToPreviousAlongTrackM = i > 0 ? (cur.sRange?.[0] ?? 0) - (ordered[i - 1].sRange?.[1] ?? 0) : null;
    const curEnd = ringEndpoints(contextRing(cur));
    const nextStart = ringEndpoints(contextRing(next));
    const leftAlign = curEnd && nextStart ? dist2d(curEnd.leftEnd, nextStart.leftStart) : null;
    const rightAlign = curEnd && nextStart ? dist2d(curEnd.rightEnd, nextStart.rightStart) : null;
    cur.boundaryEndpointAlignmentToNext = {
      leftEndToNextStartM: leftAlign,
      rightEndToNextStartM: rightAlign,
    };
    cur.distanceToNextPolygonM = gap;
    cur.distanceToPreviousPolygonM = cur.gapToPreviousAlongTrackM;
    cur.nextPassId = next.passId;
    cur.nextPoseSectionId = next.poseSectionId;
    const h0 = headingDegAtS(vehiclePath, cur.sRange?.[1]);
    const h1 = headingDegAtS(vehiclePath, next.sRange?.[0]);
    cur.headingChangeAcrossGapDeg = (h0 != null && h1 != null)
      ? Math.abs(((h1 - h0 + 540) % 360) - 180)
      : null;

    const betweenReject = (rejections || []).find((r) => {
      const rs = r.stats?.sRange;
      if (!rs) return false;
      return rs[0] >= (cur.sRange?.[1] ?? 0) - 1 && rs[1] <= (next.sRange?.[0] ?? 0) + 1;
    });
    cur.adjacentUnsupportedRejectionReason = betweenReject
      ? betweenReject.reasons?.join('+')
      : (gap > S_RANGE_OVERLAP_MERGE_HINT_M ? 'unsupported_source_bin_gap' : null);
  }
  return ordered;
}

function contextRing(fragment) {
  return fragment._ring || [];
}

function attachRings(fragments, sourcePolys) {
  for (let i = 0; i < fragments.length; i++) {
    fragments[i]._ring = sourcePolys[i]?.ring || [];
  }
}

function auditSegmentFragments(segmentId, opts = DEFAULT_OPTS, v10PolygonCount = null) {
  const filename = `qlog_f449c_${segmentId}.bz2`;
  const loaded = loadSegmentsData(process.cwd(), [filename], opts);
  const quals = qualifySegments(loaded.audits);
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
    ...opts,
    segmentQualifications: quals,
    fileAudits: loaded.audits,
  });
  const chunk = result.routeChunks[0];
  const internalPolys = (result.roadSurfacePolygons || []).map((p) => ({
    ...p,
    segmentId,
  }));
  const serializedPolys = chunk?.roadSurfacePolygons || [];
  const vehiclePath = chunk?.vehiclePath || result.vehiclePath || [];
  const frames = chunk?.frames || result.frames || [];

  const traj = buildReferenceTrajectory(vehiclePath);
  const { observations: edgeObs } = collectEdgeObservations(frames, traj, opts);
  const leftFused = fuseSideBoundary(edgeObs, 'left', opts);

  const context = {
    segmentId,
    opts,
    frames,
    vehiclePath,
    fusedLeftPoints: leftFused.fusedPoints,
    rejections: chunk?.polygonRejections || [],
    poseTransitions: chunk?.passDiagnostics?.rejectedPoseTransitions ?? [],
  };

  let fragments = internalPolys.map((p, i) => auditFragmentPolygon(p, i, context));
  attachRings(fragments, internalPolys);
  fragments = enrichFragmentGaps(fragments, vehiclePath, context.rejections, context.poseTransitions);

  const classCtx = { maxVertexJumpM: opts.maxVertexJumpM ?? 15 };
  for (const f of fragments) {
    f.classifications = classifyFragment(f, fragments, classCtx);
    delete f._ring;
  }

  const deterministicOrder = sortFragmentsForOrdering(fragments).map((f) => f.polygonId);
  const serializedIds = serializedPolys.map((p, i) => stablePolygonId(segmentId, chunk?.chunkId, p.passId, 0, p.fragmentIndex));

  const overlapPairs = [];
  let doubleCountAreaM2 = 0;
  for (let i = 0; i < fragments.length; i++) {
    for (let j = i + 1; j < fragments.length; j++) {
      const overlap = sRangeOverlap(fragments[i].sRange, fragments[j].sRange);
      if (overlap > 0) {
        overlapPairs.push({
          a: fragments[i].polygonId,
          b: fragments[j].polygonId,
          overlapM: overlap,
        });
        doubleCountAreaM2 += Math.min(fragments[i].areaM2, fragments[j].areaM2) * (overlap / Math.max(fragments[i].coverageM, 1));
      }
    }
  }

  return {
    segmentId,
    polygonCount: fragments.length,
    v10PolygonCount,
    polygonCountDelta: v10PolygonCount != null ? fragments.length - v10PolygonCount : null,
    temporalPassCount: chunk?.passDiagnostics?.passCount ?? chunk?.passCoverage?.length ?? 1,
    poseSectionCount: chunk?.passDiagnostics?.poseSectionCount ?? 1,
    fragments,
    deterministicOrder,
    serializedPolygonCount: serializedPolys.length,
    serializedIds,
    overlapPairs,
    estimatedDoubleCountAreaM2: doubleCountAreaM2,
    rejections: (chunk?.polygonRejections || []).map((r) => ({
      fragmentIndex: r.fragmentIndex,
      passId: r.passId,
      poseSectionId: r.poseSectionId,
      reasons: r.reasons,
      sRange: r.stats?.sRange,
      maxVertexJumpM: r.stats?.maxVertexJump,
    })),
    downstream: {
      chunkRetainsAll: serializedPolys.length === fragments.length,
      topLevelRetainsAll: internalPolys.length === fragments.length,
      orderingStable: deterministicOrder.length === fragments.length,
    },
  };
}

function buildDatasetDistributions(segmentAudits) {
  const polygonsPerSegment = [];
  const coverageLengths = [];
  const areas = [];
  const gapLengths = [];
  const overlapCount = [];
  const tinyPolygons = [];
  const sharpIncreases = [];

  for (const seg of segmentAudits) {
    polygonsPerSegment.push({ segmentId: seg.segmentId, count: seg.polygonCount });
    if (seg.polygonCountDelta != null && seg.polygonCountDelta >= 3) {
      sharpIncreases.push({
        segmentId: seg.segmentId,
        v10: seg.v10PolygonCount,
        v11: seg.polygonCount,
        delta: seg.polygonCountDelta,
      });
    }
    for (const f of seg.fragments) {
      coverageLengths.push(f.coverageM);
      areas.push(f.areaM2);
      if (f.gapToNextAlongTrackM != null) gapLengths.push(f.gapToNextAlongTrackM);
      if (f.areaM2 < TINY_AREA_M2 || f.coverageM < MIN_MAPPING_COVERAGE_M) {
        tinyPolygons.push({ segmentId: seg.segmentId, polygonId: f.polygonId, areaM2: f.areaM2, coverageM: f.coverageM });
      }
    }
    overlapCount.push({ segmentId: seg.segmentId, pairs: seg.overlapPairs.length });
  }

  return {
    polygonsPerSegment: {
      min: Math.min(...polygonsPerSegment.map((p) => p.count), 0),
      median: median(polygonsPerSegment.map((p) => p.count)),
      p90: percentile(polygonsPerSegment.map((p) => p.count), 0.9),
      max: Math.max(...polygonsPerSegment.map((p) => p.count), 0),
      entries: polygonsPerSegment,
    },
    coverageLengthM: {
      min: coverageLengths.length ? Math.min(...coverageLengths) : 0,
      median: median(coverageLengths),
      p90: percentile(coverageLengths, 0.9),
      max: coverageLengths.length ? Math.max(...coverageLengths) : 0,
    },
    areaM2: {
      min: areas.length ? Math.min(...areas) : 0,
      median: median(areas),
      p90: percentile(areas, 0.9),
      max: areas.length ? Math.max(...areas) : 0,
    },
    gapLengthM: {
      min: gapLengths.length ? Math.min(...gapLengths) : 0,
      median: median(gapLengths),
      p90: percentile(gapLengths, 0.9),
      max: gapLengths.length ? Math.max(...gapLengths) : 0,
      count: gapLengths.length,
    },
    overlapPairsTotal: overlapCount.reduce((n, x) => n + x.pairs, 0),
    tinyPolygonCount: tinyPolygons.length,
    tinyPolygons,
    sharpIncreasesFromV10: sharpIncreases,
  };
}

function loadV10PolygonCounts() {
  try {
    const v10 = require('../audit_dataset_v10_full.json');
    const map = new Map();
    for (const r of v10.results || []) map.set(r.segmentId, r.polygonCount ?? 0);
    return map;
  } catch {
    return new Map();
  }
}

function verifyDownstreamCompatibility(segmentAudit, result) {
  const chunk = result.routeChunks[0];
  const roundTrip = JSON.parse(JSON.stringify(chunk));
  return {
    jsonRoundTripCount: roundTrip.roadSurfacePolygons?.length ?? 0,
    topLevelCount: result.roadSurfacePolygons?.length ?? 0,
    chunkCount: chunk?.roadSurfacePolygons?.length ?? 0,
    allEqual: (roundTrip.roadSurfacePolygons?.length ?? 0) === (chunk?.roadSurfacePolygons?.length ?? 0)
      && (result.roadSurfacePolygons?.length ?? 0) === (chunk?.roadSurfacePolygons?.length ?? 0),
    deterministicOrder: segmentAudit.deterministicOrder,
  };
}

module.exports = {
  DEFAULT_OPTS,
  REPRESENTATIVE_SEGMENTS,
  CONTROL_SEGMENTS,
  MIN_MAPPING_COVERAGE_M,
  stablePolygonId,
  sortFragmentsForOrdering,
  classifyFragment,
  auditFragmentPolygon,
  auditSegmentFragments,
  buildDatasetDistributions,
  loadV10PolygonCounts,
  verifyDownstreamCompatibility,
  sRangeOverlap,
  ringEndpoints,
};
