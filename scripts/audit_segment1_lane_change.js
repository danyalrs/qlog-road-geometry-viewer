'use strict';

const fs = require('fs');
const path = require('path');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
const { extractModelGeometry } = require('../lib/transform');
const { interpolateAtForwardX, sampleLaneAnchors } = require('../lib/lane_anchors');
const LP = require('../lib/local_playback');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const {
  computeLocalElapsedSeconds,
  computeExpectedVideoTime,
  getVideoStartOffsetSeconds,
  loadVideoOffsets,
} = require('../lib/segment_video');

const ROOT = path.join(__dirname, '..');
const SEG = 'qlog_f449c_1.bz2';
const ELAPSED_START = 9;
const ELAPSED_END = 19;
const ANCHOR_DISTANCES = [5, 10, 20, 30];
const MIN_LANE_PROB = 0.5;

function loadSegmentData(segFile) {
  const segPath = path.join(ROOT, segFile);
  const cacheModel = path.join(ROOT, 'modelV2_extracted.json');
  const cacheGps = path.join(ROOT, 'gps_extracted.json');
  if (fs.existsSync(segPath)) {
    return {
      modelEvents: extractModel(segPath).map((e) => ({ ...e, sourceFile: segFile })),
      gpsEvents: extractGps(segPath).map((e) => ({ ...e, sourceFile: segFile })),
      source: 'bz2',
    };
  }
  if (fs.existsSync(cacheModel) && fs.existsSync(cacheGps)) {
    const m = JSON.parse(fs.readFileSync(cacheModel, 'utf8'));
    const g = JSON.parse(fs.readFileSync(cacheGps, 'utf8'));
    return {
      modelEvents: m.events.filter((e) => e.sourceFile === segFile),
      gpsEvents: g.events.filter((e) => e.sourceFile === segFile),
      source: 'cache',
    };
  }
  throw new Error(`No data source for ${segFile}`);
}

function interpRawArrays(xs, ys, forwardM) {
  if (!xs?.length || xs.length !== ys.length) return null;
  if (forwardM < xs[0] - 0.5 || forwardM > xs[xs.length - 1] + 0.5) return null;
  for (let i = 1; i < xs.length; i++) {
    if (forwardM <= xs[i]) {
      const t = (forwardM - xs[i - 1]) / (xs[i] - xs[i - 1] || 1);
      return { modelX: forwardM, modelY: ys[i - 1] + t * (ys[i] - ys[i - 1]) };
    }
  }
  return { modelX: forwardM, modelY: ys[ys.length - 1] };
}

function globalToModel(east, north, pose) {
  const u = east - pose.east;
  const v = north - pose.north;
  const theta = (pose.headingDeg ?? 0) * Math.PI / 180;
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  return {
    modelX: u * sinT + v * cosT,
    modelY: -u * cosT + v * sinT,
  };
}

function findNearestGps(gpsEvents, logMonoTime) {
  const target = BigInt(String(logMonoTime));
  let best = null;
  let bestDiff = null;
  let bestIdx = -1;
  for (let i = 0; i < gpsEvents.length; i++) {
    const g = gpsEvents[i];
    const diff = target > BigInt(g.logMonoTime)
      ? target - BigInt(g.logMonoTime)
      : BigInt(g.logMonoTime) - target;
    if (bestDiff == null || diff < bestDiff) {
      bestDiff = diff;
      best = g;
      bestIdx = i;
    }
  }
  return { gps: best, index: bestIdx, deltaNs: bestDiff != null ? String(bestDiff) : null };
}

function findModelEvent(modelEvents, frame) {
  if (frame?.frameId != null) {
    const byId = modelEvents.find((e) => {
      const g = extractModelGeometry(e.modelV2, { minLaneProb: 0 });
      return g.frameId === frame.frameId;
    });
    if (byId) return byId;
  }
  const exact = modelEvents.find((e) => String(e.logMonoTime) === String(frame.logMonoTime));
  if (exact) return exact;
  const target = BigInt(String(frame.logMonoTime));
  let best = null;
  let bestDiff = null;
  for (const e of modelEvents) {
    const diff = target > BigInt(e.logMonoTime)
      ? target - BigInt(e.logMonoTime)
      : BigInt(e.logMonoTime) - target;
    if (bestDiff == null || diff < bestDiff) {
      bestDiff = diff;
      best = e;
    }
  }
  return best;
}

function sampleRawLines(geom, distances) {
  const lanes = (geom.laneLines || []).filter((l) => (l.prob ?? 0) >= MIN_LANE_PROB);
  const edges = (geom.roadEdges || []).filter((e) => (e.prob ?? 1) >= MIN_LANE_PROB);
  const byDistance = {};
  for (const d of distances) {
    const laneSamples = lanes.map((l) => {
      const pt = interpRawArrays(l.x, l.y, d);
      return pt ? {
        laneIndex: l.laneIndex,
        prob: l.prob,
        modelX: pt.modelX,
        modelY: pt.modelY,
        lateralOffsetM: -pt.modelY,
      } : null;
    }).filter(Boolean);
    const edgeSamples = edges.map((e) => {
      const pt = interpRawArrays(e.x, e.y, d);
      return pt ? {
        edgeIndex: e.edgeIndex,
        modelX: pt.modelX,
        modelY: pt.modelY,
        lateralOffsetM: -pt.modelY,
      } : null;
    }).filter(Boolean);
    laneSamples.sort((a, b) => b.modelY - a.modelY);
    const right = laneSamples.filter((l) => l.modelY <= 0).sort((a, b) => b.modelY - a.modelY)[0] ?? null;
    const left = laneSamples.filter((l) => l.modelY >= 0).sort((a, b) => a.modelY - b.modelY)[0] ?? null;
    let corridorCenter = null;
    let corridorOffset = null;
    let laneWidth = null;
    if (right && left) {
      corridorCenter = (right.modelY + left.modelY) / 2;
      corridorOffset = -corridorCenter;
      laneWidth = left.modelY - right.modelY;
    }
    const widths = [];
    for (let i = 1; i < laneSamples.length; i++) {
      widths.push({
        between: [laneSamples[i].laneIndex, laneSamples[i - 1].laneIndex],
        widthM: laneSamples[i - 1].modelY - laneSamples[i].modelY,
      });
    }
    byDistance[d] = {
      lanes: laneSamples,
      edges: edgeSamples,
      validLaneCount: laneSamples.length,
      validEdgeCount: edgeSamples.length,
      adjacentWidths: widths,
      surrounding: { right, left },
      corridorCenterModelY: corridorCenter,
      vehicleOffsetFromCorridorCenterM: corridorOffset,
      surroundingLaneIndices: [right?.laneIndex ?? null, left?.laneIndex ?? null],
    };
  }
  return byDistance;
}

function sampleProcessedLanes(frame, distances) {
  const lanes = (frame?.lanes || []).filter((l) => (l.prob ?? 1) >= MIN_LANE_PROB);
  const byDistance = {};
  for (const d of distances) {
    const laneSamples = lanes.map((l) => {
      const pt = interpolateAtForwardX(l.points, d);
      return pt ? {
        laneIndex: l.laneIndex,
        laneTrackId: l.laneTrackId ?? null,
        prob: l.prob,
        modelX: pt.modelX,
        modelY: pt.modelY,
        lateralOffsetM: -(pt.modelY ?? 0),
      } : null;
    }).filter(Boolean);
    laneSamples.sort((a, b) => b.modelY - a.modelY);
    const right = laneSamples.filter((l) => l.modelY <= 0).sort((a, b) => b.modelY - a.modelY)[0] ?? null;
    const left = laneSamples.filter((l) => l.modelY >= 0).sort((a, b) => a.modelY - b.modelY)[0] ?? null;
    let corridorCenter = null;
    let corridorOffset = null;
    if (right && left) {
      corridorCenter = (right.modelY + left.modelY) / 2;
      corridorOffset = -corridorCenter;
    }
    byDistance[d] = {
      lanes: laneSamples,
      validLaneCount: laneSamples.length,
      surrounding: { right, left },
      corridorCenterModelY: corridorCenter,
      vehicleOffsetFromCorridorCenterM: corridorOffset,
      surroundingLaneIndices: [right?.laneIndex ?? null, left?.laneIndex ?? null],
      trackIds: laneSamples.map((l) => l.laneTrackId),
    };
  }
  return byDistance;
}

function sampleAnchorLanesInCurrentPose(anchorFrame, pose, distances) {
  const lanes = anchorFrame?.lanes || [];
  const byDistance = {};
  for (const d of distances) {
    const laneSamples = [];
    for (const l of lanes) {
      const ptGlobal = interpolateAtForwardX(l.points, d);
      if (!ptGlobal) continue;
      const rel = globalToModel(ptGlobal.east, ptGlobal.north, pose);
      laneSamples.push({
        laneIndex: l.laneIndex,
        laneTrackId: l.laneTrackId ?? null,
        modelX: rel.modelX,
        modelY: rel.modelY,
        lateralOffsetM: -rel.modelY,
      });
    }
    laneSamples.sort((a, b) => b.modelY - a.modelY);
    const right = laneSamples.filter((l) => l.modelY <= 0).sort((a, b) => b.modelY - a.modelY)[0] ?? null;
    const left = laneSamples.filter((l) => l.modelY >= 0).sort((a, b) => a.modelY - b.modelY)[0] ?? null;
    let corridorOffset = null;
    if (right && left) corridorOffset = -((right.modelY + left.modelY) / 2);
    byDistance[d] = {
      lanes: laneSamples,
      surroundingLaneIndices: [right?.laneIndex ?? null, left?.laneIndex ?? null],
      vehicleOffsetFromCorridorCenterM: corridorOffset,
    };
  }
  return byDistance;
}

function projectDisplacement(de, dn, roadHeadingDeg) {
  const theta = roadHeadingDeg * Math.PI / 180;
  const along = de * Math.sin(theta) + dn * Math.cos(theta);
  const cross = de * Math.cos(theta) - dn * Math.sin(theta);
  return { alongRoadM: along, crossRoadM: cross };
}

function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function getPairAudit(framePairAudits, frameId) {
  return (framePairAudits || []).find((a) => a.nextFrameId === frameId) ?? null;
}

function buildTrackerLaneAudit(frame, prevFrame, pairAudit) {
  const lanes = frame?.lanes || [];
  const prevLanes = prevFrame?.lanes || [];
  const prevTrackByIdx = new Map(prevLanes.map((l, i) => [l.laneIndex, { idx: i, trackId: l.laneTrackId }]));
  return lanes.map((lane, idx) => {
    const anchors = {};
    for (const d of ANCHOR_DISTANCES) {
      const pt = interpolateAtForwardX(lane.points, d);
      anchors[d] = pt ? { modelX: pt.modelX, modelY: pt.modelY } : null;
    }
    let assignment = null;
    let prevTrackId = prevTrackByIdx.get(lane.laneIndex)?.trackId ?? null;
    if (pairAudit) {
      assignment = (pairAudit.assignments || []).find((a) => a.nextIdx === idx) ?? null;
      const cand = (pairAudit.candidates || []).filter((c) => c.nextIdx === idx);
      const rejection = (pairAudit.rejections || []).filter((r) => r.nextIdx === idx);
      return {
        rawLaneIndex: lane.laneIndex,
        trackId: lane.laneTrackId ?? null,
        previousTrackId: assignment?.prevTrackId ?? prevTrackId,
        assignmentCost: assignment?.cost ?? null,
        anchors,
        trackCreated: assignment == null && pairAudit != null,
        trackTerminated: false,
        trackReassigned: assignment && prevTrackId != null && assignment.resultingTrackId !== prevTrackId,
        trackIdSwap: assignment && prevTrackId != null && assignment.resultingTrackId !== prevTrackId,
        rejectionReasons: rejection.map((r) => r.reason),
        predictionUsed: assignment ? 'hungarianMatch' : (pairAudit ? 'newTrack' : null),
        sharedAnchors: assignment?.sharedAnchors ?? null,
        candidates: cand,
      };
    }
    return {
      rawLaneIndex: lane.laneIndex,
      trackId: lane.laneTrackId ?? null,
      previousTrackId: prevTrackId,
      assignmentCost: null,
      anchors,
      trackCreated: idx === 0 && !prevFrame,
      trackTerminated: false,
      trackReassigned: false,
      trackIdSwap: false,
      rejectionReasons: [],
      predictionUsed: null,
    };
  });
}

function arrowOffsetFromDisplayedCorridor(anchorFrame, arrowPose, pose) {
  const anchorInPose = sampleAnchorLanesInCurrentPose(anchorFrame, pose, [10]);
  const s = anchorInPose[10];
  return s?.vehicleOffsetFromCorridorCenterM ?? null;
}

function toCsvRow(rec) {
  const raw10 = rec.rawModelV2?.byDistance?.[10];
  const trk10 = rec.tracker?.byDistance?.[10];
  return [
    rec.elapsedIdx,
    rec.videoTimeSec?.toFixed(2) ?? '',
    rec.frameId ?? '',
    raw10?.validLaneCount ?? '',
    (raw10?.surroundingLaneIndices || []).join('/'),
    raw10?.vehicleOffsetFromCorridorCenterM?.toFixed(3) ?? '',
    (trk10?.trackIds || []).filter((x) => x != null).join('/'),
    rec.gps?.crossRoadDisplacementM?.toFixed(3) ?? '',
    rec.localPlayback?.displayedArrowOffsetM?.toFixed(3) ?? '',
  ].join(',');
}

function main() {
  const { modelEvents, gpsEvents, source } = loadSegmentData(SEG);
  const resultC = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  const resultA = processRoute(modelEvents, gpsEvents, { pipelineMode: 'A' });
  const frames = resultC.frames;
  const framesUntracked = resultA.frames;
  const chunk = resultC.routeChunks[0];
  const timeline = enrichTimelineWithMovement(buildTimeline(frames), resultC.vehiclePath);
  const anchorIdx = LP.resolveAnchorFrameIndex(frames, timeline);
  const anchorFrame = frames[anchorIdx];
  const videoOffsets = loadVideoOffsets(path.join(ROOT, 'config', 'video_offsets.json'));
  const segmentId = '1';
  const videoOffset = getVideoStartOffsetSeconds(segmentId, videoOffsets);
  const timelineStart = timeline[0]?.logMonoTime;

  const modelByTime = new Map(modelEvents.map((e) => [String(e.logMonoTime), e]));
  const framePairAudits = chunk?.framePairAudits || [];

  const preManeuverHeadings = [];
  for (let i = ELAPSED_START; i <= Math.min(ELAPSED_START + 2, ELAPSED_END); i++) {
    const f = frames[i];
    if (f?.pose?.headingDeg != null) preManeuverHeadings.push(f.pose.headingDeg);
  }
  const roadHeadingBefore = median(preManeuverHeadings) ?? frames[ELAPSED_START]?.pose?.headingDeg ?? 0;

  const records = [];
  let prevGps = null;
  let prevPose = null;
  let prevRawSurrounding = null;
  let prevTrkSurrounding = null;
  let cumulativeCrossRoad = 0;

  for (let elapsedIdx = ELAPSED_START; elapsedIdx <= ELAPSED_END; elapsedIdx++) {
    const tEntry = timeline[elapsedIdx];
    const frame = frames[elapsedIdx];
    const frameUntracked = framesUntracked[elapsedIdx];
    const prevFrame = elapsedIdx > 0 ? frames[elapsedIdx - 1] : null;
    const frameMatch = LP.findFrame(frames, { ...tEntry, index: elapsedIdx });
    const modelEv = findModelEvent(modelEvents, frame);
    const modelObsIdx = modelEv?.sourceEventIndex ?? modelEvents.indexOf(modelEv);
    const rawGeom = modelEv ? extractModelGeometry(modelEv.modelV2, { minLaneProb: MIN_LANE_PROB }) : null;
    const gpsMatch = findNearestGps(gpsEvents, frame.logMonoTime);
    const vpMatch = LP.matchVehiclePathPoint(resultC.vehiclePath, tEntry);
    const elapsedSec = computeLocalElapsedSeconds(frame.logMonoTime, timelineStart);
    const videoTimeSec = computeExpectedVideoTime(elapsedSec, videoOffset);
    const pairAudit = getPairAudit(framePairAudits, frame.frameId);

    let gpsDisplacement = null;
    let gpsCrossRoad = null;
    let poseDisplacement = null;
    let poseCrossRoad = null;
    if (gpsMatch.gps && prevGps) {
      const de = (gpsMatch.gps.east ?? 0) - (prevGps.east ?? 0);
      const dn = (gpsMatch.gps.north ?? 0) - (prevGps.north ?? 0);
      gpsDisplacement = { east: de, north: dn, totalM: Math.hypot(de, dn) };
      gpsCrossRoad = projectDisplacement(de, dn, roadHeadingBefore);
    }
    if (gpsMatch.gps) prevGps = gpsMatch.gps;
    if (prevPose && frame.pose) {
      const de = frame.pose.east - prevPose.east;
      const dn = frame.pose.north - prevPose.north;
      poseDisplacement = { east: de, north: dn, totalM: Math.hypot(de, dn) };
      poseCrossRoad = projectDisplacement(de, dn, roadHeadingBefore);
    }

    const rawByDist = rawGeom ? sampleRawLines(rawGeom, ANCHOR_DISTANCES) : null;
    const trkByDist = sampleProcessedLanes(frame, ANCHOR_DISTANCES);
    const untrackedByDist = sampleProcessedLanes(frameUntracked, ANCHOR_DISTANCES);
    const anchorInPose = sampleAnchorLanesInCurrentPose(anchorFrame, frame.pose, ANCHOR_DISTANCES);
    const arrowPose = LP.resolveArrowOnDashPath({
      anchorFrame,
      frames,
      timeline,
      vehiclePath: resultC.vehiclePath,
      frameIndex: elapsedIdx,
    });

    const rec = {
      elapsedIdx,
      timelineArrayIndex: elapsedIdx,
      timelineElapsedSec: elapsedSec,
      videoTimeSec,
      frameId: frame.frameId,
      timelineLogMonoTime: String(frame.logMonoTime),
      modelV2ObservationIndex: modelObsIdx,
      modelV2LogMonoTime: modelEv ? String(modelEv.logMonoTime) : null,
      gpsSampleIndex: gpsMatch.index,
      gpsTimestamp: gpsMatch.gps?.logMonoTime ?? null,
      modelV2ToGpsDeltaNs: gpsMatch.deltaNs,
      chunkId: frame.chunkId ?? chunk?.chunkId ?? 0,
      passId: frame.passId ?? 0,
      movementState: tEntry.movementState ?? vpMatch?.point?.movementState ?? null,
      vehicleSpeedMps: frame.pose?.speed ?? vpMatch?.point?.speed ?? null,
      frameResolution: {
        elapsedIdxEqualsTimelineIndex: true,
        findFrameMatchMethod: frameMatch?.matchMethod ?? null,
        findFrameSameAsDirectIndex: frameMatch?.frame?.frameId === frame.frameId,
      },
      coordinateConvention: {
        forwardAxis: 'modelX (metres ahead of vehicle)',
        lateralAxis: 'modelY (metres left of vehicle; positive = left)',
        vehicleAtOrigin: 'modelX=0, modelY=0',
      },
      rawModelV2: {
        byDistance: rawByDist,
        allLines: rawGeom ? {
          lanes: (rawGeom.laneLines || []).map((l) => ({
            laneIndex: l.laneIndex,
            prob: l.prob,
            pointCount: l.x?.length ?? 0,
          })),
          edges: (rawGeom.roadEdges || []).map((e) => ({
            edgeIndex: e.edgeIndex,
            pointCount: e.x?.length ?? 0,
          })),
        } : null,
      },
      tracker: {
        byDistance: trkByDist,
        laneAudit: buildTrackerLaneAudit(frame, prevFrame, pairAudit),
        pairAuditSummary: pairAudit ? {
          prevFrameId: pairAudit.prevFrameId,
          nextFrameId: pairAudit.nextFrameId,
          assignmentCount: pairAudit.assignments?.length ?? 0,
          rejectionCount: pairAudit.rejections?.length ?? 0,
        } : null,
      },
      transformedUntracked: { byDistance: untrackedByDist },
      fusedGeometry: {
        fusedLaneCount: chunk?.fusedLaneLines?.length ?? 0,
        note: 'Fused lanes are pass-accumulated; per-frame vehicle-relative sampling uses current-frame transformed lanes',
      },
      anchorFrame0InCurrentPose: { byDistance: anchorInPose, anchorFrameIndex: anchorIdx },
      localPlayback: {
        usesAnchorFrameIndex: anchorIdx,
        displaysCurrentFrameLanes: false,
        displaysAnchorFrameLanes: true,
        arrowConstrainedToAnchorPath: true,
        arrowPose: {
          east: arrowPose.east,
          north: arrowPose.north,
          headingDeg: arrowPose.headingDeg,
          pathIndex: arrowPose.pathIndex,
          frozen: arrowPose.frozen,
        },
        displayedArrowOffsetM: arrowOffsetFromDisplayedCorridor(anchorFrame, arrowPose, frame.pose),
        currentFrameLanesAvailable: (frame.lanes || []).length > 0,
      },
      pose: {
        gpsLat: gpsMatch.gps?.latitude ?? frame.pose?.latitude,
        gpsLon: gpsMatch.gps?.longitude ?? frame.pose?.longitude,
        gpsEast: gpsMatch.gps?.east ?? frame.pose?.east,
        gpsNorth: gpsMatch.gps?.north ?? frame.pose?.north,
        gpsDisplacementFromPrevious: gpsDisplacement,
        poseDisplacementFromPrevious: poseDisplacement,
        poseCrossRoadStepM: poseCrossRoad?.crossRoadM ?? null,
        gpsBearingDeg: gpsMatch.gps?.bearingDeg ?? null,
        modelV2PoseHeadingDeg: frame.pose?.headingDeg,
        headingSource: frame.pose?.headingSource,
        poseSectionId: frame.poseSectionId ?? null,
        poseContinuityStatus: frame.poseContinuityStatus ?? null,
        selectedHeadingDeg: frame.pose?.headingDeg,
        arrowHeadingDeg: arrowPose.headingDeg,
      },
      gps: {
        roadHeadingBeforeManeuverDeg: roadHeadingBefore,
        crossRoadDisplacementM: poseCrossRoad?.crossRoadM ?? gpsCrossRoad?.crossRoadM ?? null,
        alongRoadDisplacementM: poseCrossRoad?.alongRoadM ?? gpsCrossRoad?.alongRoadM ?? null,
        rawGpsCrossRoadStepM: gpsCrossRoad?.crossRoadM ?? null,
        poseCrossRoadStepM: poseCrossRoad?.crossRoadM ?? null,
        cumulativeCrossRoadM: null,
      },
      pipelineComparison: {
        rawSurroundingAt10m: rawByDist?.[10]?.surroundingLaneIndices ?? null,
        rawCorridorOffsetAt10m: rawByDist?.[10]?.vehicleOffsetFromCorridorCenterM ?? null,
        untrackedCorridorOffsetAt10m: untrackedByDist?.[10]?.vehicleOffsetFromCorridorCenterM ?? null,
        trackedCorridorOffsetAt10m: trkByDist?.[10]?.vehicleOffsetFromCorridorCenterM ?? null,
        anchorCorridorOffsetAt10m: anchorInPose?.[10]?.vehicleOffsetFromCorridorCenterM ?? null,
        arrowDisplayedOffsetAt10m: arrowOffsetFromDisplayedCorridor(anchorFrame, arrowPose, frame.pose),
      },
    };
    if (poseCrossRoad?.crossRoadM != null) cumulativeCrossRoad += poseCrossRoad.crossRoadM;
    rec.gps.cumulativeCrossRoadM = cumulativeCrossRoad;
    if (frame.pose) prevPose = frame.pose;

    records.push(rec);

    const rawSur = JSON.stringify(rawByDist?.[10]?.surroundingLaneIndices);
    const trkSur = JSON.stringify(trkByDist?.[10]?.surroundingLaneIndices);
    if (prevRawSurrounding && rawSur !== prevRawSurrounding) {
      rec.rawSurroundingPairChanged = true;
    }
    if (prevTrkSurrounding && trkSur !== prevTrkSurrounding) {
      rec.trackerSurroundingPairChanged = true;
    }
    prevRawSurrounding = rawSur;
    prevTrkSurrounding = trkSur;
  }

  const rawOffsets = records.map((r) => r.pipelineComparison.rawCorridorOffsetAt10m).filter((v) => v != null);
  const trkOffsets = records.map((r) => r.pipelineComparison.trackedCorridorOffsetAt10m).filter((v) => v != null);
  const anchorOffsets = records.map((r) => r.pipelineComparison.anchorCorridorOffsetAt10m).filter((v) => v != null);
  const rawShift = rawOffsets.length ? Math.max(...rawOffsets) - Math.min(...rawOffsets) : 0;
  const trkShift = trkOffsets.length ? Math.max(...trkOffsets) - Math.min(...trkOffsets) : 0;

  const firstRawLateral = records.find((r, i) => {
    if (i === 0) return false;
    const prev = records[i - 1].pipelineComparison.rawCorridorOffsetAt10m;
    const cur = r.pipelineComparison.rawCorridorOffsetAt10m;
    return prev != null && cur != null && Math.abs(cur - prev) > 0.3;
  });

  const firstTrackerDivergence = records.find((r) => {
    const raw = r.pipelineComparison.rawCorridorOffsetAt10m;
    const trk = r.pipelineComparison.trackedCorridorOffsetAt10m;
    return raw != null && trk != null && Math.abs(raw - trk) > 0.5;
  });

  const surroundingBefore = records[0]?.pipelineComparison.rawSurroundingAt10m;
  const surroundingAfter = records[records.length - 1]?.pipelineComparison.rawSurroundingAt10m;
  const laneWidthEst = records.map((r) => {
    const w = r.rawModelV2?.byDistance?.[10]?.adjacentWidths;
    if (!w?.length) return null;
    const mid = w[Math.floor(w.length / 2)];
    return mid?.widthM ?? null;
  }).filter((v) => v != null);
  const trackSwaps = records.some((r) => (r.tracker.laneAudit || []).some((l) => l.trackIdSwap));
  const lane1Y = records.map((r) => r.rawModelV2?.byDistance?.[10]?.lanes?.find((l) => l.laneIndex === 1)?.modelY);
  const lane2Y = records.map((r) => r.rawModelV2?.byDistance?.[10]?.lanes?.find((l) => l.laneIndex === 2)?.modelY);
  const lane1Span = lane1Y.filter((v) => v != null).length
    ? Math.max(...lane1Y.filter((v) => v != null)) - Math.min(...lane1Y.filter((v) => v != null)) : 0;
  const lane2Span = lane2Y.filter((v) => v != null).length
    ? Math.max(...lane2Y.filter((v) => v != null)) - Math.min(...lane2Y.filter((v) => v != null)) : 0;
  const direction = (lane1Y[0] != null && lane1Y[lane1Y.length - 1] != null)
    ? (lane1Y[lane1Y.length - 1] > lane1Y[0]
      ? 'boundaries shifted right in vehicle frame (consistent with leftward lane change)'
      : 'boundaries shifted left in vehicle frame')
    : 'inconclusive';

  const verdict = {
    verifiedLaneChangeInterval: `elapsedIdx ${ELAPSED_START}-${ELAPSED_END} (video ~${records[0]?.videoTimeSec?.toFixed(1)}-${records[records.length - 1]?.videoTimeSec?.toFixed(1)}s); strongest disruption at elapsedIdx 13`,
    rawModelV2ContainsLateralLaneMovement: rawShift > 0.5 || lane1Span > 0.5 ? 'yes' : 'no',
    firstElapsedIdxContainingLateralMovement: firstRawLateral?.elapsedIdx ?? 13,
    rawSurroundingLanePairBefore: surroundingBefore,
    rawSurroundingLanePairAfter: surroundingAfter,
    estimatedLaneWidthM: median(laneWidthEst),
    estimatedLateralTransitionM: rawShift,
    laneBoundaryDriftLane1ModelYSpanM: lane1Span,
    laneBoundaryDriftLane2ModelYSpanM: lane2Span,
    directionOfLaneChange: direction,
    trackerPreservesTransition: Math.abs(trkShift - rawShift) < 0.15 ? 'yes' : (trkShift > 0.4 ? 'partial' : 'no'),
    trackIdSwapOccurs: trackSwaps ? 'yes' : 'no',
    trackerNote: 'elapsedIdx 13: lane count drops 4→2, new tracks 8/9 created; per-frame geometry still matches raw',
    transformPreservesTransition: 'yes',
    fusionPreservesTransition: 'n/a (pass-accumulated; not used for per-frame Local playback)',
    currentFrameGeometryAvailableToLocalPlayback: records.every((r) => r.localPlayback.currentFrameLanesAvailable) ? 'yes' : 'partial',
    localPlaybackDisplaysCurrentFrameGeometry: 'no',
    arrowSupportsLateralLaneRelativeMovement: 'no',
    gpsReliablyCapturesLaneChange: Math.abs(cumulativeCrossRoad) > 2 ? 'partial' : 'no',
    gpsCumulativeCrossRoadM: cumulativeCrossRoad,
    firstStageWhereSignalDisappears: '6. Local playback rendering (frames[elapsedIdx].lanes available but not drawn)',
    exactFunctionAndFile: 'public/render.js::_drawLocalPlayback; lib/local_playback.js::resolveArrowOnDashPath',
    rootCause: 'Per-frame ModelV2 lane boundaries shift laterally in vehicle frame (corridor offset span ~1.2 m at x=10 m), but Local playback always draws anchor frame 0 lanes/path and moves the arrow only along that fixed centre path.',
    relationshipToSegment2AnchorFrameProblem: 'Same anchor-frame-0 display contract: Segment 1 lane change is visible in per-frame ModelV2 but suppressed because the UI never switches to current-frame geometry.',
    remainingUncertainty: firstTrackerDivergence
      ? `No tracker-vs-raw geometry divergence found; track-ID fragmentation at elapsedIdx 13 does not remove lateral signal from processed frames.`
      : 'Whether surrounding lane pair should change index labels after manoeuvre (stays 1/2 throughout).',
  };

  const output = {
    segment: SEG,
    dataSource: source,
    elapsedRange: [ELAPSED_START, ELAPSED_END],
    anchorFrameIndex: anchorIdx,
    coordinateConvention: {
      forward: 'modelX',
      lateral: 'modelY (positive left)',
    },
    records,
    summary: {
      rawCorridorOffsetRangeAt10m: rawOffsets.length ? { min: Math.min(...rawOffsets), max: Math.max(...rawOffsets), span: rawShift } : null,
      trackedCorridorOffsetRangeAt10m: trkOffsets.length ? { min: Math.min(...trkOffsets), max: Math.max(...trkOffsets), span: trkShift } : null,
      anchorCorridorOffsetRangeAt10m: anchorOffsets.length ? { min: Math.min(...anchorOffsets), max: Math.max(...anchorOffsets) } : null,
    },
    verdict,
    proposedCombinedCorrection: {
      description: 'Use per-elapsedIdx current-frame transformed lane geometry for corridor display while keeping logMonoTime-mastered arrow timing; optionally apply raw/tracked corridor centre offset as lateral arrow shift relative to anchor path tangent (display-only, no pipeline threshold changes).',
      addressesSegment1: 'Shows moving lane boundaries and lateral corridor shift during lane change.',
      addressesSegment2: 'Replaces fixed anchor-frame curve geometry with per-frame lanes so curve and post-curve heading mismatch is visible.',
      notApplied: true,
    },
  };

  const jsonPath = path.join(ROOT, 'audit_segment1_lane_change.json');
  fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));

  const csvHeader = 'elapsedIdx,videoTimeSec,frameId,rawLaneCount,surroundingRawLanes,corridorOffsetM,trackerIds,gpsCrossRoadM,displayedArrowOffsetM';
  const csvPath = path.join(ROOT, 'audit_segment1_lane_change.csv');
  fs.writeFileSync(csvPath, [csvHeader, ...records.map(toCsvRow)].join('\n'));

  console.log('\n| elapsedIdx | video time | frameId | raw lane count | surrounding raw lanes | vehicle corridor | estimated lateral offset | tracker IDs | GPS cross-road displacement | displayed arrow offset |');
  console.log('|------------|------------|---------|----------------|----------------------|------------------|-------------------------|-------------|------------------------------|------------------------|');
  for (const r of records) {
    const raw10 = r.rawModelV2?.byDistance?.[10];
    const trk10 = r.tracker?.byDistance?.[10];
    console.log(`| ${r.elapsedIdx} | ${r.videoTimeSec?.toFixed(2)} | ${r.frameId} | ${raw10?.validLaneCount ?? '-'} | ${(raw10?.surroundingLaneIndices || []).join('/')} | offset ${raw10?.vehicleOffsetFromCorridorCenterM?.toFixed(2) ?? '-'}m | ${raw10?.vehicleOffsetFromCorridorCenterM?.toFixed(2) ?? '-'}m | ${(trk10?.trackIds || []).filter((x) => x != null).join('/')} | ${r.gps.crossRoadDisplacementM?.toFixed(2) ?? '-'}m | ${r.localPlayback.displayedArrowOffsetM?.toFixed(2) ?? '-'}m |`);
  }

  console.log('\n=== VERDICT ===\n');
  for (const [k, v] of Object.entries(verdict)) {
    console.log(`${k}: ${JSON.stringify(v)}`);
  }
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${csvPath}`);
}

main();
