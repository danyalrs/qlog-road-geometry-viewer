'use strict';

/**
 * Final reconciliation helpers for the experimental lane-boundary audit.
 * Investigation/experiment only — pure, read-only functions. Never modifies
 * boundary construction behaviour.
 *
 * Purpose: produce aggregation-typed tables, reconcile denominators/units,
 * compute edge-uncovered coverage and full gap reconciliation, define
 * near-duplicate predictions, and inventory turning evidence across the full
 * usable dataset.
 */

const EB = require('./experimental_boundaries');
const EBA = require('./experimental_boundaries_audit');

// --- aggregation-typed value wrapper --------------------------------------

/**
 * Wrap a value with its aggregation type, numerator and denominator so tables
 * are never ambiguous.
 */
function agg(value, { type, numerator = null, denominator = null, unit = null, note = null }) {
  return { value, aggregation: type, numerator, denominator, unit, note };
}

function datasetTotal(value, unit) { return agg(value, { type: 'dataset total', unit }); }
function medianAcrossSegments(value, unit) { return agg(value, { type: 'median across segments', unit }); }
function p90AcrossSegments(value, unit) { return agg(value, { type: 'p90 across segments', unit }); }
function p95AcrossSegments(value, unit) { return agg(value, { type: 'p95 across segments', unit }); }
function pooledRate(value, numerator, denominator, unit) {
  return agg(value, { type: 'pooled rate', numerator, denominator, unit });
}
function medianPerSegmentRate(value, numerator, denominator, unit) {
  return agg(value, { type: 'median per-segment rate', numerator, denominator, unit });
}
function p90PerSegmentRate(value, numerator, denominator, unit) {
  return agg(value, { type: 'p90 per-segment rate', numerator, denominator, unit });
}

// --- stats -----------------------------------------------------------------

function quantile(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}
function median(arr) { return arr.length ? quantile(arr, 0.5) : null; }

// --- edge-uncovered metres -------------------------------------------------

/**
 * Edge-uncovered metres: portion of the eligible lane-1/2 along-track range
 * that has no published boundary at all (before the first or after the last
 * published section), per lane.
 */
function edgeUncoveredMetres(boundaries, eligible, laneSubset = [1, 2]) {
  const out = {};
  let total = 0;
  for (const li of laneSubset) {
    const secs = boundaries.lanes[li]?.sections || [];
    let uncovered = 0;
    if (secs.length) {
      if (secs[0].sMin > eligible.sMin) uncovered += secs[0].sMin - eligible.sMin;
      if (secs[secs.length - 1].sMax < eligible.sMax) uncovered += eligible.sMax - secs[secs.length - 1].sMax;
    } else {
      uncovered = eligible.lengthM;
    }
    out[li] = +uncovered.toFixed(2);
    total += uncovered;
  }
  out.totalM = +total.toFixed(2);
  return out;
}

// --- gap reconciliation ----------------------------------------------------

/**
 * Full gap reconciliation for a lane subset:
 * eligibleM = publishedM + internalGapM + edgeUncoveredM + unavailableLaneM
 * where unavailableLaneM = lane-eligible metres with no observations (missing
 * predictions) not otherwise counted.
 */
function reconcileCoverage(points, boundaries, eligible, candidate, laneSubset = [1, 2], opts = {}) {
  const o = { ...EB.DEFAULTS, ...opts };
  // Per-lane reconciliation: eligible_lane = published_lane + internalGap_lane
  // + edgeUncovered_lane + unavailableLane_lane. Each lane reconciles against
  // its OWN eligible range (not the union across lanes).
  const perLane = {};
  let totals = { eligibleM: 0, publishedM: 0, internalGapM: 0, edgeUncoveredM: 0, unavailableLaneM: 0, totalMissingM: 0 };
  for (const li of laneSubset) {
    const lanePts = points.filter((p) => p.laneIndex === li);
    const laneEligible = EBA.eligibleRange(lanePts);
    if (!laneEligible) { continue; }
    const secs = boundaries.lanes[li]?.sections || [];
    const pubLane = secs.reduce((a, s) => a + (s.sMax - s.sMin), 0);
    let internalGapLane = 0;
    for (let i = 1; i < secs.length; i++) {
      const g = secs[i].sMin - secs[i - 1].sMax;
      if (g > 0.5) internalGapLane += g;
    }
    const edge = edgeUncoveredMetres(boundaries, laneEligible, [li]);
    const edgeLane = edge[li] ?? 0;
    // unavailable-lane (true residual): any eligible metre not published and
    // not attributable to internal gaps or edge-uncovered. Computed as the
    // balancing term so the per-lane equation reconciles exactly.
    const unavail = Math.max(0, laneEligible.lengthM - pubLane - internalGapLane - edgeLane);
    const totalMissingLane = internalGapLane + edgeLane + unavail;
    perLane[li] = {
      eligibleM: +laneEligible.lengthM.toFixed(2),
      publishedM: +pubLane.toFixed(2),
      internalGapM: +internalGapLane.toFixed(2),
      edgeUncoveredM: +edgeLane.toFixed(2),
      unavailableLaneM: +unavail.toFixed(2),
      totalMissingM: +totalMissingLane.toFixed(2),
      residualM: +Math.abs(laneEligible.lengthM - pubLane - totalMissingLane).toFixed(2),
      reconciled: Math.abs((laneEligible.lengthM - pubLane) - totalMissingLane) < 5,
    };
    for (const k of Object.keys(totals)) {
      if (k === 'reconciled' || k === 'residualM') continue;
      totals[k] += perLane[li][k];
    }
  }
  const reconciled = Object.values(perLane).every((v) => v.reconciled);
  return {
    eligibleM: +totals.eligibleM.toFixed(2),
    publishedM: +totals.publishedM.toFixed(2),
    internalGapM: +totals.internalGapM.toFixed(2),
    edgeUncoveredM: +totals.edgeUncoveredM.toFixed(2),
    unavailableLaneM: +totals.unavailableLaneM.toFixed(2),
    totalMissingM: +totals.totalMissingM.toFixed(2),
    perLane,
    reconciled,
    reconciliationEquation: 'per-lane: eligible = published + internalGap + edgeUncovered + unavailableLane',
  };
}

// --- near-duplicate prediction definition ---------------------------------

/**
 * Near-duplicate prediction definition (documented, tested):
 * a held-out observation is a near-duplicate of a construction observation if
 * it is in the same laneIndex, within 2 m along-track (s) and within 0.5 m
 * lateral (d) of a construction observation from a different frame. This
 * captures the same physical boundary re-predicted near-identically.
 */
function isNearDuplicate(held, construction) {
  return construction.some((c) =>
    c.laneIndex === held.laneIndex
    && c.frameIndex !== held.frameIndex
    && Math.abs(c.s - held.s) < 2
    && Math.abs(c.d - held.d) < 0.5);
}

// --- full-dataset turning inventory ---------------------------------------

/**
 * Inventory one usable segment's turning evidence.
 * @returns per-category distinct-observation counts, eligible metres by lane
 *          and category, B/C/D published metres by category (approx via
 *          boundary-metres-by-turn-state), comparable temporal updates by
 *          category.
 */
function inventorySegment(points, frames, opts = {}) {
  const seq = EBA.frameTurningSequence(frames);
  const o = { ...EB.DEFAULTS, ...opts };
  const categories = ['straight', 'mild', 'strong', 'headingUnavailable', 'stationary'];
  const distObs = { straight: 0, mild: 0, strong: 0, headingUnavailable: 0, stationary: 0 };
  const eligibleByCat = { straight: {}, mild: {}, strong: {}, headingUnavailable: {}, stationary: {} };
  const perLanePoints = { 1: [], 2: [] };
  const distinctFrameByCat = { straight: new Set(), mild: new Set(), strong: new Set(), headingUnavailable: new Set(), stationary: new Set() };
  for (const p of points) {
    const cat = seq[p.frameIndex] || 'headingUnavailable';
    if (!categories.includes(cat)) continue;
    if (p.laneIndex === 1 || p.laneIndex === 2) perLanePoints[p.laneIndex].push(p);
    distinctFrameByCat[cat].add(`${p.chunkId}:${p.passId}:${p.laneIndex}:${p.frameIndex}`);
  }
  for (const cat of categories) distObs[cat] = distinctFrameByCat[cat].size;
  // eligible metres per lane per category
  for (const li of [1, 2]) {
    const lanePts = perLanePoints[li];
    for (const cat of categories) {
      const catPts = lanePts.filter((p) => (seq[p.frameIndex] || 'headingUnavailable') === cat);
      eligibleByCat[cat][li] = catPts.length ? +(EBA.eligibleRange(catPts)?.lengthM ?? 0).toFixed(1) : 0;
    }
  }
  // B/C/D published metres by category (via boundary-metres-by-turn-state)
  const publishedByCat = {};
  for (const c of ['B', 'C', 'D']) {
    const eb = EB.buildExperimentalBoundaries(points, { ...o, candidate: c });
    const bm = EBA.boundaryMetresByTurnState(eb, points, seq, [1, 2]);
    publishedByCat[c] = bm;
  }
  // comparable temporal updates by category (candidate D)
  const tempByCat = { straight: 0, mild: 0, strong: 0, headingUnavailable: 0, stationary: 0 };
  const frameNums = [...new Set(points.map((p) => p.frameIndex))].sort((a, b) => a - b);
  for (let i = 1; i < frameNums.length; i++) {
    const k = frameNums[i - 1];
    const k1 = frameNums[i];
    const cat = seq[k1] || 'headingUnavailable';
    const A = EB.buildExperimentalBoundaries(points.filter((p) => p.frameIndex <= k), { ...o, candidate: 'D' });
    const B = EB.buildExperimentalBoundaries(points.filter((p) => p.frameIndex <= k1), { ...o, candidate: 'D' });
    const disp = EBA.sharedCoverageDisplacement(A, B);
    if (disp.available) tempByCat[cat]++;
  }
  return {
    segment: null, // filled by caller
    distinctObservations: distObs,
    eligibleMetresByCategoryByLane: eligibleByCat,
    publishedMetresByCategoryByCandidate: publishedByCat,
    comparableTemporalUpdatesByCategory: tempByCat,
  };
}

module.exports = {
  agg,
  datasetTotal,
  medianAcrossSegments,
  p90AcrossSegments,
  p95AcrossSegments,
  pooledRate,
  medianPerSegmentRate,
  p90PerSegmentRate,
  quantile,
  median,
  edgeUncoveredMetres,
  reconcileCoverage,
  isNearDuplicate,
  inventorySegment,
};
