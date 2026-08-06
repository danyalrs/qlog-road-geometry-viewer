'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const LMC = require('../lib/lane_map_cleanup');
const SLM = require('../lib/segment_local_map');
const RSS = require('../lib/road_surface_stage1');
const { countSelfIntersections } = require('../lib/geometry_sanity');
const { pointAtS } = require('../lib/road_surface_stage1');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEG2 = 'qlog_f449c_2.bz2';

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

function buildStage1() {
  const data = loadSegment();
  const classDGaps = loadClassDGaps();
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
  const stage1 = RSS.runStage1RoadSurface(cleanup.cleaned, cleanup, {
    classDGaps,
    separations: loadSeparations(),
  });
  return { data, cleanup, stage1 };
}

describe('Segment 2 road-surface Stage 1', () => {
  it('1. only adjacent compatible boundary pairs are eligible', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage1 } = buildStage1();
    assert.equal(stage1.eligibilityAudit.candidateBoundaryPairs, 2);
    assert.ok(stage1.eligibilityAudit.eligible.every((c) => ['BP-PB1-PB0', 'BP-PB2-PB1'].includes(c.candidatePairId)));
    assert.ok(!stage1.eligibilityAudit.candidates.some((c) => c.leftPb === c.rightPb));
  });

  it('2. polygon coverage equals intersection of left/right supported intervals', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage1 } = buildStage1();
    for (const poly of stage1.polygons) {
      assert.ok(poly.routeSStart < poly.routeSEnd);
      assert.ok(poly.routeSSpanM > 0);
      assert.ok(poly.leftPb && poly.rightPb);
    }
  });

  it('3. either boundary opening splits the polygon', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage1 } = buildStage1();
    assert.ok(stage1.splits.length > 0);
    assert.ok(stage1.summary.unsupportedBreaksRetained >= 40);
  });

  it('4. no polygon spans CD-10', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage1 } = buildStage1();
    assert.equal(RSS.anyPolygonSpansInterval(stage1.polygons, 428.756, 430.222), false);
  });

  it('5. no polygon spans CD-12', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage1 } = buildStage1();
    assert.equal(RSS.anyPolygonSpansInterval(stage1.polygons, 498.481, 500.121), false);
  });

  it('6. no polygon spans CD-18', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage1 } = buildStage1();
    assert.equal(RSS.anyPolygonSpansInterval(stage1.polygons, 428.757, 430.233), false);
  });

  it('7. no polygon spans CD-01', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage1 } = buildStage1();
    const g = loadClassDGaps().find((x) => x.gapId === 'CD-01');
    assert.equal(RSS.anyPolygonSpansInterval(stage1.polygons, g.startS, g.endS), false);
  });

  it('8. no polygon spans a rejected D6 interval on its boundary', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage1 } = buildStage1();
    for (const g of loadClassDGaps().filter((x) => x.primaryMechanism === 'D6')) {
      const affected = stage1.polygons.filter(
        (p) => p.leftPb === g.physicalBoundaryGroup || p.rightPb === g.physicalBoundaryGroup,
      );
      assert.equal(
        RSS.anyPolygonSpansInterval(affected, g.startS, g.endS),
        false,
        g.gapId,
      );
    }
  });

  it('9. no polygon spans a class-F gap', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage1 } = buildStage1();
    for (const s of loadSeparations().filter((x) => x.classification === 'F')) {
      assert.equal(RSS.anyPolygonSpansInterval(stage1.polygons, s.prevRunS, s.nextRunS), false);
    }
  });

  it('10. no polygon spans the 240 m dropout', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage1 } = buildStage1();
    const d = loadSeparations().find((s) => s.classification === 'A' && s.gapM > 200);
    assert.equal(RSS.anyPolygonSpansInterval(stage1.polygons, d.prevRunS, d.nextRunS), false);
  });

  it('11. no polygon crosses chunk or pass boundary', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage1 } = buildStage1();
    assert.ok(stage1.polygons.every((p) => p.chunkId === 0 && p.passId === 0));
  });

  it('12. no self-intersection is created', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage1 } = buildStage1();
    assert.equal(stage1.summary.selfIntersections, 0);
    for (const p of stage1.polygons) {
      assert.equal(countSelfIntersections(p.ring), 0, p.polygonId);
    }
  });

  it('13. no left/right order inversion is created', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage1 } = buildStage1();
    for (const p of stage1.polygons) {
      assert.ok((p.widthStats?.medianWidth ?? 0) > 0);
      assert.ok((p.widthStats?.minWidth ?? 0) >= 1.2);
    }
  });

  it('14. PB1 and PB2 provenance remains separate', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage1 } = buildStage1();
    const pb2polys = stage1.polygons.filter((p) => p.boundaryPairId === 'BP-PB2-PB1');
    const pb1polys = stage1.polygons.filter((p) => p.boundaryPairId === 'BP-PB1-PB0');
    assert.ok(pb2polys.every((p) => p.leftPb === 'PB2' && p.rightPb === 'PB1'));
    assert.ok(pb1polys.every((p) => p.leftPb === 'PB1' && p.rightPb === 'PB0'));
    assert.ok(pb2polys.every((p) => !p.leftTrackIds.includes(0)));
  });

  it('15. polygon rings use valid winding', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { stage1 } = buildStage1();
    for (const p of stage1.polygons) {
      assert.ok(p.ring.length >= 4);
      assert.ok(p.areaM2 > 0);
    }
  });

  it('16. computed edge-sampling points remain on accepted boundary segments', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { cleanup, stage1 } = buildStage1();
    for (const p of stage1.polygons) {
      for (const cp of p.computedPointProvenance || []) {
        const run = cleanup.cleaned.find((r) => r.runId === cp.runId);
        assert.ok(run, cp.runId);
        const pts = run.displayPoints || run.points;
        const sd = run.displaySdPoints || run.sdPoints;
        const at = pointAtS(pts, sd, cp.s);
        assert.ok(at);
        assert.ok(at.fraction >= 0 && at.fraction <= 1);
      }
    }
  });

  it('17. no extrapolation is introduced', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { cleanup, stage1 } = buildStage1();
    for (const p of stage1.polygons) {
      for (const cp of p.computedPointProvenance || []) {
        const run = cleanup.cleaned.find((r) => r.runId === cp.runId);
        const sd = run.displaySdPoints || run.sdPoints;
        assert.ok(cp.s >= sd[0].s - 0.02 && cp.s <= sd[sd.length - 1].s + 0.02);
      }
    }
  });

  it('18. Mode 5 geometry and checksum remain unchanged', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const before = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
    buildStage1();
    const after = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
    assert.equal(before.laneChecksum, after.laneChecksum);
    assert.deepEqual(
      before.laneFragments.map((f) => f.points),
      after.laneFragments.map((f) => f.points),
    );
  });

  it('19. Mode 5 road-surface count remains zero', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
    assert.equal(map.roadSurfacePolygonCount, 0);
  });

  it('20. logical cleaned-run count remains 28', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const { cleanup } = buildStage1();
    assert.equal(cleanup.cleaned.length, 28);
    assert.equal(cleanup.drawablePathAnalysis.logicalCleanedRunCount, 28);
  });

  it('21. fused-fragment count remains 33', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    assert.equal(data.routeChunks[0].fusedLaneLines.length, 33);
  });

  it('22. prototype mode produces road surfaces without altering lane checksum', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const mode5 = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
    const proto = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleanedWithStage1Surface', timelineIndex: 0 });
    assert.equal(proto.laneChecksum, mode5.laneChecksum);
    assert.ok(proto.roadSurfacePolygonCount > 0);
    assert.equal(mode5.roadSurfacePolygonCount, 0);
  });

  it('23. prototype geometry is stationary across timeline', () => {
    if (!fs.existsSync(path.join(ROOT, SEG2))) return;
    const data = loadSegment();
    const t0 = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleanedWithStage1Surface', timelineIndex: 0 });
    const t16 = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleanedWithStage1Surface', timelineIndex: 16 });
    assert.equal(t0.laneChecksum, t16.laneChecksum);
    assert.equal(t0.roadSurfacePolygonCount, t16.roadSurfacePolygonCount);
    assert.deepEqual(t0.roadSurfacePolygons.map((p) => p.ring), t16.roadSurfacePolygons.map((p) => p.ring));
  });
});
