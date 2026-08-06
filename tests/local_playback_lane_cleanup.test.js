'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
const LP = require('../lib/local_playback');
const SLM = require('../lib/segment_local_map');
const LMC = require('../lib/lane_map_cleanup');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEG2 = path.join(ROOT, 'qlog_f449c_2.bz2');
const RENDER_JS = path.join(ROOT, 'public/render.js');
const APP_JS = path.join(ROOT, 'public/app.js');
const INDEX_HTML = path.join(ROOT, 'public/index.html');

function loadSegment(fileName) {
  const segPath = path.join(ROOT, fileName);
  const modelEvents = extractModel(segPath).map((e) => ({ ...e, sourceFile: fileName }));
  const gpsEvents = extractGps(segPath).map((e) => ({ ...e, sourceFile: fileName }));
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
  return { ...result, timeline };
}

function frozenMap(data, geometrySource, timelineIndex = 0) {
  return SLM.freezeStationaryMapGeometry(
    SLM.buildSegmentLocalMap(data, { geometrySource, timelineIndex }),
  );
}

function makeDuplicateTrackFused() {
  const basePts = [
    { east: 10, north: 2, s: 0, d: 2 },
    { east: 20, north: 2.1, s: 10, d: 2.1 },
    { east: 30, north: 2.2, s: 20, d: 2.2 },
  ];
  const dupPts = basePts.map((p) => ({ ...p, north: p.north + 0.05 }));
  return {
    frames: [],
    fusedLanes: [
      { laneTrackId: 0, chunkId: 0, passId: 0, points: basePts, sdPoints: basePts.map((p) => ({ s: p.s, d: p.d })), fragmentIndex: 0 },
      { laneTrackId: 1, chunkId: 0, passId: 0, points: dupPts, sdPoints: dupPts.map((p) => ({ s: p.s, d: p.d })), fragmentIndex: 1 },
      { laneTrackId: 2, chunkId: 0, passId: 0, points: [{ east: 10, north: -2, s: 0, d: -2 }, { east: 30, north: -2.1, s: 20, d: -2.1 }], sdPoints: [{ s: 0, d: -2 }, { s: 20, d: -2.1 }], fragmentIndex: 2 },
    ],
    tracks: [
      { trackId: 0, chunkId: 0, passId: 0, frameIds: [1, 2, 3] },
      { trackId: 1, chunkId: 0, passId: 0, frameIds: [1, 2, 3] },
      { trackId: 2, chunkId: 0, passId: 0, frameIds: [1, 2, 3] },
    ],
  };
}

describe('local playback lane cleanup', () => {
  it('1. repeated observations of one boundary collapse duplicate tracks', () => {
    const { fusedLanes, tracks } = makeDuplicateTrackFused();
    const result = LMC.buildCleanedLaneMap({ fusedLanes, tracks, chunkId: 0, passId: 0 });
    const leftRuns = result.cleaned.filter((r) => (r.meanD ?? 0) > 0);
    assert.ok(leftRuns.length >= 1);
    assert.ok(result.stats.suppressedTrackCount >= 1 || result.mergeGroups.some((g) => g.trackIds.length === 1));
  });

  it('2. two neighbouring boundaries are not merged', () => {
    const { fusedLanes, tracks } = makeDuplicateTrackFused();
    const result = LMC.buildCleanedLaneMap({ fusedLanes, tracks, chunkId: 0, passId: 0 });
    const signs = new Set(result.cleaned.map((r) => Math.sign(r.meanD ?? 0)));
    assert.equal(signs.size, 2);
  });

  it('3. track order remains stable through cleanup on segment 2', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = frozenMap(data, 'cleaned', 0);
    const orders = map.laneFragments.map((f) => f.lateralOrder).filter((x) => x != null);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  });

  it('4. cleaned lane lines do not cross on segment 2', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = frozenMap(data, 'cleaned', 0);
    const frags = map.laneFragments;
    let crossings = 0;
    for (let i = 0; i < frags.length; i++) {
      for (let j = i + 1; j < frags.length; j++) {
        if (LMC.segmentCrosses(frags[i].points, frags[j].points)) crossings++;
      }
    }
    assert.equal(crossings, 0);
  });

  it('5. abrupt lateral spikes are rejected when present', () => {
    const spikePts = [
      { east: 0, north: 0 },
      { east: 10, north: 8 },
      { east: 20, north: 0 },
    ];
    const fusedLanes = [{
      laneTrackId: 0,
      chunkId: 0,
      passId: 0,
      points: spikePts,
      sdPoints: [{ s: 0, d: 0 }, { s: 10, d: 8 }, { s: 20, d: 0 }],
      fragmentIndex: 0,
    }];
    const tracks = [{ trackId: 0, chunkId: 0, passId: 0, frameIds: [1, 2, 3] }];
    const result = LMC.buildCleanedLaneMap({ fusedLanes, tracks, chunkId: 0, passId: 0 });
    assert.ok(result.rejected.length >= 1 || result.audit.some((a) => a.type === 'lateralSpike' || a.type === 'spikeRemoved'));
  });

  it('6. short unsupported extensions below span threshold are rejected', () => {
    const fusedLanes = [{
      laneTrackId: 0,
      chunkId: 0,
      passId: 0,
      points: [{ east: 0, north: 0 }, { east: 1, north: 0 }],
      sdPoints: [{ s: 0, d: 0 }, { s: 1, d: 0 }],
      fragmentIndex: 0,
    }];
    const tracks = [{ trackId: 0, chunkId: 0, passId: 0, frameIds: [1, 2] }];
    const result = LMC.buildCleanedLaneMap({ fusedLanes, tracks, chunkId: 0, passId: 0, options: { minSupportedSpanM: 6 } });
    assert.equal(result.cleaned.length, 0);
    assert.ok(result.rejected.length >= 1);
  });

  it('7. long missing intervals remain open (tracks 1 and 2 not bridged on segment 2)', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const chunk = data.routeChunks[0];
    const result = LMC.buildCleanedLaneMap({
      fusedLanes: chunk.fusedLaneLines,
      tracks: chunk.laneTracks,
      chunkId: 0,
      passId: 0,
    });
    const pb1Runs = result.cleaned.filter((r) => r.physicalBoundaryId === 'PB1');
    const track1Runs = pb1Runs.filter((r) => (r.sourceFragments || []).some((f) => f.laneTrackId === 1));
    const track2Runs = pb1Runs.filter((r) => (r.sourceFragments || []).some((f) => f.laneTrackId === 2));
    assert.ok(track1Runs.length >= 1);
    assert.ok(track2Runs.length >= 1);
    const maxS1 = Math.max(...track1Runs.map((r) => r.sMax ?? 0));
    const minS2 = Math.min(...track2Runs.map((r) => r.sMin ?? Infinity));
    assert.ok(minS2 - maxS1 > 50, `gap ${minS2 - maxS1} should remain open`);
    const bridged = result.mergeDecisions.some((d) => d.wasJoined && d.gapM > 100);
    assert.equal(bridged, false);
  });

  it('8. different chunks and passes remain separate', () => {
    const fusedLanes = [
      { laneTrackId: 0, chunkId: 0, passId: 0, points: [{ east: 0, north: 1 }, { east: 10, north: 1 }], sdPoints: [{ s: 0, d: 1 }, { s: 10, d: 1 }], fragmentIndex: 0 },
      { laneTrackId: 0, chunkId: 1, passId: 0, points: [{ east: 0, north: 1 }, { east: 10, north: 1 }], sdPoints: [{ s: 0, d: 1 }, { s: 10, d: 1 }], fragmentIndex: 1 },
    ];
    const result = LMC.buildCleanedLaneMap({ fusedLanes, tracks: [], chunkId: 0, passId: 0 });
    assert.equal(result.stats.fusedFragmentCount, 1);
  });

  it('9. a valid single detected lane remains visible when supported', () => {
    const fusedLanes = [{
      laneTrackId: 0,
      chunkId: 0,
      passId: 0,
      points: [{ east: 0, north: 1 }, { east: 12, north: 1.1 }],
      sdPoints: [{ s: 0, d: 1 }, { s: 12, d: 1.1 }],
      fragmentIndex: 0,
    }];
    const tracks = [{ trackId: 0, chunkId: 0, passId: 0, frameIds: [1] }];
    const result = LMC.buildCleanedLaneMap({
      fusedLanes,
      tracks,
      chunkId: 0,
      passId: 0,
      options: { minTrackFrames: 1 },
    });
    assert.equal(result.cleaned.length, 1);
  });

  it('10. final fused geometry stays constant during playback', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const base = frozenMap(data, 'cleaned', 0);
    for (const idx of [0, 8, 16, 29]) {
      const map = frozenMap(data, 'cleaned', idx);
      assert.equal(map.laneChecksum, base.laneChecksum, `idx ${idx}`);
      assert.equal(map.laneFragmentCount, base.laneFragmentCount);
    }
  });

  it('11. only the arrow moves during playback (geometry checksum constant)', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = frozenMap(data, 'cleaned', 0);
    const poses = [0, 8, 16, 29].map((idx) => SLM.resolveArrowOnSegmentMap(map, data.timeline, idx));
    const positions = poses.map((p) => `${p.east?.toFixed(3)},${p.north?.toFixed(3)}`);
    assert.notDeepEqual(positions[0], positions[3]);
    assert.equal(map.checksum, frozenMap(data, 'cleaned', 29).checksum);
  });

  it('12. corrected arrow direction remains unchanged', () => {
    const renderSrc = fs.readFileSync(RENDER_JS, 'utf8');
    assert.doesNotMatch(renderSrc, /playbackPose\.headingDeg\s*=\s*[^;]+;\s*\/\/\s*flip/i);
    assert.match(renderSrc, /headingDegForVehicleIcon|_drawLocalPlaybackArrow/);
  });

  it('13. video synchronization remains unchanged', () => {
    const appSrc = fs.readFileSync(APP_JS, 'utf8');
    assert.match(appSrc, /localPlaybackVideo\?\.tickSync/);
    assert.doesNotMatch(appSrc, /laneCleanup.*tickSync|tickSync.*laneCleanup/);
  });

  it('14. global and vehicle-relative modes remain available', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.match(html, /value="global"/);
    assert.match(html, /value="vehicle"/);
    assert.match(html, /value="local"/);
    const visibleModes = ['observations', 'fused'];
    for (const mode of visibleModes) {
      assert.match(html, new RegExp(`value="${mode}"`));
    }
    const slmSrc = fs.readFileSync(path.join(ROOT, 'lib', 'segment_local_map.js'), 'utf8');
    for (const mode of ['tracked', 'rejected', 'cleaned', 'cleanedWithSurface', 'cleanedDebug']) {
      assert.match(slmSrc, new RegExp(`'${mode}'`));
    }
  });

  it('observations mode shows more fragments than cleaned mode on segment 2', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const obs = frozenMap(data, 'observations', 0);
    const cleaned = frozenMap(data, 'cleaned', 0);
    assert.ok(obs.laneFragmentCount > cleaned.laneFragmentCount);
  });

  it('physical boundary groups assign tracks 1+2 as complementary left boundary', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const chunk = data.routeChunks[0];
    const result = LMC.buildCleanedLaneMap({
      fusedLanes: chunk.fusedLaneLines,
      tracks: chunk.laneTracks,
      chunkId: 0,
      passId: 0,
    });
    const pb1 = result.physicalBoundaryGroups.find((g) => g.physicalBoundaryId === 'PB1');
    assert.ok(pb1);
    assert.ok(pb1.trackIds.includes(1));
    assert.ok(pb1.trackIds.includes(2));
    assert.equal(pb1.complementary, true);
    const pb0 = result.physicalBoundaryGroups.find((g) => g.physicalBoundaryId === 'PB0');
    assert.ok(pb0?.trackIds.includes(0));
    assert.ok((pb0?.meanD ?? 0) < 0);
  });

  it('cleaned polylines preserve full fused geometry length', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const chunk = data.routeChunks[0];
    const result = LMC.buildCleanedLaneMap({
      fusedLanes: chunk.fusedLaneLines,
      tracks: chunk.laneTracks,
      chunkId: 0,
      passId: 0,
    });
    for (const run of result.cleaned) {
      assert.ok(run.sourceFusedLengthM > 0);
      assert.ok(run.lengthM >= run.sourceFusedLengthM * 0.95, `run ${run.laneTrackId} truncated`);
      assert.ok(run.points.length >= run.sourcePointCount * 0.9);
    }
  });

  it('mode 5 does not include road surface polygons', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment('qlog_f449c_2.bz2');
    const map = frozenMap(data, 'cleaned', 0);
    assert.equal(map.roadSurfacePolygonCount, 0);
  });

  it('cleanedDebug mode remains implemented but hidden from Local geometry UI', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.doesNotMatch(html, /value="cleanedDebug"/);
    const slmSrc = fs.readFileSync(path.join(ROOT, 'lib', 'segment_local_map.js'), 'utf8');
    assert.match(slmSrc, /'cleanedDebug'/);
  });
});
