/**
 * Stage 13A — fusion-path tracing (read-only).
 * Instruments each fusion stage to reconcile diagnostic vs production outcomes.
 */
const { loadSegmentsData } = require('./qlog_data');
const { processRoute } = require('./process_route');
const { qualifySegments } = require('./segment_qualify');
const { detectPasses, assignFramesToPasses } = require('./passes');
const { trackLanesAndEdgesInPass } = require('./lane_tracking');
const { assignPoseSections, applyPoseSectionsToFrames } = require('./pose_continuity');
const { buildReferenceTrajectory } = require('./trajectory');
const { DEFAULT_OPTS } = require('./stage11_fragment_audit');
const {
  collectEdgeObservations,
  fuseSideBoundary,
  splitSupportedRuns,
  pairSupportedRuns,
  resampleBoundaries,
  resamplePairedRun,
  buildPolygonsFromIntervals,
  resolveMaxInterpolationSpanM,
  interpolateDWithinRun,
} = require('./sd_fusion');
const {
  segmentsIntersect,
  countSelfIntersections,
  validateRoadPolygon,
} = require('./geometry_sanity');
const { sToMap } = require('./trajectory');

function coverageLength(fusedPoints) {
  if (!fusedPoints?.length) return 0;
  return fusedPoints[fusedPoints.length - 1].s - fusedPoints[0].s;
}

const NEGATIVE_CONTROLS = {
  straightValid: 0,
  curvedValid: 10,
  insufficientEvidence: 9,
  multiPass: 57,
};

function countPairedFrames(edgeObs) {
  const byFrame = new Map();
  for (const o of edgeObs) {
    if (!byFrame.has(o.frameId)) byFrame.set(o.frameId, { left: 0, right: 0 });
    const f = byFrame.get(o.frameId);
    if (o.side === 'left') f.left++;
    else f.right++;
  }
  let paired = 0;
  for (const f of byFrame.values()) if (f.left > 0 && f.right > 0) paired++;
  return { pairedFrameCount: paired, totalFrames: byFrame.size };
}

function binKeyRange(pts) {
  if (!pts?.length) return null;
  const keys = pts.map((p) => p.binKey).filter((k) => k != null);
  if (!keys.length) return { sRange: [pts[0].s, pts[pts.length - 1].s] };
  return { binKeyMin: Math.min(...keys), binKeyMax: Math.max(...keys), sRange: [pts[0].s, pts[pts.length - 1].s] };
}

function summarizeRuns(runs) {
  return runs.map((run, i) => ({
    runIndex: i,
    pointCount: run.length,
    sRange: [run[0].s, run[run.length - 1].s],
    coverageM: run[run.length - 1].s - run[0].s,
    binKeyRange: binKeyRange(run),
    monotonicS: run.every((p, j) => j === 0 || p.s >= run[j - 1].s - 1e-6),
  }));
}

function traceResampleDetail(leftRun, rightRun, overlapStart, overlapEnd, options) {
  const sampleStep = options.polygonSampleStepM ?? 2.0;
  const fusionIntervalM = options.fusionIntervalM ?? 2.0;
  const maxInterpolationSpanM = resolveMaxInterpolationSpanM(options);
  const minWidth = options.minRoadWidthM ?? 2;
  const maxWidth = options.maxRoadWidthM ?? 30;

  const sampleRejections = { tooNarrow: 0, tooWide: 0, boundaryCrossing: 0, interpGap: 0 };
  const samples = [];
  for (let s = overlapStart; s <= overlapEnd + 1e-9; s += sampleStep) {
    const lR = interpolateDWithinRun(leftRun, s, maxInterpolationSpanM, fusionIntervalM);
    const rR = interpolateDWithinRun(rightRun, s, maxInterpolationSpanM, fusionIntervalM);
    if (!lR || !rR) { sampleRejections.interpGap++; continue; }
    const width = Math.abs(lR.d - rR.d);
    if (width < minWidth) { sampleRejections.tooNarrow++; samples.push({ s, valid: false, reason: 'tooNarrow', width }); continue; }
    if (width > maxWidth) { sampleRejections.tooWide++; samples.push({ s, valid: false, reason: 'tooWide', width }); continue; }
    if (lR.d < rR.d) { sampleRejections.boundaryCrossing++; samples.push({ s, valid: false, reason: 'boundaryCrossing', width }); continue; }
    samples.push({ s, valid: true, dL: lR.d, dR: rR.d, width });
  }
  const intervals = resamplePairedRun(leftRun, rightRun, overlapStart, overlapEnd, options);
  return { sampleRejections, totalSamples: samples.length, validSamples: samples.filter((s) => s.valid).length, intervalsProduced: intervals.length, intervalLengths: intervals.map((iv) => iv.length) };
}

// interpolateDWithinRun is not exported - use internal via resamplePairedRun only, or export it
// I'll duplicate minimal sample counting in trace via resamplePairedRun results

function traceSectionFusion(sectionFrames, sectionPath, opts, context) {
  const trajectory = buildReferenceTrajectory(sectionPath);
  const stages = [];

  const rawLeft = [];
  const rawRight = [];
  for (const frame of sectionFrames) {
    for (const edge of frame.edges || []) {
      for (const pt of edge.points || []) {
        const entry = { frameId: frame.frameId, logMonoTime: frame.logMonoTime, prob: edge.prob ?? 1 };
        if (pt.modelY >= 0) rawLeft.push(entry);
        else rawRight.push(entry);
      }
    }
  }
  stages.push({
    stage: 1,
    name: 'raw_road_edge_observations',
    leftCount: rawLeft.length,
    rightCount: rawRight.length,
    pairedFrameCount: null,
    longitudinalCoverageM: null,
    rejectionReasons: {},
    notes: 'Vehicle-frame edge points before GPS projection',
  });

  const { observations: edgeObs, rejected: rejectedObs } = collectEdgeObservations(sectionFrames, trajectory, opts);
  const leftObs = edgeObs.filter((o) => o.side === 'left');
  const rightObs = edgeObs.filter((o) => o.side === 'right');
  const pairedFrames = countPairedFrames(edgeObs);
  const rejByReason = {};
  for (const r of rejectedObs) rejByReason[r.reason] = (rejByReason[r.reason] || 0) + 1;

  stages.push({
    stage: 2,
    name: 'projection_and_validity_filter',
    leftCount: leftObs.length,
    rightCount: rightObs.length,
    pairedFrameCount: pairedFrames.pairedFrameCount,
    longitudinalCoverageM: {
      left: leftObs.length ? Math.max(...leftObs.map((o) => o.s)) - Math.min(...leftObs.map((o) => o.s)) : 0,
      right: rightObs.length ? Math.max(...rightObs.map((o) => o.s)) - Math.min(...rightObs.map((o) => o.s)) : 0,
    },
    rejectionReasons: rejByReason,
    rejectedCount: rejectedObs.length,
    sRange: {
      left: leftObs.length ? [Math.min(...leftObs.map((o) => o.s)), Math.max(...leftObs.map((o) => o.s))] : null,
      right: rightObs.length ? [Math.min(...rightObs.map((o) => o.s)), Math.max(...rightObs.map((o) => o.s))] : null,
    },
  });

  stages.push({
    stage: 3,
    name: 'temporal_pass_assignment',
    leftCount: leftObs.length,
    rightCount: rightObs.length,
    pairedFrameCount: pairedFrames.pairedFrameCount,
    passId: context.passId,
    poseSectionId: context.poseSectionId,
  });

  stages.push({
    stage: 4,
    name: 'pose_section_assignment',
    leftCount: leftObs.length,
    rightCount: rightObs.length,
    pairedFrameCount: pairedFrames.pairedFrameCount,
    passId: context.passId,
    poseSectionId: context.poseSectionId,
    frameCount: sectionFrames.length,
  });

  const leftResult = fuseSideBoundary(edgeObs, 'left', opts);
  const rightResult = fuseSideBoundary(edgeObs, 'right', opts);
  const binRejectLeft = {};
  const binRejectRight = {};
  for (const r of leftResult.rejected) binRejectLeft[r.reason] = (binRejectLeft[r.reason] || 0) + 1;
  for (const r of rightResult.rejected) binRejectRight[r.reason] = (binRejectRight[r.reason] || 0) + 1;

  const occupiedLeftBins = leftResult.fusedPoints.length;
  const occupiedRightBins = rightResult.fusedPoints.length;

  stages.push({
    stage: 5,
    name: 'fusion_bin_construction',
    leftCount: occupiedLeftBins,
    rightCount: occupiedRightBins,
    pairedFrameCount: pairedFrames.pairedFrameCount,
    longitudinalCoverageM: {
      aggregateFusedSpan: {
        left: coverageLength(leftResult.fusedPoints),
        right: coverageLength(rightResult.fusedPoints),
        paired: Math.min(coverageLength(leftResult.fusedPoints), coverageLength(rightResult.fusedPoints)),
      },
    },
    binKeyRanges: {
      left: binKeyRange(leftResult.fusedPoints),
      right: binKeyRange(rightResult.fusedPoints),
    },
    rejectionReasons: { left: binRejectLeft, right: binRejectRight },
    minFramesPerBinFilter: opts.minFramesPerBin ?? 2,
  });

  stages.push({
    stage: 6,
    name: 'minFramesPerBin_filtering',
    leftCount: occupiedLeftBins,
    rightCount: occupiedRightBins,
    rejectedBins: {
      left: leftResult.rejected.filter((r) => r.reason === 'insufficientFrameSupport').length,
      right: rightResult.rejected.filter((r) => r.reason === 'insufficientFrameSupport').length,
    },
    fragmentCounts: { left: leftResult.fragments.length, right: rightResult.fragments.length },
  });

  const maxSpan = resolveMaxInterpolationSpanM(opts);
  const fusionIntervalM = opts.fusionIntervalM ?? 2;
  const leftFlat = leftResult.fragments.flat().sort((a, b) => a.s - b.s);
  const rightFlat = rightResult.fragments.flat().sort((a, b) => a.s - b.s);
  const leftRuns = splitSupportedRuns(leftFlat, maxSpan, fusionIntervalM);
  const rightRuns = splitSupportedRuns(rightFlat, maxSpan, fusionIntervalM);

  stages.push({
    stage: 7,
    name: 'supported_run_splitting',
    leftCount: leftRuns.length,
    rightCount: rightRuns.length,
    maxInterpolationSpanM: maxSpan,
    supportedRuns: { left: summarizeRuns(leftRuns), right: summarizeRuns(rightRuns) },
    sourceBinGaps: {
      left: leftFlat.length > 1 ? findBinGaps(leftFlat, fusionIntervalM, maxSpan) : [],
      right: rightFlat.length > 1 ? findBinGaps(rightFlat, fusionIntervalM, maxSpan) : [],
    },
  });

  const sampleStep = opts.polygonSampleStepM ?? 2.0;
  const minOverlapM = sampleStep * 2;
  const pairedRuns = pairSupportedRuns(leftRuns, rightRuns, minOverlapM);

  const qualifyingOverlapM = pairedRuns.reduce((s, p) => s + p.overlapM, 0);
  stages.push({
    stage: 8,
    name: 'left_right_run_pairing',
    leftCount: leftRuns.length,
    rightCount: rightRuns.length,
    pairedRunCount: pairedRuns.length,
    minOverlapM,
    pairedRunOverlaps: pairedRuns.map((p) => ({
      leftRunIndex: p.leftRunIndex,
      rightRunIndex: p.rightRunIndex,
      overlapStart: p.overlapStart,
      overlapEnd: p.overlapEnd,
      overlapM: p.overlapM,
      leftSRange: [p.leftRun[0].s, p.leftRun[p.leftRun.length - 1].s],
      rightSRange: [p.rightRun[0].s, p.rightRun[p.rightRun.length - 1].s],
    })),
    qualifyingPairedOverlapM: qualifyingOverlapM,
  });

  const resample = resampleBoundaries(leftResult.fragments, rightResult.fragments, trajectory, opts);
  const resampleDetails = pairedRuns.map((p) => ({
    ...traceResampleDetail(p.leftRun, p.rightRun, p.overlapStart, p.overlapEnd, opts),
    overlapM: p.overlapM,
    overlapRange: [p.overlapStart, p.overlapEnd],
  }));

  stages.push({
    stage: 9,
    name: 'paired_overlap_resampling',
    intervalCount: resample.intervals.length,
    rejected: resample.rejected,
    resampleDetails,
    validIntervalSampleCounts: resample.intervals.map((iv) => iv.length),
  });

  const { polygons, rejectionLog } = buildPolygonsFromIntervals(resample.intervals, trajectory, opts);
  stages.push({
    stage: 10,
    name: 'polygon_construction',
    attemptedCount: resample.intervals.length,
    acceptedCount: polygons.length,
    rejectedCount: rejectionLog.length,
  });

  stages.push({
    stage: 11,
    name: 'polygon_validation',
    acceptedCount: polygons.length,
    rejectedCount: rejectionLog.length,
    rejectionReasons: summarizeRejections(rejectionLog),
    rejectedPolygons: rejectionLog.map((r) => ({
      fragmentIndex: r.fragmentIndex,
      reasons: r.reasons,
      sRange: r.stats?.sRange,
      sampleCount: r.stats?.length,
      intersections: r.stats?.intersections,
      maxVertexJump: r.stats?.maxVertexJump,
    })),
  });

  const aggregatePairedCov = Math.min(coverageLength(leftResult.fusedPoints), coverageLength(rightResult.fusedPoints));
  const reconciliation = {
    aggregateRawPairedCoverageM: aggregatePairedCov,
    coverageAfterFusionBinsM: aggregatePairedCov,
    qualifyingPairedRunOverlapM: qualifyingOverlapM,
    polygonIntervalsProduced: resample.intervals.length,
    productionPolygonCount: polygons.length,
    discrepancy: aggregatePairedCov > 20 && polygons.length === 0
      ? 'aggregate_fused_span_exceeds_20m_but_zero_polygons'
      : null,
    explanation: aggregatePairedCov > qualifyingOverlapM + 1
      ? 'Diagnostic pairedCoverageM uses min(left_fused_span, right_fused_span) on ALL fused bins; production pairs only within supported runs with >=4m overlap and >=3 valid resampled samples'
      : 'Coverage metrics aligned',
  };

  return {
    context,
    stages,
    reconciliation,
    polygons,
    rejectionLog,
    resample,
    leftResult,
    rightResult,
    pairedRuns,
    trajectory,
  };
}

function findBinGaps(pts, fusionIntervalM, maxSpan) {
  const gaps = [];
  for (let i = 1; i < pts.length; i++) {
    const spacing = pts[i].binKey != null && pts[i - 1].binKey != null
      ? (pts[i].binKey - pts[i - 1].binKey) * fusionIntervalM
      : pts[i].s - pts[i - 1].s;
    if (spacing > maxSpan) {
      gaps.push({ afterIndex: i - 1, gapM: spacing, sAt: pts[i - 1].s });
    }
  }
  return gaps;
}

function summarizeRejections(rejectionLog) {
  const acc = {};
  for (const r of rejectionLog) {
    for (const reason of r.reasons || []) acc[reason] = (acc[reason] || 0) + 1;
  }
  return acc;
}

function inspectRejectedPolygon(interval, trajectory, options, rejectionEntry) {
  const left = interval.map((smp) => ({ ...sToMap(trajectory, smp.s, smp.dL), s: smp.s, d: smp.dL, width: smp.width }));
  const right = interval.map((smp) => ({ ...sToMap(trajectory, smp.s, smp.dR), s: smp.s, d: smp.dR, width: smp.width }));
  const ring = [...left, ...[...right].reverse()];
  const check = validateRoadPolygon(left, right, options);

  const intersections = [];
  for (let i = 0; i < ring.length - 1; i++) {
    for (let j = i + 2; j < ring.length - 1; j++) {
      if (i === 0 && j === ring.length - 2) continue;
      if (segmentsIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])) {
        intersections.push({
          edgeA: { from: i, to: i + 1, s: ring[i].s },
          edgeB: { from: j, to: j + 1, s: ring[j].s },
          crossesLegs: (i < ring.length / 2) !== (j < ring.length / 2),
        });
      }
    }
  }

  const monotonicLeft = left.every((p, i) => i === 0 || p.s >= left[i - 1].s - 1e-6);
  const monotonicRight = right.every((p, i) => i === 0 || p.s >= right[i - 1].s - 1e-6);

  return {
    fragmentIndex: rejectionEntry?.fragmentIndex,
    reasons: rejectionEntry?.reasons,
    sampleCount: interval.length,
    orderedLeftPoints: left.map((p, i) => ({
      index: i, s: p.s, d: p.d, east: p.east, north: p.north, widthAtSample: interval[i].width,
    })),
    orderedRightPoints: right.map((p, i) => ({
      index: i, s: p.s, d: p.d, east: p.east, north: p.north,
    })),
    ringConstructionOrder: 'left_forward_then_right_reverse',
    ringVertexOrder: ring.map((p, i) => ({ index: i, s: p.s, leg: i < left.length ? 'left' : 'right' })),
    laneWidthsAtSamples: interval.map((s) => ({ s: s.s, width: s.width, dL: s.dL, dR: s.dR })),
    boundaryDirection: { leftMonotonicS: monotonicLeft, rightMonotonicS: monotonicRight },
    intersectingEdgePairs: intersections,
    selfIntersectionCount: countSelfIntersections(ring),
    validationStats: check.stats,
    verdict: intersections.some((x) => x.crossesLegs)
      ? 'likely_sparse_tight_curve_construction_ambiguity_correctly_rejected'
      : intersections.length
        ? 'within_leg_noise_or_invalid_evidence'
        : 'no_intersection_detected',
  };
}

function traceSegment(segmentId, opts = DEFAULT_OPTS) {
  const filename = `qlog_f449c_${segmentId}.bz2`;
  const loaded = loadSegmentsData(process.cwd(), [filename], opts);
  const quals = qualifySegments(loaded.audits);
  const procOpts = { ...opts, segmentQualifications: quals, fileAudits: loaded.audits };
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, procOpts);
  const chunk = result.routeChunks[0];
  const chunkFiles = chunk?.files || [filename];
  const frames = (chunk?.frames || result.frames).filter((f) => chunkFiles.includes(f.sourceFile));
  const vehiclePath = chunk?.vehiclePath || result.vehiclePath;

  const { passes } = detectPasses(vehiclePath, procOpts);
  const assignedFrames = assignFramesToPasses(frames, passes);
  const pathWithPassIds = passes.flatMap((p) => p.points.map((pt) => ({ ...pt, passId: p.passId })));
  const poseResult = assignPoseSections(pathWithPassIds, procOpts);
  const framesWithPose = applyPoseSectionsToFrames(assignedFrames, poseResult.annotatedPoints);

  const sectionTraces = [];
  for (const pass of passes) {
    const passFrames = framesWithPose.filter((f) => f.passId === pass.passId);
    const sectionIds = [...new Set(passFrames.map((f) => f.poseSectionId ?? 0))];
    for (const poseSectionId of sectionIds) {
      const sectionFrames = passFrames.filter((f) => (f.poseSectionId ?? 0) === poseSectionId);
      const sectionPath = poseResult.annotatedPoints.filter(
        (p) => p.passId === pass.passId && p.poseSectionId === poseSectionId
      );
      const passPath = sectionPath.length ? sectionPath : pass.points;
      sectionTraces.push(traceSectionFusion(sectionFrames, passPath, procOpts, {
        segmentId,
        passId: pass.passId,
        poseSectionId,
      }));
    }
  }

  const productionPolygonCount = chunk?.roadSurfacePolygons?.length ?? 0;
  const primary = sectionTraces[0];

  let segment65Inspection = null;
  if (segmentId === 65 && primary?.rejectionLog?.length) {
    const rej = primary.rejectionLog[0];
    const interval = primary.resample.intervals[rej.fragmentIndex];
    if (interval) {
      segment65Inspection = inspectRejectedPolygon(interval, primary.trajectory, procOpts, rej);
    }
  }

  return {
    segmentId,
    productionPolygonCount,
    temporalPassCount: passes.length,
    poseSectionCount: sectionTraces.length,
    sectionTraces,
    primaryReconciliation: primary?.reconciliation,
    segment65Inspection,
    datasetWideDefectSuspected: detectDatasetWideDefects(sectionTraces, segmentId),
  };
}

function detectDatasetWideDefects(sectionTraces, segmentId) {
  const suspects = [];
  for (const st of sectionTraces) {
    const pairStage = st.stages.find((s) => s.name === 'left_right_run_pairing');
    const runStage = st.stages.find((s) => s.name === 'supported_run_splitting');
    if (!pairStage || !runStage) continue;

    for (const pr of pairStage.pairedRunOverlaps || []) {
      if (pr.leftSRange[0] > pr.rightSRange[1] || pr.rightSRange[0] > pr.leftSRange[1]) {
        suspects.push({ type: 'non_overlapping_run_ranges_paired', segmentId, ...pr });
      }
      if (pr.overlapStart > pr.overlapEnd) {
        suspects.push({ type: 'reversed_overlap_endpoints', segmentId, ...pr });
      }
    }

    for (const side of ['left', 'right']) {
      for (const run of runStage.supportedRuns?.[side] || []) {
        if (run.monotonicS === false) suspects.push({ type: 'non_monotonic_s', side, run });
      }
    }
  }
  return suspects;
}

module.exports = {
  NEGATIVE_CONTROLS,
  traceSegment,
  traceSectionFusion,
  inspectRejectedPolygon,
  detectDatasetWideDefects,
};
