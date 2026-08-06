'use strict';

/**
 * Export Segment 2 lane-continuity Stage 1 verification scenes.
 */
const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const SLM = require('../lib/segment_local_map');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots', 'segment2_lane_continuity_stage1');
const OUT = path.join(OUT_DIR, 'verification_scenes.json');
const AUDIT = path.join(ROOT, 'audit_segment2_lane_continuity_stage1.json');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const PB_COLORS = { PB0: '#2563eb', PB1: '#16a34a', PB2: '#7c3aed' };

function loadData() {
  const seg = path.join(ROOT, 'qlog_f449c_2.bz2');
  const model = extractModel(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const gps = extractGps(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  return processRoute(model, gps, { pipelineMode: 'C' });
}

function boundsForPoints(pts, pad = 4) {
  if (!pts.length) return null;
  return {
    minE: Math.min(...pts.map((p) => p.east)) - pad,
    maxE: Math.max(...pts.map((p) => p.east)) + pad,
    minN: Math.min(...pts.map((p) => p.north)) - pad,
    maxN: Math.max(...pts.map((p) => p.north)) + pad,
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

function main() {
  if (!fs.existsSync(AUDIT)) {
    console.error('Run audit first:', AUDIT);
    process.exit(1);
  }
  const audit = JSON.parse(fs.readFileSync(AUDIT, 'utf8'));
  const data = loadData();
  const mode5 = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
  const fusedMap = SLM.buildSegmentLocalMap(data, { geometrySource: 'fused', timelineIndex: 0 });
  const obsMap = SLM.buildSegmentLocalMap(data, { geometrySource: 'observations', timelineIndex: 0 });
  const frags = mode5.laneFragments;
  const fusedFrags = fusedMap.laneFragments;
  const obsFrags = obsMap.laneFragments;

  const allPts = frags.flatMap((f) => f.points || []);
  const overviewBounds = boundsForPoints(allPts, 8);

  const scenes = [{
    sceneId: 'lc_stage1_overview_endpoints',
    id: 'overview',
    modeLabel: 'laneContinuityStage1',
    geometrySource: 'cleaned',
    bounds: overviewBounds,
    fragments: frags.map((f) => ({
      points: f.points,
      physicalBoundaryId: f.physicalBoundaryId,
      color: PB_COLORS[f.physicalBoundaryId] || '#334155',
      width: 2.5,
      runId: f.runId ?? f.fragmentIndex,
    })),
    endpointMarkers: audit.endpoints.map((ep) => ({
      id: ep.endpointId,
      index: ep.endpointIndex + 1,
      east: ep.endpointCoord?.east,
      north: ep.endpointCoord?.north,
      label: String(ep.endpointIndex + 1),
      pb: ep.physicalBoundaryId,
    })),
    laneChecksum: mode5.laneChecksum,
    laneContinuityHud: true,
    timelineIndex: 0,
  }];

  for (const dc of audit.disconnections) {
    const prev = frags.find((f) => (f.runId ?? f.fragmentIndex) === dc.cleanedRunIds.preceding);
    const next = frags.find((f) => (f.runId ?? f.fragmentIndex) === dc.cleanedRunIds.following);
    if (!prev || !next) continue;
    const pts = [...(prev.points || []), ...(next.points || [])];
    const midS = (dc.endpointRouteS + dc.candidateStartRouteS) / 2;
    let bounds = boundsForPoints(pts, 6);
    if (!bounds) continue;

    scenes.push({
      sceneId: `lc_stage1_${dc.disconnectionId}`,
      id: dc.disconnectionId,
      modeLabel: 'laneContinuityCloseup',
      geometrySource: 'cleaned',
      bounds,
      fragments: [prev, next].map((f) => ({
        points: f.points,
        physicalBoundaryId: f.physicalBoundaryId,
        color: PB_COLORS[f.physicalBoundaryId] || '#334155',
        width: 3,
        runId: f.runId ?? f.fragmentIndex,
      })),
      gapMarkers: [{
        gapId: dc.classDGapId || dc.disconnectionId,
        openLengthM: dc.alongTrackGapM,
        a: prev.points[prev.points.length - 1],
        b: next.points[0],
      }],
      diagnosticLabels: [
        { text: dc.disconnectionId, east: (bounds.minE + bounds.maxE) / 2, north: bounds.maxN - 1 },
        { text: `${dc.physicalBoundaryId} gap=${dc.alongTrackGapM.toFixed(1)}m eucl=${dc.euclideanGapM?.toFixed(1)}m`, east: (bounds.minE + bounds.maxE) / 2, north: bounds.maxN - 3 },
        { text: `hΔ=${dc.headingDifferenceDeg?.toFixed(1)}° cause=${dc.primaryCause}`, east: (bounds.minE + bounds.maxE) / 2, north: bounds.minN + 1 },
        { text: `verdict=${dc.preliminaryVerdict} stage=${dc.firstPipelineStageDisconnected}`, east: (bounds.minE + bounds.maxE) / 2, north: bounds.minN + 3 },
      ],
      showGapMarkers: true,
      laneContinuityHud: true,
      laneChecksum: mode5.laneChecksum,
      routeSTarget: midS,
      timelineIndex: 0,
      disconnectionMeta: {
        disconnectionId: dc.disconnectionId,
        primaryCause: dc.primaryCause,
        preliminaryVerdict: dc.preliminaryVerdict,
        safeConnectionCandidate: dc.safeConnectionCandidate,
      },
    });

    const gapMinS = Math.min(dc.endpointRouteS, dc.candidateStartRouteS) - 5;
    const gapMaxS = Math.max(dc.endpointRouteS, dc.candidateStartRouteS) + 5;
    const samePb = (f) => f.physicalBoundaryId === dc.physicalBoundaryId
      || f.laneTrackId === dc.trackId;
    const inGapS = (f) => (f.sMax ?? 0) >= gapMinS && (f.sMin ?? 0) <= gapMaxS;
    const fusedInGap = fusedFrags.filter((f) => samePb(f) && inGapS(f));
    const obsInGap = obsFrags.filter((f) => samePb(f) && inGapS(f));
    const pipelineFrags = [
      ...fusedInGap.map((f) => ({
        points: f.points,
        physicalBoundaryId: f.physicalBoundaryId,
        color: '#94a3b8',
        width: 2,
        dashed: true,
        layer: 'pre-fusion',
      })),
      ...obsInGap.map((f) => ({
        points: f.points,
        physicalBoundaryId: f.physicalBoundaryId,
        color: '#ea580c',
        width: 1.5,
        dashed: true,
        layer: 'raw-observations',
      })),
      ...[prev, next].map((f) => ({
        points: f.points,
        physicalBoundaryId: f.physicalBoundaryId,
        color: PB_COLORS[f.physicalBoundaryId] || '#334155',
        width: 3,
        dashed: false,
        layer: 'post-cleanup',
      })),
    ];
    scenes.push({
      sceneId: `lc_stage1_${dc.disconnectionId}_pipeline`,
      id: `${dc.disconnectionId}_pipeline`,
      modeLabel: 'laneContinuityPipelineCompare',
      geometrySource: 'cleaned+fused+observations',
      bounds,
      fragments: pipelineFrags,
      gapMarkers: [{
        gapId: dc.classDGapId || dc.disconnectionId,
        openLengthM: dc.alongTrackGapM,
        a: prev.points[prev.points.length - 1],
        b: next.points[0],
      }],
      diagnosticLabels: [
        { text: `${dc.disconnectionId} pipeline`, east: (bounds.minE + bounds.maxE) / 2, north: bounds.maxN - 1 },
        { text: 'gray dashed=fused | orange=raw obs | solid=cleaned', east: (bounds.minE + bounds.maxE) / 2, north: bounds.maxN - 3 },
        { text: `firstSplit=${dc.firstPipelineStageDisconnected}`, east: (bounds.minE + bounds.maxE) / 2, north: bounds.minN + 1 },
      ],
      showGapMarkers: true,
      laneContinuityHud: true,
      laneChecksum: mode5.laneChecksum,
      routeSTarget: midS,
      timelineIndex: 0,
      disconnectionMeta: {
        disconnectionId: dc.disconnectionId,
        primaryCause: dc.primaryCause,
        preliminaryVerdict: dc.preliminaryVerdict,
        comparisonType: 'pre_fusion_pre_cleanup_raw_obs',
        firstPipelineStageDisconnected: dc.firstPipelineStageDisconnected,
      },
    });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    scenes,
    laneChecksum: mode5.laneChecksum,
    disconnectionCount: audit.disconnections.length,
    endpointCount: audit.endpoints.length,
  }, null, 2));
  console.log(`exported ${scenes.length} scenes -> ${OUT}`);
}

main();
