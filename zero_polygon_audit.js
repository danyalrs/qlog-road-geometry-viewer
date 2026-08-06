#!/usr/bin/env node
/**
 * Classify zero-polygon segments by upstream cause (pose vs fusion vs validation).
 * Stage 10 investigation — does not change processing thresholds.
 *
 * Usage:
 *   node zero_polygon_audit.js --all --out audit_zero_polygon_v10.json
 *   node zero_polygon_audit.js --segments 58,99,5
 */
const fs = require('fs');
const path = require('path');
const { loadSegmentsData } = require('./lib/qlog_data');
const { processRoute } = require('./lib/process_route');
const { qualifySegments } = require('./lib/segment_qualify');
const { PROCESSING_VERSION } = require('./lib/version');

const ROOT = __dirname;
const DEFAULT_OPTS = {
  minLaneProb: 0.5,
  maxAccuracyM: 50,
  maxModelGpsDeltaNs: 2e9,
  maxForwardM: 120,
  fusionIntervalM: 2,
  minSpeedForGpsBearing: 2,
  pipelineMode: 'C',
  laneTrackingEnabled: true,
  localSupportFilter: true,
};

function parseArgs() {
  const args = process.argv.slice(2);
  let segments = null;
  let out = path.join(ROOT, 'audit_zero_polygon_v10.json');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all') {
      segments = fs.readdirSync(ROOT)
        .filter((f) => /^qlog_f449c.*\.bz2$/i.test(f))
        .sort((a, b) => parseInt(a.match(/_(\d+)/)[1]) - parseInt(b.match(/_(\d+)/)[1]));
    } else if (args[i] === '--segments' && args[i + 1]) {
      segments = args[++i].split(',').map((n) => `qlog_f449c_${n.trim()}.bz2`);
    } else if (args[i] === '--out' && args[i + 1]) out = args[++i];
  }
  if (!segments) segments = [58, 99, 5].map((n) => `qlog_f449c_${n}.bz2`);
  return { segments, out };
}

function classifyCause(metrics) {
  if (metrics.fusionSkipped) return 'fusion_skipped';
  if (metrics.poseSectionCount > 1 && metrics.rejectedPoseTransitions > 0) {
    return 'pose_section_fragmentation';
  }
  if (metrics.temporalPassCount > 1) return 'multi_pass_geometry_split';
  if (metrics.inputEdgeObservationCount === 0) return 'no_edge_observations';
  if (metrics.pairedCoverageM < 20) return 'insufficient_paired_coverage';
  if (metrics.rejectedPolygonCount > 0 && metrics.acceptedPolygonCount === 0) {
    return `polygon_validation_rejected:${metrics.rejectionReasons.join('+') || 'unknown'}`;
  }
  if (metrics.fusedLeftPointCount < 2 || metrics.fusedRightPointCount < 2) {
    return 'insufficient_boundary_fusion';
  }
  return 'other';
}

function auditSegment(filename) {
  const segNum = parseInt(filename.match(/_(\d+)/)[1], 10);
  const loaded = loadSegmentsData(ROOT, [filename], DEFAULT_OPTS);
  const quals = qualifySegments(loaded.audits);
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
    ...DEFAULT_OPTS,
    segmentQualifications: quals,
    fileAudits: loaded.audits,
  });
  const chunk = result.routeChunks[0];
  const passDiag = chunk?.passDiagnostics || {};
  const passCov = (chunk?.passCoverage || [])[0] || {};
  const sd = chunk?.sdDiagnostics || {};
  const rejections = chunk?.polygonRejections || [];

  const metrics = {
    segmentId: segNum,
    filename,
    polygonCount: chunk?.roadSurfacePolygons?.length ?? 0,
    temporalPassCount: passDiag.passCount ?? 1,
    poseSectionCount: passDiag.poseSectionCount ?? 1,
    rejectedPoseTransitions: passDiag.rejectedPoseTransitions ?? 0,
    fusionSkipped: chunk?.fusionSkipped ?? false,
    inputEdgeObservationCount: sd.inputEdgeObservationCount ?? 0,
    rejectedEdgeObservationCount: sd.rejectedEdgeObservationCount ?? 0,
    fusedLeftPointCount: sd.fusedLeftPointCount ?? 0,
    fusedRightPointCount: sd.fusedRightPointCount ?? 0,
    pairedCoverageM: passCov.pairedCoverageM ?? 0,
    pathLengthM: passCov.pathLengthM ?? 0,
    acceptedPolygonCount: passCov.acceptedPolygonCount ?? 0,
    rejectedPolygonCount: passCov.rejectedPolygonCount ?? 0,
    rejectionReasons: passCov.rejectionReasons ?? [],
    suppressedReversalCount: passDiag.suppressedReversalCount ?? 0,
    fusedLaneCount: chunk?.fusedLaneLines?.length ?? 0,
  };

  if (metrics.polygonCount > 0) return null;

  return {
    ...metrics,
    classifiedCause: classifyCause(metrics),
    rejectionDetails: rejections.map((r) => ({
      reasons: r.reasons,
      stats: r.stats ? {
        length: r.stats.length,
        area: r.stats.area,
        medianWidth: r.stats.medianWidth,
        intersections: r.stats.intersections,
        maxVertexJump: r.stats.maxVertexJump,
      } : null,
    })),
    stage10Bucket: metrics.poseSectionCount === 1 && metrics.rejectedPoseTransitions === 0
      ? 'lane_polygon_candidate'
      : 'pose_or_multipass',
  };
}

function main() {
  const { segments, out } = parseArgs();
  const results = [];
  for (const f of segments) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    process.stdout.write(`  ${f}...`);
    const r = auditSegment(f);
    if (r) {
      results.push(r);
      console.log(` ${r.classifiedCause}`);
    } else {
      console.log(' has polygons (skipped)');
    }
  }

  const byCause = results.reduce((acc, r) => {
    acc[r.classifiedCause] = (acc[r.classifiedCause] || 0) + 1;
    return acc;
  }, {});
  const byBucket = results.reduce((acc, r) => {
    acc[r.stage10Bucket] = (acc[r.stage10Bucket] || 0) + 1;
    return acc;
  }, {});

  const summary = {
    auditedAt: new Date().toISOString(),
    processingVersion: PROCESSING_VERSION,
    zeroPolygonCount: results.length,
    byCause,
    byStage10Bucket: byBucket,
    lanePolygonCandidates: results
      .filter((r) => r.stage10Bucket === 'lane_polygon_candidate')
      .map((r) => r.segmentId)
      .sort((a, b) => a - b),
    poseOrMultipass: results
      .filter((r) => r.stage10Bucket === 'pose_or_multipass')
      .map((r) => r.segmentId)
      .sort((a, b) => a - b),
    results: results.sort((a, b) => a.segmentId - b.segmentId),
  };

  fs.writeFileSync(path.join(ROOT, out), JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${out}`);
  console.log(`Zero-polygon: ${summary.zeroPolygonCount}, lane candidates: ${summary.lanePolygonCandidates.length}, pose/multipass: ${summary.poseOrMultipass.length}`);
}

if (require.main === module) main();
