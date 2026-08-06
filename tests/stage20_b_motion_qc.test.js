'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  QC_RECORD_INDICES,
  ensureQcBackup,
  initializeQcArtifact,
  loadOrInitializeQcArtifact,
  buildQcProgressReport,
  findNextQcRecordIndex,
  applyQcUpdate,
  verifyQcArtifact,
  buildQcChangeReport,
  isQcRecordIndex,
} = require('../lib/stage20_b_motion_review_qc');
const {
  emptyReviewsArtifact,
  saveReviewsArtifact,
  loadReviewsArtifact,
} = require('../lib/stage20_b_motion_review_store');
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
    ruleDerivedClassification: 'invalid_across_chunk_boundary',
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

function makeReviewRecord(pair, index, overrides = {}) {
  const { buildMeasurementFingerprint } = require('../lib/stage20_b_motion_review_fingerprint');
  return {
    reviewPairId: pair.reviewPairId,
    reviewerLabel: 'negative_non_continuation',
    reviewerId: 'reviewer-a',
    reviewedAt: '2026-07-28T00:00:00.000Z',
    evidenceMode: 'qlog_playback',
    reviewerNotes: `note for ${index}`,
    observationIdA: pair.observationIdA,
    observationIdB: pair.observationIdB,
    measurementFingerprint: buildMeasurementFingerprint(pair),
    manifestVersion: MANIFEST_SCHEMA_VERSION,
    sourcePairIndex: index,
    ...overrides,
  };
}

function buildFixtureArtifact(pairCount = 220) {
  const pairs = [];
  const reviews = [];
  for (let i = 0; i < pairCount; i++) {
    const pair = makePair({
      reviewPairId: `0:0:${100 + i}:0|0:0:${200 + i}:0`,
      observationIdA: `0:0:${100 + i}:0`,
      observationIdB: `0:0:${200 + i}:0`,
      spatialM: i,
    });
    pairs.push(pair);
    reviews.push(makeReviewRecord(pair, i));
  }
  const manifest = makeManifest(pairs);
  const artifact = emptyReviewsArtifact(manifest, 'manifest.json');
  artifact.reviews = reviews;
  return { manifest, artifact };
}

describe('B-MOTION QC mode', () => {
  it('defines 26 QC record indices', () => {
    assert.equal(QC_RECORD_INDICES.length, 26);
    assert.ok(isQcRecordIndex(22));
    assert.ok(!isQcRecordIndex(23));
  });

  it('creates backup before QC writes without overwriting existing backup', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmotion-qc-'));
    const source = path.join(tmp, 'source.json');
    const backup = path.join(tmp, 'backup.json');
    const { manifest, artifact } = buildFixtureArtifact(30);
    saveReviewsArtifact(source, artifact);

    const first = ensureQcBackup(source, backup);
    assert.equal(first.created, true);
    assert.ok(fs.existsSync(backup));

    const second = ensureQcBackup(source, backup);
    assert.equal(second.created, false);
  });

  it('initializes QC artifact from source without modifying source', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmotion-qc-'));
    const source = path.join(tmp, 'source.json');
    const qc = path.join(tmp, 'qc.json');
    const { manifest, artifact } = buildFixtureArtifact(30);
    saveReviewsArtifact(source, artifact);

    const loaded = loadOrInitializeQcArtifact(source, qc, manifest, 'manifest.json');
    assert.equal(loaded.reviews.length, 30);
    assert.equal(fs.existsSync(qc), false);
  });

  it('tracks QC progress and finds next pending record', () => {
    const { artifact } = buildFixtureArtifact(230);
    let progress = buildQcProgressReport(artifact);
    assert.equal(progress.qcTargetCount, 26);
    assert.equal(progress.qcReviewed, 0);
    assert.equal(progress.qcRemaining, 26);
    assert.equal(findNextQcRecordIndex(artifact), 22);

    artifact.reviews[22].qcReviewed = true;
    assert.equal(findNextQcRecordIndex(artifact), 25);

    progress = buildQcProgressReport(artifact);
    assert.equal(progress.qcReviewed, 1);
    assert.equal(progress.qcRemaining, 25);
  });

  it('applies QC update with audit fields and preserves all 220 records', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmotion-qc-'));
    const source = path.join(tmp, 'source.json');
    const qc = path.join(tmp, 'qc.json');
    const { manifest, artifact } = buildFixtureArtifact(220);
    saveReviewsArtifact(source, artifact);

    let qcArtifact = loadOrInitializeQcArtifact(source, qc, manifest, 'manifest.json');
    const originalLabel = qcArtifact.reviews[22].reviewerLabel;
    const originalNote = qcArtifact.reviews[22].reviewerNotes;

    const result = applyQcUpdate(qcArtifact, manifest, {
      recordIndex: 22,
      qcReviewer: 'qc-1',
      reviewerLabel: 'positive_continuation',
      reviewerNotes: 'QC corrected label',
      evidenceMode: 'qlog_playback',
    });
    assert.equal(result.ok, true);
    assert.equal(result.record.previousReviewerLabel, originalLabel);
    assert.equal(result.record.previousReviewerNote, originalNote);
    assert.equal(result.record.qcReviewed, true);
    assert.equal(result.record.qcReviewer, 'qc-1');
    assert.ok(result.record.qcReviewedAt);

    saveReviewsArtifact(qc, qcArtifact);
    qcArtifact = loadReviewsArtifact(qc, manifest, 'manifest.json');
    assert.equal(qcArtifact.reviews.length, 220);
    const verification = verifyQcArtifact(qcArtifact);
    assert.equal(verification.ok, true);
    assert.equal(verification.uniquePairIds, 220);

    const baseline = loadReviewsArtifact(source, manifest, 'manifest.json');
    const changes = buildQcChangeReport(qcArtifact, baseline);
    assert.equal(changes.changedRecordCount, 1);
    assert.equal(changes.changes[0].recordIndex, 22);
    assert.equal(changes.changes[0].labelChanged, true);
  });

  it('rejects updates outside QC scope', () => {
    const { manifest, artifact } = buildFixtureArtifact(30);
    const result = applyQcUpdate(artifact, manifest, {
      recordIndex: 10,
      qcReviewer: 'qc-1',
      reviewerLabel: 'unresolved',
      reviewerNotes: 'nope',
      evidenceMode: 'insufficient',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not_qc_record');
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

function httpPost(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('B-MOTION QC server endpoints', () => {
  let server;
  let port;
  let tmp;
  let sourcePath;
  let qcPath;
  let backupPath;
  let app;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmotion-qc-server-'));
    sourcePath = path.join(tmp, 'source-v1.json');
    qcPath = path.join(tmp, 'qc-v1.json');
    backupPath = path.join(tmp, 'before-qc.json');

    const v1Path = path.join(__dirname, '..', 'deliverables', 'stage20-b-motion-manual-reviews-v1.json');
    if (fs.existsSync(v1Path)) {
      fs.copyFileSync(v1Path, sourcePath);
    } else {
      const { manifest, artifact } = buildFixtureArtifact(220);
      saveReviewsArtifact(sourcePath, artifact);
    }

    process.env.B_MOTION_QC_SOURCE_PATH = sourcePath;
    process.env.B_MOTION_QC_REVIEWS_PATH = qcPath;
    process.env.B_MOTION_QC_BACKUP_PATH = backupPath;
    process.env.B_MOTION_REVIEWS_PATH = sourcePath;

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
    delete process.env.B_MOTION_QC_SOURCE_PATH;
    delete process.env.B_MOTION_QC_REVIEWS_PATH;
    delete process.env.B_MOTION_QC_BACKUP_PATH;
    delete process.env.B_MOTION_REVIEWS_PATH;
    delete require.cache[require.resolve('../scripts/stage20_b_motion_review_server')];
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns QC progress with 26 target records', async () => {
    const res = await httpGet(port, '/api/qc/progress');
    assert.equal(res.status, 200);
    assert.equal(res.body.qcTargetCount, 26);
    assert.equal(res.body.qcRemaining, 26);
  });

  it('opens first QC record even when batch is complete', async () => {
    const res = await httpGet(port, '/api/qc/next?qcReviewer=qc-test');
    assert.equal(res.status, 200);
    assert.equal(res.body.done, false);
    assert.equal(res.body.recordIndex, 22);

    const detail = await httpGet(port, '/api/qc/record/22?qcReviewer=qc-test');
    assert.equal(detail.status, 200);
    assert.equal(detail.body.recordIndex, 22);
    assert.ok(detail.body.existingReview);
    assert.ok(detail.body.pair);
    assert.equal(detail.body.existingReview.reviewerLabel, detail.body.existingReview.reviewerLabel);
  });

  it('saves QC update to qc artifact with backup and never overwrites source v1', async () => {
    const sourceBefore = fs.readFileSync(sourcePath, 'utf8');
    const existing = await httpGet(port, '/api/qc/record/22?qcReviewer=qc-test');
    const originalLabel = existing.body.existingReview.reviewerLabel;

    const post = await httpPost(port, '/api/qc/review', {
      recordIndex: 22,
      qcReviewer: 'qc-test',
      reviewerLabel: originalLabel,
      reviewerNotes: existing.body.existingReview.reviewerNotes,
      evidenceMode: existing.body.existingReview.evidenceMode,
    });
    assert.equal(post.status, 200);
    assert.equal(post.body.ok, true);
    assert.equal(post.body.record.qcReviewed, true);
    assert.equal(post.body.verification.reviewCount, 220);
    assert.equal(post.body.verification.uniquePairIds, 220);
    assert.ok(fs.existsSync(qcPath));
    assert.ok(fs.existsSync(backupPath));
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), sourceBefore);
  });
});

describe('B-MOTION production QC artifact integrity', () => {
  it('validates real v1 reviews have 220 unique pair IDs for QC baseline', () => {
    const v1Path = path.join(__dirname, '..', 'deliverables', 'stage20-b-motion-manual-reviews-v1.json');
    if (!fs.existsSync(v1Path)) return;
    const artifact = JSON.parse(fs.readFileSync(v1Path, 'utf8'));
    const verification = verifyQcArtifact(artifact);
    assert.equal(verification.reviewCount, 220);
    assert.equal(verification.uniquePairIds, 220);
    assert.equal(verification.ok, true);
  });
});
