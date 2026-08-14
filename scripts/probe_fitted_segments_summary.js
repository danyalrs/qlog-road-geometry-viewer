'use strict';

/** Lib-side fitted acceptance summary using the production viewer map path. */
const fs = require('fs');
const path = require('path');
const {
  summarizeViewerSegment,
  auditSegment9Boundaries,
  VIEWER_DEFAULT_PROCESS_OPTIONS,
} = require('../lib/viewer_map_build');

const ROOT = path.join(__dirname, '..');
const SEGMENTS = [2, 3, 9, 14, 16, 54];
const OUT = path.join(ROOT, 'reports', 'fitted_layer_probe', 'segment_fitted_summary.json');

const report = {
  generatedAt: new Date().toISOString(),
  path: 'viewer_map_build (production)',
  processOptions: VIEWER_DEFAULT_PROCESS_OPTIONS,
  segments: [],
  segment9Audit: null,
};

for (const segNum of SEGMENTS) {
  const seg = `qlog_f449c_${segNum}.bz2`;
  if (!fs.existsSync(path.join(ROOT, seg))) {
    report.segments.push({ segNum, missing: true });
    continue;
  }
  const s = summarizeViewerSegment(ROOT, seg, { fitEnabled: true });
  report.segments.push({
    segNum: s.segNum,
    accepted: s.fitOn.acceptedCount,
    acceptedIds: s.fitOn.acceptedIds,
    statusCounts: s.fitOn.statusCounts,
    polygonCount: s.polygonCountOn,
    polygonUnchanged: s.polygonUnchanged,
    fragmentCount: s.fragmentCount,
    pointCount: s.pointCount,
    processingVersion: s.processingVersion,
    fitEnabled: s.fitOn.fitEnabled,
    trajectory: s.trajectory,
    mapValid: s.mapValid,
  });
}

if (fs.existsSync(path.join(ROOT, 'qlog_f449c_9.bz2'))) {
  report.segment9Audit = auditSegment9Boundaries(ROOT);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
