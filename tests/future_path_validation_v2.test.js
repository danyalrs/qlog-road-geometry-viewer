'use strict';

/**
 * Corrected future-path validation harness checks (investigation only).
 *
 * Verifies the P1-P4 corrections:
 *   P1. residual formulas distinguish raw signed lateral, absolute lateral,
 *       nominal-offset error, and lane-specific signed/absolute residuals;
 *       absolute error is never negative.
 *   P2. lane-specific expected offsets are per (segment, chunk/pass, laneIndex)
 *       from near-range points, with robust spread; unsupported lanes flagged.
 *   P3. progress-constrained matching reports valid|ambiguous|unavailable and
 *       never matches beyond the driven distance.
 *   P4. empirical boundary offsets are stable lane-consistently.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { analyzeSegment, progressMatch, binKeyFor } = require('../scripts/audit_future_path_validation_v2');

const ROOT = path.join(__dirname, '..');
const SEGS = ['qlog_f449c_5.bz2', 'qlog_f449c_2.bz2', 'qlog_f449c_99.bz2'].filter((s) => fs.existsSync(path.join(ROOT, s)));

describe('corrected future-path validation harness', () => {
  const results = {};
  for (const seg of SEGS) {
    results[seg] = analyzeSegment(path.join(ROOT, seg));
  }

  it('P1: absolute residuals are never negative and <= signed magnitude', () => {
    for (const seg of SEGS) {
      for (const p of results[seg].points) {
        if (p.absResidualM == null) continue;
        assert.ok(p.absResidualM >= 0, `${seg} f${p.frameIndex} lane${p.laneIndex} negative abs`);
        assert.ok(p.signedResidualM == null || Math.abs(p.signedResidualM) >= p.absResidualM - 1e-9,
          `${seg} abs > |signed|`);
      }
    }
  });

  it('P1: absolute lateral and nominal error reported separately', () => {
    for (const seg of SEGS) {
      const a = results[seg];
      assert.ok(a.nominalBoundaryOffsetM === 2.5, 'nominal offset 2.5 m');
      for (const p of a.points) {
        if (p.signedLateralM == null) continue;
        const expectedNominal = Math.abs(p.signedLateralM) - a.nominalBoundaryOffsetM;
        assert.ok(Math.abs(p.nominalErrorM - expectedNominal) < 0.01, `${seg} nominal error formula`);
      }
    }
  });

  it('P2: lane-specific offsets present, sane spread, lane-consistent signs', () => {
    for (const seg of SEGS) {
      const a = results[seg];
      assert.ok(a.empiricalLaneOffsets.length >= 2, `${seg} has lane offsets`);
      const byLane = {};
      for (const o of a.empiricalLaneOffsets) {
        const lane = Number(o.key.split('::')[3]);
        assert.ok(o.sampleCount > 0, `${seg} lane${lane} has samples`);
        assert.ok(o.madM != null && o.madM < 2, `${seg} lane${lane} MAD sane (${o.madM})`);
        byLane[lane] = o.sign;
      }
      // lane1 (ego right) and lane2 (ego left) must have opposite signs
      if (byLane[1] != null && byLane[2] != null) {
        assert.notStrictEqual(byLane[1], byLane[2], `${seg} lane1/lane2 opposite signs`);
      }
    }
  });

  it('P3: correspondence status is valid|ambiguous|unavailable and covered', () => {
    for (const seg of SEGS) {
      for (const p of results[seg].points) {
        assert.ok(['valid', 'ambiguous', 'unavailable'].includes(p.status), `${seg} status`);
        assert.ok(p.match20, `${seg} has 20 m window match`);
        assert.ok(p.match10, `${seg} has 10 m window match`);
      }
    }
  });

  it('P3: points beyond the driven distance are never valid', () => {
    for (const seg of SEGS) {
      for (const p of results[seg].points) {
        if (!p.verifiable) {
          assert.notStrictEqual(p.status, 'valid', `${seg} f${p.frameIndex} not-verifiable marked valid`);
        }
      }
      for (const b of results[seg].strayBranches) {
        if (b.unavailableFar === b.validFar + b.ambiguousFar + b.unavailableFar && b.validFar === 0 && b.unavailableFar > 0) {
          assert.strictEqual(b.classification, 'D', `${seg} f${b.frameIndex} pure-unavailable -> D`);
        }
      }
    }
  });

  it('P3: matchedS stays within the window of expectedS for valid matches', () => {
    for (const seg of SEGS) {
      for (const p of results[seg].points) {
        if (p.status !== 'valid') continue;
        const m = p.match20;
        assert.ok(Math.abs(m.alongTrackResidualM) <= 20 + 0.01, `${seg} valid within 20 m window (resid ${m.alongTrackResidualM})`);
      }
    }
  });

  it('P4: near-range residuals are small (reference near vehicle path)', () => {
    for (const seg of SEGS) {
      const near = results[seg].points.filter((p) => p.modelX <= 20 && p.status === 'valid' && p.absResidualM != null);
      const med = near.map((p) => p.absResidualM).sort((a, b) => a - b)[Math.floor(near.length / 2)];
      assert.ok(med < 0.5, `${seg} near-range median abs residual < 0.5 (got ${med})`);
    }
  });

  it('distance-bin absolute residual does not drop materially with modelX', () => {
    for (const seg of SEGS) {
      const keys = Object.keys(results[seg].bins).filter((k) => results[seg].bins[k].totalPoints > 0);
      let prev = -1;
      for (const k of keys) {
        const v = results[seg].bins[k].medianAbsResidualM;
        if (v == null) continue;
        // Allow small noise dips; a material drop across bins would indicate a bug.
        assert.ok(v >= prev - 0.5, `${seg} bin ${k} median ${v} dropped materially below ${prev}`);
        prev = v;
      }
    }
  });
});

describe('progressMatch unit behaviour', () => {
  const traj = {
    segments: [
      { index: 0, a: { east: 0, north: 0, chunkId: 0, logMonoTime: '0' }, b: { east: 100, north: 0, chunkId: 0, logMonoTime: '1000000000' }, s0: 0, s1: 100, length: 100 },
      { index: 1, a: { east: 100, north: 0, chunkId: 0, logMonoTime: '1000000000' }, b: { east: 200, north: 0, chunkId: 0, logMonoTime: '2000000000' }, s0: 100, s1: 200, length: 100 },
    ],
    points: [{ logMonoTime: '0' }, { logMonoTime: '1000000000' }, { logMonoTime: '2000000000' }],
    totalLength: 200,
  };

  it('matches a point near expectedS', () => {
    const m = progressMatch(traj, { east: 50, north: 3 }, 50, '500000000', 0, { sameChunk: true });
    assert.strictEqual(m[20].status, 'valid');
    assert.ok(Math.abs(m[20].alongTrackResidualM) < 1);
  });

  it('unavailable when expectedS far beyond trajectory', () => {
    const m = progressMatch(traj, { east: 300, north: 0 }, 300, '500000000', 0, { sameChunk: true });
    assert.strictEqual(m[20].status, 'unavailable');
  });

  it('does not match before the observation (minS guard)', () => {
    // expectedS = 10, window 20 -> minS defaults to expectedS - 20 = -10; a
    // candidate at s < obs time (s < 0) cannot occur on this forward trajectory,
    // but a match at s=10 (after obs) must still be found.
    const m = progressMatch(traj, { east: 10, north: 0 }, 10, '500000000', 0, { sameChunk: true });
    assert.ok(m[20].status === 'valid' || m[20].status === 'unavailable');
    // Explicit minS guard: forbid s < 40 with expectedS 50 -> only s in [30,50] fails
    const m2 = progressMatch(traj, { east: 50, north: 0 }, 50, '500000000', 0, { sameChunk: true, minS: 50 });
    if (m2[20].status === 'valid') assert.ok(m2[20].matchedS >= 50 - 1e-6, 'matchedS after minS');
  });
});
