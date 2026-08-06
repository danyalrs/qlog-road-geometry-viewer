#!/usr/bin/env node
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { loadSegmentsData } = require('../lib/qlog_data');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const { loadManifest } = require('../lib/stage20_b_motion_manifest_validate');
const {
  loadReviewsArtifact,
  saveReviewsArtifact,
  upsertReview,
  getReviewByPairAndReviewer,
  DEFAULT_REVIEWS_PATH,
} = require('../lib/stage20_b_motion_review_store');
const { blindPairForReview, revealRuleDerivedAfterReview } = require('../lib/stage20_b_motion_review_validate');
const { buildReviewBatches } = require('../lib/stage20_b_motion_review_batches');
const { buildProgressReport } = require('../lib/stage20_b_motion_review_progress');
const { assignCalibrationValidationSplit } = require('../lib/stage20_b_motion_review_split');
const { isQlogInWorkspace } = require('../lib/stage20_b_motion_manifest_validate');
const { serializePlaybackFrame, buildBrowserPlaybackScript } = require('../lib/stage20_b_motion_review_playback');
const {
  DEFAULT_SOURCE_REVIEWS_PATH,
  DEFAULT_QC_BACKUP_PATH,
  DEFAULT_QC_REVIEWS_PATH,
  ensureQcBackup,
  loadOrInitializeQcArtifact,
  buildQcProgressReport,
  findNextQcRecordIndex,
  getReviewAtRecordIndex,
  applyQcUpdate,
  isQcRecordIndex,
  buildQcChangeReport,
  verifyQcArtifact,
  QC_RECORD_INDICES,
} = require('../lib/stage20_b_motion_review_qc');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.B_MOTION_REVIEW_PORT || 3848;
const MANIFEST_PATH = path.join(ROOT, 'deliverables', 'stage20-b-motion-evidence-review-manifest.json');
const MANIFEST_REL = path.relative(ROOT, MANIFEST_PATH);
const REVIEWS_PATH = process.env.B_MOTION_REVIEWS_PATH
  ? (path.isAbsolute(process.env.B_MOTION_REVIEWS_PATH)
    ? process.env.B_MOTION_REVIEWS_PATH
    : path.join(ROOT, process.env.B_MOTION_REVIEWS_PATH))
  : path.join(ROOT, DEFAULT_REVIEWS_PATH);
const QC_SOURCE_PATH = process.env.B_MOTION_QC_SOURCE_PATH
  ? (path.isAbsolute(process.env.B_MOTION_QC_SOURCE_PATH)
    ? process.env.B_MOTION_QC_SOURCE_PATH
    : path.join(ROOT, process.env.B_MOTION_QC_SOURCE_PATH))
  : path.join(ROOT, DEFAULT_SOURCE_REVIEWS_PATH);
const QC_BACKUP_PATH = process.env.B_MOTION_QC_BACKUP_PATH
  ? (path.isAbsolute(process.env.B_MOTION_QC_BACKUP_PATH)
    ? process.env.B_MOTION_QC_BACKUP_PATH
    : path.join(ROOT, process.env.B_MOTION_QC_BACKUP_PATH))
  : path.join(ROOT, DEFAULT_QC_BACKUP_PATH);
const QC_REVIEWS_PATH = process.env.B_MOTION_QC_REVIEWS_PATH
  ? (path.isAbsolute(process.env.B_MOTION_QC_REVIEWS_PATH)
    ? process.env.B_MOTION_QC_REVIEWS_PATH
    : path.join(ROOT, process.env.B_MOTION_QC_REVIEWS_PATH))
  : path.join(ROOT, DEFAULT_QC_REVIEWS_PATH);

const manifest = loadManifest(MANIFEST_PATH);
const pairById = new Map(manifest.reviewPairs.map((p, idx) => [p.reviewPairId, { ...p, sourcePairIndex: idx }]));
const batches = buildReviewBatches(manifest.reviewPairs);
const batchById = new Map(batches.map((b) => [b.batchId, b]));
const split = assignCalibrationValidationSplit(manifest.reviewPairs);

let reviewsArtifact = loadReviewsArtifact(REVIEWS_PATH, manifest, MANIFEST_REL);
let qcReviewsArtifact = loadOrInitializeQcArtifact(
  QC_SOURCE_PATH,
  QC_REVIEWS_PATH,
  manifest,
  MANIFEST_REL,
);

const segmentCache = new Map();

function reloadReviews() {
  reviewsArtifact = loadReviewsArtifact(REVIEWS_PATH, manifest, MANIFEST_REL);
}

function reloadQcReviews() {
  qcReviewsArtifact = loadOrInitializeQcArtifact(
    QC_SOURCE_PATH,
    QC_REVIEWS_PATH,
    manifest,
    MANIFEST_REL,
  );
}

function pairForQcRecord(recordIndex) {
  const review = getReviewAtRecordIndex(qcReviewsArtifact, recordIndex);
  if (!review) return null;
  const pair = pairById.get(review.reviewPairId);
  if (!pair) return null;
  return { pair, review };
}

function reviewedByReviewer(reviewerId) {
  const done = new Set();
  for (const r of reviewsArtifact.reviews || []) {
    if (r.reviewerId === reviewerId) done.add(r.reviewPairId);
  }
  return done;
}

function findNearestFrameIndex(timeline, logMonoTime) {
  if (!timeline?.length || logMonoTime == null) return 0;
  const target = BigInt(logMonoTime);
  let best = 0;
  let bestDiff = null;
  for (let i = 0; i < timeline.length; i++) {
    const t = BigInt(timeline[i].logMonoTime);
    const diff = t > target ? t - target : target - t;
    if (bestDiff == null || diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

function processQlogSegment(qlogReference) {
  if (segmentCache.has(qlogReference)) return segmentCache.get(qlogReference);
  const filePath = path.join(ROOT, qlogReference);
  if (!fs.existsSync(filePath)) throw new Error(`qlog not found: ${qlogReference}`);
  const modelEvents = extractModel(filePath).map((e) => ({ ...e, sourceFile: qlogReference }));
  const gpsEvents = extractGps(filePath).map((e) => ({ ...e, sourceFile: qlogReference }));
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  result.timeline = buildTimeline(result.frames);
  const payload = {
    qlogReference,
    frameCount: result.frames?.length || 0,
    timeline: (result.timeline || []).map((f, i) => ({
      index: i,
      logMonoTime: String(f.logMonoTime),
      chunkId: f.chunkId,
      passId: f.passId,
    })),
    frames: (result.frames || []).map((f, i) => serializePlaybackFrame(f, i)),
  };
  segmentCache.set(qlogReference, payload);
  return payload;
}

const app = express();

app.get('/playback-helpers.js', (_req, res) => {
  res.type('application/javascript').send(buildBrowserPlaybackScript());
});

app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(ROOT, 'public', 'b-motion-review')));

app.get('/api/config', (_req, res) => {
  res.json({
    manifestSchemaVersion: manifest.schemaVersion,
    reviewsSchemaVersion: reviewsArtifact.schemaVersion,
    totalPairs: manifest.reviewPairCount,
    batchCount: batches.length,
    splitSeed: split.seed,
    thresholdCalibrationBlocked: true,
    qcModeAvailable: true,
    qcRecordIndices: QC_RECORD_INDICES,
    qcArtifactPath: path.relative(ROOT, QC_REVIEWS_PATH),
  });
});

app.get('/api/progress', (req, res) => {
  reloadReviews();
  res.json(buildProgressReport(manifest, reviewsArtifact, { root: ROOT }));
});

app.get('/api/batches', (_req, res) => {
  res.json({ batches: batches.map((b) => ({ batchId: b.batchId, pairCount: b.pairCount, coverage: b.coverage })) });
});

app.get('/api/batch/:batchId', (req, res) => {
  const batch = batchById.get(req.params.batchId);
  if (!batch) return res.status(404).json({ error: 'batch_not_found' });
  res.json(batch);
});

app.get('/api/pair/next', (req, res) => {
  reloadReviews();
  const reviewerId = req.query.reviewerId;
  if (!reviewerId) return res.status(400).json({ error: 'reviewerId_required' });
  const done = reviewedByReviewer(reviewerId);
  let candidates = manifest.reviewPairs;
  if (req.query.batchId) {
    const batch = batchById.get(req.query.batchId);
    if (!batch) return res.status(404).json({ error: 'batch_not_found' });
    const batchSet = new Set(batch.reviewPairIds);
    candidates = candidates.filter((p) => batchSet.has(p.reviewPairId));
  }
  const next = candidates.find((p) => !done.has(p.reviewPairId));
  if (!next) return res.json({ done: true, reviewPairId: null });
  const progress = buildProgressReport(manifest, reviewsArtifact, { root: ROOT });
  res.json({
    done: false,
    reviewPairId: next.reviewPairId,
    progress,
  });
});

app.get('/api/pair/:reviewPairId', (req, res) => {
  const reviewPairId = decodeURIComponent(req.params.reviewPairId);
  const pair = pairById.get(reviewPairId);
  if (!pair) return res.status(404).json({ error: 'pair_not_found' });
  const reviewerId = req.query.reviewerId;
  const existing = reviewerId ? getReviewByPairAndReviewer(reviewsArtifact, pair.reviewPairId, reviewerId) : null;
  const blinded = blindPairForReview(pair, { root: ROOT });
  blinded.evidenceAvailability = {
    qlogInWorkspace: pair.qlogReference ? isQlogInWorkspace(ROOT, pair.qlogReference) : false,
    videoReference: pair.videoReference,
    qlogReference: pair.qlogReference,
  };
  const body = { pair: blinded, existingReview: existing };
  if (existing) {
    body.ruleDerivedReveal = revealRuleDerivedAfterReview(pair);
  }
  res.json(body);
});

app.post('/api/review', (req, res) => {
  reloadReviews();
  const submission = req.body || {};
  const pair = pairById.get(submission.reviewPairId);
  if (!pair) return res.status(404).json({ error: 'pair_not_found' });

  const result = upsertReview(reviewsArtifact, manifest, {
    ...submission,
    sourcePairIndex: pair.sourcePairIndex,
  });
  if (!result.ok) {
    return res.status(400).json(result);
  }
  saveReviewsArtifact(REVIEWS_PATH, reviewsArtifact);
  res.json({
    ok: true,
    record: result.record,
    ruleDerivedReveal: revealRuleDerivedAfterReview(pair),
    progress: buildProgressReport(manifest, reviewsArtifact, { root: ROOT }),
  });
});

app.post('/api/qlog/process', (req, res) => {
  try {
    const { qlogReference, logMonoTimeA, logMonoTimeB } = req.body || {};
    if (!qlogReference) return res.status(400).json({ error: 'qlogReference_required' });
    const payload = processQlogSegment(qlogReference);
    const frameIndexA = findNearestFrameIndex(payload.timeline, logMonoTimeA);
    const frameIndexB = findNearestFrameIndex(payload.timeline, logMonoTimeB);
    res.json({
      ...payload,
      suggestedFrameIndexA: frameIndexA,
      suggestedFrameIndexB: frameIndexB,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/split', (_req, res) => {
  res.json({
    seed: split.seed,
    calibrationPairCount: split.calibrationPairCount,
    validationPairCount: split.validationPairCount,
    coverage: split.coverage,
    note: 'Split assigned independently of reviewer labels',
  });
});

app.get('/api/qc/progress', (_req, res) => {
  reloadQcReviews();
  const progress = buildQcProgressReport(qcReviewsArtifact);
  const verification = verifyQcArtifact(qcReviewsArtifact);
  res.json({
    ...progress,
    verification,
    qcArtifactPath: path.relative(ROOT, QC_REVIEWS_PATH),
    sourceArtifactPath: path.relative(ROOT, QC_SOURCE_PATH),
  });
});

app.get('/api/qc/next', (req, res) => {
  reloadQcReviews();
  const qcReviewer = req.query.qcReviewer;
  if (!qcReviewer) return res.status(400).json({ error: 'qcReviewer_required' });
  const recordIndex = findNextQcRecordIndex(qcReviewsArtifact);
  if (recordIndex == null) {
    const baseline = loadReviewsArtifact(QC_SOURCE_PATH, manifest, MANIFEST_REL);
    return res.json({
      done: true,
      recordIndex: null,
      progress: buildQcProgressReport(qcReviewsArtifact),
      changeReport: buildQcChangeReport(qcReviewsArtifact, baseline),
      verification: verifyQcArtifact(qcReviewsArtifact),
    });
  }
  res.json({
    done: false,
    recordIndex,
    progress: buildQcProgressReport(qcReviewsArtifact),
  });
});

app.get('/api/qc/record/:recordIndex', (req, res) => {
  reloadQcReviews();
  const recordIndex = Number(req.params.recordIndex);
  if (!Number.isInteger(recordIndex) || !isQcRecordIndex(recordIndex)) {
    return res.status(404).json({ error: 'qc_record_not_found' });
  }
  const resolved = pairForQcRecord(recordIndex);
  if (!resolved) return res.status(404).json({ error: 'qc_record_not_found' });
  const { pair, review } = resolved;
  const blinded = blindPairForReview(pair, { root: ROOT });
  blinded.evidenceAvailability = {
    qlogInWorkspace: pair.qlogReference ? isQlogInWorkspace(ROOT, pair.qlogReference) : false,
    videoReference: pair.videoReference,
    qlogReference: pair.qlogReference,
  };
  res.json({
    recordIndex,
    pair: blinded,
    existingReview: review,
    ruleDerivedReveal: revealRuleDerivedAfterReview(pair),
    progress: buildQcProgressReport(qcReviewsArtifact),
  });
});

app.post('/api/qc/review', (req, res) => {
  reloadQcReviews();
  const submission = req.body || {};
  const recordIndex = Number(submission.recordIndex);
  if (!Number.isInteger(recordIndex)) {
    return res.status(400).json({ error: 'recordIndex_required' });
  }
  if (!submission.qcReviewer) {
    return res.status(400).json({ error: 'qcReviewer_required' });
  }

  ensureQcBackup(QC_SOURCE_PATH, QC_BACKUP_PATH);

  const result = applyQcUpdate(qcReviewsArtifact, manifest, submission);
  if (!result.ok) {
    return res.status(400).json(result);
  }

  saveReviewsArtifact(QC_REVIEWS_PATH, qcReviewsArtifact);

  const baseline = loadReviewsArtifact(QC_SOURCE_PATH, manifest, MANIFEST_REL);
  const resolved = pairForQcRecord(recordIndex);
  res.json({
    ok: true,
    record: result.record,
    recordIndex,
    ruleDerivedReveal: resolved ? revealRuleDerivedAfterReview(resolved.pair) : null,
    progress: buildQcProgressReport(qcReviewsArtifact),
    verification: verifyQcArtifact(qcReviewsArtifact),
    changeReport: buildQcChangeReport(qcReviewsArtifact, baseline),
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`B-MOTION manual review tool: http://localhost:${PORT}`);
    console.log(`QC recheck mode: http://localhost:${PORT}/qc.html`);
    console.log(`Manifest: ${path.relative(ROOT, MANIFEST_PATH)} (${manifest.reviewPairCount} pairs)`);
    console.log(`Reviews artifact: ${path.relative(ROOT, REVIEWS_PATH)}`);
    console.log(`QC artifact: ${path.relative(ROOT, QC_REVIEWS_PATH)}`);
  });
}

module.exports = app;
