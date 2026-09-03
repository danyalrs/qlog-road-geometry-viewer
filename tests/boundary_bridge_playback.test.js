'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const BBP = require('../lib/boundary_bridge_playback');
const VMB = require('../lib/viewer_map_build');
const SLM = require('../lib/segment_local_map');
const CBAO = require('../lib/combined_boundary_anchored_orientation');
const CRB = require('../lib/combined_route_boundary_bridge');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const ROOT = path.join(__dirname, '..');

function processSelection(segments) {
  const files = segments.map((s) => `qlog_f449c_${s}.bz2`);
  const loaded = require('../lib/qlog_data').loadSegmentsData(ROOT, files, VMB.VIEWER_DEFAULT_PROCESS_OPTIONS);
  const { processRoute, buildTimeline } = require('../lib/process_route');
  const { qualifySegments } = require('../lib/segment_qualify');
  const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
  const sq = qualifySegments(loaded.audits);
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
    ...VMB.VIEWER_DEFAULT_PROCESS_OPTIONS,
    segmentQualifications: sq,
    fileAudits: loaded.audits,
  });
  return {
    ...result,
    timeline: enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath),
    fileAudits: loaded.audits,
  };
}

function buildCombinedMap(pd) {
  return CBAO.applyBoundaryAnchoredOrientation(
    SLM.buildSegmentLocalMap(pd, {
      geometrySource: 'pointAccumulated',
      timelineIndex: 0,
      fitEnabled: true,
    }),
    pd,
    { mirrorChecked: true },
  );
}

function acceptedBridges(map) {
  return (map.boundaryBridges || []).filter((b) => BBP.isAcceptedBridge(b));
}

describe('boundary bridge playback candidate', () => {
  it('1. arc-length table calculation', () => {
    const arc = BBP.buildBridgeArcLengthTable([
      { east: 0, north: 0 },
      { east: 3, north: 4 },
      { east: 3, north: 10 },
    ]);
    assert.equal(arc.totalLengthM, 11);
    assert.deepEqual(arc.cumulativeDistances, [0, 5, 11]);
  });

  it('2-3. constant-distance and curved bridge sampling', () => {
    const points = [
      { east: 0, north: 0 },
      { east: 10, north: 0 },
      { east: 10, north: 10 },
    ];
    const arc = BBP.buildBridgeArcLengthTable(points);
    const mid = BBP.sampleBridgeAtDistance(points, arc.cumulativeDistances, 10);
    assert.ok(Math.abs(mid.east - 10) < 1e-6);
    assert.ok(Math.abs(mid.north - 0) < 1e-6);
    const bend = BBP.sampleBridgeAtDistance(points, arc.cumulativeDistances, 15);
    assert.ok(Math.abs(bend.east - 10) < 1e-6);
    assert.ok(Math.abs(bend.north - 5) < 1e-6);
  });

  it('4-5. progress uses elapsed time and is refresh-rate independent', () => {
    const durationS = 2;
    const start = 1000;
    const at500 = BBP.computeBridgeProgress({
      timestampMs: 1500,
      bridgeStartTimestampMs: start,
      bridgePausedDurationMs: 0,
      bridgeDurationS: durationS,
    });
    const at500Again = BBP.computeBridgeProgress({
      timestampMs: 1500,
      bridgeStartTimestampMs: start,
      bridgePausedDurationMs: 0,
      bridgeDurationS: durationS,
    });
    assert.equal(at500, 0.25);
    assert.equal(at500, at500Again);
  });

  it('6-7. Segment 0→1 and 1→2 use recorded qlog time gaps', () => {
    const pd = processSelection([0, 1, 2]);
    const map = buildCombinedMap(pd);
    const bridges = acceptedBridges(map);
    const b01 = bridges.find((b) => b.fromSourceFile === 'qlog_f449c_0.bz2' && b.toSourceFile === 'qlog_f449c_1.bz2');
    const b12 = bridges.find((b) => b.fromSourceFile === 'qlog_f449c_1.bz2' && b.toSourceFile === 'qlog_f449c_2.bz2');
    assert.ok(b01);
    assert.ok(b12);
    assert.ok(Math.abs(b01.timeGapS - 1.999) < 0.02);
    assert.ok(Math.abs(b12.timeGapS - 1.994) < 0.02);
  });

  it('8. video ready early does not skip remaining bridge travel', () => {
    assert.equal(BBP.canCommitBridgeTransition({ bridgeProgress: 0.5, nextVideoReady: true }), false);
  });

  it('9. slow video holds arrow at bridge endpoint', () => {
    assert.equal(BBP.shouldHoldAtBridgeEnd({ bridgeProgress: 1, nextVideoReady: false }), true);
    assert.equal(BBP.canCommitBridgeTransition({ bridgeProgress: 1, nextVideoReady: false }), false);
  });

  it('10-11. pause freezes progress and resume continues', () => {
    const start = 1000;
    const paused = BBP.computeBridgeProgress({
      timestampMs: 1500,
      bridgeStartTimestampMs: start,
      bridgePausedDurationMs: 500,
      bridgeDurationS: 2,
    });
    assert.equal(paused, 0);
    const resumed = BBP.computeBridgeProgress({
      timestampMs: 2000,
      bridgeStartTimestampMs: start,
      bridgePausedDurationMs: 500,
      bridgeDurationS: 2,
    });
    assert.equal(resumed, 0.25);
  });

  it('12-13. scrub cancels transition and stale callbacks are ignored in app wiring', () => {
    assert.match(APP_SRC, /cancelRouteBoundaryTransition/);
    assert.match(APP_SRC, /boundarySwitchToken/);
    assert.match(APP_SRC, /staleCallbackCount/);
  });

  it('14. missing video can still complete at bridge end', () => {
    assert.equal(BBP.canCommitBridgeTransition({
      bridgeProgress: 1,
      nextVideoReady: false,
      missingVideo: true,
    }), true);
  });

  it('15. invalid bridge data retains safe fallback path', () => {
    const duration = BBP.resolveBridgeDuration({ timeGapS: -1 }, 10);
    assert.equal(duration.ok, false);
    assert.match(APP_SRC, /beginRouteBoundaryTransitionLegacy/);
  });

  it('16. bridge sampling spans arc length not endpoint chord', () => {
    const pd = processSelection([0, 1, 2]);
    const map = buildCombinedMap(pd);
    const pack = BBP.findAcceptedBridge(map, 'qlog_f449c_0.bz2', 'qlog_f449c_1.bz2');
    assert.ok(pack.ok);
    const arc = BBP.buildBridgeArcLengthTable(pack.centerlinePoints);
    assert.ok(arc.totalLengthM > pack.bridge.endpointDistanceM * 0.9);
    const end = BBP.sampleBridgePose(pack.centerlinePoints, 1, pack.bridge);
    const start = BBP.sampleBridgePose(pack.centerlinePoints, 0, pack.bridge);
    const jump = Math.hypot(end.pose.east - start.pose.east, end.pose.north - start.pose.north);
    assert.ok(Math.abs(jump - arc.totalLengthM) < 1);
  });

  it('17. arrow heading follows bridge tangent', () => {
    const points = [{ east: 0, north: 0 }, { east: 10, north: 0 }];
    const arc = BBP.buildBridgeArcLengthTable(points);
    const heading = BBP.bridgeTangentHeadingDeg(points, arc.cumulativeDistances, 5);
    assert.ok(Math.abs(heading - 0) < 1 || Math.abs(heading - 360) < 1);
  });

  it('18. diagnostic URL override only; promoted for Candidate C', () => {
    assert.equal(BBP.parseBoundaryBridgePlaybackCandidate(''), false);
    assert.equal(BBP.parseBoundaryBridgePlaybackCandidate('?boundaryBridgePlaybackCandidate=1'), true);
    assert.match(APP_SRC, /function isBoundaryBridgePlaybackActive/);
    assert.doesNotMatch(APP_SRC, /__boundaryBridgePlaybackCandidate\s*=\s*true/);
    assert.match(APP_SRC, /initParams\.has\('boundaryBridgePlaybackCandidate'\)/);
  });

  it('19-21. geometry placement unchanged by candidate wiring', () => {
    const pd = processSelection([0, 1, 2]);
    const map = buildCombinedMap(pd);
    assert.ok(map.boundaryAnchoredOrientationActive);
    const seg2 = map.trajectory.filter((p) => p.sourceFile === 'qlog_f449c_2.bz2');
    assert.equal(CBAO.dominantTurnSign(CBAO.signedTurnSequence(seg2)), 'left');
    assert.doesNotMatch(APP_SRC, /combinedSourceDisplayContractCandidate/);
    assert.doesNotMatch(APP_SRC, /resolveStandaloneDisplayPoint/);
  });

  it('22. only one video element in viewer shell', () => {
    assert.equal((INDEX_SRC.match(/<video/g) || []).length, 1);
  });
});
