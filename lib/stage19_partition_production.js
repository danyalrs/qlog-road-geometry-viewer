'use strict';

const { canonicalMatchId } = require('./stage19_spec/canonical');
const { partitionDP } = require('./stage19_spec/partition');
const { staticBranchCandidateEdge } = require('./stage19_spec/geometry');
const { runP3Branch } = require('./stage19_spec/p3');
const { applyBranchSelection } = require('./stage19_spec/uncertainty');
const { config } = require('./stage19_spec/config');
const { withPartitionConfigOverlay } = require('./stage19_partition_config_overlay');

const APPROVED_PARTITION_REJECTION_CODES = new Set([
  'open_cap_exceeded',
  'no_geometric_cover',
  'no_terminal_partition',
]);

function normalizePartitionFailure(failure) {
  if (!failure) return failure;
  if (failure.code === 'overflow' && failure.openCap === true) {
    return { ...failure, code: 'open_cap_exceeded', overflow: false, rejected: true };
  }
  if (APPROVED_PARTITION_REJECTION_CODES.has(failure.code)) {
    return { ...failure, rejected: true, overflow: false };
  }
  return failure;
}

function buildP3UncertaintyFields(branchCanonical) {
  const span = Math.max(
    config.minCrossPassTrajectoryOverlapM,
    branchCanonical?.accumulatedSupportedLengthM || 0,
  );
  return {
    requiredScalars: [{ confidenceLevel: 0.95, halfWidth: Math.max(span, 1e-6) }],
  };
}

function buildP3SelectionMeta(branchCanonical) {
  return {
    uncertaintyInterpretation: 'one_sigma',
    documentedIndependent: true,
    branchCanonicalId: branchCanonical?.overlapStateId || null,
    matchCount: branchCanonical?.matchCount || 0,
  };
}

function runP3WithBranchSelection(chain, meta) {
  const p3Eligible = chain.length >= config.minP3MatchCount;
  if (!p3Eligible) {
    return {
      p3Eligible: false,
      p3Executed: false,
      p3Result: null,
      branchSelection: null,
    };
  }
  const p3Result = runP3Branch(chain, meta);
  if (!p3Result.ok || !p3Result.branchCanonical) {
    return {
      p3Eligible: true,
      p3Executed: true,
      p3Result,
      branchSelection: { ok: false, reason: 'p3_failed' },
    };
  }
  const branchSelection = applyBranchSelection(
    buildP3UncertaintyFields(p3Result.branchCanonical),
    buildP3SelectionMeta(p3Result.branchCanonical),
  );
  return {
    p3Eligible: true,
    p3Executed: true,
    p3Result,
    branchSelection,
  };
}

function buildStaticChains(matches, direction = 'inc') {
  if (!matches.length) return [];
  const sorted = matches.slice().sort((a, b) => a.sLoUm - b.sLoUm || a.observationId.localeCompare(b.observationId));
  const chains = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (staticBranchCandidateEdge(prev, cur, direction)) {
      chains[chains.length - 1].push(cur);
    } else {
      chains.push([cur]);
    }
  }
  return chains;
}

function partitionChain(chain, direction = 'inc') {
  if (chain.length === 1) {
    return {
      ok: true,
      outcome: 'single_observation',
      direction,
      branchByObs: new Map([[chain[0].observationId, 0]]),
      numPaths: 1,
      totalExtensionCost: 0,
      failure: null,
      chainLength: 1,
    };
  }
  for (const dir of [direction, direction === 'inc' ? 'dec' : 'inc']) {
    const result = partitionDP(chain, dir);
    try {
      if (result.ok && result.branchMap) {
        const branchByObs = new Map();
        for (const m of chain) {
          const cid = canonicalMatchId(m);
          const bid = result.branchMap.get(cid);
          if (bid == null) {
            result.finalize();
            return {
              ok: false,
              outcome: 'incomplete_branch_map',
              direction: dir,
              branchByObs: null,
              numPaths: 0,
              totalExtensionCost: 0,
              failure: { code: 'incomplete_branch_map', direction: dir },
              chainLength: chain.length,
              affectedObservationIds: chain.map((x) => x.observationId),
            };
          }
          branchByObs.set(m.observationId, bid % config.O_max);
        }
        const terminal = result.terminal;
        const out = {
          ok: true,
          outcome: 'partitioned',
          direction: dir,
          branchByObs,
          numPaths: new Set(branchByObs.values()).size,
          totalExtensionCost: terminal?.accumulatedExtensionCost ?? 0,
          failure: null,
          chainLength: chain.length,
        };
        result.finalize();
        return out;
      }
      const failure = normalizePartitionFailure(result.failure || { code: 'no_terminal_partition' });
      result.finalize();
      const outcome = failure.rejected || APPROVED_PARTITION_REJECTION_CODES.has(failure.code)
        ? 'partition_rejected'
        : 'partition_failed';
      return {
        ok: false,
        outcome,
        direction: dir,
        branchByObs: null,
        numPaths: 0,
        totalExtensionCost: 0,
        failure: { code: failure.code || 'partition_failed', direction: dir, ...failure },
        chainLength: chain.length,
        affectedObservationIds: chain.map((x) => x.observationId),
      };
    } catch (e) {
      try { result.finalize(); } catch (_) { /* ignore */ }
      return {
        ok: false,
        outcome: 'partition_error',
        direction: dir,
        branchByObs: null,
        numPaths: 0,
        totalExtensionCost: 0,
        failure: { code: 'partition_error', message: String(e.message || e) },
        chainLength: chain.length,
        affectedObservationIds: chain.map((x) => x.observationId),
      };
    }
  }
  return {
    ok: false,
    outcome: 'partition_failed',
    direction,
    branchByObs: null,
    numPaths: 0,
    totalExtensionCost: 0,
    failure: { code: 'no_terminal_partition' },
    chainLength: chain.length,
    affectedObservationIds: chain.map((x) => x.observationId),
  };
}

function runProductionPartition(matches, deps = {}) {
  if (deps.partitionConfigOverlay) {
    return withPartitionConfigOverlay(deps.partitionConfigOverlay, () =>
      runProductionPartition(matches, { ...deps, partitionConfigOverlay: null }),
    );
  }
  const p3Runner = deps.runP3WithBranchSelection || runP3WithBranchSelection;
  const byUnit = new Map();
  for (const m of matches) {
    const key = `${m.comparisonSpatialFrameId}|${m.featurePairId}`;
    if (!byUnit.has(key)) byUnit.set(key, []);
    byUnit.get(key).push(m);
  }

  const branchByObs = new Map();
  const partitionResults = [];
  const failedObservations = new Set();
  const stats = {
    totalUnits: byUnit.size,
    totalChains: 0,
    singleObservationChains: 0,
    multiObservationChains: 0,
    successfulPartitions: 0,
    failedPartitions: 0,
    overflowPartitions: 0,
    rejectedPartitions: 0,
    trivialSingleAssignments: 0,
    p3Eligible: 0,
    p3Executed: 0,
    p3Selected: 0,
    p3Failed: 0,
  };

  for (const [unitKey, unitMatches] of byUnit) {
    const [comparisonSpatialFrameId, featurePairId] = unitKey.split('|');
    const chains = buildStaticChains(unitMatches, 'inc');
    for (const chain of chains) {
      stats.totalChains += 1;
      if (chain.length === 1) stats.singleObservationChains += 1;
      else stats.multiObservationChains += 1;

      const part = partitionChain(chain, 'inc');
      let p3Bundle = { p3Eligible: false, p3Executed: false, p3Result: null, branchSelection: null };
      if (part.ok) {
        const meta = {
          direction: part.direction,
          directionComponentId: `${comparisonSpatialFrameId}:${featurePairId}`,
          branchId: 0,
          featureIdLo: featurePairId,
          featureIdHi: featurePairId,
          comparisonSpatialFrameId,
        };
        p3Bundle = p3Runner(chain, meta);
        if (p3Bundle.p3Eligible) stats.p3Eligible += 1;
        if (p3Bundle.p3Executed) stats.p3Executed += 1;
        if (p3Bundle.branchSelection?.ok) stats.p3Selected += 1;
        if (p3Bundle.p3Executed && !p3Bundle.branchSelection?.ok) stats.p3Failed += 1;
      }

      partitionResults.push({
        unitKey,
        comparisonSpatialFrameId,
        featurePairId,
        chainLength: chain.length,
        observationIds: chain.map((x) => x.observationId),
        segmentIds: [...new Set(chain.map((x) => parseInt(x.observationId.split(':')[0], 10)))],
        ...part,
        ...p3Bundle,
      });

      if (part.ok && part.branchByObs) {
        if (part.outcome === 'single_observation') stats.trivialSingleAssignments += 1;
        else stats.successfulPartitions += 1;
        for (const [oid, bid] of part.branchByObs) branchByObs.set(oid, bid);
      } else {
        stats.failedPartitions += 1;
        if (part.outcome === 'partition_rejected' || part.failure?.rejected) {
          stats.rejectedPartitions += 1;
        } else if (part.failure?.code === 'overflow') {
          stats.overflowPartitions += 1;
        }
        for (const oid of part.affectedObservationIds || []) failedObservations.add(oid);
      }
    }
  }

  return {
    branchByObs,
    partitionResults,
    failedObservations,
    stats,
  };
}

function summarizePartitionStatsBySegment(partitionResults) {
  const bySegment = {};
  for (const pr of partitionResults) {
    for (const seg of pr.segmentIds || []) {
      if (!bySegment[seg]) bySegment[seg] = { chains: 0, failed: 0, overflow: 0 };
      bySegment[seg].chains += 1;
      if (!pr.ok) bySegment[seg].failed += 1;
      if (pr.failure?.code === 'overflow') bySegment[seg].overflow += 1;
    }
  }
  return bySegment;
}

module.exports = {
  APPROVED_PARTITION_REJECTION_CODES,
  normalizePartitionFailure,
  buildStaticChains,
  partitionChain,
  runProductionPartition,
  runP3WithBranchSelection,
  summarizePartitionStatsBySegment,
};
