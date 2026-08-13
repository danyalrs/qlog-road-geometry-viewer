'use strict';

/**
 * Additional corrected-audit helpers for the experimental lane-boundary
 * construction. Investigation/experiment only — pure, read-only functions.
 * Never modifies boundary coordinates, aggregation formulas, support
 * requirements, split conditions, or the selected candidate.
 *
 * Adds the missing measurements requested by the construction-validation gate:
 *  - gap-reason determination using construction metadata (not geometry alone)
 *  - distinct observation (frame) vs point counts
 *  - time-based (seconds) temporal-separation sensitivity
 *  - warning severity in geometric units + distinct-region analysis
 *  - per-update temporal stability with add/remove warning tracking
 *  - turning-interval coverage (eligible/published/coverage per category)
 */

const EB = require('./experimental_boundaries');

const GAP_REASONS = [
  'insufficientDistinctTemporalSupport',
  'missingLanePrediction',
  'chunkBoundary',
  'passBoundary',
  'temporalGap',
  'spatialGap',
  'excessiveLateralJump',
  'incompatibleLaneTrackId',
  'sectionDroppedFewerThanThreeBins',
  'otherDocumented',
  'unresolved',
];

// --- distinct observation vs point counts ----------------------------------

/**
 * Distinct observation/frame count vs point count for a lane subset.
 * Observations are distinct by (chunkId, passId, laneIndex, frameIndex).
 */
function observationVsPointCounts(points, laneSubset = null) {
  const subset = laneSubset ? points.filter((p) => laneSubset.includes(p.laneIndex)) : points;
  const distinctObs = new Set();
  for (const p of subset) {
    distinctObs.add(`${p.chunkId}:${p.passId}:${p.laneIndex}:${p.frameIndex}`);
  }
  return { distinctObservations: distinctObs.size, points: subset.length };
}

// --- gap-reason determination ----------------------------------------------

/**
 * Determine the earliest applicable construction reason for the gap between two
 * consecutive published sections of a lane, using construction metadata.
 * Inspects the bins between the sections and the section endpoints.
 */
function determineGapReason(prevSec, nextSec, lanePoints, bins, opts = {}) {
  const o = { ...EB.DEFAULTS, ...opts };
  const gap0 = prevSec.sMax;
  const gap1 = nextSec.sMin;
  const gapLen = gap1 - gap0;

  // 1. chunk / pass boundary (different chunk or pass across the break)
  const prevChunkPass = new Set(lanePoints.filter((p) => p.s >= prevSec.sMin && p.s <= prevSec.sMax).map((p) => `${p.chunkId}:${p.passId}`));
  const nextChunkPass = new Set(lanePoints.filter((p) => p.s >= nextSec.sMin && p.s <= nextSec.sMax).map((p) => `${p.chunkId}:${p.passId}`));
  if (prevChunkPass.size === 1 && nextChunkPass.size === 1) {
    const [pc] = prevChunkPass;
    const [nc] = nextChunkPass;
    if (pc !== nc) {
      const [pcChunk] = pc.split(':');
      const [ncChunk] = nc.split(':');
      return pcChunk === ncChunk ? 'passBoundary' : 'chunkBoundary';
    }
  }

  // 2. incompatible laneTrackId across the break
  const prevTracks = new Set(lanePoints.filter((p) => p.s >= prevSec.sMin && p.s <= prevSec.sMax).map((p) => p.laneTrackId ?? 'x'));
  const nextTracks = new Set(lanePoints.filter((p) => p.s >= nextSec.sMin && p.s <= nextSec.sMax).map((p) => p.laneTrackId ?? 'x'));
  if (prevTracks.size && nextTracks.size && [...prevTracks].every((t) => !nextTracks.has(t))) {
    return 'incompatibleLaneTrackId';
  }

  // 3. bins between the sections (the "gap region")
  const gapBins = bins.filter((b) => b.s0 < gap1 && b.s1 > gap0);
  // points actually observed in the gap region
  const gapPoints = lanePoints.filter((p) => p.s > gap0 && p.s < gap1);

  // 4. missing lane prediction: no observations at all in the gap region
  if (!gapPoints.length) return 'missingLanePrediction';

  // 5. temporal gap: large time between newest obs before gap and oldest after
  const prevTimes = lanePoints.filter((p) => p.s <= prevSec.sMax).map((p) => Number(BigInt(String(p.logMonoTime))));
  const nextTimes = lanePoints.filter((p) => p.s >= nextSec.sMin).map((p) => Number(BigInt(String(p.logMonoTime))));
  if (prevTimes.length && nextTimes.length) {
    const maxPrev = Math.max(...prevTimes);
    const minNext = Math.min(...nextTimes);
    const dtSec = (minNext - maxPrev) / 1e9;
    if (dtSec > o.headingWindowSec) return 'temporalGap';
  }

  // 6. spatial gap: gap length > maxGapM
  if (gapLen > o.maxGapM) return 'spatialGap';

  // 7. excessive lateral jump between the two section endpoints
  const prevLastD = prevSec.vertices[prevSec.vertices.length - 1]?.d;
  const nextFirstD = nextSec.vertices[0]?.d;
  if (prevLastD != null && nextFirstD != null && Math.abs(prevLastD - nextFirstD) > o.maxLateralJumpM) {
    return 'excessiveLateralJump';
  }

  // 8. bins in the gap that were not published due to insufficient temporal
  //    support or support-count
  const unpublished = gapBins.filter((b) => !b.published);
  if (unpublished.length) {
    const anyLowTs = unpublished.some((b) => b.distinctTimestamps < o.minDistinctTimestamps);
    const anyLowSupport = unpublished.some((b) => b.supportCount < o.minSupportObservations);
    if (anyLowTs && !anyLowSupport) return 'insufficientDistinctTemporalSupport';
    if (anyLowSupport) return 'insufficientDistinctTemporalSupport';
  }

  // 9. dropped section (fewer than three bins): a section of 1-2 published bins
  //    was dropped between the two endpoints
  const droppedBins = gapBins.filter((b) => b.published && b.supportCount >= o.minSupportObservations);
  if (droppedBins.length >= 1 && droppedBins.length < o.minBinsPerSection) {
    return 'sectionDroppedFewerThanThreeBins';
  }

  return 'otherDocumented';
}

/**
 * Compute per-lane gap reasons for a candidate on a segment. Requires the
 * per-bin published flag (computed here from the same rules).
 */
function gapReasonReport(boundaries, points, candidate, opts = {}) {
  const o = { ...EB.DEFAULTS, ...opts };
  const out = { byLane: {}, total: { byReason: {}, count: 0, metresM: 0 } };
  for (const li of [1, 2]) {
    const lanePoints = points.filter((p) => p.laneIndex === li);
    const bins = EB.binObservations(lanePoints, o);
    // mark published per bin under the candidate
    for (const b of bins) {
      const v = candidate === 'H' ? EB.hardThresholdVertex(b, o) : EB.binVertex(b, candidate, o);
      b.published = v != null;
    }
    const secs = boundaries.lanes[li]?.sections || [];
    const reasons = {};
    const gapList = [];
    for (let i = 1; i < secs.length; i++) {
      const reason = determineGapReason(secs[i - 1], secs[i], lanePoints, bins, o);
      const len = secs[i].sMin - secs[i - 1].sMax;
      if (len <= 0.5) continue;
      if (!reasons[reason]) reasons[reason] = { count: 0, metresM: 0, lengths: [] };
      reasons[reason].count++;
      reasons[reason].metresM += len;
      reasons[reason].lengths.push(len);
      gapList.push({ s0: secs[i - 1].sMax, s1: secs[i].sMin, lengthM: len, reason });
    }
    out.byLane[li] = { reasons, gaps: gapList };
    for (const [reason, r] of Object.entries(reasons)) {
      if (!out.total.byReason[reason]) out.total.byReason[reason] = { count: 0, metresM: 0, lengths: [] };
      out.total.byReason[reason].count += r.count;
      out.total.byReason[reason].metresM += r.metresM;
      out.total.byReason[reason].lengths.push(...r.lengths);
    }
    out.total.count += gapList.length;
    out.total.metresM += gapList.reduce((a, g) => a + g.lengthM, 0);
  }
  // aggregate length stats per reason
  for (const [reason, r] of Object.entries(out.total.byReason)) {
    r.medianM = +EB.median(r.lengths).toFixed(2);
    r.p90M = +EB.quantile(r.lengths, 0.9).toFixed(2);
    r.p95M = +EB.quantile(r.lengths, 0.95).toFixed(2);
    r.maxM = +Math.max(...r.lengths).toFixed(2);
    r.affectedSegments = 1; // filled at aggregation
    r.pctOfMissingCoverage = null; // filled at aggregation
  }
  return out;
}

// --- time-based temporal separation ----------------------------------------

/**
 * Withheld consistency under elapsed-time separation thresholds (seconds).
 * Held-out observations must be >= threshold seconds after the construction
 * observations (using logMonoTime, nanoseconds).
 */
function withheldTimeSeparation(points, candidate, splitFraction, opts = {}) {
  const secondsThresholds = opts.separationSeconds || [2, 5, 10];
  const maxFrame = Math.max(...points.map((p) => p.frameIndex));
  const splitAt = Math.floor(maxFrame * splitFraction);
  const construction = points.filter((p) => p.frameIndex <= splitAt && (p.laneIndex === 1 || p.laneIndex === 2));
  const maxConsTime = construction.length
    ? Math.max(...construction.map((p) => Number(BigInt(String(p.logMonoTime)))))
    : 0;
  const eb = EB.buildExperimentalBoundaries(construction, { ...opts, candidate });
  const sections = new Map();
  for (const li of [1, 2]) sections.set(li, eb.lanes[li]?.sections || []);
  const fitD = (h, li) => {
    const secs = sections.get(li) || [];
    for (const sec of secs) {
      const vs = sec.vertices;
      if (h.s < vs[0].s || h.s > vs[vs.length - 1].s) continue;
      for (let i = 0; i + 1 < vs.length; i++) {
        if (h.s >= vs[i].s && h.s <= vs[i + 1].s) {
          const t = (h.s - vs[i].s) / Math.max(1e-9, vs[i + 1].s - vs[i].s);
          return vs[i].d + t * (vs[i + 1].d - vs[i].d);
        }
      }
    }
    return null;
  };
  const out = {};
  for (const sec of secondsThresholds) {
    const residuals = [];
    let distObs = 0;
    let segCount = 0;
    let sharedTrack = 0;
    let nearDup = 0;
    let physOverlap = 0;
    const heldOut = points.filter((p) => {
      if (p.laneIndex !== 1 && p.laneIndex !== 2) return false;
      const t = Number(BigInt(String(p.logMonoTime)));
      return (t - maxConsTime) / 1e9 >= sec;
    });
    for (const h of heldOut) {
      const f = fitD(h, h.laneIndex);
      if (f == null) continue;
      residuals.push(Math.abs(f - h.d));
      distObs++;
      if (h.laneTrackId != null && construction.some((c) => c.laneTrackId === h.laneTrackId && c.laneIndex === h.laneIndex)) sharedTrack++;
      const dt = (Number(BigInt(String(h.logMonoTime))) - maxConsTime) / 1e9;
      const near = construction.filter((c) => c.laneIndex === h.laneIndex && Math.abs(c.s - h.s) < 2 && Math.abs(c.d - h.d) < 0.5);
      if (near.length) { nearDup++; physOverlap++; }
    }
    out[`${sec}s`] = residuals.length
      ? {
        n: residuals.length,
        distinctHeldOutObservations: distObs,
        representedSegments: 1,
        medianM: +EB.median(residuals).toFixed(3),
        p90M: +EB.quantile(residuals, 0.9).toFixed(3),
        p95M: +EB.quantile(residuals, 0.95).toFixed(3),
        medianSeparationSec: +EB.median(heldOut.map((h) => (Number(BigInt(String(h.logMonoTime))) - maxConsTime) / 1e9)).toFixed(1),
        sharedLaneTrackPct: distObs ? +((sharedTrack / distObs) * 100).toFixed(1) : null,
        nearDuplicatePct: distObs ? +((nearDup / distObs) * 100).toFixed(1) : null,
        physicalOverlapPct: distObs ? +((physOverlap / distObs) * 100).toFixed(1) : null,
      }
      : { n: 0, distinctHeldOutObservations: 0, representedSegments: 0, medianM: null, p90M: null, p95M: null, medianSeparationSec: null, sharedLaneTrackPct: null, nearDuplicatePct: null, physicalOverlapPct: null };
  }
  return out;
}

// --- warning severity + distinct regions -----------------------------------

/** Severity in geometric units for each topology warning type. */
function warningSeverity(warning) {
  switch (warning.type) {
    case 'laneCrossing':
      // d1 - d2 (how far lane1 has crossed past lane2), metres
      return { units: 'm', value: Math.max(0, (warning.d1 ?? 0) - (warning.d2 ?? 0)) };
    case 'implausibleWidth':
      // distance below min or above max plausible width, metres
      return { units: 'm', value: Math.max(0, warning.widthM ?? 0) };
    case 'rightBoundaryOnWrongSide':
    case 'leftBoundaryOnWrongSide':
      // lateral displacement onto the wrong side, metres (|d| when d has wrong sign)
      return { units: 'm', value: Math.abs(warning.d ?? warning.d1 ?? warning.negD ?? 0) };
    case 'selfIntersectionRisk':
      // reversal magnitude: |d_a + d_c| at the reversal vertex (approx)
      return { units: 'm', value: Math.abs(warning.d ?? 0) };
    default:
      return { units: 'unitless', value: 1 };
  }
}

/** Distinct warning regions with severity aggregation. */
function warningRegionsDetailed(boundaries, maxGapM = 10) {
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
    let cur = { type, sMin: span(sorted[0]), sMax: span(sorted[0]), count: 1, laneIndex: sorted[0].laneIndex ?? null, severities: [] };
    cur.severities.push(warningSeverity(sorted[0]).value);
    for (let i = 1; i < sorted.length; i++) {
      const s = span(sorted[i]);
      if (s - cur.sMax <= maxGapM) {
        cur.sMax = s;
        cur.count++;
        cur.severities.push(warningSeverity(sorted[i]).value);
      } else {
        regions.push({ ...cur, lengthM: +Math.abs(cur.sMax - cur.sMin).toFixed(2), medianSeverityM: +EB.median(cur.severities).toFixed(3), maxSeverityM: +Math.max(...cur.severities).toFixed(3) });
        cur = { type, sMin: s, sMax: s, count: 1, laneIndex: sorted[i].laneIndex ?? null, severities: [warningSeverity(sorted[i]).value] };
      }
    }
    regions.push({ ...cur, lengthM: +Math.abs(cur.sMax - cur.sMin).toFixed(2), medianSeverityM: +EB.median(cur.severities).toFixed(3), maxSeverityM: +Math.max(...cur.severities).toFixed(3) });
  }
  return regions;
}

/** Raw samples + distinct regions + affected metres + severity by type. */
function warningSummaryByType(boundaries, maxGapM = 10) {
  const warnings = boundaries.topology?.warnings || [];
  const regions = warningRegionsDetailed(boundaries, maxGapM);
  const byType = {};
  for (const w of warnings) {
    if (!byType[w.type]) byType[w.type] = { rawSamples: 0, regions: 0, affectedMetresM: 0, longestRegionM: 0, medianSeverityM: null, maxSeverityM: null, regionList: [] };
    byType[w.type].rawSamples++;
  }
  for (const r of regions) {
    if (!byType[r.type]) continue;
    byType[r.type].regions++;
    byType[r.type].affectedMetresM += r.lengthM;
    byType[r.type].longestRegionM = Math.max(byType[r.type].longestRegionM, r.lengthM);
    byType[r.type].regionList.push({ sMin: r.sMin, sMax: r.sMax, lengthM: r.lengthM, count: r.count, medianSeverityM: r.medianSeverityM, maxSeverityM: r.maxSeverityM });
  }
  for (const t of Object.keys(byType)) {
    const sev = byType[t].regionList.map((r) => r.maxSeverityM);
    byType[t].medianSeverityM = sev.length ? +EB.median(sev).toFixed(3) : null;
    byType[t].maxSeverityM = sev.length ? +Math.max(...sev).toFixed(3) : null;
  }
  return byType;
}

module.exports = {
  GAP_REASONS,
  observationVsPointCounts,
  determineGapReason,
  gapReasonReport,
  withheldTimeSeparation,
  warningSeverity,
  warningRegionsDetailed,
  warningSummaryByType,
};
