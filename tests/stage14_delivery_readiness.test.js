const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  buildDeliveryReadiness,
  generateMarkdownReport,
  FROZEN_VERSION,
  FIRST_CHUNK_ZERO_POLYGON_SEGMENT_IDS,
  APPROVED_ZERO_POLYGON_CLASSIFICATION,
} = require('../lib/stage14_delivery_readiness');
const { buildChunkReconciliation } = require('../lib/stage14_chunk_reconciliation');

const ROOT = path.join(__dirname, '..');

describe('Stage 14 delivery readiness', () => {
  const audit = buildDeliveryReadiness(ROOT);
  const a = audit.summaryA_firstChunkDatasetAudit;
  const b = audit.summaryB_allChunkOutputAudit;
  const diff = audit.polygonDifferenceReconciliation;

  it('separates first-chunk summary A from all-chunk summary B', () => {
    assert.equal(a.scope, 'first_chunk_per_segment');
    assert.equal(b.scope, 'all_chunks_per_segment');
    assert.equal(a.acceptedPolygons, 524);
    assert.equal(b.acceptedFragments, 540);
    assert.equal(a.polygonProducingSegments, 79);
    assert.equal(b.polygonProducingSegments, 81);
    assert.equal(a.zeroPolygonSegments, 13);
    assert.equal(b.zeroPolygonSegments, 11);
    assert.notEqual(a.acceptedPolygons, b.acceptedFragments);
  });

  it('reconciles first-chunk producing plus zero equals 92', () => {
    assert.equal(a.polygonProducingSegments + a.zeroPolygonSegments, 92);
  });

  it('reconciles all-chunk producing plus zero equals 92', () => {
    assert.equal(b.polygonProducingSegments + b.zeroPolygonSegments, 92);
  });

  it('accounts for 540 fragments (307 useful + 233 short)', () => {
    assert.equal(audit.datasetResults.totalAcceptedFragments, 540);
    assert.equal(audit.datasetResults.independentlyUsefulFragments, 307);
    assert.equal(audit.datasetResults.validButShortFragments, 233);
  });

  it('attributes 0-polygon difference (all-chunk output reconciled, pose-lock corrected)', () => {
    assert.equal(diff.difference, 0);
    assert.equal(diff.attributedDifference, 0);
    assert.deepEqual(diff.fullyAttributedToSegments.sort((x, y) => x - y), []);
  });

  it('no segment removed from all-chunk zero-polygon total (pose-lock corrected)', () => {
    // With the two-pass stationary pose lock, the first-chunk/all-chunk polygon
    // difference is reconciled: no segment needs removal.
    const removed = audit.zeroPolygonClassification.segmentsRemovedFromAllChunkZero;
    assert.equal(removed.length, 0);
  });

  it('classifies 13 first-chunk zero-polygon segments', () => {
    assert.equal(audit.firstChunkZeroPolygonSegments.length, 13);
    const ids = audit.firstChunkZeroPolygonSegments.map((s) => s.segmentId).sort((x, y) => x - y);
    assert.deepEqual(ids, [...FIRST_CHUNK_ZERO_POLYGON_SEGMENT_IDS].sort((x, y) => x - y));
    for (const seg of audit.firstChunkZeroPolygonSegments) {
      assert.equal(seg.primaryClassification, APPROVED_ZERO_POLYGON_CLASSIFICATION[seg.segmentId]);
      assert.equal(seg.scope, 'first_chunk_zero_polygon');
    }
  });

  it('counts 4 first-chunk insufficient-evidence and 4 all-chunk insufficient-evidence (pose-lock corrected)', () => {
    const first = a.rejectionClassAccounting.correctly_rejected_for_insufficient_evidence.sort((x, y) => x - y);
    const all = b.rejectionClassAccounting.correctly_rejected_for_insufficient_evidence.sort((x, y) => x - y);
    assert.deepEqual(first, [9, 60, 62, 96]);
    assert.deepEqual(all, [9, 60, 62, 96]);
  });

  it('fails consistency if all-chunk zero segment has polygons', () => {
    for (const row of audit.chunkReconciliationTable) {
      if (row.allChunkZeroPolygon) assert.equal(row.allChunkPolygonCount, 0);
    }
  });

  it('reconciles 84 measurable Stage 12A primary outcomes', () => {
    assert.equal(audit.bevEvidenceConsistency.measurableCount, 84);
    const c = audit.bevEvidenceConsistency.classificationCounts;
    assert.equal(c.visually_accurate + c.acceptable_within_image_uncertainty + c.laterally_shifted, 84);
  });

  it('keeps width_too_wide as secondary tag on two cases', () => {
    assert.equal(audit.bevEvidenceConsistency.widthTooWideSecondaryTagCount, 2);
  });

  it('reports frozen processing version', () => {
    assert.equal(audit.processingVersion, FROZEN_VERSION);
  });

  it('documents Stage 12B as blocked not failed', () => {
    assert.equal(audit.cameraValidation.status, 'BLOCKED');
    const report = generateMarkdownReport(audit);
    assert.match(report, /Stage 12B.*BLOCKED/);
    assert.match(report, /blocked.*not failed/i);
    assert.match(report, /Summary A/);
    assert.match(report, /Summary B/);
  });

  it('reports Stage 14 as approved', () => {
    assert.equal(audit.stage14Status, 'approved');
  });

  it('passes full consistency reconciliation', () => {
    assert.equal(audit.consistencyCheck.passed, true, audit.consistencyCheck.errors.join('; '));
  });

  it('does not present first-chunk totals as all-chunk totals in report', () => {
    const report = generateMarkdownReport(audit);
    assert.match(report, /524 is first-chunk only/);
    assert.match(report, /540 is all-chunk only/);
    assert.doesNotMatch(report, /Divergent segments: 7, 26, 96/);
  });

  it('records segment 90 as first-chunk run-pairing misalignment', () => {
    const seg90 = audit.firstChunkZeroPolygonSegments.find((s) => s.segmentId === 90);
    assert.equal(seg90.primaryClassification, 'blocked_by_run_pairing_misalignment');
    assert.equal(seg90.allChunkPolygonCount, 0);
  });
});

describe('Stage 14 chunk reconciliation', () => {
  const stage11 = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit_stage11_fragments_v11.json'), 'utf8'));
  const recon = buildChunkReconciliation(ROOT, stage11);

  it('sums per-chunk counts to 540 and first-chunk to 524', () => {
    assert.equal(recon.consistencyChecks.perChunkSumEquals540, true);
    assert.equal(recon.consistencyChecks.firstChunkSumEquals524, true);
  });
});
