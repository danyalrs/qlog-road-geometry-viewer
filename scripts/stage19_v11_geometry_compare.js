#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(ROOT, 'audit_dataset_v11_full.json');
const OUT = path.join(ROOT, 'reports', 'stage19_v11_geometry_compare_v3.json');

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function main() {
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const tmpOut = path.join(ROOT, 'audit_stage19_v11_compare_tmp.json');
  console.log('Running full 92-segment dataset audit...');
  const r = spawnSync(process.execPath, ['dataset_audit.js', '--all', '--out', tmpOut], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 600000,
  });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    process.exit(1);
  }
  const fresh = JSON.parse(fs.readFileSync(tmpOut, 'utf8'));
  const baseById = new Map(baseline.results.map((x) => [x.segmentId, x]));
  const diffs = [];
  for (const seg of fresh.results) {
    const b = baseById.get(seg.segmentId);
    if (!b) { diffs.push({ segmentId: seg.segmentId, reason: 'missing_baseline' }); continue; }
    if (seg.polygonCount !== b.polygonCount) {
      diffs.push({ segmentId: seg.segmentId, field: 'polygonCount', baseline: b.polygonCount, fresh: seg.polygonCount });
    }
    if (seg.processingVersion !== b.processingVersion) {
      diffs.push({ segmentId: seg.segmentId, field: 'processingVersion', baseline: b.processingVersion, fresh: seg.processingVersion });
    }
  }
  const spot = [2, 5, 6, 54, 58, 99].map((sid) => {
    const b = baseById.get(sid);
    const f = fresh.results.find((x) => x.segmentId === sid);
    return { segmentId: sid, baselinePolygons: b?.polygonCount, freshPolygons: f?.polygonCount, match: b?.polygonCount === f?.polygonCount };
  });
  const report = {
    comparedAt: new Date().toISOString(),
    baselinePath: BASELINE,
    baselineProcessingVersion: baseline.processingVersion,
    freshProcessingVersion: fresh.processingVersion,
    segmentCount: fresh.results.length,
    geometryDifferenceCount: diffs.length,
    baselineFlaggedCount: baseline.flaggedCount,
    freshFlaggedCount: fresh.flaggedCount,
    baselineZeroPolygonCount: baseline.zeroPolygonCount,
    freshZeroPolygonCount: fresh.zeroPolygonCount,
    spotSegments: spot,
    differences: diffs,
    protectedHashes: {
      'lib/version.js': sha256File(path.join(ROOT, 'lib/version.js')),
      'lib/process_route.js': sha256File(path.join(ROOT, 'lib/process_route.js')),
    },
    allPass: diffs.length === 0
      && baseline.flaggedCount === fresh.flaggedCount
      && baseline.zeroPolygonCount === fresh.zeroPolygonCount,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  fs.unlinkSync(tmpOut);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.allPass ? 0 : 1);
}

main();
