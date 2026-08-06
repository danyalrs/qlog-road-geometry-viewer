/** Compare pipeline modes A/B/C for segments 2, 5, 6. */
const fs = require('fs');
const path = require('path');
const { processRoute } = require('./lib/process_route');

const model = JSON.parse(fs.readFileSync('modelV2_extracted.json', 'utf8'));
const gps = JSON.parse(fs.readFileSync('gps_extracted.json', 'utf8'));
const SEGMENTS = ['qlog_f449c_2.bz2', 'qlog_f449c_5.bz2', 'qlog_f449c_6.bz2'];
const MODES = ['A', 'B', 'C'];

function metrics(file, mode) {
  const t0 = Date.now();
  const r = processRoute(
    model.events.filter((e) => e.sourceFile === file),
    gps.events.filter((e) => e.sourceFile === file),
    { pipelineMode: mode }
  );
  const ms = Date.now() - t0;
  const c = r.routeChunks[0];
  const tracking = c?.laneTrackingSummary?.passes || [];
  const continued = tracking.reduce((n, p) => n + (p.continuedTracks ?? 0), 0);
  const created = tracking.reduce((n, p) => n + (p.trackCount ?? p.createdTracks ?? 0), 0);
  const oneFrame = tracking.reduce((n, p) => n + (p.oneFrameTracks ?? 0), 0);
  const fusedLen = (c?.fusedLaneLines || []).reduce((n, l) => n + (l.points?.length ?? 0), 0);
  const accepted = c?.geometryLayers?.acceptedFusedLanes?.length ?? c?.fusedLaneLines?.length ?? 0;
  const laneOnly = c?.laneOnlyCandidates?.length ?? c?.geometryLayers?.laneOnlyCandidates?.length ?? 0;

  return {
    mode,
    ms,
    polygons: c?.roadSurfacePolygons?.length ?? 0,
    createdTracks: created,
    continuedMatches: continued,
    oneFrameTracks: oneFrame,
    medianTrackLen: tracking[0]?.medianTrackDurationFrames ?? 0,
    maxTrackLen: Math.max(0, ...tracking.map((p) => p.maxTrackDurationFrames ?? 0)),
    fusedLaneFragments: c?.fusedLaneLines?.length ?? 0,
    acceptedFusedLanes: accepted,
    laneOnlyCandidates: laneOnly,
    fusedPointCount: fusedLen,
    passes: c?.passCoverage?.length ?? 0,
  };
}

console.log('\n=== Pipeline mode comparison ===\n');
for (const file of SEGMENTS) {
  console.log(`\n${file}`);
  const results = MODES.map((m) => metrics(file, m));
  for (const r of results) {
    console.log(`  Mode ${r.mode}: ${r.ms}ms | tracks ${r.createdTracks} created, ${r.continuedMatches} continued, ${r.oneFrameTracks} 1-frame | fused ${r.fusedLaneFragments} (${r.acceptedFusedLanes} accepted, ${r.laneOnlyCandidates} lane-only) | poly ${r.polygons}`);
  }
  const best = results.reduce((a, b) => {
    const score = (r) => r.continuedMatches - r.oneFrameTracks * 2 + r.acceptedFusedLanes;
    return score(b) > score(a) ? b : a;
  });
  console.log(`  Recommended: Mode ${best.mode}`);
}
