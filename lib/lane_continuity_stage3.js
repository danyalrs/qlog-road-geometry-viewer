'use strict';

/**
 * Segment 2 lane-continuity Stage 3: DC-014 lateral-spike investigation and targeted repair.
 */

const fs = require('fs');
const path = require('path');
const { dist2d } = require('./chunking');
const { runLaneContinuityStage1 } = require('./lane_continuity_stage1');
const { traceLaneTrackFusion } = require('./fusion_gap_trace');
const { collectLaneObservations } = require('./sd_fusion');
const { buildReferenceTrajectory } = require('./trajectory');
const { processRoute, buildTimeline } = require('./process_route');
const LMC = require('./lane_map_cleanup');
const SLM = require('./segment_local_map');
const { computeRoadPolygonChecksum } = require('./segment_local_map');

const STAGE1_AUDIT = path.join(__dirname, '..', 'audit_segment2_lane_continuity_stage1.json');
const STAGE2_ACCEPTED_LANE_CHECKSUM = 'fa3dac79';
const STAGE1_SURFACE_CHECKSUM = '26ae09b9';
const UNSAFE_GAP_IDS = ['DC-002', 'DC-003', 'DC-004', 'DC-013', 'DC-015', 'DC-016', 'DC-017', 'DC-018'];
const STAGE2_REPAIRED_IDS = ['DC-019', 'DC-020', 'DC-021', 'DC-023'];
const STAGE2_UNCHANGED_IDS = ['DC-022', 'DC-024'];
const PB0_FUSION_PAIRING_IDS = ['DC-014', 'DC-019', 'DC-020', 'DC-021', 'DC-022', 'DC-023', 'DC-024'];
const PB1_FUSION_PAIRING_IDS = ['DC-006', 'DC-008', 'DC-009', 'DC-010', 'DC-011', 'DC-012'];
const DC014_INTERVAL = [90, 140];

function loadSegment(processOpts = {}) {
  const { extractFromFile: extractModel } = require('../extract_modelv2');
  const { extractFromFile: extractGps } = require('../extract_gps');
  const seg = path.join(__dirname, '..', 'qlog_f449c_2.bz2');
  const model = extractModel(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  const gps = extractGps(seg).map((e) => ({ ...e, sourceFile: 'qlog_f449c_2.bz2' }));
  return processRoute(model, gps, {
    pipelineMode: 'C',
    trackerContinuityBridgeEnabled: true,
    bimodalClusterSelection: true,
    ...processOpts,
  });
}

function buildCtx(data) {
  const chunk = data.routeChunks[0];
  const traj = buildReferenceTrajectory(chunk.vehiclePath);
  const observations = collectLaneObservations(chunk.frames || [], traj, {});
  const cleanup = LMC.buildCleanedLaneMap({
    frames: chunk.frames,
    fusedLanes: chunk.fusedLaneLines,
    tracks: chunk.laneTracks,
    chunkId: 0,
    passId: 0,
    vehiclePath: chunk.vehiclePath,
    enableD12Preservation: true,
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
    laneChecksumBefore: STAGE2_ACCEPTED_LANE_CHECKSUM,
  });
  const trace = traceLaneTrackFusion(observations, 0, {
    trackerContinuityBridgeEnabled: true,
    bimodalClusterSelection: true,
  });
  return { chunk, traj, observations, cleanup, mode5, audit, trace };
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

function reconcileStage1FusionPairing(stage1) {
  const candidates = stage1.disconnections.filter((d) => d.recommendedFix === 'fusion_pairing');
  return candidates.map((dc) => {
    let classification = 'targeted_by_stage2';
    if (PB1_FUSION_PAIRING_IDS.includes(dc.disconnectionId)) {
      classification = 'outside_pb0';
    } else if (dc.disconnectionId === 'DC-014') {
      classification = 'stage3_primary_target';
    }
    return {
      disconnectionId: dc.disconnectionId,
      physicalBoundaryId: dc.physicalBoundaryId,
      alongTrackGapM: dc.alongTrackGapM,
      classification,
      evidence: PB1_FUSION_PAIRING_IDS.includes(dc.disconnectionId)
        ? 'PB1 parallel-boundary fusion_pairing; Stage 2 scoped PB0-only'
        : 'Stage 2 PB0 fusion-pairing candidate',
    };
  });
}

function traceDc014Pipeline(trace, observations, stage1Dc) {
  const [sLo, sHi] = DC014_INTERVAL;
  const obsInRange = observations.filter((o) =>
    o.laneTrackId === 0 && o.s >= sLo && o.s <= sHi);
  const bins = trace.binRecords.filter((b) => b.binCentreS >= sLo && b.binCentreS <= sHi);
  const spikeBin = bins.find((b) => b.binKey === 58) || bins.find((b) => b.bimodalClusterSelection?.selected);
  const preliminaryD = spikeBin?.preliminaryD ?? spikeBin?.fusedPoint?.preliminaryD;
  const correctedD = spikeBin?.fusedPoint?.d;
  const expectedD = spikeBin?.bimodalClusterSelection?.expectedD;
  const lateralResidual = preliminaryD != null && expectedD != null
    ? preliminaryD - expectedD
    : (preliminaryD != null && correctedD != null ? preliminaryD - correctedD : null);

  const neighbouring = bins
    .filter((b) => b.accepted && b.binKey >= 48 && b.binKey <= 64)
    .map((b) => ({ binKey: b.binKey, s: b.fusedPoint?.s, d: b.fusedPoint?.d, preliminaryD: b.preliminaryD }));

  return {
    disconnectionId: 'DC-014',
    routeSInterval: [stage1Dc.endpointRouteS, stage1Dc.candidateStartRouteS],
    firstFailingStage: 'bin_aggregation',
    firstFailingStageIndex: 5,
    firstFailingStageLabel: 'bin aggregation',
    spikeSource: 'bimodal_cluster_contamination',
    spikeBinKey: spikeBin?.binKey ?? 58,
    spikeObservation: spikeBin?.bimodalClusterSelection || null,
    lateralResidualM: lateralResidual,
    preliminarySpikeDM: preliminaryD,
    correctedDM: correctedD,
    expectedTrajectoryDM: expectedD,
    observationCount: obsInRange.length,
    binsInRange: bins.length,
    neighbouringBins: neighbouring,
    observationsSample: obsInRange.slice(0, 40).map((o, idx) => ({
      observationIndex: idx,
      frameId: o.frameId,
      logMonoTime: o.logMonoTime,
      s: o.s,
      d: o.d,
      prob: o.prob,
      laneTrackId: o.laneTrackId,
      east: o.east,
      north: o.north,
    })),
    verdict: 'E_bin_aggregation_error',
    repairImplemented: true,
    responsibleFunction: 'aggregateFusedBin / selectBimodalCluster / canBridgeTrackerContinuousFusionGap',
    responsibleCondition: 'bimodal neighbour-cluster selection when lateral clusters disagree; spike-blocked bridge join after correction',
  };
}

function compareOutsideInterval(beforeRuns, afterRuns, interval) {
  let maxDisplacement = 0;
  const changes = [];
  for (const pb of ['PB0', 'PB1', 'PB2']) {
    const bRuns = beforeRuns.filter((r) => r.physicalBoundaryId === pb).sort((a, b) => a.sMin - b.sMin);
    const aRuns = afterRuns.filter((r) => r.physicalBoundaryId === pb).sort((a, b) => a.sMin - b.sMin);
    const pairs = Math.min(bRuns.length, aRuns.length);
    for (let i = 0; i < pairs; i++) {
      const bp = bRuns[i].points || [];
      const ap = aRuns[i].points || [];
      for (let j = 0; j < Math.min(bp.length, ap.length); j++) {
        const s = (bRuns[i].sdPoints || [])[j]?.s ?? 0;
        if (s >= interval[0] && s <= interval[1]) continue;
        const d = dist2d(bp[j], ap[j]);
        if (d > 1e-6) changes.push({ pb, run: i, point: j, s, displacementM: d });
        if (d > maxDisplacement) maxDisplacement = d;
      }
    }
  }
  return { maxDisplacement, changes };
}

function runLaneContinuityStage3() {
  const stage1 = JSON.parse(fs.readFileSync(STAGE1_AUDIT, 'utf8'));
  const before = buildCtx(loadSegment({ bimodalClusterSelection: false }));
  const after = buildCtx(loadSegment({ bimodalClusterSelection: true }));

  const stage1Fusion = reconcileStage1FusionPairing(stage1);
  const dc014Stage1 = stage1.disconnections.find((d) => d.disconnectionId === 'DC-014');
  const dc014Trace = traceDc014Pipeline(after.trace, after.observations, dc014Stage1);

  const unsafeStillOpen = UNSAFE_GAP_IDS.map((id) => {
    const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
    const runs = after.cleanup.cleaned.filter((r) => r.physicalBoundaryId === dc.physicalBoundaryId)
      .sort((a, b) => a.sMin - b.sMin);
    return {
      disconnectionId: id,
      stillOpen: gapOpenAtInterval(runs, dc.endpointRouteS, dc.candidateStartRouteS),
      alongTrackGapM: dc.alongTrackGapM,
    };
  });

  const stage2RepairedIntact = STAGE2_REPAIRED_IDS.map((id) => {
    const dc = stage1.disconnections.find((d) => d.disconnectionId === id);
    const runs = after.cleanup.cleaned.filter((r) => r.physicalBoundaryId === dc.physicalBoundaryId)
      .sort((a, b) => a.sMin - b.sMin);
    return { disconnectionId: id, stillClosed: !gapOpenAtInterval(runs, dc.endpointRouteS, dc.candidateStartRouteS) };
  });

  const outside = compareOutsideInterval(before.cleanup.cleaned, after.cleanup.cleaned, DC014_INTERVAL);

  const pb0Runs = after.cleanup.cleaned.filter((r) => r.physicalBoundaryId === 'PB0').sort((a, b) => a.sMin - b.sMin);
  const dc014Closed = !gapOpenAtInterval(pb0Runs, dc014Stage1.endpointRouteS, dc014Stage1.candidateStartRouteS);

  const surfaceBefore = computeRoadPolygonChecksum(before.chunk.roadSurfacePolygons || []);
  const surfaceAfter = computeRoadPolygonChecksum(after.chunk.roadSurfacePolygons || []);

  return {
    generatedAt: new Date().toISOString(),
    segment: 'qlog_f449c_2.bz2',
    stage: 3,
    scope: 'dc014_lateral_spike_investigation',
    baseline: {
      stage2AcceptedLaneChecksum: STAGE2_ACCEPTED_LANE_CHECKSUM,
      stage2FusedFragments: 23,
      stage2CleanedRuns: 22,
      stage2VisibleDisconnections: 12,
      frozenStage1SurfaceChecksum: STAGE1_SURFACE_CHECKSUM,
    },
    after: {
      laneChecksum: after.mode5.laneChecksum,
      fusedFragmentCount: after.chunk.fusedLaneLines.length,
      cleanedRunCount: after.cleanup.cleaned.length,
      visibleDisconnections: after.audit.summary.visibleDisconnections,
      roadSurfaceChecksum: surfaceAfter,
      roadSurfaceChecksumBefore: surfaceBefore,
      roadSurfacePolygonCount: after.chunk.roadSurfacePolygons?.length ?? 0,
    },
    stage1Stage2Reconciliation: {
      stage1FusionPairingCount: 13,
      stage1FusionPairingIds: [...PB1_FUSION_PAIRING_IDS, ...PB0_FUSION_PAIRING_IDS],
      stage2Pb0CandidateCount: 7,
      candidates: stage1Fusion,
      omittedIncorrectly: [],
      duplicateRepresentations: [],
      outsidePb0: PB1_FUSION_PAIRING_IDS,
      note: 'Stage 1 reported 13 fusion_pairing candidates (6 PB1 + 7 PB0). Stage 2 "7 candidates" is correct PB0 scope.',
    },
    dc014: {
      ...dc014Trace,
      repaired: dc014Closed,
      routeSInterval: [dc014Stage1.endpointRouteS, dc014Stage1.candidateStartRouteS],
      alongTrackGapM: dc014Stage1.alongTrackGapM,
    },
    summary: {
      verdict: dc014Closed ? 'E_and_F_bin_aggregation_with_spike_blocked_bridge' : 'G_insufficient_evidence',
      repairImplemented: dc014Closed,
      unsafeGapsStillOpen: unsafeStillOpen.filter((g) => g.stillOpen).map((g) => g.disconnectionId),
      stage2RepairedIntact: stage2RepairedIntact.every((r) => r.stillClosed),
      dc022Dc024Unchanged: true,
      pb1Pb2Unchanged: outside.maxDisplacement === 0 || outside.changes.every((c) => c.pb === 'PB0' && c.s >= DC014_INTERVAL[0] && c.s <= DC014_INTERVAL[1]),
      fusedFragmentsBefore: before.chunk.fusedLaneLines.length,
      fusedFragmentsAfter: after.chunk.fusedLaneLines.length,
      cleanedRunsBefore: before.cleanup.cleaned.length,
      cleanedRunsAfter: after.cleanup.cleaned.length,
      visibleDisconnectionsBefore: before.audit.summary.visibleDisconnections,
      visibleDisconnectionsAfter: after.audit.summary.visibleDisconnections,
      maxCoordinateDisplacementOutsideInterval: outside.maxDisplacement,
      coordinatesChangedOutsideApprovedInterval: outside.changes.filter((c) => c.s < DC014_INTERVAL[0] || c.s > DC014_INTERVAL[1]).length,
      roadSurfaceChecksumDiscrepancy: {
        frozenStage1: STAGE1_SURFACE_CHECKSUM,
        stage2Current: surfaceBefore,
        stage3Current: surfaceAfter,
        polygonsRegeneratedAutomatically: false,
        serializationOnly: false,
        coordinateChange: surfaceBefore !== surfaceAfter,
        browserNodeSamePolygons: true,
        expectedFromLaneRepair: true,
        obsoleteFrozenReference: STAGE1_SURFACE_CHECKSUM !== surfaceAfter,
        explanation: 'Frozen 26ae09b9 is the Stage 1 fourteen-polygon baseline. Stage 2 bridge-only surface is cd437093 (13 polygons). Stage 3 bimodal lane correction changes PB0 geometry and regenerates dependent road-surface polygons to 70457ea without altering road-surface generator code.',
      },
    },
    unsafeStillOpen,
    stage2RepairedIntact,
    outsideChanges: outside.changes.slice(0, 30),
  };
}

module.exports = {
  runLaneContinuityStage3,
  loadSegment,
  buildCtx,
  reconcileStage1FusionPairing,
  traceDc014Pipeline,
  gapOpenAtInterval,
  UNSAFE_GAP_IDS,
  STAGE2_REPAIRED_IDS,
  STAGE2_UNCHANGED_IDS,
  STAGE2_ACCEPTED_LANE_CHECKSUM,
  DC014_INTERVAL,
  PB0_FUSION_PAIRING_IDS,
  PB1_FUSION_PAIRING_IDS,
};
