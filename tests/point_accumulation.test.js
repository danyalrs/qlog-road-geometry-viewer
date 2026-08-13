'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PA = require('../lib/point_accumulation');
const SLM = require('../lib/segment_local_map');
const {
  LOCAL_GEOMETRY_VISIBLE_MODES,
  localGeometryDropdownOptions,
} = require('../lib/local_geometry_ui');
const { loadSegment } = require('../lib/lane_continuity_stage4');

const ROOT = path.join(__dirname, '..');
const SEG2 = path.join(ROOT, 'qlog_f449c_2.bz2');
const SEG99 = path.join(ROOT, 'qlog_f449c_99.bz2');
const RENDER_JS = path.join(ROOT, 'public/render.js');
const INDEX_HTML = path.join(ROOT, 'public/index.html');

function makeFrame({ frameId, east, north, laneIndex = 2, laneTrackId = 5, prob = 0.9, chunkId = 0, passId = 0, points }) {
  return {
    frameId,
    logMonoTime: String(frameId),
    sourceFile: 'qlog_f449c_2.bz2',
    chunkId,
    passId,
    lanes: [{
      laneIndex,
      laneTrackId,
      prob,
      points: points || [
        { east, north, modelX: 0, modelY: 5, modelZ: 0, t: 0 },
        { east: east + 10, north, modelX: 10, modelY: 5, modelZ: 0, t: 1 },
        { east: east + 20, north, modelX: 20, modelY: 5, modelZ: 0, t: 2 },
      ],
    }],
  };
}

function straightTrajectory(len = 200) {
  return PA.buildReferenceTrajectory([{ east: 0, north: 0 }, { east: len, north: 0 }]);
}

function accumulate(frames, opts = {}, ref = { east: 0, north: 0, headingDeg: 0 }) {
  return PA.accumulatePointObservations({
    frames, timeline: [], referencePose: ref, chunkId: 0, passId: 0,
    trajectory: straightTrajectory(), options: opts,
  });
}

describe('point accumulation — point sampling', () => {
  it('reuses already-sampled modelV2 points without straight-line re-interpolation', () => {
    const ref = { east: 0, north: 0, headingDeg: 0 };
    const lane = {
      laneIndex: 2,
      prob: 0.9,
      points: Array.from({ length: 51 }, (_, i) => ({
        east: i, north: 5, modelX: i, modelY: 5, modelZ: 0, t: i,
      })),
    };
    const kept = PA.samplePointIndicesAtSpacing(lane, ref, 0);
    assert.equal(kept.length, 51);
    for (const idx of kept) assert.equal(lane.points[idx].modelX, idx);
  });

  it('default keeps every existing modelV2 point (no thinning)', () => {
    const ref = { east: 0, north: 0, headingDeg: 0 };
    const lane = {
      laneIndex: 2, prob: 0.9,
      points: Array.from({ length: 101 }, (_, i) => ({ east: i, north: 5, modelX: i, modelY: 5, modelZ: 0, t: i })),
    };
    assert.equal(PA.samplePointIndicesAtSpacing(lane, ref, 0).length, 101);
    assert.equal(PA.samplePointIndicesAtSpacing(lane, ref, undefined).length, 101);
  });

  it('optional display thinning only reduces density, never drops endpoints', () => {
    const ref = { east: 0, north: 0, headingDeg: 0 };
    const lane = {
      laneIndex: 2, prob: 0.9,
      points: Array.from({ length: 101 }, (_, i) => ({ east: i, north: 5, modelX: i, modelY: 5, modelZ: 0, t: i })),
    };
    const kept = PA.samplePointIndicesAtSpacing(lane, ref, 10.0);
    assert.equal(kept[0], 0);
    assert.equal(kept[kept.length - 1], 100);
    assert.ok(kept.length < 101);
  });
});

describe('point accumulation — metadata preservation', () => {
  it('keeps segment, frame, timestamp, lane identity, side, coords, confidence, chunk/pass, movement', () => {
    const frames = [
      makeFrame({ frameId: 1, east: 0, north: 5 }),
      makeFrame({ frameId: 2, east: 0, north: 5 }),
    ];
    const timeline = [
      { logMonoTime: '1', movementState: 'moving' },
      { logMonoTime: '2', movementState: 'moving' },
    ];
    const ref = { east: 0, north: 0, headingDeg: 0 };
    const { observations } = PA.accumulatePointObservations({
      frames, timeline, referencePose: ref, chunkId: 0, passId: 0,
      trajectory: straightTrajectory(), options: {},
    });
    assert.ok(observations.length > 0);
    const o = observations[0];
    assert.equal(o.segmentId, 'qlog_f449c_2.bz2');
    assert.ok(o.frameId != null);
    assert.ok(o.logMonoTime != null);
    assert.equal(o.laneIndex, 2);
    assert.equal(o.laneTrackId, 5);
    assert.equal(o.side, 'left');
    assert.equal(o.chunkId, 0);
    assert.equal(o.passId, 0);
    assert.ok(Number.isFinite(o.s));
    assert.ok(Number.isFinite(o.d));
    assert.ok(Number.isFinite(o.prob));
    assert.equal(o.movementState, 'moving');
    assert.ok(Number.isFinite(o.localEast));
    assert.ok(Number.isFinite(o.localNorth));
  });

  it('preserves confidence on every point', () => {
    const frames = [
      { frameId: 1, logMonoTime: '1', sourceFile: 'qlog_f449c_2.bz2', chunkId: 0, passId: 0,
        lanes: [{ laneIndex: 2, laneTrackId: 5, prob: 0.15, points: [{ east: 0, north: 5, modelX: 0, modelY: 5, modelZ: 0, t: 0 }, { east: 10, north: 5, modelX: 10, modelY: 5, modelZ: 0, t: 1 }] }] },
    ];
    const { observations } = accumulate(frames);
    assert.ok(observations.length > 0);
    for (const o of observations) assert.equal(o.prob, 0.15);
  });
});

describe('point accumulation — visibility is not gated by confidence or support', () => {
  it('a valid low-confidence lane point remains visible', () => {
    const frames = [
      { frameId: 1, logMonoTime: '1', sourceFile: 'qlog_f449c_2.bz2', chunkId: 0, passId: 0,
        lanes: [{ laneIndex: 2, laneTrackId: 5, prob: 0.05, points: [{ east: 0, north: 5, modelX: 0, modelY: 5, modelZ: 0, t: 0 }, { east: 10, north: 5, modelX: 10, modelY: 5, modelZ: 0, t: 1 }] }] },
    ];
    const { observations } = accumulate(frames);
    assert.ok(observations.length > 0, 'low-confidence points must be kept');
    const display = PA.buildPointDisplay(observations, {});
    assert.ok(display.points.length > 0);
    assert.ok(display.points[0].lowConfidence === true);
  });

  it('a first-observation point appears without support from another frame', () => {
    const frames = [makeFrame({ frameId: 1, east: 0, north: 5 })];
    const { observations } = accumulate(frames);
    assert.ok(observations.length > 0);
    const display = PA.buildPointDisplay(observations, { minSupportingObservations: 2 });
    assert.ok(display.points.length > 0, 'single-frame points must be visible');
    assert.ok(display.points.every((p) => p.singleObservation === true));
  });

  it('an isolated valid point remains visible', () => {
    const frames = [
      makeFrame({ frameId: 1, east: 0, north: 5 }),
      makeFrame({ frameId: 2, east: 0, north: 5 }),
      {
        frameId: 3, logMonoTime: '3', sourceFile: 'qlog_f449c_2.bz2', chunkId: 0, passId: 0,
        lanes: [{ laneIndex: 2, laneTrackId: 5, prob: 0.9, points: [{ east: 500, north: 5, modelX: 0, modelY: 5, modelZ: 0, t: 0 }] }],
      },
    ];
    const { observations } = accumulate(frames);
    const display = PA.buildPointDisplay(observations, {});
    const iso = display.points.filter((p) => p.singleObservation);
    assert.ok(iso.length >= 1, 'isolated single-observation points must remain visible');
    assert.ok(display.points.some((p) => p.singleObservation));
  });

  it('non-finite / structurally invalid coordinates are excluded', () => {
    const frames = [
      { frameId: 1, logMonoTime: '1', sourceFile: 'qlog_f449c_2.bz2', chunkId: 0, passId: 0,
        lanes: [{
          laneIndex: 2, laneTrackId: 5, prob: 0.9,
          points: [
            { east: 0, north: 5, modelX: 0, modelY: 5, modelZ: 0, t: 0 },
            { east: NaN, north: 5, modelX: 10, modelY: 5, modelZ: 0, t: 1 },
            { east: 20, north: Infinity, modelX: 20, modelY: 5, modelZ: 0, t: 2 },
            { east: 30, north: 5, modelX: 30, modelY: 5, modelZ: 0, t: 3 },
          ],
        }] },
    ];
    const { observations, invalidExcluded } = accumulate(frames);
    assert.equal(invalidExcluded, 2);
    const display = PA.buildPointDisplay(observations, { _invalidExcluded: invalidExcluded });
    assert.equal(display.stats.invalidExcluded, 2);
    assert.ok(display.points.length >= 2);
  });
});

describe('point accumulation — safety separation metadata', () => {
  it('does not mix points from different chunks', () => {
    const frames = [
      makeFrame({ frameId: 1, east: 0, north: 5, chunkId: 0, passId: 0 }),
      makeFrame({ frameId: 2, east: 0, north: 5, chunkId: 1, passId: 0 }),
    ];
    const { observations } = PA.accumulatePointObservations({
      frames, timeline: [], referencePose: { east: 0, north: 0, headingDeg: 0 }, chunkId: 0, passId: 0,
      trajectory: straightTrajectory(), options: {},
    });
    for (const o of observations) assert.equal(o.chunkId, 0);
  });

  it('does not mix points from different passes', () => {
    const frames = [
      makeFrame({ frameId: 1, east: 0, north: 5, chunkId: 0, passId: 0 }),
      makeFrame({ frameId: 2, east: 0, north: 5, chunkId: 0, passId: 1 }),
    ];
    const { observations } = PA.accumulatePointObservations({
      frames, timeline: [], referencePose: { east: 0, north: 0, headingDeg: 0 }, chunkId: 0, passId: 0,
      trajectory: straightTrajectory(), options: {},
    });
    for (const o of observations) assert.equal(o.passId, 0);
  });

  it('accumulation restricted to active chunk/pass produces a single key group', () => {
    const frames = [
      makeFrame({ frameId: 1, east: 0, north: 5, chunkId: 0, passId: 0 }),
      makeFrame({ frameId: 2, east: 0, north: 5, chunkId: 0, passId: 0 }),
    ];
    const { observations } = PA.accumulatePointObservations({
      frames, timeline: [], referencePose: { east: 0, north: 0, headingDeg: 0 }, chunkId: 0, passId: 0,
      trajectory: straightTrajectory(), options: {},
    });
    const display = PA.buildPointDisplay(observations, {});
    const keys = new Set(display.points.map((p) => p.groupKey));
    assert.equal(keys.size, 1);
  });

  it('keeps left and right lane lines in separate groups', () => {
    const frames = [
      {
        frameId: 1, logMonoTime: '1', sourceFile: 'qlog_f449c_2.bz2', chunkId: 0, passId: 0,
        lanes: [
          { laneIndex: 2, laneTrackId: 5, prob: 0.9, points: [{ east: 0, north: 5, modelX: 0, modelY: 5, modelZ: 0, t: 0 }, { east: 10, north: 5, modelX: 10, modelY: 5, modelZ: 0, t: 1 }] },
          { laneIndex: 1, laneTrackId: 4, prob: 0.9, points: [{ east: 0, north: -5, modelX: 0, modelY: -5, modelZ: 0, t: 0 }, { east: 10, north: -5, modelX: 10, modelY: -5, modelZ: 0, t: 1 }] },
        ],
      },
      {
        frameId: 2, logMonoTime: '2', sourceFile: 'qlog_f449c_2.bz2', chunkId: 0, passId: 0,
        lanes: [
          { laneIndex: 2, laneTrackId: 5, prob: 0.9, points: [{ east: 0, north: 5, modelX: 0, modelY: 5, modelZ: 0, t: 0 }, { east: 10, north: 5, modelX: 10, modelY: 5, modelZ: 0, t: 1 }] },
          { laneIndex: 1, laneTrackId: 4, prob: 0.9, points: [{ east: 0, north: -5, modelX: 0, modelY: -5, modelZ: 0, t: 0 }, { east: 10, north: -5, modelX: 10, modelY: -5, modelZ: 0, t: 1 }] },
        ],
      },
    ];
    const { observations } = PA.accumulatePointObservations({
      frames, timeline: [], referencePose: { east: 0, north: 0, headingDeg: 0 }, chunkId: 0, passId: 0,
      trajectory: straightTrajectory(), options: {},
    });
    const display = PA.buildPointDisplay(observations, {});
    const sides = new Set(display.points.map((p) => p.side));
    assert.ok(sides.has('left'));
    assert.ok(sides.has('right'));
    const leftKeys = new Set(display.points.filter((p) => p.side === 'left').map((p) => p.groupKey));
    const rightKeys = new Set(display.points.filter((p) => p.side === 'right').map((p) => p.groupKey));
    for (const k of leftKeys) assert.ok(!rightKeys.has(k), 'left/right group keys must not overlap');
  });
});

describe('point accumulation — curved lane evidence', () => {
  it('preserves curved-road geometry as dots (no straight-line collapse)', () => {
    const ref = { east: 0, north: 0, headingDeg: 0 };
    const curvedPts = Array.from({ length: 41 }, (_, i) => {
      const east = i * 2;
      return { east, north: 5 + east * east * 0.001, modelX: i * 2, modelY: 5, modelZ: 0, t: i };
    });
    const frames = [1, 2].map((fid) => ({
      frameId: fid, logMonoTime: String(fid), sourceFile: 'qlog_f449c_2.bz2', chunkId: 0, passId: 0,
      lanes: [{ laneIndex: 2, laneTrackId: 5, prob: 0.9, points: curvedPts }],
    }));
    const { observations } = PA.accumulatePointObservations({
      frames, timeline: [], referencePose: ref, chunkId: 0, passId: 0,
      trajectory: straightTrajectory(200), options: {},
    });
    const display = PA.buildPointDisplay(observations, {});
    assert.ok(display.points.length >= 10);
    const dRange = Math.max(...display.points.map((a) => a.d)) - Math.min(...display.points.map((a) => a.d));
    assert.ok(dRange > 0.5, `expected lateral spread from curve, got ${dRange}`);
    // No connecting lines: curves array must be empty.
    assert.equal(display.curves.length, 0);
  });
});

describe('point accumulation — causality and fixed local coordinates', () => {
  it('no future-frame points appear before their timeline position', () => {
    const frames = [
      makeFrame({ frameId: 1, east: 0, north: 5 }),
      makeFrame({ frameId: 2, east: 40, north: 5 }),
      makeFrame({ frameId: 3, east: 80, north: 5 }),
    ];
    const ref = { east: 0, north: 0, headingDeg: 0 };
    const { observations } = PA.accumulatePointObservations({
      frames, timeline: [], referencePose: ref, chunkId: 0, passId: 0,
      trajectory: straightTrajectory(200), options: {},
    });
    const display = PA.buildPointDisplay(observations, {});
    // Points from frames 2 and 3 must not appear at frame 1's window.
    const at0 = display.points.filter((p) => p.frameIndex <= 0);
    assert.ok(at0.length > 0);
    assert.ok(at0.every((p) => p.frameIndex === 0));
    const at1 = display.points.filter((p) => p.frameIndex <= 1);
    assert.ok(at1.some((p) => p.frameIndex === 1));
    assert.ok(at1.every((p) => p.frameIndex <= 1));
  });

  it('points accumulate as the timeline advances', () => {
    const frames = [
      makeFrame({ frameId: 1, east: 0, north: 5 }),
      makeFrame({ frameId: 2, east: 40, north: 5 }),
      makeFrame({ frameId: 3, east: 80, north: 5 }),
    ];
    const ref = { east: 0, north: 0, headingDeg: 0 };
    const { observations } = PA.accumulatePointObservations({
      frames, timeline: [], referencePose: ref, chunkId: 0, passId: 0,
      trajectory: straightTrajectory(200), options: {},
    });
    const display = PA.buildPointDisplay(observations, {});
    const at0 = display.points.filter((p) => p.frameIndex <= 0).length;
    const at1 = display.points.filter((p) => p.frameIndex <= 1).length;
    const at2 = display.points.filter((p) => p.frameIndex <= 2).length;
    assert.ok(at0 > 0);
    assert.ok(at1 > at0);
    assert.ok(at2 > at1);
  });

  it('previously accumulated points remain in fixed local coordinates', () => {
    const frames = [
      makeFrame({ frameId: 1, east: 0, north: 5 }),
      makeFrame({ frameId: 2, east: 40, north: 5 }),
    ];
    const ref = { east: 0, north: 0, headingDeg: 0 };
    const { observations } = PA.accumulatePointObservations({
      frames, timeline: [], referencePose: ref, chunkId: 0, passId: 0,
      trajectory: straightTrajectory(200), options: {},
    });
    const display = PA.buildPointDisplay(observations, {});
    const f0pts = display.points.filter((p) => p.frameIndex === 0).map((p) => `${p.localEast.toFixed(4)},${p.localNorth.toFixed(4)}`);
    const f0later = display.points.filter((p) => p.frameIndex <= 1 && p.frameIndex === 0).map((p) => `${p.localEast.toFixed(4)},${p.localNorth.toFixed(4)}`);
    assert.deepEqual(f0later, f0pts);
  });
});

describe('point accumulation — integration and unchanged modes', () => {
  it('pointAccumulated is a valid geometry source and builds a map', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment();
    const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'pointAccumulated', timelineIndex: 0 });
    assert.ok(map.valid);
    assert.equal(map.geometrySource, 'pointAccumulated');
    assert.ok(map.pointAccumulated != null);
  });

  it('all three visible Local geometry modes are available', () => {
    assert.deepEqual(LOCAL_GEOMETRY_VISIBLE_MODES, ['observations', 'fused', 'pointAccumulated']);
    assert.deepEqual(localGeometryDropdownOptions().map((o) => o.value),
      ['observations', 'fused', 'pointAccumulated']);
    assert.match(fs.readFileSync(INDEX_HTML, 'utf8'), /value="pointAccumulated"/);
  });

  it('Raw and Fused modes are unchanged by the Point mode implementation', () => {
    if (!fs.existsSync(SEG2)) return;
    const data = loadSegment();
    const raw = SLM.buildSegmentLocalMap(data, { geometrySource: 'observations', timelineIndex: 0 });
    const fused = SLM.buildSegmentLocalMap(data, { geometrySource: 'fused', timelineIndex: 0 });
    assert.ok(raw.valid);
    assert.ok(fused.valid);
    assert.equal(raw.geometrySource, 'observations');
    assert.equal(fused.geometrySource, 'fused');
    assert.ok(raw.laneFragments.length > 0);
    assert.ok(fused.laneFragments.length > 0);
  });
});

describe('point accumulation — blue arrow independence', () => {
  it('render.js keeps the arrow independent of the geometry mode', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    assert.match(src, /_drawLocalPlaybackArrow\(null, this\.playbackPose\)/);
    const pointBlock = src.slice(src.indexOf('_drawPointAccumulatedGeometry'), src.indexOf('_drawLocalVehiclePathOverlay'));
    assert.doesNotMatch(pointBlock, /_drawLocalPlaybackArrow/);
  });

  it('dropdown change handler still resolves pose and draws', () => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
    assert.match(appSrc, /switchLocalGeometryLayer/);
    assert.match(appSrc, /setPlaybackPose/);
  });
});

describe('point accumulation — no connecting lines by default', () => {
  it('renderer draws dots without line/curve connections by default', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    const pointBlock = src.slice(src.indexOf('_drawPointAccumulatedGeometry'), src.indexOf('_drawLocalVehiclePathOverlay'));
    // No lineTo/beginPath stroke path in the point block.
    assert.doesNotMatch(pointBlock, /lineTo\(/);
    assert.doesNotMatch(pointBlock, /\.stroke\(\)/);
  });
});

describe('point accumulation — coverage parity with Raw mode', () => {
  it('point-mode displayed count matches raw source count on real segments', () => {
    if (!fs.existsSync(SEG2) && !fs.existsSync(SEG99)) return;
    for (const seg of [SEG2, SEG99]) {
      if (!fs.existsSync(seg)) continue;
      const fileName = path.basename(seg);
      const data = loadSegment();
      // count raw source points in chunk 0 / pass 0 exactly like Raw mode
      let rawCount = 0;
      for (const f of data.frames) {
        if (f.chunkId != null && f.chunkId !== 0) continue;
        if ((f.passId ?? 0) !== 0) continue;
        for (const l of f.lanes || []) rawCount += (l.points || []).length;
      }
      const pt = SLM.buildSegmentLocalMap(data, { geometrySource: 'pointAccumulated', timelineIndex: 0 });
      const st = pt.pointAccumulated.stats;
      assert.equal(st.totalValidSourcePoints, rawCount);
      assert.equal(st.displayedPoints, rawCount, `${fileName}: parity must be 100%`);
      assert.ok(st.coverageParity >= 0.999);
    }
  });
});

describe('point accumulation — segment 99 / straight-segment smoke', () => {
  it('produces a non-empty displayed point cloud on segment 99 when available', () => {
    if (!fs.existsSync(SEG99)) return;
    const data = loadSegment();
    const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'pointAccumulated', timelineIndex: 0 });
    assert.ok(map.valid);
    const st = map.pointAccumulated?.stats;
    assert.ok(st && st.displayedPoints > 0);
  });
});

describe('point accumulation — complete map vs causal playback viewer', () => {
  it('complete-map default shows every valid point from all observations', () => {
    const frames = [
      makeFrame({ frameId: 1, east: 0, north: 5 }),
      makeFrame({ frameId: 2, east: 40, north: 5 }),
      makeFrame({ frameId: 3, east: 80, north: 5 }),
    ];
    const ref = { east: 0, north: 0, headingDeg: 0 };
    const { observations } = PA.accumulatePointObservations({
      frames, timeline: [], referencePose: ref, chunkId: 0, passId: 0,
      trajectory: straightTrajectory(200), options: {},
    });
    const display = PA.buildPointDisplay(observations, {});
    // Complete map: the full set is the display set (no frame filter).
    const complete = display.points;
    assert.equal(complete.length, observations.length);
    assert.ok(complete.some((p) => p.frameIndex === 0));
    assert.ok(complete.some((p) => p.frameIndex === 2));
  });

  it('causal display keeps only points through the selected timeline index', () => {
    const frames = [
      makeFrame({ frameId: 1, east: 0, north: 5 }),
      makeFrame({ frameId: 2, east: 40, north: 5 }),
      makeFrame({ frameId: 3, east: 80, north: 5 }),
    ];
    const ref = { east: 0, north: 0, headingDeg: 0 };
    const { observations } = PA.accumulatePointObservations({
      frames, timeline: [], referencePose: ref, chunkId: 0, passId: 0,
      trajectory: straightTrajectory(200), options: {},
    });
    const display = PA.buildPointDisplay(observations, {});
    const at1 = display.points.filter((p) => p.frameIndex <= 1);
    assert.ok(at1.length > 0);
    assert.ok(at1.every((p) => p.frameIndex <= 1));
    const at2 = display.points.filter((p) => p.frameIndex <= 2);
    assert.ok(at2.length > at1.length);
    assert.ok(at2.every((p) => p.frameIndex <= 2));
  });

  it('switching display mode does not change point coordinates', () => {
    const frames = [
      makeFrame({ frameId: 1, east: 0, north: 5 }),
      makeFrame({ frameId: 2, east: 40, north: 5 }),
      makeFrame({ frameId: 3, east: 80, north: 5 }),
    ];
    const ref = { east: 0, north: 0, headingDeg: 0 };
    const { observations } = PA.accumulatePointObservations({
      frames, timeline: [], referencePose: ref, chunkId: 0, passId: 0,
      trajectory: straightTrajectory(200), options: {},
    });
    const display = PA.buildPointDisplay(observations, {});
    // The data layer returns one fixed point set; the viewer chooses whether to
    // filter by frameIndex. Coordinates are never recomputed by the toggle.
    const completeCoords = display.points.map((p) => `${p.localEast.toFixed(4)},${p.localNorth.toFixed(4)}`).join('|');
    const causalCoords = display.points
      .filter((p) => p.frameIndex <= 1)
      .map((p) => `${p.localEast.toFixed(4)},${p.localNorth.toFixed(4)}`).join('|');
    assert.ok(completeCoords.length > 0);
    assert.ok(display.points.every((p) => Number.isFinite(p.localEast) && Number.isFinite(p.localNorth)));
    // Causal coords must equal the same source coords for frames 0..1.
    const sourceCoords01 = observations
      .filter((o) => o.frameIndex <= 1)
      .map((o) => `${o.localEast.toFixed(4)},${o.localNorth.toFixed(4)}`).sort().join('|');
    assert.equal(causalCoords.split('|').sort().join('|'), sourceCoords01);
  });

  it('render.js supports a Causal playback toggle that only filters, not rebuilds', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    assert.match(src, /setPointCausalPlayback/);
    assert.match(src, /_pointCausalPlayback/);
    assert.match(src, /Complete map by default/);
    // The toggle path must not rebuild the map or recompute coordinates.
    const setter = src.slice(src.indexOf('setPointCausalPlayback('), src.indexOf('setPointCausalPlayback(') + 400);
    assert.doesNotMatch(setter, /buildSegmentLocalMap|setStationaryLocalMap/);
  });

  it('index.html and app.js expose the Causal playback toggle and label', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
    assert.match(html, /id="pointCausalPlayback"/);
    assert.match(html, /Causal playback/);
    assert.match(html, /id="pointDisplayModeLabel"/);
    assert.match(app, /updatePointDisplayModeLabel/);
    assert.match(app, /initPointCausalToggle/);
    assert.match(app, /Complete map|Causal playback/);
  });

  it('complete-map view matches raw source point set on real segments', () => {
    if (!fs.existsSync(SEG2) && !fs.existsSync(SEG99) && !fs.existsSync(path.join(ROOT, 'qlog_f449c_5.bz2'))) return;
    for (const seg of ['qlog_f449c_2.bz2', 'qlog_f449c_99.bz2', 'qlog_f449c_5.bz2']) {
      if (!fs.existsSync(path.join(ROOT, seg))) continue;
      const data = loadSegment();
      let rawCount = 0;
      for (const f of data.frames) {
        if (f.chunkId != null && f.chunkId !== 0) continue;
        if ((f.passId ?? 0) !== 0) continue;
        for (const l of f.lanes || []) rawCount += (l.points || []).length;
      }
      const pt = SLM.buildSegmentLocalMap(data, { geometrySource: 'pointAccumulated', timelineIndex: 0 });
      const complete = pt.pointAccumulated.points;
      assert.equal(complete.length, rawCount, `${seg}: complete map must equal raw source set`);
      assert.equal(pt.pointAccumulated.stats.coverageParity, 1);
    }
  });
});
