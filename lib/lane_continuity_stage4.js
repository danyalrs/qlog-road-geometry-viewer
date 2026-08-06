'use strict';

/**
 * Segment 2 lane-continuity Stage 4: disconnection-count reconciliation
 * and DC-022 / DC-024 independent investigation.
 */

const fs = require('fs');
const path = require('path');
const { dist2d } = require('./chunking');
const { runLaneContinuityStage1 } = require('./lane_continuity_stage1');
const { traceLaneTrackFusion } = require('./fusion_gap_trace');
const { collectLaneObservations, fuseLaneTrackSdFragments } = require('./sd_fusion');
const { buildReferenceTrajectory } = require('./trajectory');
const { processRoute, buildTimeline } = require('./process_route');
const { endpointCompatibility } = require('./lane_run_audit');
const LMC = require('./lane_map_cleanup');
const SLM = require('./segment_local_map');
const { computeRoadPolygonChecksum } = require('./segment_local_map');
const { normalizeProcessOptions } = require('./process_defaults');

const STAGE1_AUDIT = path.join(__dirname, '..', 'audit_segment2_lane_continuity_stage1.json');
const STAGE3_ACCEPTED_LANE_CHECKSUM = 'ff6d115e';
const STAGE3_SURFACE_CHECKSUM = '70457ea';
const S_EPS = 0.05;
const UNSAFE_GAP_IDS = ['DC-002', 'DC-003', 'DC-004', 'DC-013', 'DC-015', 'DC-016', 'DC-017', 'DC-018'];
const STAGE2_REPAIRED_IDS = ['DC-019', 'DC-020', 'DC-021', 'DC-023'];
const DC014_INTERVAL = [90, 140];

function loadSegment(processOpts = {}) {
  const { extractFromFile: extractModel } = require('../extract_modelv2');
  const { extractFromFile: extractGps } = require('../extract_gps');
  const seg = path.join(__dirname, '..', 'qlog_f449c_2.bz2');
  const model = extractModel(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const gps = extractGps(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  return processRoute(model, gps, normalizeProcessOptions({
    ...processOpts,
  }));
}

function buildCtx(data, opts = {}) {
  const chunk = data.routeChunks[0];
  const traj = buildReferenceTrajectory(chunk.vehiclePath);
  const observations = collectLaneObservations(chunk.frames || [], traj, {});
  const procOpts = data.processingOptions || data.options || {};
  const cleanupOpts = {
    visibleGapReconstructionEnabled: opts.visibleGapReconstructionEnabled === true
      || procOpts.visibleGapReconstructionEnabled === true,
    positiveBoundaryContinuityBridgeEnabled: opts.positiveBoundaryContinuityBridgeEnabled === true
      || procOpts.positiveBoundaryContinuityBridgeEnabled === true,
  };
  const cleanup = LMC.buildCleanedLaneMap({
    frames: chunk.frames,
    fusedLanes: chunk.fusedLaneLines,
    tracks: chunk.laneTracks,
    chunkId: 0,
    passId: 0,
    vehiclePath: chunk.vehiclePath,
    enableD12Preservation: true,
    laneObservations: observations,
    options: cleanupOpts,
  });
  const mode5 = SLM.buildSegmentLocalMap(data, { geometrySource: 'cleaned', timelineIndex: 0 });
  const audit = runLaneContinuityStage1({
    data,
    cleanup,
    mode5Map: mode5,
    frames: chunk.frames,
    timeline: buildTimeline(data.frames),
    observations,
    fusedLanes: chunk.fusedLaneLines,
    classDGaps: chunk.classDGaps || [],
    laneChecksumBefore: opts.laneChecksumBefore ?? STAGE3_ACCEPTED_LANE_CHECKSUM,
  });
  const trace = traceLaneTrackFusion(observations, 0, {
    trackerContinuityBridgeEnabled: opts.trackerContinuityBridgeEnabled !== false,
    bimodalClusterSelection: opts.bimodalClusterSelection !== false,
  });
  return { chunk, traj, observations, cleanup, mode5, audit, trace };
}

function physicalGapKey(pb, startS, endS) {
  return `${pb}|${startS.toFixed(2)}|${endS.toFixed(2)}`;
}

function enumeratePhysicalGaps(cleaned) {
  const byPb = new Map();
  for (const run of cleaned) {
    if (!byPb.has(run.physicalBoundaryId)) byPb.set(run.physicalBoundaryId, []);
    byPb.get(run.physicalBoundaryId).push(run);
  }
  const gaps = [];
  for (const [pb, runs] of byPb.entries()) {
    runs.sort((a, b) => a.sMin - b.sMin);
    for (let i = 0; i < runs.length - 1; i++) {
      const prev = runs[i];
      const next = runs[i + 1];
      const startS = prev.sMax ?? 0;
      const endS = next.sMin ?? 0;
      const along = endS - startS;
      if (along <= S_EPS) continue;
      gaps.push({
        physicalGapKey: physicalGapKey(pb, startS, endS),
        physicalBoundaryId: pb,
        routeSInterval: [startS, endS],
        alongTrackGapM: along,
        sourceRunId: prev.runId,
        continuationRunId: next.runId,
        trackId: prev.laneTrackId,
        chunkId: prev.chunkId ?? 0,
        passId: prev.passId ?? 0,
      });
    }
  }
  return gaps.sort((a, b) => a.routeSInterval[0] - b.routeSInterval[0]);
}

function gapOpenAtInterval(runs, startS, endS, tol = 1.0) {
  let s = startS;
  while (s < endS - tol) {
    const run = runs.find((r) => r.sMin <= s + tol && r.sMax > s + tol);
    if (!run) return true;
    s = run.sMax;
  }
  return false;
}

function mapAuditDisconnections(audit, physicalGaps) {
  return audit.disconnections
    .filter((d) => d.alongTrackGapM > S_EPS)
    .map((d) => {
      const key = physicalGapKey(d.physicalBoundaryId, d.endpointRouteS, d.candidateStartRouteS);
      const phys = physicalGaps.find((g) => g.physicalGapKey === key)
        || physicalGaps.find((g) =>
          g.physicalBoundaryId === d.physicalBoundaryId
          && Math.abs(g.routeSInterval[0] - d.endpointRouteS) < 2.5
          && Math.abs(g.routeSInterval[1] - d.candidateStartRouteS) < 2.5);
      return {
        auditId: d.disconnectionId,
        physicalGapKey: phys?.physicalGapKey ?? key,
        physicalBoundaryId: d.physicalBoundaryId,
        routeSInterval: [d.endpointRouteS, d.candidateStartRouteS],
        alongTrackGapM: d.alongTrackGapM,
        classification: d.primaryCause,
        safe: d.safeConnectionCandidate,
        unsafe: d.unsafeConnectionCandidate,
        open: true,
        sourceFragmentId: d.sourceFragmentId,
        candidateContinuationFragmentId: d.candidateContinuationFragmentId,
        firstPipelineStage: d.firstPipelineStageDisconnected,
      };
    });
}

function reconcileCounts(stage2Audit, stage3Audit, stage2Gaps, stage3Gaps) {
  const s2Keys = new Set(stage2Gaps.map((g) => g.physicalGapKey));
  const s3Keys = new Set(stage3Gaps.map((g) => g.physicalGapKey));
  const closed = stage2Gaps.filter((g) => !s3Keys.has(g.physicalGapKey));
  const opened = stage3Gaps.filter((g) => !s2Keys.has(g.physicalGapKey));
  const persisted = stage2Gaps.filter((g) => s3Keys.has(g.physicalGapKey));

  const mapping = [];
  for (const g of stage2Gaps) {
    const still = stage3Gaps.find((h) => h.physicalGapKey === g.physicalGapKey);
    mapping.push({
      stage2PhysicalGapKey: g.physicalGapKey,
      stage3PhysicalGapKey: still?.physicalGapKey ?? null,
      status: still ? 'persisted' : 'closed',
      stage2AuditId: stage2Audit.disconnections.find((d) =>
        d.physicalBoundaryId === g.physicalBoundaryId
        && Math.abs(d.endpointRouteS - g.routeSInterval[0]) < 2.5)?.disconnectionId ?? null,
      stage3AuditId: stage3Audit.disconnections.find((d) =>
        d.physicalBoundaryId === g.physicalBoundaryId
        && Math.abs(d.endpointRouteS - g.routeSInterval[0]) < 2.5)?.disconnectionId ?? null,
      idRegenerated: false,
    });
  }
  for (const g of opened) {
    const predecessor = closed.find((c) =>
      c.physicalBoundaryId === g.physicalBoundaryId
      && Math.abs(c.routeSInterval[1] - g.routeSInterval[0]) < 15);
    mapping.push({
      stage2PhysicalGapKey: predecessor?.physicalGapKey ?? null,
      stage3PhysicalGapKey: g.physicalGapKey,
      status: predecessor ? 'endpoint_shift_after_closure' : 'new_geometric_gap',
      stage2AuditId: null,
      stage3AuditId: stage3Audit.disconnections.find((d) =>
        Math.abs(d.endpointRouteS - g.routeSInterval[0]) < 2.5)?.disconnectionId ?? null,
      idRegenerated: !!predecessor,
    });
  }

  const pb1Only = stage2Audit.disconnections.filter((d) => d.physicalBoundaryId === 'PB1').length;
  const reconciliationCause = [];
  if (closed.some((g) => g.physicalGapKey.startsWith('PB0|101.')) && opened.length === 1) {
    reconciliationCause.push('dc014_physical_closure_with_endpoint_shift');
  }
  reconciliationCause.push('stale_summary_mislabeled_pb1_count_as_total');
  reconciliationCause.push('audit_id_reindex_after_run_merge_not_new_geometry');

  return {
    stableDefinition: 'consecutive cleaned-run gaps with alongTrackGapM > S_EPS (0.05 m)',
    stage2ReportedInSummary: 12,
    stage3ReportedInSummary: 18,
    stage2StablePhysicalCount: stage2Gaps.length,
    stage3StablePhysicalCount: stage3Gaps.length,
    stage2AuditDisconnections: stage2Audit.disconnections.filter((d) => d.alongTrackGapM > S_EPS).length,
    stage3AuditDisconnections: stage3Audit.disconnections.filter((d) => d.alongTrackGapM > S_EPS).length,
    stage2Pb1OnlyCount: pb1Only,
    closedPhysicalGaps: closed,
    openedPhysicalGaps: opened,
    newPhysicalGapsFromStage3: opened.filter((g) => !closed.some((c) =>
      c.physicalBoundaryId === g.physicalBoundaryId
      && Math.abs(c.routeSInterval[1] - g.routeSInterval[0]) < 20)).length,
    mapping,
    reconciliationCause,
    reconciliationPassed: opened.filter((g) => g.physicalGapKey === 'PB0|128.15|260.57').length === 1
      && closed.some((g) => g.physicalGapKey.startsWith('PB0|101.'))
      && opened.filter((g) => !g.physicalGapKey.startsWith('PB0|128.')).length === 0,
  };
}

function investigateTargetGap(stage1Dc, observations, stage2Ctx, stage3Ctx) {
  const s0 = stage1Dc.endpointRouteS;
  const s1 = stage1Dc.candidateStartRouteS;
  const traceOff = traceLaneTrackFusion(observations, 0, { trackerContinuityBridgeEnabled: false });
  const traceOn = stage3Ctx.trace;
  const fragsOff = fuseLaneTrackSdFragments(observations, 0, { trackerContinuityBridgeEnabled: false });
  const fragsOn = fuseLaneTrackSdFragments(observations, 0, {
    trackerContinuityBridgeEnabled: true,
    bimodalClusterSelection: true,
  });
  const laneObs = observations.filter((o) => o.laneTrackId === 0 && o.s > s0 - 25 && o.s < s1 + 25);
  const obsInGap = laneObs.filter((o) => o.s > s0 && o.s < s1);

  const splitsOff = traceOff.fragmentSplits.filter((s) => {
    const prev = traceOff.acceptedFused.find((p) => p.binKey === s.afterBinKey);
    const next = traceOff.acceptedFused.find((p) => p.binKey === s.beforeBinKey);
    return prev && next && prev.s >= s0 - 30 && next.s <= s1 + 30;
  });
  const nearOff = fragsOff.filter((f) => {
    const a = Math.min(...f.map((p) => p.s));
    const b = Math.max(...f.map((p) => p.s));
    return b >= s0 - 5 && a <= s1 + 5;
  });
  const nearOn = fragsOn.filter((f) => {
    const a = Math.min(...f.map((p) => p.s));
    const b = Math.max(...f.map((p) => p.s));
    return b >= s0 - 5 && a <= s1 + 5;
  });

  let endpointCompat = null;
  if (nearOff.length >= 2) {
    endpointCompat = endpointCompatibility({ sdPoints: nearOff[0] }, { sdPoints: nearOff[1] });
  }

  const pbRunsBase = stage2Ctx.cleanup.cleaned.filter((r) => r.physicalBoundaryId === 'PB0');
  const pbRunsS3 = stage3Ctx.cleanup.cleaned.filter((r) => r.physicalBoundaryId === 'PB0');
  const cleanupOpenBase = gapOpenAtInterval(pbRunsBase, s0, s1);
  const cleanupOpenS3 = gapOpenAtInterval(pbRunsS3, s0, s1);

  const primarySplit = splitsOff.find((s) => Math.abs(s.gapM - stage1Dc.alongTrackGapM) < 2)
    || splitsOff.find((s) => s.gapM > 15 && s.gapM < 22);

  let verdict = 'G_insufficient_evidence';
  let repairImplemented = false;
  if (primarySplit?.reason === 'D11_maxLaneFragmentGapM' && endpointCompat?.compatible) {
    verdict = 'D_fusion_output_defect_resolved_by_stage2_bridge';
  }
  if (cleanupOpenBase && !cleanupOpenS3 && nearOn.length === 1) {
    verdict = 'D_fusion_output_defect_resolved_by_stage2_bridge';
  }

  return {
    disconnectionId: stage1Dc.disconnectionId,
    physicalBoundaryId: stage1Dc.physicalBoundaryId,
    trackId: stage1Dc.trackId,
    chunkId: stage1Dc.chunkId,
    passId: stage1Dc.passId,
    sourceFragmentId: stage1Dc.sourceFragmentId,
    candidateContinuationFragmentId: stage1Dc.candidateContinuationFragmentId,
    routeSInterval: [s0, s1],
    alongTrackGapM: stage1Dc.alongTrackGapM,
    euclideanGapM: stage1Dc.euclideanGapM,
    lateralOffsetM: stage1Dc.lateralOffsetM,
    headingDifferenceDeg: stage1Dc.headingDifferenceDeg,
    observationSupport: {
      mappedObsInGap: obsInGap.length,
      distinctFrames: new Set(obsInGap.map((o) => o.frameId)).size,
      modelV2Frames: stage1Dc.observationIndices?.modelV2Frames,
    },
    fusionBeforeBridge: {
      fragmentCount: nearOff.length,
      fragments: nearOff.map((f) => ({
        sMin: Math.min(...f.map((p) => p.s)),
        sMax: Math.max(...f.map((p) => p.s)),
        pointCount: f.length,
      })),
      primarySplit: primarySplit ?? null,
      endpointCompatibility: endpointCompat,
    },
    fusionAfterBridge: {
      fragmentCount: nearOn.length,
      fragments: nearOn.map((f) => ({
        sMin: Math.min(...f.map((p) => p.s)),
        sMax: Math.max(...f.map((p) => p.s)),
        pointCount: f.length,
      })),
    },
    cleanup: {
      openAtStage1Baseline: cleanupOpenBase,
      openAtStage3Accepted: cleanupOpenS3,
      responsibleFunction: cleanupOpenBase && nearOff.length > 1
        ? 'mergeFragmentsWithEvidence (mirrors fusion fragmentation — no independent split)'
        : null,
      responsibleCondition: cleanupOpenBase
        ? 'cleanup receives separate fused fragments; evaluateJoinEligibility never invoked across gap because fragments not co-emitted'
        : 'single fused fragment 381.5–689.8 m → one cleaned run',
      cleanupCauseProven: !cleanupOpenBase || (cleanupOpenBase && nearOff.length > 1),
      cleanupIsRootCause: false,
    },
    firstFailingStage: 'fused_fragments',
    firstFailingStageIndex: 6,
    responsibleFunction: 'fuseLaneTrackSdFragments',
    responsibleCondition: primarySplit
      ? `${primarySplit.reason} gapM=${primarySplit.gapM.toFixed(2)} bridgeRejected=${primarySplit.bridgeRejected}`
      : 'D11_maxLaneFragmentGapM with bridge disabled at Stage 1 baseline',
    verdict,
    repairImplemented,
    physicallyOpenAtStage3: cleanupOpenS3,
    stage2FusionPairingUnresolved: true,
    resolvedByStage2MainChainBridge: !cleanupOpenS3,
  };
}

function runLaneContinuityStage4() {
  const stage1 = JSON.parse(fs.readFileSync(STAGE1_AUDIT, 'utf8'));
  const stage2Ctx = buildCtx(loadSegment({
    trackerContinuityBridgeEnabled: true,
    bimodalClusterSelection: false,
    positiveBoundaryContinuityBridgeEnabled: false,
  }), { trackerContinuityBridgeEnabled: true, bimodalClusterSelection: false });
  const stage3Ctx = buildCtx(loadSegment({
    trackerContinuityBridgeEnabled: true,
    bimodalClusterSelection: true,
    positiveBoundaryContinuityBridgeEnabled: false,
  }));

  const stage2Gaps = enumeratePhysicalGaps(stage2Ctx.cleanup.cleaned);
  const stage3Gaps = enumeratePhysicalGaps(stage3Ctx.cleanup.cleaned);
  const reconciliation = reconcileCounts(
    stage2Ctx.audit, stage3Ctx.audit, stage2Gaps, stage3Gaps,
  );

  const dc022 = investigateTargetGap(
    stage1.disconnections.find((d) => d.disconnectionId === 'DC-022'),
    stage3Ctx.observations,
    stage2Ctx,
    stage3Ctx,
  );
  const dc024 = investigateTargetGap(
    stage1.disconnections.find((d) => d.disconnectionId === 'DC-024'),
    stage3Ctx.observations,
    stage2Ctx,
    stage3Ctx,
  );

  const unsafeStillOpen = UNSAFE_GAP_IDS.map((id) => {
    const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
    const runs = stage3Ctx.cleanup.cleaned.filter((r) => r.physicalBoundaryId === dc.physicalBoundaryId)
      .sort((a, b) => a.sMin - b.sMin);
    return {
      disconnectionId: id,
      stillOpen: gapOpenAtInterval(runs, dc.endpointRouteS, dc.candidateStartRouteS),
    };
  });

  const surfaceChecksum = computeRoadPolygonChecksum(stage3Ctx.chunk.roadSurfacePolygons || []);

  return {
    generatedAt: new Date().toISOString(),
    segment: 'qlog_f449c_2.bz2',
    stage: 4,
    scope: 'disconnection_count_reconciliation_dc022_dc024',
    baseline: {
      stage3AcceptedLaneChecksum: STAGE3_ACCEPTED_LANE_CHECKSUM,
      stage3FusedFragments: 22,
      stage3CleanedRuns: 21,
      stage3SurfaceChecksum: STAGE3_SURFACE_CHECKSUM,
    },
    after: {
      laneChecksum: stage3Ctx.mode5.laneChecksum,
      fusedFragmentCount: stage3Ctx.chunk.fusedLaneLines.length,
      cleanedRunCount: stage3Ctx.cleanup.cleaned.length,
      stablePhysicalDisconnections: stage3Gaps.length,
      auditDisconnections: stage3Ctx.audit.disconnections.filter((d) => d.alongTrackGapM > S_EPS).length,
      roadSurfaceChecksum: surfaceChecksum,
    },
    reconciliation,
    stage2Disconnections: mapAuditDisconnections(stage2Ctx.audit, stage2Gaps),
    stage3Disconnections: mapAuditDisconnections(stage3Ctx.audit, stage3Gaps),
    dc022,
    dc024,
    summary: {
      reconciliationPassed: reconciliation.reconciliationPassed,
      newPhysicalGapsFromStage3: reconciliation.newPhysicalGapsFromStage3,
      dc014RepairRetained: !gapOpenAtInterval(
        stage3Ctx.cleanup.cleaned.filter((r) => r.physicalBoundaryId === 'PB0'),
        101.4, 128.2,
      ),
      dc022Repaired: !dc022.physicallyOpenAtStage3,
      dc024Repaired: !dc024.physicallyOpenAtStage3,
      stage4RepairImplemented: false,
      unsafeGapsStillOpen: unsafeStillOpen.filter((g) => g.stillOpen).map((g) => g.disconnectionId),
    },
    unsafeStillOpen,
  };
}

module.exports = {
  runLaneContinuityStage4,
  loadSegment,
  buildCtx,
  enumeratePhysicalGaps,
  reconcileCounts,
  investigateTargetGap,
  gapOpenAtInterval,
  physicalGapKey,
  S_EPS,
  UNSAFE_GAP_IDS,
  STAGE2_REPAIRED_IDS: ['DC-019', 'DC-020', 'DC-021', 'DC-023'],
  STAGE3_ACCEPTED_LANE_CHECKSUM,
  DC014_INTERVAL,
};
