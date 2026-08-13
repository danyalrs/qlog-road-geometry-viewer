'use strict';

/**
 * Section A diagnosis — constructed-fragment / joined-polyline endpoint
 * coverage. For each physical boundary (L0/L1/L2) on Segments 14 and 16:
 *   - first/last accumulated-point s + timestamp
 *   - first/last constructed-fragment point s + timestamp
 *   - start/end coverage gaps in metres and seconds
 *   - every accumulated point excluded before the first / after the last
 *     fragment, with ID, boundary, s, timestamp/frame, support count,
 *     confidence, rejection stage and exact reason.
 *
 * The constructed-fragment algorithm is NOT modified here; this only measures.
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
const SEGS = ['14', '16'];
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

/**
 * Reconstruct the per-stage point pipeline for one boundary so we can attribute
 * each excluded endpoint point to an exact rejection stage.
 */
function traceBoundary(points, boundaryId) {
  const o = D;
  // Stage 1: groupObservations gate (minSupportCount)
  const stage1 = [];
  const stage1Rejected = [];
  for (const p of points) {
    if (!Number.isFinite(p.s) || !Number.isFinite(p.d)) continue;
    if (o.minSupportCount > 1 && (p.supportFrameCount ?? 1) < o.minSupportCount) {
      stage1Rejected.push(p);
      continue;
    }
    stage1.push(p);
  }
  // Stage 2: orderAndDedupe
  const stage2 = [];
  const stage2Rejected = [];
  const sorted = [...stage1].sort((a, b) => (a.s ?? 0) - (b.s ?? 0) || (a.d ?? 0) - (b.d ?? 0));
  for (const p of sorted) {
    const last = stage2[stage2.length - 1];
    if (last && Math.abs(p.s - last.s) < o.dedupRadiusM && Math.abs(p.d - last.d) < o.dedupRadiusM) {
      stage2Rejected.push(p);
      continue;
    }
    stage2.push(p);
  }
  // Stage 3: fragment construction (minObservations per fragment via flush)
  const fragments = [];
  let current = [];
  const flush = (reason) => {
    if (current.length >= o.minObservations) fragments.push({ points: current.slice(), reason });
    current = [];
  };
  for (const p of stage2) {
    if (!current.length) { current.push(p); continue; }
    const head = current[current.length - 1];
    const prev = current.length >= 2 ? current[current.length - 2] : null;
    const decision = CF.evaluateConnect(prev, head, p, { opts: o });
    if (decision.safeToJoin) current.push(p);
    else { flush(decision.reason); current.push(p); }
  }
  flush('endOfGroup');

  // Which points ended up inside fragments?
  const inFragment = new Set();
  for (const f of fragments) for (const p of f.points) inFragment.add(pointKey(p));

  // stage3Rejected = stage2 points not inside any fragment AND not part of a
  // sub-minObservations run.
  const stage3Rejected = stage2.filter((p) => !inFragment.has(pointKey(p)));

  return { stage1, stage1Rejected, stage2, stage2Rejected, fragments, stage3Rejected };
}

function pointKey(p) {
  return `${p.s.toFixed(6)}:${p.d.toFixed(6)}:${p.frameId ?? p.frameIndex}:${p.chunkId}:${p.passId}`;
}

function tsSec(p) {
  return p.logMonoTime != null ? Number(BigInt(String(p.logMonoTime))) / 1e9 : null;
}

function run(seg) {
  const { route, pa } = load(seg);
  const frags = pa.constructedFragments.fragments;
  const allPoints = pa.points;
  const perBoundary = {};

  // group fragments by physical boundary (use laneIndex as the boundary label L0/L1/L2)
  const fragByBoundary = {};
  for (const f of frags) {
    const key = `${f.groupTrackId}`;
    (fragByBoundary[key] = fragByBoundary[key] || []).push(f);
  }

  // iterate over the boundary keys present in the fragment output
  for (const [bk, list] of Object.entries(fragByBoundary)) {
    const boundaryPts = allPoints.filter((p) => String(p.groupTrackId) === String(bk));
    if (!boundaryPts.length) continue;
    const sortedPts = [...boundaryPts].sort((a, b) => a.s - b.s);
    const firstPt = sortedPts[0];
    const lastPt = sortedPts[sortedPts.length - 1];

    const fragSorted = [...list].sort((a, b) => a.points[0].s - b.points[0].s);
    const firstFrag = fragSorted[0];
    const lastFrag = fragSorted[fragSorted.length - 1];
    const firstFragPt = firstFrag.points[0];
    const lastFragPt = lastFrag.points[lastFrag.points.length - 1];

    const startGapM = firstFragPt.s - firstPt.s;
    const endGapM = lastPt.s - lastFragPt.s;
    const startGapSec = tsSec(firstFragPt) != null && tsSec(firstPt) != null ? tsSec(firstFragPt) - tsSec(firstPt) : null;
    const endGapSec = tsSec(lastPt) != null && tsSec(lastFragPt) != null ? tsSec(lastPt) - tsSec(lastFragPt) : null;

    // excluded points before first fragment and after last fragment
    const before = sortedPts.filter((p) => p.s < firstFragPt.s - 1e-6);
    const after = sortedPts.filter((p) => p.s > lastFragPt.s + 1e-6);

    // attribute each excluded point to a stage
    const trace = traceBoundary(boundaryPts, bk);
    const stage1Keys = new Set(trace.stage1Rejected.map(pointKey));
    const stage2Keys = new Set(trace.stage2Rejected.map(pointKey));
    const stage3Keys = new Set(trace.stage3Rejected.map(pointKey));

    const explain = (p) => {
      if (stage1Keys.has(pointKey(p))) return { stage: 'groupObservations', reason: `minSupportCount: supportFrameCount=${p.supportFrameCount ?? 1} < ${D.minSupportCount}` };
      if (stage2Keys.has(pointKey(p))) return { stage: 'orderAndDedupe', reason: `dedup within ${D.dedupRadiusM}m of a kept neighbour` };
      if (stage3Keys.has(pointKey(p))) return { stage: 'fragment-construction', reason: 'run below minObservations or split boundary' };
      return { stage: 'unknown', reason: 'point not attributed to any gate' };
    };

    const beforeDetail = before.map((p) => ({
      pointId: pointKey(p),
      boundaryId: `${p.chunkId}:${p.passId}:${p.groupTrackId}`,
      s: +p.s.toFixed(3),
      frameId: p.frameId ?? null,
      frameIndex: p.frameIndex ?? null,
      logMonoTime: p.logMonoTime != null ? String(p.logMonoTime) : null,
      supportCount: p.supportFrameCount ?? 1,
      prob: +(p.prob ?? 1).toFixed(3),
      side: p.side ?? null,
      laneIndex: p.laneIndex ?? null,
      ...explain(p),
    }));
    const afterDetail = after.map((p) => ({
      pointId: pointKey(p),
      boundaryId: `${p.chunkId}:${p.passId}:${p.groupTrackId}`,
      s: +p.s.toFixed(3),
      frameId: p.frameId ?? null,
      frameIndex: p.frameIndex ?? null,
      logMonoTime: p.logMonoTime != null ? String(p.logMonoTime) : null,
      supportCount: p.supportFrameCount ?? 1,
      prob: +(p.prob ?? 1).toFixed(3),
      side: p.side ?? null,
      laneIndex: p.laneIndex ?? null,
      ...explain(p),
    }));

    perBoundary[bk] = {
      fragments: list.length,
      firstPoint: { s: +firstPt.s.toFixed(3), ts: tsSec(firstPt) != null ? +tsSec(firstPt).toFixed(3) : null },
      firstFragmentPoint: { s: +firstFragPt.s.toFixed(3), ts: tsSec(firstFragPt) != null ? +tsSec(firstFragPt).toFixed(3) : null },
      startGapM: +startGapM.toFixed(3),
      startGapSec: startGapSec != null ? +startGapSec.toFixed(3) : null,
      lastPoint: { s: +lastPt.s.toFixed(3), ts: tsSec(lastPt) != null ? +tsSec(lastPt).toFixed(3) : null },
      lastFragmentPoint: { s: +lastFragPt.s.toFixed(3), ts: tsSec(lastFragPt) != null ? +tsSec(lastFragPt).toFixed(3) : null },
      endGapM: +endGapM.toFixed(3),
      endGapSec: endGapSec != null ? +endGapSec.toFixed(3) : null,
      excludedBeforeCount: before.length,
      excludedAfterCount: after.length,
      excludedBefore: beforeDetail,
      excludedAfter: afterDetail,
    };
  }

  return { seg, perBoundary };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const results = {};
  for (const seg of SEGS) {
    try {
      results[seg] = run(seg);
      console.log(`seg ${seg} done`);
    } catch (e) {
      results[seg] = { error: e.message };
      console.log(`seg ${seg} ERROR ${e.message}`);
    }
  }
  const outPath = path.join(OUT, 'endpoint_coverage_diagnosis.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log('\nENDPOINT COVERAGE DIAGNOSIS');
  console.log('='.repeat(100));
  for (const seg of SEGS) {
    const r = results[seg];
    if (r.error) continue;
    console.log(`\n=== seg ${seg} ===`);
    for (const [bk, b] of Object.entries(r.perBoundary)) {
      console.log(`\n  boundary ${bk} (${b.fragments} fragments)`);
      console.log(`    first pt: s=${b.firstPoint.s} ts=${b.firstPoint.ts} | first frag pt: s=${b.firstFragmentPoint.s} ts=${b.firstFragmentPoint.ts} | START gap ${b.startGapM}m ${b.startGapSec ?? '?'}s`);
      console.log(`    last  pt: s=${b.lastPoint.s} ts=${b.lastPoint.ts} | last  frag pt: s=${b.lastFragmentPoint.s} ts=${b.lastFragmentPoint.ts} | END   gap ${b.endGapM}m ${b.endGapSec ?? '?'}s`);
      console.log(`    excluded before first frag: ${b.excludedBeforeCount} | after last frag: ${b.excludedAfterCount}`);
      for (const x of b.excludedBefore.slice(0, 10)) {
        console.log(`      BEFORE ${x.pointId} s=${x.s} frame=${x.frameId} support=${x.supportCount} prob=${x.prob} -> stage=${x.stage} reason=${x.reason}`);
      }
      for (const x of b.excludedAfter.slice(0, 10)) {
        console.log(`      AFTER  ${x.pointId} s=${x.s} frame=${x.frameId} support=${x.supportCount} prob=${x.prob} -> stage=${x.stage} reason=${x.reason}`);
      }
    }
  }
  console.log('\nWrote:', outPath);
}

main();
