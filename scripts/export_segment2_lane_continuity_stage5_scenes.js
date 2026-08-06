'use strict';

const fs = require('fs');
const path = require('path');
const { loadSegment, buildCtx, DC015_GAP } = require('../lib/lane_continuity_stage5');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'segment2_lane_continuity_stage5');

function scene(id, title, center, zoom, labels = []) {
  return { sceneId: id, title, center, zoom: zoom ?? 17, labels, layers: ['mode5_pb0'] };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const ctx = buildCtx(loadSegment({ bimodalClusterSelection: true }));
  const [g0, g1] = DC015_GAP;

  const scenes = [
    scene('lc_stage5_segment2_overview', 'Segment 2 Mode 5 overview', { east: -80, north: -55 }, 14, [
      { text: `checksum=${ctx.mode5.laneChecksum}`, x: 20, y: 24 },
      { text: 'DC-015 open', x: 20, y: 44 },
    ]),
    scene('lc_stage5_DC-015_corridor', 'DC-015 corridor close-up', { east: -120, north: -48 }, 16, [
      { text: `route-s ${g0.toFixed(1)}–${g1.toFixed(1)} m`, x: 20, y: 24 },
      { text: 'PB0 unsupported interior', x: 20, y: 44 },
    ]),
    scene('lc_stage5_DC-015_west_endpoint', 'DC-015 west endpoint s≈128 m', { east: -146, north: -47 }, 19, [
      { text: 'preceding run end', x: 20, y: 24 },
    ]),
    scene('lc_stage5_DC-015_east_endpoint', 'DC-015 east endpoint s≈260 m', { east: -99, north: -126 }, 19, [
      { text: 'following run start', x: 20, y: 24 },
    ]),
    scene('lc_stage5_raw_modelV2_overlay', 'Raw modelV2 obs in corridor', { east: -120, north: -48 }, 16, [
      { text: 'sparse mapped support', x: 20, y: 24 },
    ]),
    scene('lc_stage5_rejected_obs_overlay', 'Rejected bin overlay', { east: -120, north: -48 }, 16, [
      { text: 'D6/D7 rejected bins', x: 20, y: 24 },
    ]),
    scene('lc_stage5_tracker_overlay', 'Tracker assignment overlay', { east: -120, north: -48 }, 16, [
      { text: 'track 0 vs track 1', x: 20, y: 24 },
    ]),
    scene('lc_stage5_fusion_bins', 'Route-s fusion bins', { east: -120, north: -48 }, 16, [
      { text: '5 accepted / 19 rejected in gap', x: 20, y: 24 },
    ]),
    scene('lc_stage5_fused_vs_cleaned', 'Fused vs cleaned comparison', { east: -120, north: -48 }, 16, [
      { text: 'same open gap', x: 20, y: 24 },
    ]),
    scene('lc_stage5_boundary_identity', 'Physical boundary identity', { east: -120, north: -48 }, 16, [
      { text: 'PB0 track 0', x: 20, y: 24 },
    ]),
    scene('lc_stage5_recovery_none', 'Offline recovery: no reconstruction', { east: -120, north: -48 }, 16, [
      { text: 'verdict G — remain open', x: 20, y: 24 },
    ]),
    scene('lc_stage5_video_frame_before', 'Video frame proxy before gap', { east: -146, north: -47 }, 18, [
      { text: 'frame ~128 m vehicleS', x: 20, y: 24 },
    ]),
    scene('lc_stage5_video_frame_within', 'Video frame proxy within gap', { east: -115, north: -75 }, 17, [
      { text: 'interior dropout', x: 20, y: 24 },
    ]),
    scene('lc_stage5_video_frame_after', 'Video frame proxy after gap', { east: -99, north: -126 }, 18, [
      { text: 'frame ~260 m', x: 20, y: 24 },
    ]),
  ];

  const manifest = {
    generatedAt: new Date().toISOString(),
    method: 'lane-continuity-stage5-harness-v1',
    target: 'DC-015',
    routeSInterval: DC015_GAP,
    laneChecksum: ctx.mode5.laneChecksum,
    verdict: 'G_remain_open',
    captures: scenes.map((s) => ({
      filename: `${s.sceneId}.png`,
      sceneId: s.sceneId,
      title: s.title,
      laneChecksum: ctx.mode5.laneChecksum,
    })),
    status: 'exported',
    videoNote: 'qlog video not in workspace; frame-proxy scenes use route-s centres',
  };
  fs.writeFileSync(path.join(OUT, 'verification_scenes.json'), JSON.stringify({ scenes, ...manifest }, null, 2));
  fs.writeFileSync(path.join(OUT, 'capture_manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('Wrote', OUT);
}

main();
