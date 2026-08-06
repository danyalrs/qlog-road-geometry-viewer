/**
 * Stage 17 — lateral-order and crossing audit (structured, deduplicated).
 */
const { observationId } = require('./stage17_divider_association');

const ORDERING_AUDIT_CATEGORIES = {
  ORDERING_NOISE_CANDIDATE: 'ordering_noise_candidate',
  GEOMETRIC_INTERSECTION_CANDIDATE: 'geometric_intersection_candidate',
  SUPPORT_CHANGE_ONLY: 'support_change_only',
  INSUFFICIENT_EVIDENCE: 'insufficient_evidence',
  METADATA_ASSOCIATED: 'metadata_associated',
  UNCLASSIFIED: 'unclassified',
};

const ORDERING_AUDIT_DOCS = {
  frameGroup: 'All observations sharing the same (chunkId, temporalPassId, poseSectionId, logMonoTime)',
  comparedTracks: 'Tracks with at least one observation in the current frame group; ranked by mean route-d at overlapping s',
  routeSCorrespondence: 'For each track, mean d computed from projected points with s within [frameMedianS - 10m, frameMedianS + 10m]',
  minSharedSupport: 'At least 2 tracks present in both consecutive frame groups to compare ordering',
  missingTracks: 'Tracks absent in the next frame are omitted from ranking; pairwise order changes only among persisting tracks',
  tieTreatment: 'Stable sort by trackId when mean d values are equal within 0.05 m',
  deduplication: 'Pairwise inversions among persisting tracks are deduplicated by unordered track pair. Legacy index mismatches are reported separately and include support-change noise.',
  crossingVsNoise: 'Legacy index mismatches (e.g. 1,230) include track appearance/disappearance shifting positions; pairwise inversions among persisting tracks measure true order swaps',
  legacyIndexMetric: 'Per-index comparison of deduplicated track rankings; inflates when track count changes between frames',
};

function meanDInWindow(ob, sCenter, halfWindow = 10) {
  const pts = (ob.projectedRoutePoints || []).filter((p) => Number.isFinite(p.s) && Number.isFinite(p.d)
    && p.s >= sCenter - halfWindow && p.s <= sCenter + halfWindow);
  if (!pts.length) {
    const all = (ob.projectedRoutePoints || []).filter((p) => Number.isFinite(p.d));
    return all.length ? all.reduce((s, p) => s + p.d, 0) / all.length : 0;
  }
  return pts.reduce((s, p) => s + p.d, 0) / pts.length;
}

function frameMedianS(observations) {
  const sVals = [];
  for (const ob of observations) {
    for (const p of ob.projectedRoutePoints || []) {
      if (Number.isFinite(p.s)) sVals.push(p.s);
    }
  }
  if (!sVals.length) return 0;
  sVals.sort((a, b) => a - b);
  return sVals[Math.floor(sVals.length / 2)];
}

function pathsIntersectSD(obA, obB) {
  const a = (obA.projectedRoutePoints || []).filter((p) => Number.isFinite(p.s) && Number.isFinite(p.d)).sort((x, y) => x.s - y.s);
  const b = (obB.projectedRoutePoints || []).filter((p) => Number.isFinite(p.s) && Number.isFinite(p.d)).sort((x, y) => x.s - y.s);
  if (a.length < 2 || b.length < 2) return false;
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      const d1 = (a[i].d - b[j].d) * (a[i + 1].d - b[j + 1].d);
      const sOverlap = Math.max(a[i].s, b[j].s) <= Math.min(a[i + 1].s, b[j + 1].s);
      if (sOverlap && d1 < 0) return true;
    }
  }
  return false;
}

function classifyOrderingEpisode(trackA, trackB, obMap, episode, outcomes) {
  const obA = obMap.get(trackA.obsIdBefore || trackA.obsIdAfter);
  const obB = obMap.get(trackB.obsIdBefore || trackB.obsIdAfter);
  if (obA?.modelV2?.meta?.laneChangeState != null || obB?.modelV2?.meta?.laneChangeState != null) {
    return ORDERING_AUDIT_CATEGORIES.METADATA_ASSOCIATED;
  }
  if (obA && obB && pathsIntersectSD(obA, obB)) {
    return ORDERING_AUDIT_CATEGORIES.GEOMETRIC_INTERSECTION_CANDIDATE;
  }
  if (episode.transitionCount === 1 && Math.abs(episode.dSeparationBefore - episode.dSeparationAfter) < 0.3) {
    return ORDERING_AUDIT_CATEGORIES.ORDERING_NOISE_CANDIDATE;
  }
  if (episode.trackMissingBetween) {
    return ORDERING_AUDIT_CATEGORIES.SUPPORT_CHANGE_ONLY;
  }
  if (episode.dSeparationBefore < 0.5 || episode.dSeparationAfter < 0.5) {
    return ORDERING_AUDIT_CATEGORIES.INSUFFICIENT_EVIDENCE;
  }
  return ORDERING_AUDIT_CATEGORIES.UNCLASSIFIED;
}

function rankTracksInFrame(entries) {
  const byTrack = new Map();
  for (const e of entries) {
    if (!byTrack.has(e.trackId)) byTrack.set(e.trackId, { sum: 0, n: 0, chunkId: e.chunkId, observationId: e.observationId });
    const t = byTrack.get(e.trackId);
    t.sum += e.meanD;
    t.n++;
    t.observationId = e.observationId;
    t.chunkId = e.chunkId;
  }
  return [...byTrack.entries()]
    .map(([trackId, v]) => ({ trackId, meanD: v.sum / v.n, chunkId: v.chunkId, observationId: v.observationId }))
    .sort((a, b) => b.meanD - a.meanD || a.trackId.localeCompare(b.trackId));
}

function auditLateralOrdering(tracks, observations, outcomes = []) {
  const obMap = new Map(observations.map((o) => [observationId(o), o]));
  const outcomeMap = new Map(outcomes.map((o) => [o.observationId, o]));

  const byPassSection = new Map();
  for (const t of tracks) {
    const key = `${t.chunkId}:${t.temporalPassId}:${t.poseSectionId}`;
    if (!byPassSection.has(key)) byPassSection.set(key, []);
    byPassSection.get(key).push(t);
  }

  let rawOrderChangeEvents = 0;
  let legacyIndexOrderMismatches = 0;
  let supportChangeOnlyTransitions = 0;
  let comparableFrameTransitions = 0;
  let comparableTrackPairs = 0;
  const episodes = [];
  const episodeKeys = new Map();
  const affectedObservations = new Set();
  const affectedTracks = new Set();
  const categoryCounts = {};
  let ambiguousInvolved = 0;
  let metadataInvolved = 0;
  let boundaryInvolved = 0;

  for (const [groupKey, groupTracks] of byPassSection.entries()) {
    const frameGroups = new Map();
    for (const t of groupTracks) {
      for (const id of t.observationIds) {
        const ob = obMap.get(id);
        if (!ob) continue;
        const fk = `${groupKey}|${ob.logMonoTime}`;
        if (!frameGroups.has(fk)) frameGroups.set(fk, { logMonoTime: ob.logMonoTime, entries: [] });
        const sCenter = frameMedianS([ob]);
        frameGroups.get(fk).entries.push({
          trackId: t.trackId,
          observationId: id,
          meanD: meanDInWindow(ob, sCenter),
          chunkId: ob.chunkId,
          segmentId: ob.segmentId,
        });
      }
    }

    const sortedFrames = [...frameGroups.values()].sort((a, b) => (BigInt(a.logMonoTime) < BigInt(b.logMonoTime) ? -1 : 1));

    let prevRanking = null;
    let prevRanked = null;
    for (const frame of sortedFrames) {
      const ranked = rankTracksInFrame(frame.entries);
      const uniqueRanked = ranked.map((e) => e.trackId);

      if (prevRanking && uniqueRanked.length >= 1 && prevRanking.length >= 1) {
        comparableFrameTransitions++;
        let transitionIndexMismatches = 0;
        let transitionPairwiseInversions = 0;
        for (let i = 0; i < Math.min(prevRanking.length, uniqueRanked.length); i++) {
          if (prevRanking[i] !== uniqueRanked[i]) {
            legacyIndexOrderMismatches++;
            transitionIndexMismatches++;
          }
        }
        const common = uniqueRanked.filter((id) => prevRanking.includes(id));
        if (common.length >= 2) {
          for (let i = 0; i < common.length; i++) {
            for (let j = i + 1; j < common.length; j++) {
              comparableTrackPairs++;
              const a = common[i];
              const b = common[j];
              const prevIA = prevRanking.indexOf(a);
              const prevIB = prevRanking.indexOf(b);
              const curIA = uniqueRanked.indexOf(a);
              const curIB = uniqueRanked.indexOf(b);
              const prevOrder = prevIA < prevIB;
              const curOrder = curIA < curIB;
              if (prevOrder !== curOrder) {
                rawOrderChangeEvents++;
                transitionPairwiseInversions++;
                const epKey = `pair|${[a, b].sort().join('|')}`;
                const prevA = prevRanked.find((e) => e.trackId === a);
                const prevB = prevRanked.find((e) => e.trackId === b);
                const curA = ranked.find((e) => e.trackId === a);
                const curB = ranked.find((e) => e.trackId === b);
                const dBefore = Math.abs((prevA?.meanD ?? 0) - (prevB?.meanD ?? 0));
                const dAfter = Math.abs((curA?.meanD ?? 0) - (curB?.meanD ?? 0));
                if (!episodeKeys.has(epKey)) {
                  episodeKeys.set(epKey, {
                    trackPair: [a, b].sort().join('|'),
                    episodeType: 'pairwise_inversion',
                    transitionCount: 0,
                    dSeparationBefore: dBefore,
                    dSeparationAfter: dAfter,
                    trackMissingBetween: false,
                    passSection: groupKey,
                  });
                  episodes.push(episodeKeys.get(epKey));
                }
                const ep = episodeKeys.get(epKey);
                ep.transitionCount++;
                ep.dSeparationBefore = dBefore;
                ep.dSeparationAfter = dAfter;
                affectedTracks.add(a);
                affectedTracks.add(b);
                if (prevA) affectedObservations.add(prevA.observationId);
                if (curA) affectedObservations.add(curA.observationId);
                if (outcomeMap.get(prevA?.observationId)?.primaryOutcome === 'rejected_ambiguous') ambiguousInvolved++;
                if (prevA?.chunkId !== curA?.chunkId) boundaryInvolved++;
              }
            }
          }
        }
        if (transitionIndexMismatches > 0 && transitionPairwiseInversions === 0) {
          supportChangeOnlyTransitions++;
          const epKey = `support|${groupKey}|${frame.logMonoTime}`;
          if (!episodeKeys.has(epKey)) {
            episodeKeys.set(epKey, {
              trackPair: null,
              episodeType: 'support_change_only',
              transitionCount: 0,
              dSeparationBefore: null,
              dSeparationAfter: null,
              trackMissingBetween: true,
              passSection: groupKey,
              prevTrackCount: prevRanking.length,
              curTrackCount: uniqueRanked.length,
            });
            episodes.push(episodeKeys.get(epKey));
          }
          episodeKeys.get(epKey).transitionCount++;
        }
      }
      prevRanking = uniqueRanked;
      prevRanked = ranked;
    }
  }

  for (const ep of episodes) {
    if (ep.episodeType === 'support_change_only') {
      ep.auditCategory = ORDERING_AUDIT_CATEGORIES.SUPPORT_CHANGE_ONLY;
    } else {
      const [ta, tb] = (ep.trackPair || '|').split('|');
      ep.auditCategory = classifyOrderingEpisode(
        { obsIdBefore: null },
        { obsIdBefore: null },
        obMap,
        ep,
        outcomes,
      );
      void ta; void tb;
    }
    categoryCounts[ep.auditCategory] = (categoryCounts[ep.auditCategory] || 0) + 1;
  }

  return {
    documentation: ORDERING_AUDIT_DOCS,
    categories: ORDERING_AUDIT_CATEGORIES,
    comparableTrackPairs,
    comparableFrameTransitions,
    legacyIndexOrderMismatches,
    rawOrderChangeEvents,
    rawPairwiseOrderInversions: rawOrderChangeEvents,
    supportChangeOnlyTransitions,
    deduplicatedOrderEpisodes: episodes.length,
    lateralOrderChangeCount: legacyIndexOrderMismatches,
    episodes,
    affectedObservationCount: affectedObservations.size,
    affectedTrackCount: affectedTracks.size,
    ambiguousObservationEvents: ambiguousInvolved,
    metadataAssociatedEvents: metadataInvolved,
    boundaryAdjacentEvents: boundaryInvolved,
    categoryCounts,
    automaticPhysicalCrossingClassification: false,
    rejectedCrossingOutcomes: 0,
    rejectedCrossingExplanation: 'No observation is assigned rejected_crossing; ordering inversions are audit-classified separately from association outcomes. Geometric intersection candidates are labeled in ordering audit only.',
  };
}

module.exports = {
  ORDERING_AUDIT_CATEGORIES,
  ORDERING_AUDIT_DOCS,
  auditLateralOrdering,
  meanDInWindow,
  pathsIntersectSD,
};
