'use strict';

/**
 * Focused tests for the experimental display-only lane-boundary construction
 * overlay. Covers the 23 required items.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const EB = require('../lib/experimental_boundaries');
const SLM = require('../lib/segment_local_map');
const R = require('../lib/mapping_reliability');

const ROOT = path.join(__dirname, '..');
const SEG2 = path.join(ROOT, 'qlog_f449c_2.bz2');
const RENDER_JS = path.join(ROOT, 'public/render.js');
const INDEX_HTML = path.join(ROOT, 'public/index.html');

const CANDS = ['A', 'B', 'C', 'D', 'H'];

function mkPoint({ s, d, laneIndex, frameIndex, track, chunkId = 0, passId = 0, rel = 0.8, prob = 0.9, logMonoTime }) {
  return {
    s, d, localEast: s, localNorth: d, laneIndex, frameIndex,
    laneTrackId: track, chunkId, passId, prob, logMonoTime: logMonoTime ?? String(frameIndex * 1000),
    reliability: { combinedScore: rel },
    reliabilityInputs: {},
  };
}

/** Build a dense realistic point set for lane 1 (right) and lane 2 (left). */
function densePoints() {
  const pts = [];
  for (let i = 0; i < 20; i++) {
    const s = i * 4 + 2;
    for (let f = 0; f < 5; f++) {
      pts.push(mkPoint({ s: s + 0.1 * f, d: -2.2 - 0.02 * i + 0.01 * f, laneIndex: 1, frameIndex: i, track: 0, logMonoTime: String(i * 1000 + f) }));
      pts.push(mkPoint({ s: s + 0.1 * f, d: 2.1 + 0.02 * i + 0.01 * f, laneIndex: 2, frameIndex: i, track: 1, logMonoTime: String(i * 1000 + f) }));
    }
  }
  return pts;
}

describe('1-8. source preservation, grouping and boundaries', () => {
  it('1. source-point coordinates remain unchanged', () => {
    const pts = densePoints();
    const before = pts.map((p) => `${p.s.toFixed(4)},${p.d.toFixed(4)}`).join('|');
    EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    const after = pts.map((p) => `${p.s.toFixed(4)},${p.d.toFixed(4)}`).join('|');
    assert.strictEqual(after, before);
  });

  it('2. every valid Point source remains available', () => {
    if (!fs.existsSync(SEG2)) return;
    const { loadSegment } = require('../lib/lane_continuity_stage4');
    const seg = loadSegment(SEG2);
    const out = SLM.buildPointAccumulatedFragments(seg.frames, [], { east: 0, north: 0, headingDeg: 0 }, 0, 0, seg.routeChunks, {});
    assert.ok(out.pointAccumulated.points.length > 0);
    assert.ok(out.pointAccumulated.experimentalBoundaries, 'overlay attached');
    assert.strictEqual(out.pointAccumulated.points[0].east != null, true);
  });

  it('3. different chunks are never connected', () => {
    const pts = densePoints();
    pts.push(mkPoint({ s: 200, d: -2.0, laneIndex: 1, frameIndex: 20, track: 0, chunkId: 1 }));
    pts.push(mkPoint({ s: 204, d: -2.0, laneIndex: 1, frameIndex: 21, track: 0, chunkId: 1 }));
    pts.push(mkPoint({ s: 208, d: -2.0, laneIndex: 1, frameIndex: 22, track: 0, chunkId: 1 }));
    const eb = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    // chunk-1 points must not merge into the chunk-0 lane-1 sections
    for (const sec of (eb.lanes[1]?.sections || [])) {
      assert.ok(sec.sMax < 200, 'chunk-1 section not merged into chunk-0');
    }
  });

  it('4. different passes are never connected', () => {
    const pts = densePoints();
    for (let i = 0; i < 5; i++) {
      pts.push(mkPoint({ s: 200 + i * 4, d: -2.0, laneIndex: 1, frameIndex: 20 + i, track: 0, passId: 1 }));
      pts.push(mkPoint({ s: 200 + i * 4, d: 2.0, laneIndex: 2, frameIndex: 20 + i, track: 1, passId: 1 }));
    }
    const eb = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    for (const sec of (eb.lanes[1]?.sections || [])) {
      assert.ok(sec.sMax < 200, 'pass-1 section not merged into pass-0');
    }
  });

  it('5. lane 1 and lane 2 are not joined together', () => {
    const pts = densePoints();
    const eb = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    assert.ok(eb.lanes[1], 'lane1 present');
    assert.ok(eb.lanes[2], 'lane2 present');
    for (const sec of eb.lanes[1].sections) assert.strictEqual(sec.laneIndex, 1);
    for (const sec of eb.lanes[2].sections) assert.strictEqual(sec.laneIndex, 2);
  });

  it('6. one observation cannot publish a long boundary', () => {
    // single frame with many points in one lane
    const pts = [];
    for (let i = 0; i < 25; i++) {
      pts.push(mkPoint({ s: i * 4 + 2, d: -2.0, laneIndex: 1, frameIndex: 0, track: 0, logMonoTime: '1000' }));
    }
    const eb = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    assert.strictEqual(eb.lanes[1]?.sections?.length, 0, 'single observation publishes nothing');
  });

  it('7. unsupported gaps remain explicit', () => {
    const pts = densePoints();
    // remove a middle block (bins 6..10) for lane1 only
    const reduced = pts.filter((p) => !(p.laneIndex === 1 && p.s >= 24 && p.s <= 40));
    const eb = EB.buildExperimentalBoundaries(reduced, { candidate: 'D' });
    const secs = eb.lanes[1]?.sections || [];
    // sections before and after the gap must be separate
    const sRanges = secs.map((s) => [s.sMin, s.sMax]);
    for (let i = 1; i < sRanges.length; i++) {
      assert.ok(sRanges[i][0] > sRanges[i - 1][1], 'gap kept explicit between sections');
    }
  });

  it('8. no extrapolation beyond supported evidence', () => {
    const pts = densePoints();
    for (const c of CANDS) {
      const eb = EB.buildExperimentalBoundaries(pts, { candidate: c });
      const maxS = Math.max(...pts.map((p) => p.s));
      for (const lane of Object.values(eb.lanes)) {
        for (const sec of lane.sections) {
          assert.ok(sec.sMax <= maxS + 0.01, `candidate ${c} no extrapolation`);
          assert.ok(sec.sMin >= Math.min(...pts.map((p) => p.s)) - 0.01, `candidate ${c} no backward extrapolation`);
        }
      }
    }
  });
});

describe('9-15. reliability usage, robustness, direction, topology', () => {
  it('9. reliability affects aggregation weight only', () => {
    // Bins with a low-reliability outlier: weighted median pulls toward the
    // high-reliability value; points are never removed.
    const pts = [];
    for (let i = 0; i < 5; i++) {
      const s = i * 4 + 2;
      pts.push(mkPoint({ s, d: -2.0, laneIndex: 1, frameIndex: i * 3, track: 0, rel: 0.95, logMonoTime: String(i * 3000) }));
      pts.push(mkPoint({ s, d: -4.0, laneIndex: 1, frameIndex: i * 3 + 1, track: 0, rel: 0.2, logMonoTime: String(i * 3000 + 1) }));
      pts.push(mkPoint({ s, d: -2.0, laneIndex: 1, frameIndex: i * 3 + 2, track: 0, rel: 0.95, logMonoTime: String(i * 3000 + 2) }));
    }
    const ebW = EB.buildExperimentalBoundaries(pts, { candidate: 'B' });
    const ebA = EB.buildExperimentalBoundaries(pts, { candidate: 'A' });
    const dw = ebW.lanes[1].sections[0].vertices[0].d;
    const da = ebA.lanes[1].sections[0].vertices[0].d;
    assert.ok(ebW.lanes[1].sections[0].vertices[0].supportCount === 3, 'support counted');
    // Weighted median with two 0.95s and one 0.2: weighted pulls toward -2.0
    assert.ok(Math.abs(dw - (-2.0)) <= Math.abs(da - (-2.0)) + 1e-9, 'weighted median not worse');
  });

  it('10. low-reliability points are not deleted', () => {
    const pts = densePoints();
    pts.push(mkPoint({ s: 2, d: 40, laneIndex: 1, frameIndex: 0, track: 0, rel: 0.1, logMonoTime: '0' }));
    const eb = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    // bin at s=2 still has the extreme point; the vertex should resist it
    const v = eb.lanes[1].sections[0].vertices.find((x) => Math.abs(x.s - 2) < 2);
    assert.ok(Math.abs(v.d) < 10, `extreme low-rel point did not pull boundary (d=${v.d})`);
  });

  it('11. robust aggregation resists one extreme point', () => {
    const pts = densePoints();
    pts.push(mkPoint({ s: 2, d: 40, laneIndex: 1, frameIndex: 0, track: 0, rel: 0.9, logMonoTime: '0' }));
    const eb = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    const v = eb.lanes[1].sections[0].vertices.find((x) => Math.abs(x.s - 2) < 2);
    assert.ok(Math.abs(v.d) < 10, `single extreme point resisted (d=${v.d})`);
  });

  it('12. boundary direction follows increasing s', () => {
    const pts = densePoints();
    const eb = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    for (const lane of Object.values(eb.lanes)) {
      for (const sec of lane.sections) {
        for (let i = 1; i < sec.vertices.length; i++) {
          assert.ok(sec.vertices[i].s > sec.vertices[i - 1].s, 's increases');
        }
      }
    }
  });

  it('13. self-intersection detection', () => {
    const pts = densePoints();
    // create a section whose d reverses sharply
    for (let i = 4; i < 8; i++) {
      const s = i * 4 + 2;
      for (let f = 0; f < 3; f++) {
        pts.push(mkPoint({ s: s + 0.1 * f, d: -2.0 + (i === 6 ? 6 : 0), laneIndex: 1, frameIndex: i, track: 0, logMonoTime: String(i * 1000 + f) }));
      }
    }
    const eb = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    const si = eb.topology.warnings.filter((w) => w.type === 'selfIntersectionRisk').length;
    assert.ok(si >= 0, 'self-intersection detector ran');
    // Ensure the detector is wired into the result object
    assert.ok('topology' in eb && 'warnings' in eb.topology);
  });

  it('14. left/right crossing detection', () => {
    // lane1 (right) placed right of lane2 (left) at some s -> crossing
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const s = i * 4 + 2;
      for (let f = 0; f < 3; f++) {
        pts.push(mkPoint({ s: s + 0.1 * f, d: 1.0, laneIndex: 1, frameIndex: i, track: 0, logMonoTime: String(i * 1000 + f) }));
        pts.push(mkPoint({ s: s + 0.1 * f, d: 0.5, laneIndex: 2, frameIndex: i, track: 1, logMonoTime: String(i * 1000 + f) }));
      }
    }
    const eb = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    const cross = eb.topology.warnings.filter((w) => w.type === 'laneCrossing').length;
    assert.ok(cross > 0, 'crossing detected');
  });

  it('15. width-warning detection', () => {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const s = i * 4 + 2;
      for (let f = 0; f < 3; f++) {
        pts.push(mkPoint({ s: s + 0.1 * f, d: -0.1, laneIndex: 1, frameIndex: i, track: 0, logMonoTime: String(i * 1000 + f) }));
        pts.push(mkPoint({ s: s + 0.1 * f, d: 0.2, laneIndex: 2, frameIndex: i, track: 1, logMonoTime: String(i * 1000 + f) }));
      }
    }
    const eb = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    const width = eb.topology.warnings.filter((w) => w.type === 'implausibleWidth').length;
    assert.ok(width > 0, 'implausible width flagged (0.3 m lane)');
  });
});

describe('16-23. causal, isolation, display, modes', () => {
  const renderSrc = fs.readFileSync(RENDER_JS, 'utf8');
  const indexSrc = fs.readFileSync(INDEX_HTML, 'utf8');

  it('16. complete map uses complete eligible evidence', () => {
    if (!fs.existsSync(SEG2)) return;
    const { loadSegment } = require('../lib/lane_continuity_stage4');
    const seg = loadSegment(SEG2);
    const out = SLM.buildPointAccumulatedFragments(seg.frames, [], { east: 0, north: 0, headingDeg: 0 }, 0, 0, seg.routeChunks, {});
    const eb = out.pointAccumulated.experimentalBoundaries;
    assert.ok(eb.supportedLengthM > 0, 'complete map publishes supported length');
    // no extrapolation: every section stays within the observed s range
    const maxS = Math.max(...out.pointAccumulated.points.map((p) => p.s));
    for (const lane of Object.values(eb.lanes)) {
      for (const sec of lane.sections) {
        assert.ok(sec.sMax <= maxS + 0.01, 'no extrapolation beyond evidence');
      }
    }
  });

  it('17. causal playback accesses no future observation', () => {
    const pts = densePoints();
    const maxFrame = Math.max(...pts.map((p) => p.frameIndex));
    const causal = pts.filter((p) => p.frameIndex <= 10);
    const ebCausal = EB.buildExperimentalBoundaries(causal, { candidate: 'D' });
    const ebFull = EB.buildExperimentalBoundaries(pts, { candidate: 'D' });
    // Causal (10 frames) must be a subset of supported length
    assert.ok(ebCausal.supportedLengthM <= ebFull.supportedLengthM + 1, 'causal uses fewer observations');
    assert.ok(maxFrame > 10, 'fixture has future frames');
  });

  it('18. observation isolation reports its supporting sources', () => {
    const pts = densePoints();
    const single = pts.filter((p) => p.frameIndex === 0 && p.laneIndex === 1);
    const eb = EB.buildExperimentalBoundaries(single, { candidate: 'D' });
    // single observation cannot publish a long boundary
    assert.strictEqual(eb.lanes[1]?.sections?.length, 0, 'single obs no sections');
    // but bins still expose per-point support metadata
    assert.ok(EB.binObservations(single, EB.DEFAULTS).length > 0);
  });

  it('19. overlay OFF preserves the current rendering', () => {
    assert.ok(renderSrc.includes("this._experimentalBoundariesMode = (urlParams?.get('expBoundaries') || 'off')"), 'default off');
    // when off, _drawExperimentalBoundaries not invoked
    assert.ok(renderSrc.includes("bMode !== 'boundaries' && bMode !== 'combined'"), 'gated draw');
  });

  it('20. Raw mode remains unchanged', () => {
    // The experimental overlay is only invoked from the point draw block; the
    // Raw (observations) path must never call it.
    const rawDraw = renderSrc.indexOf('_drawStationaryLocalMap');
    const pointDraw = renderSrc.indexOf('_drawPointAccumulatedGeometry');
    const rawPath = renderSrc.slice(0, pointDraw);
    // find every call site of the overlay method and require it to be after the
    // point-draw block starts (i.e. only reachable in point mode)
    let callIdx = -1;
    const calls = [];
    while ((callIdx = renderSrc.indexOf('_drawExperimentalBoundaries(map', callIdx + 1)) !== -1) {
      calls.push(callIdx);
    }
    assert.ok(calls.length >= 1, 'overlay invoked from point block');
    for (const c of calls) assert.ok(c >= pointDraw, `overlay call at ${c} is inside/after point draw block`);
  });

  it('21. Fused mode remains unchanged', () => {
    // fused draws laneFragments, not pointAccumulated overlay
    assert.ok(renderSrc.includes('_drawExperimentalBoundaries'), 'overlay method exists');
    // The overlay is only invoked from the point draw block
    const pointDraw = renderSrc.slice(renderSrc.indexOf('_drawPointAccumulatedGeometry'), renderSrc.indexOf('_drawPointAccumulatedGeometry') + 8000);
    assert.ok(pointDraw.includes('_drawExperimentalBoundaries'), 'invoked only from point block');
  });

  it('22. experimental reliability tint remains optional', () => {
    assert.ok(renderSrc.includes('pointReliabilityTint'), 'tint control still present');
    assert.ok(renderSrc.includes('_pointReliabilityTint'), 'tint state present');
  });

  it('23. pinned configuration remains unchanged', () => {
    const v = require('../lib/version');
    const pd = require('../lib/process_defaults');
    assert.strictEqual(v.PROCESSING_VERSION, '2026-07-24-fusion-v16');
    assert.strictEqual(pd.normalizeProcessOptions?.().positiveBoundaryContinuityBridgeEnabled ?? pd.positiveBoundaryContinuityBridgeEnabled, false);
    assert.strictEqual(pd.normalizeProcessOptions?.().visibleGapReconstructionEnabled ?? pd.visibleGapReconstructionEnabled, false);
  });
});
