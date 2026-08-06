const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectPasses, segmentIntersectsPath } = require('../lib/passes');

const DEFAULT_OPTS = {
  selfIntersectionMinAlongTrackSepM: 45,
  spatialRevisitMaxTravelToEuclideanRatio: 50,
};

describe('sparse path pass detection', () => {
  it('suppresses chord self-intersection on long forward curve', () => {
    const audit = require('../audit_transform_qlog_f449c_2.json');
    const points = audit.transformedTrajectorySample.map((p) => ({
      ...p,
      speed: 12,
      logMonoTime: p.logMonoTime,
    }));
    const { diagnostics } = detectPasses(points, { selfIntersectionMinAlongTrackSepM: 45 });
    assert.equal(diagnostics.passCount, 1);
    assert.ok(diagnostics.suppressedSplitEvents.some((e) => e.reason === 'suppressedChordSelfIntersection'));
  });

  it('suppresses false spatial revisit when travel/euclidean ratio is high', () => {
    const audit = require('../audit_transform_qlog_f449c_99.json');
    const points = audit.transformedTrajectorySample.map((p) => ({
      ...p,
      speed: 12,
      logMonoTime: p.logMonoTime,
    }));
    const { diagnostics } = detectPasses(points, {
      revisitDistM: 8,
      revisitMinTravelM: 25,
      spatialRevisitMaxTravelToEuclideanRatio: 50,
    });
    assert.equal(diagnostics.passCount, 1);
    const suppressed = diagnostics.suppressedSplitEvents.filter((e) => (
      e.reason === 'suppressedCurveSpatialRevisit' || e.reason === 'suppressedChordSelfIntersection'
    ));
    assert.ok(suppressed.length >= 1);
  });

  it('segmentIntersectsPath reports chord suppression metadata for forward curve chords', () => {
    const audit = require('../audit_transform_qlog_f449c_2.json');
    const pts = audit.transformedTrajectorySample;
    const i = 17;
    const prev = pts[i - 1];
    const cur = pts[i];
    const path = pts.slice(0, i);
    const r = segmentIntersectsPath(prev, cur, path, 3, DEFAULT_OPTS);
    assert.equal(r.suppressed, true);
    assert.equal(r.reason, 'chordSelfIntersection');
    assert.ok(r.assessment.bothSegmentsForwardAligned);
    assert.ok(r.assessment.alongTrackFromHitToEndM >= 45);
  });
});
