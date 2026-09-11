'use strict';

const fs = require('fs');
const path = require('path');
const VMB = require('../lib/viewer_map_build');
const SLM = require('../lib/segment_local_map');
const CBAO = require('../lib/combined_boundary_anchored_orientation');
const CVLP = require('../lib/combined_visible_lane_projection');
const PALP = require('../lib/point_accumulated_lane_polylines');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'reports', 'display_orientation', 'point_accumulated_lane_polylines');

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

function displayPoints(map, useProjection) {
  return (map.pointAccumulated?.points || []).map((p) => {
    if (!useProjection) {
      return {
        ...p,
        east: p.placedEast ?? p.localEast,
        north: p.placedNorth ?? p.localNorth,
      };
    }
    const r = CVLP.projectCombinedSourceLanePoint(p, map, 'pointAccumulated', {
      mirrorChecked: true,
      useVisibleLaneProjection: true,
    });
    const east = r?.corrected ? r.east : (p.placedEast ?? p.localEast);
    const north = r?.corrected ? r.north : (p.placedNorth ?? p.localNorth);
    return { ...p, east, north };
  }).filter((p) => Number.isFinite(p.east) && Number.isFinite(p.north) && Number.isFinite(p.s));
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const all = listSegments();
  const sampleSets = [
    { name: 'seg1', files: ['qlog_f449c_1.bz2'], multi: false },
    { name: 'combined_012', files: ['qlog_f449c_0.bz2', 'qlog_f449c_1.bz2', 'qlog_f449c_2.bz2'], multi: true },
    { name: 'seg2', files: ['qlog_f449c_2.bz2'], multi: false },
  ];
  if (all.includes('qlog_f449c_99.bz2')) {
    sampleSets.push({ name: 'seg99', files: ['qlog_f449c_99.bz2'], multi: false });
  }

  const rows = [];
  for (const set of sampleSets) {
    const pd = processFiles(set.files);
    let map = SLM.buildSegmentLocalMap(pd, {
      geometrySource: 'pointAccumulated',
      timelineIndex: 0,
      fitEnabled: true,
    });
    if (set.multi) {
      map = CBAO.applyBoundaryAnchoredOrientation(map, pd, { mirrorChecked: true });
    }
    const pts = displayPoints(map, set.multi);
    const built = PALP.buildPointAccumulatedLanePolylines(pts);
    const audit = PALP.auditPolylineSet(built.polylines);
    const built2 = PALP.buildPointAccumulatedLanePolylines(pts);
    rows.push({
      name: set.name,
      files: set.files,
      pointCount: pts.length,
      polylineCount: built.polylines.length,
      diagnostics: built.diagnostics,
      audit,
      deterministic: built.polylines.length === built2.polylines.length
        && built.diagnostics.vertexCount === built2.diagnostics.vertexCount,
    });
  }

  // Dataset-wide light scan: every available segment standalone (may be slow; cap if huge)
  const dataset = [];
  for (const file of all.slice(0, 30)) {
    try {
      const pd = processFiles([file]);
      const map = SLM.buildSegmentLocalMap(pd, {
        geometrySource: 'pointAccumulated',
        timelineIndex: 0,
        fitEnabled: false,
      });
      const pts = displayPoints(map, false);
      const built = PALP.buildPointAccumulatedLanePolylines(pts);
      const audit = PALP.auditPolylineSet(built.polylines);
      dataset.push({
        file,
        pointCount: pts.length,
        polylineCount: built.polylines.length,
        nonFinite: audit.nonFiniteCount,
        backward: audit.backwardOrderingCount,
        crossPass: audit.crossPassCount,
        crossChunk: audit.crossChunkCount,
        identityChange: audit.identityChangeCount,
        maxSegM: audit.maxSegmentLengthM,
      });
    } catch (err) {
      dataset.push({ file, error: String(err.message || err) });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    sampleSets: rows,
    datasetScan: {
      segmentCount: dataset.length,
      rows: dataset,
      totals: {
        nonFinite: dataset.reduce((n, r) => n + (r.nonFinite || 0), 0),
        backward: dataset.reduce((n, r) => n + (r.backward || 0), 0),
        crossPass: dataset.reduce((n, r) => n + (r.crossPass || 0), 0),
        crossChunk: dataset.reduce((n, r) => n + (r.crossChunk || 0), 0),
        identityChange: dataset.reduce((n, r) => n + (r.identityChange || 0), 0),
      },
    },
  };
  fs.writeFileSync(path.join(OUT, 'dataset_metrics.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    samples: rows.map((r) => ({ name: r.name, polylines: r.polylineCount, deterministic: r.deterministic })),
    datasetTotals: report.datasetScan.totals,
  }, null, 2));
}

main();
