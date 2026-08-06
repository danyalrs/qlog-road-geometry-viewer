#!/usr/bin/env node
/**
 * Measure rejected pose transitions with displacement, timing, movement state,
 * heading continuity, neighbour steps and section lengths.
 *
 * Usage:
 *   node pose_rejection_audit.js --affected17
 *   node pose_rejection_audit.js --segments 0,14,25
 *   node pose_rejection_audit.js --all
 */
const fs = require('fs');
const path = require('path');
const { loadSegmentsData } = require('./lib/qlog_data');
const { processRoute } = require('./lib/process_route');
const { qualifySegments } = require('./lib/segment_qualify');
const {
  assignPoseSections,
  classifyRejectionTransition,
} = require('./lib/pose_continuity');
const { annotatePathWithMovement } = require('./lib/movement_state');

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

const AFFECTED_17 = [0, 14, 15, 16, 17, 18, 25, 29, 30, 31, 32, 35, 37, 49, 88, 89, 90];

function parseArgs() {
  const args = process.argv.slice(2);
  let segments = null;
  let out = path.join(ROOT, 'audit_pose_rejection.json');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--affected17') segments = AFFECTED_17.map((n) => `qlog_f449c_${n}.bz2`);
    else if (args[i] === '--all') {
      segments = fs.readdirSync(ROOT)
        .filter((f) => /^qlog_f449c.*\.bz2$/i.test(f))
        .sort((a, b) => parseInt(a.match(/_(\d+)/)[1]) - parseInt(b.match(/_(\d+)/)[1]));
    } else if (args[i] === '--segments' && args[i + 1]) {
      segments = args[++i].split(',').map((n) => `qlog_f449c_${n.trim()}.bz2`);
    } else if (args[i] === '--out' && args[i + 1]) out = args[++i];
  }
  if (!segments) segments = AFFECTED_17.map((n) => `qlog_f449c_${n}.bz2`);
  return { segments, out };
}

function auditSegmentPose(filename) {
  const loaded = loadSegmentsData(ROOT, [filename], DEFAULT_OPTS);
  const quals = qualifySegments(loaded.audits);
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
    ...DEFAULT_OPTS,
    segmentQualifications: quals,
    fileAudits: loaded.audits,
  });
  const segNum = parseInt(filename.match(/_(\d+)/)[1], 10);
  const chunk = result.routeChunks[0];
  const path = annotatePathWithMovement(result.vehiclePath || []);
  const pose = assignPoseSections(path, {});
  const sectionById = new Map(pose.sections.map((s) => [s.poseSectionId, s]));

  const rejections = pose.rejectedTransitions.map((t) => {
    const section = sectionById.get(path[t.index]?.poseSectionId);
    return {
      index: t.index,
      reason: t.reason,
      classification: classifyRejectionTransition(t),
      displacementM: t.step,
      elapsedSec: t.dt,
      impliedSpeedMps: t.impliedSpeed,
      reportedSpeedMps: t.reportedSpeed,
      maxAllowedStepM: t.maxAllowedStepM,
      movementState: t.movementState,
      headingContinuityDeg: t.headingContinuityDeg,
      headingDeltaDeg: t.headingDelta,
      motionDisagreementDeg: t.motionDisagreement,
      disagreementLimitDeg: t.disagreementLimitDeg,
      gpsSamplingIntervalSec: t.gpsSamplingIntervalSec,
      neighborPrevStepM: t.neighborPrevStepM,
      neighborPrevImpliedSpeedMps: t.neighborPrevImpliedSpeedMps,
      resultingSectionPointCount: section?.pointCount ?? null,
      fromFrameId: t.fromFrameId,
      toFrameId: t.toFrameId,
    };
  });

  const falseSparse = rejections.filter((r) => r.classification.startsWith('false_'));
  const genuine = rejections.filter((r) => r.classification === 'genuine_localization_failure');

  return {
    segmentId: segNum,
    filename,
    polygonCount: chunk?.roadSurfacePolygons?.length ?? 0,
    temporalPassCount: chunk?.passDiagnostics?.passCount ?? 1,
    poseSectionCount: pose.poseSectionCount,
    rejectedPoseTransitions: rejections.length,
    hiddenConnectorLengthM: chunk?.passDiagnostics?.hiddenConnectorLengthM ?? null,
    falseSparseRejectionCount: falseSparse.length,
    genuineRejectionCount: genuine.length,
    rejections,
    sections: pose.sections,
  };
}

function main() {
  const { segments, out } = parseArgs();
  const results = [];
  for (const f of segments) {
    if (!fs.existsSync(path.join(ROOT, f))) {
      console.warn('Missing', f);
      continue;
    }
    process.stdout.write(`  ${f}...`);
    try {
      const r = auditSegmentPose(f);
      results.push(r);
      console.log(` sections=${r.poseSectionCount} rejected=${r.rejectedPoseTransitions} poly=${r.polygonCount}`);
    } catch (err) {
      console.log(' ERROR', err.message);
      results.push({ filename: f, error: err.message });
    }
  }

  const summary = {
    auditedAt: new Date().toISOString(),
    segmentCount: results.length,
    totalRejections: results.reduce((n, r) => n + (r.rejectedPoseTransitions ?? 0), 0),
    falseSparseRejectionCount: results.reduce((n, r) => n + (r.falseSparseRejectionCount ?? 0), 0),
    genuineRejectionCount: results.reduce((n, r) => n + (r.genuineRejectionCount ?? 0), 0),
    recoveredPolygonSegments: results.filter((r) => (r.polygonCount ?? 0) > 0
      && AFFECTED_17.includes(r.segmentId)).map((r) => r.segmentId),
    stillZeroPolygonAffected: results.filter((r) => (r.polygonCount ?? 0) === 0
      && AFFECTED_17.includes(r.segmentId)).map((r) => r.segmentId),
    results,
  };

  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${out}`);
  console.log(`Rejections: ${summary.totalRejections} (false-sparse ${summary.falseSparseRejectionCount}, genuine ${summary.genuineRejectionCount})`);
}

if (require.main === module) main();
module.exports = { auditSegmentPose, AFFECTED_17 };
