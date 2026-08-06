#!/usr/bin/env node
/**
 * Post-change Stage 10 candidate audit — reports per-segment fusion/polygon metrics.
 */
const fs = require('fs');
const path = require('path');
const { loadSegmentsData } = require('./lib/qlog_data');
const { processRoute } = require('./lib/process_route');
const { qualifySegments } = require('./lib/segment_qualify');
const { PROCESSING_VERSION } = require('./lib/version');
const { STAGE10_CANDIDATES } = require('./lib/stage10_diagnostics');
const {
  collectEdgeObservations,
  fuseSideBoundary,
  resampleBoundaries,
  buildPolygonsFromIntervals,
  splitSupportedRuns,
  resolveMaxInterpolationSpanM,
} = require('./lib/sd_fusion');
const { buildReferenceTrajectory } = require('./lib/trajectory');
const { detectPasses, assignFramesToPasses } = require('./lib/passes');
const { trackLanesAndEdgesInPass } = require('./lib/lane_tracking');
const { assignPoseSections, applyPoseSectionsToFrames } = require('./lib/pose_continuity');
const { countSelfIntersections, maxConsecutiveVertexJump } = require('./lib/geometry_sanity');

const ROOT = __dirname;
const DEFAULT_OPTS = {
  minLaneProb: 0.5,
  maxAccuracyM: 50,
  maxModelGpsDeltaNs: 2e9,
  maxForwardM: 120,
  fusionIntervalM: 2,
  pipelineMode: 'C',
  laneTrackingEnabled: true,
  localSupportFilter: true,
};

function auditCandidate(segNum) {
  const filename = `qlog_f449c_${segNum}.bz2`;
  const loaded = loadSegmentsData(ROOT, [filename], DEFAULT_OPTS);
  const quals = qualifySegments(loaded.audits);
  const opts = { ...DEFAULT_OPTS, segmentQualifications: quals, fileAudits: loaded.audits };
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, opts);
  const chunk = result.routeChunks[0];
  const chunkFiles = chunk?.files || [filename];
  const frames = result.frames.filter((f) => chunkFiles.includes(f.sourceFile));
  const vehiclePath = chunk?.vehiclePath || result.vehiclePath;

  const { passes } = detectPasses(vehiclePath, opts);
  const assignedFrames = assignFramesToPasses(frames, passes);
  const pathWithPassIds = passes.flatMap((p) => p.points.map((pt) => ({ ...pt, passId: p.passId })));
  const poseResult = assignPoseSections(pathWithPassIds, opts);
  const framesWithPose = applyPoseSectionsToFrames(assignedFrames, poseResult.annotatedPoints);

  const pass = passes[0];
  const sectionFrames = framesWithPose.filter((f) => f.passId === pass.passId && (f.poseSectionId ?? 0) === 0);
  const tracked = trackLanesAndEdgesInPass(sectionFrames, opts);
  const sectionPath = poseResult.annotatedPoints.filter((p) => p.passId === pass.passId && p.poseSectionId === 0);
  const passPath = sectionPath.length ? sectionPath : pass.points;

  const trajectory = buildReferenceTrajectory(passPath);
  const { observations: edgeObs } = collectEdgeObservations(tracked.frames, trajectory, opts);
  const leftResult = fuseSideBoundary(edgeObs, 'left', opts);
  const rightResult = fuseSideBoundary(edgeObs, 'right', opts);
  const maxSpan = resolveMaxInterpolationSpanM(opts);

  const leftRuns = splitSupportedRuns(leftResult.fusedPoints, maxSpan);
  const rightRuns = splitSupportedRuns(rightResult.fusedPoints, maxSpan);
  const resample = resampleBoundaries(leftResult.fragments, rightResult.fragments, trajectory, opts);
  const built = buildPolygonsFromIntervals(resample.intervals, trajectory, opts);

  const accepted = built.polygons.map((p) => ({
    fragmentIndex: p.fragmentIndex,
    sRange: p.stats?.sRange,
    coverageM: p.stats?.sRange ? p.stats.sRange[1] - p.stats.sRange[0] : 0,
    selfIntersections: countSelfIntersections(p.ring),
    maxVertexJumpM: maxConsecutiveVertexJump(p.ring),
    widthMedian: p.stats?.medianWidth,
    widthMin: p.stats?.minWidth,
    widthMax: p.stats?.maxWidth,
  }));

  const rejected = built.rejectionLog.map((r) => ({
    fragmentIndex: r.fragmentIndex,
    reasons: r.reasons,
    selfIntersections: r.stats?.intersections ?? 0,
    maxVertexJumpM: r.stats?.maxVertexJump ?? 0,
    widthMedian: r.stats?.medianWidth,
  }));

  const pairedOverlaps = (resample.pairedRuns || []).map((p) => ({
    overlapM: p.overlapM,
    overlapStart: p.overlapStart,
    overlapEnd: p.overlapEnd,
  }));

  const fullSpanBefore = Math.min(
    leftResult.fusedPoints.length ? leftResult.fusedPoints[leftResult.fusedPoints.length - 1].s - leftResult.fusedPoints[0].s : 0,
    rightResult.fusedPoints.length ? rightResult.fusedPoints[rightResult.fusedPoints.length - 1].s - rightResult.fusedPoints[0].s : 0
  );
  const spanAfter = accepted.reduce((s, p) => s + p.coverageM, 0);

  const maxAcceptedVertexJumpM = accepted.length
    ? Math.max(...accepted.map((p) => p.maxVertexJumpM))
    : 0;
  const maxRejectedVertexJumpM = rejected.length
    ? Math.max(...rejected.map((p) => p.maxVertexJumpM))
    : 0;

  return {
    segmentId: segNum,
    temporalPassId: pass.passId,
    poseSectionId: 0,
    leftObservations: edgeObs.filter((o) => o.side === 'left').length,
    rightObservations: edgeObs.filter((o) => o.side === 'right').length,
    supportedRunCount: { left: leftRuns.length, right: rightRuns.length },
    pairedRunOverlaps: pairedOverlaps,
    polygonsProduced: accepted.length,
    polygonRejections: rejected.length,
    acceptedPolygons: accepted,
    rejectedPolygons: rejected,
    maxAcceptedVertexJumpM,
    maxRejectedVertexJumpM,
    unsupportedSpanRemovedM: Math.max(0, fullSpanBefore - spanAfter),
    finalOutcome: accepted.length > 0
      ? `accepted:${accepted.length}`
      : rejected.length > 0
        ? `rejected:${rejected[0].reasons.join('+')}`
        : resample.rejected?.join('+') || 'no_polygon',
    chunkPolygonCount: chunk?.roadSurfacePolygons?.length ?? 0,
  };
}

function main() {
  const out = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : 'audit_stage10_candidates_v11.json';

  const results = STAGE10_CANDIDATES.map((seg) => {
    process.stdout.write(`  seg ${seg}...`);
    try {
      const r = auditCandidate(seg);
      console.log(` ${r.finalOutcome} poly=${r.chunkPolygonCount}`);
      return r;
    } catch (e) {
      console.log(` ERROR ${e.message}`);
      return { segmentId: seg, error: e.message };
    }
  });

  const output = {
    auditedAt: new Date().toISOString(),
    processingVersion: PROCESSING_VERSION,
    maxInterpolationSpanM: DEFAULT_OPTS.fusionIntervalM * 2,
    results,
    recovered: results.filter((r) => r.chunkPolygonCount > 0).map((r) => r.segmentId),
    stillZero: results.filter((r) => !r.error && r.chunkPolygonCount === 0).map((r) => r.segmentId),
  };

  fs.writeFileSync(path.join(ROOT, out), JSON.stringify(output, null, 2));
  console.log(`\nWrote ${out}`);
  console.log(`Recovered: ${output.recovered.length}/12 — [${output.recovered.join(', ')}]`);
  console.log(`Still zero: ${output.stillZero.length} — [${output.stillZero.join(', ')}]`);
}

if (require.main === module) main();
