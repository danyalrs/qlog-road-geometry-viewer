'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  detectProductionConflicts,
  buildHeadingForCandidates,
  buildCrossPassCandidates,
} = require('../lib/stage19_cross_pass_production');
const { buildStage19InputContext } = require('../lib/stage19_stage18_loader');
const { injectStage17Gaps, clearStage17Gaps } = require('../lib/stage19_runtime');
const { buildStage19Bundle } = require('../lib/stage19_bundle_builder');
const { validateProductionQualityGates } = require('../lib/stage19_quality_gates');
const {
  mkMatch,
  mkMinimalBevLoad,
  mkFixtureContext,
  mkFixtureInterval,
  crossPassCandidate,
} = require('./helpers/stage19_fixture_bundle');

const ROOT = path.join(__dirname, '..');

function populateObservations(ctx, matches, interval) {
  for (const m of matches) {
    ctx.observationById.set(m.observationId, {
      chunkId: interval.chunkId ?? 0,
      temporalPassId: interval.temporalPassId ?? 0,
      poseSectionId: interval.poseSectionId ?? 0,
      projectedRoutePoints: [{ s: m.sLoUm / 1e6, d: 0, east: 0, north: 0 }],
    });
  }
}

describe('Stage 19 v5 full-bundle conflict matrix', () => {
  it('real dataset bundle: 0 candidates, unavailable evidence, 5 insufficient intervals', async () => {
    const context = buildStage19InputContext(ROOT);
    injectStage17Gaps(context.gaps);
    try {
      const bundle = await buildStage19Bundle(context, { runId: 'stage19-v4-conflict-real' });
      assert.equal(bundle.crossPassCandidateCount, 0);
      assert.equal(bundle.conflicts.length, 0);
      assert.equal(bundle.conflictEvidenceAvailable, false);
      assert.equal(bundle.insufficientEvidenceIntervalCount, 5);
      assert.equal(bundle.qualityGates.ok, true);
    } finally {
      clearStage17Gaps();
    }
  });

  it('same-pass evidence pair is rejected and cannot be published through buildStage19Bundle', async () => {
    const iv = mkFixtureInterval('iv-same-pass');
    const ctx = mkFixtureContext([iv]);
    const matches = [mkMatch('a', 0, 5, { heading: 5, eu: '0:0' }), mkMatch('b', 0, 5, { heading: 50, eu: '0:1' })];
    populateObservations(ctx, matches, iv);
    const c = {
      ...crossPassCandidate(0, 1, 'a', 'b', '0:0', '0:1'),
      featurePairId: 'fp-same-pass',
      temporalPassIdLo: '0',
      temporalPassIdHi: '0',
    };
    const { detectProductionConflicts, buildHeadingForCandidates } = require('../lib/stage19_cross_pass_production');
    const { headingByPairId } = buildHeadingForCandidates([c], matches);
    const detected = detectProductionConflicts([c], headingByPairId);
    assert.ok(detected.insufficient.some((i) => i.reason === 'same_pass_rejected'));
    assert.equal(detected.conflicts.length, 0);
    await assert.rejects(
      () => buildStage19Bundle(ctx, {
        runId: 'stage19-v5-conflict-same-pass',
        fixtureMode: true,
        fixtureMatches: matches,
        crossPassInject: { candidates: [c], insufficient: [] },
        bevArtifactLoad: mkMinimalBevLoad(),
        expectedInsufficientIntervalCount: 1,
      }),
      /qualityGatesFailed.*cross_pass_self_pair|semanticValidationFailed/,
    );
  });

  it('self-pair cross-pass candidate fails publication-quality gates', async () => {
    const iv = mkFixtureInterval('iv-self-pair');
    const ctx = mkFixtureContext([iv]);
    const matches = [mkMatch('a', 0, 5, { heading: 5, eu: '0:0' }), mkMatch('b', 0, 5, { heading: 50, eu: '0:1' })];
    populateObservations(ctx, matches, iv);
    const c = { ...crossPassCandidate(0, 0, 'a', 'b', '0:0', '0:1'), featurePairId: 'fp-self-pair' };
    await assert.rejects(
      () => buildStage19Bundle(ctx, {
        runId: 'stage19-v5-conflict-self-pair',
        fixtureMode: true,
        fixtureMatches: matches,
        crossPassInject: { candidates: [c], insufficient: [] },
        bevArtifactLoad: mkMinimalBevLoad(),
        expectedInsufficientIntervalCount: 1,
      }),
      /qualityGatesFailed.*cross_pass_self_pair/,
    );
  });

  it('repeated evidence unit is rejected and cannot be published through buildStage19Bundle', async () => {
    const iv = mkFixtureInterval('iv-repeated-eu');
    const ctx = mkFixtureContext([iv]);
    const matches = [mkMatch('a', 0, 5, { heading: 359, eu: '0:0' }), mkMatch('b', 0, 5, { heading: 1, eu: '0:1' })];
    populateObservations(ctx, matches, iv);
    const c = { ...crossPassCandidate(0, 1, 'a', 'b', '0:0', '0:0'), featurePairId: 'fp-repeated-eu' };
    const { detectProductionConflicts, buildHeadingForCandidates } = require('../lib/stage19_cross_pass_production');
    const { headingByPairId } = buildHeadingForCandidates([c], matches);
    const detected = detectProductionConflicts([c], headingByPairId);
    assert.ok(detected.insufficient.some((i) => i.reason === 'repeated_evidence_unit'));
    assert.equal(detected.conflicts.length, 0);
    await assert.rejects(
      () => buildStage19Bundle(ctx, {
        runId: 'stage19-v5-conflict-repeated-eu',
        fixtureMode: true,
        fixtureMatches: matches,
        crossPassInject: { candidates: [c], insufficient: [] },
        bevArtifactLoad: mkMinimalBevLoad(),
        expectedInsufficientIntervalCount: 1,
      }),
      /qualityGatesFailed.*cross_pass_same_evidence_unit/,
    );
  });

  it('duplicated provenance pair cannot be published through buildStage19Bundle', async () => {
    const iv = mkFixtureInterval('iv-dup-prov');
    const ctx = mkFixtureContext([iv]);
    const matches = [mkMatch('a', 0, 5, { heading: 359, eu: '0:0' }), mkMatch('b', 0, 5, { heading: 1, eu: '0:1' })];
    populateObservations(ctx, matches, iv);
    const c = crossPassCandidate(0, 1, 'a', 'b', '0:0', '0:1');
    await assert.rejects(
      () => buildStage19Bundle(ctx, {
        runId: 'stage19-v5-conflict-dup-prov',
        fixtureMode: true,
        fixtureMatches: matches,
        crossPassInject: { candidates: [c, c], insufficient: [] },
        bevArtifactLoad: mkMinimalBevLoad(),
        expectedInsufficientIntervalCount: 0,
      }),
      /semanticValidationFailed.*duplicate_feature_pair_id|qualityGatesFailed/,
    );
  });

  it('invalid cross-pass evidence does not change another interval assessment', async () => {
    const ivA = mkFixtureInterval('iv-invalid-a');
    const ivB = mkFixtureInterval('iv-valid-b');
    ivB.leftParentTrackId = '1:0:2:interval';
    ivB.rightParentTrackId = '1:0:2:interval';
    const ctx = mkFixtureContext([ivA, ivB]);
    const matchesA = [mkMatch('a', 0, 5, { heading: 5, eu: '0:0' }), mkMatch('b', 0, 5, { heading: 50, eu: '0:1' })];
    const matchesB = [mkMatch('c', 0, 5, { heading: 359, eu: '1:0' }), mkMatch('d', 0, 5, { heading: 1, eu: '1:1' })];
    populateObservations(ctx, matchesA, ivA);
    populateObservations(ctx, matchesB, ivB);
    const validB = { ...crossPassCandidate(0, 1, 'c', 'd', '1:0', '1:1'), parentTrackId: ivB.leftParentTrackId };
    const bundleB = await buildStage19Bundle(ctx, {
      runId: 'stage19-v5-conflict-valid-b-only',
      fixtureMode: true,
      fixtureMatches: [...matchesA, ...matchesB],
      crossPassInject: { candidates: [validB], insufficient: [] },
      bevArtifactLoad: mkMinimalBevLoad(),
      expectedInsufficientIntervalCount: 1,
    });
    const assessB = bundleB.bundleDocs.assessments.find((a) => a.intervalId === 'iv-valid-b');
    assert.notEqual(assessB.status, 'conflict');
    assert.equal(bundleB.conflicts.length, 0);
    assert.equal(bundleB.conflictEvidenceAvailable, false);
    const invalidA = { ...crossPassCandidate(0, 0, 'a', 'b', '0:0', '0:1'), featurePairId: 'fp-invalid-a', parentTrackId: ivA.leftParentTrackId };
    await assert.rejects(
      () => buildStage19Bundle(ctx, {
        runId: 'stage19-v5-conflict-invalid-contaminate',
        fixtureMode: true,
        fixtureMatches: [...matchesA, ...matchesB],
        crossPassInject: { candidates: [invalidA, validB], insufficient: [] },
        bevArtifactLoad: mkMinimalBevLoad(),
        expectedInsufficientIntervalCount: 1,
      }),
      /qualityGatesFailed.*cross_pass_self_pair/,
    );
  });

  it('5 vs 50 conflict through full buildStage19Bundle path', async () => {
    const iv = mkFixtureInterval('iv-conflict');
    const ctx = mkFixtureContext([iv]);
    const matches = [mkMatch('a', 0, 5, { heading: 5, eu: '0:0' }), mkMatch('b', 0, 5, { heading: 50, eu: '0:1' })];
    populateObservations(ctx, matches, iv);
    const c = crossPassCandidate(0, 1, 'a', 'b', '0:0', '0:1');
    const bundle = await buildStage19Bundle(ctx, {
      runId: 'stage19-v4-conflict-5-50-bundle',
      fixtureMode: true,
      fixtureMatches: matches,
      crossPassInject: { candidates: [c], insufficient: [] },
      bevArtifactLoad: mkMinimalBevLoad(),
      expectedInsufficientIntervalCount: 0,
    });
    assert.equal(bundle.conflicts.length, 1);
    assert.equal(bundle.crossPassCandidateCount, 1);
    assert.equal(bundle.qualityGates.ok, true);
    assert.equal(bundle.bundleDocs.promotion.decisions[0].promotion, 'reject');
  });

  it('359 vs 1 agreement through full buildStage19Bundle path', async () => {
    const iv = mkFixtureInterval('iv-agree');
    const ctx = mkFixtureContext([iv]);
    const matches = [mkMatch('a', 0, 5, { heading: 359, eu: '0:0' }), mkMatch('b', 0, 5, { heading: 1, eu: '0:1' })];
    populateObservations(ctx, matches, iv);
    const c = crossPassCandidate(0, 1, 'a', 'b', '0:0', '0:1');
    const bundle = await buildStage19Bundle(ctx, {
      runId: 'stage19-v4-conflict-359-1-bundle',
      fixtureMode: true,
      fixtureMatches: matches,
      crossPassInject: { candidates: [c], insufficient: [] },
      bevArtifactLoad: mkMinimalBevLoad(),
      expectedInsufficientIntervalCount: 0,
    });
    assert.equal(bundle.conflicts.length, 0);
    assert.equal(bundle.crossPassCandidateCount, 1);
    assert.equal(bundle.conflictEvidenceAvailable, false);
    assert.equal(bundle.insufficientEvidenceIntervalCount, 0);
  });

  it('cross-interval contamination rejection: conflict in iv-a does not change iv-b assessment', async () => {
    const ivA = mkFixtureInterval('iv-a');
    const ivB = mkFixtureInterval('iv-b');
    ivB.leftParentTrackId = '1:0:2:interval';
    ivB.rightParentTrackId = '1:0:2:interval';
    const ctx = mkFixtureContext([ivA, ivB]);
    const matchesA = [mkMatch('a', 0, 5, { heading: 5, eu: '0:0' }), mkMatch('b', 0, 5, { heading: 50, eu: '0:1' })];
    const matchesB = [mkMatch('c', 0, 5, { heading: 10, eu: '1:0' })];
    populateObservations(ctx, matchesA, ivA);
    populateObservations(ctx, matchesB, ivB);
    const c = { ...crossPassCandidate(0, 1, 'a', 'b', '0:0', '0:1'), parentTrackId: ivA.leftParentTrackId };
    const bundle = await buildStage19Bundle(ctx, {
      runId: 'stage19-v4-conflict-cross-interval',
      fixtureMode: true,
      fixtureMatches: [...matchesA, ...matchesB],
      crossPassInject: { candidates: [c], insufficient: [] },
      bevArtifactLoad: mkMinimalBevLoad(),
      expectedInsufficientIntervalCount: 1,
    });
    const assessA = bundle.bundleDocs.assessments.find((a) => a.intervalId === 'iv-a');
    const assessB = bundle.bundleDocs.assessments.find((a) => a.intervalId === 'iv-b');
    assert.equal(bundle.conflicts.length, 1);
    assert.equal(assessA.status, 'conflict');
    assert.equal(assessB.status, 'insufficient_evidence');
  });

  it('unresolved observation foreign key yields insufficient cross-pass evidence not conflict', async () => {
    const iv = mkFixtureInterval('iv-fk-obs');
    const ctx = mkFixtureContext([iv]);
    const matches = [mkMatch('a', 0, 5, { heading: 5, eu: '0:0' })];
    populateObservations(ctx, matches, iv);
    const c = crossPassCandidate(0, 1, 'missing-obs', 'a', '0:0', '0:1');
    const bundle = await buildStage19Bundle(ctx, {
      runId: 'stage19-v4-conflict-fk-obs',
      fixtureMode: true,
      fixtureMatches: matches,
      crossPassInject: { candidates: [c], insufficient: [] },
      bevArtifactLoad: mkMinimalBevLoad(),
      expectedInsufficientIntervalCount: 0,
    });
    assert.equal(bundle.conflicts.length, 0);
    assert.ok(bundle.insufficientCrossPassCount >= 1);
    assert.equal(bundle.insufficientEvidenceIntervalCount, 0);
  });

  it('unresolved interval foreign key leaves interval without conflict contamination', async () => {
    const iv = mkFixtureInterval('iv-fk-interval');
    const ctx = mkFixtureContext([iv]);
    const matches = [mkMatch('a', 0, 5, { heading: 5, eu: '0:0' }), mkMatch('b', 0, 5, { heading: 50, eu: '0:1' })];
    populateObservations(ctx, matches, iv);
    const c = crossPassCandidate(0, 1, 'a', 'b', '0:0', '0:1');
    c.parentTrackId = 'missing-track';
    const bundle = await buildStage19Bundle(ctx, {
      runId: 'stage19-v4-conflict-fk-interval',
      fixtureMode: true,
      fixtureMatches: matches,
      crossPassInject: { candidates: [c], insufficient: [] },
      bevArtifactLoad: mkMinimalBevLoad(),
      expectedInsufficientIntervalCount: 1,
    });
    assert.equal(bundle.conflicts.length, 1);
    assert.equal(bundle.insufficientEvidenceIntervalCount, 1);
  });

  it('one-interval-only conflict propagation through promotion decisions', async () => {
    const ivA = mkFixtureInterval('iv-only-a');
    const ivB = mkFixtureInterval('iv-only-b');
    ivB.leftParentTrackId = '9:0:2:interval';
    ivB.rightParentTrackId = '9:0:2:interval';
    const ctx = mkFixtureContext([ivA, ivB]);
    const matchesA = [mkMatch('a', 0, 5, { heading: 5, eu: '0:0' }), mkMatch('b', 0, 5, { heading: 50, eu: '0:1' })];
    populateObservations(ctx, matchesA, ivA);
    const c = { ...crossPassCandidate(0, 1, 'a', 'b', '0:0', '0:1'), parentTrackId: ivA.leftParentTrackId };
    const bundle = await buildStage19Bundle(ctx, {
      runId: 'stage19-v4-conflict-one-interval',
      fixtureMode: true,
      fixtureMatches: matchesA,
      crossPassInject: { candidates: [c], insufficient: [] },
      bevArtifactLoad: mkMinimalBevLoad(),
      expectedInsufficientIntervalCount: 1,
    });
    const promoA = bundle.bundleDocs.promotion.decisions.find((d) => d.intervalId === 'iv-only-a');
    const promoB = bundle.bundleDocs.promotion.decisions.find((d) => d.intervalId === 'iv-only-b');
    assert.equal(promoA.promotion, 'reject');
    assert.equal(promoB.promotion, 'hold');
    assert.equal(bundle.conflicts.length, 1);
  });

  it('available evidence with zero conflict distinguishes from unavailable evidence', async () => {
    const iv = mkFixtureInterval('iv-zero-conflict-available');
    const ctx = mkFixtureContext([iv]);
    const matches = [mkMatch('a', 0, 5, { heading: 359, eu: '0:0' }), mkMatch('b', 0, 5, { heading: 1, eu: '0:1' })];
    populateObservations(ctx, matches, iv);
    const c1 = crossPassCandidate(0, 1, 'a', 'b', '0:0', '0:1');
    const c2 = crossPassCandidate(2, 3, 'a', 'b', '0:2', '0:3');
    const bundle = await buildStage19Bundle(ctx, {
      runId: 'stage19-v4-conflict-zero-available',
      fixtureMode: true,
      fixtureMatches: matches,
      crossPassInject: { candidates: [c1, c2], insufficient: [] },
      bevArtifactLoad: mkMinimalBevLoad(),
      expectedInsufficientIntervalCount: 0,
    });
    assert.equal(bundle.conflicts.length, 0);
    assert.equal(bundle.crossPassCandidateCount, 2);
    assert.equal(bundle.conflictEvidenceAvailable, true);
  });

  it('unavailable evidence with zero conflict on real dataset', async () => {
    const context = buildStage19InputContext(ROOT);
    injectStage17Gaps(context.gaps);
    try {
      const bundle = await buildStage19Bundle(context, { runId: 'stage19-v4-conflict-zero-unavailable' });
      assert.equal(bundle.conflicts.length, 0);
      assert.equal(bundle.crossPassCandidateCount, 0);
      assert.equal(bundle.conflictEvidenceAvailable, false);
    } finally {
      clearStage17Gaps();
    }
  });

  it('synthetic 5 vs 50 conflict through detectProductionConflicts', () => {
    const c = crossPassCandidate(0, 1, 'a', 'b', '0:0', '0:1');
    const matches = [mkMatch('a', 0, 5, { heading: 5, eu: '0:0' }), mkMatch('b', 0, 5, { heading: 50, eu: '0:1' })];
    const { headingByPairId } = buildHeadingForCandidates([c], matches);
    const r = detectProductionConflicts([c], headingByPairId);
    assert.equal(r.conflicts.length, 1);
  });

  it('quality gates reject conflict without candidates', () => {
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const gates = validateProductionQualityGates({
      catalog: { members: [] },
      crossPass: { pairs: [] },
      bev: { images: [{ mime: 'image/png', payloadPath: 'p', sha256: 'a'.repeat(64) }] },
      partitionResults: [],
      failedObservations: new Set(),
      crossPassCandidates: { candidates: [] },
      crossPassCandidateCount: 0,
      crossPassBundleCount: 0,
      conflicts: [{ featurePairId: 'x' }],
      assessments: [{ status: 'insufficient_evidence' }],
      sensitivityTable: { authorityNote: 'x' },
      partitionStats: { multiObservationChains: 0 },
      payloadFiles: {},
      expectedInsufficientIntervalCount: 5,
    }, {});
    assert.equal(gates.ok, false);
  });

  it('buildCrossPassCandidates on real data returns zero', () => {
    const context = buildStage19InputContext(ROOT);
    injectStage17Gaps(context.gaps);
    try {
      const { matches } = require('../lib/stage19_match_builder').buildMatchRecords(context);
      const cp = buildCrossPassCandidates(context, matches);
      assert.equal(cp.candidates.length, 0);
    } finally {
      clearStage17Gaps();
    }
  });
});
