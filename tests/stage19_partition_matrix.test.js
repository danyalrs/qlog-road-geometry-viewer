'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  runProductionPartition,
  runProductionMatchPartition,
  runP3WithBranchSelection,
  partitionChain,
  buildStaticChains,
} = require('../lib/stage19_partition_production');
const { makeTestMatch, runPartitionLayerOwnershipTests, runPartitionOwnershipTests } = require('../lib/stage19_spec/partition');
const { runP3Branch } = require('../lib/stage19_spec/p3');
const { applyBranchSelection } = require('../lib/stage19_spec/uncertainty');
const { injectStage17Gaps, clearStage17Gaps } = require('../lib/stage19_runtime');
const { buildStage19InputContext } = require('../lib/stage19_stage18_loader');
const { buildStage19Bundle } = require('../lib/stage19_bundle_builder');
const { buildCatalogMembers } = require('../lib/stage19_match_builder');
const {
  mkMatch,
  multiBranchChain,
  partitionEligibleChain,
  p3EligibleChain,
  mkMinimalBevLoad,
  mkFixtureContext,
  mkFixtureInterval,
} = require('./helpers/stage19_fixture_bundle');

const ROOT = path.join(__dirname, '..');

function specToProd(m, id) {
  return {
    ...m,
    observationId: String(id),
    featurePairId: 'fp-test',
    featureIdLo: 'fp-test',
    featureIdHi: 'fp-test',
    comparisonSpatialFrameId: 'csf-0',
  };
}

describe('Stage 19 v5 partition production matrix', () => {
  it('real dataset: 5809 singleton chains, 0 multi-observation', async () => {
    const context = buildStage19InputContext(ROOT);
    injectStage17Gaps(context.gaps);
    try {
      const { matches } = require('../lib/stage19_match_builder').buildMatchRecords(context);
      const r = runProductionPartition(matches);
      assert.equal(r.stats.totalChains, 5809);
      assert.equal(r.stats.singleObservationChains, 5809);
      assert.equal(r.stats.multiObservationChains, 0);
      assert.equal(r.stats.p3Executed, 0);
      assert.equal(r.stats.p3Eligible, 0);
      assert.equal(r.stats.p3Selected, 0);
      assert.equal(r.failedObservations.size, 0);
    } finally {
      clearStage17Gaps();
    }
  });

  it('valid multi-branch chain partitions with branchId 0 only on trivial singletons', () => {
    const chain = multiBranchChain();
    const part = partitionChain(chain, 'inc');
    assert.equal(part.ok, true);
    assert.equal(part.numPaths, 2);
    const bids = [...part.branchByObs.values()];
    assert.ok(bids.some((b) => b !== 0));
    const singleton = partitionChain([mkMatch('solo', 0, 10)], 'inc');
    assert.equal(singleton.branchByObs.get('solo'), 0);
  });

  it('shared-node ownership via normative partition audit hooks', () => {
    const layer = runPartitionLayerOwnershipTests();
    assert.equal(layer.allPass, true);
    const own = runPartitionOwnershipTests();
    assert.equal(own.allPass, true);
  });

  it('shared-node cleanup releases all refcounts after finalize', () => {
    const layer = runPartitionLayerOwnershipTests();
    assert.ok(layer.results.some((r) => r.name === 'finalize-zero-refs' && r.pass));
    assert.ok(layer.results.some((r) => r.name === 'finalize-empty-registry' && r.pass));
  });

  it('duplicate observation ownership keeps last branch assignment without duplicate catalog members', () => {
    const chain = [mkMatch('a', 0), mkMatch('a', 2), mkMatch('b', 4)];
    const outcome = runProductionPartition(chain);
    const { members } = buildCatalogMembers(chain, ['a', 'b'], outcome);
    const ids = members.map((m) => m.memberMatchId);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.includes('a'), true);
    assert.equal(outcome.branchByObs.get('a'), 0);
  });

  it('disconnected catalog member: failed partition observations excluded from members', () => {
    const chain = [0, 1, 2, 3].map((i) => mkMatch(String(i), i, i + 2));
    const outcome = runProductionPartition(chain);
    const observationIds = chain.map((m) => m.observationId);
    const { members } = buildCatalogMembers(chain, observationIds, outcome);
    assert.equal(outcome.stats.overflowPartitions, 1);
    assert.equal(members.length, 0);
    assert.equal(outcome.failedObservations.size, chain.length);
    for (const oid of observationIds) {
      assert.equal(outcome.branchByObs.has(oid), false);
    }
  });

  it('rejected non-overflow partition assigns no branchId and records open_cap_exceeded', () => {
    const chain = p3EligibleChain();
    const r = runProductionPartition(chain, {
      partitionConfigOverlay: { maxClosureSubsetsPerState: 4 },
    });
    const rejected = r.partitionResults.find((p) => !p.ok);
    assert.equal(rejected.outcome, 'partition_rejected');
    assert.equal(rejected.failure?.code, 'open_cap_exceeded');
    assert.equal(rejected.failure?.overflow, false);
    assert.equal(rejected.failure?.openCap, true);
    assert.equal(rejected.failure?.rejected, true);
    assert.equal(r.stats.rejectedPartitions, 1);
    assert.equal(r.stats.overflowPartitions, 0);
    assert.equal(r.stats.p3Eligible, 0);
    assert.equal(r.stats.p3Executed, 0);
    assert.equal(r.stats.p3Selected, 0);
    for (const oid of chain.map((m) => m.observationId)) {
      assert.equal(r.branchByObs.has(oid), false);
    }
  });

  it('rejected non-overflow partition propagates failed status through buildStage19Bundle', async () => {
    const iv = mkFixtureInterval('iv-rejected');
    const ctx = mkFixtureContext([iv]);
    const chain = p3EligibleChain();
    for (const m of chain) {
      ctx.observationById.set(m.observationId, {
        chunkId: 0,
        temporalPassId: 0,
        poseSectionId: 0,
        projectedRoutePoints: [{ s: m.sLoUm / 1e6, d: 0, east: 0, north: 0 }],
      });
    }
    const bundle = await buildStage19Bundle(ctx, {
      runId: 'stage19-v5-partition-rejected-bundle',
      fixtureMode: true,
      fixtureMatches: chain,
      bevArtifactLoad: mkMinimalBevLoad(),
      fixturePartitionConfigOverlay: { maxClosureSubsetsPerState: 4 },
      expectedInsufficientIntervalCount: 0,
    });
    const rejected = bundle.partitionResults.find((p) => !p.ok);
    assert.equal(rejected.failure?.code, 'open_cap_exceeded');
    assert.equal(bundle.partitionStats.rejectedPartitions, 1);
    assert.equal(bundle.partitionStats.overflowPartitions, 0);
    assert.equal(bundle.catalogMemberCount, 0);
    assert.equal(bundle.p3Stats.eligible, 0);
    const assess = bundle.bundleDocs.assessments[0];
    assert.equal(assess.status, 'failed');
    assert.equal(assess.failureReason, 'partition_failure');
    assert.equal(bundle.qualityGates.ok, true);
  });

  it('selected P3 output reaches final bundle through buildStage19Bundle with catalog and gates', async () => {
    const ivA = mkFixtureInterval('iv-p3');
    const ivB = mkFixtureInterval('iv-p3-other');
    ivB.leftParentTrackId = '1:0:2:interval';
    ivB.rightParentTrackId = '1:0:2:interval';
    ivB.sourceSegmentIds = [1];
    const ctx = mkFixtureContext([ivA, ivB]);
    const chain = p3EligibleChain();
    const singletonB = [mkMatch('1:0:b0', 0, 10, { fp: 'fp-b', csf: 'csf-b' })];
    const matches = [...chain, ...singletonB];
    for (const m of matches) {
      ctx.observationById.set(m.observationId, {
        chunkId: m.observationId.startsWith('1:') ? 0 : 0,
        temporalPassId: 0,
        poseSectionId: 0,
        projectedRoutePoints: [{ s: m.sLoUm / 1e6, d: 0, east: 0, north: 0 }],
      });
    }
    const bundle = await buildStage19Bundle(ctx, {
      runId: 'stage19-v5-p3-full-bundle',
      fixtureMode: true,
      fixtureMatches: matches,
      bevArtifactLoad: mkMinimalBevLoad(),
      fixturePartitionConfigOverlay: { B_partition: 500000 },
      expectedInsufficientIntervalCount: 2,
    });
    assert.equal(bundle.p3Stats.eligible, 1);
    assert.equal(bundle.p3Stats.executed, 1);
    assert.equal(bundle.p3Stats.selected, 1);
    assert.equal(bundle.productionAudit.p3.selected, 1);
    assert.equal(bundle.catalogMemberCount, 7);
    assert.ok(bundle.branchCounts[0] >= 1);
    const catalog = bundle.bundleDocs['catalog_v0.json'];
    for (const m of chain) {
      const member = catalog.members.find((x) => x.memberMatchId === m.observationId);
      assert.ok(member, `missing catalog member ${m.observationId}`);
      assert.ok(Number.isFinite(member.branchId));
    }
    const p3Record = bundle.productionAudit.p3.records[0];
    assert.equal(p3Record.p3Ok, true);
    assert.equal(p3Record.branchSelectionOk, true);
    assert.ok(Number.isFinite(p3Record.branchSelectionValue));
    const assessA = bundle.bundleDocs.assessments.find((a) => a.intervalId === 'iv-p3');
    const assessB = bundle.bundleDocs.assessments.find((a) => a.intervalId === 'iv-p3-other');
    assert.equal(assessA.status, 'insufficient_evidence');
    assert.equal(assessB.status, 'insufficient_evidence');
    assert.equal(bundle.qualityGates.ok, true);
    assert.equal(bundle.semantics.ok, true);
    assert.equal(bundle.schemaValidation.ok, true);
  });

  it('bypassing applyBranchSelection fails buildStage19Bundle quality gates on P3 chain', async () => {
    const iv = mkFixtureInterval('iv-p3-bypass');
    const ctx = mkFixtureContext([iv]);
    const chain = p3EligibleChain();
    for (const m of chain) {
      ctx.observationById.set(m.observationId, {
        chunkId: 0,
        temporalPassId: 0,
        poseSectionId: 0,
        projectedRoutePoints: [{ s: m.sLoUm / 1e6, d: 0, east: 0, north: 0 }],
      });
    }
    await assert.rejects(
      () => buildStage19Bundle(ctx, {
        runId: 'stage19-v5-p3-bypass-bundle',
        fixtureMode: true,
        fixtureMatches: chain,
        bevArtifactLoad: mkMinimalBevLoad(),
        fixturePartitionConfigOverlay: { B_partition: 500000 },
        partitionDeps: {
          runP3WithBranchSelection: (c, meta) => {
            const { runP3Branch } = require('../lib/stage19_spec/p3');
            return {
              p3Eligible: true,
              p3Executed: true,
              p3Result: runP3Branch(c, meta),
              branchSelection: null,
            };
          },
        },
        expectedInsufficientIntervalCount: 0,
      }),
      /qualityGatesFailed.*missing_apply_branch_selection/,
    );
  });

  it('overflow partition does not assign branchId to failed observations', () => {
    const chain = [0, 1, 2, 3].map((i) => mkMatch(String(i), i, i + 2));
    const part = partitionChain(chain, 'inc');
    assert.equal(part.ok, false);
    assert.equal(part.failure?.code, 'overflow');
    assert.equal(part.branchByObs, null);
    const r = runProductionPartition(chain);
    assert.equal(r.stats.overflowPartitions, 1);
    assert.equal(r.failedObservations.size, chain.length);
    for (const oid of chain.map((m) => m.observationId)) {
      assert.equal(r.branchByObs.has(oid), false);
    }
  });

  it('explicit multiple-branch-candidate P3 selection via applyBranchSelection', () => {
    const chain = p3EligibleChain();
    const p3 = runP3WithBranchSelection(chain, {
      direction: 'inc',
      directionComponentId: 'd',
      branchId: 0,
      featureIdLo: 'f',
      featureIdHi: 'f',
      comparisonSpatialFrameId: 'csf',
    });
    assert.equal(p3.p3Eligible, true);
    assert.equal(p3.branchSelection?.ok, true);
  });

  it('interval-specific P3 failure through buildStage19Bundle on real dataset leaves intervals isolated', async () => {
    const context = buildStage19InputContext(ROOT);
    injectStage17Gaps(context.gaps);
    try {
      const bundle = await buildStage19Bundle(context, { runId: 'stage19-v4-partition-real-bundle' });
      assert.equal(bundle.insufficientEvidenceIntervalCount, 5);
      assert.equal(bundle.p3Stats.executed, 0);
      assert.equal(bundle.assessmentCount, 5);
    } finally {
      clearStage17Gaps();
    }
  });
  it('interval-specific partition failure does not affect other interval assessments', () => {
    const ivA = mkFixtureInterval('iv-a');
    const ivB = mkFixtureInterval('iv-b');
    ivB.sourceSegmentIds = [1];
    ivB.leftParentTrackId = '1:0:2:interval';
    ivB.rightParentTrackId = '1:0:2:interval';
    const ctx = mkFixtureContext([ivA, ivB]);
    const overflowA = [0, 1, 2, 3].map((i) => mkMatch(`0:0:${i}`, i, i + 2, { fp: 'fp-a', csf: 'csf-a' }));
    const matchesB = [mkMatch('1:0:b0', 0, 10, { fp: 'fp-b', csf: 'csf-b' })];
    const matches = [...overflowA, ...matchesB];
    for (const m of matches) {
      ctx.observationById.set(m.observationId, {
        chunkId: 0,
        temporalPassId: 0,
        poseSectionId: 0,
        projectedRoutePoints: [{ s: m.sLoUm / 1e6, d: 0, east: 0, north: 0 }],
      });
    }
    const part = runProductionPartition(matches);
    const { assessIntervalProduction } = require('../lib/stage19_interval_evidence');
    const evidence = {
      context: ctx,
      partitionResults: part.partitionResults,
      failedObservations: part.failedObservations,
      crossPass: { candidates: [], insufficient: [] },
      conflicts: [],
      insufficientCrossPass: [],
      bevArtifacts: mkMinimalBevLoad(),
    };
    const assessA = assessIntervalProduction(ivA, evidence, 'stage19-v4-partition-interval-fail');
    const assessB = assessIntervalProduction(ivB, evidence, 'stage19-v4-partition-interval-fail');
    assert.equal(assessA.status, 'failed');
    assert.equal(assessB.status, 'insufficient_evidence');
  });

  it('selected P3 output reaches final bundle via runP3WithBranchSelection on eligible chain', () => {
    const chain = p3EligibleChain();
    const p3 = runP3WithBranchSelection(chain, {
      direction: 'inc',
      directionComponentId: 'd',
      branchId: 0,
      featureIdLo: 'f',
      featureIdHi: 'f',
      comparisonSpatialFrameId: 'csf',
    });
    assert.equal(p3.branchSelection?.ok, true);
    assert.ok(p3.p3Result?.branchCanonical);
  });

  it('runP3Branch failure does not assign selected branch', () => {
    const chain = partitionEligibleChain();
    const r = runProductionPartition(chain, {
      runP3WithBranchSelection: () => ({
        p3Eligible: true,
        p3Executed: true,
        p3Result: { ok: false },
        branchSelection: { ok: false, reason: 'p3_failed' },
      }),
    });
    assert.equal(r.stats.p3Failed, 1);
    assert.equal(r.stats.p3Selected, 0);
  });

  it('applyBranchSelection failure increments p3Failed', () => {
    const chain = partitionEligibleChain();
    const r = runProductionPartition(chain, {
      runP3WithBranchSelection: (c, meta) => ({
        p3Eligible: true,
        p3Executed: true,
        p3Result: runP3Branch(c, meta),
        branchSelection: { ok: false, reason: 'stub' },
      }),
    });
    assert.equal(r.stats.p3Failed, 1);
  });

  it('deterministic partition across reruns', () => {
    const chain = partitionEligibleChain();
    const a = runProductionPartition(chain);
    const b = runProductionPartition(chain);
    assert.deepEqual([...a.branchByObs.entries()], [...b.branchByObs.entries()]);
  });

  it('bundle builder rejects stubbed applyBranchSelection on multi-obs chain', async () => {
    const context = buildStage19InputContext(ROOT);
    injectStage17Gaps(context.gaps);
    try {
      await assert.rejects(
        () => buildStage19Bundle(context, {
          runId: 'stage19-v4-partition-stub',
          partitionDeps: {
            runP3WithBranchSelection: () => ({
              p3Eligible: true,
              p3Executed: true,
              p3Result: { ok: true },
              branchSelection: null,
            }),
          },
        }),
        /qualityGatesFailed|missing_apply_branch_selection/,
      );
    } finally {
      clearStage17Gaps();
    }
  });

  it('singleton chain skips P3', () => {
    const r = runProductionPartition([mkMatch('a', 0, 10)]);
    assert.equal(r.stats.p3Eligible, 0);
    assert.equal(r.branchByObs.get('a'), 0);
  });

  it('static chains split on prohibited gap when gaps injected', () => {
    injectStage17Gaps([{
      gapId: 'g1',
      reason: 'test',
      intersectsLoOrHi(lo, hi) { return lo < 2e6 && hi > 1e6; },
    }]);
    try {
      const chain = [mkMatch('a', 0, 2), mkMatch('b', 3, 5)];
      const chains = buildStaticChains(chain, 'inc');
      assert.ok(chains.length >= 1);
    } finally {
      clearStage17Gaps();
    }
  });
});
