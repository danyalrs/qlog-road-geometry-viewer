#!/usr/bin/env node
/**
 * Stage 13 — zero-polygon segment diagnostics (read-only).
 * Usage: node stage13_zero_polygon_diagnostics.js [--all] [--out audit_stage13_zero_polygon.json]
 */
const fs = require('fs');
const path = require('path');
const { PROCESSING_VERSION } = require('./lib/version');
const {
  ZERO_POLYGON_SEGMENTS,
  diagnoseZeroPolygonSegment,
  summarizeZeroPolygonAudit,
} = require('./lib/stage13_zero_polygon_diagnostics');

const ROOT = __dirname;

function parseArgs() {
  const args = process.argv.slice(2);
  let segments = [...ZERO_POLYGON_SEGMENTS];
  let out = path.join(ROOT, 'audit_stage13_zero_polygon.json');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all') segments = [...ZERO_POLYGON_SEGMENTS];
    else if (args[i] === '--segments' && args[i + 1]) {
      segments = args[++i].split(',').map((n) => parseInt(n.trim(), 10));
    } else if (args[i] === '--out' && args[i + 1]) out = args[++i];
  }
  return { segments, out };
}

function main() {
  const { segments, out } = parseArgs();
  console.log(`Stage 13 zero-polygon diagnostics — ${segments.length} segment(s), version ${PROCESSING_VERSION}`);

  const results = [];
  for (const seg of segments) {
    process.stdout.write(`  seg ${seg}...`);
    try {
      const diag = diagnoseZeroPolygonSegment(seg);
      results.push(diag);
      console.log(` ${diag.primaryClassification} (passes=${diag.temporalPassCount} sections=${diag.poseSectionCount})`);
    } catch (e) {
      console.log(` ERROR ${e.message}`);
      results.push({ segmentId: seg, error: e.message });
    }
  }

  const ok = results.filter((r) => !r.error);
  const summary = summarizeZeroPolygonAudit(ok);
  const output = {
    auditedAt: new Date().toISOString(),
    processingVersion: PROCESSING_VERSION,
    stage13Status: 'approved',
    segmentIds: segments,
    summary,
    results: results.sort((a, b) => a.segmentId - b.segmentId),
  };

  const outPath = path.isAbsolute(out) ? out : path.join(ROOT, out);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log(`Classifications: ${JSON.stringify(summary.byClassification)}`);
}

if (require.main === module) main();
