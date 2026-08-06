#!/usr/bin/env node
/**
 * Stage 13A — fusion-path tracing CLI.
 * Usage: node stage13a_fusion_trace.js [--segments 90,65] [--controls]
 */
const fs = require('fs');
const path = require('path');
const { PROCESSING_VERSION } = require('./lib/version');
const { traceSegment, NEGATIVE_CONTROLS } = require('./lib/stage13a_fusion_trace');

const ROOT = __dirname;

function parseArgs() {
  const args = process.argv.slice(2);
  let segments = [90, 65];
  let includeControls = false;
  let out = path.join(ROOT, 'audit_stage13a_fusion_trace.json');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--segments' && args[i + 1]) {
      segments = args[++i].split(',').map((n) => parseInt(n.trim(), 10));
    } else if (args[i] === '--controls') includeControls = true;
    else if (args[i] === '--out' && args[i + 1]) out = args[++i];
  }
  if (includeControls) {
    segments = [...new Set([...segments, ...Object.values(NEGATIVE_CONTROLS)])];
  }
  return { segments, out };
}

function main() {
  const { segments, out } = parseArgs();
  console.log(`Stage 13A fusion trace — ${segments.length} segment(s), version ${PROCESSING_VERSION}`);

  const results = [];
  for (const seg of segments.sort((a, b) => a - b)) {
    process.stdout.write(`  seg ${seg}...`);
    try {
      const trace = traceSegment(seg);
      results.push(trace);
      const recon = trace.primaryReconciliation;
      console.log(` poly=${trace.productionPolygonCount} ${recon?.discrepancy || 'ok'}`);
    } catch (e) {
      console.log(` ERROR ${e.message}`);
      results.push({ segmentId: seg, error: e.message });
    }
  }

  const output = {
    auditedAt: new Date().toISOString(),
    processingVersion: PROCESSING_VERSION,
    stage13aStatus: 'approved',
    negativeControls: NEGATIVE_CONTROLS,
    note: 'Read-only trace — no production geometry changes',
    results,
  };

  const outPath = path.isAbsolute(out) ? out : path.join(ROOT, out);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${outPath}`);

  const seg90 = results.find((r) => r.segmentId === 90);
  if (seg90?.primaryReconciliation) {
    const r = seg90.primaryReconciliation;
    console.log(`\nSeg 90 reconciliation:`);
    console.log(`  aggregate paired coverage: ${r.aggregateRawPairedCoverageM?.toFixed(1)} m`);
    console.log(`  qualifying run overlap: ${r.qualifyingPairedRunOverlapM?.toFixed(1)} m`);
    console.log(`  polygon intervals: ${r.polygonIntervalsProduced}`);
    console.log(`  ${r.explanation}`);
  }

  const seg65 = results.find((r) => r.segmentId === 65);
  if (seg65?.segment65Inspection) {
    const i = seg65.segment65Inspection;
    console.log(`\nSeg 65 polygon inspection:`);
    console.log(`  samples: ${i.sampleCount}, intersections: ${i.selfIntersectionCount}`);
    console.log(`  verdict: ${i.verdict}`);
    console.log(`  widths: ${i.laneWidthsAtSamples.map((w) => w.width.toFixed(2)).join(', ')} m`);
  }
}

if (require.main === module) main();
