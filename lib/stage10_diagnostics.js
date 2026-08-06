/**
 * Stage 10 per-candidate fusion/polygon diagnostics.
 * Read-only instrumentation — does not change processing thresholds.
 */
const { dist2d } = require('./chunking');
const { buildReferenceTrajectory } = require('./trajectory');
const {
  collectEdgeObservations,
  fuseSideBoundary,
  resampleBoundaries,
  buildPolygonsFromIntervals,
  processChunkSdFusion,
} = require('./sd_fusion');
const {
  segmentsIntersect,
  countSelfIntersections,
  maxConsecutiveVertexJump,
  validateRoadPolygon,
  widthsAlongPolygon,
} = require('./geometry_sanity');

const STAGE10_CANDIDATES = [5, 9, 24, 28, 46, 50, 56, 58, 65, 72, 92, 99];
const STAGE10_GROUPS = {
  selfIntersecting: [5, 24, 56, 58, 99],
  vertexJumpTooLarge: [28, 46, 50, 72, 92],
  insufficientPairedCoverage: [9, 65],
};

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

function findAllSelfIntersections(ring) {
  const hits = [];
  for (let i = 0; i < ring.length - 1; i++) {
    for (let j = i + 2; j < ring.length - 1; j++) {
      if (i === 0 && j === ring.length - 2) continue;
      if (segmentsIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])) {
        hits.push({
          edgeA: { from: i, to: i + 1 },
          edgeB: { from: j, to: j + 1 },
          pointA0: { east: ring[i].east, north: ring[i].north, s: ring[i].s },
          pointA1: { east: ring[i + 1].east, north: ring[i + 1].north, s: ring[i + 1]?.s },
          pointB0: { east: ring[j].east, north: ring[j].north, s: ring[j].s },
          pointB1: { east: ring[j + 1].east, north: ring[j + 1].north, s: ring[j + 1]?.s },
          onLeftLeg: i < ring.length / 2 && j < ring.length / 2,
          onRightLeg: i >= ring.length / 2 && j >= ring.length / 2,
          crossesLegs: (i < ring.length / 2) !== (j < ring.length / 2),
        });
      }
    }
  }
  return hits;
}

function findMaxVertexJumpDetail(ring) {
  let max = 0;
  let fromIndex = 0;
  for (let i = 1; i < ring.length; i++) {
    const d = dist2d(ring[i - 1], ring[i]);
    if (d > max) {
      max = d;
      fromIndex = i - 1;
    }
  }
  const n = ring.length;
  const half = Math.floor(n / 2);
  const leg = fromIndex < half ? 'left' : (fromIndex === n - 1 ? 'left-to-right-bridge' : 'right');
  return {
    distanceM: max,
    fromIndex,
    toIndex: fromIndex + 1,
    from: { east: ring[fromIndex].east, north: ring[fromIndex].north, s: ring[fromIndex].s },
    to: { east: ring[fromIndex + 1].east, north: ring[fromIndex + 1].north, s: ring[fromIndex + 1]?.s },
    leg,
    isBridgeEdge: fromIndex === half - 1 || fromIndex === n - 1,
  };
}

function analyzeVertexOrder(left, right) {
  const issues = [];
  const checkMonotonicS = (pts, label) => {
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].s != null && pts[i - 1].s != null && pts[i].s < pts[i - 1].s - 0.5) {
        issues.push({ type: 'nonMonotonicS', boundary: label, index: i, sPrev: pts[i - 1].s, sCur: pts[i].s });
      }
    }
  };
  checkMonotonicS(left, 'left');
  const rightForward = [...right];
  checkMonotonicS(rightForward, 'right');

  const ring = [...left, ...[...right].reverse()];
  const expectedOrder = 'left-forward then right-reverse';
  return { expectedOrder, ringVertexCount: ring.length, leftCount: left.length, rightCount: right.length, issues };
}

function countPairedFrames(edgeObs) {
  const byFrame = new Map();
  for (const o of edgeObs) {
    if (!byFrame.has(o.frameId)) byFrame.set(o.frameId, { left: 0, right: 0 });
    const f = byFrame.get(o.frameId);
    if (o.side === 'left') f.left++;
    else if (o.side === 'right') f.right++;
  }
  let paired = 0;
  let leftOnly = 0;
  let rightOnly = 0;
  for (const f of byFrame.values()) {
    if (f.left > 0 && f.right > 0) paired++;
    else if (f.left > 0) leftOnly++;
    else if (f.right > 0) rightOnly++;
  }
  return { pairedFrameCount: paired, leftOnlyFrames: leftOnly, rightOnlyFrames: rightOnly, totalFrames: byFrame.size };
}

function analyzeBinFusion(edgeObs, side, options) {
  const interval = options.fusionIntervalM ?? 2.0;
  const sideObs = edgeObs.filter((o) => o.side === side);
  const bins = new Map();
  for (const obs of sideObs) {
    const key = Math.round(obs.s / interval);
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push(obs);
  }
  const occupied = [...bins.keys()].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < occupied.length; i++) {
    const gapBins = occupied[i] - occupied[i - 1] - 1;
    if (gapBins > 0) {
      gaps.push({
        afterBin: occupied[i - 1],
        beforeBin: occupied[i],
        missingBins: gapBins,
        gapDistanceM: gapBins * interval,
      });
    }
  }
  const frameCounts = occupied.map((k) => {
    const obs = bins.get(k);
    return new Set(obs.map((o) => o.frameId)).size;
  });
  return {
    side,
    totalObservations: sideObs.length,
    occupiedBinCount: occupied.length,
    minBinKey: occupied[0] ?? null,
    maxBinKey: occupied[occupied.length - 1] ?? null,
    binGaps: gaps,
    maxBinGapM: gaps.length ? Math.max(...gaps.map((g) => g.gapDistanceM)) : 0,
    framesPerBin: {
      min: frameCounts.length ? Math.min(...frameCounts) : 0,
      median: median(frameCounts),
      max: frameCounts.length ? Math.max(...frameCounts) : 0,
    },
  };
}

function analyzeInterpolation(intervals, leftFrags, rightFrags, options) {
  const sampleStep = options.polygonSampleStepM ?? 2.0;
  const leftPts = leftFrags.flat().sort((a, b) => a.s - b.s);
  const rightPts = rightFrags.flat().sort((a, b) => a.s - b.s);
  if (!leftPts.length || !rightPts.length) {
    return { unsupportedInterpolationDistanceM: 0, boundaryCrossingSamples: 0, invalidWidthSamples: 0 };
  }

  const interpolateD = (pts, s) => {
    if (s < pts[0].s || s > pts[pts.length - 1].s) return null;
    for (let i = 1; i < pts.length; i++) {
      if (s <= pts[i].s) {
        const t = (s - pts[i - 1].s) / (pts[i].s - pts[i - 1].s || 1);
        return { d: pts[i - 1].d + t * (pts[i].d - pts[i - 1].d), spanM: pts[i].s - pts[i - 1].s, t };
      }
    }
    return { d: pts[pts.length - 1].d, spanM: 0, t: 1 };
  };

  const sMin = Math.max(leftPts[0].s, rightPts[0].s);
  const sMax = Math.min(leftPts[leftPts.length - 1].s, rightPts[rightPts.length - 1].s);
  let maxInterpSpan = 0;
  let boundaryCrossing = 0;
  let invalidWidth = 0;
  let outsideRange = 0;

  for (let s = sMin; s <= sMax; s += sampleStep) {
    const lR = interpolateD(leftPts, s);
    const rR = interpolateD(rightPts, s);
    if (!lR || !rR) { outsideRange++; continue; }
    maxInterpSpan = Math.max(maxInterpSpan, lR.spanM, rR.spanM);
    const width = Math.abs(lR.d - rR.d);
    if (lR.d < rR.d) boundaryCrossing++;
    if (width < (options.minRoadWidthM ?? 2) || width > (options.maxRoadWidthM ?? 30)) invalidWidth++;
  }

  return {
    sampleStepM: sampleStep,
    sRange: [sMin, sMax],
    maxInterpolationSpanM: maxInterpSpan,
    unsupportedInterpolationDistanceM: maxInterpSpan,
    boundaryCrossingSamples: boundaryCrossing,
    invalidWidthSamples: invalidWidth,
    outsideRangeSamples: outsideRange,
    intervalCount: intervals.length,
    totalSampleCount: intervals.reduce((n, iv) => n + iv.length, 0),
  };
}

function widthDistribution(left, right) {
  const widths = widthsAlongPolygon(left, right);
  if (!widths.length) return null;
  return {
    min: Math.min(...widths),
    p5: percentile(widths, 0.05),
    median: median(widths),
    p95: percentile(widths, 0.95),
    max: Math.max(...widths),
    sampleCount: widths.length,
  };
}

function classifySelfIntersectionCause(ctx) {
  const causes = [];
  const { intersections, vertexOrder, interpolation, fusion, rejection } = ctx;

  if (vertexOrder.issues.length > 0) causes.push('incorrect_vertex_ordering');
  if (interpolation.boundaryCrossingSamples > 0) causes.push('lane_side_swapping');
  if (interpolation.maxInterpolationSpanM > (ctx.options.fusionIntervalM ?? 2) * 2) {
    causes.push('sparse_bin_interpolation');
  }
  if (intersections.some((h) => h.crossesLegs && (h.edgeA.from < 3 || h.edgeB.from < 3))) {
    causes.push('noisy_endpoint_geometry');
  }
  if (fusion.left.maxBinGapM > 4 || fusion.right.maxBinGapM > 4) {
    causes.push('sparse_bin_interpolation');
  }
  if (causes.length === 0 && intersections.length > 0) {
    causes.push('genuine_road_curve_unrepresentable');
  }
  return [...new Set(causes)];
}

function classifyVertexJumpCause(ctx) {
  const causes = [];
  const { jump, fusion, interpolation, leftResult, rightResult } = ctx;

  if (fusion.left.binGaps.length || fusion.right.binGaps.length) {
    causes.push('missing_fusion_bin');
  }
  const rejectedBins = [...leftResult.rejected, ...rightResult.rejected]
    .filter((r) => r.reason === 'insufficientObservations' || r.reason === 'insufficientFrameSupport');
  if (rejectedBins.length > 0) causes.push('insufficient_observations');
  const spikes = [...leftResult.rejected, ...rightResult.rejected].filter((r) => r.reason === 'lateralSpike');
  if (spikes.length > 0) causes.push('edge_tracking_discontinuity');
  if (interpolation.maxInterpolationSpanM > 6) causes.push('excessive_smoothing_or_interpolation');
  if (ctx.vertexOrder.issues.length > 0) causes.push('incorrect_point_ordering');
  if (jump.isBridgeEdge) causes.push('left_right_bridge_gap');
  if (causes.length === 0) causes.push('genuine_unsupported_gap');
  return [...new Set(causes)];
}

function diagnoseRejectedPolygon(left, right, options, context) {
  const ring = [...left, ...[...right].reverse()];
  const check = validateRoadPolygon(left, right, options);
  const intersections = findAllSelfIntersections(ring);
  const jump = findMaxVertexJumpDetail(ring);
  const vertexOrder = analyzeVertexOrder(left, right);
  const widths = widthDistribution(left, right);

  const ctx = { ...context, intersections, jump, vertexOrder, rejection: check };
  const rootCauses = check.rejections.includes('selfIntersecting')
    ? classifySelfIntersectionCause(ctx)
    : check.rejections.includes('vertexJumpTooLarge')
      ? classifyVertexJumpCause(ctx)
      : [];

  return {
    rejectionReasons: check.rejections,
    exactRejectionConditions: check.rejections.map((r) => {
      if (r === 'selfIntersecting') return `countSelfIntersections(ring)=${check.stats.intersections} > 0`;
      if (r === 'vertexJumpTooLarge') return `maxConsecutiveVertexJump(ring)=${check.stats.maxVertexJump.toFixed(2)} > maxVertexJumpM=${options.maxVertexJumpM ?? 15}`;
      if (r === 'widthBelowMin') return `minWidth=${check.stats.minWidth.toFixed(2)} < minRoadWidthM=${options.minRoadWidthM ?? 2}`;
      if (r === 'widthAboveMax') return `maxWidth=${check.stats.maxWidth.toFixed(2)} > maxRoadWidthM=${options.maxRoadWidthM ?? 30}`;
      return r;
    }),
    stats: check.stats,
    selfIntersections: intersections,
    maxVertexJump: jump,
    vertexOrder,
    laneWidthDistribution: widths,
    inferredRootCauses: rootCauses,
  };
}

function diagnoseSegmentFusion(frames, vehiclePath, options = {}) {
  const trajectory = buildReferenceTrajectory(vehiclePath);
  const { observations: edgeObs } = collectEdgeObservations(frames, trajectory, options);

  const leftResult = fuseSideBoundary(edgeObs, 'left', options);
  const rightResult = fuseSideBoundary(edgeObs, 'right', options);

  const { intervals, rejected: intervalRejected } = resampleBoundaries(
    leftResult.fragments,
    rightResult.fragments,
    trajectory,
    options
  );
  const { polygons, rejectionLog } = buildPolygonsFromIntervals(intervals, trajectory, options);

  const pairedFrames = countPairedFrames(edgeObs);
  const leftBins = analyzeBinFusion(edgeObs, 'left', options);
  const rightBins = analyzeBinFusion(edgeObs, 'right', options);
  const interpolation = analyzeInterpolation(intervals, leftResult.fragments, rightResult.fragments, options);

  const fusion = { left: leftBins, right: rightBins };
  const context = {
    options,
    fusion,
    interpolation,
    leftResult,
    rightResult,
  };

  const rejectedDetails = rejectionLog.map((rej, idx) => {
    const interval = intervals[rej.fragmentIndex];
    if (!interval) {
      return { fragmentIndex: rej.fragmentIndex, reasons: rej.reasons, stats: rej.stats };
    }
    const left = interval.map((smp) => {
      const { sToMap } = require('./trajectory');
      return { ...sToMap(trajectory, smp.s, smp.dL), s: smp.s, d: smp.dL };
    });
    const right = interval.map((smp) => {
      const { sToMap } = require('./trajectory');
      return { ...sToMap(trajectory, smp.s, smp.dR), s: smp.s, d: smp.dR };
    });
    return {
      fragmentIndex: rej.fragmentIndex,
      ...diagnoseRejectedPolygon(left, right, options, context),
    };
  });

  const acceptedDetails = polygons.map((p) => ({
    fragmentIndex: p.fragmentIndex,
    stats: p.stats,
    selfIntersectionCount: countSelfIntersections(p.ring),
    maxVertexJump: findMaxVertexJumpDetail(p.ring).distanceM,
  }));

  return {
    edgeObservationCount: edgeObs.length,
    leftObservationCount: edgeObs.filter((o) => o.side === 'left').length,
    rightObservationCount: edgeObs.filter((o) => o.side === 'right').length,
    pairedFrames,
    fusionBins: fusion,
    occupiedFusionBinCount: {
      left: leftBins.occupiedBinCount,
      right: rightBins.occupiedBinCount,
    },
    fusedPointCount: {
      left: leftResult.fusedPoints.length,
      right: rightResult.fusedPoints.length,
    },
    longitudinalCoverageM: {
      left: leftResult.fusedPoints.length
        ? leftResult.fusedPoints[leftResult.fusedPoints.length - 1].s - leftResult.fusedPoints[0].s
        : 0,
      right: rightResult.fusedPoints.length
        ? rightResult.fusedPoints[rightResult.fusedPoints.length - 1].s - rightResult.fusedPoints[0].s
        : 0,
      paired: Math.min(
        leftResult.fusedPoints.length ? leftResult.fusedPoints[leftResult.fusedPoints.length - 1].s - leftResult.fusedPoints[0].s : 0,
        rightResult.fusedPoints.length ? rightResult.fusedPoints[rightResult.fusedPoints.length - 1].s - rightResult.fusedPoints[0].s : 0
      ),
    },
    interpolation,
    intervalRejected,
    acceptedPolygonCount: polygons.length,
    rejectedPolygonCount: rejectionLog.length,
    acceptedPolygons: acceptedDetails,
    rejectedPolygons: rejectedDetails,
    fusionRejections: {
      left: leftResult.rejected.length,
      right: rightResult.rejected.length,
      leftByReason: summarizeRejections(leftResult.rejected),
      rightByReason: summarizeRejections(rightResult.rejected),
    },
  };
}

function summarizeRejections(rejected) {
  const acc = {};
  for (const r of rejected) {
    acc[r.reason] = (acc[r.reason] || 0) + 1;
  }
  return acc;
}

function diagnoseCandidateSegment(loaded, options = {}) {
  const { qualifySegments } = require('./segment_qualify');
  const { processRoute } = require('./process_route');
  const { detectPasses, assignFramesToPasses } = require('./passes');
  const { trackLanesAndEdgesInPass } = require('./lane_tracking');
  const {
    assignPoseSections,
    applyPoseSectionsToFrames,
  } = require('./pose_continuity');

  const quals = qualifySegments(loaded.audits);
  const procOpts = { ...options, segmentQualifications: quals, fileAudits: loaded.audits };
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, procOpts);
  const chunk = result.routeChunks[0];
  const chunkFiles = chunk?.files || loaded.audits.map((a) => a.filename);
  const frames = result.frames.filter((f) => chunkFiles.includes(f.sourceFile));
  const vehiclePath = chunk?.vehiclePath || result.vehiclePath;

  const { passes } = detectPasses(vehiclePath, procOpts);
  const assignedFrames = assignFramesToPasses(frames, passes);
  const pathWithPassIds = passes.flatMap((p) => p.points.map((pt) => ({
    ...pt,
    temporalPassId: p.passId,
    passId: p.passId,
  })));
  const poseResult = assignPoseSections(pathWithPassIds, procOpts);
  const framesWithPose = applyPoseSectionsToFrames(assignedFrames, poseResult.annotatedPoints);

  const passDiagnostics = [];
  for (const pass of passes) {
    const passFrames = framesWithPose.filter((f) => f.passId === pass.passId);
    const sectionIds = [...new Set(passFrames.map((f) => f.poseSectionId ?? 0))];

    for (const poseSectionId of sectionIds) {
      const sectionFrames = passFrames.filter((f) => (f.poseSectionId ?? 0) === poseSectionId);
      const tracked = trackLanesAndEdgesInPass(sectionFrames, procOpts);
      const sectionPath = poseResult.annotatedPoints.filter(
        (p) => p.passId === pass.passId && p.poseSectionId === poseSectionId
      );
      const passPath = sectionPath.length ? sectionPath : pass.points;

      passDiagnostics.push({
        temporalPassId: pass.passId,
        poseSectionId,
        frameCount: sectionFrames.length,
        pathLengthM: pass.pathLengthM,
        fusion: diagnoseSegmentFusion(tracked.frames, passPath, procOpts),
      });
    }
  }

  const segNum = parseInt(loaded.audits[0]?.filename?.match(/_(\d+)/)?.[1] ?? '-1', 10);
  const group = STAGE10_GROUPS.selfIntersecting.includes(segNum)
    ? 'selfIntersecting'
    : STAGE10_GROUPS.vertexJumpTooLarge.includes(segNum)
      ? 'vertexJumpTooLarge'
      : STAGE10_GROUPS.insufficientPairedCoverage.includes(segNum)
        ? 'insufficientPairedCoverage'
        : 'unknown';

  return {
    segmentId: segNum,
    stage10Group: group,
    temporalPassCount: chunk?.passDiagnostics?.passCount ?? passes.length,
    poseSectionCount: chunk?.passDiagnostics?.poseSectionCount ?? 1,
    rejectedPoseTransitions: chunk?.passDiagnostics?.rejectedPoseTransitions ?? 0,
    polygonCount: chunk?.roadSurfacePolygons?.length ?? 0,
    passSections: passDiagnostics,
    primarySection: passDiagnostics[0] ?? null,
  };
}

module.exports = {
  STAGE10_CANDIDATES,
  STAGE10_GROUPS,
  diagnoseCandidateSegment,
  diagnoseSegmentFusion,
  diagnoseRejectedPolygon,
  findAllSelfIntersections,
  findMaxVertexJumpDetail,
  analyzeVertexOrder,
  classifySelfIntersectionCause,
  classifyVertexJumpCause,
};
