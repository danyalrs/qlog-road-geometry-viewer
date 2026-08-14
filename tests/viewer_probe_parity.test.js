'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  summarizeViewerSegment,
  buildViewerStationaryMap,
  processSegmentLikeViewer,
  VIEWER_DEFAULT_PROCESS_OPTIONS,
  viewerLocalMapOptions,
} = require('../lib/viewer_map_build');
const { PROCESSING_VERSION } = require('../lib/version');
const GF = require('../lib/graph_fit');

const ROOT = path.join(__dirname, '..');
const SEGMENTS = [2, 3, 9, 14, 16, 54];

function segmentFile(n) {
  return `qlog_f449c_${n}.bz2`;
}

describe('viewer/probe parity — production map path', () => {
  for (const segNum of SEGMENTS) {
    const seg = segmentFile(segNum);
    if (!fs.existsSync(path.join(ROOT, seg))) continue;

    it(`${segNum}: probe summary matches buildSegmentLocalMap viewer path`, () => {
      const summary = summarizeViewerSegment(ROOT, seg, { fitEnabled: true });
      const processData = processSegmentLikeViewer(ROOT, seg);
      const map = buildViewerStationaryMap(processData, { fitEnabled: true });
      const pa = map.pointAccumulated;
      const accepted = (pa?.fittedPolylines?.results || []).filter((r) => r.status === 'accepted');
      assert.equal(summary.fitOn.acceptedCount, accepted.length);
      assert.deepEqual(summary.fitOn.acceptedIds, accepted.map((r) => r.fragmentId).sort());
      assert.equal(summary.processingVersion, PROCESSING_VERSION);
      assert.equal(summary.polygonCountOn, map.roadSurfacePolygonCount);
      assert.equal(summary.trajectory.isStationary, GF.isDegenerateTrajectory(
        processData.routeChunks?.[0]?.vehiclePath?.length >= 2
          ? require('../lib/point_accumulation').buildReferenceTrajectory(processData.routeChunks[0].vehiclePath)
          : null,
      ));
      assert.equal(summary.fitOn.fitEnabled, true);
    });
  }

  it('viewer map options match app.js local playback contract', () => {
    const opts = viewerLocalMapOptions({ fitEnabled: true });
    assert.equal(opts.geometrySource, 'pointAccumulated');
    assert.equal(opts.timelineIndex, 0);
    assert.equal(opts.minHeadingSpeedMps, VIEWER_DEFAULT_PROCESS_OPTIONS.minSpeedForGpsBearing);
    assert.equal(opts.fitEnabled, true);
  });

  it('fit off by default in viewer map options', () => {
    const opts = viewerLocalMapOptions({ fitEnabled: false });
    assert.equal(opts.fitEnabled, false);
  });
});

describe('graph-fit cache scope', () => {
  it('cache stats are zero after fitConstructedRuns returns', () => {
    assert.deepEqual(GF.getGraphFitCacheStats(), {
      omegaEntries: 0,
      designEntries: 0,
      omegaBuilds: 0,
      designBuilds: 0,
      estimatedBytes: 0,
    });
  });

  it('per-build cache is populated during fit and not retained module-wide', () => {
    const seg = path.join(ROOT, 'qlog_f449c_2.bz2');
    if (!fs.existsSync(seg)) return;
    const processData = processSegmentLikeViewer(ROOT, segmentFile(2));
    const map = buildViewerStationaryMap(processData, { fitEnabled: true });
    const stats = map.pointAccumulated?.fittedPolylines?.stats?.cache;
    assert.ok(stats);
    assert.ok(stats.omegaEntries >= 0);
    assert.ok(stats.designEntries >= 0);
    assert.deepEqual(GF.getGraphFitCacheStats().omegaEntries, 0);
  });

  it('sequential segment builds do not accumulate module-level cache entries', () => {
    const available = SEGMENTS.filter((n) => fs.existsSync(path.join(ROOT, segmentFile(n))));
    if (!available.length) return;
    const peak = [];
    for (const n of available) {
      const processData = processSegmentLikeViewer(ROOT, segmentFile(n));
      const map = buildViewerStationaryMap(processData, { fitEnabled: true });
      const c = map.pointAccumulated?.fittedPolylines?.stats?.cache;
      if (c) peak.push(c);
      assert.deepEqual(GF.getGraphFitCacheStats().omegaEntries, 0);
    }
    assert.ok(peak.length);
  });

  it('cold-cache and warm per-build cache produce identical fit coordinates', () => {
    const seg = path.join(ROOT, 'qlog_f449c_3.bz2');
    if (!fs.existsSync(seg)) return;
    const CF = require('../lib/constructed_fragments');
    const processData = processSegmentLikeViewer(ROOT, segmentFile(3));
    const map = buildViewerStationaryMap(processData, { fitEnabled: false });
    const cf = map.pointAccumulated.constructedFragments;
    const a = GF.fitConstructedRuns(cf.fragments, cf.runs, { fitEnabled: true });
    const b = GF.fitConstructedRuns(cf.fragments, cf.runs, { fitEnabled: true });
    assert.equal(a.acceptedCount, b.acceptedCount);
    for (let i = 0; i < a.results.length; i++) {
      assert.equal(a.results[i].status, b.results[i].status);
      const pa = a.results[i].fittedPolyline;
      const pb = b.results[i].fittedPolyline;
      if (!pa || !pb) continue;
      const flatA = Array.isArray(pa[0]) ? pa[0] : pa;
      const flatB = Array.isArray(pb[0]) ? pb[0] : pb;
      assert.equal(flatA.length, flatB.length);
      for (let k = 0; k < flatA.length; k++) {
        assert.ok(Math.abs(flatA[k].east - flatB[k].east) < 1e-9);
        assert.ok(Math.abs(flatA[k].north - flatB[k].north) < 1e-9);
      }
    }
  });
});
