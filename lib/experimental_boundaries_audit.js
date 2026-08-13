'use strict';

/**
 * Corrected audit helpers for the experimental lane-boundary construction.
 * Investigation/experiment only — pure, read-only functions. Never modifies
 * boundary coordinates, aggregation formulas, support requirements, split
 * conditions, or the selected candidate. Does not repair topology failures.
 *
 * Correctness notes (per the construction-validation gate):
 *  - The TEST split is renamed "experimental confirmation split v1"; it is
 *    NOT an independent final-test split because segments 2,5,6,54,58,99 were
 *    repeatedly inspected, the full dataset was used during reliability
 *    analysis, and candidate behaviour has been viewed on those segments.
 *  - Primary metrics are restricted to laneIndex 1 and 2 (ego boundaries).
 *    Lanes 0 and 3 are separate unsupported extensions.
 *  - Topology results are normalized to published/overlapping kilometres, and
 *    persistent failures are reported as distinct regions (not repeated point
 *    counts).
 *  - Temporal stability reports shared-coverage displacement and marks updates
 *    with no comparable shared coverage as unavailable (not zero).
 *  - Withheld 50% and 75% results are reported separately, with complete
 *    percentiles for every candidate.
 */

const EB = require('./experimental_boundaries');

// --- turning classification -------------------------------------------------
// Causal, observation-level turning categories derived only from the per-point
// reliability input turnRateDegPerSec (yaw rate from the previous eligible
// heading within a 4 s window) plus speed.
const TURN_CATEGORIES = ['straight', 'mild', 'strong', 'headingUnavailable', 'stationary'];

const TURN_THRESHOLDS = {
  mildDegPerSec: 5,      // |yaw| >= this => mild turn
  strongDegPerSec: 15,   // |yaw| >= this => strong turn
  stationarySpeedMps: 1.0,
};

/** Classify one observation's turning state from its reliability inputs. */
function classifyObservationTurn(point, thresholds = TURN_THRESHOLDS) {
  const ri = point?.reliabilityInputs || {};
  const rate = ri.turnRateDegPerSec;
  if (Number.isFinite(rate)) {
    const abs = Math.abs(rate);
    if (abs >= thresholds.strongDegPerSec) return 'strong';
    if (abs >= thresholds.mildDegPerSec) return 'mild';
    return 'straight';
  }
  // Heading unavailable: no rate. If stationary speed is known from movement
  // state we cannot know here; rely on rate==null => headingUnavailable unless
  // speed is available.
  if (point && Number.isFinite(point._speedMps)) {
    if (point._speedMps < thresholds.stationarySpeedMps) return 'stationary';
  }
  return 'headingUnavailable';
}

/**
 * Build a per-frame (timeline) turning-state sequence from frames, using only
 * causal heading information. Returns array aligned to frame index.
 * @param {Array} frames frames with pose {headingDeg, speed}
 */
function frameTurningSequence(frames, opts = {}) {
  const thresholds = { ...TURN_THRESHOLDS, ...(opts.thresholds || {}) };
  const windowSec = opts.headingWindowSec ?? 4;
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!f?.pose) { out.push('headingUnavailable'); continue; }
    const speed = Number.isFinite(f.pose.speed) ? f.pose.speed : null;
    if (speed != null && speed < thresholds.stationarySpeedMps) {
      out.push('stationary');
      continue;
    }
    // find previous eligible frame with pose + heading
    let prevHeading = null;
    let dt = null;
    const t = BigInt(f.logMonoTime);
    for (let j = i - 1; j >= 0; j--) {
      const pf = frames[j];
      if (!pf?.pose) continue;
      const d = Number(t - BigInt(pf.logMonoTime)) / 1e9;
      if (d > windowSec) break;
      if (!Number.isFinite(pf.pose.headingDeg)) continue;
      prevHeading = pf.pose.headingDeg;
      dt = d;
      break;
    }
    if (prevHeading == null || dt == null || dt < 1e-3) {
      out.push('headingUnavailable');
      continue;
    }
    let delta = f.pose.headingDeg - prevHeading;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    const rate = delta / dt;
    const abs = Math.abs(rate);
    if (abs >= thresholds.strongDegPerSec) out.push('strong');
    else if (abs >= thresholds.mildDegPerSec) out.push('mild');
    else out.push('straight');
  }
  return out;
}

/** Count turning-state labels in an array of per-point categories. */
function turnCounts(categories) {
  const c = { straight: 0, mild: 0, strong: 0, headingUnavailable: 0, stationary: 0 };
  for (const x of categories) if (c[x] != null) c[x]++;
  return c;
}

/** Percentage of observations in each category. */
function turnDistribution(categories) {
  const c = turnCounts(categories);
  const n = categories.length || 1;
  const out = {};
  for (const k of Object.keys(c)) out[k] = +(c[k] / n).toFixed(4);
  return out;
}

/** True if a segment contains at least one strong or mild turn interval. */
function hasTurningInterval(sequence) {
  return sequence.some((s) => s === 'mild' || s === 'strong');
}

/**
 * Turn intervals: contiguous runs of non-straight/non-unavailable labels.
 * Returns [{ state, startFrame, endFrame, frameCount }].
 */
function turningIntervals(sequence) {
  const intervals = [];
  let cur = null;
  for (let i = 0; i < sequence.length; i++) {
    const s = sequence[i];
    const isTurn = s === 'mild' || s === 'strong';
    if (isTurn && !cur) cur = { state: s, startFrame: i, endFrame: i, frameCount: 1 };
    else if (isTurn && cur) { cur.endFrame = i; cur.frameCount++; }
    else if (!isTurn && cur) { intervals.push(cur); cur = null; }
  }
  if (cur) intervals.push(cur);
  return intervals;
}

// --- coverage / continuity helpers -----------------------------------------

/** Eligible along-track range from points (min/max s across all lanes). */
function eligibleRange(points) {
  const sValues = points.filter((p) => Number.isFinite(p.s)).map((p) => p.s);
  if (!sValues.length) return null;
  return { sMin: Math.min(...sValues), sMax: Math.max(...sValues), lengthM: Math.max(...sValues) - Math.min(...sValues) };
}

/**
 * Published boundary coverage for lanes 1/2 (or a provided lane subset).
 * Returns per-lane and paired metrics.
 */
function publishedCoverage(boundaries, laneSubset = [1, 2]) {
  const out = { lanes: {}, paired: null, totalM: 0, sections: 0, vertices: 0 };
  const laneSections = {};
  for (const li of laneSubset) {
    const lane = boundaries.lanes[li];
    const secs = lane?.sections || [];
    const len = secs.reduce((a, s) => a + (s.sMax - s.sMin), 0);
    const verts = secs.reduce((a, s) => a + (s.vertices?.length || 0), 0);
    laneSections[li] = secs;
    out.lanes[li] = { publishedM: +len.toFixed(2), sections: secs.length, vertices: verts };
    out.totalM += len;
    out.sections += secs.length;
    out.vertices += verts;
  }
  out.totalM = +out.totalM.toFixed(2);
  // Paired overlap: intersect lane1 and lane2 section s-ranges
  if (laneSubset.length === 2) {
    const a = laneSections[laneSubset[0]] || [];
    const b = laneSections[laneSubset[1]] || [];
    let overlapM = 0;
    for (const sa of a) for (const sb of b) {
      const lo = Math.max(sa.sMin, sb.sMin);
      const hi = Math.min(sa.sMax, sb.sMax);
      if (hi > lo) overlapM += hi - lo;
    }
    out.paired = { overlapM: +overlapM.toFixed(2) };
  }
  return out;
}

/**
 * Union of published s-span across lanes 1/2 as a fraction of eligible.
 * Returns percentage (0-100+) of the eligible along-track range covered by at
 * least one ego boundary.
 */
function unionCoverage(boundaries, laneSubset = [1, 2], eligible) {
  if (!eligible || eligible.lengthM <= 0) return null;
  let minS = Infinity;
  let maxS = -Infinity;
  let any = false;
  for (const li of laneSubset) {
    const secs = boundaries.lanes[li]?.sections || [];
    for (const s of secs) {
      if (s.sMin < minS) minS = s.sMin;
      if (s.sMax > maxS) maxS = s.sMax;
      any = true;
    }
  }
  if (!any) return 0;
  // clip to eligible
  minS = Math.max(minS, eligible.sMin);
  maxS = Math.min(maxS, eligible.sMax);
  if (maxS <= minS) return 0;
  return +((maxS - minS) / eligible.lengthM * 100).toFixed(2);
}

// --- gap classification ----------------------------------------------------

/** Classify the gap between two consecutive sections by cause. */
function classifyGap(prevSec, nextSec, binsByLane, opts) {
  const sGap = nextSec.sMin - prevSec.sMax;
  if (sGap <= 0.5) return 'none';
  if (sGap > opts.maxGapM) return 'spatialGap';
  // check for observations in the gap region
  return 'spatialGap'; // default
}

/** Per-lane gap lengths and reasons between consecutive sections. */
function gapReport(boundaries, points, opts = {}) {
  const o = { ...EB.DEFAULTS, ...opts };
  const out = { byLane: {}, total: { count: 0, lengthM: 0, reasons: {} } };
  for (const li of [1, 2]) {
    const lane = boundaries.lanes[li];
    const secs = lane?.sections || [];
    const gaps = [];
    for (let i = 1; i < secs.length; i++) {
      const g = secs[i].sMin - secs[i - 1].sMax;
      if (g > 0.5) gaps.push({ s0: secs[i - 1].sMax, s1: secs[i].sMin, lengthM: +g.toFixed(2) });
    }
    out.byLane[li] = { gaps };
    for (const g of gaps) { out.total.count++; out.total.lengthM += g.lengthM; }
  }
  out.total.lengthM = +out.total.lengthM.toFixed(2);
  return out;
}

// --- normalized topology ---------------------------------------------------

/** Lane-pair overlap opportunities (s-overlap between lane1 and lane2). */
function lanePairOverlapM(boundaries) {
  const a = boundaries.lanes[1]?.sections || [];
  const b = boundaries.lanes[2]?.sections || [];
  let m = 0;
  for (const sa of a) for (const sb of b) {
    const lo = Math.max(sa.sMin, sb.sMin);
    const hi = Math.min(sa.sMax, sb.sMax);
    if (hi > lo) m += hi - lo;
  }
  return m;
}

/**
 * Normalized topology summary for a candidate on a segment. Uses only
 * lanes 1/2. Returns rates per km and distinct failure regions.
 */
function normalizedTopology(boundaries, opts = {}) {
  const o = { ...EB.DEFAULTS, ...opts };
  const warnings = boundaries.topology?.warnings || [];
  const pub = publishedCoverage(boundaries, [1, 2]);
  const publishedKm = pub.totalM / 1000 || 1e-9;
  const overlapM = lanePairOverlapM(boundaries);
  const overlapKm = overlapM / 1000 || 1e-9;

  const countByType = { selfIntersectionRisk: 0, laneCrossing: 0, implausibleWidth: 0, rightBoundaryOnWrongSide: 0, leftBoundaryOnWrongSide: 0 };
  for (const w of warnings) if (countByType[w.type] != null) countByType[w.type]++;

  // Match warnings to sections (by lane + overlapping s range) to compute
  // affected-section percentage.
  const sectionsById = {};
  let sectionSeq = 0;
  for (const li of [1, 2]) {
    const secs = boundaries.lanes[li]?.sections || [];
    for (const sec of secs) {
      sectionsById[`${li}:${sectionSeq++}`] = sec;
      sec.sectionId = `${li}:${sectionSeq - 1}`;
    }
  }
  const affectedSectionIds = new Set();
  for (const w of warnings) {
    const wl = w.laneIndex ?? null;
    for (const [id, sec] of Object.entries(sectionsById)) {
      if (wl != null && !String(id).startsWith(`${wl}:`)) continue;
      const lo = Math.max(w.sMin ?? -Infinity, sec.sMin);
      const hi = Math.min(w.sMax ?? Infinity, sec.sMax);
      if (hi >= lo) { affectedSectionIds.add(id); break; }
    }
  }
  const sectionCount = pub.sections || 1;
  const affectedSections = affectedSectionIds.size;

  return {
    publishedM: pub.totalM,
    sections: pub.sections,
    vertices: pub.vertices,
    lanePairOverlapM: +overlapM.toFixed(2),
    selfIntPerKm: +(countByType.selfIntersectionRisk / publishedKm).toFixed(3),
    crossingsPerKm: +(countByType.laneCrossing / overlapKm).toFixed(3),
    widthPerKm: +(countByType.implausibleWidth / overlapKm).toFixed(3),
    wrongSidePerKm: +((countByType.rightBoundaryOnWrongSide + countByType.leftBoundaryOnWrongSide) / publishedKm).toFixed(3),
    affectedSectionPct: +((affectedSections / sectionCount) * 100).toFixed(2),
    affectedSegmentPct: null, // filled at aggregation
    rawCounts: countByType,
    warnings,
  };
}

// --- distinct failure regions ----------------------------------------------

/** Cluster warnings of the same type by along-track proximity into regions. */
function failureRegions(boundaries, maxGapM = 10) {
  const warnings = boundaries.topology?.warnings || [];
  const byType = {};
  for (const w of warnings) {
    if (!byType[w.type]) byType[w.type] = [];
    byType[w.type].push(w);
  }
  const regions = [];
  for (const [type, list] of Object.entries(byType)) {
    const span = (w) => (Number.isFinite(w.s) ? w.s : (w.sMin ?? 0));
    const sorted = [...list].sort((a, b) => span(a) - span(b));
    let cur = { type, sMin: span(sorted[0]), sMax: span(sorted[0]), count: 1, laneIndex: sorted[0].laneIndex ?? null, maxSeverity: 1 };
    for (let i = 1; i < sorted.length; i++) {
      const s = span(sorted[i]);
      if (s - cur.sMax <= maxGapM) {
        cur.sMax = s;
        cur.count++;
      } else {
        regions.push({ ...cur, lengthM: +Math.abs(cur.sMax - cur.sMin).toFixed(2) });
        cur = { type, sMin: s, sMax: s, count: 1, laneIndex: sorted[i].laneIndex ?? null, maxSeverity: 1 };
      }
    }
    regions.push({ ...cur, lengthM: +Math.abs(cur.sMax - cur.sMin).toFixed(2) });
  }
  return regions;
}

// --- temporal stability ----------------------------------------------------

/**
 * Corrected temporal stability between two causal boundary builds.
 * Returns displacement on shared coverage; marks unavailable if there is no
 * comparable shared coverage.
 */
function sharedCoverageDisplacement(boundaryA, boundaryB, maxVertexGapM = 6) {
  const samples = [];
  let sharedM = 0;
  let newM = 0;
  let removedM = 0;
  let splitCount = 0;
  let mergeCount = 0;
  for (const li of [1, 2]) {
    const secsA = boundaryA.lanes[li]?.sections || [];
    const secsB = boundaryB.lanes[li]?.sections || [];
    // vertices as flat arrays keyed by s
    const vertsA = secsA.flatMap((s) => s.vertices.map((v) => ({ ...v, lane: li })));
    const vertsB = secsB.flatMap((s) => s.vertices.map((v) => ({ ...v, lane: li })));
    for (const vb of vertsB) {
      const match = vertsA.find((va) => va.lane === li && Math.abs(va.s - vb.s) <= maxVertexGapM);
      if (match) {
        samples.push(Math.abs(match.d - vb.d));
        sharedM += 2; // approx shared coverage step
      } else {
        newM += 2;
      }
    }
    for (const va of vertsA) {
      const match = vertsB.find((vb) => vb.lane === li && Math.abs(va.s - vb.s) <= maxVertexGapM);
      if (!match) removedM += 2;
    }
    // section split/merge heuristics by count change
    if (secsB.length > secsA.length) splitCount += secsB.length - secsA.length;
    else if (secsA.length > secsB.length) mergeCount += secsA.length - secsB.length;
  }
  if (!samples.length) {
    return {
      available: false,
      reason: 'noComparableSharedCoverage',
      sharedVertices: 0,
      sharedM: 0,
      newM: +newM.toFixed(2),
      removedM: +removedM.toFixed(2),
      sectionSplits: splitCount,
      sectionMerges: mergeCount,
    };
  }
  return {
    available: true,
    sharedVertices: samples.length,
    sharedM: +sharedM.toFixed(2),
    medianDisplacementM: +EB.median(samples).toFixed(3),
    p90DisplacementM: +EB.quantile(samples, 0.9).toFixed(3),
    p95DisplacementM: +EB.quantile(samples, 0.95).toFixed(3),
    newM: +newM.toFixed(2),
    removedM: +removedM.toFixed(2),
    sectionSplits: splitCount,
    sectionMerges: mergeCount,
  };
}

/** Boundary metres by turning state of the supporting observations at that s. */
function boundaryMetresByTurnState(boundaries, points, seq, laneSubset = [1, 2]) {
  // Build an s -> turning-state lookup from points (frame index -> seq state).
  const frameState = seq;
  // For each section vertex, estimate the dominant turning state of supporting
  // observations near that s.
  const out = { straight: 0, mild: 0, strong: 0, headingUnavailable: 0, stationary: 0 };
  for (const li of laneSubset) {
    const secs = boundaries.lanes[li]?.sections || [];
    for (const sec of secs) {
      for (let v = 0; v < sec.vertices.length; v++) {
        const vt = sec.vertices[v];
        const nextS = v + 1 < sec.vertices.length ? sec.vertices[v + 1].s : vt.s;
        const len = Math.max(0, nextS - vt.s);
        // nearest supporting point state
        let nearest = null;
        let bestD = Infinity;
        for (const p of points) {
          if (p.laneIndex !== li) continue;
          if (Math.abs(p.s - vt.s) > 6) continue;
          const st = frameState[p.frameIndex] || 'headingUnavailable';
          const d = Math.abs(p.s - vt.s);
          if (d < bestD) { bestD = d; nearest = st; }
        }
        const st = nearest || 'headingUnavailable';
        out[st] = (out[st] || 0) + len;
      }
    }
  }
  for (const k of Object.keys(out)) out[k] = +out[k].toFixed(2);
  return out;
}

module.exports = {
  TURN_CATEGORIES,
  TURN_THRESHOLDS,
  classifyObservationTurn,
  frameTurningSequence,
  turnCounts,
  turnDistribution,
  hasTurningInterval,
  turningIntervals,
  eligibleRange,
  publishedCoverage,
  unionCoverage,
  gapReport,
  lanePairOverlapM,
  normalizedTopology,
  failureRegions,
  sharedCoverageDisplacement,
  enrichWarningsWithSection,
  boundaryMetresByTurnState,
};

/** Join topology warnings with section/vertex metadata for the audit. */
function enrichWarningsWithSection(boundaries, opts = {}) {
  const o = { ...EB.DEFAULTS, ...opts };
  const warnings = boundaries.topology?.warnings || [];
  const sectionsById = [];
  for (const li of [1, 2]) {
    const secs = boundaries.lanes[li]?.sections || [];
    for (const sec of secs) {
      sectionsById.push({ laneIndex: li, ...sec });
    }
  }
  return warnings.map((w, i) => {
    const wl = w.laneIndex ?? null;
    const sec = sectionsById.find((s) => {
      if (wl != null && s.laneIndex !== wl) return false;
      const lo = Math.max(w.sMin ?? -Infinity, s.sMin);
      const hi = Math.min(w.sMax ?? Infinity, s.sMax);
      return hi >= lo;
    });
    return {
      warningId: i,
      type: w.type,
      laneIndex: wl,
      sMin: w.sMin ?? w.s ?? null,
      sMax: w.sMax ?? w.s ?? null,
      s: w.s ?? null,
      detail: w,
      section: sec ? {
        sectionId: `${sec.laneIndex}:${sectionsById.indexOf(sec)}`,
        sMin: sec.sMin,
        sMax: sec.sMax,
        vertices: sec.vertices,
        directionWarning: sec.directionWarning ?? null,
      } : null,
    };
  });
}
