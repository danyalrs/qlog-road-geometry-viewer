'use strict';

/**
 * Section A audit — constructed-fragment output inspection for the joining
 * stage. Does NOT modify the constructed-fragment algorithm. Measures:
 *   - fragment metadata availability
 *   - endpoint/tangent representation
 *   - candidate endpoint-gap distributions (Segments 14, 16)
 *   - which fragment pairs could potentially connect
 *   - which split reasons must prohibit joining
 *
 * Usage: node scripts/audit_joining_input.js [segments...]
 */

const path = require('path');
const SLM = require('../lib/segment_local_map');
const { processRoute } = require('../lib/process_route');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEGS = process.argv.slice(2).length ? process.argv.slice(2) : ['14', '16'];

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function pct(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}
function dist(a, b) { return Math.hypot(a.east - b.east, a.north - b.north); }

function load(seg) {
  const file = `qlog_f449c_${seg}.bz2`;
  const full = path.join(ROOT, file);
  const me = extractModel(full).map((e) => ({ ...e, sourceFile: file }));
  const ge = extractGps(full).map((e) => ({ ...e, sourceFile: file }));
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
  const rejected = pa.constructedFragments.rejectedConnections;

  // group fragments by physical boundary
  const byBoundary = {};
  for (const f of frags) {
    const key = `${f.chunkId}:${f.passId}:${f.groupTrackId}`;
    (byBoundary[key] = byBoundary[key] || []).push(f);
  }

  // endpoint metadata availability
  const sample = frags[0];
  const metaKeys = [
    'fragmentId', 'groupTrackId', 'laneIndex', 'chunkId', 'passId', 'side',
    'points', 'sourceObservations', 'distinctFrames',
    'startLogMonoTime', 'endLogMonoTime', 'startFrameIndex', 'endFrameIndex',
    'lengthM', 'maxInternalGapM', 'medianResidualM', 'maxResidualM', 'medianProb',
    'splitReason', 'groupKey',
  ];
  const metaPresent = {};
  for (const k of metaKeys) metaPresent[k] = k in sample;
  const ptKeys = Object.keys(sample.points[0]).join(',');
  const hasStartTime = frags.every((f) => f.startLogMonoTime != null);
  const hasEndTime = frags.every((f) => f.endLogMonoTime != null);
  const hasStartFrame = frags.every((f) => f.startFrameIndex != null);
  const hasEndFrame = frags.every((f) => f.endFrameIndex != null);

  // endpoint-gap distribution between consecutive fragments in the SAME
  // boundary ordered by start s. Compute euclidean gap between end of A and
  // start of B (forward direction: B starts at higher s).
  const endpointGaps = [];
  const orderedPairs = [];
  for (const [key, list] of Object.entries(byBoundary)) {
    const sorted = [...list].sort((a, b) => a.points[0].s - b.points[0].s);
    for (let i = 0; i < sorted.length - 1; i++) {
      const A = sorted[i], B = sorted[i + 1];
      const Aend = A.points[A.points.length - 1];
      const Bstart = B.points[0];
      const gap = dist(Aend, Bstart);
      const sGap = Bstart.s - Aend.s;
      endpointGaps.push({ key, from: A.fragmentId, to: B.fragmentId, gap, sGap });
      // only count as a "forward" candidate if B is after A in s (non-overlapping)
      if (sGap > 0) orderedPairs.push({ key, from: A.fragmentId, to: B.fragmentId, gap, sGap });
    }
  }
  const gapsArr = endpointGaps.map((g) => g.gap);
  const sGapsArr = endpointGaps.map((g) => g.sGap);

  // split reasons present
  const splitReasons = {};
  for (const f of frags) splitReasons[f.splitReason] = (splitReasons[f.splitReason] || 0) + 1;

  // rejected-connection reasons (these split the fragments; some must prohibit joining)
  const rejectReasons = {};
  for (const rc of rejected) rejectReasons[rc.reason] = (rejectReasons[rc.reason] || 0) + 1;

  // candidate search: for each fragment, count nearby fragments (same boundary,
  // within a 40m endpoint search radius, forward in s)
  const candidatesPerFragment = [];
  let candidatePairs = 0;
  for (const [key, list] of Object.entries(byBoundary)) {
    const sorted = [...list].sort((a, b) => a.points[0].s - b.points[0].s);
    for (const A of sorted) {
      const Aend = A.points[A.points.length - 1];
      let nNear = 0;
      for (const B of sorted) {
        if (A.fragmentId === B.fragmentId) continue;
        const Bstart = B.points[0];
        if (Bstart.s <= Aend.s) continue; // must continue forward in s
        const gap = dist(Aend, Bstart);
        if (gap <= 40) { nNear++; candidatePairs++; }
      }
      candidatesPerFragment.push(nNear);
    }
  }

  return {
    seg,
    fragmentCount: frags.length,
    boundaries: Object.keys(byBoundary),
    boundaryFragmentCounts: Object.fromEntries(Object.entries(byBoundary).map(([k, v]) => [k, v.length])),
    metadata: {
      allPresent: metaKeys.every((k) => metaPresent[k]),
      missing: metaKeys.filter((k) => !metaPresent[k]),
      pointKeys: ptKeys,
      startLogMonoTimePresent: hasStartTime,
      endLogMonoTimePresent: hasEndTime,
      startFrameIndexPresent: hasStartFrame,
      endFrameIndexPresent: hasEndFrame,
    },
    endpointGapDist: {
      n: gapsArr.length,
      min: gapsArr.length ? Math.min(...gapsArr).toFixed(2) : null,
      p25: gapsArr.length ? pct(gapsArr, 0.25).toFixed(2) : null,
      median: gapsArr.length ? median(gapsArr).toFixed(2) : null,
      p75: gapsArr.length ? pct(gapsArr, 0.75).toFixed(2) : null,
      p90: gapsArr.length ? pct(gapsArr, 0.9).toFixed(2) : null,
      max: gapsArr.length ? Math.max(...gapsArr).toFixed(2) : null,
    },
    sGapDist: {
      n: sGapsArr.length,
      min: sGapsArr.length ? Math.min(...sGapsArr).toFixed(2) : null,
      median: sGapsArr.length ? median(sGapsArr).toFixed(2) : null,
      max: sGapsArr.length ? Math.max(...sGapsArr).toFixed(2) : null,
    },
    forwardCandidatePairs: orderedPairs.length,
    forwardPairGapDist: {
      n: orderedPairs.length,
      min: orderedPairs.length ? Math.min(...orderedPairs.map((p) => p.gap)).toFixed(2) : null,
      median: orderedPairs.length ? median(orderedPairs.map((p) => p.gap)).toFixed(2) : null,
      max: orderedPairs.length ? Math.max(...orderedPairs.map((p) => p.gap)).toFixed(2) : null,
    },
    nearbyCandidates: {
      perFragment: candidatesPerFragment,
      maxPerFragment: candidatesPerFragment.length ? Math.max(...candidatesPerFragment) : 0,
      totalPairsWithin40m: candidatePairs,
    },
    splitReasons,
    rejectedReasons: rejectReasons,
  };
}

function main() {
  const out = {};
  for (const seg of SEGS) {
    try {
      out[seg] = run(seg);
      console.log(`seg ${seg} done`);
    } catch (e) {
      out[seg] = { error: e.message };
      console.log(`seg ${seg} ERROR ${e.message}`);
    }
  }
  const fs = require('fs');
  fs.mkdirSync(path.join(ROOT, 'reports', 'constructed_fragments_validation'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'reports', 'constructed_fragments_validation', 'joining_input_audit.json'), JSON.stringify(out, null, 2));

  console.log('\nJOINING INPUT AUDIT');
  console.log('='.repeat(80));
  for (const seg of SEGS) {
    const r = out[seg];
    if (r.error) { console.log(`seg ${seg}: ERROR ${r.error}`); continue; }
    console.log(`\nseg ${seg}:`);
    console.log(`  fragments: ${r.fragmentCount} | boundaries: ${JSON.stringify(r.boundaryFragmentCounts)}`);
    console.log(`  metadata complete: ${r.metadata.allPresent} ${r.metadata.missing.length ? '(missing: ' + r.metadata.missing.join(',') + ')' : ''} | point keys: ${r.metadata.pointKeys}`);
    console.log(`  start/end logMonoTime: ${r.metadata.startLogMonoTimePresent}/${r.metadata.endLogMonoTimePresent} | start/end frameIndex: ${r.metadata.startFrameIndexPresent}/${r.metadata.endFrameIndexPresent}`);
    console.log(`  endpoint gap (m): n=${r.endpointGapDist.n} min=${r.endpointGapDist.min} p25=${r.endpointGapDist.p25} med=${r.endpointGapDist.median} p75=${r.endpointGapDist.p75} p90=${r.endpointGapDist.p90} max=${r.endpointGapDist.max}`);
    console.log(`  s-gap (m): min=${r.sGapDist.min} med=${r.sGapDist.median} max=${r.sGapDist.max}`);
    console.log(`  forward candidate pairs: ${r.forwardCandidatePairs} | gap med=${r.forwardPairGapDist.median} max=${r.forwardPairGapDist.max}`);
    console.log(`  nearby candidates (<=40m): maxPerFragment=${r.nearbyCandidates.maxPerFragment} totalPairs=${r.nearbyCandidates.totalPairsWithin40m}`);
    console.log(`  split reasons: ${JSON.stringify(r.splitReasons)}`);
    console.log(`  reject reasons: ${JSON.stringify(r.rejectedReasons)}`);
  }
}

main();
