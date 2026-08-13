'use strict';

/**
 * Browser mirror of lib/experimental_boundaries.js.
 * Regenerate with: node scripts/sync_experimental_boundaries_public.js
 */

/**
 * Experimental display-only lane-boundary construction from Point-accumulated
 * observations.
 *
 * This is an experiment. It never filters, removes, moves or connects the
 * existing Point dots, never alters coordinates or laneTrackId, and is never
 * used for map fusion, smoothing, snapping or road polygons. It aggregates the
 * (signed lateral) evidence in along-track bins and fits local boundary lines
 * that are drawn only as a labelled experimental overlay.
 *
 * Coordinate frame: s = progress along the verified reference trajectory
 * (metres), d = signed lateral placement relative to that trajectory (metres,
 * left-positive). Boundary vertices are converted back to segment-local
 * east/north via an s->local index built from the point observations so the
 * overlay lines up exactly with the dots.
 *
 * Construction candidates:
 *   A. unweighted robust aggregation (median per bin)
 *   B. reliability-weighted robust aggregation
 *   C. B + temporal-support requirement (>= minDistinctTimestamps per bin)
 *   D. C + robust outlier resistance (MAD-scaled weights)
 * A hard-threshold baseline (H) is provided ONLY for evaluation to demonstrate
 * precision/recall limitations.
 *
 * Reliability is an aggregation weight / evidence-ranking input only. It is
 * never interpreted as probability of correctness and never deletes points.
 */

const DEFAULTS = {
  // Along-track bin width (m).
  binSizeM: 4,
  // Minimum supporting observations to publish a bin.
  minSupportObservations: 3,
  // Minimum distinct timestamps to publish a bin (temporal support).
  minDistinctTimestamps: 2,
  // Minimum bins in a published boundary section.
  minBinsPerSection: 3,
  // Max along-track gap (m) between supported bins before an explicit break.
  maxGapM: 10,
  // Max lateral jump (m) between adjacent bin medians before a break.
  maxLateralJumpM: 8,
  // Robust outlier resistance: MAD multiple above which a point's weight decays.
  madCutoff: 3.0,
  // Hard-threshold baseline score (evaluation only).
  hardThresholdScore: 0.4,
  // Plausible experimental lane width range (m).
  minWidthM: 1.5,
  maxWidthM: 8.0,
  // Max width change between adjacent s bins before flagging (m).
  maxWidthChangeM: 2.5,
  // Max turning (deg/s) that still counts as "straight" for reporting.
  straightTurnRateDps: 5.0,
  // Candidate to use for the overlay (default selected experimental candidate).
  candidate: 'D',
};

// --- small stats helpers ---------------------------------------------------

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function quantile(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}
function mad(arr) {
  if (!arr.length) return null;
  const m = median(arr);
  return median(arr.map((x) => Math.abs(x - m)));
}

/** Robust weighted median of (value, weight) pairs. */
function weightedMedian(pairs) {
  if (!pairs.length) return null;
  const sorted = [...pairs].sort((a, b) => a.value - b.value);
  const totalW = sorted.reduce((a, b) => a + b.weight, 0);
  if (totalW <= 0) return sorted[Math.floor(sorted.length / 2)].value;
  let acc = 0;
  for (const p of sorted) {
    acc += p.weight;
    if (acc >= totalW / 2) return p.value;
  }
  return sorted[sorted.length - 1].value;
}

/**
 * Compute the reliability weight for a point under a candidate.
 * Candidate A: weight 1 (unweighted median).
 * Candidate B/C/D: weight = clamp(reliability, 0, 1).
 * Candidate D additionally decays outliers via a MAD-scaled weight (applied by
 * the caller after the bin MAD is known — see weightForPointInBin).
 */
function baseReliabilityWeight(reliability) {
  const s = reliability?.combinedScore;
  return Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : 0.5;
}

/**
 * Per-bin MAD-scaled weight for candidate D. Points farther than
 * madCutoff*MAD from the bin's weighted median get a decaying weight so one
 * extreme far point cannot pull the boundary.
 */
function outlierResistanceWeight(lateralM, binMad, binMedian, madCutoff) {
  if (!Number.isFinite(binMad) || binMad <= 1e-6) return 1;
  const dev = Math.abs(lateralM - binMedian);
  if (dev <= madCutoff * binMad) return 1;
  return Math.max(0, Math.pow(madCutoff * binMad / dev, 2));
}

/**
 * Group point observations into along-track bins for one (chunk, pass, lane).
 * Returns an ordered array of bins: { s0, s1, sCenter, observations, ... }.
 */
function binObservations(points, opts) {
  const bins = [];
  const byKey = new Map();
  for (const p of points) {
    if (!Number.isFinite(p.s) || !Number.isFinite(p.d)) continue;
    const idx = Math.floor(p.s / opts.binSizeM);
    const key = idx;
    if (!byKey.has(key)) {
      byKey.set(key, { idx, s0: idx * opts.binSizeM, s1: idx * opts.binSizeM + opts.binSizeM, obs: [] });
    }
    byKey.get(key).obs.push(p);
  }
  for (const [key, b] of byKey) {
    const obs = b.obs;
    const dValues = obs.map((o) => o.d);
    const relScores = obs.map((o) => o.reliability?.combinedScore ?? null).filter((x) => x != null);
    const probs = obs.map((o) => o.prob ?? 1);
    const timestamps = new Set(obs.map((o) => String(o.logMonoTime)));
    const tempDisag = obs.map((o) => o.reliabilityInputs?.temporalDisagreementM ?? null).filter((x) => x != null);
    bins.push({
      idx: key,
      s0: b.s0,
      s1: b.s1,
      sCenter: (b.s0 + b.s1) / 2,
      supportCount: obs.length,
      distinctTimestamps: timestamps.size,
      newestLogMonoTime: Math.max(...obs.map((o) => Number(BigInt(String(o.logMonoTime))))),
      oldestLogMonoTime: Math.min(...obs.map((o) => Number(BigInt(String(o.logMonoTime))))),
      laneIndices: [...new Set(obs.map((o) => o.laneIndex))],
      laneTrackIds: [...new Set(obs.map((o) => o.laneTrackId ?? null))],
      medianReliability: relScores.length ? median(relScores) : null,
      medianProb: probs.length ? median(probs) : null,
      medianLateral: median(dValues),
      madLateral: mad(dValues),
      medianTemporalDisagreement: tempDisag.length ? median(tempDisag) : null,
      observations: obs,
    });
  }
  bins.sort((a, b) => a.idx - b.idx);
  return bins;
}

/**
 * Compute the published boundary vertex for one bin under a candidate.
 * Returns null if the bin does not meet the support requirements.
 */
function binVertex(bin, candidate, opts) {
  const obs = bin.observations;
  if (obs.length < opts.minSupportObservations) return null;
  if (candidate === 'C' || candidate === 'D') {
    if (bin.distinctTimestamps < opts.minDistinctTimestamps) return null;
  }
  let d;
  let weights;
  if (candidate === 'A') {
    d = median(obs.map((o) => o.d));
    weights = obs.map(() => 1);
  } else if (candidate === 'B' || candidate === 'C' || candidate === 'D') {
    const relW = obs.map((o) => baseReliabilityWeight(o.reliability));
    if (candidate === 'D') {
      // Two-pass: first a reliability-weighted median, then MAD-scaled weights.
      const pass1 = weightedMedian(obs.map((o, i) => ({ value: o.d, weight: relW[i] })));
      const madV = mad(obs.map((o) => o.d));
      const weights2 = obs.map((o, i) => relW[i] * outlierResistanceWeight(o.d, madV, pass1, opts.madCutoff));
      d = weightedMedian(obs.map((o, i) => ({ value: o.d, weight: weights2[i] })));
      weights = weights2;
    } else {
      d = weightedMedian(obs.map((o, i) => ({ value: o.d, weight: relW[i] })));
      weights = relW;
    }
  } else {
    return null;
  }
  if (!Number.isFinite(d)) return null;
  // No extrapolation: the vertex along-track position is clamped to the actual
  // observation range of this bin (never beyond the last supported point).
  const minObsS = Math.min(...obs.map((o) => o.s));
  const maxObsS = Math.max(...obs.map((o) => o.s));
  const sCenter = Math.max(minObsS, Math.min(bin.sCenter, maxObsS));
  return {
    s: sCenter,
    d,
    s0: bin.s0,
    s1: bin.s1,
    supportCount: bin.supportCount,
    distinctTimestamps: bin.distinctTimestamps,
    medianReliability: bin.medianReliability,
    medianProb: bin.medianProb,
    madLateral: bin.madLateral,
    medianTemporalDisagreement: bin.medianTemporalDisagreement,
    laneIndices: bin.laneIndices,
    laneTrackIds: bin.laneTrackIds,
    newestLogMonoTime: bin.newestLogMonoTime,
    oldestLogMonoTime: bin.oldestLogMonoTime,
    weights,
  };
}

/**
 * Hard-threshold baseline (evaluation only): bin publishes only if the median
 * reliability >= threshold. Demonstrates precision/recall limitations.
 */
function hardThresholdVertex(bin, opts) {
  const obs = bin.observations;
  if (obs.length < opts.minSupportObservations) return null;
  const medRel = median(obs.map((o) => o.reliability?.combinedScore ?? 0));
  if (medRel == null || medRel < opts.hardThresholdScore) return null;
  const minObsS = Math.min(...obs.map((o) => o.s));
  const maxObsS = Math.max(...obs.map((o) => o.s));
  const sCenter = Math.max(minObsS, Math.min(bin.sCenter, maxObsS));
  return {
    s: sCenter,
    d: weightedMedian(obs.map((o) => ({ value: o.d, weight: baseReliabilityWeight(o.reliability) }))),
    s0: bin.s0,
    s1: bin.s1,
    supportCount: obs.length,
    distinctTimestamps: bin.distinctTimestamps,
    medianReliability: medRel,
    medianProb: bin.medianProb,
    madLateral: bin.madLateral,
    laneIndices: bin.laneIndices,
    laneTrackIds: bin.laneTrackIds,
    weights: obs.map(() => 1),
  };
}

/**
 * Assemble published vertices into boundary sections, splitting on:
 *   - unsupported gap (no vertex): explicit break
 *   - along-track gap > maxGapM
 *   - lateral jump > maxLateralJumpM
 *   - laneIndex change
 *   - laneTrackId change (identity not supported to continue)
 *   - bin not supporting publication
 * Sections with fewer than minBinsPerSection vertices are dropped (a single
 * high-reliability prediction cannot publish a long boundary by itself).
 */
function assembleSections(vertices, opts) {
  if (!vertices.length) return [];
  const sections = [];
  let cur = [vertices[0]];
  for (let i = 1; i < vertices.length; i++) {
    const prev = vertices[i - 1];
    const v = vertices[i];
    const gap = v.s - prev.s1;
    const lateralJump = Math.abs(v.d - prev.d);
    const laneChange = !sameSet(prev.laneIndices, v.laneIndices);
    const trackChange = !sameSet(prev.laneTrackIds, v.laneTrackIds);
    const breakCondition = v.s0 > prev.s1 + opts.maxGapM
      || gap > opts.maxGapM
      || lateralJump > opts.maxLateralJumpM
      || laneChange
      || trackChange;
    if (breakCondition) {
      if (cur.length >= opts.minBinsPerSection) sections.push(cur);
      cur = [v];
    } else {
      cur.push(v);
    }
  }
  if (cur.length >= opts.minBinsPerSection) sections.push(cur);
  return sections;
}

function sameSet(a, b) {
  if (!a?.length || !b?.length) return false;
  const sa = [...new Set(a)].sort().join(',');
  const sb = [...new Set(b)].sort().join(',');
  return sa === sb;
}

/**
 * Build the experimental boundary overlay for a set of point observations
 * (already restricted to the active chunk/pass/lane). Returns sections with
 * vertices in (s, d) plus topology info.
 */
function buildBoundariesForLane(points, candidate, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const bins = binObservations(points, o);
  let vertices;
  if (candidate === 'H') {
    vertices = bins.map((b) => hardThresholdVertex(b, o)).filter((v) => v != null);
  } else {
    vertices = bins.map((b) => binVertex(b, candidate, o)).filter((v) => v != null);
  }
  const sections = assembleSections(vertices, o);

  // Topology: direction must follow increasing s.
  for (const sec of sections) {
    let dirOk = true;
    for (let i = 1; i < sec.length; i++) {
      if (sec[i].s < sec[i - 1].s) { dirOk = false; break; }
    }
    sec.directionOk = dirOk;
    sec.directionWarning = dirOk ? null : 'direction decreases (increasing-s violated)';
  }

  return {
    candidate,
    binSizeM: o.binSizeM,
    minSupportObservations: o.minSupportObservations,
    minDistinctTimestamps: o.minDistinctTimestamps,
    minBinsPerSection: o.minBinsPerSection,
    maxGapM: o.maxGapM,
    maxLateralJumpM: o.maxLateralJumpM,
    totalBins: bins.length,
    publishedBins: vertices.length,
    unsupportedBins: bins.length - vertices.length,
    sections,
  };
}

/**
 * Convert boundary (s,d) vertices to segment-local east/north using an
 * s->local index built from the point observations (so the overlay lines up
 * exactly with the dots). Points are mapped s -> (localEast, localNorth).
 */
function buildSLocalIndex(points) {
  const pairs = points
    .filter((p) => Number.isFinite(p.s) && Number.isFinite(p.localEast) && Number.isFinite(p.localNorth))
    .map((p) => ({
      s: p.s,
      east: p.localEast,
      north: p.localNorth,
      mirroredEast: p.mirroredLocalEast != null ? p.mirroredLocalEast : p.mirroredEast,
      mirroredNorth: p.mirroredLocalNorth != null ? p.mirroredLocalNorth : p.mirroredNorth,
    }))
    .sort((a, b) => a.s - b.s);
  return pairs;
}

function sToLocal(pairs, s) {
  if (!pairs?.length) return null;
  if (s <= pairs[0].s) {
    return {
      east: pairs[0].east, north: pairs[0].north,
      mirroredEast: pairs[0].mirroredEast, mirroredNorth: pairs[0].mirroredNorth,
    };
  }
  if (s >= pairs[pairs.length - 1].s) {
    const last = pairs[pairs.length - 1];
    return {
      east: last.east, north: last.north,
      mirroredEast: last.mirroredEast, mirroredNorth: last.mirroredNorth,
    };
  }
  for (let i = 0; i + 1 < pairs.length; i++) {
    const a = pairs[i];
    const b = pairs[i + 1];
    if (s >= a.s && s <= b.s) {
      const span = b.s - a.s;
      const t = span > 1e-9 ? (s - a.s) / span : 0;
      const lerp = (x, y) => (x != null && y != null) ? x + t * (y - x) : (x != null ? x : y);
      return {
        east: a.east + t * (b.east - a.east),
        north: a.north + t * (b.north - a.north),
        mirroredEast: lerp(a.mirroredEast, b.mirroredEast),
        mirroredNorth: lerp(a.mirroredNorth, b.mirroredNorth),
      };
    }
  }
  const last = pairs[pairs.length - 1];
  return {
    east: last.east, north: last.north,
    mirroredEast: last.mirroredEast, mirroredNorth: last.mirroredNorth,
  };
}

/**
 * Build the complete experimental boundary overlay for a set of points (the
 * active chunk/pass, all lanes). Returns an object with per-lane sections in
 * segment-local coordinates plus topology summary.
 */
function buildExperimentalBoundaries(points, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const laneGroups = new Map();
  for (const p of points) {
    if (p.laneIndex == null) continue;
    if (!laneGroups.has(p.laneIndex)) laneGroups.set(p.laneIndex, []);
    laneGroups.get(p.laneIndex).push(p);
  }
  const sIndex = buildSLocalIndex(points);
  const lanes = {};
  const allSections = [];
  for (const [laneIndex, lanePoints] of laneGroups) {
    const built = buildBoundariesForLane(lanePoints, o.candidate, o);
    const localSections = built.sections.map((sec) => ({
      vertices: sec.map((v) => {
        const loc = sToLocal(sIndex, v.s);
        return {
          s: +v.s.toFixed(2),
          d: +v.d.toFixed(3),
          east: loc ? +loc.east.toFixed(4) : null,
          north: loc ? +loc.north.toFixed(4) : null,
          mirroredEast: loc && loc.mirroredEast != null ? +loc.mirroredEast.toFixed(4) : null,
          mirroredNorth: loc && loc.mirroredNorth != null ? +loc.mirroredNorth.toFixed(4) : null,
          supportCount: v.supportCount,
          distinctTimestamps: v.distinctTimestamps,
          medianReliability: v.medianReliability != null ? +v.medianReliability.toFixed(3) : null,
          medianProb: v.medianProb != null ? +v.medianProb.toFixed(3) : null,
          madLateral: v.madLateral != null ? +v.madLateral.toFixed(3) : null,
          s0: +v.s0.toFixed(2),
          s1: +v.s1.toFixed(2),
        };
      }),
      laneIndex,
      directionOk: sec.directionOk,
      directionWarning: sec.directionWarning ?? null,
      breakReasons: sec.breakReasons ?? [],
      sMin: +sec[0].s.toFixed(2),
      sMax: +sec[sec.length - 1].s.toFixed(2),
    }));
    lanes[laneIndex] = {
      candidate: built.candidate,
      totalBins: built.totalBins,
      publishedBins: built.publishedBins,
      unsupportedBins: built.unsupportedBins,
      sections: localSections,
    };
    allSections.push(...localSections);
  }

  const topology = runTopologyChecks(lanes, o);
  return {
    experimental: true,
    candidate: o.candidate,
    lanes,
    topology,
    sectionCount: allSections.length,
    supportedLengthM: +allSections.reduce((a, s) => a + (s.sMax - s.sMin), 0).toFixed(1),
  };
}

// --- topology checks -------------------------------------------------------

function runTopologyChecks(lanes, opts) {
  const warnings = [];
  const lane1 = lanes[1];
  const lane2 = lanes[2];
  // Expected sides: lane1 = right ego boundary (d < 0), lane2 = left (d > 0).
  // Verified sign consistency from the accepted audit.
  if (lane1) {
    for (const sec of lane1.sections) {
      const posSide = sec.vertices.filter((v) => v.d > 0).length;
      if (posSide > 0) warnings.push({ type: 'rightBoundaryOnWrongSide', laneIndex: 1, sMin: sec.sMin, sMax: sec.sMax, posD: posSide });
    }
  }
  if (lane2) {
    for (const sec of lane2.sections) {
      const negSide = sec.vertices.filter((v) => v.d < 0).length;
      if (negSide > 0) warnings.push({ type: 'leftBoundaryOnWrongSide', laneIndex: 2, sMin: sec.sMin, sMax: sec.sMax, negD: negSide });
    }
  }
  // Crossing detection between lane1 and lane2 within the same s range.
  if (lane1 && lane2) {
    for (const s1 of lane1.sections) {
      for (const s2 of lane2.sections) {
        const overlap = Math.min(s1.sMax, s2.sMax) - Math.max(s1.sMin, s2.sMin);
        if (overlap <= 0) continue;
        for (const v1 of s1.vertices) {
          for (const v2 of s2.vertices) {
            if (Math.abs(v1.s - v2.s) <= opts.binSizeM && v1.d >= v2.d) {
              warnings.push({ type: 'laneCrossing', lane1: 1, lane2: 2, s: v1.s, d1: +v1.d.toFixed(2), d2: +v2.d.toFixed(2) });
            }
          }
        }
      }
    }
  }
  // Width checks at overlapping s.
  if (lane1 && lane2) {
    for (const s1 of lane1.sections) {
      for (const s2 of lane2.sections) {
        const sMin = Math.max(s1.sMin, s2.sMin);
        const sMax = Math.min(s1.sMax, s2.sMax);
        if (sMax <= sMin) continue;
        for (const v1 of s1.vertices) {
          for (const v2 of s2.vertices) {
            if (Math.abs(v1.s - v2.s) <= opts.binSizeM) {
              const width = v2.d - v1.d;
              if (width < opts.minWidthM || width > opts.maxWidthM) {
                warnings.push({ type: 'implausibleWidth', s: +v1.s.toFixed(1), widthM: +width.toFixed(2) });
              }
            }
          }
        }
      }
    }
  }
  // Self-intersection within each section: detect decreasing d spans (abrupt).
  for (const laneIdx of [1, 2]) {
    const l = lanes[laneIdx];
    if (!l) continue;
    for (const sec of l.sections) {
      for (let i = 2; i < sec.vertices.length; i++) {
        const a = sec.vertices[i - 2];
        const b = sec.vertices[i - 1];
        const c = sec.vertices[i];
        const da = b.d - a.d;
        const db = c.d - b.d;
        if (da * db < 0 && Math.abs(da) + Math.abs(db) > opts.maxWidthChangeM * 2) {
          warnings.push({ type: 'selfIntersectionRisk', laneIndex: laneIdx, s: +b.s.toFixed(1), d: +b.d.toFixed(2) });
        }
      }
    }
  }
  return { warnings, count: warnings.length };
}


window.ExperimentalBoundaries = {
  DEFAULTS,
  median,
  quantile,
  mad,
  weightedMedian,
  baseReliabilityWeight,
  outlierResistanceWeight,
  binObservations,
  binVertex,
  hardThresholdVertex,
  assembleSections,
  buildBoundariesForLane,
  buildSLocalIndex,
  sToLocal,
  buildExperimentalBoundaries,
  runTopologyChecks,
};
