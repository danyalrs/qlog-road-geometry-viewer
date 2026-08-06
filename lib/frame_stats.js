/**
 * Frame count breakdown — separate raw, parsed, valid, interpolated, synthetic, cached.
 */
const { extractModelGeometry } = require('./transform');

function buildFrameStats(modelEvents, transformedFrames, options = {}) {
  const opts = { minLaneProb: 0.5, maxForwardM: 120, ...options };
  const byFile = new Map();

  for (const ev of modelEvents) {
    const f = ev.sourceFile;
    if (!byFile.has(f)) {
      byFile.set(f, {
        rawModelV2: 0,
        parsedModelFrames: 0,
        validLaneFrames: 0,
        validRoadEdgeFrames: 0,
        rejectedGpsAlignment: 0,
      });
    }
    const s = byFile.get(f);
    s.rawModelV2++;

    const geom = extractModelGeometry(ev.modelV2, opts);
    if (geom.laneLines.length || geom.roadEdges.length || geom.path) {
      s.parsedModelFrames++;
    }
    if (geom.laneLines.length) s.validLaneFrames++;
    if (geom.roadEdges.length) s.validRoadEdgeFrames++;
  }

  const gpsAlignedByFile = new Map();
  const interpolatedByFile = new Map();
  const vehicleRelativeByFile = new Map();

  for (const frame of transformedFrames) {
    const f = frame.sourceFile;
    gpsAlignedByFile.set(f, (gpsAlignedByFile.get(f) || 0) + 1);
    if (frame.pose?.headingSource === 'interpolated' || frame.pose?.interpolated) {
      interpolatedByFile.set(f, (interpolatedByFile.get(f) || 0) + 1);
    }
    if (frame.vehicleRelative) {
      vehicleRelativeByFile.set(f, (vehicleRelativeByFile.get(f) || 0) + 1);
    }
  }

  const perFile = {};
  const allFiles = new Set([...byFile.keys(), ...gpsAlignedByFile.keys()]);
  for (const f of allFiles) {
    const base = byFile.get(f) || {
      rawModelV2: 0, parsedModelFrames: 0, validLaneFrames: 0, validRoadEdgeFrames: 0,
    };
    perFile[f] = {
      rawModelV2Messages: base.rawModelV2,
      parsedModelFrames: base.parsedModelFrames,
      validLaneFrames: base.validLaneFrames,
      validRoadEdgeFrames: base.validRoadEdgeFrames,
      gpsAlignedFrames: gpsAlignedByFile.get(f) || 0,
      interpolatedPoseFrames: interpolatedByFile.get(f) || 0,
      vehicleRelativeFrames: vehicleRelativeByFile.get(f) || 0,
      syntheticFrames: 0,
      cachedFrames: 0,
      /** UI must use this, not conflate with raw modelV2 */
      displayedTimelineFrames: gpsAlignedByFile.get(f) || vehicleRelativeByFile.get(f) || 0,
    };
  }

  const totals = {
    rawModelV2Messages: modelEvents.length,
    parsedModelFrames: [...byFile.values()].reduce((n, s) => n + s.parsedModelFrames, 0),
    validLaneFrames: [...byFile.values()].reduce((n, s) => n + s.validLaneFrames, 0),
    validRoadEdgeFrames: [...byFile.values()].reduce((n, s) => n + s.validRoadEdgeFrames, 0),
    gpsAlignedFrames: transformedFrames.filter((f) => !f.vehicleRelative).length,
    interpolatedPoseFrames: transformedFrames.filter((f) => f.pose?.headingSource === 'interpolated').length,
    vehicleRelativeFrames: transformedFrames.filter((f) => f.vehicleRelative).length,
    syntheticFrames: 0,
    cachedFrames: 0,
    displayedTimelineFrames: transformedFrames.length,
  };

  return { perFile, totals };
}

module.exports = { buildFrameStats };
