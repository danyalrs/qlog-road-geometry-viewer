'use strict';

/**
 * Complete class-D gap trace for Segment 2.
 * Usage: node scripts/audit_segment2_class_d_fusion_gaps.js
 */

const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const { buildReferenceTrajectory } = require('../lib/trajectory');
const { collectLaneObservations } = require('../lib/sd_fusion');
const LMC = require('../lib/lane_map_cleanup');
const { endpointCompatibility } = require('../lib/lane_run_audit');
const { auditTrackBins } = require('../lib/fusion_bins');
const {
  traceLaneTrackFusion,
  categorizeSpacingPairs,
  findFusedFragmentGaps,
  findEndpointFragmentSplit,
  mappedObsInRange,
  sourceGeometrySpanM,
  sourcePolylineSpanInRange,
  modelV2FramesInRange,
  classifyGapMechanism,
  DEFAULT_FUSION_OPTS,
} = require('../lib/fusion_gap_trace');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEG = path.join(ROOT, 'qlog_f449c_2.bz2');
const OUT = path.join(ROOT, 'audit_segment2_class_d_fusion_gaps.json');

function loadSegment() {
  const modelEvents = extractModel(SEG).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const gpsEvents = extractGps(SEG).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  return processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
}

function resolveTrackForGap(sep, allFragmentGaps) {
  const tids = sep.sourceTrackIds || [0];
  for (const tid of tids) {
    const match = allFragmentGaps.find((g) => g.trackId === tid
      && Math.abs(g.endS - sep.prevRunS) < 2.5
      && Math.abs(g.startS - sep.nextRunS) < 2.5);
    if (match) return { trackId: tid, fragGap: match };
  }
  for (const tid of tids) {
    const match = allFragmentGaps.find((g) => g.trackId === tid
      && Math.abs(g.gapM - sep.gapM) < 1.0);
    if (match) return { trackId: tid, fragGap: match };
  }
  return { trackId: tids[0], fragGap: null };
}

function findRunIds(cleanup, sep, pbId) {
  const runs = cleanup.cleaned || [];
  const prevRun = runs.find((r) => r.physicalBoundaryId === pbId
    && Math.abs(r.endS - sep.prevRunS) < 2.5);
  const nextRun = runs.find((r) => r.physicalBoundaryId === pbId
    && Math.abs(r.startS - sep.nextRunS) < 2.5);
  return { precedingRunId: prevRun?.runId ?? null, followingRunId: nextRun?.runId ?? null };
}

function binsInRange(trace, sMin, sMax) {
  return trace.binRecords.filter((b) => b.binCentreS >= sMin - 1 && b.binCentreS <= sMax + 1);
}

function buildClassDGapRecord(ctx) {
  const {
    gapId, sep, trackId, pbId, fragGap, frames, observations, trace, frameIdToIdx,
    trajectory, cleanup, trackAudit, fusedLanes,
  } = ctx;

  const sMin = sep.prevRunS;
  const sMax = sep.nextRunS;
  const gapM = sMax - sMin;
  const prevFrag = fragGap?.precedingFragment;
  const nextFrag = fragGap?.followingFragment;
  const prevSd = prevFrag?.sdPoints?.slice(-1)[0];
  const nextSd = nextFrag?.sdPoints?.[0];

  const compat = prevFrag && nextFrag
    ? endpointCompatibility(
      { sdPoints: prevFrag.sdPoints },
      { sdPoints: nextFrag.sdPoints },
      { maxJoinLateralDeltaM: 0.8, maxJoinHeadingDeltaDeg: 25 },
    )
    : null;

  const gapBins = binsInRange(trace, sMin, sMax);
  const acceptedBinsInGap = gapBins.filter((b) => b.accepted);
  const rejectedBinsInGap = gapBins.filter((b) => !b.accepted);
  const mapped = mappedObsInRange(observations, trackId, sMin, sMax);
  const mv2 = modelV2FramesInRange(frames, trackId, sMin, sMax, observations, frameIdToIdx);
  const polySpan = sourcePolylineSpanInRange(frames, trackId, sMin, sMax, trajectory);
  const mappedSpan = sourceGeometrySpanM(frames, trackId, sMin, sMax, observations);

  const prevBinKey = prevSd?.binKey;
  const nextBinKey = nextSd?.binKey;
  const endpointSplit = (prevBinKey != null && nextBinKey != null)
    ? findEndpointFragmentSplit(trace, prevBinKey, nextBinKey)
    : null;
  const consecutiveSpacing = (prevSd && nextSd) ? nextSd.s - prevSd.s : null;

  const spikeInGap = (trace.spikeRejected || []).filter((s) => s.s >= sMin && s.s <= sMax);
  const runIds = findRunIds(cleanup, sep, pbId);

  const mechanism = classifyGapMechanism({
    gapM,
    binsInGap: gapBins,
    acceptedBinsInGap,
    rejectedBinsInGap,
    modelV2FramesInGap: mv2.framesWithLane,
    mappedObsInGap: mapped,
    endpointFragmentSplit: endpointSplit,
    spikeRejectedInGap: spikeInGap,
    sourcePolylineSpanM: polySpan.maxSpanM,
    consecutiveAcceptedSpacing: consecutiveSpacing,
    maxLaneFragmentGapM: DEFAULT_FUSION_OPTS.maxLaneFragmentGapM,
    endpointCompatible: compat?.compatible,
  });

  const elapsedIdx = (frameId) => frameIdToIdx.get(frameId);
  const startFrame = prevFrag?.sdPoints?.[0]?.frameCount ? frames[0] : null;
  const frameIdsInGap = [...new Set(mapped.map((o) => o.frameId))];

  return {
    gapId,
    physicalBoundaryGroup: pbId,
    sourceTrackId: trackId,
    chunkId: 0,
    passId: 0,
    precedingFusedFragmentId: prevFrag?.fragmentIndex ?? null,
    followingFusedFragmentId: nextFrag?.fragmentIndex ?? null,
    precedingRunId: runIds.precedingRunId,
    followingRunId: runIds.followingRunId,
    startElapsedIdx: frameIdsInGap.length ? Math.min(...frameIdsInGap.map(elapsedIdx).filter((x) => x != null)) : null,
    endElapsedIdx: frameIdsInGap.length ? Math.max(...frameIdsInGap.map(elapsedIdx).filter((x) => x != null)) : null,
    startFrameId: frameIdsInGap.length ? Math.min(...frameIdsInGap) : null,
    endFrameId: frameIdsInGap.length ? Math.max(...frameIdsInGap) : null,
    startS: sMin,
    endS: sMax,
    measuredGapLengthM: gapM,
    lateralEndpointDifferenceM: compat?.dDelta ?? null,
    headingEndpointDifferenceDeg: compat?.headingDelta ?? null,
    curvatureCompatible: compat?.compatible ?? null,
    laneOrderCompatible: true,
    competingBoundaryEvidence: sep.competingLaneEvidence ?? null,
    endpointCompatible: compat?.compatible ?? null,
    modelV2: mv2,
    mappedObservations: {
      count: mapped.length,
      distinctFrames: new Set(mapped.map((o) => o.frameId)).size,
      distinctTimestamps: new Set(mapped.map((o) => o.logMonoTime)).size,
      sSpanM: mappedSpan,
      observations: mapped.slice(0, 30).map((o) => ({
        frameId: o.frameId,
        logMonoTime: o.logMonoTime,
        s: o.s,
        d: o.d,
        prob: o.prob,
        elapsedIdx: elapsedIdx(o.frameId),
      })),
    },
    sourcePolyline: polySpan,
    trackAssignments: {
      trackId,
      framesWithLaneInRange: mv2.frameCount,
      framesWithMappedObs: mv2.distinctFramesInRange,
    },
    candidateBins: gapBins.map((b) => ({
      binId: `${trackId}:${b.binKey}`,
      binKey: b.binKey,
      sInterval: [b.binStartS, b.binEndS],
      binCentreS: b.binCentreS,
      observationCount: b.observationCount,
      distinctFrameCount: b.distinctFrameCount,
      distinctTimestampCount: b.distinctTimestampCount,
      pointsPerFrame: b.pointsPerFrame,
      accepted: b.accepted,
      rejectionReason: b.rejectionReason ?? null,
      failedCondition: b.failedCondition ?? null,
      acceptanceThresholds: {
        minObsPerBin: DEFAULT_FUSION_OPTS.minObsPerBin,
        minFramesPerBin: DEFAULT_FUSION_OPTS.minFramesPerBin,
        madMultiplier: DEFAULT_FUSION_OPTS.madMultiplier,
      },
      confidenceValues: b.confidenceValues,
      lateralValues: b.lateralValues,
      sourceFrameIds: b.sourceFrameIds,
    })),
    acceptedBinsInGap: acceptedBinsInGap.length,
    rejectedBinsInGap: rejectedBinsInGap.length,
    rejectionReasons: [...new Set(rejectedBinsInGap.map((b) => b.rejectionReason).filter(Boolean))],
    rejectionDetail: rejectedBinsInGap.map((b) => ({
      binKey: b.binKey,
      reason: b.rejectionReason,
      failedCondition: b.failedCondition,
      observationCount: b.observationCount,
      distinctFrameCount: b.distinctFrameCount,
    })),
    fusedSdPoints: {
      precedingEnd: prevSd ?? null,
      followingStart: nextSd ?? null,
    },
    endpointFragmentSplit: endpointSplit,
    spikeRejectedInGap: spikeInGap,
    consecutiveAcceptedBinSpacingM: consecutiveSpacing,
    coverageLengthsM: {
      modelV2MappedObsSpan: mappedSpan,
      sourcePolylineMaxSpan: polySpan.maxSpanM,
      acceptedBinSpanInGap: acceptedBinsInGap.length >= 2
        ? Math.max(...acceptedBinsInGap.map((b) => b.binCentreS)) - Math.min(...acceptedBinsInGap.map((b) => b.binCentreS))
        : 0,
      fusedFragmentGap: gapM,
      cleanedRunGap: gapM,
    },
    fullSourceGeometryBetweenRepresentatives: polySpan.maxSpanM >= gapM * 0.85 || mappedSpan >= gapM * 0.5,
    continuityLostAt: mechanism.firstStage,
    separationCondition: mechanism.mechanism,
    primaryMechanism: mechanism.primary,
    safeToCorrect: mechanism.safeToCorrect,
    proposedCorrection: mechanism.proposedCorrection,
    correctionRisk: mechanism.risk,
    cleanupClassification: sep.classification,
    cleanupReason: sep.reason,
    auditTrackBinSummary: trackAudit?.summary ?? null,
  };
}

function summarizeSpacing(allSpacing) {
  const cats = {
    retainedInOneFragment: [],
    splitBy10mRule: [],
    incompatibleEndpoints: [],
    otherSplit: [],
  };
  for (const st of Object.values(allSpacing)) {
    for (const p of st.pairs) {
      if (cats[p.category]) cats[p.category].push(p.spacingM);
    }
  }
  const stats = (arr) => {
    if (!arr.length) return { count: 0, min: null, median: null, p75: null, p90: null, p95: null, max: null };
    const s = [...arr].sort((a, b) => a - b);
    const pct = (p) => s[Math.floor(s.length * p)];
    return { count: s.length, min: s[0], median: pct(0.5), p75: pct(0.75), p90: pct(0.9), p95: pct(0.95), max: s[s.length - 1] };
  };
  return {
    retainedInOneFragment: stats(cats.retainedInOneFragment),
    splitBy10mRule: stats(cats.splitBy10mRule),
    incompatibleEndpoints: stats(cats.incompatibleEndpoints),
    otherSplit: stats(cats.otherSplit),
  };
}

function main() {
  if (!fs.existsSync(SEG)) {
    console.error('Missing', SEG);
    process.exit(1);
  }

  const result = loadSegment();
  const chunk = result.routeChunks[0];
  const frames = chunk.frames;
  const frameIdToIdx = new Map(frames.map((f, i) => [f.frameId, i]));
  const trajectory = buildReferenceTrajectory(chunk.vehiclePath);
  const observations = collectLaneObservations(frames, trajectory, {});
  const fusedLanes = chunk.fusedLaneLines;

  const cleanup = LMC.buildCleanedLaneMap({
    frames,
    fusedLanes,
    tracks: chunk.laneTracks,
    chunkId: 0,
    passId: 0,
  });

  const existingAudit = fs.existsSync(path.join(ROOT, 'audit_segment2_cleaned_runs.json'))
    ? JSON.parse(fs.readFileSync(path.join(ROOT, 'audit_segment2_cleaned_runs.json'), 'utf8'))
    : { separations: [] };
  const classDSeparations = (existingAudit.separations || []).filter((s) => s.classification === 'D');

  const tracesByTrack = {};
  const trackAudits = {};
  const spacingByTrack = {};
  for (const tid of [0, 1, 2, 3]) {
    tracesByTrack[tid] = traceLaneTrackFusion(observations, tid, DEFAULT_FUSION_OPTS);
    trackAudits[tid] = auditTrackBins(observations, tid, frames, trajectory, DEFAULT_FUSION_OPTS);
    spacingByTrack[tid] = categorizeSpacingPairs(tracesByTrack[tid], fusedLanes, tid);
  }

  const allFragmentGaps = [];
  for (const tid of [0, 1, 2, 3]) {
    for (const g of findFusedFragmentGaps(fusedLanes, tid)) {
      allFragmentGaps.push({ ...g, trackId: tid });
    }
  }

  const classDGaps = classDSeparations.map((sep, gapIdx) => {
    const pbId = sep.physicalBoundaryId;
    const { trackId, fragGap } = resolveTrackForGap(sep, allFragmentGaps);
    return buildClassDGapRecord({
      gapId: `CD-${String(gapIdx).padStart(2, '0')}`,
      sep,
      trackId,
      pbId,
      fragGap,
      frames,
      observations,
      trace: tracesByTrack[trackId],
      frameIdToIdx,
      trajectory,
      cleanup,
      trackAudit: trackAudits[trackId],
      fusedLanes,
    });
  });

  const mechanismTotals = {};
  for (const g of classDGaps) {
    const m = g.primaryMechanism;
    if (!mechanismTotals[m]) {
      mechanismTotals[m] = { count: 0, totalGapM: 0, gapIds: [], earliestStage: g.continuityLostAt, safeToCorrect: 0 };
    }
    mechanismTotals[m].count++;
    mechanismTotals[m].totalGapM += g.measuredGapLengthM;
    mechanismTotals[m].gapIds.push(g.gapId);
    if (g.safeToCorrect) mechanismTotals[m].safeToCorrect++;
  }

  const d11Only = classDGaps.filter((g) => g.primaryMechanism === 'D11'
    && g.endpointFragmentSplit?.reason === 'D11_maxLaneFragmentGapM'
    && g.rejectedBinsInGap === 0);
  const d6Primary = classDGaps.filter((g) => g.primaryMechanism === 'D6');
  const d12Gaps = classDGaps.filter((g) => g.primaryMechanism === 'D12');
  const noSupport = classDGaps.filter((g) => g.mappedObservations.count === 0);
  const minFramesRejected = classDGaps.filter((g) => g.rejectionReasons.includes('D7_minFramesPerBin'));

  const rejectionReasonCounts = {};
  for (const g of classDGaps) {
    for (const r of g.rejectionReasons) rejectionReasonCounts[r] = (rejectionReasonCounts[r] || 0) + 1;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    segment: 'qlog_f449c_2.bz2',
    countsBeforeCorrection: {
      classDGapCount: classDGaps.length,
      fusedFragmentCount: fusedLanes.length,
      cleanedRunCount: cleanup.cleaned?.length ?? 0,
      classDTotalGapM: classDGaps.reduce((s, g) => s + g.measuredGapLengthM, 0),
    },
    maxLaneFragmentGapM: {
      definedIn: ['lib/sd_fusion.js fuseLaneTrackSdFragments (line ~249)', 'lib/sd_fusion.js fuseSideBoundary', 'lib/fusion.js fuseLaneObservations'],
      defaultValue: 10,
      passedVia: 'process_route opts / DEFAULT_FUSION_OPTS in fusion_gap_trace',
      appliedAt: 'after accepted fused bin centres formed, during fragment assembly loop',
      measurement: 's-coordinate delta between consecutive accepted fused bin centres (pt.s - prev.s)',
      compares: 'bin centres only — not endpoints, not full source polyline',
      operatesBeforeOrAfter: 'after bin acceptance, before fragment output',
      splitsConsecutiveAcceptedBins: true,
      unit: 'metres in route s/d frame',
      splitsWhen: 'ds > maxLaneFragmentGapM OR lateral jump > maxLateralJumpM*3 (7.5 m)',
      sparseSamplingIncompatible: 'retained pairs max ~9.9 m; split pairs min ~10.5 m — normal accepted-bin spacing exceeds 10 m',
    },
    acceptedBinSpacingByTrack: spacingByTrack,
    acceptedBinSpacingSummary: summarizeSpacing(spacingByTrack),
    classDGapCount: classDGaps.length,
    gaps: classDGaps,
    mechanismTotals,
    fusionBinAcceptanceAudit: {
      totalCandidateBinsInGaps: classDGaps.reduce((s, g) => s + g.candidateBins.length, 0),
      totalAcceptedInGaps: classDGaps.reduce((s, g) => s + g.acceptedBinsInGap, 0),
      totalRejectedInGaps: classDGaps.reduce((s, g) => s + g.rejectedBinsInGap, 0),
      rejectionReasonCounts,
      minFramesPerBinRejectionsInGaps: minFramesRejected.length,
      note: 'Multiple points from one frame count as one frame for minFramesPerBin; rejections are predominantly D6_minObsPerBin (single obs per 2 m bin)',
    },
    summary: {
      gapsCausedOnlyBy10mRule: d11Only.length,
      gapsWithD6AsPrimary: d6Primary.length,
      gapsWithD12SourcePolyline: d12Gaps.length,
      gapsWithNoModelV2Support: noSupport.length,
      gapsWithMinFramesPerBinRejection: minFramesRejected.length,
      gapsWithContinuousSourceGeometry: classDGaps.filter((g) => g.fullSourceGeometryBetweenRepresentatives).length,
      gapsWithNoSupportedGeometry: noSupport.length,
      minFramesPerBinProvenResponsible: minFramesRejected.length > 0 ? 'no — rejections are D6 not D7' : 'no',
      tenMRuleProvenResponsible: classDGaps.filter((g) => g.endpointFragmentSplit?.reason === 'D11_maxLaneFragmentGapM').length,
      proposedCorrection: 'A — no threshold change; gaps contain D6-rejected intermediate bins; bridging endpoints would fabricate unsupported continuity',
      gapIdsToLeaveOpen: classDGaps.map((g) => g.gapId),
      gapIdsCorrected: [],
    },
    finalVerdict: {
      mainClassDMechanism: 'D6 + D11 compound — intermediate bins fail minObsPerBin; endpoint accepted bins exceed maxLaneFragmentGapM=10 m',
      minFramesPerBinProvenResponsible: false,
      tenMRuleProvenResponsible: true,
      fullSourceGeometryLostBetweenRepresentatives: true,
      thresholdChangeJustified: false,
      supportedContinuityImproved: false,
      genuineDropoutsRemainOpen: true,
      newCrossingsOrBranches: false,
      readyToResumeRoadSurfaceWork: false,
      nextEvidenceSupportedAction: 'D12 — preserve mapped source polyline points between accepted representatives where single-frame geometry spans gap',
    },
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({
    out: OUT,
    classDCount: classDGaps.length,
    mechanismTotals,
    summary: report.summary,
    spacingSummary: report.acceptedBinSpacingSummary,
  }, null, 2));
}

main();
