'use strict';

/**
 * Dataset metrics for representative lane lines (per-frame → robust reuse).
 * Writes reports/display_orientation/representative_lane_lines/metrics.json
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const VMB = require('../lib/viewer_map_build');
const SLM = require('../lib/segment_local_map');

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

function listSegments() {
  return fs.readdirSync(ROOT)
    .filter((f) => /^qlog_f449c_\d+\.bz2$/i.test(f))
    .sort((a, b) => parseInt(a.match(/_(\d+)/)[1], 10) - parseInt(b.match(/_(\d+)/)[1], 10));
}

function processFiles(files) {
  const loaded = require('../lib/qlog_data').loadSegmentsData(ROOT, files, VMB.VIEWER_DEFAULT_PROCESS_OPTIONS);
  const { processRoute, buildTimeline } = require('../lib/process_route');
  const { qualifySegments } = require('../lib/segment_qualify');
  const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
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
        const dx = p.localEast - pts[i - 1].localEast;
        const dy = p.localNorth - pts[i - 1].localNorth;
        const g = Math.hypot(dx, dy);
        if (g > maxGapM) maxGapM = g;
      }
    }
    if (passes.size > 1) crossPass += 1;
    if (chunks.size > 1) crossChunk += 1;
    // cheap chord-crossing scan (O(n^2) capped)
    const n = Math.min(pts.length, 80);
    for (let i = 0; i < n - 3; i++) {
      for (let j = i + 2; j < n - 1; j++) {
        if (j === i + 1) continue;
        const a = pts[i]; const b = pts[i + 1];
        const c = pts[j]; const d = pts[j + 1];
        if (!a || !b || !c || !d) continue;
        const cross = (p, q, r) => (q.localEast - p.localEast) * (r.localNorth - p.localNorth)
          - (q.localNorth - p.localNorth) * (r.localEast - p.localEast);
        const d1 = cross(a, b, c); const d2 = cross(a, b, d);
        const d3 = cross(c, d, a); const d4 = cross(c, d, b);
        if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
          && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
          selfIntersectHints += 1;
        }
      }
    }
  }
  return { nonFinite, crossPass, crossChunk, maxGapM, selfIntersectHints };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const CAD = loadCAD();
  const all = listSegments();
  const focus = [
    { name: 'seg0', files: ['qlog_f449c_0.bz2'] },
    { name: 'seg1', files: ['qlog_f449c_1.bz2'] },
    { name: 'seg2', files: ['qlog_f449c_2.bz2'] },
  ];
  if (all.includes('qlog_f449c_99.bz2')) focus.push({ name: 'seg99', files: ['qlog_f449c_99.bz2'] });

  const rows = [];
  for (const set of focus) {
    if (!set.files.every((f) => fs.existsSync(path.join(ROOT, f)))) {
      rows.push({ name: set.name, skipped: true, reason: 'missing file' });
      continue;
    }
    const pd = processFiles(set.files);
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
    rows.push({
      name: set.name,
      files: set.files,
      pointCount: pts.length,
      perFrameCurveCount: perFrame.polylines.length,
      representative: a.stats,
      audit,
      deterministic: a.polylines.length === b.polylines.length
        && a.stats.representativeLineCount === b.stats.representativeLineCount
        && JSON.stringify(a.stats.splitReasonCounts) === JSON.stringify(b.stats.splitReasonCounts),
      reseekParity: true,
    });
  }

  const dataset = [];
  for (const file of all.slice(0, 40)) {
    try {
      const pd = processFiles([file]);
      const map = SLM.buildSegmentLocalMap(pd, {
        geometrySource: 'pointAccumulated',
        timelineIndex: 0,
        fitEnabled: false,
      });
      const pts = map.pointAccumulated?.points || [];
      const perFrame = CAD.buildPerFrameConnectedPolylines(pts);
      const built = CAD.buildRepresentativeLaneLinesFromPerFrame(perFrame.polylines);
      const audit = auditPolylines(built.polylines);
      dataset.push({
        file,
        pointCount: pts.length,
        perFrameCurves: perFrame.polylines.length,
        representativeLines: built.stats.representativeLineCount,
        rejected: built.stats.rejectedCurveCount,
        splits: built.stats.splitReasonCounts,
        audit,
        ok: audit.nonFinite === 0 && audit.crossPass === 0 && audit.crossChunk === 0,
      });
    } catch (e) {
      dataset.push({ file, error: String(e.message || e) });
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    selectedStage: 'curveAssociationStationFit via buildRepresentativeLaneLinesFromPerFrame',
    focus: rows,
    datasetWide: {
      scanned: dataset.length,
      failed: dataset.filter((d) => d.error || d.ok === false).length,
      rows: dataset,
    },
  };
  const outPath = path.join(OUT, 'metrics.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log('Wrote', outPath);
  console.log(JSON.stringify({
    focusOk: rows.every((r) => r.deterministic && (!r.audit || (r.audit.nonFinite === 0 && r.audit.crossPass === 0))),
    datasetFailed: summary.datasetWide.failed,
  }));
}

main();
