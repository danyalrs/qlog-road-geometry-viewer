'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const VMC = require('../lib/viewer_mirror_coords');
const VMB = require('../lib/viewer_map_build');
const SLM = require('../lib/segment_local_map');
const LRR = require('../lib/local_road_surface_ribbon');

function buildMap(seg) {
  const pd = VMB.processSegmentLikeViewer(ROOT, seg);
  return SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', fitEnabled: false });
}

describe('road render isolation and canonical mirror contract', () => {
  it('canonical road coordinates unchanged without stored mirror coords', () => {
    const map = buildMap('qlog_f449c_99.bz2');
    const ribbon = LRR.buildTrajectoryRoadSurfaceRibbons(map.trajectory, map.edgeFragments, {});
    const vtx = ribbon.ribbons?.[0]?.ring?.[10];
    assert.ok(vtx);
    const resolved = VMC.resolveRoadDisplayCoords(vtx.east, vtx.north, null, null, true, {
      trajectory: map.trajectory,
    });
    assert.equal(resolved.method, 'canonicalWithoutPrecomputed');
    assert.ok(Math.hypot(resolved.east - vtx.east, resolved.north - vtx.north) < 1e-9);
  });

  it('trajectory fallback runs only with useTrajectoryFallback true', () => {
    const map = buildMap('qlog_f449c_99.bz2');
    const ribbon = LRR.buildTrajectoryRoadSurfaceRibbons(map.trajectory, map.edgeFragments, {});
    const vtx = ribbon.ribbons?.[0]?.ring?.[10];
    const resolved = VMC.resolveRoadDisplayCoords(vtx.east, vtx.north, null, null, true, {
      trajectory: map.trajectory,
      useTrajectoryFallback: true,
    });
    assert.equal(resolved.method, 'trajectoryFallback');
    assert.ok(Math.hypot(resolved.east - vtx.east, resolved.north - vtx.north) > 0.01);
  });

  it('stored mirrored road coordinates take priority when present', () => {
    const map = buildMap('qlog_f449c_0.bz2');
    const p = map.pointAccumulated.points.find((pt) => pt.mirroredLocalEast != null);
    assert.ok(p);
    const resolved = VMC.resolveRoadDisplayCoords(
      p.localEast,
      p.localNorth,
      p.mirroredLocalEast,
      p.mirroredLocalNorth,
      true,
      { trajectory: map.trajectory },
    );
    assert.equal(resolved.method, 'precomputed');
    assert.ok(Math.hypot(resolved.east - p.mirroredLocalEast, resolved.north - p.mirroredLocalNorth) < 1e-6);
  });

  it('renderer disables trajectory fallback for road geometry', () => {
    const renderSrc = fs.readFileSync(path.join(ROOT, 'public', 'render.js'), 'utf8');
    assert.match(renderSrc, /roadGeometryToScreen\(east, north, mirroredEast/);
    assert.match(renderSrc, /useTrajectoryFallback:\s*false/);
    assert.match(renderSrc, /VMC\?\.resolveRoadDisplayCoords/);
  });

  it('connected lane drawing restores canvas dash state', () => {
    const renderSrc = fs.readFileSync(path.join(ROOT, 'public', 'render.js'), 'utf8');
    const fn = renderSrc.slice(
      renderSrc.indexOf('_drawConnectedAccumulatedPolylines(map, elapsedIdx, visiblePoints)'),
      renderSrc.indexOf('_drawHybridFittedBoundaries(map, elapsedIdx, visiblePoints)'),
    );
    assert.match(fn, /ctx\.save\(\)/);
    assert.match(fn, /try\s*\{/);
    assert.match(fn, /finally/);
    assert.match(fn, /ctx\.setLineDash\(\[\]\)/);
    assert.match(fn, /ctx\.lineDashOffset\s*=\s*0/);
  });

  it('segment 99 ribbon vertices use checkpoint canonical contract by default', () => {
    const map = buildMap('qlog_f449c_99.bz2');
    const ribbon = LRR.buildTrajectoryRoadSurfaceRibbons(map.trajectory, map.edgeFragments, {});
    let canonical = 0;
    for (const v of ribbon.ribbons?.[0]?.ring || []) {
      const resolved = VMC.resolveRoadDisplayCoords(v.east, v.north, null, null, true, {
        trajectory: map.trajectory,
      });
      if (resolved.method === 'canonicalWithoutPrecomputed') canonical++;
    }
    assert.ok(canonical > 0);
  });

  it('repair does not require road-guided sequence builder', () => {
    const renderSrc = fs.readFileSync(path.join(ROOT, 'public', 'render.js'), 'utf8');
    assert.doesNotMatch(renderSrc, /buildRoadGuidedSequenceConnectionDisplay/);
    const indexSrc = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.doesNotMatch(indexSrc, /roadGuidedSequenceConnection/);
  });
});
