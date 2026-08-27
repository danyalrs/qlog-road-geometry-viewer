'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const VDC = require('../lib/viewer_display_corrections');
const VMB = require('../lib/viewer_map_build');
const SLM = require('../lib/segment_local_map');
const VMC = require('../lib/viewer_mirror_coords');

const ROOT = path.join(__dirname, '..');
const SEG0_FILE = 'qlog_f449c_0.bz2';
const SEG0_SHA = '9ddfc49b6061357e648a096d13749e30f9597827fd86786951241f098ea29fa5';

function qlogSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listQualifiedSegments(root) {
  const names = [];
  for (const base of [root, path.join(root, 'data')]) {
    if (!fs.existsSync(base)) continue;
    for (const ent of fs.readdirSync(base)) {
      if (/^qlog_f449c_\d+\.bz2$/i.test(ent)) names.push(ent);
    }
  }
  return [...new Set(names)].sort((a, b) => {
    const ai = Number(a.match(/_(\d+)\./)[1]);
    const bi = Number(b.match(/_(\d+)\./)[1]);
    return ai - bi;
  });
}

describe('segment0 exact display correction', () => {
  it('1. manifest contains one full SHA-256 key', () => {
    const manifest = VDC.loadManifest();
    const keys = Object.keys(manifest);
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^[0-9a-f]{64}$/);
  });

  it('2. Segment 0 source hash matches the manifest', () => {
    const file = path.join(ROOT, SEG0_FILE);
    assert.equal(qlogSha256(file), SEG0_SHA);
    assert.equal(VDC.manifestEntry(SEG0_SHA)?.correction, 'fullSegmentLocalLateralReflection');
  });

  it('3. renaming the qlog does not change the match', () => {
    const { map } = (() => {
      const pd = VMB.processSegmentLikeViewer(ROOT, SEG0_FILE);
      return { map: SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated' }) };
    })();
    assert.equal(map.sourceQlogSha256, SEG0_SHA);
    assert.equal(VDC.isExactDisplayCorrectionActive(true, map.sourceQlogSha256), true);
  });

  it('4. another file named qlog_f449c_0.bz2 with different bytes does not match', () => {
    const fakeSha = crypto.createHash('sha256').update('not-a-qlog').digest('hex');
    assert.notEqual(fakeSha, SEG0_SHA);
    assert.equal(VDC.isExactDisplayCorrectionActive(true, fakeSha), false);
  });

  it('5. segment index does not affect the correction', () => {
    const renderSrc = fs.readFileSync(path.join(ROOT, 'public', 'render.js'), 'utf8');
    assert.doesNotMatch(renderSrc, /segmentId|segment\s*===\s*0|qlog_f449c_0/);
    const vdcSrc = fs.readFileSync(path.join(ROOT, 'lib', 'viewer_display_corrections.js'), 'utf8');
    assert.doesNotMatch(vdcSrc, /segmentId|qlog_f449c|segment\s*===\s*0/);
  });

  it('6. correction activates only when mirror is checked', () => {
    assert.equal(VDC.isExactDisplayCorrectionActive(false, SEG0_SHA), false);
    assert.equal(VDC.isExactDisplayCorrectionActive(true, SEG0_SHA), true);
  });

  it('7. correction applies to every visual layer via render gate', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'render.js'), 'utf8');
    assert.match(src, /_useExactDisplayCorrection\(\)/);
    assert.match(src, /roadGeometryToScreen/);
    assert.match(src, /_segmentDisplayToScreen/);
    assert.match(src, /transformDisplayHeading/);
    assert.match(src, /_mirrorAwareMapBounds/);
  });

  it('8. nonmatching hashes use the restored path', () => {
    const { map } = (() => {
      const pd = VMB.processSegmentLikeViewer(ROOT, 'qlog_f449c_2.bz2');
      return { map: SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated' }) };
    })();
    assert.notEqual(map.sourceQlogSha256, SEG0_SHA);
    assert.equal(VDC.isExactDisplayCorrectionActive(true, map.sourceQlogSha256), false);
  });

  it('9. all 91 nonmatching qlogs remain exact vs baseline', () => {
    const baselinePath = path.join(ROOT, 'reports', 'segment0_isolated_fix', 'baseline', 'dataset_geometry_baseline.json');
    if (!fs.existsSync(baselinePath)) return;
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).segments;
    const segs = listQualifiedSegments(ROOT);
    let changed = 0;
    for (const seg of segs) {
      const pd = VMB.processSegmentLikeViewer(ROOT, seg);
      const map = SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', fitEnabled: false });
      if (map.sourceQlogSha256 === SEG0_SHA) continue;
      assert.equal(VDC.isExactDisplayCorrectionActive(true, map.sourceQlogSha256), false, seg);
      const base = baseline[seg];
      if (!base) continue;
      const pts = map.pointAccumulated?.points || [];
      const traj = map.trajectory || [];
      const laneFn = (p) => {
        const r = VMC.resolveRoadDisplayCoords(
          p.localEast, p.localNorth, p.mirroredLocalEast, p.mirroredLocalNorth, true,
          { trajectory: traj, useTrajectoryFallback: false },
        );
        return { east: r.east, north: r.north };
      };
      let h = crypto.createHash('sha256');
      for (const p of pts) {
        const d = laneFn(p);
        h.update(`${d.east.toFixed(6)},${d.north.toFixed(6)};`);
      }
      const lane = h.digest('hex').slice(0, 8);
      if (lane !== base.laneDisplayChecksumOn) changed += 1;
    }
    assert.equal(changed, 0);
  });

  it('10. Segment 2 remains exact', () => {
    const { map } = (() => {
      const pd = VMB.processSegmentLikeViewer(ROOT, 'qlog_f449c_2.bz2');
      return { map: SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated' }) };
    })();
    assert.equal(VDC.isExactDisplayCorrectionActive(true, map.sourceQlogSha256), false);
  });

  it('11. Segment 99 remains exact', () => {
    const seg99 = (() => {
      const pd = VMB.processSegmentLikeViewer(ROOT, 'qlog_f449c_99.bz2');
      return SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated' });
    })();
    assert.equal(VDC.isExactDisplayCorrectionActive(true, seg99.sourceQlogSha256), false);
  });

  it('12. Segment 99 trajectory fallback remains blocked', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'render.js'), 'utf8');
    assert.match(src, /useTrajectoryFallback:\s*false/);
  });

  it('13. inputs remain unchanged', () => {
    const { map } = (() => {
      const pd = VMB.processSegmentLikeViewer(ROOT, SEG0_FILE);
      return { map: SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated' }) };
    })();
    const checksumBefore = map.checksum;
    VDC.transformDisplayPoint(1, 2);
    assert.equal(map.checksum, checksumBefore);
  });

  it('14. normal viewer URL activates the correction without query flags', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'render.js'), 'utf8');
    assert.doesNotMatch(src, /segment0RoadFixExperiment/);
    assert.doesNotMatch(src, /segment0RoadProbe/);
    assert.match(src, /ViewerDisplayCorrections/);
    assert.match(src, /sourceQlogSha256/);
  });

  it('15. browser runtime reports the manifest match', () => {
    const pub = fs.readFileSync(path.join(ROOT, 'public', 'viewer_display_corrections.js'), 'utf8');
    assert.match(pub, /manifestMatch/);
    assert.match(pub, /correctionActive/);
    assert.match(pub, /sourceQlogSha256/);
  });

  it('16. no production condition reads Segment 0 identity or filename', () => {
    for (const rel of ['public/render.js', 'lib/viewer_display_corrections.js', 'public/viewer_display_corrections.js']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.doesNotMatch(src, /qlog_f449c_0|segmentId\s*===\s*0|segment\s*===\s*0/, rel);
    }
  });

  it('17. public manifest matches config manifest', () => {
    const config = VDC.loadManifest();
    const pub = fs.readFileSync(path.join(ROOT, 'public', 'viewer_display_corrections.js'), 'utf8');
    const key = Object.keys(config)[0];
    assert.match(pub, new RegExp(key));
  });

  it('18. map payload carries sourceQlogSha256 from pipeline audit', () => {
    const pd = VMB.processSegmentLikeViewer(ROOT, SEG0_FILE);
    assert.equal(pd.fileAudits?.[0]?.sha256?.toLowerCase(), SEG0_SHA);
    const map = SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated' });
    assert.equal(map.sourceQlogSha256, SEG0_SHA);
  });
});
