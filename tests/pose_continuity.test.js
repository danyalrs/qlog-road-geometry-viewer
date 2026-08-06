const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  assignPoseSections,
  validatePoseTransition,
  estimateExpectedSpeedMps,
  maxAllowedPositionJumpM,
  DEFAULT_POSE_CONTINUITY_CONFIG,
} = require('../lib/pose_continuity');

const CFG = DEFAULT_POSE_CONTINUITY_CONFIG;

function pt(east, north, headingDeg, speed, frameId, tIndex) {
  return {
    east,
    north,
    headingDeg,
    speed,
    logMonoTime: String(1_000_000_000 + tIndex * 2_000_000_000),
    frameId,
  };
}

function noSpeed(east, north, headingDeg, frameId, tIndex) {
  return pt(east, north, headingDeg, undefined, frameId, tIndex);
}

function historyAt(speedMps, count = 4) {
  const history = [];
  for (let i = 0; i < count; i++) {
    history.push({ impliedSpeed: speedMps, reportedSpeed: speedMps, step: speedMps * 2, dt: 2 });
  }
  return history;
}

describe('pose continuity', () => {
  it('rejects unrealistic position jump', () => {
    const prev = { east: 0, north: 0, headingDeg: 90, speed: 10, logMonoTime: '1000000000', frameId: 1 };
    const cur = { east: 100, north: 0, headingDeg: 90, speed: 10, logMonoTime: '2000000000', frameId: 2 };
    const r = validatePoseTransition(prev, cur, {});
    assert.equal(r.ok, false);
    assert.ok(['impliedSpeedExceeded', 'positionJump'].includes(r.reason));
  });

  it('creates multiple pose sections after rejection', () => {
    const points = [
      { east: 0, north: 0, headingDeg: 90, speed: 5, logMonoTime: '1000000000', frameId: 1 },
      { east: 5, north: 0, headingDeg: 90, speed: 5, logMonoTime: '2000000000', frameId: 2 },
      { east: 5, north: 0, headingDeg: 90, speed: 5, logMonoTime: '6000000000', frameId: 3 },
      { east: 10, north: 0, headingDeg: 90, speed: 5, logMonoTime: '7000000000', frameId: 4 },
    ];
    const result = assignPoseSections(points, {});
    assert.ok(result.poseSectionCount >= 2);
    assert.equal(result.rejectedTransitions.length, 1);
  });

  it('accepts valid sparse GPS movement at highway speed (~2 s spacing)', () => {
    const prev = pt(0, 0, 0, 21, 1, 0);
    const cur = pt(0, 43.4, 2, 21.7, 2, 1);
    const r = validatePoseTransition(prev, cur, CFG);
    assert.equal(r.ok, true, `expected accept, got ${r.reason}`);
    assert.equal(r.expectedSpeedSource, 'reported');
    assert.ok(r.maxAllowedStepM >= 43.4);
  });

  it('rejects genuine position jump inconsistent with reported speed', () => {
    const prev = pt(0, 0, 0, 8, 1, 0);
    const cur = pt(0, 60, 0, 8, 2, 1);
    const r = validatePoseTransition(prev, cur, CFG);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'positionJump');
    assert.ok(r.step > r.maxAllowedStepM);
  });

  it('rejects isolated GPS outlier with implied speed above cap', () => {
    const prev = pt(0, 0, 90, 5, 1, 0);
    const cur = pt(80, 0, 90, 5, 2, 1);
    const r = validatePoseTransition(prev, cur, CFG);
    assert.equal(r.ok, false);
    assert.ok(['impliedSpeedExceeded', 'positionJump'].includes(r.reason));
  });

  it('rejects sustained localization shift across consecutive transitions', () => {
    const points = [];
    let north = 0;
    for (let i = 0; i < 5; i++) {
      north += 70;
      points.push(pt(0, north, 0, 5, i + 1, i));
    }
    const result = assignPoseSections(points, CFG);
    assert.ok(result.rejectedTransitions.length >= 3);
    assert.ok(result.poseSectionCount >= 4);
  });

  it('allows moderate heading-motion disagreement when speed is consistent (sparse curve)', () => {
    const prev = pt(0, 0, 0, 6.5, 1, 0);
    const cur = pt(1, 10, 53, 6.5, 2, 1);
    const r = validatePoseTransition(prev, cur, CFG);
    assert.equal(r.ok, true, `expected accept on curve, got ${r.reason}`);
    assert.ok(r.motionDisagreement > CFG.maxHeadingMotionDisagreementDeg);
    assert.ok(r.motionDisagreement <= CFG.maxHeadingMotionDisagreementSparseDeg);
  });

  it('maxAllowedPositionJumpM scales with independently estimated speed', () => {
    const allowed = maxAllowedPositionJumpM(20, CFG, 2);
    assert.ok(allowed > CFG.maxPositionJumpM);
    assert.ok(allowed <= CFG.absoluteMaxPositionJumpM);
  });
});

describe('pose continuity — missing-speed thresholding', () => {
  it('1. accepts missing-speed steady sparse movement using neighbour/history speed', () => {
    const prev = noSpeed(0, 80, 0, 4, 4);
    const cur = noSpeed(0, 123, 0, 5, 5);
    const context = {
      acceptedHistory: historyAt(21.5, 4),
      neighborPrevStepM: 43,
      neighborPrevDt: 2,
    };
    const r = validatePoseTransition(prev, cur, CFG, context);
    assert.equal(r.ok, true, r.reason);
    assert.ok(['neighborMedian', 'prevReported'].includes(r.expectedSpeedSource)
      || r.expectedSpeedMps >= 20);
    assert.notEqual(r.expectedSpeedSource, 'conservativeFallback');
  });

  it('2. rejects missing-speed isolated 40–60 m GPS jump against steady history', () => {
    const prev = noSpeed(0, 40, 0, 4, 4);
    const cur = noSpeed(0, 98, 0, 5, 5);
    const context = {
      acceptedHistory: historyAt(12, 4),
      neighborPrevStepM: 24,
      neighborPrevDt: 2,
    };
    const r = validatePoseTransition(prev, cur, CFG, context);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'positionJump');
    assert.ok(r.step >= 40 && r.step <= 60);
    assert.ok(r.step > r.maxAllowedStepM);
  });

  it('3. uses conservative fallback at startup with insufficient history', () => {
    const prev = noSpeed(0, 0, 0, 1, 0);
    const cur = noSpeed(0, 30, 0, 2, 1);
    const estimate = estimateExpectedSpeedMps(prev, cur, {}, CFG);
    assert.equal(estimate.source, 'conservativeFallback');
    const r = validatePoseTransition(prev, cur, CFG, {});
    assert.equal(r.expectedSpeedSource, 'conservativeFallback');
    assert.ok(r.maxAllowedStepM < 55, 'must not auto-accept via candidate implied speed');
    assert.equal(r.ok, true);
  });

  it('4. accepts missing-speed acceleration when reported speed on current point supports step', () => {
    const prev = noSpeed(0, 20, 0, 3, 3);
    const cur = pt(0, 70, 0, 25, 4, 4);
    const context = {
      acceptedHistory: historyAt(10, 3),
      neighborPrevStepM: 20,
      neighborPrevDt: 2,
    };
    const r = validatePoseTransition(prev, cur, CFG, context);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.expectedSpeedSource, 'reported');
  });

  it('5. rejects genuine sustained localization shift without reported speed', () => {
    const points = [];
    let north = 0;
    for (let i = 0; i < 5; i++) {
      north += 70;
      points.push(noSpeed(0, north, 0, i + 1, i));
    }
    const result = assignPoseSections(points, CFG);
    assert.ok(result.rejectedTransitions.length >= 3);
    assert.ok(result.poseSectionCount >= 4);
  });

  it('6. rejects jump below 65 m cap when inconsistent with independent speed evidence', () => {
    const prev = noSpeed(0, 20, 0, 2, 2);
    const cur = noSpeed(0, 72, 0, 3, 3);
    const context = {
      acceptedHistory: historyAt(10, 2),
      neighborPrevStepM: 20,
      neighborPrevDt: 2,
    };
    const r = validatePoseTransition(prev, cur, CFG, context);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'positionJump');
    assert.ok(r.step < CFG.absoluteMaxPositionJumpM);
    assert.ok(r.step > r.maxAllowedStepM);
  });

  it('7. prefers neighbour median when reported speed conflicts with accepted history', () => {
    const prev = noSpeed(0, 40, 0, 4, 4);
    const cur = pt(0, 108, 0, 5, 5, 5);
    const context = {
      acceptedHistory: historyAt(20, 4),
      neighborPrevStepM: 40,
      neighborPrevDt: 2,
    };
    const estimate = estimateExpectedSpeedMps(prev, cur, context, CFG);
    assert.equal(estimate.source, 'neighborMedianOverridesReported');
    const r = validatePoseTransition(prev, cur, CFG, context);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'positionJump');
  });

  it('8. recovers after one rejected outlier in assignPoseSections', () => {
    const points = [
      noSpeed(0, 0, 0, 1, 0),
      noSpeed(0, 40, 0, 2, 1),
      noSpeed(0, 80, 0, 3, 2),
      noSpeed(0, 150, 0, 4, 3),
      noSpeed(0, 190, 0, 5, 4),
      noSpeed(0, 230, 0, 6, 5),
    ];
    const result = assignPoseSections(points, CFG);
    assert.equal(result.rejectedTransitions.length, 1);
    assert.equal(result.rejectedTransitions[0].reason, 'positionJump');
    assert.ok(result.poseSectionCount >= 2);
    const lastSection = result.sections[result.sections.length - 1];
    assert.ok(lastSection.pointCount >= 3, 'valid points continue after outlier');
  });

  it('does not derive threshold from candidate implied speed (no circular acceptance)', () => {
    const prev = noSpeed(0, 0, 0, 1, 0);
    const cur = noSpeed(0, 55, 0, 2, 1);
    const r = validatePoseTransition(prev, cur, CFG, {});
    assert.equal(r.ok, false, '55 m first step must not auto-pass without independent speed');
    assert.equal(r.reason, 'positionJump');
    assert.ok(r.maxAllowedStepM <= 55);
    assert.notEqual(r.expectedSpeedMps, r.impliedSpeed);
  });
});
