#!/usr/bin/env node
/**
 * Stage 15 — lane-divider evidence assessment CLI (read-only).
 * Usage: node stage15_lane_divider_assessment.js [--out audit_stage15_lane_divider_evidence.json]
 */
const fs = require('fs');
const path = require('path');
const {
  buildLaneDividerAssessment,
  generateAssessmentMarkdown,
  generateDesignMarkdown,
} = require('./lib/stage15_lane_divider_assessment');

const ROOT = __dirname;

function parseArgs() {
  const args = process.argv.slice(2);
  let out = path.join(ROOT, 'audit_stage15_lane_divider_evidence.json');
  let segments = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) out = args[++i];
    else if (args[i] === '--segments' && args[i + 1]) {
      segments = args[++i].split(',').map((n) => `qlog_f449c_${n.trim()}.bz2`);
    }
  }
  return { out, segments };
}

function main() {
  const { out, segments } = parseArgs();
  const opts = segments ? { filenames: segments } : {};
  const audit = buildLaneDividerAssessment(ROOT, opts);

  const outPath = path.isAbsolute(out) ? out : path.join(ROOT, out);
  fs.writeFileSync(outPath, JSON.stringify(audit, null, 2));

  const reportDir = path.join(ROOT, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const assessmentPath = path.join(reportDir, 'stage15_lane_divider_assessment.md');
  const designPath = path.join(reportDir, 'stage15_lane_counting_design.md');
  fs.writeFileSync(assessmentPath, generateAssessmentMarkdown(audit));
  fs.writeFileSync(designPath, generateDesignMarkdown(audit));

  const d = audit.datasetEvidence;
  console.log(`Stage 15 lane-divider assessment — frozen baseline ${audit.frozenRoadSurfaceVersion}`);
  console.log(`  Segments: ${audit.physicalRouteSegments}, chunks: ${audit.routeChunksDiscovered}`);
  console.log(`  modelV2 frames: ${d.totalModelV2Frames}, with lane lines: ${d.framesWithLaneLines}`);
  console.log(`  laneLineProb median: ${d.laneLineProb?.median?.toFixed(3) ?? 'n/a'}`);
  console.log(`  v11 geometry modified: ${audit.v11GeometryModified}`);
  console.log(`  lane counting complete: ${audit.laneCountingComplete}`);
  console.log(`\nWrote ${outPath}`);
  console.log(`Wrote ${assessmentPath}`);
  console.log(`Wrote ${designPath}`);
}

if (require.main === module) main();

module.exports = { main };
