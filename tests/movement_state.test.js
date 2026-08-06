const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { classifyMovementStates, allowsReversalSplit, annotatePathWithMovement } = require('../lib/movement_state');
const { detectPasses } = require('../lib/passes');

describe('movement state', () => {
  it('classifies stationary GPS drift', () => {
    const points = [];
    for (let i = 0; i < 10; i++) {
      points.push({
        east: i * 0.1,
        north: (i % 2) * 0.05,
        speed: 0.5,
        logMonoTime: String(BigInt(1e9) + BigInt(i * 2e9)),
        headingDeg: i * 20,
      });
    }
    const { states, summary } = classifyMovementStates(points);
    assert.ok(summary.stationary >= 5 || summary.creeping + summary.stationary >= 5);
  });

  it('blocks reversal split when stationary', () => {
    const prev = { east: 0, north: 0, movementState: 'stationary', speed: 0.5 };
    const cur = { east: 0.3, north: -0.2, movementState: 'stationary', speed: 0.5 };
    assert.equal(allowsReversalSplit(cur, prev), false);
  });
});

describe('pass detection with movement state', () => {
  it('does not split stationary GPS noise into multiple passes', () => {
    const path = [];
    for (let i = 0; i < 30; i++) {
      const t = BigInt(1e12) + BigInt(i * 2e9);
      path.push({
        logMonoTime: t.toString(),
        east: 100 + (i < 15 ? i * 2 : 30 + (i - 15) * 0.1),
        north: 200 + (i < 15 ? i * 0.5 : 0.2 * ((i % 3) - 1)),
        speed: i < 15 ? 8 : 0.5,
        headingDeg: i < 15 ? 90 : (i % 2 ? 120 : 60),
        frameId: 1000 + i,
      });
    }
    const { passes, diagnostics } = detectPasses(path, {});
    assert.equal(passes.length, 1, `expected 1 pass, got ${passes.length} splits=${JSON.stringify(diagnostics.splitEvents)}`);
  });
});
