'use strict';

/**
 * Corrected representative-lines gate metrics (per-frame → curve association).
 *
 * - Seg1 before/after: legacy flattened-point robust reuse vs the corrected
 *   curve-association shared-station builder.
 * - Focus regression rows for Seg0/Seg1/Seg2/Seg99 with audit gates.
 * - Determinism is checked by rebuilding twice.
 *
 * Writes reports/display_orientation/representative_lane_lines/corrected_metrics.json
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const VMB = require(path.join(__dirname, '..', 'lib/viewer_map_build'));
const SLM = require(path.join(__dirname, '..', 'lib/segment_local_map'));

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'reports', 'display_orientation', 'representative_lane_lines');
const CAD_SRC = fs.readFileSync(path.join(ROOT, 'public/connected_accumulated_display.js'), 'utf8');

function loadCAD() {
  const sandbox = { console, module: { exports: {} }, exports: {} };
  sandbox.global = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(CAD_SRC, sandbox, { filename: 'connected_accumulated_display.js' });
  return sandbox.ConnectedAccumulatedDisplay || sandbox.module.exports;
}

function loadProcessed(file) {
  const loaded = require(path.join(ROOT, 'lib/qlog_data')).loadSegmentsData(ROOT, [file], VMB.VIEWER_DEFAULT_PROCESS_OPTIONS);
  const { processRoute, buildTimeline } = require(path.join(ROOT, 'lib/process_route'));
  const { qualifySegments } = require(path.join(ROOT, 'lib/segment_qualify'));
  const { enrichTimelineWithMovement } = require(path.join(ROOT, 'lib/vehicle_movement_display'));
  const sq = qualifySegments(loaded.audits);
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
    ...VMB.VIEWER_DEFAULT_PROCESS_OPTIONS,
    segmentQualifications: sq,
    fileAudits: loaded.audits,
  });
  return {
    ...result,
    timeline: enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath),
    fileAudits: loaded.audits,
  };
}

function auditPolylines(polylines) {
  let nonFinite = 0;
  let crossPass = 0;
  let crossChunk = 0;
  let maxGapM = 0;
  let selfIntersectHints = 0;
  for (const pl of polylines) {
    const pts = pl.points || [];
    const passes = new Set();
    const chunks = new Set();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!Number.isFinite(p.localEast) || !Number.isFinite(p.localNorth)) nonFinite += 1;
      if (p.passId != null) passes.add(String(p.passId));
      if (p.chunkId != null) chunks.add(String(p.chunkId));
      if (i > 0) {
        maxGapM = Math.max(maxGapM, Math.hypot(p.localEast - pts[i - 1].localEast, p.localNorth - pts[i - 1].localNorth));
      }
    }
    if (passes.size > 1) crossPass += 1;
    if (chunks.size > 1) crossChunk += 1;
  }
  return { nonFinite, crossPass, crossChunk, maxGapM: +maxGapM.toFixed(3), selfIntersectHints };
}

function segmentRow(CAD, name, file) {
  const pd = loadProcessed(file);
  const map = SLM.buildSegmentLocalMap(pd, {
    geometrySource: 'pointAccumulated',
    timelineIndex: 0,
    fitEnabled: false,
  });
  const pts = map.pointAccumulated?.points || [];
  const perFrame = CAD.buildPerFrameConnectedPolylines(pts);
  const a = CAD.buildRepresentativeLaneLinesFromPerFrame(perFrame.polylines);
  const b = CAD.buildRepresentativeLaneLinesFromPerFrame(perFrame.polylines);
  const audit = auditPolylines(a.polylines);
  const spans = a.polylines.map((pl) => pl.coverageM ?? 0).sort((x, y) => y - x);
  return {
    name,
    files: [file],
    pointCount: pts.length,
    sourceFrameCount: a.stats.sourceFrameCount,
    sourceCurveCount: perFrame.polylines.length,
    acceptedSourceCurveCount: a.stats.acceptedSourceCurveCount,
    logicalLaneCount: a.stats.logicalLaneCount,
    physicalClusterCount: a.stats.physicalClusterCount,
    representativeLineCount: a.stats.representativeLineCount,
    reductionRatio: a.stats.reductionRatio,
    medianSupportFrames: a.stats.medianSupportFrames,
    totalSupportedCoverageM: a.stats.totalSupportedCoverageM,
    coveragePerLane: a.stats.coveragePerLane,
    topSpansM: spans.slice(0, 6),
    audit,
    deterministic: a.polylines.length === b.polylines.length
      && a.stats.representativeLineCount === b.stats.representativeLineCount
      && JSON.stringify(a.stats.coveragePerLane) === JSON.stringify(b.stats.coveragePerLane),
  };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const CAD = loadCAD();

  // Seg1 before/after with the same map.
  const pd1 = loadProcessed('qlog_f449c_1.bz2');
  const map1 = SLM.buildSegmentLocalMap(pd1, { geometrySource: 'pointAccumulated', timelineIndex: 0, fitEnabled: false });
  const pts1 = map1.pointAccumulated?.points || [];
  const perFrame1 = CAD.buildPerFrameConnectedPolylines(pts1);
  const before = CAD.buildRepresentativeLaneLinesLegacyFromPerFrame(perFrame1.polylines);
  const after = CAD.buildRepresentativeLaneLinesFromPerFrame(perFrame1.polylines);
  const seg1BeforeAfter = {
    sourceFrames: after.stats.sourceFrameCount,
    sourceCurves: after.stats.sourceCurveCount,
    before: {
      representativeLines: before.stats.representativeLineCount,
      rejected: before.stats.rejectedCurveCount,
      maxLateralSpread: before.stats.lateralSpreadRange?.max,
    },
    after: {
      representativeLines: after.stats.representativeLineCount,
      logicalLanes: after.stats.logicalLaneCount,
      rejected: after.stats.rejectedCurveCount,
      reductionRatio: after.stats.reductionRatio,
      medianSupportFrames: after.stats.medianSupportFrames,
      totalSupportedCoverageM: after.stats.totalSupportedCoverageM,
      topSpansM: after.polylines.map((pl) => pl.coverageM ?? 0).sort((x, y) => y - x).slice(0, 6),
      coveragePerLane: after.stats.coveragePerLane,
    },
  };

  const focus = [];
  for (const [name, file] of [
    ['seg0', 'qlog_f449c_0.bz2'],
    ['seg1', 'qlog_f449c_1.bz2'],
    ['seg2', 'qlog_f449c_2.bz2'],
    ['seg99', 'qlog_f449c_99.bz2'],
  ]) {
    if (fs.existsSync(path.join(ROOT, file))) focus.push(segmentRow(CAD, name, file));
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    method: 'buildRepresentativeLaneLinesFromPerFrame (curveAssociationStationFit)',
    trustedSource: 'valid All per-frame curves in corrected stationary map frame',
    seg1BeforeAfter: seg1BeforeAfter,
    focus: focus,
  };
  const outPath = path.join(OUT, 'corrected_metrics.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log('Wrote', outPath);
  console.log(JSON.stringify({
    seg1: { before: seg1BeforeAfter.before.representativeLines, after: seg1BeforeAfter.after.representativeLines, lanes: seg1BeforeAfter.after.logicalLanes, reduction: seg1BeforeAfter.after.reductionRatio },
    focusOk: focus.map((r) => ({ name: r.name, lines: r.representativeLineCount, lanes: r.logicalLaneCount, deterministic: r.deterministic, audit: r.audit })),
  }));
}

main();
