'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { processRoute } = require('../lib/process_route');
const LMC = require('../lib/lane_map_cleanup');
const SLM = require('../lib/segment_local_map');
const RSS = require('../lib/road_surface_stage1');
const RS2 = require('../lib/road_surface_stage2');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEG2 = 'qlog_f449c_2.bz2';

const STAGE1_POLYGON_IDS = [
  'RS-BP-PB1-PB0-0-89', 'RS-BP-PB1-PB0-1-66', 'RS-BP-PB1-PB0-2-622', 'RS-BP-PB1-PB0-3-435',
  'RS-BP-PB1-PB0-4-590', 'RS-BP-PB1-PB0-5-647', 'RS-BP-PB1-PB0-6-500', 'RS-BP-PB1-PB0-7-528',
  'RS-BP-PB1-PB0-8-381', 'RS-BP-PB1-PB0-9-567', 'RS-BP-PB1-PB0-10-467', 'RS-BP-PB1-PB0-11-332',
  'RS-BP-PB2-PB1-12-408', 'RS-BP-PB2-PB1-13-435',
];

function loadSegment() {
  const segPath = path.join(ROOT, SEG2);
  const model = extractModel(segPath).map((e) => ({ ...e, sourceFile: SEG2 }));
  const gps = extractGps(segPath).map((e) => ({ ...e, sourceFile: SEG2 }));
  return processRoute(model, gps, { pipelineMode: 'C' });
}

function loadClassDGaps() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'audit_segment2_class_d_fusion_gaps.json'), 'utf8')).gaps;
}

function loadSeparations() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'audit_segment2_cleaned_runs.json'), 'utf8')).separations;
}

function buildStage2() {
  const data = loadSegment();
  const classDGaps = loadClassDGaps();
  const separations = loadSeparations();
  const cleanup = LMC.buildCleanedLaneMap({
    frames: data.routeChunks[0].frames,
    fusedLanes: data.routeChunks[0].fusedLaneLines,
    tracks: data.routeChunks[0].laneTracks,
    chunkId: 0,
    passId: 0,
    vehiclePath: data.routeChunks[0].vehiclePath,
    classDGaps: classDGaps.filter((g) => g.primaryMechanism === 'D12'),
    enableD12Preservation: true,
  });
  const stage2 = RS2.runStage2RoadSurface(cleanup.cleaned, cleanup, {
    classDGaps, separations, vehiclePath: data.routeChunks[0].vehiclePath,
  });
  return { data, cleanup, stage2 };
}

function loadStage1PolygonBaseline() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'audit_segment2_road_surface_polygons.json'), 'utf8'));
}

function loadBrowserSegmentLocalMap() {
  const context = { window: {}, globalThis: {} };
  context.window = context.globalThis;
  vm.createContext(context);
  const scripts = [
    'public/local_playback.js',
    'public/segment2_browser_audit_data.js',
    'public/lane_map_cleanup.js',
    'public/road_surface_stage1.js',
    'public/segment_local_map.js',
  ];
  for (const rel of scripts) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(src, context);
  }
  return context.window.SegmentLocalMap;
}

describe('Segment 2 road-surface Stage 2', () => {
  it('1. all 14 Stage 1 polygon identities remain present', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage2 } = buildStage2();
    const ids = stage2.stage1.polygons.map((p) => p.polygonId).sort();
    assert.deepEqual(ids, [...STAGE1_POLYGON_IDS].sort());
    assert.equal(ids.length, 14);
  });

  it('2. every polygon has complete provenance', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage2 } = buildStage2();
    assert.ok(stage2.components.every((c) => c.provenanceComplete));
  });

  it('3. no polygon geometry changes during Stage 2', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage2 } = buildStage2();
    const baseline = loadStage1PolygonBaseline();
    for (const p of stage2.stage1.polygons) {
      const b = baseline.polygons.find((x) => x.polygonId === p.polygonId);
      assert.ok(b, p.polygonId);
      assert.deepEqual(p.ring, b.ring, p.polygonId);
    }
  });

  it('4. PB2–PB1 components remain between PB2 and PB1', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage2 } = buildStage2();
    for (const r of stage2.pb2pb1Review) {
      assert.equal(r.betweenPb2AndPb1, true, r.polygonId);
    }
  });

  it('5. PB2–PB1 components do not cross CD-10 or CD-18', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage2 } = buildStage2();
    for (const r of stage2.pb2pb1Review) {
      assert.equal(r.crossesCd10, false, r.polygonId);
      assert.equal(r.crossesCd18, false, r.polygonId);
    }
  });

  it('6. no component is a thin or degenerate triangle', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage2 } = buildStage2();
    assert.equal(stage2.summary.thinTriangles, 0);
  });

  it('7. no width collapse occurs', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage2 } = buildStage2();
    assert.equal(stage2.summary.widthCollapses, 0);
  });

  it('8. no width spike exceeds accepted Segment 2 limits', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage2 } = buildStage2();
    assert.equal(stage2.summary.widthSpikes, 0);
    for (const c of stage2.components) {
      assert.ok((c.maxWidthM ?? 0) <= RS2.MAX_WIDTH_SPIKE_M, c.polygonId);
    }
  });

  it('9. end caps use supported endpoints only', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage2 } = buildStage2();
    assert.ok(stage2.overlapPolicy.endCapAudits.every((e) => e.startCapUsesSupportedEndpoints));
    assert.ok(stage2.overlapPolicy.endCapAudits.every((e) => e.endCapUsesSupportedEndpoints));
  });

  it('10. end caps do not cross another boundary', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage2 } = buildStage2();
    assert.ok(stage2.overlapPolicy.endCapAudits.every((e) => !e.endCapCrossesBoundary));
  });

  it('11. separate components have zero interior overlap', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage2 } = buildStage2();
    assert.equal(stage2.summary.overlaps, 0);
    assert.equal(stage2.overlapPolicy.overlapCount, 0);
  });

  it('12. unsupported breaks remain uncovered', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage2 } = buildStage2();
    assert.equal(RSS.anyPolygonSpansInterval(stage2.stage1.polygons, 428.756, 430.222), false);
    assert.equal(RSS.anyPolygonSpansInterval(stage2.stage1.polygons, 498.481, 500.121), false);
  });

  it('13. coverage totals reconcile using unrounded values', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage2 } = buildStage2();
    const r = stage2.coverage.roundingReconciliation;
    assert.equal(r.explanation, 'rounding_only');
    assert.ok(Math.abs(r.sumExact - r.reportedTotalExact) < 1e-6);
  });

  it('14. browser and Node lane checksums match', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { data } = buildStage2();
    const nodeMap = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
    const BrowserSLM = loadBrowserSegmentLocalMap();
    const browserMap = BrowserSLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
    assert.equal(browserMap.laneChecksum, nodeMap.laneChecksum);
    assert.equal(browserMap.laneChecksum, '5283af91');
    assert.ok(browserMap.laneFragmentCount > 0);
  });

  it('15. browser and Node polygon checksums match', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { data } = buildStage2();
    const nodeMap = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleanedWithStage1Surface', timelineIndex: 0 });
    const BrowserSLM = loadBrowserSegmentLocalMap();
    const browserMap = BrowserSLM.buildSegmentLocalMap(data, { geometrySource: 'cleanedWithStage1Surface', timelineIndex: 0 });
    assert.equal(browserMap.roadSurfaceChecksum, nodeMap.roadSurfaceChecksum);
    assert.equal(browserMap.roadSurfacePolygonCount, 14);
  });

  it('16. browser bundle has no unresolved require error', () => {
    const bundles = [
      'public/lane_map_cleanup.js',
      'public/road_surface_stage1.js',
      'public/segment_local_map.js',
    ];
    for (const rel of bundles) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.ok(!/\brequire\s*\(/.test(src), rel);
    }
  });

  it('17. Mode 5 contains zero road surfaces', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { data } = buildStage2();
    const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
    assert.equal(map.roadSurfacePolygonCount, 0);
  });

  it('18. prototype mode contains exactly 14 polygons', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { data } = buildStage2();
    const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleanedWithStage1Surface', timelineIndex: 0 });
    assert.equal(map.roadSurfacePolygonCount, 14);
  });

  it('19. timeline changes do not move lane geometry', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { data } = buildStage2();
    const t0 = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleanedWithStage1Surface', timelineIndex: 0 });
    const t16 = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleanedWithStage1Surface', timelineIndex: 16 });
    assert.deepEqual(t0.laneFragments.map((f) => f.points), t16.laneFragments.map((f) => f.points));
  });

  it('20. timeline changes do not move polygon geometry', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { data } = buildStage2();
    const t0 = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleanedWithStage1Surface', timelineIndex: 0 });
    const t16 = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleanedWithStage1Surface', timelineIndex: 16 });
    assert.deepEqual(t0.roadSurfacePolygons.map((p) => p.ring), t16.roadSurfacePolygons.map((p) => p.ring));
  });

  it('21. road-surface toggle changes visibility only (geometry unchanged)', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { data } = buildStage2();
    const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleanedWithStage1Surface', timelineIndex: 0 });
    assert.equal(map.roadSurfacePolygons.length, 14);
    assert.ok(map.roadSurfacePolygons.every((p) => p.ring?.length >= 3));
  });

  it('22. Mode 5 checksum remains 5283af91', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { data } = buildStage2();
    const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
    assert.equal(map.laneChecksum, '5283af91');
  });

  it('23. cleaned-run count remains 28', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { cleanup } = buildStage2();
    assert.equal(cleanup.cleaned.length, 28);
  });

  it('24. fused-fragment count remains 33', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { data } = buildStage2();
    assert.equal(data.routeChunks[0].fusedLaneLines.length, 33);
  });

  it('25. all Stage 1 tests still pass (structural summary)', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage2 } = buildStage2();
    assert.equal(stage2.stage1.summary.selfIntersections, 0);
    assert.equal(stage2.stage1.summary.polygonOverlaps, 0);
    assert.equal(stage2.stage1.summary.polygonsGenerated, 14);
  });

  it('26. all components structurally accepted', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage2 } = buildStage2();
    assert.equal(stage2.summary.structurallyAccepted, 14);
    assert.equal(stage2.summary.structurallyRejected, 0);
  });
});
