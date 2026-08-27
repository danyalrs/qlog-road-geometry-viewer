'use strict';

/**
 * Exact source-hash display correction regression (normal URL, mirror checked).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Probe = require('../lib/segment0_mirror_probe');
const VDC = require('../lib/viewer_display_corrections');
const VMC = require('../lib/viewer_mirror_coords');
const SLM = require('../lib/segment_local_map');
const VMB = require('../lib/viewer_map_build');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'reports', 'segment0_exact_correction');
const BASELINE = path.join(ROOT, 'reports', 'segment0_isolated_fix', 'baseline', 'dataset_geometry_baseline.json');
const SEG0_SHA = '9ddfc49b6061357e648a096d13749e30f9597827fd86786951241f098ea29fa5';

function hashPoints(points, fn) {
  let h = crypto.createHash('sha256');
  for (const p of points) {
    const d = fn(p);
    h.update(`${d.east.toFixed(6)},${d.north.toFixed(6)};`);
  }
  return h.digest('hex').slice(0, 8);
}

function loadMap(seg) {
  const pd = VMB.processSegmentLikeViewer(ROOT, seg);
  const map = SLM.buildSegmentLocalMap(pd, { geometrySource: 'pointAccumulated', fitEnabled: false });
  return { pd, map };
}

function segmentMetrics(seg, mirrorOn = true) {
  const { map } = loadMap(seg);
  const pts = map.pointAccumulated?.points || [];
  const traj = map.trajectory || [];
  const sha = map.sourceQlogSha256;
  const active = VDC.isExactDisplayCorrectionActive(mirrorOn, sha);
  const laneFn = (p) => {
    if (active) return VDC.transformDisplayPoint(p.localEast, p.localNorth);
    const r = VMC.resolveRoadDisplayCoords(
      p.localEast, p.localNorth, p.mirroredLocalEast, p.mirroredLocalNorth, mirrorOn,
      { trajectory: traj, useTrajectoryFallback: false },
    );
    return { east: r.east, north: r.north };
  };
  const roadVerts = Probe.ribbonVertices(map);
  const roadFn = (v) => (active
    ? VDC.transformDisplayPoint(v.east, v.north)
    : (() => {
      const r = VMC.resolveRoadDisplayCoords(v.east, v.north, null, null, mirrorOn, {
        trajectory: traj, useTrajectoryFallback: false,
      });
      return { east: r.east, north: r.north };
    })());
  const trajFn = (t) => (active
    ? VDC.transformDisplayPoint(t.east, t.north)
    : { east: t.east, north: t.north });
  const arrowPts = traj.slice(0, Math.min(50, traj.length));
  return {
    segment: seg,
    sourceQlogSha256: sha,
    mapChecksum: map.checksum,
    roadInput: Probe.roadInputChecksum(map).combined,
    manifestMatch: !!VDC.manifestEntry(sha),
    correctionActive: active,
    laneDisplayChecksum: hashPoints(pts, laneFn),
    roadRibbonChecksum: hashPoints(roadVerts, roadFn),
    trajectoryChecksum: hashPoints(traj, trajFn),
    arrowPathChecksum: hashPoints(arrowPts, trajFn),
  };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const segs = Probe.listQualifiedSegments(ROOT);
  const baseline = fs.existsSync(BASELINE)
    ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')).segments
    : {};
  const rows = [];
  let activeCount = 0;
  let inactiveCount = 0;
  let unaffectedChanged = 0;
  let baselineMismatch = 0;
  for (const seg of segs) {
    if (!Probe.findSegmentFile(ROOT, seg)) continue;
    const row = segmentMetrics(seg, true);
    if (row.correctionActive) activeCount += 1;
    else inactiveCount += 1;
    const base = baseline[seg];
    if (base) {
      const same = row.laneDisplayChecksum === base.laneDisplayChecksumOn
        && row.mapChecksum === base.mapChecksum
        && row.roadInput === base.roadInput?.combined;
      if (!row.correctionActive && !same) {
        unaffectedChanged += 1;
        baselineMismatch += 1;
      }
    }
    rows.push({ segment: seg, ...row, baselineLane: base?.laneDisplayChecksumOn ?? null });
  }
  const seg0 = rows.find((r) => r.sourceQlogSha256 === SEG0_SHA) || null;
  const seg2 = rows.find((r) => r.segment === 'qlog_f449c_2.bz2') || null;
  const seg99 = rows.find((r) => r.segment === 'qlog_f449c_99.bz2') || null;
  const summary = {
    generatedAt: new Date().toISOString(),
    total: rows.length,
    correctionActiveCount: activeCount,
    correctionInactiveCount: inactiveCount,
    unaffectedChangedCount: unaffectedChanged,
    baselineMismatchCount: baselineMismatch,
    seg0Sha: SEG0_SHA,
    seg0,
    seg2,
    seg99,
    pass: activeCount === 1
      && inactiveCount === rows.length - 1
      && unaffectedChanged === 0
      && seg0?.correctionActive === true
      && seg0?.laneDisplayChecksum === '3d809dfa'
      && seg2?.correctionActive === false
      && seg99?.correctionActive === false,
  };
  fs.writeFileSync(path.join(OUT, 'dataset_diff.json'), JSON.stringify(rows, null, 2));
  fs.writeFileSync(path.join(OUT, 'dataset_diff_summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.pass) process.exit(1);
}

main();
