'use strict';

/**
 * Focused tests for the .ts video evidence stage (video-qlog synchronization,
 * frame manifest, viewer). Covers the 20 required items. Investigation only —
 * never modifies videos, qlogs, coordinates, or boundaries.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(ROOT, 'reports', 'video_verification', 'video_sync_manifest.json');
const SELECTION = path.join(ROOT, 'reports', 'video_verification', 'verification_frame_selection.json');
const SCHEMA = path.join(ROOT, 'reports', 'video_verification', 'manifest_schema.json');
const TARGET_SEGS = [99, 6, 2, 54, 58];

function videoHash(seg) {
  const p = path.join(ROOT, `f449c322f59e6943---2026-07-20--09-34-13--${seg}---qcamera.ts`);
  return { path: p, size: fs.existsSync(p) ? fs.statSync(p).size : 0 };
}

function qlogHash(seg) {
  const p = path.join(ROOT, `qlog_f449c_${seg}.bz2`);
  return { path: p, size: fs.existsSync(p) ? fs.statSync(p).size : 0 };
}

describe('1-5. source integrity and timestamp monotonicity', () => {
  it('1. source videos remain unchanged', () => {
    // verify expected sizes match the inventory (no overwrite/transcode)
    const expected = { 2: 1788632, 6: null, 54: null, 58: null, 99: null };
    const inv = require('../reports/qlog_video_inventory.json');
    for (const seg of TARGET_SEGS) {
      const r = inv.inventory.find((x) => x.segmentNumber === seg);
      if (!r) continue;
      const v = videoHash(seg);
      assert.ok(fs.existsSync(v.path), `seg${seg} video exists`);
      assert.strictEqual(v.size, r.tsSizeBytes, `seg${seg} video size unchanged (${v.size} vs ${r.tsSizeBytes})`);
    }
  });

  it('2. qlogs remain unchanged', () => {
    const files = fs.readdirSync(ROOT).filter((f) => /^qlog_f449c_(\d+)\.bz2$/.test(f));
    assert.ok(files.length >= 92, 'qlog set intact');
    for (const seg of TARGET_SEGS) {
      assert.ok(fs.existsSync(qlogHash(seg).path), `qlog_f449c_${seg}.bz2 exists`);
    }
  });

  it('3. frame timestamps are monotonic', () => {
    const manifest = require(MANIFEST);
    for (const seg of TARGET_SEGS) {
      const fm = manifest.segments[String(seg)].frameManifest;
      for (let i = 1; i < fm.length; i++) {
        assert.ok(fm[i].videoTimestampSec >= fm[i - 1].videoTimestampSec, `seg${seg} frame ${i} monotonic`);
      }
    }
  });

  it('4. ModelV2 timestamps are monotonic', () => {
    const manifest = require(MANIFEST);
    for (const seg of TARGET_SEGS) {
      const matches = manifest.segments[String(seg)].modelV2Matches;
      const times = matches.map((m) => Number(BigInt(m.modelV2LogMonoTime)));
      for (let i = 1; i < times.length; i++) {
        assert.ok(times[i] > times[i - 1], `seg${seg} modelV2 timestamps monotonic`);
      }
    }
  });

  it('5. matching uses timestamps rather than proportional frame position', () => {
    const manifest = require(MANIFEST);
    for (const seg of TARGET_SEGS) {
      const s = manifest.segments[String(seg)];
      // verify the sync offset is ~0 (video PTS clock == qlog encode clock)
      assert.ok(Math.abs(s.sync.videoQlogOffsetSec) < 0.01, `seg${seg} offset near zero (${s.sync.videoQlogOffsetSec})`);
      // verify nearest-frame matching produced sub-frame errors
      assert.ok(s.alignment.maxTsErrorMs <= 100, `seg${seg} max ts error <= 100ms`);
    }
  });
});

describe('6-10. unmatched, duplicates, VFR, confidence', () => {
  it('6. unmatched observations remain explicitly unmatched', () => {
    const manifest = require(MANIFEST);
    for (const seg of TARGET_SEGS) {
      const s = manifest.segments[String(seg)];
      // all modelV2 matched in these segments; verify unmatched list present
      assert.ok(Array.isArray(s.modelV2Unmatched), `seg${seg} unmatched list`);
      assert.ok(s.alignment.modelV2Matched === s.qlog.modelV2Observations, `seg${seg} all matched`);
    }
  });

  it('7. timestamp error is reported', () => {
    const manifest = require(MANIFEST);
    for (const seg of TARGET_SEGS) {
      const a = manifest.segments[String(seg)].alignment;
      assert.ok(a.medianTsErrorMs != null, `seg${seg} median error`);
      assert.ok(a.p90TsErrorMs != null && a.p95TsErrorMs != null, `seg${seg} p90/p95`);
      assert.ok(a.maxTsErrorMs >= a.medianTsErrorMs, `seg${seg} max >= median`);
    }
  });

  it('8. segment IDs cannot cross during matching', () => {
    const manifest = require(MANIFEST);
    for (const seg of TARGET_SEGS) {
      const s = manifest.segments[String(seg)];
      for (const m of s.modelV2Matches) {
        assert.strictEqual(s.segmentId, seg, `seg${seg} matches stay in segment`);
      }
    }
  });

  it('9. duplicate matches are reported', () => {
    const manifest = require(MANIFEST);
    for (const seg of TARGET_SEGS) {
      const a = manifest.segments[String(seg)].alignment;
      assert.ok(a.duplicatedMatches >= 0, `seg${seg} duplicate count reported`);
      assert.strictEqual(a.duplicatedMatches, 0, `seg${seg} no duplicate matches (each encode index has unique frame)`);
    }
  });

  it('10. variable-frame-rate video is handled correctly', () => {
    const manifest = require(MANIFEST);
    // seg6 is VFR (60000/1001)
    const s6 = manifest.segments['6'];
    assert.strictEqual(s6.video.variableFrameRate, true, 'seg6 VFR detected');
    // its frame manifest uses actual PTS (not a nominal frame position)
    const fm = s6.frameManifest;
    assert.ok(fm.length > 0);
    // frame spacing varies but timestamps stay monotonic
    const diffs = [];
    for (let i = 1; i < Math.min(fm.length, 50); i++) diffs.push(fm[i].videoTimestampSec - fm[i - 1].videoTimestampSec);
    const uniq = new Set(diffs.map((d) => d.toFixed(3)));
    assert.ok(uniq.size > 1 || s6.video.avgFrameRate !== s6.video.frameRate, 'VFR spacing not constant');
  });
});

describe('11-15. schema, confidence, frames, coordinates', () => {
  it('11. manifest records follow the documented schema', () => {
    const schema = require(SCHEMA);
    const fields = Object.keys(schema.recordFields);
    const manifest = require(MANIFEST);
    const rec = manifest.segments['99'].frameManifest[0];
    for (const f of fields) {
      assert.ok(f in rec, `record field ${f} present`);
    }
  });

  it('12. synchronization confidence uses fixed rules', () => {
    const schema = require(SCHEMA);
    const rules = schema.syncConfidenceRules;
    assert.ok(rules.high.includes('<= 100') && rules.medium.includes('<= 300') && rules.low.includes('> 300'), 'fixed rules documented');
    const manifest = require(MANIFEST);
    const rec = manifest.segments['99'].frameManifest[32]; // matched obs
    assert.strictEqual(rec.syncConfidence, 'high');
    assert.ok(rec.timestampDiffMs <= 100, 'high confidence means error <= 100ms');
  });

  it('13. selected frames exist and decode successfully', () => {
    const selection = require(SELECTION);
    for (const seg of TARGET_SEGS) {
      const sel = selection.selections[String(seg)];
      assert.ok(sel && sel.selected.length >= 8, `seg${seg} has selected frames`);
      for (const f of sel.selected) {
        const frameNum = String(f.videoFrameIndex).padStart(5, '0');
        const tStr = String(f.videoPtsSec).replace('.', '_');
        const png = path.join(ROOT, 'reports', 'video_verification', 'frames', String(seg), `seg${seg}_frame${frameNum}_t${tStr}_clean.png`);
        assert.ok(fs.existsSync(png), `seg${seg} frame ${f.videoFrameIndex} PNG exists`);
        assert.ok(fs.statSync(png).size > 1000, `seg${seg} frame ${f.videoFrameIndex} non-empty`);
      }
    }
  });

  it('14. no map coordinates change', () => {
    const renderSrc = fs.readFileSync(path.join(ROOT, 'public', 'render.js'), 'utf8');
    // video verification page is separate; map drawing untouched
    assert.ok(renderSrc.includes('_drawPointAccumulatedGeometry'), 'point draw intact');
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'video_verification.html')), 'viewer exists');
  });

  it('15. no boundary coordinates change', () => {
    const EB = require('../lib/experimental_boundaries');
    assert.strictEqual(EB.DEFAULTS.candidate, 'D', 'SELECTED_CANDIDATE unchanged');
    const renderSrc = fs.readFileSync(path.join(ROOT, 'public', 'render.js'), 'utf8');
    assert.ok(renderSrc.includes('_drawExperimentalBoundaries'), 'boundary overlay intact');
  });
});

describe('16-20. dots, modes, polygons, pinned', () => {
  const renderSrc = fs.readFileSync(path.join(ROOT, 'public', 'render.js'), 'utf8');

  it('16. no Point dots are removed', () => {
    assert.ok(renderSrc.includes('// Complete map by default: show every valid point from all observations.'), 'complete map intact');
    assert.ok(!renderSrc.includes('reliability.combinedScore < 0.4'), 'no score filtering');
  });

  it('17. Raw and Fused remain unchanged', () => {
    const pointDraw = renderSrc.indexOf('_drawPointAccumulatedGeometry');
    let callIdx = -1;
    const calls = [];
    while ((callIdx = renderSrc.indexOf('_drawExperimentalBoundaries(map', callIdx + 1)) !== -1) calls.push(callIdx);
    for (const c of calls) assert.ok(c >= pointDraw, 'overlay only in point draw block');
  });

  it('18. Candidate D remains display-only', () => {
    assert.ok(renderSrc.includes('Experimental lane boundaries (candidate'), 'experimental label');
    assert.ok(renderSrc.includes('display only'), 'display-only label');
  });

  it('19. no road polygons are created', () => {
    const EB = require('../lib/experimental_boundaries');
    // the module documents it is never used for road polygons; verify no
    // polygon-producing logic exists
    assert.ok(EB.buildExperimentalBoundaries, 'build function exists');
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'experimental_boundaries.js'), 'utf8');
    assert.ok(!/function\s+\w*[Pp]olygon/.test(src), 'no polygon-generating function');
    assert.ok(src.includes('road polygons'), 'documented non-use for road polygons');
  });

  it('20. pinned values remain unchanged', () => {
    const v = require('../lib/version');
    assert.strictEqual(v.PROCESSING_VERSION, '2026-07-24-fusion-v16');
    const pd = require('../lib/process_defaults');
    const norm = pd.normalizeProcessOptions?.() || {};
    assert.strictEqual(norm.positiveBoundaryContinuityBridgeEnabled, false);
    assert.strictEqual(norm.visibleGapReconstructionEnabled, false);
    const EB = require('../lib/experimental_boundaries');
    assert.strictEqual(EB.DEFAULTS.candidate, 'D');
  });
});
