#!/usr/bin/env node
/**
 * Dataset-wide upstream audit — pass counts, pose/trajectory suspicious indicators.
 * Usage: node dataset_audit.js [--segments 2,6,54] [--all] [--out audit_dataset.json]
 */
const fs = require('fs');
const path = require('path');
const { loadSegmentsData } = require('./lib/qlog_data');
const { qualifySegments } = require('./lib/segment_qualify');
const { processRoute } = require('./lib/process_route');
const { PROCESSING_VERSION, MOVEMENT_ONLY_VERSION } = require('./lib/version');
const { dist2d, timeGapSec } = require('./lib/chunking');
const { configHash } = require('./lib/qlog_audit');
const { annotatePathWithMovement } = require('./lib/movement_state');

const ROOT = __dirname;
const DEFAULT_OPTS = {
  minLaneProb: 0.5,
  maxAccuracyM: 50,
  maxModelGpsDeltaNs: 2e9,
  maxForwardM: 120,
  fusionIntervalM: 2,
  minSpeedForGpsBearing: 2,
  maxTimeGapSec: 3,
  maxGpsGapM: 30,
  maxImpliedSpeedMps: 55,
  maxLaneFragmentGapM: 10,
  maxRoadEdgeGapM: 10,
  pipelineMode: 'C',
  laneTrackingEnabled: true,
  localSupportFilter: true,
};

function parseArgs() {
  const args = process.argv.slice(2);
  let segments = null;
  let all = false;
  let out = path.join(ROOT, 'audit_dataset.json');
  let movementOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all') all = true;
    else if (args[i] === '--movement-only') movementOnly = true;
    else if (args[i] === '--segments' && args[i + 1]) {
      segments = args[++i].split(',').map((n) => `qlog_f449c_${n.trim()}.bz2`);
    } else if (args[i] === '--out' && args[i + 1]) out = args[++i];
  }
  if (!segments && !all) {
    segments = [2, 6, 54, 58, 99].map((n) => `qlog_f449c_${n}.bz2`);
  }
  if (all) {
    segments = fs.readdirSync(ROOT)
      .filter((f) => /^qlog_f449c.*\.bz2$/i.test(f))
      .sort((a, b) => parseInt(a.match(/_(\d+)/)[1]) - parseInt(b.match(/_(\d+)/)[1]));
  }
  return { segments, out, movementOnly };
}

function trajectoryMetrics(vehiclePath) {
  const flags = [];
  let maxImpliedSpeed = 0;
  let maxStep = 0;
  let maxHeadingDelta = 0;
  let lowSpeedReversals = 0;
  let stationaryDriftM = 0;
  let stationaryPoints = 0;

  for (let i = 1; i < vehiclePath.length; i++) {
    const prev = vehiclePath[i - 1];
    const cur = vehiclePath[i];
    const step = dist2d(prev, cur);
    const dt = Math.max(timeGapSec(prev, cur), 0.001);
    const implied = step / dt;
    maxImpliedSpeed = Math.max(maxImpliedSpeed, implied);
    maxStep = Math.max(maxStep, step);

    const speed = cur.speed ?? prev.speed ?? 0;
    if (speed < 2 && step < 5) {
      stationaryDriftM += step;
      stationaryPoints++;
    }

    const h0 = prev.headingDeg ?? 0;
    const h1 = cur.headingDeg ?? 0;
    let hd = Math.abs(h1 - h0);
    if (hd > 180) hd = 360 - hd;
    maxHeadingDelta = Math.max(maxHeadingDelta, hd);
    if (speed < 2 && step < 1 && hd > 30) lowSpeedReversals++;
  }

  if (maxImpliedSpeed > DEFAULT_OPTS.maxImpliedSpeedMps) flags.push('highImpliedSpeed');
  if (maxStep > 50) flags.push('largePositionJump');
  if (lowSpeedReversals > 0) flags.push('lowSpeedHeadingNoise');
  if (stationaryDriftM > 15) flags.push('stationaryGpsDrift');

  return {
    pointCount: vehiclePath.length,
    maxImpliedSpeedMps: maxImpliedSpeed,
    maxStepM: maxStep,
    maxHeadingDeltaDeg: maxHeadingDelta,
    lowSpeedHeadingNoiseCount: lowSpeedReversals,
    stationaryDriftM,
    stationaryPointCount: stationaryPoints,
    flags,
  };
}

function movementMetrics(vehiclePath) {
  const annotated = annotatePathWithMovement(vehiclePath || []);
  const counts = { moving: 0, stationary: 0, creeping: 0, uncertain: 0 };
  let stationaryCoverageM = 0;
  let movingCoverageM = 0;
  for (let i = 1; i < annotated.length; i++) {
    const step = dist2d(annotated[i - 1], annotated[i]);
    const st = annotated[i].movementState || 'uncertain';
    counts[st] = (counts[st] || 0) + 1;
    if (st === 'stationary' || st === 'uncertain') stationaryCoverageM += step;
    if (st === 'moving') movingCoverageM += step;
  }
  return { counts, stationaryCoverageM, movingCoverageM, annotatedPointCount: annotated.length };
}

function auditSegment(filename, auditOpts = {}) {
  const t0 = Date.now();
  const movementOnly = auditOpts.movementOnly === true;
  const procOpts = {
    ...DEFAULT_OPTS,
    poseContinuityEnabled: !movementOnly,
    ...auditOpts,
  };
  const version = movementOnly ? MOVEMENT_ONLY_VERSION : PROCESSING_VERSION;
  const loaded = loadSegmentsData(ROOT, [filename], procOpts);
  const quals = qualifySegments(loaded.audits);
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
    ...procOpts,
    segmentQualifications: quals,
    fileAudits: loaded.audits,
  });
  const elapsedMs = Date.now() - t0;
  const segNum = parseInt(filename.match(/_(\d+)/)[1], 10);
  const chunk = result.routeChunks[0];
  const passDiag = chunk?.passDiagnostics || {};
  const splitEvents = passDiag.splitEvents || [];
  const traj = trajectoryMetrics(result.vehiclePath || []);
  const movement = movementMetrics(result.vehiclePath || []);
  const suppressedReversalCount = passDiag.suppressedReversalCount ?? 0;
  const poseSectionCount = passDiag.poseSectionCount ?? 1;
  const rejectedPoseTransitions = passDiag.rejectedPoseTransitions ?? 0;
  const firstPoseRejection = passDiag.firstPoseRejection ?? null;
  const hiddenConnectorLengthM = passDiag.hiddenConnectorLengthM ?? 0;

  const severity = [];
  if ((passDiag.passCount ?? chunk?.passCoverage?.length ?? 0) > 1) severity.push('multiPass');
  if (passDiag.suspiciousLoop) severity.push('suspiciousLoop');
  if (traj.flags.includes('lowSpeedHeadingNoise')) severity.push('stationaryHeadingNoise');
  if (traj.flags.includes('stationaryGpsDrift')) severity.push('stationaryDrift');
  if ((chunk?.roadSurfacePolygons?.length ?? 0) === 0) severity.push('zeroPolygons');

  return {
    segmentId: segNum,
    filename,
    processingVersion: version,
    configHash: configHash(DEFAULT_OPTS),
    fileSha256: loaded.audits[0]?.sha256,
    modelV2Count: loaded.audits[0]?.modelV2Count,
    durationSec: loaded.audits[0]?.durationSec,
    qualification: quals[0],
    processingMs: elapsedMs,
    mode: result.mode,
    temporalPassCount: passDiag.passCount ?? chunk?.passCoverage?.length ?? 0,
    poseSectionCount,
    rejectedPoseTransitions,
    hiddenConnectorLengthM,
    firstPoseRejection,
    splitEvents: splitEvents.map((e) => ({
      passId: e.passId,
      reason: e.reason,
      frameId: e.frameId,
      logMonoTime: e.logMonoTime,
      dot: e.dot,
      headingDelta: e.headingDelta,
    })),
    frameCounts: result.stats.frameCounts,
    polygonCount: chunk?.roadSurfacePolygons?.length ?? 0,
    fusedLaneCount: chunk?.fusedLaneLines?.length ?? 0,
    laneTrackCount: chunk?.laneTracks?.length ?? 0,
    suppressedReversalCount,
    suppressedSplitEvents: (passDiag.suppressedSplitEvents || []).map((e) => ({
      reason: e.reason,
      wouldBeReason: e.wouldBeReason,
      frameId: e.frameId,
      movementState: e.movementState,
      dot: e.dot,
      step: e.step,
    })),
    movementStates: movement.counts,
    stationaryTrajectoryCoverageM: movement.stationaryCoverageM,
    movingTrajectoryCoverageM: movement.movingCoverageM,
    trajectory: traj,
    severityFlags: severity,
    poseSource: loaded.poseSourceReports?.[0]?.pipelinePoseSource,
  };
}

function main() {
  const { segments, out, movementOnly } = parseArgs();
  const version = movementOnly ? MOVEMENT_ONLY_VERSION : PROCESSING_VERSION;
  console.log(`Auditing ${segments.length} segment(s), version ${version}${movementOnly ? ' (movement-only)' : ''}`);
  const results = [];
  for (const f of segments) {
    if (!fs.existsSync(path.join(ROOT, f))) {
      console.warn('Missing', f);
      continue;
    }
    process.stdout.write(`  ${f}...`);
    try {
      const r = auditSegment(f, { movementOnly });
      results.push(r);
      console.log(` passes=${r.temporalPassCount} poly=${r.polygonCount} flags=${r.severityFlags.join(',')||'none'} ${r.processingMs}ms`);
    } catch (err) {
      console.log(' ERROR', err.message);
      results.push({ filename: f, error: err.message });
    }
  }

  const flagged = results
    .filter((r) => r.severityFlags?.length)
    .sort((a, b) => b.severityFlags.length - a.severityFlags.length);

  const summary = {
    auditedAt: new Date().toISOString(),
    processingVersion: version,
    movementOnly,
    configHash: configHash(DEFAULT_OPTS),
    segmentCount: results.length,
    flaggedCount: flagged.length,
    multiPassCount: results.filter((r) => r.temporalPassCount > 1).length,
    zeroPolygonCount: results.filter((r) => r.polygonCount === 0).length,
    medianProcessingMs: median(results.map((r) => r.processingMs).filter(Boolean)),
    totalSuppressedReversals: results.reduce((n, r) => n + (r.suppressedReversalCount ?? 0), 0),
    aggregateMovementStates: results.reduce((acc, r) => {
      for (const [k, v] of Object.entries(r.movementStates || {})) acc[k] = (acc[k] || 0) + v;
      return acc;
    }, {}),
    results,
    flaggedRanked: flagged.map((r) => ({
      segmentId: r.segmentId,
      severityFlags: r.severityFlags,
      temporalPassCount: r.temporalPassCount,
      polygonCount: r.polygonCount,
      splitReasons: [...new Set((r.splitEvents || []).map((e) => e.reason))],
    })),
  };

  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${out}`);
  console.log(`Flagged: ${flagged.length}/${results.length}, multi-pass: ${summary.multiPassCount}, zero-polygon: ${summary.zeroPolygonCount}`);
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

if (require.main === module) main();
module.exports = { auditSegment, trajectoryMetrics, DEFAULT_OPTS };
