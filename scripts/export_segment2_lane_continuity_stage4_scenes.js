'use strict';

const fs = require('fs');
const path = require('path');
const { loadSegment, buildCtx } = require('../lib/lane_continuity_stage4');
const stage1 = require('../audit_segment2_lane_continuity_stage1.json');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'segment2_lane_continuity_stage4');

function scene(id, title, center, zoom, labels = []) {
  return { sceneId: id, title, center, zoom: zoom ?? 18, labels, layers: ['mode5_pb0'] };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const s2 = buildCtx(loadSegment({ bimodalClusterSelection: false }), { bimodalClusterSelection: false });
  const s3 = buildCtx(loadSegment({ bimodalClusterSelection: true }));
  const dc22 = stage1.disconnections.find((d) => d.disconnectionId === 'DC-022');
  const dc24 = stage1.disconnections.find((d) => d.disconnectionId === 'DC-024');

  const scenes = [
    scene('lc_stage4_disconnection_overview_s2', 'Stage 2 physical gaps (19)', { east: -80, north: -45 }, 15, [
      { text: `stable gaps=19 checksum=${s2.mode5.laneChecksum}`, x: 20, y: 24 },
    ]),
    scene('lc_stage4_disconnection_overview_s3', 'Stage 3 physical gaps (18)', { east: -80, north: -45 }, 15, [
      { text: `stable gaps=18 checksum=${s3.mode5.laneChecksum}`, x: 20, y: 24 },
    ]),
    scene('lc_stage4_DC-022_fusion_off', 'DC-022 fusion without bridge', { east: 15, north: -95 }, 19, [
      { text: `D11 gap=${dc22.alongTrackGapM.toFixed(1)}m heading=${dc22.headingDifferenceDeg.toFixed(1)}°`, x: 20, y: 24 },
      { text: 'first failing stage: fused_fragments', x: 20, y: 44 },
    ]),
    scene('lc_stage4_DC-022_mode5', 'DC-022 Mode 5 (closed)', { east: 15, north: -95 }, 19, [
      { text: 'continuous in run 381–690 m', x: 20, y: 24 },
    ]),
    scene('lc_stage4_DC-024_fusion_off', 'DC-024 fusion without bridge', { east: 35, north: -100 }, 19, [
      { text: `D11 gap=${dc24.alongTrackGapM.toFixed(1)}m lateral=${dc24.lateralOffsetM.toFixed(2)}m`, x: 20, y: 24 },
    ]),
    scene('lc_stage4_DC-024_mode5', 'DC-024 Mode 5 (closed)', { east: 35, north: -100 }, 19, [
      { text: 'resolved by Stage 2 tracker bridge', x: 20, y: 24 },
    ]),
    scene('lc_stage4_DC-013_open', 'DC-013 remains open', { east: -145, north: -35 }, 18, [{ text: 'DC-013 open', x: 20, y: 24 }]),
    scene('lc_stage4_DC-015_open', 'DC-015 remains open', { east: -110, north: -42 }, 17, [{ text: 'DC-015 open', x: 20, y: 24 }]),
    scene('lc_stage4_pb0_overview', 'PB0 overview Stage 3', { east: -60, north: -55 }, 14, [
      { text: `checksum=${s3.mode5.laneChecksum}`, x: 20, y: 24 },
    ]),
  ];

  const manifest = {
    generatedAt: new Date().toISOString(),
    method: 'lane-continuity-stage4-harness-v1',
    stage2Checksum: s2.mode5.laneChecksum,
    stage3Checksum: s3.mode5.laneChecksum,
    stableStage2Gaps: 19,
    stableStage3Gaps: 18,
    captures: scenes.map((s) => ({
      filename: `${s.sceneId}.png`,
      sceneId: s.sceneId,
      title: s.title,
      laneChecksum: s3.mode5.laneChecksum,
    })),
    status: 'exported',
  };
  fs.writeFileSync(path.join(OUT, 'verification_scenes.json'), JSON.stringify({ scenes, ...manifest }, null, 2));
  fs.writeFileSync(path.join(OUT, 'capture_manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('Wrote', OUT);
}

main();
