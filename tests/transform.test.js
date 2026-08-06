const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { modelToGlobal, transformXyztLine } = require('../lib/transform');
const { timeGapSec } = require('../lib/chunking');

const TOL = 1e-6;

describe('modelToGlobal transform chain', () => {
  it('zero yaw: forward point maps north', () => {
    const p = modelToGlobal(10, 0, 0, 0, 0);
    assert.ok(Math.abs(p.east) < TOL);
    assert.ok(Math.abs(p.north - 10) < TOL);
  });

  it('+90 degree yaw: forward point maps east', () => {
    const p = modelToGlobal(10, 0, 0, 0, 90);
    assert.ok(Math.abs(p.east - 10) < TOL);
    assert.ok(Math.abs(p.north) < TOL);
  });

  it('-90 degree yaw: forward point maps west', () => {
    const p = modelToGlobal(10, 0, 0, 0, -90);
    assert.ok(Math.abs(p.east + 10) < TOL);
    assert.ok(Math.abs(p.north) < TOL);
  });

  it('left point at zero yaw maps west', () => {
    const p = modelToGlobal(0, 5, 0, 0, 0);
    assert.ok(Math.abs(p.east + 5) < TOL);
    assert.ok(Math.abs(p.north) < TOL);
  });

  it('right point at zero yaw maps east', () => {
    const p = modelToGlobal(0, -5, 0, 0, 0);
    assert.ok(Math.abs(p.east - 5) < TOL);
    assert.ok(Math.abs(p.north) < TOL);
  });

  it('behind-vehicle point excluded by transformXyztLine', () => {
    const line = { x: [-10, 0, 10], y: [0, 0, 0], z: [], t: [], prob: 1 };
    const pose = { east: 100, north: 200, headingDeg: 0 };
    const out = transformXyztLine(line, pose, { maxForwardM: 120 });
    assert.equal(out.points.length, 2);
    assert.ok(out.points.every((pt) => pt.modelX >= 0));
  });

  it('translation only: origin shift without rotation', () => {
    const p = modelToGlobal(0, 0, 50, -30, 0);
    assert.ok(Math.abs(p.east - 50) < TOL);
    assert.ok(Math.abs(p.north + 30) < TOL);
  });

  it('rotation plus translation combined', () => {
    const p = modelToGlobal(10, 0, 5, 5, 90);
    assert.ok(Math.abs(p.east - 15) < TOL);
    assert.ok(Math.abs(p.north - 5) < TOL);
  });

  it('mirrored lateral: +y and -y are symmetric about heading axis', () => {
    const left = modelToGlobal(0, 4, 0, 0, 45);
    const right = modelToGlobal(0, -4, 0, 0, 45);
    const midE = (left.east + right.east) / 2;
    const midN = (left.north + right.north) / 2;
    const fwd = modelToGlobal(4, 0, 0, 0, 45);
    assert.ok(Math.abs(left.east - midE + (right.east - midE)) < 0.01);
    assert.ok(Math.abs(dist(left, right) - 8 * Math.SQRT2 / 2 * 2) < 0.1 || Math.abs(dist(left, right) - 8) < 0.5);
    assert.ok(dist(fwd, { east: midE, north: midN }) < dist(left, fwd));
  });

  it('rejects non-finite input in transformXyztLine', () => {
    const line = { x: [0, NaN], y: [0, 1], z: [], t: [], prob: 1 };
    const pose = { east: 0, north: 0, headingDeg: 0 };
    const out = transformXyztLine(line, pose, {});
    assert.equal(out, null);
  });

  it('uses degrees not radians (90 yaw not ~1.57 rad mistake)', () => {
    const radWrong = modelToGlobal(10, 0, 0, 0, 1.5708);
    const degRight = modelToGlobal(10, 0, 0, 0, 90);
    assert.ok(Math.abs(degRight.east - 10) < TOL);
    assert.ok(Math.abs(radWrong.east - 10) > 5, 'radian heading should not match +90° east result');
  });
});

describe('stale timestamp alignment', () => {
  it('timeGapSec detects large model/GPS separation', () => {
    const a = { logMonoTime: '1000000000' };
    const b = { logMonoTime: '6000000000' };
    assert.ok(timeGapSec(a, b) > 3.5);
  });
});

function dist(a, b) {
  return Math.hypot(a.east - b.east, a.north - b.north);
}
