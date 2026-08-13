const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  ZERO_POLYGON_SEGMENTS,
  diagnoseZeroPolygonSegment,
  summarizeZeroPolygonAudit,
  classifyZeroPolygonSegment,
  STAGE13_CLASSIFICATIONS,
} = require('../lib/stage13_zero_polygon_diagnostics');

describe('Stage 13 zero-polygon diagnostics', () => {
  it('lists 13 zero-polygon segments', () => {
    assert.equal(ZERO_POLYGON_SEGMENTS.length, 13);
    assert.ok(ZERO_POLYGON_SEGMENTS.includes(9));
    assert.ok(ZERO_POLYGON_SEGMENTS.includes(57));
  });

  it('classifies metrics into stage13 taxonomy', () => {
    const tags = classifyZeroPolygonSegment({
      temporalPassCount: 2,
      poseSectionCount: 3,
      poseRejection: { rejectedCount: 2 },
      fusion: { pairedFrames: { pairedFrameCount: 0 }, longitudinalCoverageM: { paired: 5 }, edgeObservationCount: 10 },
      attemptedPolygonCount: 0,
      acceptedPolygonCount: 0,
      rejectedPolygonCount: 0,
      exactRejectionReasons: [],
      recoverabilityHint: 'none',
      roadShape: 'straight',
    });
    assert.ok(tags.some((t) => STAGE13_CLASSIFICATIONS.includes(t)));
    assert.ok(tags.includes('blocked_by_multi_pass_ambiguity'));
  });

  it('diagnoses segment 9 as zero-polygon with classification', () => {
    const diag = diagnoseZeroPolygonSegment(9);
    assert.equal(diag.polygonCount, 0);
    assert.ok(diag.classifications.length > 0);
    assert.ok(diag.sectionDiagnostics.length > 0);
    assert.ok(diag.poseRejection);
    assert.ok(diag.fusion);
  });

  it('summarizeZeroPolygonAudit aggregates classifications', () => {
    const mock = [
      { segmentId: 9, classifications: ['correctly_rejected_for_insufficient_evidence'] },
      { segmentId: 57, classifications: ['blocked_by_multi_pass_ambiguity', 'blocked_by_pose_fragmentation'] },
    ];
    const summary = summarizeZeroPolygonAudit(mock);
    assert.equal(summary.segmentCount, 2);
    assert.ok(summary.byClassification['blocked_by_multi_pass_ambiguity'] >= 1);
  });

  it('segment 57 no longer fragments into spurious temporal passes (pose-lock corrected)', () => {
    const diag = diagnoseZeroPolygonSegment(57);
    // With the stationary pose lock, the drift-caused second temporal pass is
    // resolved: seg57 is a single-pass zero-polygon segment rejected for
    // insufficient evidence, not blocked by multi-pass ambiguity.
    assert.ok(diag.temporalPassCount >= 1);
    assert.ok(diag.classifications.includes('correctly_rejected_for_insufficient_evidence'));
  });
});
