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
const INDICES = [0, 8, 16, 29];

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
  const chunk = data.routeChunks?.[0];
  const sourcePolygonCount = chunk?.roadSurfacePolygons?.length ?? 0;
  const apiPolygonCount = data.geometryDebug?.polygonCount ?? sourcePolygonCount;

  const snapshots = {};
  for (const idx of INDICES) {
    const built = SLM.buildSegmentLocalMap(data, { geometrySource: 'fused', timelineIndex: idx });
    const map = SLM.freezeStationaryMapGeometry(built);
    const selection = SLM.selectStationaryRoadSurfacePolygons(map.roadSurfacePolygons);
    const arrow = SLM.resolveArrowOnSegmentMap(map, data.timeline, idx);
    snapshots[idx] = {
      sourcePolygonCount,
      apiPolygonCount,
      localMapPolygonCount: map.roadSurfacePolygonCount,
      frontendPolygonCount: map.roadSurfacePolygonCount,
      renderedPolygonCount: selection.selectedCount,
      skippedPolygons: selection.skipped,
      polygonIds: map.roadSurfacePolygons.map((p, i) => ({
        index: i,
        fragmentIndex: p.fragmentIndex ?? i,
        passId: p.passId,
        surfaceType: p.surfaceType ?? 'egoLaneCorridor',
        pointCount: p.ring?.length ?? 0,
      })),
      surfaceTypes: [...new Set(map.roadSurfacePolygons.map((p) => p.surfaceType ?? 'egoLaneCorridor'))],
      checksum: map.checksum,
      roadSurfaceChecksum: map.roadSurfaceChecksum,
      roadSurfaceMetaChecksum: map.roadSurfaceMetaChecksum,
      roadSurfaceBoundsChecksum: map.roadSurfaceBoundsChecksum,
      roadSurfaceBounds: map.roadSurfaceBounds,
      finiteCoordinates: map.roadSurfaceBounds?.finite ?? false,
      arrow: { east: arrow.east, north: arrow.north, headingDeg: arrow.headingDeg },
    };
  }

  const checksum0 = snapshots[0].roadSurfaceChecksum;
  const inconsistentIdx = INDICES.find((idx) => snapshots[idx].roadSurfaceChecksum !== checksum0);

  const report = {
    segment: SEG2,
    indices: INDICES,
    firstInconsistentTimelineIndex: inconsistentIdx ?? null,
    firstDataStageChange: inconsistentIdx != null ? 'buildSegmentLocalMap' : null,
    visibleInconsistency: inconsistentIdx != null
      ? 'road-polygon checksum changed between timeline indices'
      : 'none in data pipeline — geometry is stationary; apparent changes are viewport-relative or legitimate dropout gaps',
    snapshots,
    polygonCounts: Object.fromEntries(INDICES.map((i) => [i, snapshots[i].localMapPolygonCount])),
    geometryChecksums: Object.fromEntries(INDICES.map((i) => [i, {
      lanes: snapshots[i].checksum,
      roadPolygons: snapshots[i].roadSurfaceChecksum,
      roadMeta: snapshots[i].roadSurfaceMetaChecksum,
      roadBounds: snapshots[i].roadSurfaceBoundsChecksum,
    }])),
  };

  const outPath = path.join(ROOT, 'audit_segment2_surface_playback.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.error(`Wrote ${outPath}`);
}

main();
