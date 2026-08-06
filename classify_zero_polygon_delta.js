#!/usr/bin/env node
/** Classify segments that lost polygons v7→v8. */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

function load(p) {
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
  if (!Array.isArray(d.results)) throw new Error(`${p} invalid`);
  return d;
}

function byId(results) {
  return new Map(results.map((r) => [r.segmentId, r]));
}

function classify(v7, v8) {
  if (v8.polygonCount > 0) return null;
  if (v7.polygonCount === 0) return null;
  const poseSections = v8.poseSectionCount ?? 1;
  const rejected = v8.rejectedPoseTransitions ?? 0;
  const passes = v8.temporalPassCount ?? 1;
  let reason = 'other';
  if (rejected >= 2 && poseSections >= 3) reason = 'excessive_section_fragmentation';
  else if (rejected >= 1 && poseSections >= 2) reason = 'geometry_split_across_pose_sections';
  else if (poseSections > passes) reason = 'insufficient_paired_edge_overlap_within_section';
  else if (rejected > 0) reason = 'false_pose_rejection_or_section_split';
  return {
    segmentId: v8.segmentId,
    v7Polygons: v7.polygonCount,
    v8Polygons: v8.polygonCount,
    v7Passes: v7.temporalPassCount,
    v8Passes: v8.temporalPassCount,
    poseSections,
    rejectedPoseTransitions: rejected,
    firstPoseRejection: v8.firstPoseRejection?.reason ?? null,
    classifiedReason: reason,
  };
}

function main() {
  const v7 = load(process.argv[2] || 'audit_dataset_v7_full.json');
  const v8 = load(process.argv[3] || 'audit_dataset_v8_full.json');
  const v7m = byId(v7.results);
  const lost = [];
  for (const r of v8.results) {
    const prev = v7m.get(r.segmentId);
    if (!prev) continue;
    const c = classify(prev, r);
    if (c) lost.push(c);
  }
  const summary = {
    v7ZeroPolygon: v7.zeroPolygonCount,
    v8ZeroPolygon: v8.zeroPolygonCount,
    newlyZeroFromV7NonZero: lost.length,
    byReason: lost.reduce((acc, x) => {
      acc[x.classifiedReason] = (acc[x.classifiedReason] || 0) + 1;
      return acc;
    }, {}),
    segments: lost.sort((a, b) => a.segmentId - b.segmentId),
  };
  const out = path.join(ROOT, 'audit_zero_polygon_v7_v8.json');
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main();
