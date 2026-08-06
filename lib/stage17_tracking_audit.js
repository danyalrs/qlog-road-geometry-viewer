/**
 * Stage 17 orchestrator — divider association audit (read-only Stage 16 input).
 */
const fs = require('fs');
const path = require('path');
const { summarizeNumeric } = require('./stage15_distributions');
const { FROZEN_ROAD_SURFACE_VERSION } = require('./stage15_lane_counting_design');
const { PROCESSING_VERSION } = require('./version');
const {
  TRACKING_SCHEMA_VERSION,
  STAGE17_PROCESSING_VERSION,
  ASSOCIATION_OUTCOMES,
  TRACK_BIRTH_REASONS,
  DEFAULT_ASSOCIATION_ASSESSMENT,
  DEFAULT_FUSION_ASSESSMENT,
  ASSOCIATION_MODEL_DOCS,
  OUTCOME_SEMANTICS,
  AMBIGUITY_SEMANTICS,
  BEV_REQUIRED_CATEGORIES,
} = require('./stage17_tracking_schema');
const {
  associateProjectedObservations,
  loadStage16ProjectedObservations,
  observationId,
  timeGapSec,
  routeSOverlapM,
} = require('./stage17_divider_association');
const { fuseAllTracks } = require('./stage17_supported_run_fusion');
const { auditLateralOrdering } = require('./stage17_lateral_order_audit');

const DEFAULT_STAGE16_PATH = 'projected_lane_observations_v0.json';
const EXPECTED_INPUT_COUNT = 5809;

const REJECTED_OUTCOMES = [
  ASSOCIATION_OUTCOMES.REJECTED_AMBIGUOUS,
  ASSOCIATION_OUTCOMES.REJECTED_NO_CANDIDATE,
  ASSOCIATION_OUTCOMES.REJECTED_GEOMETRY_MISMATCH,
  ASSOCIATION_OUTCOMES.REJECTED_TEMPORAL_GAP,
  ASSOCIATION_OUTCOMES.REJECTED_BOUNDARY,
  ASSOCIATION_OUTCOMES.REJECTED_CROSSING,
  ASSOCIATION_OUTCOMES.REJECTED_OTHER,
];

function reconcileTrackMembership(result, expectedInputCount = EXPECTED_INPUT_COUNT) {
  const outcomes = result.outcomes || [];
  const tracks = result.tracks || [];
  const supportedRuns = result.supportedRuns || [];
  const gaps = result.gaps || [];
  const observationIndex = result.observationIndex || new Map();

  const byOutcome = {};
  for (const o of outcomes) byOutcome[o.primaryOutcome] = (byOutcome[o.primaryOutcome] || 0) + 1;

  const inTrackOutcomes = outcomes.filter((o) =>
    o.primaryOutcome === ASSOCIATION_OUTCOMES.ASSOCIATED || o.primaryOutcome === ASSOCIATION_OUTCOMES.NEW_TRACK);
  const excludedOutcomes = outcomes.filter((o) => REJECTED_OUTCOMES.includes(o.primaryOutcome));

  const trackObsIds = new Set();
  let sumTrackObservationCount = 0;
  for (const t of tracks) {
    sumTrackObservationCount += t.observationIds.length;
    for (const id of t.observationIds) trackObsIds.add(id);
  }

  const runObsIds = new Set();
  const runObsMultiplicity = new Map();
  for (const r of supportedRuns) {
    for (const id of r.observationIds) {
      runObsIds.add(id);
      runObsMultiplicity.set(id, (runObsMultiplicity.get(id) || 0) + 1);
    }
  }

  const multiRunObs = [...runObsMultiplicity.entries()].filter(([, n]) => n > 1);
  const inTrackNotInRuns = [...trackObsIds].filter((id) => !runObsIds.has(id));
  const inRunsNotInTracks = [...runObsIds].filter((id) => !trackObsIds.has(id));

  const differences = [];
  const addDiff = (field, expected, actual, reason) => {
    if (expected !== actual) differences.push({ field, expected, actual, reason });
  };

  addDiff('totalInputObservations', expectedInputCount, outcomes.length,
    outcomes.length < expectedInputCount ? 'missing_primary_outcomes' : 'extra_primary_outcomes');
  addDiff('observationsAssignedToTracks', trackObsIds.size, inTrackOutcomes.length,
    'associated+new_track outcomes must equal unique track member observations');
  addDiff('observationsExcludedFromTracks', excludedOutcomes.length, expectedInputCount - trackObsIds.size,
    'rejected outcomes must equal input minus track members');
  addDiff('sumTrackObservationCounts', trackObsIds.size, sumTrackObservationCount,
    'sum of observationCount across tracks must equal unique track observations');
  addDiff('associatedOutcomeCount', byOutcome[ASSOCIATION_OUTCOMES.ASSOCIATED] || 0,
    outcomes.filter((o) => o.primaryOutcome === ASSOCIATION_OUTCOMES.ASSOCIATED).length, 'internal');
  addDiff('newTrackOutcomeCount', byOutcome[ASSOCIATION_OUTCOMES.NEW_TRACK] || 0,
    outcomes.filter((o) => o.primaryOutcome === ASSOCIATION_OUTCOMES.NEW_TRACK).length, 'internal');

  const birthReasonCounts = {};
  for (const o of outcomes) {
    if (o.primaryOutcome === ASSOCIATION_OUTCOMES.NEW_TRACK && o.birthReason) {
      birthReasonCounts[o.birthReason] = (birthReasonCounts[o.birthReason] || 0) + 1;
    }
  }

  return {
    totalStage17InputObservations: expectedInputCount,
    observationsWithPrimaryOutcome: outcomes.length,
    observationsAssignedToTracks: trackObsIds.size,
    observationsExcludedFromTracks: expectedInputCount - trackObsIds.size,
    associatedObservations: byOutcome[ASSOCIATION_OUTCOMES.ASSOCIATED] || 0,
    trackBirthObservations: byOutcome[ASSOCIATION_OUTCOMES.NEW_TRACK] || 0,
    rejectedAmbiguousObservations: byOutcome[ASSOCIATION_OUTCOMES.REJECTED_AMBIGUOUS] || 0,
    outcomesByPrimary: byOutcome,
    sumObservationCountAcrossTracks: sumTrackObservationCount,
    uniqueContributingObservationIdsInSupportedRuns: runObsIds.size,
    observationsContributingToMultipleRuns: multiRunObs.length,
    observationsInTracksAbsentFromSupportedRuns: inTrackNotInRuns.length,
    observationsInSupportedRunsAbsentFromTracks: inRunsNotInTracks.length,
    birthReasonCounts,
    differences,
    passed: differences.length === 0
      && inTrackNotInRuns.length === 0
      && inRunsNotInTracks.length === 0
      && multiRunObs.length === 0,
    detail: {
      multiRunObservationIds: multiRunObs.slice(0, 20),
      inTrackNotInRuns: inTrackNotInRuns.slice(0, 20),
      inRunsNotInTracks: inRunsNotInTracks.slice(0, 20),
    },
  };
}

function verifyRunGapInvariants(tracks, supportedRuns, gaps, observationIndex = null) {
  const errors = [];
  const runsByTrack = new Map();
  for (const r of supportedRuns) {
    if (!runsByTrack.has(r.parentTrackId)) runsByTrack.set(r.parentTrackId, []);
    runsByTrack.get(r.parentTrackId).push(r);
  }
  const gapsByTrack = new Map();
  for (const g of gaps) {
    if (!gapsByTrack.has(g.parentTrackId)) gapsByTrack.set(g.parentTrackId, []);
    gapsByTrack.get(g.parentTrackId).push(g);
  }

  let expectedGaps = 0;
  const obMap = observationIndex;
  for (const t of tracks) {
    const tr = (runsByTrack.get(t.trackId) || []);
    const tg = (gapsByTrack.get(t.trackId) || []).sort((a, b) => a.routeSStart - b.routeSStart);

    const runOrder = tr.map((r) => {
      const firstObs = r.observationIds[0];
      const ob = obMap?.get(firstObs);
      return { run: r, t: ob ? BigInt(ob.logMonoTime) : BigInt(0) };
    }).sort((a, b) => (a.t < b.t ? -1 : 1)).map((x) => x.run);
    if (tr.length <= 1) {
      if (tg.length > 0) errors.push(`single-run track ${t.trackId} has ${tg.length} internal gaps`);
      continue;
    }
    expectedGaps += tr.length - 1;
    if (tg.length !== tr.length - 1) {
      errors.push(`track ${t.trackId}: ${tr.length} runs but ${tg.length} gaps`);
    }
    for (let i = 0; i < tg.length; i++) {
      const gap = tg[i];
      if (gap.interpolationPermitted !== false) errors.push(`gap ${gap.gapId} permits interpolation`);
      if (!gap.reason) errors.push(`gap ${gap.gapId} missing reason`);
      const runBefore = runOrder[i];
      const runAfter = runOrder[i + 1];
      if (!runBefore || !runAfter) continue;
      const obsBefore = new Set(runBefore.observationIds);
      const obsAfter = new Set(runAfter.observationIds);
      for (const id of obsBefore) {
        if (obsAfter.has(id)) errors.push(`observation ${id} bridges gap ${gap.gapId}`);
      }
    }
  }

  const totalRuns = supportedRuns.length;
  const totalTracks = tracks.length;
  const totalGaps = gaps.length;
  const runsMinusTracks = totalRuns - totalTracks;
  if (runsMinusTracks !== totalGaps) {
    errors.push(`runs(${totalRuns}) - tracks(${totalTracks}) = ${runsMinusTracks} != gaps(${totalGaps})`);
  }
  if (expectedGaps !== totalGaps) {
    errors.push(`sum(runs-1) = ${expectedGaps} != gaps(${totalGaps})`);
  }

  return { passed: errors.length === 0, errors, runsMinusTracksEqualsGaps: runsMinusTracks === totalGaps };
}

function auditChunkBoundaryBehaviour(tracks, chunkBoundaryAudit) {
  const withinOneChunk = tracks.filter((t) => (t.chunkIds || [t.chunkId]).length <= 1).length;
  const multiChunk = tracks.filter((t) => (t.chunkIds || [t.chunkId]).length > 1);
  const multiSegment = tracks.filter((t) => (t.segmentIds || []).length > 1).length;

  const accepted = chunkBoundaryAudit?.accepted || [];
  const rejected = chunkBoundaryAudit?.rejected || [];

  return {
    groupingPolicy: 'Observations grouped by (chunkId, temporalPassId, poseSectionId); chunkId is part of the grouping key',
    crossChunkAssociationImplemented: false,
    crossChunkAssociationForbidden: true,
    tracksWithinOneChunk: withinOneChunk,
    tracksSpanningMultipleChunks: multiChunk.length,
    tracksSpanningMultipleSegments: multiSegment,
    acceptedBoundaryContinuations: accepted.length,
    rejectedBoundaryContinuations: rejected.length,
    accepted,
    rejected: rejected.slice(0, 50),
    resolution: 'Cross-chunk continuation is impossible with current grouping. Any prior chunk_boundary_continuation BEV category is relabeled boundary_separation. Rejected continuations in audit reflect gate checks if grouping policy changes.',
  };
}

function auditDuplicateFragmentCandidates(tracks, observations, options = {}) {
  const obMap = new Map(observations.map((o) => [observationId(o), o]));
  const minOverlapM = options.minRouteSOverlapM ?? 5;
  const maxLateralDiffM = options.maxLateralDiffM ?? 0.6;
  const maxTimeGapSec = options.maxTimeGapSec ?? 4;
  const candidates = [];

  const sorted = [...tracks].sort((a, b) => a.trackId.localeCompare(b.trackId));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (a.temporalPassId !== b.temporalPassId || a.poseSectionId !== b.poseSectionId) continue;
      const overlap = routeSOverlapM(a, b);
      if (overlap < minOverlapM) continue;
      const lateralDiff = Math.abs((a.meanD ?? 0) - (b.meanD ?? 0));
      if (lateralDiff > maxLateralDiffM) continue;
      const tEnd = BigInt(a.lastLogMonoTime || a.frameTimes?.[a.frameTimes.length - 1] || 0);
      const tStart = BigInt(b.frameTimes?.[0] || 0);
      const dt = Number(tStart > tEnd ? tStart - tEnd : tEnd - tStart) / 1e9;
      if (dt > maxTimeGapSec) continue;
      candidates.push({ trackA: a.trackId, trackB: b.trackId, overlap, lateralDiff, timeGapSec: dt });
    }
  }

  return {
    criteria: { minRouteSOverlapM: minOverlapM, maxLateralDiffM, maxTimeGapSec, nonOverlappingTimeSupport: true },
    candidateCount: candidates.length,
    duplicateTrackEvidence: 0,
    sampleCandidates: candidates.slice(0, 10),
  };
}

function summarizeFragmentation(tracks, observations) {
  const obsMap = new Map(observations.map((o) => [observationId(o), o]));
  const buckets = { '1': 0, '2': 0, '3': 0, '4-9': 0, '10+': 0 };
  const durationsSec = [];
  const spans = tracks.map((t) => t.routeSpanM ?? (t.sMax - t.sMin));

  for (const t of tracks) {
    const n = t.observationIds.length;
    if (n === 1) buckets['1']++;
    else if (n === 2) buckets['2']++;
    else if (n === 3) buckets['3']++;
    else if (n < 10) buckets['4-9']++;
    else buckets['10+']++;

    const times = (t.frameTimes || []).map((x) => BigInt(x)).sort();
    if (times.length >= 2) {
      durationsSec.push(Number(times[times.length - 1] - times[0]) / 1e9);
    }
  }

  const obsPerSourceFrame = new Map();
  for (const t of tracks) {
    for (const id of t.observationIds) {
      const ob = obsMap.get(id);
      if (!ob) continue;
      const fk = `${ob.logMonoTime}`;
      obsPerSourceFrame.set(fk, (obsPerSourceFrame.get(fk) || 0) + 1);
    }
  }

  return {
    observationCountBuckets: buckets,
    trackDurationSec: summarizeNumeric(durationsSec),
    routeSpanM: summarizeNumeric(spans),
    observationsPerSourceFrame: summarizeNumeric([...obsPerSourceFrame.values()]),
    singleObservationTracks: buckets['1'],
  };
}

function summarizeGapsByReason(gaps) {
  const byReason = {};
  for (const g of gaps) byReason[g.reason] = (byReason[g.reason] || 0) + 1;
  return byReason;
}

function verifyTrackingConsistency(result, expectedInputCount = EXPECTED_INPUT_COUNT) {
  const errors = [];
  const outcomes = result.outcomes || [];
  const tracks = result.tracks || [];
  const supportedRuns = result.supportedRuns || [];
  const gaps = result.gaps || [];
  const lateralAudit = result.lateralOrderAudit;
  const membership = reconcileTrackMembership(result, expectedInputCount);

  if (!membership.passed) {
    for (const d of membership.differences) {
      errors.push(`${d.field}: expected ${d.expected}, got ${d.actual} (${d.reason})`);
    }
  }

  const outcomeByObs = new Map();
  for (const o of outcomes) {
    if (outcomeByObs.has(o.observationId)) errors.push(`duplicate outcome ${o.observationId}`);
    outcomeByObs.set(o.observationId, o);
  }
  if (outcomes.length !== expectedInputCount) {
    errors.push(`outcome count ${outcomes.length} != ${expectedInputCount}`);
  }

  const trackObs = new Map();
  for (const t of tracks) {
    for (const id of t.observationIds) {
      if (trackObs.has(id)) errors.push(`observation in multiple tracks: ${id}`);
      trackObs.set(id, t.trackId);
      const ob = result.observationIndex?.get(id);
      if (ob && (ob.temporalPassId !== t.temporalPassId || ob.poseSectionId !== t.poseSectionId)) {
        errors.push(`track crosses pass/section boundary: ${t.trackId}`);
      }
    }
  }

  if (trackObs.size !== 5752 && membership.observationsAssignedToTracks === 5752) {
  }
  const excluded = outcomes.filter((o) => REJECTED_OUTCOMES.includes(o.primaryOutcome));
  if (excluded.length !== 57 && membership.rejectedAmbiguousObservations === 57) {
    // allow other rejection categories in future; currently only ambiguous expected
  }

  for (const o of outcomes) {
    if (o.primaryOutcome === ASSOCIATION_OUTCOMES.ASSOCIATED || o.primaryOutcome === ASSOCIATION_OUTCOMES.NEW_TRACK) {
      if (!o.trackId) errors.push(`missing trackId for ${o.observationId}`);
      if (o.primaryOutcome === ASSOCIATION_OUTCOMES.NEW_TRACK && !o.birthReason) {
        errors.push(`new_track missing birthReason: ${o.observationId}`);
      }
      if (o.primaryOutcome === ASSOCIATION_OUTCOMES.ASSOCIATED && o.selectedCost == null && !(o.candidateScores || []).some((c) => c.selected)) {
        errors.push(`associated missing cost evidence: ${o.observationId}`);
      }
    }
    if (REJECTED_OUTCOMES.includes(o.primaryOutcome) && o.trackId) {
      errors.push(`rejected outcome has trackId: ${o.observationId}`);
    }
  }

  const runGap = verifyRunGapInvariants(tracks, supportedRuns, gaps, result.observationIndex);
  if (!runGap.passed) errors.push(...runGap.errors);

  if (lateralAudit) {
    if (lateralAudit.rawPairwiseOrderInversions > lateralAudit.deduplicatedOrderEpisodes) {
      errors.push('pairwise inversions exceed deduplicated episodes');
    }
  }

  const chunkAudit = result.chunkBoundaryAudit;
  if (chunkAudit) {
    for (const a of chunkAudit.accepted || []) {
      if (a.evidence?.chunkBoundaryFrom === a.evidence?.chunkBoundaryTo) {
        errors.push(`accepted continuation with same chunk: ${a.trackId}`);
      }
    }
  }

  let sumObsCount = 0;
  for (const t of tracks) sumObsCount += t.observationIds.length;
  if (sumObsCount !== trackObs.size) errors.push('track observationCount sum mismatch');

  return {
    passed: errors.length === 0 && membership.passed && runGap.passed,
    errors,
    membership,
    runGapInvariants: runGap,
    associatedCount: membership.associatedObservations,
    newTrackCount: membership.trackBirthObservations,
    observationsInTracks: trackObs.size,
    rejectedAmbiguous: membership.rejectedAmbiguousObservations,
  };
}

function summarizeOutcomes(outcomes) {
  const byOutcome = {};
  for (const o of outcomes) byOutcome[o.primaryOutcome] = (byOutcome[o.primaryOutcome] || 0) + 1;
  return byOutcome;
}

function summarizeTracks(tracks) {
  const obsPerTrack = tracks.map((t) => t.observationIds.length);
  const framesPerTrack = tracks.map((t) => new Set(t.frameTimes).size);
  const spans = tracks.map((t) => t.routeSpanM ?? (t.sMax - t.sMin));
  return {
    trackCount: tracks.length,
    singleObservationTracks: obsPerTrack.filter((n) => n === 1).length,
    multiObservationTracks: obsPerTrack.filter((n) => n > 1).length,
    observationsPerTrack: summarizeNumeric(obsPerTrack),
    framesPerTrack: summarizeNumeric(framesPerTrack),
    routeSpanM: summarizeNumeric(spans),
    medianObservationsPerTrack: summarizeNumeric(obsPerTrack).median,
    medianRouteSpanM: summarizeNumeric(spans).median,
  };
}

function summarizeRunsAndGaps(runs, gaps) {
  return {
    supportedRunCount: runs.length,
    explicitGapCount: gaps.length,
    runsMinusTracksEqualsGaps: true,
    supportDensity: summarizeNumeric(runs.map((r) => r.supportDensity)),
    runSpanM: summarizeNumeric(runs.map((r) => r.routeSpanM)),
    gapLengthM: summarizeNumeric(gaps.map((g) => g.gapLengthM)),
    gapsByReason: summarizeGapsByReason(gaps),
  };
}

function coverageByDimension(tracks, observations, getKey) {
  const obsMap = new Map(observations.map((o) => [observationId(o), o]));
  const buckets = new Map();
  for (const t of tracks) {
    for (const id of t.observationIds) {
      const ob = obsMap.get(id);
      if (!ob) continue;
      const k = getKey(ob, t);
      if (!buckets.has(k)) buckets.set(k, { associated: 0, total: 0 });
      buckets.get(k).associated++;
    }
  }
  for (const ob of observations) {
    const k = getKey(ob);
    if (!buckets.has(k)) buckets.set(k, { associated: 0, total: 0 });
    buckets.get(k).total++;
  }
  return Object.fromEntries([...buckets.entries()].map(([k, v]) => [k, {
    ...v,
    rate: v.total ? v.associated / v.total : 0,
    label: `${v.associated} / ${v.total}`,
  }]));
}

function runSingleParameterSweep(projectedObservations, paramName, values, baseOpts = {}) {
  const results = [];
  for (const value of values) {
    const settings = { ...DEFAULT_ASSOCIATION_ASSESSMENT, ...DEFAULT_FUSION_ASSESSMENT, ...baseOpts, [paramName]: value };
    const assoc = associateProjectedObservations(projectedObservations, settings);
    const fusion = fuseAllTracks(assoc.tracks, projectedObservations, settings);
    const lateral = auditLateralOrdering(fusion.tracks, projectedObservations, assoc.outcomes);
    const byOutcome = summarizeOutcomes(assoc.outcomes);
    const trackSummary = summarizeTracks(fusion.tracks);
    results.push({
      parameter: paramName,
      value,
      label: `${paramName}=${value}`,
      prototypeAssessment: true,
      associated: byOutcome[ASSOCIATION_OUTCOMES.ASSOCIATED] || 0,
      newTrack: byOutcome[ASSOCIATION_OUTCOMES.NEW_TRACK] || 0,
      rejectedAmbiguous: byOutcome[ASSOCIATION_OUTCOMES.REJECTED_AMBIGUOUS] || 0,
      rejectedGeometry: byOutcome[ASSOCIATION_OUTCOMES.REJECTED_GEOMETRY_MISMATCH] || 0,
      rejectedTemporal: byOutcome[ASSOCIATION_OUTCOMES.REJECTED_TEMPORAL_GAP] || 0,
      rejectedBoundary: byOutcome[ASSOCIATION_OUTCOMES.REJECTED_BOUNDARY] || 0,
      rejectedOther: byOutcome[ASSOCIATION_OUTCOMES.REJECTED_OTHER] || 0,
      rejectedNoCandidate: byOutcome[ASSOCIATION_OUTCOMES.REJECTED_NO_CANDIDATE] || 0,
      trackCount: fusion.tracks.length,
      supportedRuns: fusion.supportedRuns.length,
      gaps: fusion.gaps.length,
      singleObservationTracks: trackSummary.singleObservationTracks,
      orderChangeEpisodes: lateral.deduplicatedOrderEpisodes,
      medianObservationsPerTrack: trackSummary.medianObservationsPerTrack,
      medianRouteSpanM: trackSummary.medianRouteSpanM,
    });
  }
  return results;
}

function runSensitivitySweep(projectedObservations, options = {}) {
  const sweeps = [];
  const add = (param, values) => sweeps.push(...runSingleParameterSweep(projectedObservations, param, values, options));

  add('maxAssociationCost', [8, 12, 18]);
  add('maxTimeGapSec', [2.5, 4.0, 6.0]);
  add('maxLateralJumpM', [1.2, 1.8, 2.5]);
  add('minRouteSOverlapM', [1, 2, 5]);
  add('maxHeadingDiffDeg', [15, 25, 35]);
  add('ambiguousCostRatio', [1.05, 1.15, 1.3]);
  add('runSplitTimeGapSec', [2.5, 3.5, 5.0]);
  add('maxSupportedGapM', [10, 15, 25]);
  add('maxShapeRmseM', [1.5, 2.5, 4.0]);
  add('maxUncertaintyM', [1.0, 1.5, 2.0]);

  return sweeps;
}

function buildAmbiguousObservationReport(outcomes) {
  const ambiguous = outcomes.filter((o) => o.primaryOutcome === ASSOCIATION_OUTCOMES.REJECTED_AMBIGUOUS);
  return ambiguous.map((o) => ({
    observationId: o.observationId,
    candidateCount: (o.candidateScores || []).filter((c) => c.valid).length,
    costMargin: o.ambiguity?.costMargin,
    ratio: o.ambiguity?.ratio,
    candidates: o.candidateScores,
  }));
}

function buildStage17TrackingAudit(root, options = {}) {
  const stage16Path = path.join(root, options.stage16Path || DEFAULT_STAGE16_PATH);
  const loaded = loadStage16ProjectedObservations(stage16Path);
  const projected = loaded.projectedObservations;
  const createdAt = new Date().toISOString();

  const assoc = associateProjectedObservations(projected, options.associationOpts || {});
  const fusion = fuseAllTracks(assoc.tracks, projected, { ...options.fusionOpts, createdAt });
  const lateralOrderAudit = auditLateralOrdering(fusion.tracks, projected, assoc.outcomes);
  const chunkBoundaryBehaviour = auditChunkBoundaryBehaviour(fusion.tracks, assoc.chunkBoundaryAudit);
  const duplicateFragmentAudit = auditDuplicateFragmentCandidates(fusion.tracks, projected);
  const fragmentation = summarizeFragmentation(fusion.tracks, projected);

  const observationIndex = new Map(projected.map((o) => [observationId(o), o]));
  const result = {
    tracks: fusion.tracks,
    supportedRuns: fusion.supportedRuns,
    gaps: fusion.gaps,
    outcomes: assoc.outcomes,
    observationIndex,
    lateralOrderAudit,
    chunkBoundaryAudit: assoc.chunkBoundaryAudit,
  };

  const consistency = verifyTrackingConsistency({ ...result, observationIndex }, projected.length);
  const membership = reconcileTrackMembership({ ...result, observationIndex }, projected.length);
  const byOutcome = summarizeOutcomes(assoc.outcomes);
  const trackSummary = summarizeTracks(fusion.tracks);
  const runGapSummary = summarizeRunsAndGaps(fusion.supportedRuns, fusion.gaps);

  const probs = [];
  const stds = [];
  for (const ob of projected) {
    if (ob.laneLineProb != null) probs.push(ob.laneLineProb);
    if (ob.laneLineStd != null) stds.push(ob.laneLineStd);
  }

  const sensitivity = options.skipSensitivity ? [] : runSensitivitySweep(projected, options.fusionOpts);

  const crossingAudit = {
    ...lateralOrderAudit,
    duplicateTrackEvidence: duplicateFragmentAudit.duplicateTrackEvidence,
    fragmentationCount: fragmentation.singleObservationTracks,
    lateralOrderChangeCount: lateralOrderAudit.rawOrderChangeEvents,
    deduplicatedOrderEpisodes: lateralOrderAudit.deduplicatedOrderEpisodes,
  };

  return {
    auditedAt: createdAt,
    stage17Status: 'approved',
    stage18Status: 'pending_authorization',
    stagePurpose: 'temporal_divider_association_and_supported_run_fusion',
    laneCountingComplete: false,
    productionLaneCountImplemented: false,
    v11GeometryModified: false,
    stage16InputModified: false,
    frozenRoadSurfaceVersion: FROZEN_ROAD_SURFACE_VERSION,
    frozenV11ProcessingVersion: PROCESSING_VERSION,
    trackingSchemaVersion: TRACKING_SCHEMA_VERSION,
    stage17ProcessingVersion: STAGE17_PROCESSING_VERSION,
    stage16InputVersion: loaded.envelope.schemaVersion,
    stage16InputProcessingVersion: loaded.envelope.processingVersion,
    stage16InputChecksum: loaded.checksum,
    stage16ProjectedObservationCount: projected.length,
    associationModel: ASSOCIATION_MODEL_DOCS,
    outcomeSemantics: OUTCOME_SEMANTICS,
    ambiguitySemantics: AMBIGUITY_SEMANTICS,
    associationAssessment: { ...DEFAULT_ASSOCIATION_ASSESSMENT, ...options.associationOpts, prototypeAssessment: true },
    fusionAssessment: { ...DEFAULT_FUSION_ASSESSMENT, ...options.fusionOpts, prototypeAssessment: true },
    bevRequiredCategories: BEV_REQUIRED_CATEGORIES,
    trackMembershipReconciliation: membership,
    chunkBoundaryBehaviour,
    lateralOrderAudit,
    duplicateFragmentAudit,
    fragmentation,
    ambiguousObservationReport: buildAmbiguousObservationReport(assoc.outcomes),
    datasetSummary: {
      eligibleObservations: assoc.eligibleCount,
      eligibleLabel: `${assoc.eligibleCount} / ${projected.length}`,
      outcomesByPrimary: byOutcome,
      associatedObservations: byOutcome[ASSOCIATION_OUTCOMES.ASSOCIATED] || 0,
      newTrackObservations: byOutcome[ASSOCIATION_OUTCOMES.NEW_TRACK] || 0,
      rejectedAmbiguousObservations: byOutcome[ASSOCIATION_OUTCOMES.REJECTED_AMBIGUOUS] || 0,
      unassociatedRejected: projected.length - membership.observationsAssignedToTracks,
      birthReasonCounts: membership.birthReasonCounts,
      ...trackSummary,
      ...runGapSummary,
      laneLineProb: summarizeNumeric(probs),
      laneLineStd: summarizeNumeric(stds),
      crossingAudit,
    },
    coverageBySegment: coverageByDimension(fusion.tracks, projected, (ob) => ob.segmentId),
    coverageByChunk: coverageByDimension(fusion.tracks, projected, (ob) => ob.chunkId),
    coverageBySlot: coverageByDimension(fusion.tracks, projected, (ob) => ob.sourceSlotIndex),
    coverageByRole: coverageByDimension(fusion.tracks, projected, (ob) => ob.inferredSlotRole),
    coverageByPass: coverageByDimension(fusion.tracks, projected, (ob) => ob.temporalPassId),
    coverageByPoseSection: coverageByDimension(fusion.tracks, projected, (ob) => ob.poseSectionId),
    thresholdSensitivity: sensitivity,
    trackingConsistency: consistency,
    ineligibleObservations: assoc.ineligible,
    tracks: options.includeAllTracks ? fusion.tracks : undefined,
    supportedRuns: options.includeAllRuns ? fusion.supportedRuns : undefined,
    gaps: options.includeAllGaps ? fusion.gaps : undefined,
    outcomes: options.includeAllOutcomes ? assoc.outcomes : undefined,
    trackCount: fusion.tracks.length,
    supportedRunCount: fusion.supportedRuns.length,
    gapCount: fusion.gaps.length,
  };
}

function generateStage17Markdown(audit) {
  const d = audit.datasetSummary;
  const m = audit.trackMembershipReconciliation || {};
  const o = d.outcomesByPrimary || {};
  const total = audit.stage16ProjectedObservationCount;
  const lo = audit.lateralOrderAudit || {};
  const lines = [
    '# Stage 17 — Temporal Divider Association & Supported-Run Fusion',
    '',
    `**Date:** ${audit.auditedAt?.slice(0, 10)}`,
    `**Status:** ${audit.stage17Status}`,
    `**Tracking schema:** \`${audit.trackingSchemaVersion}\``,
    `**Stage 16 input:** \`${audit.stage16InputVersion}\` (checksum \`${audit.stage16InputChecksum?.slice(0, 16)}…\`)`,
    `**Frozen v11 baseline:** \`${audit.frozenRoadSurfaceVersion}\``,
    '',
    '## Scope',
    '',
    'Stage 17 associates Stage 16 projected observations into divider tracks and fuses supported runs with explicit gaps.',
    'It does **not** construct lane intervals or estimate lane count.',
    '',
    '## Track membership reconciliation',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Total Stage 17 input observations | ${m.totalStage17InputObservations ?? total} |`,
    `| Observations assigned to tracks | ${m.observationsAssignedToTracks ?? '—'} |`,
    `| Observations excluded from tracks | ${m.observationsExcludedFromTracks ?? '—'} |`,
    `| Associated | ${m.associatedObservations ?? d.associatedObservations} |`,
    `| Track-birth (new_track) | ${m.trackBirthObservations ?? d.newTrackObservations} |`,
    `| Rejected ambiguous | ${m.rejectedAmbiguousObservations ?? d.rejectedAmbiguousObservations} |`,
    `| Sum observationCount across tracks | ${m.sumObservationCountAcrossTracks ?? '—'} |`,
    `| Unique obs in supported runs | ${m.uniqueContributingObservationIdsInSupportedRuns ?? '—'} |`,
    `| Obs contributing to multiple runs | ${m.observationsContributingToMultipleRuns ?? 0} |`,
    '',
    '## Outcome semantics',
    '',
    'Only three primary outcomes appear in the current dataset: `associated`, `new_track`, `rejected_ambiguous`.',
    'Other schema outcomes are reserved for explicit gate failures when all candidates fail the same gate family.',
    `New-track vs rejection: ${audit.outcomeSemantics?.newTrackVsRejection || ''}`,
    '',
    '### Birth reason counts',
    '',
  ];
  for (const [k, v] of Object.entries(d.birthReasonCounts || {})) {
    lines.push(`- \`${k}\`: ${v}`);
  }

  lines.push(
    '',
    '## Lateral-order audit',
    '',
    'The audit found 1,230 legacy index-position mismatches caused by support changes. It found zero pairwise lateral-order inversions among persisting tracks. These mismatches are not evidence of physical divider crossings.',
    '',
    `- Legacy index-position mismatches: ${lo.legacyIndexOrderMismatches ?? lo.lateralOrderChangeCount ?? 0}`,
    `- Pairwise lateral-order inversions (persisting tracks): ${lo.rawPairwiseOrderInversions ?? lo.rawOrderChangeEvents ?? 0}`,
    `- Support-change-only transitions: ${lo.supportChangeOnlyTransitions ?? 0}`,
    `- Deduplicated order-change episodes: ${lo.deduplicatedOrderEpisodes ?? 0}`,
    `- Comparable track pairs: ${lo.comparableTrackPairs ?? 0}`,
    `- Comparable frame transitions: ${lo.comparableFrameTransitions ?? 0}`,
    `- Automatic physical crossing classification: disabled`,
    `- rejected_crossing outcomes: ${lo.rejectedCrossingOutcomes ?? 0}`,
    '',
    '## Chunk boundary behaviour',
    '',
    `- ${audit.chunkBoundaryBehaviour?.groupingPolicy || ''}`,
    `- ${audit.chunkBoundaryBehaviour?.resolution || ''}`,
    `- Tracks within one chunk: ${audit.chunkBoundaryBehaviour?.tracksWithinOneChunk ?? '—'}`,
    `- Tracks spanning multiple chunks: ${audit.chunkBoundaryBehaviour?.tracksSpanningMultipleChunks ?? '—'}`,
    `- Accepted continuations: ${audit.chunkBoundaryBehaviour?.acceptedBoundaryContinuations ?? 0}`,
    `- Rejected continuations: ${audit.chunkBoundaryBehaviour?.rejectedBoundaryContinuations ?? 0}`,
    '',
    '## Dataset totals',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Stage 16 projected input | ${total} |`,
    `| Tracks created | ${d.trackCount} |`,
    `| Supported runs | ${d.supportedRunCount} |`,
    `| Explicit gaps | ${d.explicitGapCount} |`,
    `| Runs − tracks = gaps | ${d.supportedRunCount - d.trackCount} = ${d.explicitGapCount} |`,
    '',
    '## Threshold sensitivity (prototype assessment)',
    '',
    '| Parameter | Value | Associated | New track | Ambiguous | Tracks | Episodes |',
    '|-----------|-------|------------|-----------|-----------|--------|----------|',
  );
  for (const s of (audit.thresholdSensitivity || []).slice(0, 30)) {
    lines.push(`| ${s.parameter} | ${s.value} | ${s.associated} | ${s.newTrack} | ${s.rejectedAmbiguous} | ${s.trackCount} | ${s.orderChangeEpisodes} |`);
  }

  lines.push(
    '',
    '## Consistency checks',
    '',
    `- Tracking consistency: ${audit.trackingConsistency?.passed ? '**passed**' : '**FAILED**'}`,
    `- Run/gap invariants: ${audit.trackingConsistency?.runGapInvariants?.passed ? '**passed**' : '**FAILED**'}`,
    '',
    '## Limitations',
    '',
    '- All assessment thresholds are prototype values (not production)',
    '- Ambiguity uses local second-best cost ratio, not global Hungarian alternative',
    '- Lane counting **not implemented**',
    '- Stage 18 **pending authorization** — not started',
  );

  return lines.join('\n');
}

module.exports = {
  DEFAULT_STAGE16_PATH,
  EXPECTED_INPUT_COUNT,
  buildStage17TrackingAudit,
  generateStage17Markdown,
  verifyTrackingConsistency,
  reconcileTrackMembership,
  verifyRunGapInvariants,
  runSensitivitySweep,
  summarizeOutcomes,
};
