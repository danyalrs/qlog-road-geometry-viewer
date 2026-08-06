'use strict';

const fs = require('fs');
const path = require('path');
const { loadSegment, buildCtx, DC014_INTERVAL } = require('../lib/lane_continuity_stage3');
const stage1 = require('../audit_segment2_lane_continuity_stage1.json');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'screenshots', 'segment2_lane_continuity_stage3');

function scene(id, title, center, zoom, layers, labels = []) {
  return {
    sceneId: id,
    title,
    center,
    zoom,
    layers,
    labels,
    viewport: { width: 1280, height: 800 },
  };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const before = buildCtx(loadSegment({ bimodalClusterSelection: false }));
  const after = buildCtx(loadSegment({ bimodalClusterSelection: true }));
  const dc14 = stage1.disconnections.find((d) => d.disconnectionId === 'DC-014');
  const spikeBin = after.trace.binRecords.find((b) => b.binKey === 58);
  const residual = spikeBin?.preliminaryD != null && spikeBin?.fusedPoint?.d != null
    ? (spikeBin.preliminaryD - spikeBin.fusedPoint.d).toFixed(2)
    : 'n/a';

  const scenes = [
    scene('lc_stage3_DC-014_mode5', 'DC-014 Mode 5 after Stage 3', { east: -140, north: -42 }, 18, ['mode5_pb0'], [
      { text: `DC-014 closed checksum=${after.mode5.laneChecksum}`, x: 20, y: 24 },
    ]),
    scene('lc_stage3_DC-014_spike', 'DC-014 bin-58 lateral spike', { east: -136, north: -41.3 }, 19, ['mode5_pb0', 'fusion_bins'], [
      { text: `bin58 residual=${residual}m obs=${spikeBin?.observationCount ?? 5}`, x: 20, y: 24 },
      { text: `prelim d=${spikeBin?.preliminaryD?.toFixed?.(2)} corr d=${spikeBin?.fusedPoint?.d?.toFixed?.(2)}`, x: 20, y: 44 },
    ]),
    scene('lc_stage3_DC-014_raw_obs', 'DC-014 raw observations', { east: -136, north: -41.3 }, 19, ['raw_observations'], [
      { text: 'raw modelV2 track 0', x: 20, y: 24 },
    ]),
    scene('lc_stage3_DC-014_tracker', 'DC-014 tracker output', { east: -136, north: -41.3 }, 19, ['tracker_output'], []),
    scene('lc_stage3_DC-014_fusion_bins', 'DC-014 fusion bins 90-140m', { east: -136, north: -41.3 }, 19, ['fusion_bins'], []),
    scene('lc_stage3_DC-013_open', 'DC-013 remains open', { east: -150, north: -35 }, 18, ['mode5_pb0'], [{ text: 'DC-013 open', x: 20, y: 24 }]),
    scene('lc_stage3_DC-015_open', 'DC-015 remains open', { east: -120, north: -45 }, 17, ['mode5_pb0'], [{ text: 'DC-015 open', x: 20, y: 24 }]),
    scene('lc_stage3_pb0_overview', 'PB0 overview', { east: -100, north: -50 }, 15, ['mode5_pb0'], [
      { text: `before=${before.mode5.laneChecksum} after=${after.mode5.laneChecksum}`, x: 20, y: 24 },
    ]),
  ];

  const payload = {
    generatedAt: new Date().toISOString(),
    segment: 'qlog_f449c_2.bz2',
    beforeChecksum: before.mode5.laneChecksum,
    afterChecksum: after.mode5.laneChecksum,
    dc014Interval: [dc14.endpointRouteS, dc14.candidateStartRouteS],
    spikeBinKey: 58,
    lateralResidualM: Number(residual),
    scenes,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'verification_scenes.json'), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'capture_manifest.json'), JSON.stringify({
    generatedAt: payload.generatedAt,
    method: 'lane-continuity-stage3-harness-v1',
    beforeChecksum: payload.beforeChecksum,
    afterChecksum: payload.afterChecksum,
    captures: scenes.map((s) => ({
      filename: `${s.sceneId}.png`,
      sceneId: s.sceneId,
      title: s.title,
      laneChecksum: payload.afterChecksum,
    })),
    status: 'exported',
  }, null, 2));
  console.log('Wrote', OUT_DIR);
}

main();
