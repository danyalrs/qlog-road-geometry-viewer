'use strict';

/**
 * Export Segment 2 road-surface Stage 1 verification scenes.
 */
const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const SLM = require('../lib/segment_local_map');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots', 'segment2_road_surface_stage1');
const OUT = path.join(OUT_DIR, 'verification_scenes.json');

const GEOMETRY_SOURCE = 'cleanedWithStage1Surface';
const SURFACE_FILL = 'rgba(255, 165, 0, 0.30)';
const SURFACE_STROKE = 'rgba(180, 83, 9, 0.85)';

const TARGETS = [
  { id: 'overview', routeSTarget: 350, sMargin: 120 },
  { id: 'CD-10', routeSTarget: 429.5, sMargin: 12, gapId: 'CD-10' },
  { id: 'CD-12', routeSTarget: 499.3, sMargin: 12, gapId: 'CD-12' },
  { id: 'CD-18', routeSTarget: 429.5, sMargin: 12, gapId: 'CD-18' },
  { id: 'CD-01_D10_control', routeSTarget: 115, sMargin: 25 },
  { id: 'D6_control', routeSTarget: 340, sMargin: 25 },
  { id: 'classF_control', routeSTarget: 80, sMargin: 25 },
  { id: 'dropout_240m', routeSTarget: 200, sMargin: 130 },
];

const PB_COLORS = { PB0: '#2563eb', PB1: '#16a34a', PB2: '#7c3aed' };

function loadData() {
  const seg = path.join(ROOT, 'qlog_f449c_2.bz2');
  const model = extractModel(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const gps = extractGps(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  return processRoute(model, gps, { pipelineMode: 'C' });
}

function ringIntersectsBounds(ring, bounds, pad = 0) {
  for (const p of ring || []) {
    if (p.east >= bounds.minE - pad && p.east <= bounds.maxE + pad
      && p.north >= bounds.minN - pad && p.north <= bounds.maxN + pad) {
      return true;
    }
  }
  return false;
}

function boundsForRouteS(frags, surfaces, routeS, sMargin) {
  const pts = [];
  for (const f of frags) {
    for (let i = 0; i < (f.sdPoints || []).length; i++) {
      const s = f.sdPoints[i].s;
      if (s >= routeS - sMargin && s <= routeS + sMargin) pts.push(f.points[i]);
    }
  }
  for (const poly of surfaces || []) {
    for (const p of poly.ring || []) pts.push(p);
  }
  if (!pts.length) return null;
  const pad = 2;
  return {
    minE: Math.min(...pts.map((p) => p.east)) - pad,
    maxE: Math.max(...pts.map((p) => p.east)) + pad,
    minN: Math.min(...pts.map((p) => p.north)) - pad,
    maxN: Math.max(...pts.map((p) => p.north)) + pad,
  };
}

function findPointAtS(frags, sTarget) {
  for (const f of frags) {
    for (let i = 0; i < (f.sdPoints || []).length; i++) {
      if (Math.abs(f.sdPoints[i].s - sTarget) < 0.08) return f.points[i];
    }
  }
  return null;
}

function main() {
  const data = loadData();
  const rendering = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'audit_segment2_d12_rendering_verification.json'), 'utf8',
  ));
  const gapById = Object.fromEntries((rendering.interRunBreaks || []).map((g) => [g.gapId, g]));

  const mode5 = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
  const proto = SLM.buildSegmentLocalMap(data, { geometrySource: GEOMETRY_SOURCE, timelineIndex: 0 });

  const allSurfaces = proto.roadSurfacePolygons.map((p) => ({
    ring: p.ring,
    fill: SURFACE_FILL,
    stroke: SURFACE_STROKE,
    strokeWidth: 1.25,
    polygonId: p.polygonId,
    routeSStart: p.routeSStart,
    routeSEnd: p.routeSEnd,
  }));

  const scenes = [];
  for (const target of TARGETS) {
    const bounds = boundsForRouteS(proto.laneFragments, allSurfaces, target.routeSTarget, target.sMargin);
    if (!bounds) continue;
    const visibleSurfaces = allSurfaces.filter((p) => ringIntersectsBounds(p.ring, bounds, 3));
    const gap = target.gapId ? gapById[target.gapId] : null;
    const gapMarkers = gap ? [{
      gapId: gap.gapId,
      openLengthM: gap.openLengthM,
      a: findPointAtS(proto.laneFragments, gap.openIntervalStartS),
      b: findPointAtS(proto.laneFragments, gap.openIntervalEndS),
    }] : [];

    scenes.push({
      sceneId: `stage1_${target.id}_t0`,
      id: target.id,
      modeLabel: 'stage1Prototype',
      geometrySource: GEOMETRY_SOURCE,
      bounds,
      fragments: proto.laneFragments.map((f) => ({
        points: f.points,
        physicalBoundaryId: f.physicalBoundaryId,
        color: PB_COLORS[f.physicalBoundaryId] || '#334155',
        width: 2.5,
      })),
      roadSurfacePolygons: visibleSurfaces,
      showRoadSurface: true,
      stage1Hud: true,
      showGapMarkers: !!gap,
      gapMarkers,
      laneChecksum: proto.laneChecksum,
      mode5Checksum: mode5.laneChecksum,
      roadSurfaceCount: proto.roadSurfacePolygonCount,
      visibleSurfaceCount: visibleSurfaces.length,
      timelineIndex: 0,
    });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    scenes,
    geometrySource: GEOMETRY_SOURCE,
    mode5Checksum: mode5.laneChecksum,
    protoChecksum: proto.laneChecksum,
    totalSurfaceCount: proto.roadSurfacePolygonCount,
  }, null, 2));
  console.log(`exported ${scenes.length} scenes, ${proto.roadSurfacePolygonCount} total surfaces -> ${OUT}`);
}

main();
