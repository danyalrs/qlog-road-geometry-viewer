'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  runRuntimeManualReviewExecution,
  buildDeliverables,
  applyHumanReview,
  DEFAULT_INPUTS,
} = require('../lib/stage26_b_motion_runtime_manual_review');
const { processQlogSegment } = require('../lib/stage26_b_motion_evidence_generation');
const { buildBrowserPlaybackScript } = require('../lib/stage20_b_motion_review_playback');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.B_MOTION_STAGE26_PORT || 3850;
const REVIEWS_PATH = path.join(ROOT, DEFAULT_INPUTS.reviewsOutputPath);

function loadReviews() {
  if (!fs.existsSync(REVIEWS_PATH)) {
    const report = runRuntimeManualReviewExecution({ root: ROOT });
    const { reviewsJson } = buildDeliverables(report);
    fs.mkdirSync(path.dirname(REVIEWS_PATH), { recursive: true });
    fs.writeFileSync(REVIEWS_PATH, `${JSON.stringify(reviewsJson, null, 2)}\n`);
    return reviewsJson;
  }
  return JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
}

function saveReviews(artifact) {
  fs.writeFileSync(REVIEWS_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
}

let reviewsArtifact = loadReviews();
const manifestById = new Map(
  JSON.parse(fs.readFileSync(path.join(ROOT, DEFAULT_INPUTS.stage25ManifestPath), 'utf8')).records.map((r) => [r.reviewPairId, r]),
);

const app = express();
app.use(express.json());
app.use('/b-motion-review', express.static(path.join(ROOT, 'public/b-motion-review')));

app.get('/api/stage26/manifest', (_req, res) => {
  res.json({
    total: reviewsArtifact.reviews.length,
    pending: reviewsArtifact.reviews.filter((r) => r.reviewStatus === 'pending_human_review').length,
    reviews: reviewsArtifact.reviews.map((r) => ({
      reviewPairId: r.reviewPairId,
      reviewStatus: r.reviewStatus,
      priority: r.priority,
      reviewGroup: r.reviewGroup,
      developmentRecord: r.developmentRecord,
      runtimeOnly: r.runtimeOnly,
    })),
  });
});

app.get('/api/stage26/review/:reviewPairId', (req, res) => {
  const review = reviewsArtifact.reviews.find((r) => r.reviewPairId === req.params.reviewPairId);
  const manifest = manifestById.get(req.params.reviewPairId);
  if (!review) return res.status(404).json({ error: 'not_found' });
  res.json({ review, manifest });
});

app.get('/api/stage26/playback', (req, res) => {
  const qlogReference = req.query.qlogReference;
  if (!qlogReference) return res.status(400).json({ error: 'qlogReference required' });
  const payload = processQlogSegment(ROOT, qlogReference);
  if (!payload.ok) return res.status(404).json(payload);
  res.json(payload);
});

app.get('/api/stage26/playback-script.js', (_req, res) => {
  res.type('application/javascript').send(buildBrowserPlaybackScript());
});

app.post('/api/stage26/review/:reviewPairId', (req, res) => {
  const submission = {
    reviewPairId: req.params.reviewPairId,
    temporalContinuation: req.body.temporalContinuation,
    identitySwap: req.body.identitySwap,
    geometryIssue: req.body.geometryIssue,
    evidenceAvailable: req.body.evidenceAvailable,
    confidence: req.body.confidence,
    reviewerNote: req.body.reviewerNote,
    reviewerId: req.body.reviewerId || 'human-reviewer',
    roadEdgeOverlap: req.body.roadEdgeOverlap === true,
  };
  const result = applyHumanReview(reviewsArtifact, submission);
  if (!result.ok) return res.status(400).json(result);
  saveReviews(reviewsArtifact);
  res.json({ ok: true, review: result.review });
});

app.get('/api/stage26/progress', (_req, res) => {
  const report = runRuntimeManualReviewExecution({ root: ROOT, resume: true });
  res.json(report.progress);
});

app.listen(PORT, () => {
  console.log(`Stage 26 runtime review server: http://localhost:${PORT}/b-motion-review/stage26-runtime.html`);
});
