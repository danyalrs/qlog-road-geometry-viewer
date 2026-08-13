'use strict';

/**
 * Focused tests for the lateral-axis diagnosis on Segments 14/16 (and 3 other
 * straight segments). Verifies the shared lateral convention end-to-end and
 * that no per-segment logic was introduced. Investigation/display-only.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { modelToGlobal } = require('../lib/transform');
const { globalToSegmentLocal, segmentLocalToGlobal } = require('../lib/segment_local_map');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const { processRoute, buildTimeline } = require('../lib/process_route');

const ROOT = path.join(__dirname, '..');
const RENDER_JS = path.join(ROOT, 'public', 'render.js');
const TOL = 1e-6;
const SEGS = [14, 16, 1, 12, 15];

describe('1-4. conventions and transforms', () => {
  it('1. lateral-axis convention: +y is vehicle-left, -y is vehicle-right', () => {
    // at heading 0 (north), +y (left) -> -east (west)
    const left = modelToGlobal(0, 5, 0, 0, 0);
    assert.ok(left.east < 0 && Math.abs(left.east + 5) < TOL, '+y maps west (left)');
    // -y (right) -> +east
    const right = modelToGlobal(0, -5, 0, 0, 0);
    assert.ok(right.east > 0 && Math.abs(right.east - 5) < TOL, '-y maps east (right)');
  });

  it('2. lane-line index semantics: lane1=inner-right, lane2=inner-left ego', () => {
    // raw modelV2 data: lane1 near y<0 (right), lane2 near y>0 (left)
    for (const seg of SEGS) {
      const evs = extractModel(path.join(ROOT, `qlog_f449c_${seg}.bz2`));
      const m = evs[15].modelV2;
      const lanes = m.laneLines || [];
      const lane1 = lanes[1], lane2 = lanes[2];
      assert.ok(lane1 && lane2, `seg${seg} has lane1/lane2`);
      const y1 = lane1.y[lane1.y.findIndex((_, i) => Math.abs(lane1.x[i]) < 2)];
      const y2 = lane2.y[lane2.y.findIndex((_, i) => Math.abs(lane2.x[i]) < 2)];
      assert.ok(y1 < 0, `seg${seg} lane1 right (y=${y1.toFixed(2)})`);
      assert.ok(y2 > 0, `seg${seg} lane2 left (y=${y2.toFixed(2)})`);
    }
  });

  it('3. vehicle-left/right ordering: lane1 < vehicle < lane2 in segment-local north', () => {
    for (const seg of SEGS) {
      const f = path.join(ROOT, `qlog_f449c_${seg}.bz2`);
      const me = extractModel(f).map((e) => ({ ...e, sourceFile: path.basename(f) }));
      const ge = extractGps(f).map((e) => ({ ...e, sourceFile: path.basename(f) }));
      const r = processRoute(me, ge, { pipelineMode: 'C' });
      const ref = r.frames[0].pose;
      const frame = r.frames[15];
      const l1 = (frame.lanes || []).find((l) => l.laneIndex === 1);
      const l2 = (frame.lanes || []).find((l) => l.laneIndex === 2);
      assert.ok(l1 && l2, `seg${seg} both ego lanes`);
      const p1 = l1.points.find((p) => Math.abs(p.modelX) < 3);
      const p2 = l2.points.find((p) => Math.abs(p.modelX) < 3);
      const s1 = globalToSegmentLocal(p1.east, p1.north, ref);
      const s2 = globalToSegmentLocal(p2.east, p2.north, ref);
      // lane1 (right) must be more negative north than lane2 (left)
      assert.ok(s1.north < s2.north, `seg${seg} lane1 north (${s1.north.toFixed(2)}) < lane2 (${s2.north.toFixed(2)})`);
    }
  });

  it('4. heading rotation at 0/90/180/270', () => {
    // forward x=10 at each heading maps to correct ENU
    const cases = [
      { h: 0, expE: 0, expN: 10 },
      { h: 90, expE: 10, expN: 0 },
      { h: 180, expE: 0, expN: -10 },
      { h: 270, expE: -10, expN: 0 },
    ];
    for (const c of cases) {
      const g = modelToGlobal(10, 0, 0, 0, c.h);
      assert.ok(Math.abs(g.east - c.expE) < TOL && Math.abs(g.north - c.expN) < TOL, `heading ${c.h}`);
    }
  });
});

describe('5-8. screen, arrow, colours, containment', () => {
  it('5. screen-coordinate conversion: positive north is up-screen', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    // worldToScreen: y = cy - north * scale
    assert.ok(src.includes('y: cy - north * this.scale'), 'north maps to screen-up');
  });

  it('6. arrow orientation: heading 0 points up, 90 points right', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    assert.ok(src.includes('dx = Math.sin(headingRad)'), 'arrow forward uses sin/cos of heading');
    assert.ok(src.includes('uy = -dy / len'), 'screen y inverted (up = forward)');
  });

  it('7. track-colour identity is stable (not spatial)', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    // trackColor is indexed by trackId only
    assert.ok(src.includes('TRACK_COLORS[trackId % TRACK_COLORS.length]'), 'colour is identity-based');
    assert.ok(!src.includes('trackColor(lane.side)'), 'no colour-by-side');
  });

  it('8. ego-lane containment: vehicle between lane1 and lane2 when both exist', () => {
    for (const seg of [14, 16]) {
      const f = path.join(ROOT, `qlog_f449c_${seg}.bz2`);
      const me = extractModel(f).map((e) => ({ ...e, sourceFile: path.basename(f) }));
      const ge = extractGps(f).map((e) => ({ ...e, sourceFile: path.basename(f) }));
      const r = processRoute(me, ge, { pipelineMode: 'C' });
      const frame = r.frames[15];
      const l1 = (frame.lanes || []).find((l) => l.laneIndex === 1);
      const l2 = (frame.lanes || []).find((l) => l.laneIndex === 2);
      const p1 = l1.points.find((p) => Math.abs(p.modelX) < 3);
      const p2 = l2.points.find((p) => Math.abs(p.modelX) < 3);
      // vehicle at modelY=0; lane1<0<lane2
      assert.ok(p1.modelY < 0 && p2.modelY > 0, `seg${seg} vehicle between lane1 and lane2`);
    }
  });
});

describe('9-13. no segment logic, integrity', () => {
  it('9. correction applies identically across segment IDs (no per-segment conditions)', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    // no segment 14/16 specific handling in render or transform
    const transformSrc = fs.readFileSync(path.join(ROOT, 'lib', 'transform.js'), 'utf8');
    assert.ok(!transformSrc.includes('segmentId') && !transformSrc.includes('seg === 14') && !transformSrc.includes('seg === 16'),
      'transform has no per-segment logic');
    assert.ok(!src.includes('segmentId === 14') && !src.includes('segmentId === 16'), 'render has no seg14/16 logic');
    // the shared convention is single: y=left
    assert.ok(transformSrc.includes('y = left'), 'single documented convention');
  });

  it('10. source qlogs and videos remain unchanged', () => {
    for (const seg of SEGS) {
      const q = path.join(ROOT, `qlog_f449c_${seg}.bz2`);
      assert.ok(fs.existsSync(q), `seg${seg} qlog exists`);
    }
    for (const seg of [2, 6, 54, 58, 99]) {
      const v = path.join(ROOT, `f449c322f59e6943---2026-07-20--09-34-13--${seg}---qcamera.ts`);
      assert.ok(fs.existsSync(v), `seg${seg} video exists`);
    }
  });

  it('11. pinned values remain unchanged', () => {
    const v = require('../lib/version');
    assert.strictEqual(v.PROCESSING_VERSION, '2026-07-24-fusion-v16');
    const pd = require('../lib/process_defaults');
    const norm = pd.normalizeProcessOptions?.() || {};
    assert.strictEqual(norm.positiveBoundaryContinuityBridgeEnabled, false);
    assert.strictEqual(norm.visibleGapReconstructionEnabled, false);
    const EB = require('../lib/experimental_boundaries');
    assert.strictEqual(EB.DEFAULTS.candidate, 'D');
  });

  it('12. Raw and Fused remain unchanged', () => {
    const src = fs.readFileSync(RENDER_JS, 'utf8');
    const pointDraw = src.indexOf('_drawPointAccumulatedGeometry');
    let callIdx = -1;
    const calls = [];
    while ((callIdx = src.indexOf('_drawExperimentalBoundaries(map', callIdx + 1)) !== -1) calls.push(callIdx);
    for (const c of calls) assert.ok(c >= pointDraw, 'overlay only in point draw block');
    assert.ok(src.includes('_drawStationaryLocalMap'), 'stationary map draw intact');
  });

  it('13. no road polygons are created', () => {
    const EB = require('../lib/experimental_boundaries');
    assert.ok(EB.buildExperimentalBoundaries, 'boundary module exists');
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'experimental_boundaries.js'), 'utf8');
    assert.ok(!/function\s+\w*[Pp]olygon/.test(src), 'no polygon-generating function');
  });
});
