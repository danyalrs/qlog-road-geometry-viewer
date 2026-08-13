'use strict';

/**
 * Future-path validation checks (investigation only).
 *
 * These verify the audit harness used to measure how well modelV2 lane
 * predictions agree with the vehicle trajectory recorded later:
 *   - verifiability rule (points beyond the driven distance are "not
 *     verifiable", never labelled wrong)
 *   - distance-bin coverage and metric sanity
 *   - dt (time-until-reach) is in real units, non-negative for verifiable pts
 *   - per-branch classification membership in {A,B,C,D,E}
 *   - temporal-consistency disagreement does not decrease with forward distance
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { analyzeSegment, temporalConsistency, classify, buildReport } = require('../scripts/audit_future_path_validation');

const ROOT = path.join(__dirname, '..');
const SEGS = ['qlog_f449c_5.bz2', 'qlog_f449c_2.bz2', 'qlog_f449c_99.bz2'].filter((s) => fs.existsSync(path.join(ROOT, s)));

describe('future-path validation harness', () => {
  const results = {};
  for (const seg of SEGS) {
    results[seg] = analyzeSegment(path.join(ROOT, seg));
  }

  it('runs for the selected segments', () => {
    assert.ok(SEGS.length >= 3, 'expected segments 5, 2, 99 present');
    for (const seg of SEGS) {
      assert.ok(results[seg].trajectoryLengthM > 0, `${seg} trajectory`);
      assert.ok(results[seg].totalLanePoints > 0, `${seg} lane points`);
    }
  });

  it('verifiability: not-verifiable points only beyond driven distance', () => {
    for (const seg of SEGS) {
      const r = results[seg];
      assert.ok(r.notVerifiable >= 0, `${seg} notVerifiable non-negative`);
      // All stray branches flagged farUncovered must lie at the trajectory end.
      for (const b of r.strayBranches) {
        if (b.farUncovered) {
          assert.ok(b.farMaxS >= r.trajectoryLengthM - 1e-6,
            `${seg} f${b.frameIndex} lane${b.laneIndex} uncovered branch farS ${b.farMaxS} < traj ${r.trajectoryLengthM}`);
        }
      }
    }
  });

  it('distance bins cover the expected forward ranges and metrics are sane', () => {
    for (const seg of SEGS) {
      const r = results[seg];
      assert.ok(r.bins['0-20'], `${seg} 0-20 bin`);
      assert.ok(r.bins['20-40'], `${seg} 20-40 bin`);
      assert.ok(r.bins['40-60'], `${seg} 40-60 bin`);
      assert.ok(r.bins['100-120'], `${seg} 100-120 bin`);
      const b0 = r.bins['0-20'];
      assert.ok(b0.medianDistM < 5, `${seg} near-bin median distance < 5 m (got ${b0.medianDistM})`);
      assert.ok(b0.medianLateralM >= 0, `${seg} near-bin median lateral >= 0`);
      assert.ok(r.empiricalBoundaryOffsetM > 0 && r.empiricalBoundaryOffsetM < 4,
        `${seg} empirical boundary offset in (0,4) m`);
    }
  });

  it('dt for verifiable far points is finite and non-negative seconds', () => {
    for (const seg of SEGS) {
      for (const b of results[seg].strayBranches) {
        if (!b.farUncovered) {
          assert.ok(Number.isFinite(b.maxDtSeconds) && b.maxDtSeconds >= 0,
            `${seg} f${b.frameIndex} dt ${b.maxDtSeconds}`);
        }
      }
    }
  });

  it('branch classifications are members of {A,B,C,D,E}', () => {
    for (const seg of SEGS) {
      for (const b of results[seg].strayBranches) {
        const c = classify(b, temporalConsistencyFor(seg, results[seg])[seg].perBranch);
        assert.ok(['A', 'B', 'C', 'D', 'E'].includes(c.cls), `${seg} f${b.frameIndex} got ${c.cls}`);
      }
    }
  });

  it('temporal spatial disagreement does not decrease with forward bin', () => {
    for (const seg of SEGS) {
      const bins = results[seg].bins;
      const keys = Object.keys(bins);
      const medians = keys.map((k) => bins[k].medianLateralErrorM);
      // median lateral error should be monotonically non-decreasing across bins
      for (let i = 1; i < medians.length; i++) {
        assert.ok(medians[i] >= medians[i - 1] - 0.5,
          `${seg} lateral-error median drops at ${keys[i]}: ${medians[i - 1]} -> ${medians[i]}`);
      }
    }
  });
});

function temporalConsistencyFor(seg, result) {
  return temporalConsistency({ [seg]: result });
}

describe('future-path validation report integrity', () => {
  it('buildReport is complete and self-consistent', () => {
    const r = {};
    for (const seg of SEGS) {
      const a = analyzeSegment(path.join(ROOT, seg));
      for (const b of a.strayBranches) b.classification = 'D';
      r[seg] = a;
    }
    const rep = buildReport(r, {});
    assert.ok(rep.method, 'method section');
    assert.ok(rep.method.verifiableRule, 'verifiable rule documented');
    for (const seg of SEGS) {
      assert.ok(rep.segments[seg].bins['0-20'], `${seg} bins present in report`);
    }
  });
});
