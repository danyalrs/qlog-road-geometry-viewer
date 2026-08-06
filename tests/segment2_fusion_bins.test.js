'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  deriveSafeSurfaceBridgeGapM,
  mergeAdjacentIntervals,
  interpolateBridgeSamples,
  classifySurfaceType,
  SURFACE_TYPES,
} = require('../lib/fusion_bins');
const { processRoute } = require('../lib/process_route');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const SLM = require('../lib/segment_local_map');

const ROOT = path.join(__dirname, '..');
const SEG2 = 'qlog_f449c_2.bz2';

function loadSegment() {
  const segPath = path.join(ROOT, SEG2);
  const modelEvents = extractModel(segPath).map((e) => ({ ...e, sourceFile: SEG2 }));
  const gpsEvents = extractGps(segPath).map((e) => ({ ...e, sourceFile: SEG2 }));
  return processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
}

describe('fusion bin assembly', () => {
  it('merges consecutive compatible intervals across short gaps', () => {
    const a = [
      { s: 0, dL: 3, dR: 0, width: 3, valid: true },
      { s: 2, dL: 3, dR: 0, width: 3, valid: true },
      { s: 4, dL: 3, dR: 0, width: 3, valid: true },
    ];
    const b = [
      { s: 10, dL: 3, dR: 0, width: 3, valid: true },
      { s: 12, dL: 3, dR: 0, width: 3, valid: true },
      { s: 14, dL: 3, dR: 0, width: 3, valid: true },
    ];
    const merged = mergeAdjacentIntervals([a, b], { safeBridgeGapM: 8, leftTrackId: 0, rightTrackId: 1 });
    assert.equal(merged.intervals.length, 1);
    assert.ok(merged.intervals[0].length > 6);
    assert.ok(merged.bridges.length >= 1);
  });

  it('does not merge across gaps larger than safe bridge limit', () => {
    const a = [{ s: 0, dL: 3, dR: 0, width: 3, valid: true }, { s: 2, dL: 3, dR: 0, width: 3, valid: true }, { s: 4, dL: 3, dR: 0, width: 3, valid: true }];
    const b = [{ s: 200, dL: 3, dR: 0, width: 3, valid: true }, { s: 202, dL: 3, dR: 0, width: 3, valid: true }, { s: 204, dL: 3, dR: 0, width: 3, valid: true }];
    const merged = mergeAdjacentIntervals([a, b], { safeBridgeGapM: 12 });
    assert.equal(merged.intervals.length, 2);
  });

  it('surface interpolation marks synthetic provenance', () => {
    const end = [{ s: 0, dL: 3, dR: 0, width: 3, valid: true }, { s: 2, dL: 3, dR: 0, width: 3, valid: true }, { s: 4, dL: 3, dR: 0, width: 3, valid: true }];
    const start = [{ s: 10, dL: 3, dR: 0, width: 3, valid: true }, { s: 12, dL: 3, dR: 0, width: 3, valid: true }, { s: 14, dL: 3, dR: 0, width: 3, valid: true }];
    const bridge = interpolateBridgeSamples(end, start, { polygonSampleStepM: 2 });
    assert.ok(bridge.valid);
    assert.ok(bridge.samples.every((s) => s.syntheticForSurface));
    assert.ok(bridge.provenance.syntheticForSurface);
  });

  it('rejects bridge when widths are incompatible', () => {
    const end = [{ s: 0, dL: 5, dR: 0, width: 5, valid: true }, { s: 2, dL: 5, dR: 0, width: 5, valid: true }, { s: 4, dL: 5, dR: 0, width: 5, valid: true }];
    const start = [{ s: 10, dL: 1, dR: 0, width: 1, valid: true }, { s: 12, dL: 1, dR: 0, width: 1, valid: true }, { s: 14, dL: 1, dR: 0, width: 1, valid: true }];
    const bridge = interpolateBridgeSamples(end, start, { maxBridgeWidthDeltaM: 1.5 });
    assert.equal(bridge.valid, false);
  });

  it('classifies ego-lane corridor correctly', () => {
    const t = classifySurfaceType({ leftTrackId: 0, rightTrackId: 1, laneTrackCount: 2 });
    assert.equal(t, SURFACE_TYPES.EGO_LANE);
  });

  it('segment 2 produces longer polygons after bin merging', () => {
    const data = loadSegment();
    const polys = data.routeChunks[0].roadSurfacePolygons;
    const lens = polys.map((p) => p.stats.sRange[1] - p.stats.sRange[0]);
    const total = lens.reduce((a, b) => a + b, 0);
    assert.ok(total > 100, `expected >100m coverage, got ${total}`);
    assert.ok(Math.max(...lens) > 20, `expected max section >20m, got ${Math.max(...lens)}`);
  });

  it('segment 2 dropout gap is not bridged', () => {
    const leftPts = [{ s: 100, d: 1 }, { s: 136, d: 1 }];
    const rightPts = [{ s: 100, d: -1 }, { s: 136, d: -1 }];
    const derived = deriveSafeSurfaceBridgeGapM(leftPts, rightPts, {});
    assert.ok(derived.safeBridgeGapM <= 12);
    const a = [{ s: 100, dL: 2, dR: -1, width: 3, valid: true }, { s: 102, dL: 2, dR: -1, width: 3, valid: true }, { s: 104, dL: 2, dR: -1, width: 3, valid: true }];
    const b = [{ s: 250, dL: 2, dR: -1, width: 3, valid: true }, { s: 252, dL: 2, dR: -1, width: 3, valid: true }, { s: 254, dL: 2, dR: -1, width: 3, valid: true }];
    const merged = mergeAdjacentIntervals([a, b], { safeBridgeGapM: derived.safeBridgeGapM });
    assert.equal(merged.intervals.length, 2);
  });

  it('stationary map checksum unchanged with fused geometry', () => {
    const data = loadSegment();
    const checksums = new Set();
    for (const idx of [0, 8, 16, 29]) {
      const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'fused', timelineIndex: idx });
      checksums.add(map.checksum);
    }
    assert.equal(checksums.size, 1);
  });

  it('ego-lane surface type is set on segment 2 polygons', () => {
    const data = loadSegment();
    const polys = data.routeChunks[0].roadSurfacePolygons;
    assert.ok(polys.length > 0);
    assert.ok(polys.every((p) => !p.surfaceType || p.surfaceType === 'egoLaneCorridor'));
  });
});
