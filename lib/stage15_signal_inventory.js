/**
 * Stage 15 Part 1 — qlog signal inventory (read-only).
 * Scans decoded messages via parseQlogBuffer; does not modify production geometry.
 */
const fs = require('fs');
const path = require('path');
const { parseQlogBuffer } = require('./qlog_parse_once');
const { UNION } = require('./qlog_decoder');

const SIGNAL_UNION_TAGS = {
  0: 'initData',
  1: 'frameData',
  18: 'liveCalibration',
  19: 'liveCalibrationData',
  20: 'gpsLocationDEPRECATED',
  47: 'gpsLocationExternal',
  62: 'cameraOdometry',
  70: 'liveLocationKalman',
  73: 'modelV2',
};

const MODEL_V2_FIELDS = [
  'laneLines', 'laneLineProbs', 'laneLineStds', 'roadEdges', 'roadEdgeStds',
  'position', 'orientation', 'velocity', 'orientationRate', 'acceleration',
  'temporalPose', 'meta', 'confidence', 'leads', 'leadsV3',
  'frameId', 'timestampEof', 'navEnabled', 'locationMonoTime',
];

const META_FIELDS = [
  'engagedProb', 'desirePrediction', 'desireState', 'laneChangeState',
  'laneChangeDirection', 'hardBrakePredicted', 'disengagePredictions',
];

/** Exact v11 production usage — every "used by v11" claim must map here. */
const V11_SIGNAL_USAGE = {
  laneLines: {
    usedByV11: true,
    codePaths: ['lib/transform.js → extractModelGeometry', 'lib/transform.js → transformXyztLine'],
  },
  laneLineProbs: {
    usedByV11: true,
    codePaths: ['lib/transform.js → extractModelGeometry (minLaneProb filter)', 'lib/transform.js → transformXyztLine'],
  },
  laneLineStds: {
    usedByV11: false,
    codePaths: [],
    note: 'Decoded in qlog JSON; not consumed by v11 fusion',
  },
  roadEdges: {
    usedByV11: true,
    codePaths: ['lib/transform.js → extractModelGeometry', 'lib/transform.js → transformFrameGeometry'],
  },
  roadEdgeStds: {
    usedByV11: true,
    codePaths: ['lib/transform.js → extractModelGeometry (stored as edge std, not prob filter)'],
    note: 'Spatial uncertainty metres — attached to edge geometry, not a classification gate',
  },
  temporalPose: {
    usedByV11: false,
    codePaths: [],
    proposedFor: 'future lane-divider temporal alignment',
  },
  desireState: {
    usedByV11: false,
    codePaths: [],
    proposedFor: 'lane-change unknown-state tagging',
  },
  laneChangeState: {
    usedByV11: false,
    codePaths: [],
    proposedFor: 'lane-change unknown-state tagging',
  },
  laneChangeDirection: {
    usedByV11: false,
    codePaths: [],
    proposedFor: 'lane-change unknown-state tagging',
  },
  gps: {
    usedByV11: true,
    codePaths: ['lib/process_route.js → interpolateGpsAtTime', 'lib/pose_continuity.js'],
  },
  liveLocationKalman: {
    usedByV11: false,
    codePaths: [],
    note: 'Decoded; pose pipeline uses GPS interpolation only',
  },
  liveCalibration: {
    usedByV11: false,
    codePaths: [],
    note: 'Stage 12B blocked — not applied to geometry',
  },
  cameraOdometry: {
    usedByV11: false,
    codePaths: [],
    note: 'Present in qlog; not used for projection or fusion',
  },
};

function arrLen(v) {
  return Array.isArray(v) ? v.length : 0;
}

function hasMetaField(meta, field) {
  if (!meta) return false;
  const v = meta[field];
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'boolean') return v;
  return true;
}

function scanQlogSignals(filePath) {
  const buf = fs.readFileSync(filePath);
  const sourceFile = path.basename(filePath);
  const { modelEvents, gpsEvents, parsed, poseSourceReport } = parseQlogBuffer(buf, sourceFile);

  const modelFieldPresence = Object.fromEntries(MODEL_V2_FIELDS.map((f) => [f, 0]));
  const metaFieldPresence = Object.fromEntries(META_FIELDS.map((f) => [f, 0]));
  const laneLineCounts = [];
  const roadEdgeCounts = [];
  const laneProbLengths = [];
  const laneStdLengths = [];
  const roadEdgeStdLengths = [];
  let temporalPoseCount = 0;
  let confidenceCount = 0;

  for (const ev of modelEvents) {
    const m = ev.modelV2 || {};
    const nLines = arrLen(m.laneLines);
    const nEdges = arrLen(m.roadEdges);
    laneLineCounts.push(nLines);
    roadEdgeCounts.push(nEdges);
    laneProbLengths.push(arrLen(m.laneLineProbs));
    laneStdLengths.push(arrLen(m.laneLineStds));
    roadEdgeStdLengths.push(arrLen(m.roadEdgeStds));

    if (nLines > 0) modelFieldPresence.laneLines++;
    if (arrLen(m.laneLineProbs) > 0) modelFieldPresence.laneLineProbs++;
    if (arrLen(m.laneLineStds) > 0) modelFieldPresence.laneLineStds++;
    if (nEdges > 0) modelFieldPresence.roadEdges++;
    if (arrLen(m.roadEdgeStds) > 0) modelFieldPresence.roadEdgeStds++;
    if (m.position?.x?.length) modelFieldPresence.position++;
    if (m.orientation?.x?.length) modelFieldPresence.orientation++;
    if (m.velocity?.x?.length) modelFieldPresence.velocity++;
    if (m.orientationRate?.x?.length) modelFieldPresence.orientationRate++;
    if (m.acceleration?.x?.length) modelFieldPresence.acceleration++;
    if (m.temporalPose) {
      modelFieldPresence.temporalPose++;
      temporalPoseCount++;
    }
    if (m.meta) modelFieldPresence.meta++;
    if (m.confidence != null) {
      modelFieldPresence.confidence++;
      confidenceCount++;
    }
    if (arrLen(m.leads) > 0) modelFieldPresence.leads++;
    if (arrLen(m.leadsV3) > 0) modelFieldPresence.leadsV3++;
    if (m.frameId != null) modelFieldPresence.frameId++;
    if (m.timestampEof != null) modelFieldPresence.timestampEof++;
    if (m.navEnabled != null) modelFieldPresence.navEnabled++;
    if (m.locationMonoTime != null) modelFieldPresence.locationMonoTime++;

    const meta = m.meta || {};
    for (const f of META_FIELDS) {
      if (hasMetaField(meta, f)) metaFieldPresence[f]++;
    }
  }

  const tagCounts = Object.fromEntries([...parsed.tagCounts.entries()]);
  const kalmanEvents = parsed.tagCounts.get(70) || 0;
  const calibrationEvents = (parsed.tagCounts.get(18) || 0) + (parsed.tagCounts.get(19) || 0);
  const cameraOdometryEvents = parsed.tagCounts.get(62) || 0;
  const gpsCount = gpsEvents.length;

  return {
    sourceFile,
    tagCounts,
    modelV2Count: modelEvents.length,
    gpsEvents: gpsCount,
    kalmanEvents,
    calibrationEvents,
    cameraOdometryEvents,
    modelFieldPresence,
    metaFieldPresence,
    laneLineCounts,
    roadEdgeCounts,
    laneProbLengths,
    laneStdLengths,
    roadEdgeStdLengths,
    temporalPoseCount,
    confidenceCount,
    poseSourceReport,
  };
}

function summarizeCoverageOutliers(segmentSummaries) {
  const outliers = [];
  for (const s of segmentSummaries || []) {
    const flags = [];
    if (s.frameCoverageRate < 1) flags.push('incomplete_lane_line_frames');
    if (s.probFilteredCoverageRate < 0.5) flags.push('low_prob_filtered_coverage');
    if (s.missingLineFrames > 0) flags.push('missing_raw_lines');
    if (s.modelV2FrameCount < 5) flags.push('sparse_modelV2');
    if (flags.length) {
      outliers.push({
        segmentId: s.segmentId,
        filename: s.filename,
        modelV2FrameCount: s.modelV2FrameCount,
        chunkCount: s.chunkCount,
        frameCoverageRate: s.frameCoverageRate,
        probFilteredCoverageRate: s.probFilteredCoverageRate,
        flags,
      });
    }
  }
  return outliers.sort((a, b) => a.probFilteredCoverageRate - b.probFilteredCoverageRate);
}

function buildSignalInventoryReport(root, filenames) {
  const perFile = [];
  const aggregateTags = new Map();
  const aggregateModelFields = Object.fromEntries(MODEL_V2_FIELDS.map((f) => [f, 0]));
  const aggregateMetaFields = Object.fromEntries(META_FIELDS.map((f) => [f, 0]));
  let totalModelV2 = 0;
  let filesWithCalibration = 0;
  let filesWithCameraOdometry = 0;
  let filesWithKalman = 0;
  const allLaneLineCounts = [];
  const allRoadEdgeCounts = [];
  const allLaneProbLengths = [];
  const allLaneStdLengths = [];
  const allRoadEdgeStdLengths = [];
  let totalTemporalPose = 0;
  let totalConfidence = 0;

  for (const f of filenames) {
    const scan = scanQlogSignals(path.join(root, f));
    perFile.push(scan);
    totalModelV2 += scan.modelV2Count;
    if (scan.calibrationEvents > 0) filesWithCalibration++;
    if (scan.cameraOdometryEvents > 0) filesWithCameraOdometry++;
    if (scan.kalmanEvents > 0) filesWithKalman++;
    allLaneLineCounts.push(...scan.laneLineCounts);
    allRoadEdgeCounts.push(...scan.roadEdgeCounts);
    allLaneProbLengths.push(...scan.laneProbLengths);
    allLaneStdLengths.push(...scan.laneStdLengths);
    allRoadEdgeStdLengths.push(...scan.roadEdgeStdLengths);
    totalTemporalPose += scan.temporalPoseCount;
    totalConfidence += scan.confidenceCount;
    for (const [tag, count] of Object.entries(scan.tagCounts)) {
      aggregateTags.set(Number(tag), (aggregateTags.get(Number(tag)) || 0) + count);
    }
    for (const [k, v] of Object.entries(scan.modelFieldPresence)) {
      if (v > 0) aggregateModelFields[k]++;
    }
    for (const [k, v] of Object.entries(scan.metaFieldPresence)) {
      if (v > 0) aggregateMetaFields[k]++;
    }
  }

  const segmentCount = filenames.length;
  const meanLines = allLaneLineCounts.length
    ? allLaneLineCounts.reduce((a, b) => a + b, 0) / allLaneLineCounts.length
    : null;
  const meanEdges = allRoadEdgeCounts.length
    ? allRoadEdgeCounts.reduce((a, b) => a + b, 0) / allRoadEdgeCounts.length
    : null;

  return {
    coordinateSystem: {
      frame: 'device',
      units: 'SI (metres, radians where applicable)',
      axes: { x: 'forward', y: 'left', z: 'up' },
      globalProjection: 'GPS-interpolated east/north via existing pose pipeline (not LiveLocationKalman)',
      schemaReference: 'cereal/log.capnp ModelDataV2, XYZTData',
    },
    v11SignalUsage: V11_SIGNAL_USAGE,
    signals: {
      modelV2: {
        exists: true,
        unionTag: UNION.MODEL_V2,
        fields: MODEL_V2_FIELDS,
        presentInSegments: aggregateModelFields,
        observationFrequency: {
          totalMessages: totalModelV2,
          meanPerSegment: segmentCount ? totalModelV2 / segmentCount : 0,
          approximateHz: '~0.5 Hz (one modelV2 per ~2 s segment window)',
        },
        laneLines: {
          shape: 'List(XYZTData) — per-line x,y,z,t arrays plus optional xStd,yStd,zStd per point',
          companionFields: ['laneLineProbs (Float32 per line)', 'laneLineStds (Float32 per line, metres)'],
          meanLinesPerFrame: meanLines,
          slotsPerValidFrame: meanLines === 4 ? 4 : meanLines,
          uncertaintyFields: ['laneLineStds (per line)', 'laneLines[].xStd/yStd/zStd (per point, unused by v11)'],
          note: 'Not every modelV2 lane line is a physical lane divider — classification required',
        },
        laneLineProbs: {
          shape: 'Float32 per line index',
          units: 'classification confidence [0,1]',
          meanLengthPerFrame: allLaneProbLengths.length
            ? allLaneProbLengths.reduce((a, b) => a + b, 0) / allLaneProbLengths.length
            : null,
        },
        laneLineStds: {
          shape: 'Float32 per line index',
          units: 'spatial uncertainty (metres)',
          meanLengthPerFrame: allLaneStdLengths.length
            ? allLaneStdLengths.reduce((a, b) => a + b, 0) / allLaneStdLengths.length
            : null,
          usedByV11: false,
        },
        roadEdges: {
          shape: 'List(XYZTData) with roadEdgeStds (Float32 per edge, spatial uncertainty metres)',
          meanEdgesPerFrame: meanEdges,
        },
        roadEdgeStds: {
          shape: 'Float32 per road-edge index',
          units: 'spatial uncertainty (metres)',
          meanLengthPerFrame: allRoadEdgeStdLengths.length
            ? allRoadEdgeStdLengths.reduce((a, b) => a + b, 0) / allRoadEdgeStdLengths.length
            : null,
          usedByV11: true,
          v11Note: 'Attached to edge geometry in extractModelGeometry; not a probability gate',
        },
        meta: {
          fields: META_FIELDS,
          presentInSegments: aggregateMetaFields,
          laneChangeFields: ['laneChangeState', 'laneChangeDirection'],
          desireFields: ['desirePrediction', 'desireState'],
        },
        temporalPose: {
          exists: totalTemporalPose > 0,
          messagesWithField: totalTemporalPose,
          shape: 'Pose { trans, rot, transStd, rotStd } in device frame',
          usedByV11: false,
        },
        confidence: {
          exists: totalConfidence > 0,
          messagesWithField: totalConfidence,
          enum: ['red', 'yellow', 'green'],
          usedByV11: false,
        },
        proposedForLaneDividerPipeline: [
          'laneLines', 'laneLineProbs', 'laneLineStds', 'roadEdges (context only)',
          'meta.desireState', 'meta.laneChangeState', 'meta.laneChangeDirection',
        ],
        missingOrUnused: [
          'laneLineStds decoded but not consumed by v11 fusion pipeline',
          'per-point xStd/yStd on lane lines decoded but not used in fusion',
          'no dedicated lane-divider type or colour classification in modelV2',
          'road edges are geometric context, not lane-divider ground truth',
        ],
      },
      gps: {
        exists: true,
        unionTags: [UNION.GPS_LOCATION, UNION.GPS_LOCATION_EXTERNAL],
        usedByPosePipeline: true,
        v11CodePaths: V11_SIGNAL_USAGE.gps.codePaths,
      },
      liveLocationKalman: {
        exists: filesWithKalman > 0,
        unionTag: 70,
        presentInSegments: filesWithKalman,
        usedByPosePipeline: false,
        note: 'Decoded for audit; process_route uses GPS interpolation only',
      },
      liveCalibration: {
        exists: filesWithCalibration > 0,
        unionTags: [18, 19],
        presentInSegments: filesWithCalibration,
        fields: ['calStatus', 'calPerc', 'extrinsicMatrix', 'rpyCalib', 'validBlocks'],
        usedByGeometryPipeline: false,
        stage12bStatus: 'BLOCKED — calibration not applied without verified decode',
      },
      cameraOdometry: {
        exists: filesWithCameraOdometry > 0,
        unionTag: 62,
        presentInSegments: filesWithCameraOdometry,
        usedByPosePipeline: false,
      },
      encodeIndex: {
        note: 'Present for HEVC frame references; Stage 12B blocked on external files',
        suitableForLaneCounting: false,
      },
    },
    unionTagSummary: Object.fromEntries(
      [...aggregateTags.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([tag, count]) => [tag, { name: SIGNAL_UNION_TAGS[tag] || `tag${tag}`, count }]),
    ),
    segmentCoverage: {
      physicalSegments: segmentCount,
      segmentsWithModelV2: perFile.filter((p) => p.modelV2Count > 0).length,
      segmentsWithLaneLineStds: perFile.filter((p) => p.modelFieldPresence.laneLineStds > 0).length,
      segmentsWithDesireMeta: perFile.filter((p) => p.metaFieldPresence.desireState > 0).length,
      segmentsWithLaneChangeMeta: perFile.filter((p) => p.metaFieldPresence.laneChangeState > 0).length,
      segmentsWithTemporalPose: perFile.filter((p) => p.modelFieldPresence.temporalPose > 0).length,
    },
    posePipelineCompatibility: {
      compatible: ['laneLines', 'roadEdges', 'laneLineProbs', 'position (model path)'],
      requiresSeparateHandling: ['laneLineStds', 'laneChangeState', 'desireState', 'temporalPose'],
      notUsed: ['liveLocationKalman for projection', 'cameraOdometry', 'liveCalibration for geometry'],
      frozenBaseline: '2026-07-24-fusion-v11',
    },
    perFile,
  };
}

module.exports = {
  SIGNAL_UNION_TAGS,
  MODEL_V2_FIELDS,
  META_FIELDS,
  V11_SIGNAL_USAGE,
  scanQlogSignals,
  buildSignalInventoryReport,
  summarizeCoverageOutliers,
};
