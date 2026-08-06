/**
 * Geometry provenance tracing for diagnostic output.
 */
function buildGeometryProvenance(result, fileAudits, cacheResultId) {
  const auditByFile = new Map((fileAudits || []).map((a) => [a.filename, a]));
  const items = [];

  for (const chunk of result.routeChunks || []) {
    const fileHash = chunk.files?.map((f) => auditByFile.get(f)?.sha256).filter(Boolean).join('|') || null;

    for (const poly of chunk.roadSurfacePolygons || []) {
      items.push({
        kind: 'roadSurfacePolygon',
        chunkId: chunk.chunkId,
        passId: poly.passId,
        fragmentIndex: poly.fragmentIndex,
        sourceFileHash: fileHash,
        sourceMessageType: 'fusedLane+roadEdge',
        sourceModelFrameIds: poly.supportingFrameIds || poly.stats?.frameIds || [],
        sourceTimestamps: poly.supportingTimestamps || [],
        rawOrGenerated: 'generated',
        trackId: null,
        supportingIndependentFrames: poly.stats?.supportingFrameCount ?? poly.stats?.frameCount ?? 0,
        geometryClassification: poly.stats?.classification || 'fused',
        cacheResultId,
      });
    }

    for (const lane of chunk.fusedLaneLines || []) {
      items.push({
        kind: 'fusedLane',
        chunkId: chunk.chunkId,
        passId: lane.passId,
        laneIndex: lane.laneIndex,
        sourceFileHash: fileHash,
        sourceMessageType: 'modelV2',
        sourceModelFrameIds: lane.frameIds || [],
        rawOrGenerated: lane.frameIds?.length > 1 ? 'fused' : 'raw',
        trackId: lane.laneTrackId ?? null,
        supportingIndependentFrames: lane.frameIds?.length ?? 0,
        geometryClassification: lane.classification || 'accepted',
        cacheResultId,
      });
    }

    for (const frame of chunk.frames || []) {
      for (const lane of frame.lanes || []) {
        items.push({
          kind: 'rawLaneObservation',
          chunkId: chunk.chunkId,
          passId: frame.passId,
          sourceFileHash: auditByFile.get(frame.sourceFile)?.sha256,
          sourceMessageType: 'modelV2',
          sourceModelFrameId: frame.frameId,
          sourceTimestamp: frame.logMonoTime,
          rawOrGenerated: 'raw',
          trackId: lane.laneTrackId ?? null,
          supportingIndependentFrames: 1,
          geometryClassification: 'observation',
          cacheResultId,
        });
      }
    }
  }

  return items;
}

function buildPassProvenance(chunk, fileAudits) {
  const auditByFile = new Map((fileAudits || []).map((a) => [a.filename, a]));
  const passes = chunk.passCoverage || [];
  return passes.map((p) => ({
    chunkId: chunk.chunkId,
    passId: p.passId,
    sourcePoseStream: 'gpsLocation',
    startTimestamp: p.startLogMonoTime ?? null,
    endTimestamp: p.endLogMonoTime ?? null,
    sourceFrameIds: p.frameIds || [],
    independentPoseObservations: p.gpsPointCount ?? p.frameCount ?? 0,
    travelledDistanceM: p.pathLengthM ?? null,
    splitReason: p.splitReason ?? null,
    sourceFileHash: chunk.files?.map((f) => auditByFile.get(f)?.sha256).join('|'),
    frameCount: p.frameCount,
  }));
}

module.exports = {
  buildGeometryProvenance,
  buildPassProvenance,
};
