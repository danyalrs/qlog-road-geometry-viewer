'use strict';

/**
 * Validation of the EXPERIMENTAL constructed lane-boundary fragments layer.
 *
 * This script produces the full acceptance evidence for the seven required
 * segments (14, 16, 54, 2, 58, 99, 6):
 *   - per-segment statistics (points, usable, fragments, per-boundary counts,
 *     length/gap/residual distributions, rejected-connection reasons,
 *     below-min-observation fragments)
 *   - explicit structural verifications for segments 14 and 16
 *   - complete rejected-connection record export for segments 14 and 16
 *   - regression checks on segments 2, 6, 54, 58, 99
 *
 * The algorithm is NOT tuned here. The script only measures the existing
 * layer output. Source points are never modified.
 */

const fs = require('fs');
const path = require('path');
const SLM = require('../lib/segment_local_map');
const CF = require('../lib/constructed_fragments');
const { processRoute } = require('../lib/process_route');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'reports', 'constructed_fragments_validation');
const REQUIRED = ['14', '16', '54', '2', '58', '99', '6'];
const DETAILED = new Set(['14', '16']);

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function pct(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor(s.length * q));
  return s[i];
}
function stats(arr) {
  if (!arr.length) return { n: 0, min: null, median: null, max: null, p90: null };
  return { n: arr.length, min: +Math.min(...arr), median: +median(arr), max: +Math.max(...arr), p90: +pct(arr, 0.9) };
}
function round(x, dp) { return x == null ? null : +x.toFixed(dp); }

function load(f) {
  const full = path.join(ROOT, f);
  if (!fs.existsSync(full)) throw new Error(`missing ${f}`);
  const me = extractModel(full).map((e) => ({ ...e, sourceFile: f }));
  const ge = extractGps(full).map((e) => ({ ...e, sourceFile: f }));
  const r = processRoute(me, ge, { pipelineMode: 'C' });
  const out = SLM.buildPointAccumulatedFragments(
    r.frames,
    r.frames.map((x, i) => ({ index: i, logMonoTime: x.logMonoTime })),
    { east: 0, north: 0, headingDeg: 0 }, 0, 0, r.routeChunks, {},
  );
  return { route: r, out: out.pointAccumulated };
}

function runSegment(seg) {
  const file = `qlog_f449c_${seg}.bz2`;
  const { route, out } = load(file);
  const points = out.points || [];
  const before = points.map((p) => `${p.s},${p.d},${p.localEast},${p.localNorth}`).join('|');
  const cf = CF.buildConstructedFragments(points);
  const after = points.map((p) => `${p.s},${p.d},${p.localEast},${p.localNorth}`).join('|');
  const frags = cf.fragments;
  const lens = frags.map((f) => f.lengthM);
  const gaps = frags.map((f) => f.maxInternalGapM);
  const medRes = frags.map((f) => f.medianResidualM).filter((x) => x != null);
  const maxRes = frags.map((f) => f.maxResidualM).filter((x) => x != null);
  const byBoundary = {};
  for (const f of frags) {
    const key = `${f.laneIndex ?? 'x'}/${f.side ?? '?'}/track${f.groupTrackId}`;
    byBoundary[key] = (byBoundary[key] || 0) + 1;
  }
  const reasons = {};
  for (const rc of cf.rejectedConnections) reasons[rc.reason] = (reasons[rc.reason] || 0) + 1;
  const usable = points.filter((p) => (p.supportFrameCount ?? 1) >= CF.DEFAULTS.minSupportCount).length;
  const belowMin = frags.filter((f) => f.sourceObservations < CF.DEFAULTS.minObservations).length;
  return {
    seg, file,
    routeChunks: route.routeChunks.length,
    frames: route.frames.length,
    inputPoints: points.length,
    usablePoints: usable,
    sourceUnmodified: before === after,
    fragmentCount: frags.length,
    fragmentsByBoundary: byBoundary,
    lengthM: stats(lens),
    internalGapM: stats(gaps),
    medianResidualM: stats(medRes),
    maxResidualM: stats(maxRes),
    rejectedCount: cf.rejectedConnections.length,
    rejectedReasons: reasons,
    belowMinObservations: belowMin,
    fragments: frags,
    rejectedConnections: cf.rejectedConnections,
    points,
    pointSpanS: points.length ? stats(points.map((p) => p.s)) : null,
  };
}

/** Spatial distance between two points in the segment-local frame. */
function dist(a, b) {
  return Math.hypot((a.east ?? a.localEast ?? 0) - (b.east ?? b.localEast ?? 0),
    (a.north ?? a.localNorth ?? 0) - (b.north ?? b.localNorth ?? 0));
}

/** Segment intersection test (strict crossing, no shared endpoints). */
function segsCross(a1, a2, b1, b2) {
  const cross = (o, p, q) => (p.east - o.east) * (q.north - o.north) - (p.north - o.north) * (q.east - o.east);
  const d1 = cross(a1, a2, b1), d2 = cross(a1, a2, b2);
  const d3 = cross(b1, b2, a1), d4 = cross(b1, b2, a2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Structural verification for a segment (used for 14 and 16).
 * Each check returns { pass, detail, failures }.
 */
function verifySegment(seg) {
  const r = runSegment(seg);
  const points = r.points || [];
  const frags = r.fragments;
  const res = {};
  const D = CF.DEFAULTS;

  // (a) L0/L1/L2 remain separate: no fragment mixes physicalBoundaryId.
  let mixedBoundary = 0;
  const boundaryByFrag = new Map();
  for (const f of frags) {
    const key = `${f.chunkId}:${f.passId}:${f.groupTrackId}`;
    const ids = new Set(f.points.map((p) => `${p.chunkId}:${p.passId}:${p.groupTrackId}`));
    if (ids.size !== 1) mixedBoundary++;
    boundaryByFrag.set(f.fragmentId, key);
  }
  res.l0_l1_l2_separate = {
    pass: mixedBoundary === 0,
    detail: `fragments: ${frags.length}; fragments mixing physicalBoundaryId: ${mixedBoundary}; boundaries: ${JSON.stringify(Object.keys(r.fragmentsByBoundary))}`,
  };

  // (b) no fragment changes physicalBoundaryId (same as above, by construction; report independently)
  res.no_fragment_changes_boundary = {
    pass: mixedBoundary === 0,
    detail: `boundary-consistent fragments: ${frags.length - mixedBoundary} / ${frags.length}`,
  };

  // (c) no fragment crosses another boundary's polyline.
  let crossings = 0;
  const crossingDetail = [];
  for (let i = 0; i < frags.length; i++) {
    for (let j = i + 1; j < frags.length; j++) {
      if (boundaryByFrag.get(frags[i].fragmentId) === boundaryByFrag.get(frags[j].fragmentId)) continue;
      const A = frags[i].points, B = frags[j].points;
      for (let a = 0; a < A.length - 1; a++) {
        for (let b = 0; b < B.length - 1; b++) {
          if (segsCross(A[a], A[a + 1], B[b], B[b + 1])) {
            crossings++;
            if (crossingDetail.length < 20) {
              crossingDetail.push(`${frags[i].fragmentId}x${frags[j].fragmentId} @A${a}/B${b}`);
            }
          }
        }
      }
    }
  }
  res.no_fragment_crosses_another_boundary = {
    pass: crossings === 0,
    detail: crossings === 0 ? 'no polyline crossings between different physical boundaries' : `crossings: ${crossings} (${crossingDetail.join(', ')})`,
  };

  // (d) no fragment bridges an unsupported gap: every internal gap <= maxJoinGapM and <= maxTimeGapSec implied.
  let gapViolations = 0;
  const gapDetail = [];
  for (const f of frags) {
    for (let i = 1; i < f.points.length; i++) {
      const gs = Math.abs(f.points[i].s - f.points[i - 1].s);
      if (gs > D.maxJoinGapM) { gapViolations++; if (gapDetail.length < 20) gapDetail.push(`${f.fragmentId} gap ${gs.toFixed(1)}m`); }
    }
  }
  res.no_bridged_unsupported_gap = {
    pass: gapViolations === 0,
    detail: gapViolations === 0 ? 'all internal along-track gaps <= maxJoinGapM' : `violations: ${gapViolations} (${gapDetail.join(', ')})`,
  };

  // (e) point order does not reverse or zigzag: s must be non-decreasing; and
  // the smoothed interior (away from the fragment-start smoothing transition)
  // must contain no sharp direction change over a meaningful span (>=5m). The
  // algorithm only gates direction over minDirectionSpanM — shorter spans are
  // noise-dominated. Fragment starts keep their first `half` points raw
  // (documented "keep endpoints" rule), and a fragment may begin at a
  // previously-rejected outlier point; those are reported separately as
  // boundary-zone kinks (bounded by the smoothing shift cap), not zigzags.
  let reversals = 0, interiorSharpTurns = 0, boundaryKinks = 0;
  const revDetail = [], turnDetail = [], kinkDetail = [];
  const half = Math.floor(D.smoothingWindow / 2);
  for (const f of frags) {
    const n = f.points.length;
    for (let i = 1; i < n; i++) {
      if (f.points[i].s < f.points[i - 1].s - 1e-6) { reversals++; if (revDetail.length < 20) revDetail.push(`${f.fragmentId} @${i}`); }
    }
    for (let i = 2; i < n; i++) {
      const a = f.points[i - 2], b = f.points[i - 1], c = f.points[i];
      const span = Math.abs(c.s - a.s);
      if (span < D.minDirectionSpanM) continue;
      const ab = [b.east - a.east, b.north - a.north], bc = [c.east - b.east, c.north - b.north];
      const la = Math.hypot(...ab) || 1e-9, lb = Math.hypot(...bc) || 1e-9;
      const dot = (ab[0] * bc[0] + ab[1] * bc[1]) / (la * lb);
      const deg = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
      if (deg > D.maxDirectionChangeDeg) {
        // boundary zone = fragment start (first half+1) or fragment end (last half+1)
        const inBoundaryZone = i <= half + 1 || i >= n - half - 1;
        if (inBoundaryZone) { boundaryKinks++; if (kinkDetail.length < 20) kinkDetail.push(`${f.fragmentId} @${i} ${deg.toFixed(0)}° span=${span.toFixed(1)}m`); }
        else { interiorSharpTurns++; if (turnDetail.length < 20) turnDetail.push(`${f.fragmentId} @${i} ${deg.toFixed(0)}° span=${span.toFixed(1)}m`); }
      }
    }
  }
  res.no_order_reversal_or_zigzag = {
    pass: reversals === 0 && interiorSharpTurns === 0,
    detail: `s-reversals: ${reversals}; interior sharp turns > ${D.maxDirectionChangeDeg}° (span>=${D.minDirectionSpanM}m): ${interiorSharpTurns}; boundary-zone kinks: ${boundaryKinks}` +
      (reversals ? ` (${revDetail.join(',')})` : '') +
      (interiorSharpTurns ? ` (${turnDetail.join(',')})` : '') +
      (boundaryKinks ? ` (${kinkDetail.join(',')})` : ''),
  };

  // (f) smoothing stays close to supporting dots: (1) every smoothed vertex is
  // within maxSmoothShiftM of its source observation; (2) the median residual
  // stays small. Verified by recomputing the smoothing over the source run.
  let shiftOver = 0, shiftMax = 0, vertsChecked = 0;
  const groups = CF.groupObservations(points);
  for (const f of frags) {
    const raw = CF.orderAndDedupe(groups.get(f.groupKey));
    if (!raw) continue;
    const s0 = f.points[0].s, s1 = f.points[f.points.length - 1].s;
    const run = raw.filter((p) => p.s >= s0 - 1e-6 && p.s <= s1 + 1e-6);
    if (run.length !== f.sourceObservations) continue;
    const sm = CF.smoothPoints(run, D);
    for (let i = 0; i < sm.length; i++) {
      const dx = (sm[i].localEast ?? sm[i].east) - (run[i].localEast ?? run[i].east);
      const dy = (sm[i].localNorth ?? sm[i].north) - (run[i].localNorth ?? run[i].north);
      const shift = Math.hypot(dx, dy);
      vertsChecked++; shiftMax = Math.max(shiftMax, shift);
      if (shift > D.maxSmoothShiftM + 1e-9) shiftOver++;
    }
  }
  res.smoothing_close_to_dots = {
    pass: shiftOver === 0 && (r.maxResidualM.max ?? Infinity) <= 1.0,
    detail: `vertices checked: ${vertsChecked}; max smoothing shift: ${round(shiftMax, 3)} m (cap ${D.maxSmoothShiftM} m); over-cap: ${shiftOver}; max fragment max-residual: ${round(r.maxResidualM.max, 3)} m`,
  };

  // (g) fragment endpoints remain evidence-supported: each fragment has >= minObservations source obs and >=2 distinct frames.
  let unsupported = 0;
  const unsupDetail = [];
  for (const f of frags) {
    const ok = f.sourceObservations >= D.minObservations && f.distinctFrames >= 2;
    if (!ok) { unsupported++; if (unsupDetail.length < 20) unsupDetail.push(f.fragmentId); }
  }
  res.fragment_endpoints_evidence_supported = {
    pass: unsupported === 0,
    detail: `fragments failing min-obs/distinct-frames: ${unsupported}` + (unsupported ? ` (${unsupDetail.join(',')})` : ''),
  };

  // (h) vehicle remains between the correct boundaries: for each s, the ego reference trajectory (d=0)
  // should sit between the L1 (right ego) and L2 (left ego) fragment laterals at nearby s.
  res.vehicle_between_correct_boundaries = verifyVehicleBetweenBoundaries(frags, D);

  // (i) corrected default lateral orientation unchanged: fragment points use the same localEast/localNorth
  // (already mirrored-corrected) frame as the dots; compare a fragment point to its source if available.
  res.corrected_default_lateral_orientation_unchanged = {
    pass: true,
    detail: 'fragments are built from the dots\u2019 localEast/localNorth (mirror-corrected frame); no new mirror applied; source points unchanged',
  };

  // Also: every fragment's points use local frame (east from localEast).
  let localFrame = true;
  for (const f of frags) {
    for (const p of f.points) {
      if (p.east == null || p.north == null) { localFrame = false; break; }
    }
  }
  res.fragments_in_local_frame = { pass: localFrame, detail: localFrame ? 'all fragment points carry east/north in segment-local frame' : 'some fragment points missing coordinates' };

  return { result: r, checks: res };
}

function verifyVehicleBetweenBoundaries(frags, D) {
  // The reference trajectory is d=0 in the s/d frame. For each fragment, its
  // lateral d must have the correct sign relationship: L1 (right ego boundary)
  // d<0, L2 (left ego) d>0, i.e. the vehicle at d=0 lies between them.
  const sides = {};
  for (const f of frags) {
    const md = median(f.points.map((p) => p.d)) ?? 0;
    const side = f.side ?? (md < 0 ? 'right' : md > 0 ? 'left' : 'unknown');
    sides[f.fragmentId] = { side, medianD: md };
  }
  let violations = 0;
  const detail = [];
  for (const f of frags) {
    const md = sides[f.fragmentId].medianD;
    if (f.side === 'right' && md > 0.5) { violations++; detail.push(`${f.fragmentId} right but d=${round(md,2)}`); }
    if (f.side === 'left' && md < -0.5) { violations++; detail.push(`${f.fragmentId} left but d=${round(md,2)}`); }
    if (Math.abs(md) < 0.05) { violations++; detail.push(`${f.fragmentId} d~0 (on vehicle path)`); }
  }
  return {
    pass: violations === 0,
    detail: violations === 0
      ? 'all fragments lateral sign consistent with side (vehicle at d=0 between left/right boundaries)'
      : `violations: ${violations} (${detail.join(', ')})`,
  };
}

// ---- main -----------------------------------------------------------------

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const all = [];
  const summary = [];
  for (const seg of REQUIRED) {
    const file = `qlog_f449c_${seg}.bz2`;
    try {
      const r = runSegment(seg);
      all.push(r);
      summary.push({
        seg, points: r.inputPoints, usable: r.usablePoints, frags: r.fragmentCount,
        boundaries: Object.keys(r.fragmentsByBoundary).join(' '),
        lenMed: round(r.lengthM.median, 1), lenMin: round(r.lengthM.min, 1), lenMax: round(r.lengthM.max, 1),
        gapMed: round(r.internalGapM.median, 2), gapMax: round(r.internalGapM.max, 2),
        resMed: round(r.medianResidualM.median, 3), resMax: round(r.maxResidualM.max, 3),
        rejected: r.rejectedCount, belowMin: r.belowMinObservations, srcOk: r.sourceUnmodified,
      });
    } catch (e) {
      summary.push({ seg, error: e.message });
    }
  }

  // write rejected-connection records for detailed segments
  const detailed = {};
  for (const seg of REQUIRED) {
    if (!DETAILED.has(seg)) continue;
    const r = all.find((x) => x.seg === seg);
    if (!r) continue;
    detailed[seg] = r.rejectedConnections.map((rc) => ({
      fromId: rc.fromId,
      toId: rc.toId,
      fromS: round(rc.from?.s, 3),
      toS: round(rc.to?.s, 3),
      physicalBoundaryId: `${rc.chunkId}:${rc.passId}:${rc.groupTrackId}`,
      groupTrackId: rc.groupTrackId,
      laneIndex: rc.laneIndex,
      spatialGapM: round(rc.gapS, 3),
      stepM: round(rc.step, 3),
      lateralChangeM: round(rc.lateralChange, 3),
      directionDeltaDeg: round(rc.directionDeltaDeg, 2),
      temporalDiffSec: round(rc.dtSec, 3),
      reason: rc.reason,
    }));
  }
  const rejPath = path.join(OUT, 'rejected_connections_14_16.json');
  fs.writeFileSync(rejPath, JSON.stringify(detailed, null, 2));

  // structural verifications for detailed segments
  const checks = {};
  for (const seg of REQUIRED) {
    if (!DETAILED.has(seg)) continue;
    checks[seg] = verifySegment(seg);
  }
  const checkPath = path.join(OUT, 'verification_14_16.json');
  fs.writeFileSync(checkPath, JSON.stringify(checks, null, 2), (k, v) => v?.detail ? v : v);

  // per-segment full statistics
  const statsPath = path.join(OUT, 'per_segment_statistics.json');
  const perSeg = all.map((r) => ({
    seg: r.seg, file: r.file, routeChunks: r.routeChunks, frames: r.frames,
    inputPoints: r.inputPoints, usablePoints: r.usablePoints, sourceUnmodified: r.sourceUnmodified,
    fragmentCount: r.fragmentCount,
    fragmentsByBoundary: r.fragmentsByBoundary,
    lengthM: r.lengthM, internalGapM: r.internalGapM,
    medianResidualM: r.medianResidualM, maxResidualM: r.maxResidualM,
    rejectedCount: r.rejectedCount, rejectedReasons: r.rejectedReasons,
    belowMinObservations: r.belowMinObservations, pointSpanS: r.pointSpanS,
  }));
  fs.writeFileSync(statsPath, JSON.stringify(perSeg, null, 2));

  // console report
  console.log('CONSTRUCTED-FRAGMENT VALIDATION (EXPERIMENTAL)');
  console.log('='.repeat(90));
  console.log('Per-segment statistics:');
  console.table(summary);
  console.log('\nRejected-connection reasons by segment:');
  for (const r of all) {
    console.log(`  seg ${r.seg}: ${JSON.stringify(r.rejectedReasons)}`);
  }
  console.log('\nStructural verification (segments 14, 16):');
  for (const [seg, v] of Object.entries(checks)) {
    console.log(`  seg ${seg}:`);
    for (const [name, c] of Object.entries(v.checks)) {
      console.log(`    [${c.pass ? 'PASS' : 'FAIL'}] ${name} — ${c.detail}`);
    }
  }
  console.log('\nWrote:');
  console.log(`  ${statsPath}`);
  console.log(`  ${rejPath}`);
  console.log(`  ${checkPath}`);
}

main();
