const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  globalToVehicle,
  visibleEdgesInVehicleFrame,
  validatePolygonAtFrame,
  classifyAlignment,
  buildStratifiedSample,
  REQUIRED_SEGMENTS,
  OVERLAP_SEGMENT,
  CLASSIFICATIONS,
  inspectOverlapPairs,
} = require('../lib/stage12_visual_validation');
const { modelToGlobal } = require('../lib/transform');
const { auditSegmentFragments, DEFAULT_OPTS } = require('../lib/stage11_fragment_audit');

describe('Stage 12 visual validation', () => {
  it('globalToVehicle inverts modelToGlobal', () => {
    const pose = { east: 100, north: 200, headingDeg: 45 };
    const g = modelToGlobal(10, 2, pose.east, pose.north, pose.headingDeg);
    const v = globalToVehicle(g.east, g.north, pose);
    assert.ok(Math.abs(v.x - 10) < 0.01);
    assert.ok(Math.abs(v.y - 2) < 0.01);
  });

  it('classifyAlignment marks accurate low-error alignment', () => {
    const tags = classifyAlignment({
      inconclusive: false,
      leftLateralErrorM: 0.3,
      rightLateralErrorM: 0.4,
      widthErrorM: 0.5,
      longitudinalStartErrorM: 0,
      longitudinalEndErrorM: 0,
      unsupportedExtensionM: 0,
    });
    assert.ok(tags.includes('visually_accurate'));
  });

  it('classifyAlignment marks inconclusive separately', () => {
    const tags = classifyAlignment({ inconclusive: true });
    assert.deepEqual(tags, ['inconclusive_due_to_image_quality']);
  });

  it('visibleEdgesInVehicleFrame extracts left and right points', () => {
    const frame = {
      edges: [{
        edgeIndex: 0,
        points: [
          { modelX: 10, modelY: 3 },
          { modelX: 20, modelY: 3.5 },
          { modelX: 10, modelY: -3 },
          { modelX: 20, modelY: -3.2 },
        ],
      }],
    };
    const { left, right } = visibleEdgesInVehicleFrame(frame);
    assert.ok(left.length >= 2);
    assert.ok(right.length >= 2);
  });

  it('buildStratifiedSample includes required segments', () => {
    const mock = {
      results: REQUIRED_SEGMENTS.map((id) => ({
        segmentId: id,
        polygonCount: 2,
        fragments: [{
          polygonId: `${id}:0:0:0:0`,
          coverageM: id % 2 === 0 ? 10 : 4,
          sourceFrameIds: [],
        }],
        overlapPairs: [],
      })),
    };
    const samples = buildStratifiedSample(mock, REQUIRED_SEGMENTS);
    for (const id of REQUIRED_SEGMENTS) {
      assert.ok(samples.some((s) => s.segmentId === id), `missing segment ${id}`);
    }
  });

  it('inspectOverlapPairs reports valid adjacent evidence', () => {
    const result = {
      overlapPairs: [{ a: '27:0:0:0:0', b: '27:0:0:1:0', overlapM: 4 }],
      polygons: [
        { polygonId: '27:0:0:0:0', coverageM: 4, primaryClassification: 'visually_accurate' },
        { polygonId: '27:0:0:1:0', coverageM: 20, primaryClassification: 'acceptable_within_image_uncertainty' },
      ],
    };
    const reports = inspectOverlapPairs(result);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].verdict, 'valid_adjacent_evidence');
  });

  it('validates segment 46 polygons against source frames', () => {
    const { auditSegmentVisual } = require('../lib/stage12_visual_validation');
    const frag = auditSegmentFragments(46, DEFAULT_OPTS, 0);
    const visual = auditSegmentVisual(46, frag);
    assert.ok(visual.polygons.length > 0);
    const measurable = visual.polygons.filter((p) =>
      p.frameResults?.some((f) => !f.metrics?.inconclusive));
    assert.ok(measurable.length > 0, 'expected at least one measurable polygon on seg 46');
    for (const p of measurable) {
      assert.ok(CLASSIFICATIONS.includes(p.primaryClassification)
        || p.primaryClassification === 'inconclusive_due_to_image_quality');
    }
  });

  it('overlap segment 27 is included in required audit set', () => {
    assert.equal(OVERLAP_SEGMENT, 27);
  });
});
