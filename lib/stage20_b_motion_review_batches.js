'use strict';

const { displacementBucket, speedBucket, timeGapBucket } = require('./stage20_b_motion_review_split');

const DEFAULT_BATCH_SIZE = 25;
const MIN_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 30;

function buildReviewBatches(pairs, options = {}) {
  const batchSize = Math.min(
    MAX_BATCH_SIZE,
    Math.max(MIN_BATCH_SIZE, options.batchSize || DEFAULT_BATCH_SIZE),
  );
  const ordered = [...pairs];
  const batches = [];
  for (let i = 0; i < ordered.length; i += batchSize) {
    const slice = ordered.slice(i, i + batchSize);
    batches.push({
      batchId: `batch-${String(batches.length + 1).padStart(2, '0')}`,
      batchIndex: batches.length,
      startIndex: i,
      endIndex: i + slice.length - 1,
      pairCount: slice.length,
      reviewPairIds: slice.map((p) => p.reviewPairId),
      pairs: slice,
    });
  }

  if (batches.length > 1 && batches[batches.length - 1].pairCount < MIN_BATCH_SIZE) {
    const last = batches.pop();
    const prev = batches[batches.length - 1];
    prev.pairs = prev.pairs.concat(last.pairs);
    prev.pairCount = prev.pairs.length;
    prev.reviewPairIds = prev.pairs.map((p) => p.reviewPairId);
    prev.endIndex = last.endIndex;
  }

  return batches.map(({ pairs: batchPairs, ...meta }) => ({
    ...meta,
    coverage: summarizeBatchCoverage(batchPairs),
  }));
}

function summarizeBatchCoverage(pairs) {
  const coverage = {
    clearContinuationRuleDerived: 0,
    ambiguousMotion: 0,
    sessionBoundary: 0,
    spatialCapFailure: 0,
    displacement: { lt_12m: 0, '12_35m': 0, gt_35m: 0, unknown: 0 },
    speed: { stationary: 0, low: 0, normal: 0, high: 0, unknown: 0 },
    timeGap: { lt_2s: 0, '2_4s': 0, gt_4s: 0, unknown: 0 },
    headingChangeGe15: 0,
    videoAvailable: 0,
    qlogPlaybackOnly: 0,
  };

  for (const p of pairs) {
    if (p.ruleDerivedClassification === 'valid_same_track_continuation') {
      coverage.clearContinuationRuleDerived += 1;
    }
    if (p.ruleDerivedClassification === 'ambiguous_motion_residual_candidate') {
      coverage.ambiguousMotion += 1;
    }
    if (p.ruleDerivedClassification === 'invalid_across_session_boundary') {
      coverage.sessionBoundary += 1;
    }
    if (p.ruleDerivedClassification === 'ambiguous_spatial_cap_failure') {
      coverage.spatialCapFailure += 1;
    }

    const db = displacementBucket(p.spatialM);
    coverage.displacement[db] = (coverage.displacement[db] || 0) + 1;
    const sb = speedBucket(p.speedMps);
    coverage.speed[sb] = (coverage.speed[sb] || 0) + 1;
    const tb = timeGapBucket(p.deltaTimeS);
    coverage.timeGap[tb] = (coverage.timeGap[tb] || 0) + 1;

    if (p.headingDiffDeg != null && p.headingDiffDeg >= 15) coverage.headingChangeGe15 += 1;
    if (p.videoAvailableInWorkspace) {
      coverage.videoAvailable += 1;
    } else if (p.qlogReference) {
      coverage.qlogPlaybackOnly += 1;
    }
  }

  return coverage;
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
  buildReviewBatches,
  summarizeBatchCoverage,
};
