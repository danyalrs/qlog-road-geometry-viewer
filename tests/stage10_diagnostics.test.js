const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { countSelfIntersections } = require('../lib/geometry_sanity');
const {
  findAllSelfIntersections,
  findMaxVertexJumpDetail,
  analyzeVertexOrder,
  classifySelfIntersectionCause,
  STAGE10_CANDIDATES,
  STAGE10_GROUPS,
} = require('../lib/stage10_diagnostics');

describe('Stage 10 diagnostics', () => {
  it('exposes 12 candidates in three groups', () => {
    assert.equal(STAGE10_CANDIDATES.length, 12);
    const all = [
      ...STAGE10_GROUPS.selfIntersecting,
      ...STAGE10_GROUPS.vertexJumpTooLarge,
      ...STAGE10_GROUPS.insufficientPairedCoverage,
    ];
    assert.deepEqual([...all].sort((a, b) => a - b), [...STAGE10_CANDIDATES].sort((a, b) => a - b));
  });

  it('reports intersection details consistent with geometry_sanity counter', () => {
    const square = [
      { east: 0, north: 0 },
      { east: 10, north: 0 },
      { east: 10, north: 10 },
      { east: 0, north: 10 },
      { east: 0, north: 0 },
    ];
    assert.equal(countSelfIntersections(square), 0);
    assert.equal(findAllSelfIntersections(square).length, 0);
  });

  it('finds max vertex jump with leg attribution', () => {
    const ring = [
      { east: 0, north: 0, s: 0 },
      { east: 20, north: 0, s: 20 },
      { east: 20, north: 5, s: 20 },
      { east: 0, north: 5, s: 0 },
    ];
    const jump = findMaxVertexJumpDetail(ring);
    assert.equal(jump.distanceM, 20);
    assert.ok(jump.leg === 'left' || jump.isBridgeEdge);
  });

  it('flags non-monotonic s in vertex order analysis', () => {
    const left = [{ s: 0 }, { s: 10 }, { s: 5 }];
    const right = [{ s: 0 }, { s: 10 }];
    const order = analyzeVertexOrder(left, right);
    assert.ok(order.issues.some((i) => i.type === 'nonMonotonicS'));
  });

  it('classifies lane-side swapping when boundary crossings present', () => {
    const causes = classifySelfIntersectionCause({
      intersections: [{ crossesLegs: true, edgeA: { from: 0 }, edgeB: { from: 5 } }],
      vertexOrder: { issues: [] },
      interpolation: { boundaryCrossingSamples: 2, maxInterpolationSpanM: 2 },
      fusion: { left: { maxBinGapM: 2 }, right: { maxBinGapM: 2 } },
      options: { fusionIntervalM: 2 },
    });
    assert.ok(causes.includes('lane_side_swapping'));
  });
});
