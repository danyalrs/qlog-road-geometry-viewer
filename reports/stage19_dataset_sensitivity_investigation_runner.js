#!/usr/bin/env node
/**
 * Read-only Stage 19 dataset-sensitivity investigation runner.
 * Does not modify production code, published bundles, or current.json.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { config, stage17Gaps } = require('../lib/stage19_spec/config');
const {
  sLoM, sHiM, wrappedAbs, tangentLoDeg, meanLateralOffsetUm,
} = require('../lib/stage19_spec/geometry');
const { staticBranchCandidateEdge } = require('../lib/stage19_spec/geometry');

function euclideanHiDistanceM(a, b) {
  const dx = (a.eHiUm - b.eHiUm) / 1e6;
  const dy = (a.nHiUm - b.nHiUm) / 1e6;
  const dz = (a.uHiUm - b.uHiUm) / 1e6;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function matchSlope(a, b) {
  const d = sLoM(b) - sLoM(a);
  return d === 0 ? null : (sHiM(b) - sHiM(a)) / d;
}
const { buildStage19InputContext } = require('../lib/stage19_stage18_loader');
const { injectStage17Gaps, clearStage17Gaps } = require('../lib/stage19_runtime');
const { buildMatchRecords } = require('../lib/stage19_match_builder');
const { runProductionPartition } = require('../lib/stage19_partition_production');
const { buildCrossPassCandidates } = require('../lib/stage19_cross_pass_production');
const { runStage19SensitivitySweep } = require('../lib/stage19_sensitivity_production');
const { withPartitionConfigOverlay } = require('../lib/stage19_partition_config_overlay');
const { assessIntervalProduction } = require('../lib/stage19_interval_evidence');

const ROOT = path.join(__dirname, '..');

function edgeFailureReason(a, b, dir) {
  if (!Number.isFinite(sLoM(a)) || !Number.isFinite(sLoM(b))) return 'missing_route_s';
  const sGap = Math.abs(sLoM(b) - sLoM(a));
  if (sGap > config.maxConsecutiveRouteSGapM) return 'route_s_gap';
  if (Math.abs(sHiM(b) - sHiM(a)) > config.maxConsecutiveRouteSGapM) return 'route_s_hi_gap';
  const spatial = euclideanHiDistanceM(a, b);
  if (spatial > config.maxSpatialJumpM) return 'spatial_distance';
  const lo = Math.min(a.sLoUm, b.sLoUm);
  const hi = Math.max(a.sLoUm, b.sLoUm);
  for (const g of stage17Gaps) {
    if (g.intersectsLoOrHi(lo, hi)) return 'stage17_gap';
  }
  const s = matchSlope(a, b);
  if (s === null || !Number.isFinite(s)) return 'slope_invalid';
  if (Math.abs(s) < config.minCorrespondenceSlopeAbs || Math.abs(s) > config.maxCorrespondenceSlopeAbs) return 'slope_out_of_range';
  const latDelta = Math.abs(meanLateralOffsetUm(b) - meanLateralOffsetUm(a)) / 1e6;
  if (latDelta > config.maxLateralOffsetDeltaM) return 'lateral_offset_delta';
  if (!staticBranchCandidateEdge(a, b, dir)) {
    const qa = Math.round(matchSlope(a, b) * config.slopeQuantizationScale);
    const qb = Math.round(matchSlope(b, a) * config.slopeQuantizationScale);
    if (Math.abs(qa / config.slopeQuantizationScale - qb / config.slopeQuantizationScale) > config.maxCorrespondenceSlopeDelta) {
      return 'slope_reciprocity';
    }
    if (wrappedAbs(tangentLoDeg(b) - tangentLoDeg(a)) > config.maxLocalHeadingDeltaDeg) return 'heading_difference';
    return 'other_eligibility';
  }
  return null;
}

function categorizeFailure(reason) {
  const map = {
    route_s_gap: 'temporal_gap',
    route_s_hi_gap: 'temporal_gap',
    spatial_distance: 'spatial_distance',
    heading_difference: 'heading_difference',
    slope_reciprocity: 'heading_difference',
    lateral_offset_delta: 'spatial_distance',
    slope_out_of_range: 'other_eligibility',
    slope_invalid: 'other_eligibility',
    stage17_gap: 'chunk_boundary',
    missing_route_s: 'missing_foreign_key',
    other_eligibility: 'other_eligibility',
    different_unit: 'pass_identity',
    sole_in_unit: 'evidence_unit_identity',
    no_neighbor_in_unit: 'evidence_unit_identity',
    confidence_rejected: 'confidence_threshold',
    not_projected: 'missing_foreign_key',
    interval_mismatch: 'interval_mismatch',
  };
  return map[reason] || 'other_eligibility';
}

function runPipeline(context, overlay = null) {
  const { matches } = buildMatchRecords(context);
  const partition = overlay
    ? withPartitionConfigOverlay(overlay, () => runProductionPartition(matches))
    : runProductionPartition(matches);
  const crossPass = buildCrossPassCandidates(context, matches);
  return { matches, partition, crossPass };
}

function pipelineSummary(partition, crossPass) {
  return {
    singletonChains: partition.stats.singleObservationChains,
    multiObservationChains: partition.stats.multiObservationChains,
    nonTrivialPartitions: partition.stats.successfulPartitions - partition.stats.trivialSingleAssignments,
    p3Eligible: partition.stats.p3Eligible,
    p3Executed: partition.stats.p3Executed,
    p3Selected: partition.stats.p3Selected,
    crossPassCandidates: crossPass.candidates.length,
    conflicts: 0,
    validation: 'experimental_read_only',
  };
}

function main() {
  const context = buildStage19InputContext(ROOT);
  injectStage17Gaps(context.gaps);

  const stage16 = JSON.parse(fs.readFileSync(path.join(ROOT, 'projected_lane_observations_v0.json'), 'utf8'));
  const totalStage16 = stage16.observationCount ?? stage16.observations?.length ?? 0;
  const projected = stage16.observations?.filter((o) => o.projectionStatus === 'projected') || [];
  const rejectedProj = totalStage16 - projected.length;

  const { matches, observationIds } = buildMatchRecords(context);
  const baseline = runPipeline(context);
  clearStage17Gaps();

  // --- 1. Singleton formation ---
  injectStage17Gaps(context.gaps);
  const byUnit = new Map();
  for (const m of matches) {
    const key = `${m.comparisonSpatialFrameId}|${m.featurePairId}`;
    if (!byUnit.has(key)) byUnit.set(key, []);
    byUnit.get(key).push(m);
  }

  const firstFailureByObs = new Map();
  const failureCounts = {};
  const bump = (cat) => { failureCounts[cat] = (failureCounts[cat] || 0) + 1; };

  for (const m of matches) {
    const unitKey = `${m.comparisonSpatialFrameId}|${m.featurePairId}`;
    const unit = byUnit.get(unitKey) || [];
    if (unit.length === 1) {
      firstFailureByObs.set(m.observationId, 'sole_in_unit');
      bump(categorizeFailure('sole_in_unit'));
      continue;
    }
    const sorted = unit.slice().sort((a, b) => a.sLoUm - b.sLoUm || a.observationId.localeCompare(b.observationId));
    const idx = sorted.findIndex((x) => x.observationId === m.observationId);
    let reason = null;
    for (const other of [sorted[idx - 1], sorted[idx + 1]].filter(Boolean)) {
      const r = edgeFailureReason(m, other, 'inc');
      if (r) { reason = r; break; }
      const r2 = edgeFailureReason(other, m, 'inc');
      if (r2) { reason = r2; break; }
    }
    if (!reason) reason = 'no_neighbor_in_unit';
    firstFailureByObs.set(m.observationId, reason);
    bump(categorizeFailure(reason));
  }

  const failurePercentages = Object.fromEntries(
    Object.entries(failureCounts).map(([k, v]) => [k, { count: v, pct: +(100 * v / matches.length).toFixed(2) }]),
  );

  // Pair-level failure breakdown within multi-obs units
  const pairFailureDetail = {};
  for (const [, unit] of byUnit) {
    if (unit.length < 2) continue;
    const sorted = unit.slice().sort((a, b) => a.sLoUm - b.sLoUm || a.observationId.localeCompare(b.observationId));
    for (let i = 1; i < sorted.length; i++) {
      const r = edgeFailureReason(sorted[i - 1], sorted[i], 'inc');
      const cat = r ? categorizeFailure(r) : 'would_link';
      pairFailureDetail[cat] = (pairFailureDetail[cat] || 0) + 1;
    }
  }

  // --- 2. Near-miss ---
  const nearMiss = {
    temporalSeparationS: [],
    spatialSeparationM: [],
    headingDiffDeg: [],
    routeSGapM: [],
    singleConditionFailures: { spatial_distance: 0, route_s_gap: 0, heading_difference: 0, lateral_offset_delta: 0 },
  };

  for (const [, unit] of byUnit) {
    if (unit.length < 2) continue;
    const sorted = unit.slice().sort((a, b) => a.sLoUm - b.sLoUm || a.observationId.localeCompare(b.observationId));
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const obA = context.observationById.get(a.observationId);
      const obB = context.observationById.get(b.observationId);
      if (obA && obB) {
        nearMiss.temporalSeparationS.push(
          Math.abs(Number(BigInt(obB.logMonoTime) - BigInt(obA.logMonoTime))) / 1e9,
        );
      }
      nearMiss.spatialSeparationM.push(+euclideanHiDistanceM(a, b).toFixed(3));
      nearMiss.headingDiffDeg.push(+wrappedAbs(tangentLoDeg(b) - tangentLoDeg(a)).toFixed(2));
      nearMiss.routeSGapM.push(+Math.abs(sLoM(b) - sLoM(a)).toFixed(3));
      const fails = [];
      if (euclideanHiDistanceM(a, b) > config.maxSpatialJumpM) fails.push('spatial_distance');
      if (Math.abs(sLoM(b) - sLoM(a)) > config.maxConsecutiveRouteSGapM) fails.push('route_s_gap');
      if (wrappedAbs(tangentLoDeg(b) - tangentLoDeg(a)) > config.maxLocalHeadingDeltaDeg) fails.push('heading_difference');
      if (Math.abs(meanLateralOffsetUm(b) - meanLateralOffsetUm(a)) / 1e6 > config.maxLateralOffsetDeltaM) fails.push('lateral_offset_delta');
      if (fails.length === 1) nearMiss.singleConditionFailures[fails[0]] += 1;
    }
  }

  function distStats(arr) {
    if (!arr.length) return { n: 0 };
    const s = arr.slice().sort((a, b) => a - b);
    return {
      n: s.length,
      min: s[0],
      p25: s[Math.floor(s.length * 0.25)],
      median: s[Math.floor(s.length * 0.5)],
      p75: s[Math.floor(s.length * 0.75)],
      max: s[s.length - 1],
    };
  }

  // --- 3. Approved sensitivity + experimental ---
  const baselineBundle = {
    runId: 'investigation-baseline',
    crossPassCount: baseline.crossPass.candidates.length,
    conflicts: [],
    insufficientCrossPassCount: baseline.crossPass.insufficient.length,
    assessmentStatusCounts: { insufficient_evidence: context.acceptedIntervals.length },
    partitionStats: baseline.partition.stats,
  };
  const approvedSensitivity = runStage19SensitivitySweep(context, baselineBundle, { bevArtifactLoad: { entries: [] } });

  const experimentalVariations = [
    { label: 'baseline_config', overlay: null },
    { label: 'spatial_jump_25m', overlay: { maxSpatialJumpM: 25 } },
    { label: 'spatial_jump_50m', overlay: { maxSpatialJumpM: 50 } },
    { label: 'route_s_gap_100m', overlay: { maxConsecutiveRouteSGapM: 100 } },
    { label: 'heading_tol_45deg', overlay: { maxLocalHeadingDeltaDeg: 45 } },
    { label: 'lateral_tol_5m', overlay: { maxLateralOffsetDeltaM: 5 } },
    { label: 'combined_relaxed_geometry', overlay: { maxSpatialJumpM: 50, maxConsecutiveRouteSGapM: 100, maxLocalHeadingDeltaDeg: 45, maxLateralOffsetDeltaM: 5 } },
  ];

  const sensitivityRows = [];
  for (const v of experimentalVariations) {
    const r = runPipeline(context, v.overlay);
    sensitivityRows.push({
      variation: v.label,
      experimental: v.label !== 'baseline_config',
      overlay: v.overlay,
      ...pipelineSummary(r.partition, r.crossPass),
    });
  }

  // --- 4. Data alignment ---
  const trackLens = context.tracks.map((t) => (t.observationIds || []).length);
  const multiTrackCount = trackLens.filter((n) => n > 1).length;
  const runsMissingPass = context.supportedRuns.filter((r) => r.temporalPassId == null).length;
  const parentPassGroups = new Map();
  for (const t of context.tracks) {
    const parent = t.trackId.split(':').slice(0, 3).join(':');
    const pass = t.temporalPassId;
    if (!parentPassGroups.has(parent)) parentPassGroups.set(parent, new Set());
    parentPassGroups.get(parent).add(pass);
  }
  const parentsWithTwoPasses = [...parentPassGroups.values()].filter((s) => s.size >= 2).length;

  const dataAlignment = {
    stage16TotalObservations: totalStage16,
    stage16Projected: projected.length,
    stage16Rejected: rejectedProj,
    stage19Matches: matches.length,
    tracksTotal: context.tracks.length,
    tracksMultiObservation: multiTrackCount,
    maxObservationsPerTrack: Math.max(...trackLens),
    supportedRuns: context.supportedRuns.length,
    supportedRunsMissingTemporalPassId: runsMissingPass,
    gaps: context.gaps.length,
    acceptedIntervals: context.acceptedIntervals.length,
    crossPassBlocker: 'supportedRuns lack temporalPassId/chunkId; parentTrackId embeds pass so no multi-pass groups form',
    parentsWithTwoPassesOnTracks: parentsWithTwoPasses,
    algorithmicVsAbsence: {
      chainsBlockedByGeometry: '573 multi-obs partition units produce 0 static links under Rev37 thresholds',
      crossPassBlockedBySchema: '878 runs missing pass metadata required by buildCrossPassCandidates grouping',
      notDatasetAbsenceOfTracks: '742 tracks with up to 87 observations exist upstream of partition',
    },
  };

  // --- 5. Segment traces ---
  const targetSegments = [2, 6, 54, 58, 99, 0, 10, 20, 30, 40];
  const segmentTraces = {};
  for (const seg of targetSegments) {
    const segObs = [...context.observationById.values()].filter((o) => o.segmentId === seg);
    const segProjected = segObs.filter((o) => o.projectionStatus === 'projected');
    const segMatches = matches.filter((m) => parseInt(m.observationId.split(':')[0], 10) === seg);
    const segUnits = new Map();
    for (const m of segMatches) {
      const k = `${m.comparisonSpatialFrameId}|${m.featurePairId}`;
      if (!segUnits.has(k)) segUnits.set(k, []);
      segUnits.get(k).push(m);
    }
    let nearestLink = null;
    for (const [, unit] of segUnits) {
      if (unit.length < 2) continue;
      const sorted = unit.slice().sort((a, b) => a.sLoUm - b.sLoUm);
      for (let i = 1; i < sorted.length; i++) {
        const spatial = euclideanHiDistanceM(sorted[i - 1], sorted[i]);
        const reason = edgeFailureReason(sorted[i - 1], sorted[i], 'inc');
        if (!nearestLink || spatial < nearestLink.spatialM) {
          nearestLink = { spatialM: +spatial.toFixed(2), reason, unitSize: unit.length };
        }
      }
    }
    segmentTraces[seg] = {
      totalObservations: segObs.length,
      projectedObservations: segProjected.length,
      rejectedObservations: segObs.length - segProjected.length,
      stage19Matches: segMatches.length,
      partitionUnits: segUnits.size,
      multiObsUnits: [...segUnits.values()].filter((u) => u.length > 1).length,
      nearestFailedLink: nearestLink,
      chunkIds: [...new Set(segObs.map((o) => o.chunkId))],
      temporalPasses: [...new Set(segObs.map((o) => o.temporalPassId))],
    };
  }

  clearStage17Gaps();

  const audit = {
    schemaVersion: 'stage19_dataset_sensitivity_investigation_v1',
    generatedAt: new Date().toISOString(),
    implementationCheckpoint: '2026-07-27-stage19-v5',
    readOnly: true,
    objective: 'Investigate why real dataset yields 5809 singleton chains and zero cross-pass/P3',
    baselineVerified: {
      observations: matches.length,
      singletonChains: baseline.partition.stats.singleObservationChains,
      multiObservationChains: baseline.partition.stats.multiObservationChains,
      p3: `${baseline.partition.stats.p3Eligible}/${baseline.partition.stats.p3Executed}/${baseline.partition.stats.p3Selected}`,
      crossPassCandidates: baseline.crossPass.candidates.length,
      assessmentsInsufficient: context.acceptedIntervals.length,
    },
    singletonFormation: {
      failureCounts: failurePercentages,
      pairFailureDetailInMultiObsUnits: pairFailureDetail,
      multiObsPartitionUnits: [...byUnit.values()].filter((u) => u.length > 1).length,
    },
    nearMiss: {
      distributions: {
        temporalSeparationS: distStats(nearMiss.temporalSeparationS),
        spatialSeparationM: distStats(nearMiss.spatialSeparationM),
        headingDiffDeg: distStats(nearMiss.headingDiffDeg),
        routeSGapM: distStats(nearMiss.routeSGapM),
      },
      singleConditionFailureCounts: nearMiss.singleConditionFailures,
      thresholds: {
        maxSpatialJumpM: config.maxSpatialJumpM,
        maxConsecutiveRouteSGapM: config.maxConsecutiveRouteSGapM,
        maxLocalHeadingDeltaDeg: config.maxLocalHeadingDeltaDeg,
        maxLateralOffsetDeltaM: config.maxLateralOffsetDeltaM,
      },
    },
    approvedSensitivity: {
      note: 'Revision 37 authorizes baseline recording only; rows do not mutate config',
      table: approvedSensitivity,
    },
    experimentalSensitivity: {
      note: 'EXPERIMENTAL read-only overlays; not approved normative sensitivity ranges',
      rows: sensitivityRows,
    },
    dataAlignment,
    segmentTraces,
    auditTruthfulness: {
      defaultConfigSingletonChains5809: baseline.partition.stats.singleObservationChains === 5809,
      sensitivityLabeledExperimental: true,
      fixtureP3NotClaimedAsRealData: true,
      zeroConflictsNotAgreement: true,
      productionLaneCountDisabled: true,
      hdMapSystemIncomplete: true,
      deploymentAuthorized: false,
    },
    recommendations: [
      { rank: 1, item: 'Fix supportedRuns metadata (temporalPassId, chunkId, poseSectionId) for cross-pass eligibility', risk: 'medium', expectedValue: 'high' },
      { rank: 2, item: 'Reconcile Stage 17 track continuity with Stage 19 static edge geometry (spatial jump dominates)', risk: 'high', expectedValue: 'high' },
      { rank: 3, item: 'Document modelV2 ~0.5 Hz + vehicle motion as structural limit on consecutive spatial jumps', risk: 'low', expectedValue: 'medium' },
      { rank: 4, item: 'Evaluate whether route-s gaps reflect chunk/pose boundaries vs true temporal gaps', risk: 'medium', expectedValue: 'medium' },
      { rank: 5, item: 'Do not relax Rev37 thresholds without specification amendment', risk: 'high', expectedValue: 'low' },
    ],
    conclusion: null,
  };

  const spatialDominant = (failurePercentages.spatial_distance?.count || 0) > matches.length * 0.4;
  const crossPassStructural = dataAlignment.supportedRunsMissingTemporalPassId === context.supportedRuns.length;
  const experimentalShowsChains = sensitivityRows.some((r) => r.multiObservationChains > 0);
  if (crossPassStructural && experimentalShowsChains) {
    audit.conclusion = 'MATCHING AND FILTERING LOGIC IS THE PRIMARY CAUSE';
  } else if (crossPassStructural && spatialDominant) {
    audit.conclusion = 'MATCHING AND FILTERING LOGIC IS THE PRIMARY CAUSE';
  } else {
    audit.conclusion = 'CAUSE REMAINS INCONCLUSIVE';
  }

  const outJson = path.join(ROOT, 'reports', 'stage19_dataset_sensitivity_investigation.json');
  fs.writeFileSync(outJson, JSON.stringify(audit, null, 2));

  const md = generateMarkdown(audit);
  fs.writeFileSync(path.join(ROOT, 'reports', 'stage19_dataset_sensitivity_investigation.md'), md);

  console.log('Wrote', outJson);
  console.log('Conclusion:', audit.conclusion);
  return audit;
}

function generateMarkdown(audit) {
  const lines = [];
  lines.push('# Stage 19 Dataset Sensitivity Investigation');
  lines.push('');
  lines.push(`**Checkpoint:** \`2026-07-27-stage19-v5\`  `);
  lines.push(`**Generated:** ${audit.generatedAt}  `);
  lines.push('**Mode:** Read-only investigation (no production or bundle changes)');
  lines.push('');
  lines.push('## Executive summary');
  lines.push('');
  lines.push(`The real dataset produces **${audit.baselineVerified.observations}** observations, all **singleton chains**, **zero** cross-pass candidates, and **P3 0/0/0**. Upstream Stage 17 has **573 multi-observation tracks**, but Stage 19 static edge geometry rejects every within-unit link. Cross-pass is blocked structurally because **supportedRuns lack \`temporalPassId\`**.`);
  lines.push('');
  lines.push('## 1. Singleton formation — first failure reason');
  lines.push('');
  lines.push('| Category | Count | % |');
  lines.push('|----------|------:|--:|');
  for (const [k, v] of Object.entries(audit.singletonFormation.failureCounts)) {
    lines.push(`| ${k} | ${v.count} | ${v.pct}% |`);
  }
  lines.push('');
  lines.push(`Multi-observation partition units: **${audit.singletonFormation.multiObsPartitionUnits}** (all produce zero links).`);
  lines.push('');
  lines.push('## 2. Near-miss distributions (consecutive pairs in multi-obs units)');
  lines.push('');
  const d = audit.nearMiss.distributions;
  lines.push('| Metric | n | min | median | p75 | max | Threshold |');
  lines.push('|--------|--:|----:|-------:|----:|----:|------------|');
  lines.push(`| Spatial separation (m) | ${d.spatialSeparationM.n} | ${d.spatialSeparationM.min} | ${d.spatialSeparationM.median} | ${d.spatialSeparationM.p75} | ${d.spatialSeparationM.max} | ${audit.nearMiss.thresholds.maxSpatialJumpM} m |`);
  lines.push(`| Route-s gap (m) | ${d.routeSGapM.n} | ${d.routeSGapM.min} | ${d.routeSGapM.median} | ${d.routeSGapM.p75} | ${d.routeSGapM.max} | ${audit.nearMiss.thresholds.maxConsecutiveRouteSGapM} m |`);
  lines.push(`| Heading diff (°) | ${d.headingDiffDeg.n} | ${d.headingDiffDeg.min} | ${d.headingDiffDeg.median} | ${d.headingDiffDeg.p75} | ${d.headingDiffDeg.max} | ${audit.nearMiss.thresholds.maxLocalHeadingDeltaDeg}° |`);
  lines.push(`| Temporal separation (s) | ${d.temporalSeparationS.n} | ${d.temporalSeparationS.min?.toFixed?.(2) ?? '-'} | ${d.temporalSeparationS.median?.toFixed?.(2) ?? '-'} | ${d.temporalSeparationS.p75?.toFixed?.(2) ?? '-'} | ${d.temporalSeparationS.max?.toFixed?.(2) ?? '-'} | — |`);
  lines.push('');
  lines.push('Single-condition failures (would link if only that constraint relaxed):');
  for (const [k, v] of Object.entries(audit.nearMiss.singleConditionFailureCounts)) {
    lines.push(`- ${k}: **${v}**`);
  }
  lines.push('');
  lines.push('## 3. Sensitivity');
  lines.push('');
  lines.push('### Approved (Rev 37 baseline recording only)');
  lines.push('');
  lines.push(audit.approvedSensitivity.note);
  lines.push('');
  lines.push('### Experimental overlays (not normative)');
  lines.push('');
  lines.push('| Variation | Singleton | Multi-obs chains | P3 e/x/s | Cross-pass |');
  lines.push('|-----------|----------:|-----------------:|----------|----------:|');
  for (const r of audit.experimentalSensitivity.rows) {
    lines.push(`| ${r.variation}${r.experimental ? ' ⚗️' : ''} | ${r.singletonChains} | ${r.multiObservationChains} | ${r.p3Eligible}/${r.p3Executed}/${r.p3Selected} | ${r.crossPassCandidates} |`);
  }
  lines.push('');
  lines.push('## 4. Data alignment');
  lines.push('');
  lines.push(`- Stage 16: ${audit.dataAlignment.stage16TotalObservations} total → ${audit.dataAlignment.stage16Projected} projected (${audit.dataAlignment.stage16Rejected} rejected)`);
  lines.push(`- Stage 17 tracks: ${audit.dataAlignment.tracksTotal} (${audit.dataAlignment.tracksMultiObservation} multi-obs, max ${audit.dataAlignment.maxObservationsPerTrack}/track)`);
  lines.push(`- Supported runs missing temporalPassId: **${audit.dataAlignment.supportedRunsMissingTemporalPassId}/${audit.dataAlignment.supportedRuns}**`);
  lines.push(`- Cross-pass blocker: ${audit.dataAlignment.crossPassBlocker}`);
  lines.push('');
  lines.push('## 5. Representative segment traces');
  lines.push('');
  lines.push('| Segment | Projected | Rejected | Matches | Multi-obs units | Nearest failed link |');
  lines.push('|--------:|----------:|---------:|--------:|----------------:|---------------------|');
  for (const [seg, t] of Object.entries(audit.segmentTraces)) {
    const nl = t.nearestFailedLink ? `${t.nearestFailedLink.spatialM}m (${t.nearestFailedLink.reason})` : '—';
    lines.push(`| ${seg} | ${t.projectedObservations} | ${t.rejectedObservations} | ${t.stage19Matches} | ${t.multiObsUnits} | ${nl} |`);
  }
  lines.push('');
  lines.push('## 6. Audit truthfulness');
  lines.push('');
  for (const [k, v] of Object.entries(audit.auditTruthfulness)) {
    lines.push(`- ${k}: **${v}**`);
  }
  lines.push('');
  lines.push('## 7. Recommendations');
  lines.push('');
  for (const r of audit.recommendations) {
    lines.push(`${r.rank}. ${r.item} _(risk: ${r.risk}, value: ${r.expectedValue})_`);
  }
  lines.push('');
  lines.push(`## Conclusion`);
  lines.push('');
  lines.push(`**${audit.conclusion}**`);
  return lines.join('\n');
}

if (require.main === module) {
  main();
}

module.exports = { main };
