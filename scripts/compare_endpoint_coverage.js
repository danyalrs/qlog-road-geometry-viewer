'use strict';

/**
 * Section D — endpoint coverage before/after the endpoint-extension fix, for
 * the validation segments (14, 16) and regression segments (2, 6, 54, 58, 99).
 * Reports start/end coverage per boundary, points recovered, points still
 * rejected, and per-boundary reason the remaining endpoint points stay excluded.
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
const SEGS = ['14', '16', '2', '6', '54', '58', '99'];
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
  return { pa: out.pointAccumulated };
}

function run(seg, { withExtension }) {
  const { pa } = load(seg);
  const opts = { ...D, endpointExtensionEnabled: withExtension };
  const cf = CF.buildConstructedFragments(pa.points, opts);
  const frags = cf.fragments;
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
    const firstFrag = [...list].sort((a, b) => a.points[0].s - b.points[0].s)[0];
    const lastFrag = [...list].sort((a, b) => a.points[a.points.length - 1].s - b.points[b.points.length - 1].s).pop();
    const firstFragPt = firstFrag.points[0];
    const lastFragPt = lastFrag.points[lastFrag.points.length - 1];

    // points still outside fragments (never captured by the pipeline, including
    // extension) with their rejection reason
    const inAnyFrag = new Set();
    for (const f of frags) for (const p of f.points) inAnyFrag.add(p.s.toFixed(2) + '|' + p.d.toFixed(2));
    const before = sortedPts.filter((p) => p.s < firstFragPt.s - 1e-6);
    const after = sortedPts.filter((p) => p.s > lastFragPt.s + 1e-6);
    const explainRemaining = (p) => {
      if ((p.supportFrameCount ?? 1) < D.minSupportCount) return 'low-support (supportFrameCount < 2)';
      return 'outside extension window / lateral/gap gate';
    };

    perBoundary[bk] = {
      fragments: list.length,
      routeStartS: +firstPt.s.toFixed(2),
      routeEndS: +lastPt.s.toFixed(2),
      firstFragmentS: +firstFragPt.s.toFixed(2),
      lastFragmentS: +lastFragPt.s.toFixed(2),
      startCoverageM: +(firstFragPt.s - firstPt.s).toFixed(2),
      endCoverageM: +(lastPt.s - lastFragPt.s).toFixed(2),
      excludedBefore: before.length,
      excludedAfter: after.length,
      remainingBeforeReasons: before.slice(0, 5).map((p) => ({
        s: +p.s.toFixed(2), d: +p.d.toFixed(2), support: p.supportFrameCount ?? 1, reason: explainRemaining(p),
      })),
      remainingAfterReasons: after.slice(0, 5).map((p) => ({
        s: +p.s.toFixed(2), d: +p.d.toFixed(2), support: p.supportFrameCount ?? 1, reason: explainRemaining(p),
      })),
    };
  }

  return { frags: frags.length, acceptedCount: frags.length, perBoundary };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const results = {};
  for (const seg of SEGS) {
    try {
      const before = run(seg, { withExtension: false });
      const after = run(seg, { withExtension: true });
      results[seg] = { before, after };
      console.log(`seg ${seg} done`);
    } catch (e) {
      results[seg] = { error: e.message };
      console.log(`seg ${seg} ERROR ${e.message}`);
    }
  }
  const outPath = path.join(OUT, 'endpoint_coverage_before_after.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  console.log('\nENDPOINT COVERAGE BEFORE vs AFTER');
  console.log('='.repeat(110));
  for (const seg of SEGS) {
    const r = results[seg];
    if (r.error) continue;
    console.log(`\n=== seg ${seg} ===`);
    const b = r.before, a = r.after;
    for (const bk of Object.keys(a.perBoundary)) {
      const bB = b.perBoundary[bk], aB = a.perBoundary[bk];
      console.log(`  L${bk}: START gap ${bB.startCoverageM}m -> ${aB.startCoverageM}m (excl ${bB.excludedBefore}->${aB.excludedBefore}) | END gap ${bB.endCoverageM}m -> ${aB.endCoverageM}m (excl ${bB.excludedAfter}->${aB.excludedAfter})`);
    }
  }
  console.log('\nWrote:', outPath);
}

main();
