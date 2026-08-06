'use strict';

const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const SLM = require('../lib/segment_local_map');
const { computeCoordinateChecksum } = require('../lib/visible_gap_reconstruction');
const { computeRoadPolygonChecksum } = require('../lib/segment_local_map');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const { PRE_STAGE7_SEGMENT_OPTS } = require('../lib/lane_continuity_stage6');
const { PRE_STAGE8_SEGMENT_OPTS } = require('../lib/lane_continuity_stage8');
const { PROCESSING_VERSION } = require('../lib/version');
const stage1 = require('../audit_segment2_lane_continuity_stage1.json');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots', 'segment2_lane_mapping_comparison');
const OUT = path.join(OUT_DIR, 'comparison_scenes.json');
const PB_COLORS = { PB0: '#2563eb', PB1: '#16a34a', PB2: '#7c3aed' };

const VARIANTS = [
  {
    id: 'A',
    sceneKey: 'baseline_pre_stage7',
    label: 'Earlier baseline (pre Stage 7/8)',
    processingVersionLabel: '2026-07-24-fusion-v11 (Stage 6 accepted)',
    processOpts: { ...PRE_STAGE7_SEGMENT_OPTS },
    flagSummary: 'positiveBoundaryContinuityBridgeEnabled=false, visibleGapReconstructionEnabled=false',
  },
  {
    id: 'B',
    sceneKey: 'current_stage8_disabled',
    label: 'Current code, Stage 8 disabled',
    processingVersionLabel: `${PROCESSING_VERSION} + PRE_STAGE8 flags`,
    processOpts: { ...PRE_STAGE8_SEGMENT_OPTS },
    flagSummary: 'positiveBoundaryContinuityBridgeEnabled=true, visibleGapReconstructionEnabled=false',
  },
  {
    id: 'C',
    sceneKey: 'current_stage7_8_disabled',
    label: 'Current code, Stages 7+8 disabled',
    processingVersionLabel: `${PROCESSING_VERSION} + PRE_STAGE7 flags`,
    processOpts: { ...PRE_STAGE7_SEGMENT_OPTS },
    flagSummary: 'positiveBoundaryContinuityBridgeEnabled=false, visibleGapReconstructionEnabled=false',
  },
];

function loadData(opts) {
  const seg = path.join(ROOT, 'qlog_f449c_2.bz2');
  const model = extractModel(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const gps = extractGps(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  return processRoute(model, gps, { pipelineMode: 'C', ...opts });
}

function boundsForPoints(pts, pad = 10) {
  if (!pts.length) return null;
  return {
    minE: Math.min(...pts.map((p) => p.east)) - pad,
    maxE: Math.max(...pts.map((p) => p.east)) + pad,
    minN: Math.min(...pts.map((p) => p.north)) - pad,
    maxN: Math.max(...pts.map((p) => p.north)) + pad,
  };
}

function fragmentsForMap(map) {
  return (map.laneFragments || []).map((f) => ({
    physicalBoundaryId: f.physicalBoundaryId,
    laneTrackId: f.laneTrackId,
    color: PB_COLORS[f.physicalBoundaryId] || '#334155',
    width: 2.5,
    dashed: false,
    points: (f.points || []).map((p) => ({
      east: p.east,
      north: p.north,
      generated: !!(p.generated || p.interpolationProvenance?.generated),
    })),
  }));
}

function gapMarkersForTargets(map, ids) {
  const markers = [];
  for (const id of ids) {
    const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
    const run = (map.laneFragments || []).find((f) =>
      f.physicalBoundaryId === dc.physicalBoundaryId
      && f.sMin <= dc.endpointRouteS + 1
      && f.sMax >= dc.candidateStartRouteS - 1);
    if (!run?.points?.length) continue;
    let jump = null;
    for (let i = 0; i < run.points.length - 1; i++) {
      const s0 = run.sdPoints?.[i]?.s;
      const s1 = run.sdPoints?.[i + 1]?.s;
      if (s0 <= dc.endpointRouteS + 0.5 && s1 >= dc.candidateStartRouteS - 0.5) {
        const d = Math.hypot(run.points[i + 1].east - run.points[i].east, run.points[i + 1].north - run.points[i].north);
        if (d > 1) jump = { a: run.points[i], b: run.points[i + 1], openLengthM: d };
      }
    }
    if (!jump) {
      const pre = run.points.find((p, i) => Math.abs((run.sdPoints?.[i]?.s ?? 0) - dc.endpointRouteS) < 2);
      const post = run.points.find((p, i) => Math.abs((run.sdPoints?.[i]?.s ?? 0) - dc.candidateStartRouteS) < 2);
      if (pre && post) {
        jump = {
          a: pre,
          b: post,
          openLengthM: Math.hypot(post.east - pre.east, post.north - pre.north),
        };
      }
    }
    if (jump) markers.push({ gapId: id, ...jump });
  }
  return markers;
}

function buildVariant(v) {
  const data = loadData(v.processOpts);
  const map = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
  const cleaned = map.laneCleanup?.cleaned || [];
  return {
    ...v,
    codeVersion: PROCESSING_VERSION,
    laneChecksum: map.laneChecksum,
    coordinateChecksum: map.laneCleanup?.stats?.coordinateChecksum || computeCoordinateChecksum(cleaned),
    roadSurfaceChecksum: computeRoadPolygonChecksum(data.routeChunks[0]?.roadSurfacePolygons || []),
    fusedFragments: data.routeChunks[0]?.fusedLaneLines?.length ?? 0,
    cleanedRuns: cleaned.length,
    interpolatedPointCount: cleaned.reduce((n, r) =>
      n + (r.points || []).filter((p) => p.generated || p.interpolationProvenance?.generated).length, 0),
    map,
    fragments: fragmentsForMap(map),
    allPoints: map.laneFragments.flatMap((f) => f.points || []),
  };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const built = VARIANTS.map(buildVariant);

  const sharedOverviewBounds = boundsForPoints(built[0].allPoints, 12);
  const pb1Pts = built[0].map.laneFragments
    .filter((f) => f.physicalBoundaryId === 'PB1')
    .flatMap((f) => f.points || []);
  const pb1MidBounds = boundsForPoints(
    pb1Pts.filter((p, i, arr) => {
      const frag = built[0].map.laneFragments.find((f) => f.points?.includes(p));
      const s = frag?.sdPoints?.[frag.points.indexOf(p)]?.s;
      return s == null || (s >= 540 && s <= 660);
    }),
    8,
  );

  const zoomTargets = [
    { sceneId: 'overview_mode5', label: 'Full Segment 2 Mode 5', bounds: sharedOverviewBounds, showGapMarkers: false },
    { sceneId: 'pb1_540_660', label: 'PB1 540–660 m', bounds: pb1MidBounds, showGapMarkers: true },
    { sceneId: 'DC-010', label: 'DC-010 zoom', bounds: null, showGapMarkers: true, gapId: 'DC-010' },
    { sceneId: 'DC-012', label: 'DC-012 zoom', bounds: null, showGapMarkers: true, gapId: 'DC-012' },
  ];

  for (const t of zoomTargets) {
    if (t.gapId) {
      const dc = stage1.disconnections.find((d) => d.disconnectionId === t.gapId);
      const pts = built[0].map.laneFragments
        .filter((f) => f.physicalBoundaryId === 'PB1')
        .flatMap((f) => (f.points || []).filter((p, i) => {
          const s = f.sdPoints?.[i]?.s;
          return s >= dc.endpointRouteS - 8 && s <= dc.candidateStartRouteS + 8;
        }));
      t.bounds = boundsForPoints(pts, 6);
    }
  }

  const scenes = [];
  for (const variant of built) {
    for (const view of zoomTargets) {
      scenes.push({
        sceneId: `compare_${variant.id}_${view.sceneId}`,
        variantId: variant.id,
        variantLabel: variant.label,
        viewId: view.sceneId,
        viewLabel: view.label,
        geometrySource: 'cleaned',
        modeLabel: 'Mode 5 cleaned',
        bounds: view.bounds,
        laneChecksum: variant.laneChecksum,
        coordinateChecksum: variant.coordinateChecksum,
        roadSurfaceChecksum: variant.roadSurfaceChecksum,
        flagSummary: variant.flagSummary,
        fragments: variant.fragments,
        gapMarkers: view.showGapMarkers
          ? (view.gapId ? gapMarkersForTargets(variant.map, [view.gapId]) : gapMarkersForTargets(variant.map, ['DC-009', 'DC-010', 'DC-011', 'DC-012']))
          : [],
        showGapMarkers: view.showGapMarkers,
        stage1Hud: true,
      });
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    segment: 'qlog_f449c_2.bz2',
    gitCommit: null,
    note: 'No git repository detected; baseline identified from audit artifacts and feature flags.',
    baselineIdentification: {
      preStage7ProcessingVersion: '2026-07-24-fusion-v11',
      stage7ProcessingVersion: '2026-07-24-fusion-v12',
      currentProcessingVersion: PROCESSING_VERSION,
      preStage7Flags: PRE_STAGE7_SEGMENT_OPTS,
      preStage8Flags: PRE_STAGE8_SEGMENT_OPTS,
      acceptedStage6LaneChecksum: 'ff6d115e',
      acceptedStage7LaneChecksum: '10845acd',
    },
    variants: built.map((v) => ({
      id: v.id,
      label: v.label,
      processingVersionLabel: v.processingVersionLabel,
      codeVersion: v.codeVersion,
      flags: v.processOpts,
      flagSummary: v.flagSummary,
      laneChecksum: v.laneChecksum,
      coordinateChecksum: v.coordinateChecksum,
      roadSurfaceChecksum: v.roadSurfaceChecksum,
      fusedFragments: v.fusedFragments,
      cleanedRuns: v.cleanedRuns,
      interpolatedPointCount: v.interpolatedPointCount,
    })),
    viewport: { width: 1280, height: 800 },
    scenes,
  };

  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  fs.writeFileSync(
    path.join(ROOT, 'audit_segment2_lane_mapping_comparison.json'),
    JSON.stringify({
      ...payload,
      scenes: payload.scenes.map((s) => ({
        sceneId: s.sceneId,
        variantId: s.variantId,
        viewId: s.viewId,
        laneChecksum: s.laneChecksum,
        coordinateChecksum: s.coordinateChecksum,
      })),
    }, null, 2),
  );
  console.log('Wrote', OUT, `(${scenes.length} scenes, ${built.length} variants)`);
}

main();
