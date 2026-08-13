'use strict';

/**
 * Section B — full-route-endpoint coverage per physical boundary, evaluated
 * across the COMPLETE route extent (not the playback position). Reports for
 * Segments 14, 16 and regression segments 2, 6, 54, 58, 99:
 *   - route start/end (first/last accumulated point s per boundary)
 *   - constructed-fragment start/end per boundary
 *   - start/end coverage gaps in metres
 *   - number of excluded endpoint points and their rejection stages
 * No tuning is performed on the regression segments.
 */

const path = require('path');
const fs = require('fs');
const SLM = require('../lib/segment_local_map');
const CF = require('../lib/constructed_fragments');
const { processRoute } = require('../lib/process_route');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'reports', 'constructed_fragments_validation');
const SEGS = process.argv.slice(2).length ? process.argv.slice(2) : ['14', '16', '2', '6', '54', '58', '99'];
const D = CF.DEFAULTS;

function load(seg) {
  const file = `qlog_f449c_${seg}.bz2`;
  const me = extractModel(file).map((e) => ({ ...e, sourceFile: file }));
  const ge = extractGps(file).map((e) => ({ ...e, sourceFile: file }));
  const r = processRoute(me, ge, { pipelineMode: 'C' });
  const out = SLM.buildPointAccumulatedFragments(
    r.frames, r.frames.map((x, i) => ({ index: i, logMonoTime: x.logMonoTime })),
    { east: 0, north: 0, headingDeg: 0 }, 0, 0, r.routeChunks, {},
  );
  return { route: r, pa: out.pointAccumulated };
}

function run(seg) {
  const { route, pa } = load(seg);
  const frags = pa.constructedFragments.fragments;
  const allPoints = pa.points;
  const perBoundary = {};

  const fragByBoundary = {};
  for (const f of frags) {
    const key = `${f.groupTrackId}`;
    (fragByBoundary[key] = fragByBoundary[key] || []).push(f);
  }

  for (const [bk, list] of Object.entries(fragByBoundary)) {
    const boundaryPts = allPoints.filter((p) => String(p.groupTrackId) === String(bk));
    if (!boundaryPts.length) continue;
    const sortedPts = [...boundaryPts].sort((a, b) => a.s - b.s);
    const firstPt = sortedPts[0], lastPt = sortedPts[sortedPts.length - 1];
    const fragSorted = [...list].sort((a, b) => a.points[0].s - b.points[0].s);
    const firstFrag = fragSorted[0], lastFrag = fragSorted[fragSorted.length - 1];
    const firstFragPt = firstFrag.points[0];
    const lastFragPt = lastFrag.points[lastFrag.points.length - 1];

    // full-route coverage
    const routeStartS = sortedPts[0].s;
    const routeEndS = sortedPts[sortedPts.length - 1].s;

    // excluded endpoint points and their rejection stage (reuse the trace)
    const before = sortedPts.filter((p) => p.s < firstFragPt.s - 1e-6);
    const after = sortedPts.filter((p) => p.s > lastFragPt.s + 1e-6);
    const stage1Before = before.filter((p) => (p.supportFrameCount ?? 1) < D.minSupportCount).length;
    const stage2Before = before.length - stage1Before; // dedup or run below minObservations approximation

    perBoundary[bk] = {
      fragments: list.length,
      routeStartS: +routeStartS.toFixed(2),
      routeEndS: +routeEndS.toFixed(2),
      firstFragmentS: +firstFragPt.s.toFixed(2),
      lastFragmentS: +lastFragPt.s.toFixed(2),
      startCoverageM: +(firstFragPt.s - routeStartS).toFixed(2),
      endCoverageM: +(routeEndS - lastFragPt.s).toFixed(2),
      excludedBeforeCount: before.length,
      excludedAfterCount: after.length,
      excludedBeforeLowSupport: stage1Before,
      excludedAfterLowSupport: after.filter((p) => (p.supportFrameCount ?? 1) < D.minSupportCount).length,
      // per-boundary start/end coverage as fraction of the boundary's own span
      boundarySpanM: +(routeEndS - routeStartS).toFixed(2),
      startCoverageFraction: +((firstFragPt.s - routeStartS) / Math.max(routeEndS - routeStartS, 1e-9)).toFixed(4),
      endCoverageFraction: +((routeEndS - lastFragPt.s) / Math.max(routeEndS - routeStartS, 1e-9)).toFixed(4),
    };
  }

  return { seg, routeChunks: route.routeChunks.length, frames: route.frames.length, perBoundary };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  for (const seg of SEGS) {
    try {
      results.push(run(seg));
      console.log(`seg ${seg} done`);
    } catch (e) {
      results.push({ seg, error: e.message });
      console.log(`seg ${seg} ERROR ${e.message}`);
    }
  }
  const outPath = path.join(OUT, 'route_extent_endpoint_coverage.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  console.log('\nFULL-ROUTE ENDPOINT COVERAGE');
  console.log('='.repeat(110));
  for (const r of results) {
    if (r.error) { console.log(`\nseg ${r.seg}: ERROR ${r.error}`); continue; }
    console.log(`\n=== seg ${r.seg} (${r.routeChunks} chunks, ${r.frames} frames) ===`);
    for (const [bk, b] of Object.entries(r.perBoundary)) {
      console.log(`  L${bk}: route ${b.routeStartS}..${b.routeEndS} m | frag ${b.firstFragmentS}..${b.lastFragmentS} m`);
      console.log(`    START gap ${b.startCoverageM} m (${(b.startCoverageFraction * 100).toFixed(1)}% of span), excluded ${b.excludedBeforeCount} (${b.excludedBeforeLowSupport} low-support)`);
      console.log(`    END   gap ${b.endCoverageM} m (${(b.endCoverageFraction * 100).toFixed(1)}% of span), excluded ${b.excludedAfterCount} (${b.excludedAfterLowSupport} low-support)`);
    }
  }
  console.log('\nWrote:', outPath);
}

main();
