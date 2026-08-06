'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  validateManifest,
  validateManifestOrdering,
} = require('../lib/stage20_b_motion_manifest_validate');
const {
  blindPairForReview,
  validateReviewRecord,
  validateReviewCollection,
  buildReviewRecord,
} = require('../lib/stage20_b_motion_review_validate');
const { buildMeasurementFingerprint } = require('../lib/stage20_b_motion_review_fingerprint');
const {
  emptyReviewsArtifact,
  upsertReview,
  loadReviewsArtifact,
  saveReviewsArtifact,
} = require('../lib/stage20_b_motion_review_store');
const { buildReviewBatches } = require('../lib/stage20_b_motion_review_batches');
const {
  assignCalibrationValidationSplit,
  verifyNoClusterLeakage,
} = require('../lib/stage20_b_motion_review_split');
const { buildProgressReport } = require('../lib/stage20_b_motion_review_progress');
const { MANIFEST_SCHEMA_VERSION } = require('../lib/stage20_b_motion_review_constants');

function makePair(overrides = {}) {
  const base = {
    reviewPairId: '0:0:100:0|0:0:200:0',
    observationIdA: '0:0:100:0',
    observationIdB: '0:0:200:0',
    segmentId: 0,
    parentTrackId: '0:0:0:1',
    temporalPassIdA: 0,
    temporalPassIdB: 0,
    chunkIdA: 0,
    chunkIdB: 0,
    poseSectionIdA: 0,
    poseSectionIdB: 0,
    logMonoTimeA: '100',
    logMonoTimeB: '200',
    deltaTimeS: 2,
    spatialM: 5,
    routeSGapM: 4,
    headingDiffDeg: 1,
    lateralDeltaM: 0.1,
    speedMps: 10,
    expectedMotionM: 20,
    poseDisplacementM: 19,
    residualAfterPoseM: 14,
    residualRouteSAfterSpeedM: 16,
    stage17GapIntersection: false,
    rev37StaticEdgePass: true,
    qlogReference: 'qlog_f449c_0.bz2',
    videoReference: 'qlog:qlog_f449c_0.bz2:modelV2',
    videoAvailableInWorkspace: false,
    ruleDerivedClassification: 'valid_same_track_continuation',
    stratificationBucket: 'clear_continuation',
    applicableRejectionConditions: [],
    reviewerLabel: null,
    reviewerNotes: null,
    reviewStatus: 'pending',
    evidenceProvenance: {
      source: 'test_fixture',
      labelMethod: 'rule_derived_not_manually_reviewed',
      generatedAt: '2026-07-28T00:00:00.000Z',
    },
  };
  return { ...base, ...overrides };
}

function makeManifest(pairs) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    reviewPairCount: pairs.length,
    reviewPairs: pairs,
  };
}

describe('B-MOTION manifest validation', () => {
  it('accepts valid fixture manifest', () => {
    const manifest = makeManifest([makePair(), makePair({
      reviewPairId: '0:0:300:0|0:0:400:0',
      observationIdA: '0:0:300:0',
      observationIdB: '0:0:400:0',
      segmentId: 0,
      spatialM: 10,
    })]);
    const result = validateManifest(manifest, { root: process.cwd() });
    assert.equal(result.ok, true);
    assert.equal(result.pairCount, 2);
  });

  it('detects duplicate reviewPairId (B-MR-001)', () => {
    const pair = makePair();
    const result = validateManifest(makeManifest([pair, { ...pair }]));
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === 'B-MR-001'));
  });

  it('detects reversed duplicate pair (B-MR-002)', () => {
    const a = makePair();
    const b = makePair({
      reviewPairId: '0:0:200:0|0:0:100:0',
      observationIdA: '0:0:200:0',
      observationIdB: '0:0:100:0',
    });
    const result = validateManifest(makeManifest([a, b]));
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === 'B-MR-002'));
  });

  it('detects self-pair (B-MR-003)', () => {
    const pair = makePair({
      reviewPairId: '0:0:100:0|0:0:100:0',
      observationIdB: '0:0:100:0',
    });
    const result = validateManifest(makeManifest([pair]));
    assert.ok(result.issues.some((i) => i.code === 'B-MR-003'));
  });

  it('detects ordering violation (B-MR-012)', () => {
    const issues = validateManifestOrdering([
      makePair({ segmentId: 1, spatialM: 5 }),
      makePair({ segmentId: 0, spatialM: 1 }),
    ]);
    assert.ok(issues.some((i) => i.code === 'B-MR-012'));
  });

  it('rejects pre-filled reviewerLabel (B-MR-010)', () => {
    const pair = makePair({ reviewerLabel: 'positive_continuation' });
    const result = validateManifest(makeManifest([pair]));
    assert.ok(result.issues.some((i) => i.code === 'B-MR-010'));
  });
});

describe('B-MOTION review validation and blinding', () => {
  it('blinds rule-derived classification fields', () => {
    const pair = makePair();
    const blinded = blindPairForReview(pair);
    assert.equal(blinded.ruleDerivedClassification, undefined);
    assert.equal(blinded.stratificationBucket, undefined);
    assert.equal(blinded.reviewPairId, pair.reviewPairId);
  });

  it('rejects invalid reviewer label (B-MR-R001)', () => {
    const manifest = makeManifest([makePair()]);
    const pair = manifest.reviewPairs[0];
    const pairById = new Map([[pair.reviewPairId, pair]]);
    const issues = validateReviewRecord({
      reviewPairId: pair.reviewPairId,
      reviewerLabel: 'valid_same_track_continuation',
      reviewerId: 'r1',
      reviewedAt: '2026-07-28T00:00:00.000Z',
      evidenceMode: 'qlog_playback',
      observationIdA: pair.observationIdA,
      observationIdB: pair.observationIdB,
      measurementFingerprint: buildMeasurementFingerprint(pair),
      manifestVersion: MANIFEST_SCHEMA_VERSION,
    }, pairById);
    assert.ok(issues.some((i) => i.code === 'B-MR-R001'));
  });

  it('rejects positive label with insufficient evidence (B-MR-R007)', () => {
    const manifest = makeManifest([makePair()]);
    const pair = manifest.reviewPairs[0];
    const pairById = new Map([[pair.reviewPairId, pair]]);
    const issues = validateReviewRecord({
      reviewPairId: pair.reviewPairId,
      reviewerLabel: 'positive_continuation',
      reviewerId: 'r1',
      reviewedAt: '2026-07-28T00:00:00.000Z',
      evidenceMode: 'insufficient',
      observationIdA: pair.observationIdA,
      observationIdB: pair.observationIdB,
      measurementFingerprint: buildMeasurementFingerprint(pair),
      manifestVersion: MANIFEST_SCHEMA_VERSION,
    }, pairById);
    assert.ok(issues.some((i) => i.code === 'B-MR-R007'));
  });

  it('rejects changed endpoint identities (B-MR-R004)', () => {
    const manifest = makeManifest([makePair()]);
    const pair = manifest.reviewPairs[0];
    const pairById = new Map([[pair.reviewPairId, pair]]);
    const issues = validateReviewRecord({
      reviewPairId: pair.reviewPairId,
      reviewerLabel: 'negative_non_continuation',
      reviewerId: 'r1',
      reviewedAt: '2026-07-28T00:00:00.000Z',
      evidenceMode: 'qlog_playback',
      observationIdA: '9:9:9:9',
      observationIdB: pair.observationIdB,
      measurementFingerprint: buildMeasurementFingerprint(pair),
      manifestVersion: MANIFEST_SCHEMA_VERSION,
    }, pairById);
    assert.ok(issues.some((i) => i.code === 'B-MR-R004'));
  });

  it('rejects fingerprint mismatch (B-MR-R008)', () => {
    const manifest = makeManifest([makePair()]);
    const pair = manifest.reviewPairs[0];
    const pairById = new Map([[pair.reviewPairId, pair]]);
    const issues = validateReviewRecord({
      reviewPairId: pair.reviewPairId,
      reviewerLabel: 'negative_non_continuation',
      reviewerId: 'r1',
      reviewedAt: '2026-07-28T00:00:00.000Z',
      evidenceMode: 'qlog_playback',
      observationIdA: pair.observationIdA,
      observationIdB: pair.observationIdB,
      measurementFingerprint: 'deadbeef',
      manifestVersion: MANIFEST_SCHEMA_VERSION,
    }, pairById);
    assert.ok(issues.some((i) => i.code === 'B-MR-R008'));
  });
});

describe('B-MOTION review store resume', () => {
  it('upserts and resumes without losing prior reviews', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmotion-'));
    const reviewsPath = path.join(tmp, 'reviews.json');
    const manifest = makeManifest([makePair(), makePair({
      reviewPairId: '0:0:300:0|0:0:400:0',
      observationIdA: '0:0:300:0',
      observationIdB: '0:0:400:0',
      spatialM: 8,
    })]);
    let artifact = emptyReviewsArtifact(manifest, 'manifest.json');

    const pair0 = manifest.reviewPairs[0];
    const first = upsertReview(artifact, manifest, {
      reviewPairId: pair0.reviewPairId,
      reviewerId: 'reviewer-a',
      reviewerLabel: 'negative_non_continuation',
      evidenceMode: 'qlog_playback',
      reviewerNotes: 'clear gap',
    });
    assert.equal(first.ok, true);
    saveReviewsArtifact(reviewsPath, artifact);

    artifact = loadReviewsArtifact(reviewsPath, manifest, 'manifest.json');
    const dup = upsertReview(artifact, manifest, {
      reviewPairId: pair0.reviewPairId,
      reviewerId: 'reviewer-a',
      reviewerLabel: 'positive_continuation',
      evidenceMode: 'qlog_playback',
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.error, 'duplicate_review');

    const pair1 = manifest.reviewPairs[1];
    const second = upsertReview(artifact, manifest, {
      reviewPairId: pair1.reviewPairId,
      reviewerId: 'reviewer-a',
      reviewerLabel: 'unresolved',
      evidenceMode: 'insufficient',
      reviewerNotes: 'missing context',
    });
    assert.equal(second.ok, true);
    saveReviewsArtifact(reviewsPath, artifact);

    const reloaded = loadReviewsArtifact(reviewsPath, manifest, 'manifest.json');
    assert.equal(reloaded.reviews.length, 2);
    const collection = validateReviewCollection(reloaded, manifest);
    assert.equal(collection.ok, true);
  });
});

describe('B-MOTION batching and split', () => {
  it('builds deterministic batches of 20-30 pairs', () => {
    const pairs = [];
    for (let i = 0; i < 55; i++) {
      pairs.push(makePair({
        reviewPairId: `0:0:${100 + i}:0|0:0:${200 + i}:0`,
        observationIdA: `0:0:${100 + i}:0`,
        observationIdB: `0:0:${200 + i}:0`,
        spatialM: i,
      }));
    }
    const batches = buildReviewBatches(pairs);
    assert.ok(batches.length >= 2);
    for (const b of batches) {
      assert.ok(b.pairCount >= 20 || b.batchIndex === batches.length - 1);
      assert.ok(b.pairCount <= 30);
    }
    const again = buildReviewBatches(pairs);
    assert.deepEqual(batches.map((b) => b.reviewPairIds), again.map((b) => b.reviewPairIds));
  });

  it('assigns leakage-safe calibration/validation split', () => {
    const pairs = [
      makePair({ parentTrackId: 'track-a' }),
      makePair({
        reviewPairId: '0:0:300:0|0:0:400:0',
        observationIdA: '0:0:300:0',
        observationIdB: '0:0:400:0',
        parentTrackId: 'track-a',
        spatialM: 8,
      }),
      makePair({
        reviewPairId: '1:0:100:0|1:0:200:0',
        observationIdA: '1:0:100:0',
        observationIdB: '1:0:200:0',
        segmentId: 1,
        parentTrackId: 'track-b',
        spatialM: 15,
      }),
    ];
    const split = assignCalibrationValidationSplit(pairs);
    assert.ok(split.calibrationPairCount + split.validationPairCount === pairs.length);
    assert.ok(verifyNoClusterLeakage(split));
    const again = assignCalibrationValidationSplit(pairs);
    assert.deepEqual(split.calibrationPairIds, again.calibrationPairIds);
  });
});

describe('B-MOTION progress and calibration blocking', () => {
  it('keeps thresholdCalibrationBlocked true until gates satisfied', () => {
    const manifest = makeManifest([makePair()]);
    const artifact = emptyReviewsArtifact(manifest, 'manifest.json');
    let progress = buildProgressReport(manifest, artifact);
    assert.equal(progress.thresholdCalibrationBlocked, true);
    assert.ok(progress.remaining.reviewedPairs > 0);

    const pair = manifest.reviewPairs[0];
    upsertReview(artifact, manifest, {
      reviewPairId: pair.reviewPairId,
      reviewerId: 'r1',
      reviewerLabel: 'positive_continuation',
      evidenceMode: 'qlog_playback',
    });
    progress = buildProgressReport(manifest, artifact);
    assert.equal(progress.positive, 1);
    assert.equal(progress.thresholdCalibrationBlocked, true);
  });
});

describe('B-MOTION real manifest validation', () => {
  it('validates production review manifest structure', () => {
    const manifestPath = path.join(__dirname, '..', 'deliverables', 'stage20-b-motion-evidence-review-manifest.json');
    if (!fs.existsSync(manifestPath)) return;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const result = validateManifest(manifest, { root: path.join(__dirname, '..') });
    assert.equal(result.pairCount, 220);
    assert.equal(result.ok, true, JSON.stringify(result.issues.slice(0, 5)));
  });
});

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: JSON.parse(body) });
      });
    }).on('error', reject);
  });
}

describe('B-MOTION review server /api/pair/next routing', () => {
  let server;
  let port;
  let reviewsPath;
  let app;

  before(async () => {
    reviewsPath = path.join(os.tmpdir(), `bmotion-server-test-${Date.now()}.json`);
    process.env.B_MOTION_REVIEWS_PATH = reviewsPath;
    const serverModulePath = require.resolve('../scripts/stage20_b_motion_review_server');
    delete require.cache[serverModulePath];
    app = require('../scripts/stage20_b_motion_review_server');
    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => resolve(srv));
    });
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (fs.existsSync(reviewsPath)) fs.unlinkSync(reviewsPath);
    delete process.env.B_MOTION_REVIEWS_PATH;
    delete require.cache[require.resolve('../scripts/stage20_b_motion_review_server')];
  });

  it('fresh reviewer loads first pair from batch-01', async () => {
    const reviewerId = `test-fresh-${Date.now()}`;
    const res = await httpGet(port, `/api/pair/next?reviewerId=${encodeURIComponent(reviewerId)}&batchId=batch-01`);
    assert.equal(res.status, 200);
    assert.equal(res.body.done, false);
    assert.ok(res.body.reviewPairId);
    const batches = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'deliverables', 'stage20-b-motion-review-batches.json'),
      'utf8',
    ));
    const batch01 = batches.batches.find((b) => b.batchId === 'batch-01');
    assert.ok(batch01.reviewPairIds.includes(res.body.reviewPairId));
    assert.equal(res.body.reviewPairId, batch01.reviewPairIds[0]);
  });

  it('all batches scope returns a pending pair for fresh reviewer', async () => {
    const reviewerId = `test-all-${Date.now()}`;
    const res = await httpGet(port, `/api/pair/next?reviewerId=${encodeURIComponent(reviewerId)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.done, false);
    assert.ok(res.body.reviewPairId);
  });

  it('missing reviews artifact does not cause pair_not_found on /api/pair/next', async () => {
    assert.equal(fs.existsSync(reviewsPath), false);
    const reviewerId = `test-no-artifact-${Date.now()}`;
    const res = await httpGet(port, `/api/pair/next?reviewerId=${encodeURIComponent(reviewerId)}&batchId=batch-01`);
    assert.equal(res.status, 200);
    assert.notEqual(res.body.error, 'pair_not_found');
    assert.equal(res.body.done, false);
  });

  it('pair_not_found only for unknown pair id; exhausted scope returns done not pair_not_found', async () => {
    const unknown = await httpGet(port, '/api/pair/unknown-pair-id');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, 'pair_not_found');

    const reviewerId = `test-exhausted-${Date.now()}`;
    const batches = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'deliverables', 'stage20-b-motion-review-batches.json'),
      'utf8',
    ));
    const batch01 = batches.batches.find((b) => b.batchId === 'batch-01');
    for (const reviewPairId of batch01.reviewPairIds) {
      const body = JSON.stringify({
        reviewPairId,
        reviewerId,
        reviewerLabel: 'unresolved',
        evidenceMode: 'insufficient',
        reviewerNotes: 'exhaust test',
      });
      const postRes = await httpPost(port, '/api/review', body);
      assert.equal(postRes.status, 200);
    }

    const exhausted = await httpGet(
      port,
      `/api/pair/next?reviewerId=${encodeURIComponent(reviewerId)}&batchId=batch-01`,
    );
    assert.equal(exhausted.status, 200);
    assert.equal(exhausted.body.done, true);
    assert.equal(exhausted.body.reviewPairId, null);
    assert.notEqual(exhausted.body.error, 'pair_not_found');
  });
});

function httpPost(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
