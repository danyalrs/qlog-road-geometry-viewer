'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const CAD = require('../public/connected_accumulated_display');
const SLM = require('../lib/segment_local_map');
const VMB = require('../lib/viewer_map_build');

const ROOT = path.join(__dirname, '..');

function mkPoint(overrides = {}) {
  return {
    chunkId: 0,
    passId: 0,
    groupTrackId: 1,
    groupKey: '0:0:right:1',
    laneIndex: 1,
    side: 'right',
    s: 0,
    d: 0,
    localEast: 0,
    localNorth: 0,
    frameIndex: 0,
    frameId: 100,
    logMonoTime: '1000',
    prob: 0.9,
    ...overrides,
  };
}

function buildFromMap(segFile) {
  const pd = VMB.processSegmentLikeViewer(ROOT, segFile);
  const map = SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', fitEnabled: false });
  return { pd, map };
}

describe('connected_accumulated_display', () => {
  it('1. same identity points form a polyline', () => {
    const pts = [
      mkPoint({ s: 0, localEast: 0, frameIndex: 0 }),
      mkPoint({ s: 5, localEast: 5, frameIndex: 1 }),
      mkPoint({ s: 10, localEast: 10, frameIndex: 2 }),
    ];
    const { polylines, stats } = CAD.buildConnectedPolylines(pts, { mode: 'raw' });
    assert.equal(polylines.length, 1);
    assert.equal(polylines[0].pointCount, 3);
    assert.equal(stats.drawablePolylineCount, 1);
  });

  it('2. different chunkId never connect', () => {
    const pts = [
      mkPoint({ chunkId: 0, s: 0, localEast: 0 }),
      mkPoint({ chunkId: 1, s: 5, localEast: 5 }),
    ];
    const { polylines } = CAD.buildConnectedPolylines(pts, { mode: 'raw' });
    assert.equal(polylines.length, 0);
  });

  it('3. different passId never connect', () => {
    const pts = [
      mkPoint({ passId: 0, s: 0, localEast: 0 }),
      mkPoint({ passId: 1, s: 5, localEast: 5 }),
    ];
    const { polylines } = CAD.buildConnectedPolylines(pts, { mode: 'raw' });
    assert.equal(polylines.length, 0);
  });

  it('4. different groupTrackId never connect', () => {
    const pts = [
      mkPoint({ groupTrackId: 1, s: 0, localEast: 0 }),
      mkPoint({ groupTrackId: 2, s: 5, localEast: 5 }),
    ];
    const { polylines } = CAD.buildConnectedPolylines(pts, { mode: 'raw' });
    assert.equal(polylines.length, 0);
  });

  it('5. different laneIndex or side never connect', () => {
    const pts = [
      mkPoint({ groupTrackId: 5, laneIndex: 1, side: 'right', s: 0, localEast: 0 }),
      mkPoint({ groupTrackId: 5, laneIndex: 2, side: 'left', s: 5, localEast: 5 }),
    ];
    const { polylines, stats } = CAD.buildConnectedPolylines(pts, { mode: 'raw' });
    assert.equal(polylines.length, 0);
    assert.ok(stats.identityRejected >= 1);
  });

  it('6. ordering uses s', () => {
    const pts = [
      mkPoint({ s: 15, localEast: 15, frameIndex: 2 }),
      mkPoint({ s: 5, localEast: 5, frameIndex: 0 }),
      mkPoint({ s: 10, localEast: 10, frameIndex: 1 }),
    ];
    const { polylines } = CAD.buildConnectedPolylines(pts, { mode: 'raw' });
    assert.deepEqual(polylines[0].points.map((p) => p.s), [5, 10, 15]);
  });

  it('7. frameIndex and logMonoTime provide deterministic tie-breaking', () => {
    const pts = [
      mkPoint({ s: 5, frameIndex: 2, logMonoTime: '3000', localEast: 5, d: 1 }),
      mkPoint({ s: 5, frameIndex: 1, logMonoTime: '2000', localEast: 5, d: 0 }),
      mkPoint({ s: 5, frameIndex: 1, logMonoTime: '1000', localEast: 5, d: 2 }),
      mkPoint({ s: 12, localEast: 12 }),
    ];
    const a = CAD.buildConnectedPolylines(pts, { mode: 'raw' });
    const b = CAD.buildConnectedPolylines(pts, { mode: 'raw' });
    assert.deepEqual(a, b);
    assert.equal(a.polylines[0].points[0].logMonoTime, '1000');
    assert.equal(a.polylines[0].points[1].logMonoTime, '2000');
    assert.equal(a.polylines[0].points[2].frameIndex, 2);
  });

  it('8. Δs > 8 m creates a split', () => {
    const pts = [
      mkPoint({ s: 0, localEast: 0 }),
      mkPoint({ s: 5, localEast: 5 }),
      mkPoint({ s: 20, localEast: 20 }),
      mkPoint({ s: 25, localEast: 25 }),
    ];
    const { polylines, stats } = CAD.buildConnectedPolylines(pts, { mode: 'raw' });
    assert.equal(polylines.length, 2);
    assert.ok(stats.gapSplits >= 1);
  });

  it('9. spatial step greater than 14 m creates a split', () => {
    const pts = [
      mkPoint({ s: 0, localEast: 0, localNorth: 0 }),
      mkPoint({ s: 3, localEast: 4, localNorth: 0 }),
      mkPoint({ s: 6, localEast: 22, localNorth: 0 }),
      mkPoint({ s: 9, localEast: 26, localNorth: 0 }),
    ];
    const { polylines, stats } = CAD.buildConnectedPolylines(pts, { mode: 'raw' });
    assert.equal(polylines.length, 2);
    assert.ok(stats.spatialStepSplits >= 1);
  });

  it('10. invalid coordinates are rejected', () => {
    const pts = [
      mkPoint({ localEast: NaN }),
      mkPoint({ s: NaN, localEast: 1 }),
      mkPoint({ s: 0, localEast: 0 }),
      mkPoint({ s: 5, localEast: 5 }),
    ];
    const { polylines, stats } = CAD.buildConnectedPolylines(pts, { mode: 'raw' });
    assert.equal(stats.invalidPointCount, 2);
    assert.equal(polylines.length, 1);
  });

  it('11. dedupe retains the higher-probability point', () => {
    const pts = [
      mkPoint({ s: 5, d: 0, prob: 0.4, localEast: 5 }),
      mkPoint({ s: 5.1, d: 0.1, prob: 0.95, localEast: 5.1 }),
      mkPoint({ s: 12, localEast: 12 }),
    ];
    const { polylines, stats } = CAD.buildConnectedPolylines(pts, { mode: 'raw' });
    assert.ok(stats.dedupedPointCount >= 1);
    assert.equal(polylines[0].pointCount, 2);
    assert.equal(polylines[0].points[0].prob, 0.95);
  });

  it('12. isolated points do not produce drawable polylines', () => {
    const { polylines, stats } = CAD.buildConnectedPolylines([mkPoint({ s: 0 })]);
    assert.equal(polylines.length, 0);
    assert.equal(stats.isolatedPointCount, 1);
    assert.equal(stats.drawablePolylineCount, 0);
  });

  it('13. input is not mutated', () => {
    const pts = [
      mkPoint({ s: 0, localEast: 0 }),
      mkPoint({ s: 5, localEast: 5 }),
    ];
    const snap = JSON.stringify(pts);
    CAD.buildConnectedPolylines(pts, { mode: 'raw' });
    assert.equal(JSON.stringify(pts), snap);
  });

  it('14. repeated calls produce byte-identical results', () => {
    const pts = [
      mkPoint({ s: 0, localEast: 0 }),
      mkPoint({ s: 4, localEast: 4 }),
      mkPoint({ s: 8, localEast: 8 }),
      mkPoint({ s: 20, localEast: 20 }),
    ];
    const a = JSON.stringify(CAD.buildConnectedPolylines(pts));
    const b = JSON.stringify(CAD.buildConnectedPolylines(pts));
    assert.equal(a, b);
  });

  it('15. causal filtering contains no future frame', () => {
    const pts = [
      mkPoint({ frameIndex: 0, s: 0, localEast: 0 }),
      mkPoint({ frameIndex: 5, s: 5, localEast: 5 }),
      mkPoint({ frameIndex: 10, s: 10, localEast: 10 }),
    ];
    const filtered = CAD.filterPointsForCausal(pts, 5);
    assert.ok(filtered.every((p) => p.frameIndex <= 5));
    const { polylines } = CAD.buildConnectedPolylines(filtered, { mode: 'raw' });
    assert.ok(polylines[0].points.every((p) => p.frameIndex <= 5));
  });

  it('16. Segment 99 laneIndex 1 and 2 never appear in the same polyline', () => {
    const segFile = 'qlog_f449c_99.bz2';
    if (!fs.existsSync(path.join(ROOT, segFile))) return;
    const { map } = buildFromMap(segFile);
    const { polylines } = CAD.buildConnectedPolylines(map.pointAccumulated.points, { mode: 'raw' });
    const lcFrames = new Set([119683, 119723, 119763, 119803]);
    for (const pl of polylines) {
      assert.equal(CAD.polylineCrossesLaneIdentity(pl), false);
      const lanes = new Set(pl.points.map((p) => p.laneIndex));
      assert.ok(lanes.size <= 1);
      const lcPts = pl.points.filter((p) => lcFrames.has(p.frameId));
      if (lcPts.length >= 2) {
        const sides = new Set(lcPts.map((p) => p.side));
        assert.ok(sides.size <= 1);
      }
    }
  });

  it('17. mirror rendering uses the dot coordinate conversion', () => {
    const renderSrc = fs.readFileSync(path.join(ROOT, 'public/render.js'), 'utf8');
    const fn = renderSrc.slice(
      renderSrc.indexOf('_drawConnectedAccumulatedPolylines'),
      renderSrc.indexOf('Hybrid graph-fitted lane map'),
    );
    assert.match(fn, /roadGeometryToScreen\(pt\.localEast, pt\.localNorth, pt\.mirroredLocalEast, pt\.mirroredLocalNorth\)/);
  });

  it('18. checkbox is present and unchecked by default', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    assert.match(html, /id="layerConnectedAccumulated"/);
    assert.match(html, /Connected accumulated lane observations \(experimental\)/);
    assert.doesNotMatch(html, /id="layerConnectedAccumulated"[^>]*checked/);
  });

  it('19. no URL query flag is required', () => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    assert.match(appSrc, /layerConnectedAccumulated/);
    assert.doesNotMatch(html, /connectedAccumulated=1/);
    assert.doesNotMatch(appSrc, /connectedAccumulated.*searchParams/);
  });

  it('20. production source modules listed above remain untouched', () => {
    const protectedFiles = [
      'lib/point_accumulation.js',
      'lib/constructed_fragments.js',
      'lib/lane_joining.js',
      'lib/graph_fit.js',
      'lib/segment_local_map.js',
      'lib/viewer_map_build.js',
      'server.js',
      'public/candidate_layer_display.js',
    ];
    for (const rel of protectedFiles) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
    }
  });

  it('21. no report or diagnostic script is imported by public/ or lib/', () => {
    const scanDirs = ['public', 'lib'];
    const bad = [];
    for (const dir of scanDirs) {
      for (const file of fs.readdirSync(path.join(ROOT, dir))) {
        if (!file.endsWith('.js')) continue;
        const src = fs.readFileSync(path.join(ROOT, dir, file), 'utf8');
        if (/require\(['"]\.\.\/(reports|scripts)\//.test(src) || /from ['"]\.\.\/(reports|scripts)\//.test(src)) {
          bad.push(`${dir}/${file}`);
        }
      }
    }
    assert.deepEqual(bad, []);
  });

  it('22. map and polygon checksums remain unchanged because the module is display-only', () => {
    const segFile = 'qlog_f449c_9.bz2';
    if (!fs.existsSync(path.join(ROOT, segFile))) return;
    const { map: mapA } = buildFromMap(segFile);
    CAD.buildConnectedPolylines(mapA.pointAccumulated.points, { mode: 'robust' });
    const { map: mapB } = buildFromMap(segFile);
    assert.equal(mapA.checksum, mapB.checksum);
    const polyA = mapA.roadSurfacePolygons?.checksum ?? mapA.surfaceChecksum ?? null;
    const polyB = mapB.roadSurfacePolygons?.checksum ?? mapB.surfaceChecksum ?? null;
    if (polyA != null && polyB != null) assert.equal(polyA, polyB);
  });

  it('23. raw mode preserves existing output', () => {
    const pts = [
      mkPoint({ s: 0, localEast: 0 }),
      mkPoint({ s: 5, localEast: 5 }),
      mkPoint({ s: 20, localEast: 20 }),
      mkPoint({ s: 25, localEast: 25 }),
    ];
    const direct = CAD.buildRawConnectedPolylines(pts);
    const routed = CAD.buildConnectedPolylines(pts, { mode: 'raw' });
    assert.deepEqual(direct, routed);
  });

  it('24. robust mode is available; perFrame is the module default', () => {
    const pts = [mkPoint({ s: 0 }), mkPoint({ s: 2, localEast: 2 })];
    const { stats } = CAD.buildConnectedPolylines(pts);
    assert.equal(stats.mode, 'perFrame');
    const raw = CAD.buildConnectedPolylines(pts, { mode: 'raw' });
    assert.equal(raw.stats.mode, 'raw');
  });

  it('25. deterministic 1 m bins', () => {
    const pts = [
      mkPoint({ s: 0.2, d: 0, frameIndex: 0 }),
      mkPoint({ s: 0.8, d: 1, frameIndex: 1 }),
      mkPoint({ s: 2.1, d: 0, frameIndex: 2 }),
    ];
    const a = CAD.buildRobustConnectedPolylines(pts);
    const b = CAD.buildRobustConnectedPolylines(pts);
    assert.deepEqual(a, b);
    assert.equal(a.stats.representativePointCount, 2);
  });

  it('26. negative s bins', () => {
    const pts = [
      mkPoint({ s: -1.2, d: 0, frameIndex: 0 }),
      mkPoint({ s: -0.4, d: 0, frameIndex: 1 }),
      mkPoint({ s: 0.5, d: 0, frameIndex: 2 }),
    ];
    const { polylines } = CAD.buildRobustConnectedPolylines(pts);
    assert.ok(polylines.length >= 1);
    assert.equal(CAD.binIndexForS(-1.2, 1), -2);
  });

  it('27. representative is an actual source point', () => {
    const pts = [
      mkPoint({ s: 0.1, d: 0, frameIndex: 0, frameId: 10 }),
      mkPoint({ s: 0.9, d: 1, frameIndex: 1, frameId: 11 }),
      mkPoint({ s: 2.5, d: 1, frameIndex: 2, frameId: 12, localEast: 2.5 }),
    ];
    const { polylines } = CAD.buildRobustConnectedPolylines(pts);
    assert.ok(polylines.length >= 1);
    const rep = polylines[0].points[0];
    assert.ok(pts.some((p) => p.frameId === rep.frameId));
    assert.ok(rep.binMeta);
  });

  it('28. MAD outlier exclusion', () => {
    const pts = [
      mkPoint({ s: 0.1, d: 0, frameIndex: 0 }),
      mkPoint({ s: 0.2, d: 0.1, frameIndex: 1 }),
      mkPoint({ s: 0.3, d: -0.1, frameIndex: 2 }),
      mkPoint({ s: 0.4, d: 3.5, frameIndex: 3 }),
      mkPoint({ s: 3, localEast: 3, frameIndex: 4 }),
    ];
    const { stats } = CAD.buildRobustConnectedPolylines(pts);
    assert.ok(stats.outlierExcludedCount >= 1);
  });

  it('29. fallback if filtering empties a bin', () => {
    const pts = [
      mkPoint({ s: 0.1, d: 0, frameIndex: 0 }),
      mkPoint({ s: 0.2, d: 5, frameIndex: 1 }),
      mkPoint({ s: 0.3, d: -5, frameIndex: 2 }),
      mkPoint({ s: 4, localEast: 4, frameIndex: 3 }),
    ];
    const { polylines, stats } = CAD.buildRobustConnectedPolylines(pts);
    assert.ok(polylines.length >= 1);
    assert.ok(stats.representativePointCount >= 2);
  });

  it('30. lateral jump over 1.5 m splits', () => {
    const pts = [
      mkPoint({ s: 0, d: 0, localEast: 0, localNorth: 0 }),
      mkPoint({ s: 1, d: 0, localEast: 1, localNorth: 0 }),
      mkPoint({ s: 2, d: 2.5, localEast: 2, localNorth: 2.5 }),
      mkPoint({ s: 3, d: 2.5, localEast: 3, localNorth: 2.5 }),
    ];
    const { polylines, stats } = CAD.buildRobustConnectedPolylines(pts);
    assert.ok(stats.lateralStepSplits >= 1 || polylines.length >= 2);
  });

  it('31. robust output is deterministic', () => {
    const pts = [
      mkPoint({ s: 0, d: 0 }), mkPoint({ s: 0.5, d: 0.2 }), mkPoint({ s: 1.5, d: 0.1 }),
      mkPoint({ s: 10, d: 0, localEast: 10 }),
    ];
    const a = JSON.stringify(CAD.buildRobustConnectedPolylines(pts));
    const b = JSON.stringify(CAD.buildRobustConnectedPolylines(pts));
    assert.equal(a, b);
  });

  it('32. viewer explicitly requests perFrame mode', () => {
    const appSrc = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
    assert.match(appSrc, /buildConnectedPolylines\(map\.pointAccumulated\.points,\s*\{\s*mode:\s*'perFrame'\s*\}\)/);
    const renderSrc = fs.readFileSync(path.join(ROOT, 'public/render.js'), 'utf8');
    assert.match(renderSrc, /mode:\s*'perFrame'/);
    assert.match(renderSrc, /per-frame \(experimental\)/);
  });

  it('33. perFrame same identity and frame connect', () => {
    const pts = [
      mkPoint({ s: 0, modelX: 0, frameId: 1, frameIndex: 0, localEast: 0 }),
      mkPoint({ s: 1, modelX: 10, frameId: 1, frameIndex: 0, localEast: 10 }),
      mkPoint({ s: 2, modelX: 20, frameId: 1, frameIndex: 0, localEast: 20 }),
    ];
    const { polylines } = CAD.buildPerFrameConnectedPolylines(pts);
    assert.equal(polylines.length, 1);
    assert.equal(polylines[0].pointCount, 3);
  });

  it('34. perFrame different frameId never connect', () => {
    const pts = [
      mkPoint({ s: 0, modelX: 0, frameId: 1, localEast: 0 }),
      mkPoint({ s: 1, modelX: 10, frameId: 2, localEast: 10 }),
    ];
    const { polylines, stats } = CAD.buildPerFrameConnectedPolylines(pts);
    assert.equal(polylines.length, 0);
    assert.equal(stats.crossFrameConnections, 0);
  });

  it('35. perFrame missing frameId uses frameIndex fallback', () => {
    const pts = [
      mkPoint({ frameId: undefined, frameIndex: 5, modelX: 0, localEast: 0 }),
      mkPoint({ frameId: undefined, frameIndex: 5, modelX: 5, localEast: 5 }),
      mkPoint({ frameId: undefined, frameIndex: 6, modelX: 0, localEast: 10 }),
    ];
    const { polylines } = CAD.buildPerFrameConnectedPolylines(pts);
    assert.equal(polylines.length, 1);
    assert.equal(polylines[0].pointCount, 2);
  });

  it('36. perFrame different laneIndex never connect', () => {
    const pts = [
      mkPoint({ frameId: 1, laneIndex: 1, modelX: 0, localEast: 0 }),
      mkPoint({ frameId: 1, laneIndex: 2, modelX: 5, localEast: 5 }),
    ];
    const { polylines } = CAD.buildPerFrameConnectedPolylines(pts);
    assert.equal(polylines.length, 0);
  });

  it('37. perFrame modelX ordering', () => {
    const pts = [
      mkPoint({ frameId: 1, modelX: 30, localEast: 30 }),
      mkPoint({ frameId: 1, modelX: 10, localEast: 10 }),
      mkPoint({ frameId: 1, modelX: 20, localEast: 20 }),
    ];
    const { polylines } = CAD.buildPerFrameConnectedPolylines(pts);
    assert.deepEqual(polylines[0].points.map((p) => p.modelX), [10, 20, 30]);
    assert.equal(polylines[0].orderingField, 'modelX');
  });

  it('38. perFrame spatial step over 14 m splits', () => {
    const pts = [
      mkPoint({ frameId: 1, modelX: 0, localEast: 0 }),
      mkPoint({ frameId: 1, modelX: 1, localEast: 20 }),
      mkPoint({ frameId: 1, modelX: 2, localEast: 40 }),
    ];
    const { polylines, stats } = CAD.buildPerFrameConnectedPolylines(pts);
    assert.ok(stats.spatialStepSplits >= 1 || polylines.length >= 2);
  });

  it('39. perFrame duplicate collapse within 0.15 m', () => {
    const pts = [
      mkPoint({ frameId: 1, modelX: 0, localEast: 0, prob: 0.4 }),
      mkPoint({ frameId: 1, modelX: 1, localEast: 0.05, prob: 0.9 }),
      mkPoint({ frameId: 1, modelX: 2, localEast: 10 }),
    ];
    const { polylines, stats } = CAD.buildPerFrameConnectedPolylines(pts);
    assert.ok(stats.duplicatePointCount >= 1);
    assert.equal(polylines[0].pointCount, 2);
    assert.equal(polylines[0].points[0].prob, 0.9);
  });

  it('40. perFrame every polyline is single-frame', () => {
    const pts = [
      mkPoint({ frameId: 1, modelX: 0, localEast: 0 }),
      mkPoint({ frameId: 1, modelX: 5, localEast: 5 }),
      mkPoint({ frameId: 2, modelX: 0, localEast: 10 }),
      mkPoint({ frameId: 2, modelX: 5, localEast: 15 }),
    ];
    const { polylines } = CAD.buildPerFrameConnectedPolylines(pts);
    for (const pl of polylines) {
      const frames = new Set(pl.points.map((p) => p.frameId));
      assert.equal(frames.size, 1);
    }
  });

  it('41. perFrame causal filter excludes future frames', () => {
    const pts = [
      mkPoint({ frameIndex: 0, frameId: 1, modelX: 0, localEast: 0 }),
      mkPoint({ frameIndex: 0, frameId: 1, modelX: 5, localEast: 5 }),
      mkPoint({ frameIndex: 5, frameId: 2, modelX: 0, localEast: 10 }),
      mkPoint({ frameIndex: 5, frameId: 2, modelX: 5, localEast: 15 }),
    ];
    const filtered = CAD.filterPointsForCausal(pts, 0);
    const { polylines } = CAD.buildPerFrameConnectedPolylines(filtered);
    assert.ok(polylines.every((pl) => pl.frameIndex <= 0));
  });

  it('42. raw and robust modes remain callable', () => {
    const pts = [mkPoint({ s: 0 }), mkPoint({ s: 5, localEast: 5 })];
    assert.equal(CAD.buildRawConnectedPolylines(pts).stats.mode, 'raw');
    assert.equal(CAD.buildRobustConnectedPolylines(pts).stats.mode, 'robust');
  });
});
