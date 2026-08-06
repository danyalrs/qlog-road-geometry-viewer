/** @typedef {import('node:test')} test */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { classifySegment, qualifySegments } = require('../lib/segment_qualify');
const { buildFrameStats } = require('../lib/frame_stats');
const { buildCacheKey, configHash } = require('../lib/qlog_audit');

describe('segment qualification', () => {
  it('flags truncated segment with one modelV2', () => {
    const audit = {
      filename: 'qlog_f449c_6.bz2',
      sha256: 'cd5ddf28b7426399254ecd8af2ab2151e31562c5ad9a8994c475264114f99d86',
      modelV2Count: 1,
      fileSizeBytes: 143360,
      durationSec: { modelV2: 2, gps: 2 },
      firstTimestamp: { modelV2: '100' },
      lastTimestamp: { modelV2: '102000000000' },
    };
    const q = classifySegment(audit, { gapFromPrevSec: 58 });
    assert.ok(q.flags.includes('incompleteLog'));
    assert.ok(q.flags.includes('insufficientTemporalObservations'));
    assert.equal(q.allowFusion, false);
    assert.equal(q.allowPasses, false);
  });

  it('allows normal 60s segment', () => {
    const audit = {
      filename: 'qlog_f449c_5.bz2',
      modelV2Count: 30,
      fileSizeBytes: 2788736,
      durationSec: { modelV2: 58 },
      firstTimestamp: { modelV2: '1' },
      lastTimestamp: { modelV2: '58000000001' },
    };
    const q = classifySegment(audit);
    assert.equal(q.allowFusion, true);
    assert.equal(q.flags.length, 0);
  });
});

describe('frame stats', () => {
  it('separates raw modelV2 from gps-aligned frames', () => {
    const modelEvents = [
      { sourceFile: 'a.bz2', modelV2: { frameId: 1, laneLines: [{ x: [0, 1], y: [0, 1] }], laneLineProbs: [0.9] } },
      { sourceFile: 'a.bz2', modelV2: { frameId: 2, laneLines: [] } },
    ];
    const transformed = [
      { sourceFile: 'a.bz2', frameId: 1, pose: { headingSource: 'gps' } },
    ];
    const stats = buildFrameStats(modelEvents, transformed);
    assert.equal(stats.totals.rawModelV2Messages, 2);
    assert.equal(stats.totals.parsedModelFrames, 1);
    assert.equal(stats.totals.gpsAlignedFrames, 1);
    assert.equal(stats.perFile['a.bz2'].rawModelV2Messages, 2);
    assert.equal(stats.perFile['a.bz2'].gpsAlignedFrames, 1);
  });
});

describe('cache key', () => {
  it('includes file hash not just filename', () => {
    const a1 = [{ filename: 'q.bz2', sha256: 'aaa' }];
    const a2 = [{ filename: 'q.bz2', sha256: 'bbb' }];
    const k1 = buildCacheKey(['q.bz2'], {}, a1, 'v1');
    const k2 = buildCacheKey(['q.bz2'], {}, a2, 'v1');
    assert.notEqual(k1, k2);
    assert.ok(k1.includes('aaa'));
  });
});
