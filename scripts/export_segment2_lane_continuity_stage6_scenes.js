'use strict';

const fs = require('fs');
const path = require('path');
const { loadSegment, buildCtx, SAFE_FUSION_CANDIDATE_IDS, DASHED_MARKING_SUSPECT_IDS } = require('../lib/lane_continuity_stage6');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'segment2_lane_continuity_stage6');

function scene(id, title, center, zoom, labels = []) {
  return { sceneId: id, title, center, zoom: zoom ?? 18, labels };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ctx = buildCtx(loadSegment({ bimodalClusterSelection: true }));
  const scenes = [
    scene('lc_stage6_overview', 'Stage 6 candidate overview', { east: -60, north: -80 }, 14, [
      { text: `checksum=${ctx.mode5.laneChecksum}`, x: 20, y: 24 },
      { text: '7 candidates classified', x: 20, y: 44 },
    ]),
    ...SAFE_FUSION_CANDIDATE_IDS.map((id) =>
      scene(`lc_stage6_${id}_fusion`, `${id} PB1 fusion candidate`, { east: 20, north: -95 }, 17, [
        { text: `verdict=A eligible later repair`, x: 20, y: 24 },
      ])),
    ...DASHED_MARKING_SUSPECT_IDS.map((id) =>
      scene(`lc_stage6_${id}_dashed`, `${id} dashed-marking suspect`, { east: 5, north: -75 }, 19, [
        { text: 'verdict=D continuous identity', x: 20, y: 24 },
      ])),
    scene('lc_stage6_DC-015_preserved', 'DC-015 remains open', { east: -110, north: -48 }, 16, [
      { text: 'PB0|128.15|260.57 open', x: 20, y: 24 },
    ]),
  ];
  const manifest = {
    generatedAt: new Date().toISOString(),
    method: 'lane-continuity-stage6-harness-v1',
    laneChecksum: ctx.mode5.laneChecksum,
    safeFusionIds: SAFE_FUSION_CANDIDATE_IDS,
    dashedSuspectIds: DASHED_MARKING_SUSPECT_IDS,
    captures: scenes.map((s) => ({
      filename: `${s.sceneId}.png`,
      sceneId: s.sceneId,
      title: s.title,
    })),
    status: 'exported',
  };
  fs.writeFileSync(path.join(OUT, 'verification_scenes.json'), JSON.stringify({ scenes, ...manifest }, null, 2));
  fs.writeFileSync(path.join(OUT, 'capture_manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('Wrote', OUT);
}

main();
