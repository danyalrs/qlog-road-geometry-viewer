'use strict';

/**
 * Export Segment 2 road-surface Stage 2 verification scenes.
 */
const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const SLM = require('../lib/segment_local_map');
const RS2 = require('../lib/road_surface_stage2');
const LMC = require('../lib/lane_map_cleanup');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots', 'segment2_road_surface_stage2');
const OUT = path.join(OUT_DIR, 'verification_scenes.json');

const GEOMETRY_SOURCE = 'cleanedWithStage1Surface';
const SURFACE_FILL = 'rgba(255, 165, 0, 0.30)';
const SURFACE_STROKE = 'rgba(180, 83, 9, 0.85)';

const PB_COLORS = { PB0: '#2563eb', PB1: '#16a34a', PB2: '#7c3aed' };

const CONTROL_TARGETS = [
  { id: 'overview', routeSTarget: 350, sMargin: 120 },
  { id: 'CD-10', routeSTarget: 429.5, sMargin: 12, gapId: 'CD-10' },
  { id: 'CD-12', routeSTarget: 499.3, sMargin: 12, gapId: 'CD-12' },
  { id: 'CD-18', routeSTarget: 429.5, sMargin: 12, gapId: 'CD-18' },
  { id: 'CD-01_D10_control', routeSTarget: 115, sMargin: 25 },
  { id: 'D6_control', routeSTarget: 340, sMargin: 25 },
  { id: 'classF_control', routeSTarget: 80, sMargin: 25 },
  { id: 'dropout_240m', routeSTarget: 200, sMargin: 130 },
];

function loadData() {
  const seg = path.join(ROOT, 'qlog_f449c_2.bz2');
  const model = extractModel(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const gps = extractGps(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  return processRoute(model, gps, { pipelineMode: 'C' });
}

function loadClassDGaps() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'audit_segment2_class_d_fusion_gaps.json'), 'utf8')).gaps;
}

function loadSeparations() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'audit_segment2_cleaned_runs.json'), 'utf8')).separations;
}

function ringBounds(ring, pad = 2) {
  const easts = ring.map((p) => p.east);
  const norths = ring.map((p) => p.north);
  return {
    minE: Math.min(...easts) - pad,
    maxE: Math.max(...easts) + pad,
    minN: Math.min(...norths) - pad,
    maxN: Math.max(...norths) + pad,
  };
}

function mergeBounds(a, b) {
  return {
    minE: Math.min(a.minE, b.minE),
    maxE: Math.max(a.maxE, b.maxE),
    minN: Math.min(a.minN, b.minN),
    maxN: Math.max(a.maxN, b.maxN),
  };
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

function surfaceDrawable(p) {
  return {
    ring: p.ring,
    fill: SURFACE_FILL,
    stroke: SURFACE_STROKE,
    strokeWidth: 1.25,
    polygonId: p.polygonId,
    routeSStart: p.routeSStart,
    routeSEnd: p.routeSEnd,
    leftPb: p.sourceLeftTrackId != null ? undefined : undefined,
  };
}

function buildScene(base, {
  sceneId, id, bounds, surfaces, gapMarkers = [], diagnosticLabels = [], highlightPolygonIds = [],
}) {
  return {
    ...base,
    sceneId,
    id,
    bounds,
    roadSurfacePolygons: surfaces,
    showRoadSurface: true,
    stage1Hud: true,
    stage2Hud: true,
    showGapMarkers: gapMarkers.some((g) => g.drawMarker),
    gapMarkers,
    diagnosticLabels,
    highlightPolygonIds,
    visibleSurfaceCount: surfaces.length,
  };
}

function main() {
  const data = loadData();
  const classDGaps = loadClassDGaps();
  const separations = loadSeparations();
  const rendering = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'audit_segment2_d12_rendering_verification.json'), 'utf8',
  ));
  const gapById = Object.fromEntries((rendering.interRunBreaks || []).map((g) => [g.gapId, g]));

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

  const mode5 = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
  const proto = SLM.buildSegmentLocalMap(data, { geometrySource: GEOMETRY_SOURCE, timelineIndex: 0 });

  const frags = proto.laneFragments;
  const allSurfaces = proto.roadSurfacePolygons.map((p) => ({
    ring: p.ring,
    fill: SURFACE_FILL,
    stroke: SURFACE_STROKE,
    strokeWidth: 1.25,
    polygonId: p.polygonId,
    routeSStart: p.routeSStart,
    routeSEnd: p.routeSEnd,
    boundaryPairId: p.boundaryPairId,
  }));

  const base = {
    modeLabel: 'stage2Prototype',
    geometrySource: GEOMETRY_SOURCE,
    fragments: frags.map((f) => ({
      points: f.points,
      physicalBoundaryId: f.physicalBoundaryId,
      color: PB_COLORS[f.physicalBoundaryId] || '#334155',
      width: 2.5,
    })),
    laneChecksum: proto.laneChecksum,
    mode5Checksum: mode5.laneChecksum,
    roadSurfaceChecksum: proto.roadSurfaceChecksum,
    roadSurfaceCount: proto.roadSurfacePolygonCount,
    timelineIndex: 0,
  };

  const scenes = [];

  for (const target of CONTROL_TARGETS) {
    const bounds = boundsForRouteS(frags, allSurfaces, target.routeSTarget, target.sMargin);
    if (!bounds) continue;
    const visible = allSurfaces.filter((p) => {
      for (const pt of p.ring) {
        if (pt.east >= bounds.minE && pt.east <= bounds.maxE
          && pt.north >= bounds.minN && pt.north <= bounds.maxN) return true;
      }
      return false;
    });
    const gap = target.gapId ? gapById[target.gapId] : null;
    const gapMarkers = gap ? [{
      gapId: gap.gapId,
      openLengthM: gap.openLengthM,
      a: findPointAtS(frags, gap.openIntervalStartS),
      b: findPointAtS(frags, gap.openIntervalEndS),
      drawMarker: true,
    }] : [];
    scenes.push(buildScene(base, {
      sceneId: `stage2_${target.id}_t0`,
      id: target.id,
      bounds,
      surfaces: visible.length ? visible : allSurfaces,
      gapMarkers,
    }));
  }

  for (const comp of stage2.components) {
    const poly = allSurfaces.find((p) => p.polygonId === comp.polygonId);
    if (!poly) continue;
    let bounds = ringBounds(poly.ring, 4);
    for (const nbId of comp.neighbouringPolygonIds || []) {
      const nb = allSurfaces.find((p) => p.polygonId === nbId);
      if (nb) bounds = mergeBounds(bounds, ringBounds(nb.ring, 4));
    }
    scenes.push(buildScene(base, {
      sceneId: `stage2_poly_${comp.polygonId}_t0`,
      id: comp.polygonId,
      bounds,
      surfaces: [poly],
      diagnosticLabels: [{
        text: comp.polygonId,
        east: (bounds.minE + bounds.maxE) / 2,
        north: bounds.maxN - 1,
      }, {
        text: `${comp.leftPb}-${comp.rightPb} s=${comp.routeSStart.toFixed(1)}-${comp.routeSEnd.toFixed(1)}`,
        east: (bounds.minE + bounds.maxE) / 2,
        north: bounds.maxN - 3,
      }, {
        text: `L=${comp.supportedLengthM.toFixed(1)}m A=${comp.areaM2.toFixed(1)}m² w=${comp.minWidthM?.toFixed(1)}-${comp.maxWidthM?.toFixed(1)}m`,
        east: (bounds.minE + bounds.maxE) / 2,
        north: bounds.minN + 1,
      }],
      highlightPolygonIds: [comp.polygonId],
    }));
  }

  for (const review of stage2.pb2pb1Review) {
    const poly = allSurfaces.find((p) => p.polygonId === review.polygonId);
    if (!poly) continue;
    const bounds = ringBounds(poly.ring, 6);
    const leftOpens = review.unsupportedIntervalsLeft || [];
    const rightOpens = review.unsupportedIntervalsRight || [];
    scenes.push(buildScene(base, {
      sceneId: `stage2_pb2pb1_${review.polygonId}_t0`,
      id: `PB2-PB1_${review.polygonId}`,
      bounds,
      surfaces: [poly],
      diagnosticLabels: [{
        text: review.polygonId,
        east: (bounds.minE + bounds.maxE) / 2,
        north: bounds.maxN - 1,
      }, {
        text: 'PB2 (left) — PB1 (right)',
        east: bounds.minE + 2,
        north: bounds.maxN - 3,
      }, {
        text: `s=${review.routeSStart?.toFixed(1)}-${review.routeSEnd?.toFixed(1)} L=${review.supportedLengthM?.toFixed(1)}m`,
        east: (bounds.minE + bounds.maxE) / 2,
        north: bounds.minN + 1,
      }, {
        text: `left unsupported: ${leftOpens.length}, right unsupported: ${rightOpens.length}`,
        east: (bounds.minE + bounds.maxE) / 2,
        north: bounds.minN + 3,
      }],
      highlightPolygonIds: [review.polygonId],
    }));
  }

  const sortedByLen = [...stage2.components].sort((a, b) => a.supportedLengthM - b.supportedLengthM);
  const widest = [...stage2.components].sort((a, b) => b.maxWidthM - a.maxWidthM)[0];
  const highestVar = [...stage2.components].sort((a, b) => b.widthVariationM - a.widthVariationM)[0];
  const neighbourPair = stage2.overlapPolicy.neighbourPairs
    .filter((p) => p.sameBoundaryPair && p.routeSSeparationM < 20)
    .sort((a, b) => a.routeSSeparationM - b.routeSSeparationM)[0];

  const specials = [
    { key: 'shortest_polygon', comp: sortedByLen[0] },
    { key: 'widest_polygon', comp: widest },
    { key: 'highest_width_variation', comp: highestVar },
  ];
  for (const sp of specials) {
    const poly = allSurfaces.find((p) => p.polygonId === sp.comp.polygonId);
    if (!poly) continue;
    scenes.push(buildScene(base, {
      sceneId: `stage2_${sp.key}_t0`,
      id: sp.key,
      bounds: ringBounds(poly.ring, 8),
      surfaces: [poly],
      diagnosticLabels: [{ text: sp.key, east: poly.ring[0].east, north: poly.ring[0].north + 2 }],
      highlightPolygonIds: [sp.comp.polygonId],
    }));
  }

  if (neighbourPair) {
    const polys = allSurfaces.filter((p) =>
      p.polygonId === neighbourPair.polygonA || p.polygonId === neighbourPair.polygonB);
    let bounds = ringBounds(polys[0].ring, 6);
    bounds = mergeBounds(bounds, ringBounds(polys[1].ring, 6));
    scenes.push(buildScene(base, {
      sceneId: 'stage2_closest_neighbours_t0',
      id: 'closest_neighbours',
      bounds,
      surfaces: polys,
      diagnosticLabels: [{
        text: `${neighbourPair.polygonA} | ${neighbourPair.polygonB}`,
        east: (bounds.minE + bounds.maxE) / 2,
        north: bounds.maxN - 1,
      }, {
        text: `routeSep=${neighbourPair.routeSSeparationM.toFixed(2)}m eucl=${neighbourPair.minEuclideanSeparationM?.toFixed(2)}m`,
        east: (bounds.minE + bounds.maxE) / 2,
        north: bounds.maxN - 3,
      }],
      highlightPolygonIds: [neighbourPair.polygonA, neighbourPair.polygonB],
    }));
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    scenes,
    geometrySource: GEOMETRY_SOURCE,
    mode5Checksum: mode5.laneChecksum,
    protoChecksum: proto.laneChecksum,
    roadSurfaceChecksum: proto.roadSurfaceChecksum,
    totalSurfaceCount: proto.roadSurfacePolygonCount,
    stage2Summary: stage2.summary,
  }, null, 2));
  console.log(`exported ${scenes.length} stage2 scenes -> ${OUT}`);
}

main();
