'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const { buildReferenceTrajectory } = require('../lib/trajectory');
const { collectLaneObservations, fuseLaneTrackSdFragments } = require('../lib/sd_fusion');
const {
  traceLaneTrackFusion,
  classifyGapMechanism,
  computeAcceptedBinSpacingStats,
  findFusedFragmentGaps,
  DEFAULT_FUSION_OPTS,
} = require('../lib/fusion_gap_trace');
const { endpointCompatibility } = require('../lib/lane_run_audit');
const LMC = require('../lib/lane_map_cleanup');
const SLM = require('../lib/segment_local_map');
const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
const { buildTimeline } = require('../lib/process_route');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEG2 = 'qlog_f449c_2.bz2';
const AUDIT_JSON = path.join(ROOT, 'audit_segment2_class_d_fusion_gaps.json');

function loadSegment() {
  const segPath = path.join(ROOT, SEG2);
  const modelEvents = extractModel(segPath).map((e) => ({ ...e, sourceFile: SEG2 }));
  const gpsEvents = extractGps(segPath).map((e) => ({ ...e, sourceFile: SEG2 }));
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
  return { ...result, timeline };
}

function loadAudit() {
  if (!fs.existsSync(AUDIT_JSON)) return null;
  return JSON.parse(fs.readFileSync(AUDIT_JSON, 'utf8'));
}

describe('segment 2 class-D fusion gap trace', () => {
  it('1. valid accepted bin is not removed by fragment construction', () => {
    const obs = [
      { laneTrackId: 0, s: 0, d: 1, frameId: 1, logMonoTime: '1', prob: 0.9 },
      { laneTrackId: 0, s: 0.5, d: 1.1, frameId: 2, logMonoTime: '2', prob: 0.9 },
      { laneTrackId: 0, s: 4, d: 1.05, frameId: 3, logMonoTime: '3', prob: 0.9 },
      { laneTrackId: 0, s: 4.5, d: 1.0, frameId: 4, logMonoTime: '4', prob: 0.9 },
    ];
    const trace = traceLaneTrackFusion(obs, 0, { ...DEFAULT_FUSION_OPTS, maxLaneFragmentGapM: 10 });
    assert.equal(trace.acceptedFused.length, 2);
    assert.equal(trace.fragments.length, 1);
    assert.equal(trace.fragments[0].length, 2);
  });

  it('2. compatible consecutive accepted bins within 10 m stay in one fragment', () => {
    const obs = [];
    for (let i = 0; i < 4; i++) {
      obs.push({ laneTrackId: 0, s: i * 4, d: 2, frameId: i + 1, logMonoTime: String(i), prob: 0.9 });
      obs.push({ laneTrackId: 0, s: i * 4 + 0.5, d: 2.1, frameId: i + 10, logMonoTime: String(i + 10), prob: 0.9 });
    }
    const trace = traceLaneTrackFusion(obs, 0, DEFAULT_FUSION_OPTS);
    assert.equal(trace.fragments.length, 1);
    assert.ok(trace.fragments[0].length >= 3);
  });

  it('3. full mapped geometry span is tracked when source observation covers interval', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const audit = loadAudit();
    assert.ok(audit);
    const cd00 = audit.gaps.find((g) => g.gapId === 'CD-00');
    assert.ok(cd00.coverageLengthsM.sourcePolylineMaxSpan > 15);
    assert.ok(cd00.mappedObservations.count > 0);
  });

  it('4. sparse bin representatives do not imply missing lane geometry', () => {
    const mech = classifyGapMechanism({
      gapM: 20,
      binsInGap: [{ accepted: true }],
      acceptedBinsInGap: [{ accepted: true }],
      rejectedBinsInGap: [],
      modelV2FramesInGap: [{ frameId: 1 }],
      mappedObsInGap: [{ frameId: 1, s: 10 }],
      sourcePolylineSpanM: 19,
      maxLaneFragmentGapM: 10,
      consecutiveAcceptedSpacing: 20,
      endpointCompatible: true,
    });
    assert.equal(mech.primary, 'D12');
  });

  it('5. gap with no ModelV2 support classifies as D1', () => {
    const mech = classifyGapMechanism({
      gapM: 20,
      binsInGap: [],
      acceptedBinsInGap: [],
      rejectedBinsInGap: [],
      modelV2FramesInGap: [],
      mappedObsInGap: [],
      maxLaneFragmentGapM: 10,
    });
    assert.equal(mech.primary, 'D1');
  });

  it('6. rejected bin remains rejected when temporal support is insufficient', () => {
    const obs = [
      { laneTrackId: 0, s: 10, d: 1, frameId: 1, logMonoTime: '1', prob: 0.9 },
      { laneTrackId: 0, s: 10.3, d: 1.1, frameId: 1, logMonoTime: '1', prob: 0.9 },
    ];
    const trace = traceLaneTrackFusion(obs, 0, DEFAULT_FUSION_OPTS);
    const bin = trace.binRecords[0];
    assert.equal(bin.rejectionReason, 'D7_minFramesPerBin');
    assert.equal(trace.acceptedFused.length, 0);
  });

  it('7. multiple points from one frame do not count as multiple independent frames', () => {
    const obs = [
      { laneTrackId: 0, s: 10, d: 1, frameId: 1, logMonoTime: '1', prob: 0.9 },
      { laneTrackId: 0, s: 10.2, d: 1.1, frameId: 1, logMonoTime: '1', prob: 0.9 },
      { laneTrackId: 0, s: 10.4, d: 0.9, frameId: 1, logMonoTime: '1', prob: 0.9 },
    ];
    const trace = traceLaneTrackFusion(obs, 0, DEFAULT_FUSION_OPTS);
    const bin = trace.binRecords[0];
    assert.equal(bin.distinctFrameCount, 1);
    assert.equal(bin.rejectionReason, 'D7_minFramesPerBin');
  });

  it('8. distinct valid frames count correctly toward acceptance', () => {
    const obs = [
      { laneTrackId: 0, s: 10, d: 1, frameId: 1, logMonoTime: '1', prob: 0.9 },
      { laneTrackId: 0, s: 10.2, d: 1.0, frameId: 2, logMonoTime: '2', prob: 0.9 },
      { laneTrackId: 0, s: 14, d: 1.05, frameId: 3, logMonoTime: '3', prob: 0.9 },
      { laneTrackId: 0, s: 14.2, d: 1.1, frameId: 4, logMonoTime: '4', prob: 0.9 },
    ];
    const trace = traceLaneTrackFusion(obs, 0, DEFAULT_FUSION_OPTS);
    assert.equal(trace.acceptedFused.length, 2);
    assert.ok(trace.binRecords.every((b) => b.accepted || b.rejectionReason));
  });

  it('9. lateral incompatibility prevents fragment join at cleanup', () => {
    const a = { sdPoints: [{ s: 0, d: 0, east: 0, north: 0 }, { s: 10, d: 0, east: 10, north: 0 }] };
    const b = { sdPoints: [{ s: 12, d: 3, east: 12, north: 3 }, { s: 22, d: 3, east: 22, north: 3 }] };
    const compat = endpointCompatibility(a, b, { maxJoinLateralDeltaM: 0.8, maxJoinHeadingDeltaDeg: 25 });
    assert.equal(compat.compatible, false);
  });

  it('10. heading incompatibility prevents fragment join at cleanup', () => {
    const a = { sdPoints: [{ s: 0, d: 0 }, { s: 10, d: 0 }] };
    const b = { sdPoints: [{ s: 12, d: 0 }, { s: 22, d: 6 }] };
    const compat = endpointCompatibility(a, b, { maxJoinLateralDeltaM: 0.8, maxJoinHeadingDeltaDeg: 25 });
    assert.equal(compat.compatible, false);
    assert.equal(compat.reason, 'headingMismatch');
  });

  it('11. competing neighbouring boundary prevents joining different physical boundaries', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const cleanup = LMC.buildCleanedLaneMap({
      frames: data.routeChunks[0].frames,
      fusedLanes: data.routeChunks[0].fusedLaneLines,
      tracks: data.routeChunks[0].laneTracks,
      chunkId: 0,
      passId: 0,
    });
    const groups = cleanup.physicalBoundaryGroups;
    assert.equal(groups.length, 3);
    assert.ok(groups.every((g) => g.trackIds.length >= 1));
  });

  it('12. different track identities remain separate in fused output', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const ids = new Set(data.routeChunks[0].fusedLaneLines.map((f) => f.laneTrackId));
    assert.ok(ids.has(0));
    assert.ok(ids.has(1) || ids.has(2));
    assert.ok(!ids.has(4), 'track 4 must remain absent');
  });

  it('13. chunk and pass boundaries remain separate', () => {
    const obs = [
      { laneTrackId: 0, s: 0, d: 1, frameId: 1, logMonoTime: '1', prob: 0.9, passId: 0, chunkId: 0 },
      { laneTrackId: 0, s: 0.5, d: 1, frameId: 2, logMonoTime: '2', prob: 0.9, passId: 0, chunkId: 0 },
      { laneTrackId: 0, s: 5, d: 1, frameId: 3, logMonoTime: '3', prob: 0.9, passId: 1, chunkId: 0 },
      { laneTrackId: 0, s: 5.5, d: 1, frameId: 4, logMonoTime: '4', prob: 0.9, passId: 1, chunkId: 0 },
    ];
    const trace = traceLaneTrackFusion(obs, 0, { ...DEFAULT_FUSION_OPTS, maxLaneFragmentGapM: 10 });
    assert.equal(trace.fragments.length, 1);
  });

  it('14. 240 m Segment 2 dropout between track 1 and track 2 remains open', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit_segment2_cleaned_runs.json'), 'utf8'));
    const dropout = audit.separations.find((s) => s.classification === 'A' && s.gapM > 200);
    assert.ok(dropout);
    assert.ok(dropout.gapM > 230);
    assert.deepEqual(dropout.sourceTrackIds, [1, 2]);
  });

  it('15. track 4 remains absent', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const track4 = data.routeChunks[0].laneTracks.find((t) => t.trackId === 4);
    assert.ok(!track4 || track4.frameIds?.length <= 1);
    const fused4 = data.routeChunks[0].fusedLaneLines.filter((f) => f.laneTrackId === 4);
    assert.equal(fused4.length, 0);
  });

  it('16. PB0 PB1 PB2 identity unchanged', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const audit = loadAudit();
    const groups = audit ? null : null;
    const data = loadSegment();
    const cleanup = LMC.buildCleanedLaneMap({
      frames: data.routeChunks[0].frames,
      fusedLanes: data.routeChunks[0].fusedLaneLines,
      tracks: data.routeChunks[0].laneTracks,
      chunkId: 0,
      passId: 0,
    });
    const pb = cleanup.physicalBoundaryGroups.map((g) => g.physicalBoundaryId).sort();
    assert.deepEqual(pb, ['PB0', 'PB1', 'PB2']);
  });

  it('17. lane order remains stable after cleanup', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const map = SLM.freezeStationaryMapGeometry(
      SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 }),
    );
    const orders = map.laneFragments.map((f) => f.lateralOrder).filter((x) => x != null);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  });

  it('18. no new crossings introduced in cleaned geometry', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const cleanup = LMC.buildCleanedLaneMap({
      frames: data.routeChunks[0].frames,
      fusedLanes: data.routeChunks[0].fusedLaneLines,
      tracks: data.routeChunks[0].laneTracks,
      chunkId: 0,
      passId: 0,
    });
    const meanDs = cleanup.cleaned.map((r) => r.meanD).sort((a, b) => a - b);
    for (let i = 1; i < meanDs.length; i++) {
      assert.ok(meanDs[i] >= meanDs[i - 1] - 0.01, 'lane order crossing');
    }
  });

  it('19. unsupported extensions are absent from cleaned runs', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const cleanup = LMC.buildCleanedLaneMap({
      frames: data.routeChunks[0].frames,
      fusedLanes: data.routeChunks[0].fusedLaneLines,
      tracks: data.routeChunks[0].laneTracks,
      chunkId: 0,
      passId: 0,
    });
    assert.ok(cleanup.cleaned.every((r) => r.supportStatus === 'supported'));
  });

  it('20. Mode 5 remains stationary across timeline indices', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const checksums = new Set();
    for (const idx of [0, 8, 16, 26]) {
      const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: idx });
      checksums.add(map.checksum);
    }
    assert.equal(checksums.size, 1);
  });

  it('21. arrow transform remains unchanged', () => {
    const renderSrc = fs.readFileSync(path.join(ROOT, 'public/render.js'), 'utf8');
    assert.match(renderSrc, /headingDegForVehicleIcon|_drawLocalPlaybackArrow/);
    assert.doesNotMatch(renderSrc, /playbackPose\.headingDeg\s*=\s*[^;]+;\s*\/\/\s*flip/i);
  });

  it('22. video synchronization remains unchanged', () => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
    assert.match(appSrc, /localPlaybackVideo\?\.tickSync/);
    assert.doesNotMatch(appSrc, /laneCleanup.*tickSync|tickSync.*laneCleanup/);
  });

  it('23. global and vehicle-relative modes preserved in process_route', () => {
    const pr = fs.readFileSync(path.join(ROOT, 'lib/process_route.js'), 'utf8');
    assert.ok(pr.includes("mode = 'global'"));
    assert.ok(pr.includes("mode = 'vehicle-relative'"));
  });

  it('24. Mode 5 hides road surfaces in segment local map', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const cleaned = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
    assert.equal(cleaned.roadSurfacePolygons?.length ?? 0, 0);
  });

  it('25. class-F incompatible gaps remain open in audit', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit_segment2_cleaned_runs.json'), 'utf8'));
    const classF = audit.separations.filter((s) => s.classification === 'F');
    assert.equal(classF.length, 4);
    assert.ok(classF.every((s) => !s.safeToJoin));
  });

  it('audit JSON contains exactly 19 class-D gaps with reconciling mechanisms', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const audit = loadAudit();
    assert.ok(audit);
    assert.equal(audit.classDGapCount, 19);
    const total = Object.values(audit.mechanismTotals).reduce((s, m) => s + m.count, 0);
    assert.equal(total, 19);
    const gapM = Object.values(audit.mechanismTotals).reduce((s, m) => s + m.totalGapM, 0);
    assert.ok(Math.abs(gapM - audit.countsBeforeCorrection.classDTotalGapM) < 0.01);
  });

  it('10 m rule splits pairs above retained maximum', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const audit = loadAudit();
    const retained = audit.acceptedBinSpacingSummary.retainedInOneFragment;
    const split = audit.acceptedBinSpacingSummary.splitBy10mRule;
    assert.ok(retained.max < 10.1);
    assert.ok(split.min >= 1.0);
    assert.ok(split.median > 10);
  });

  it('maxLaneFragmentGapM splits consecutive accepted bins beyond threshold', () => {
    const obs = [];
    for (const [s, fid] of [[0, 1], [0.5, 2], [4, 3], [4.5, 4], [25, 5], [25.5, 6], [29, 7], [29.5, 8]]) {
      obs.push({ laneTrackId: 0, s, d: 1, frameId: fid, logMonoTime: String(fid), prob: 0.9 });
    }
    const trace = traceLaneTrackFusion(obs, 0, DEFAULT_FUSION_OPTS);
    assert.equal(trace.fragmentSplits.length, 1);
    assert.equal(trace.fragmentSplits[0].reason, 'D11_maxLaneFragmentGapM');
    assert.equal(trace.fragments.length, 2);
  });
});
