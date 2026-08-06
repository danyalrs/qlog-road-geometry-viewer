'use strict';

const fs = require('fs');
const path = require('path');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
const SLM = require('../lib/segment_local_map');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const SEG2 = 'qlog_f449c_2.bz2';
const INDICES = [0, 4, 8, 12, 16, 29];

function loadSegment(fileName) {
  const segPath = path.join(ROOT, fileName);
  const modelEvents = extractModel(segPath).map((e) => ({ ...e, sourceFile: fileName }));
  const gpsEvents = extractGps(segPath).map((e) => ({ ...e, sourceFile: fileName }));
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  const timeline = enrichTimelineWithMovement(buildTimeline(result.frames), result.vehiclePath);
  return { ...result, timeline };
}

function main() {
  const data = loadSegment(SEG2);
  const groups = SLM.listChunkPassGroups(data);
  const map = SLM.buildSegmentLocalMap(data, {
    geometrySource: 'observations',
    timelineIndex: 0,
    minHeadingSpeedMps: 2,
  });

  const report = {
    segment: SEG2,
    chunkPassGroups: groups,
    referencePose: map.referencePose,
    mapChecksum: map.checksum,
    laneFragmentCount: map.laneFragmentCount,
    edgeFragmentCount: map.edgeFragmentCount,
    trajectoryPointCount: map.trajectoryPointCount,
    observationFrameCount: map.observationFrameCount,
    stationaryBounds: map.bounds,
    perIndex: [],
  };

  for (const idx of INDICES) {
    const arrow = SLM.resolveArrowOnSegmentMap(map, data.timeline, idx, { minHeadingSpeedMps: 2 });
    const active = SLM.resolveActiveChunkPass(data, idx);
    report.perIndex.push({
      elapsedIdx: idx,
      mapChecksum: map.checksum,
      stationaryBounds: map.bounds,
      arrowLocal: { east: arrow.east, north: arrow.north },
      arrowHeading: arrow.headingDeg,
      activeChunk: active.chunkId,
      activePass: active.passId,
    });
  }

  const outPath = path.join(ROOT, 'verify_segment2_stationary.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main();
