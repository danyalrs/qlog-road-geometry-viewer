'use strict';

/**
 * Section A summary — endpoint coverage diagnosis, condensed per boundary.
 * Reads reports/constructed_fragments_validation/endpoint_coverage_diagnosis.json
 * and prints a compact before-fix summary for the report.
 */

const d = require('../reports/constructed_fragments_validation/endpoint_coverage_diagnosis.json');

function summarize() {
  console.log('ENDPOINT COVERAGE SUMMARY (before fix)');
  console.log('='.repeat(100));
  for (const seg of ['14', '16']) {
    console.log(`\n=== Segment ${seg} ===`);
    for (const [bk, b] of Object.entries(d[seg].perBoundary)) {
      const stages = {};
      for (const x of [...b.excludedBefore, ...b.excludedAfter]) {
        const k = x.stage;
        stages[k] = (stages[k] || 0) + 1;
      }
      console.log(`\n  Boundary ${bk} (${b.fragments} fragments)`);
      console.log(`    START: first dot s=${b.firstPoint.s} m (ts ${b.firstPoint.ts}) | first frag s=${b.firstFragmentPoint.s} m (ts ${b.firstFragmentPoint.ts}) | gap ${b.startGapM} m / ${b.startGapSec ?? '?'} s | excluded ${b.excludedBeforeCount}`);
      console.log(`    END:   last  dot s=${b.lastPoint.s} m (ts ${b.lastPoint.ts}) | last  frag s=${b.lastFragmentPoint.s} m (ts ${b.lastFragmentPoint.ts}) | gap ${b.endGapM} m / ${b.endGapSec ?? '?'} s | excluded ${b.excludedAfterCount}`);
      console.log(`    exclusion stages: ${JSON.stringify(stages)}`);
    }
  }
}

summarize();
