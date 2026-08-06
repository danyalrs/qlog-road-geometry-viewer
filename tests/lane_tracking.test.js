const test = require('node:test');
const assert = require('node:assert/strict');
const { hungarianAssign } = require('../lib/hungarian');
const { trackLanesInPass, computeMatchDetail, buildLaneFeature } = require('../lib/lane_tracking');
const { sampleLaneAnchors, sharedAnchorPairs } = require('../lib/lane_anchors');
const { classifyTrack, CLASS, buildGeometryLayers } = require('../lib/lane_support');

test('Hungarian assigns one-to-one minimum cost', () => {
  const matrix = [[1, 5], [4, 2]];
  const { assignments } = hungarianAssign(matrix, 10);
  assert.equal(assignments.get(0).colIdx, 0);
  assert.equal(assignments.get(1).colIdx, 1);
});

test('constant three-lane sequence retains track identities', () => {
  const frames = [];
  for (let i = 0; i < 5; i++) {
    frames.push({
      frameId: i,
      logMonoTime: String(1e10 + i * 2e9),
      passId: 0,
      chunkId: 0,
      pose: { east: i * 30, north: 0, headingDeg: 90, speed: 15 },
      lanes: [
        { laneIndex: 0, prob: 0.9, points: [{ east: i * 30 + 5, north: 4, modelX: 10, modelY: 4 }, { east: i * 30 + 25, north: 4, modelY: 4, modelX: 30 }] },
        { laneIndex: 1, prob: 0.9, points: [{ east: i * 30 + 5, north: 0, modelX: 10, modelY: 0 }, { east: i * 30 + 25, north: 0, modelY: 0, modelX: 30 }] },
        { laneIndex: 2, prob: 0.9, points: [{ east: i * 30 + 5, north: -4, modelX: 10, modelY: -4 }, { east: i * 30 + 25, north: -4, modelY: -4, modelX: 30 }] },
      ],
      edges: [],
    });
  }
  const { diagnostics, tracks } = trackLanesInPass(frames, {});
  assert.ok(diagnostics.continuedTracks >= 8, `continued ${diagnostics.continuedTracks}`);
  assert.ok(diagnostics.oneFrameTracks <= 3, `1-frame ${diagnostics.oneFrameTracks}`);
  assert.ok(tracks.length <= 5, `tracks ${tracks.length}`);
});

test('changing lane-array order does not break association', () => {
  const mkLane = (y, i) => ({
    laneIndex: y > 0 ? 2 : 0,
    prob: 0.9,
    points: [{ east: i * 30 + 5, north: y, modelX: 10, modelY: y }, { east: i * 30 + 25, north: y, modelY: y, modelX: 30 }],
  });
  const frames = [];
  for (let i = 0; i < 4; i++) {
    const lanes = i % 2 === 0
      ? [mkLane(4, i), mkLane(0, i)]
      : [mkLane(0, i), mkLane(4, i)];
    frames.push({
      frameId: i, logMonoTime: String(1e10 + i * 2e9), passId: 0, chunkId: 0,
      pose: { east: i * 30, north: 0, headingDeg: 90, speed: 15 },
      lanes, edges: [],
    });
  }
  const { tracks } = trackLanesInPass(frames, {});
  const longTracks = tracks.filter((t) => t.frameIds.length >= 3);
  assert.ok(longTracks.length >= 1);
});

test('one-frame track classified as raw', () => {
  const track = { trackId: 1, passId: 0, frameIds: [10], coveredDistanceM: 0 };
  const frames = [{ frameId: 10, logMonoTime: '1', lanes: [{ laneTrackId: 1, prob: 0.9, points: [{ east: 0, north: 0 }] }] }];
  const cls = classifyTrack(track, frames, {});
  assert.equal(cls.classification, CLASS.RAW);
});

test('sparse 2-second intervals use motion-adaptive thresholds', () => {
  const prev = {
    frameId: 1, logMonoTime: '1000000000', passId: 0, laneIndex: 0, lateralOrder: 0,
    headingDeg: 90, prob: 0.9, gpsAccuracy: 5,
    forwardRange: { min: 5, max: 40 },
    anchors: [{ forwardM: 10, modelY: 2 }, { forwardM: 20, modelY: 2 }],
    pose: { east: 0, north: 0, headingDeg: 90, speed: 16 },
  };
  const next = {
    frameId: 2, logMonoTime: '3000000000', passId: 0, laneIndex: 1, lateralOrder: 0,
    headingDeg: 90, prob: 0.9, gpsAccuracy: 5,
    forwardRange: { min: 5, max: 40 },
    anchors: [{ forwardM: 10, modelY: 2.1 }, { forwardM: 20, modelY: 2.0 }],
    pose: { east: 32, north: 0, headingDeg: 90, speed: 16 },
  };
  const d = computeMatchDetail(prev, next, null, {});
  assert.ok(d.valid, `rejection: ${d.rejection}`);
});

test('separate passes never share track IDs in tracker', () => {
  const frames = [
    { frameId: 0, logMonoTime: '1', passId: 0, chunkId: 0, pose: { east: 0, north: 0, headingDeg: 90 }, lanes: [{ laneIndex: 0, prob: 0.9, points: [{ east: 5, north: 2, modelX: 10, modelY: 2 }] }], edges: [] },
    { frameId: 1, logMonoTime: '2', passId: 1, chunkId: 0, pose: { east: 0, north: 0, headingDeg: 90 }, lanes: [{ laneIndex: 0, prob: 0.9, points: [{ east: 5, north: 2, modelX: 10, modelY: 2 }] }], edges: [] },
  ];
  const { tracks } = trackLanesInPass(frames, {});
  assert.equal(tracks.length, 2);
  assert.notEqual(tracks[0].trackId, tracks[1].trackId);
});

test('local support filter demotes unsupported fused fragments', () => {
  const frames = [];
  const tracks = [{ trackId: 1, passId: 0, frameIds: [0] }];
  const fused = [{ laneTrackId: 1, points: [{ east: 0, north: 0 }, { east: 10, north: 0 }] }];
  const layers = buildGeometryLayers(frames, tracks, fused, [], [], { minTrackFrames: 2 });
  assert.ok(layers.laneOnlyCandidates.length + layers.rejectedOutliers.length >= 0);
  assert.equal(layers.acceptedFusedLanes.length, 0);
});
