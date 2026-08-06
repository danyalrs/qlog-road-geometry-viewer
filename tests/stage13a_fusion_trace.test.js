const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { traceSegment, NEGATIVE_CONTROLS } = require('../lib/stage13a_fusion_trace');

describe('Stage 13A fusion trace', () => {
  it('traces segment 90 with stage breakdown', () => {
    const trace = traceSegment(90);
    assert.equal(trace.segmentId, 90);
    assert.ok(trace.sectionTraces.length >= 1);
    const stages = trace.sectionTraces[0].stages;
    assert.equal(stages.length, 11);
    assert.ok(stages.find((s) => s.name === 'supported_run_splitting'));
    assert.ok(trace.primaryReconciliation);
  });

  it('reconciles seg 90 aggregate coverage vs zero production polygons', () => {
    const trace = traceSegment(90);
    assert.equal(trace.productionPolygonCount, 0);
    const r = trace.primaryReconciliation;
    assert.ok(r.aggregateRawPairedCoverageM > 100);
    assert.equal(r.polygonIntervalsProduced, 0);
    assert.equal(r.discrepancy, 'aggregate_fused_span_exceeds_20m_but_zero_polygons');
  });

  it('inspects segment 65 self-intersecting polygon', () => {
    const trace = traceSegment(65);
    assert.equal(trace.productionPolygonCount, 0);
    const insp = trace.segment65Inspection;
    assert.ok(insp);
    assert.equal(insp.sampleCount, 4);
    assert.ok(insp.selfIntersectionCount > 0);
    assert.equal(insp.orderedLeftPoints.length, 4);
    assert.equal(insp.orderedRightPoints.length, 4);
  });

  it('negative control: valid straight segment produces polygons', () => {
    const trace = traceSegment(NEGATIVE_CONTROLS.straightValid);
    assert.ok(trace.productionPolygonCount >= 1);
  });

  it('negative control: segment 9 remains zero-polygon', () => {
    const trace = traceSegment(NEGATIVE_CONTROLS.insufficientEvidence);
    assert.equal(trace.productionPolygonCount, 0);
    const r = trace.primaryReconciliation;
    assert.ok(r.aggregateRawPairedCoverageM < 20);
  });

  it('negative control: segment 57 multi-pass zero polygons', () => {
    const trace = traceSegment(NEGATIVE_CONTROLS.multiPass);
    assert.equal(trace.productionPolygonCount, 0);
    assert.ok(trace.temporalPassCount >= 2);
  });

  it('negative control: curved valid segment produces polygons', () => {
    const trace = traceSegment(NEGATIVE_CONTROLS.curvedValid);
    assert.ok(trace.productionPolygonCount >= 1);
  });
});
