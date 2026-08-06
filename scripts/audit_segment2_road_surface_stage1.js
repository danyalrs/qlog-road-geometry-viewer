'use strict';

/**
 * Segment 2 road-surface Stage 1 audit export.
 * Usage: node scripts/audit_segment2_road_surface_stage1.js
 */

const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const LMC = require('../lib/lane_map_cleanup');
const RSS = require('../lib/road_surface_stage1');
const SLM = require('../lib/segment_local_map');
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

function main() {
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

  const mode5Before = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
  const stage1 = RSS.runStage1RoadSurface(cleanup.cleaned, cleanup, { classDGaps, separations });
  const mode5After = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
  const prototype = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleanedWithStage1Surface', timelineIndex: 0 });

  const rendering = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'audit_segment2_d12_rendering_verification.json'), 'utf8',
  ));

  const gapControls = {};
  for (const brk of rendering.interRunBreaks || []) {
    gapControls[brk.gapId] = {
      startS: brk.openIntervalStartS,
      endS: brk.openIntervalEndS,
      openLengthM: brk.openLengthM,
      polygonSpans: stage1.controls.spansGap(brk.openIntervalStartS, brk.openIntervalEndS),
    };
  }
  const cd01 = classDGaps.find((g) => g.gapId === 'CD-01');
  gapControls['CD-01'] = {
    startS: cd01.startS, endS: cd01.endS, openLengthM: cd01.measuredGapLengthM,
    polygonSpans: stage1.controls.spansGap(cd01.startS, cd01.endS),
  };
  const dropout = separations.find((s) => s.classification === 'A' && s.gapM > 200);
  gapControls.dropout_240m = {
    startS: dropout.prevRunS, endS: dropout.nextRunS, openLengthM: dropout.gapM,
    polygonSpans: stage1.controls.spansGap(dropout.prevRunS, dropout.nextRunS),
  };
  const classF = separations.filter((s) => s.classification === 'F');
  gapControls.classF_gaps = classF.map((s) => ({
    startS: s.prevRunS, endS: s.nextRunS, openLengthM: s.gapM,
    polygonSpans: stage1.controls.spansGap(s.prevRunS, s.nextRunS),
  }));
  const d6gaps = classDGaps.filter((g) => g.primaryMechanism === 'D6');
  gapControls.D6_gaps = d6gaps.map((g) => ({
    gapId: g.gapId,
    physicalBoundaryGroup: g.physicalBoundaryGroup,
    startS: g.startS,
    endS: g.endS,
    polygonSpans: stage1.polygons
      .filter((p) => p.leftPb === g.physicalBoundaryGroup || p.rightPb === g.physicalBoundaryGroup)
      .some((p) => RSS.polygonSpansOpenInterval(p, g.startS, g.endS)),
  }));

  const eligibilityOut = {
    generatedAt: new Date().toISOString(),
    segment: SEG2,
    widthDistribution: stage1.widthDistribution,
    summary: stage1.summary,
    eligibilityAudit: stage1.eligibilityAudit,
    splits: stage1.splits,
    gapControls,
    mode5Baseline: {
      laneChecksumBefore: mode5Before.laneChecksum,
      laneChecksumAfter: mode5After.laneChecksum,
      laneChecksumUnchanged: mode5Before.laneChecksum === mode5After.laneChecksum,
      roadSurfaceCount: mode5After.roadSurfacePolygonCount,
      cleanedRunCount: cleanup.cleaned.length,
      fusedFragmentCount: data.routeChunks[0].fusedLaneLines.length,
    },
    prototypeMode: {
      geometrySource: 'cleanedWithStage1Surface',
      roadSurfacePolygonCount: prototype.roadSurfacePolygonCount,
      laneChecksum: prototype.laneChecksum,
    },
  };

  const polygonOut = {
    generatedAt: new Date().toISOString(),
    segment: SEG2,
    polygons: stage1.polygons,
    validationAudit: stage1.validationAudit,
    rejectedPolygons: stage1.rejectedPolygons,
    overlapPairs: stage1.overlapPairs,
    summary: stage1.summary,
    gapControls,
  };

  fs.writeFileSync(path.join(ROOT, 'audit_segment2_road_surface_eligibility.json'), JSON.stringify(eligibilityOut, null, 2));
  fs.writeFileSync(path.join(ROOT, 'audit_segment2_road_surface_polygons.json'), JSON.stringify(polygonOut, null, 2));
  console.log(JSON.stringify({
    eligible: stage1.summary.eligibleBoundaryPairs,
    polygons: stage1.summary.polygonsGenerated,
    area: stage1.summary.totalPolygonAreaM2,
    length: stage1.summary.totalSupportedPolygonLengthM,
    mode5Checksum: mode5After.laneChecksum,
    prototypeSurfaces: prototype.roadSurfacePolygonCount,
  }, null, 2));
}

main();
