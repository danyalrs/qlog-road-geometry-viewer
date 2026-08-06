'use strict';

/**
 * Export authoritative Segment 2 geometry scenes for pixel verification.
 */
const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const SLM = require('../lib/segment_local_map');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'segment2_d12_verification', 'verification_scenes.json');

const MODES = {
  mode3: 'fused',
  mode5: 'cleaned',
  mode7: 'cleanedDebug',
};

const TARGETS = [
  { id: 'CD-00', routeSTarget: 54, sMargin: 15 },
  { id: 'CD-02', routeSTarget: 423, sMargin: 15 },
  { id: 'CD-10', routeSTarget: 429.5, sMargin: 4, gapId: 'CD-10', expectedGapM: 1.466, closeup: true },
  { id: 'CD-12', routeSTarget: 499.3, sMargin: 4, gapId: 'CD-12', expectedGapM: 1.640, closeup: true },
  { id: 'CD-18', routeSTarget: 429.5, sMargin: 4, gapId: 'CD-18', expectedGapM: 1.476, closeup: true },
  { id: 'CD-01_D10_control', routeSTarget: 115, sMargin: 20 },
  { id: 'D6_control', routeSTarget: 340, sMargin: 20 },
  { id: 'classF_control', routeSTarget: 80, sMargin: 20 },
  { id: 'dropout_240m', routeSTarget: 200, sMargin: 130, expectedGapM: 239.94 },
];

const PB_COLORS = { PB0: '#2563eb', PB1: '#16a34a', PB2: '#7c3aed' };

function loadData() {
  const seg = path.join(ROOT, 'qlog_f449c_2.bz2');
  const model = extractModel(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const gps = extractGps(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  return processRoute(model, gps, { pipelineMode: 'C' });
}

function boundsForRouteS(frags, routeS, sMargin) {
  const pts = [];
  for (const f of frags) {
    for (let i = 0; i < (f.sdPoints || []).length; i++) {
      const s = f.sdPoints[i].s;
      if (s >= routeS - sMargin && s <= routeS + sMargin) pts.push(f.points[i]);
    }
  }
  if (!pts.length) return null;
  const pad = 1.5;
  return {
    minE: Math.min(...pts.map((p) => p.east)) - pad,
    maxE: Math.max(...pts.map((p) => p.east)) + pad,
    minN: Math.min(...pts.map((p) => p.north)) - pad,
    maxN: Math.max(...pts.map((p) => p.north)) + pad,
  };
}

function tightBoundsForGap(gap, structural) {
  const g = structural.interRunBreaks?.find((x) => x.gapId === gap.gapId);
  if (!g) return null;
  const pad = 0.35;
  const easts = [g.precedingRunEnd?.east, g.followingRunStart?.east].filter((v) => v != null);
  const norths = [g.precedingRunEnd?.north, g.followingRunStart?.north].filter((v) => v != null);
  if (!easts.length) return null;
  return {
    minE: Math.min(...easts) - pad,
    maxE: Math.max(...easts) + pad,
    minN: Math.min(...norths) - pad,
    maxN: Math.max(...norths) + pad,
  };
}

function findPointAtS(frags, sTarget) {
  for (const f of frags) {
    for (let i = 0; i < (f.sdPoints || []).length; i++) {
      if (Math.abs(f.sdPoints[i].s - sTarget) < 0.06) return f.points[i];
    }
  }
  return null;
}

function buildScene(data, structural, target, modeLabel, geometrySource, bounds, timelineIndex, extra = {}) {
  const map = SLM.buildSegmentLocalMap(data, { geometrySource, timelineIndex });
  const frags = map.laneFragments || [];
  const fragments = frags.map((f) => ({
    points: f.points,
    physicalBoundaryId: f.physicalBoundaryId,
    laneTrackId: f.laneTrackId,
    runId: f.runId,
    color: f.fragmentKind === 'preservedSourcePolyline'
      ? 'rgba(234,179,8,0.95)'
      : PB_COLORS[f.physicalBoundaryId] || '#334155',
    dashed: f.fragmentKind === 'preservedSourcePolyline',
    width: 2.5,
  }));

  const gap = target.gapId ? structural.interRunBreaks?.find((g) => g.gapId === target.gapId) : null;
  const gapMarkers = gap ? [{
    gapId: gap.gapId,
    openLengthM: gap.openLengthM,
    a: gap.precedingRunEnd || findPointAtS(frags, gap.openIntervalStartS),
    b: gap.followingRunStart || findPointAtS(frags, gap.openIntervalEndS),
  }] : [];

  const arrow = SLM.resolveArrowOnSegmentMap(map, data.timeline || [], timelineIndex);

  return {
    sceneId: extra.sceneId || `${modeLabel}_${target.id}_t${timelineIndex}`,
    id: target.id,
    modeLabel,
    geometrySource,
    bounds,
    fragments,
    gapMarkers,
    showGapMarkers: modeLabel === 'mode7',
    laneChecksum: map.laneChecksum,
    roadSurfaceCount: map.roadSurfacePolygonCount ?? 0,
    expectedGapM: target.expectedGapM ?? gap?.openLengthM ?? null,
    timelineIndex,
    closeup: extra.closeup || false,
    playbackHud: extra.playbackHud || false,
    vehicleArrow: arrow,
    routeSTarget: target.routeSTarget,
    sMargin: target.sMargin,
  };
}

function main() {
  const data = loadData();
  const structural = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'audit_segment2_d12_rendering_verification.json'), 'utf8',
  ));

  const mode5Ref = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
  const boundsByTarget = {};
  for (const target of TARGETS) {
    boundsByTarget[target.id] = boundsForRouteS(mode5Ref.laneFragments || [], target.routeSTarget, target.sMargin);
  }

  const scenes = [];
  for (const target of TARGETS) {
    const bounds = boundsByTarget[target.id];
    if (!bounds) continue;
    for (const [modeLabel, geometrySource] of Object.entries(MODES)) {
      scenes.push(buildScene(data, structural, target, modeLabel, geometrySource, bounds, 0));
    }
    if (target.closeup) {
      const tight = tightBoundsForGap(target, structural) || bounds;
      for (const modeLabel of ['mode5', 'mode7']) {
        scenes.push(buildScene(data, structural, target, modeLabel, MODES[modeLabel], tight, 0, {
          sceneId: `${modeLabel}_${target.id}_closeup_t0`,
          closeup: true,
        }));
      }
    }
  }

  const playbackBounds = boundsByTarget['CD-12'];
  for (const timelineIndex of [0, 16]) {
    scenes.push(buildScene(data, structural, { id: 'playback_CD-12', routeSTarget: 499.3, sMargin: 15 }, 'mode5', 'cleaned', playbackBounds, timelineIndex, {
      sceneId: `playback_mode5_CD-12_t${timelineIndex}`,
      playbackHud: true,
    }));
    scenes.push(buildScene(data, structural, { id: 'playback_CD-12', routeSTarget: 499.3, sMargin: 15 }, 'mode7', 'cleanedDebug', playbackBounds, timelineIndex, {
      sceneId: `playback_mode7_CD-12_t${timelineIndex}`,
      playbackHud: true,
    }));
  }

  const checksums = [0, 16].map((idx) => SLM.buildSegmentLocalMap(data, {
    geometrySource: 'cleaned', timelineIndex: idx,
  }).laneChecksum);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ scenes, playbackChecksums: checksums }, null, 2));
  console.log(`exported ${scenes.length} scenes -> ${OUT}`);
}

main();
