/**
 * Stage 12B — imagery acquisition audit (read-only).
 * Scans qlogs for EncodeIndex/calibration references and searches for external camera files.
 * Does NOT decode video or guess calibration.
 */
const fs = require('fs');
const path = require('path');
const capnp = require('capnp-ts');
const Log = require('@commaai/log_reader/capnp/log.capnp');
const { iterateEvents } = require('./qlog_decoder');

const ENCODE_INDEX_TAGS = new Set([14, 74, 75, 76, 77]);
const CAMERA_STATE_TAGS = new Set([1, 68, 72, 74]);
const ENCODE_TYPE_NAMES = {
  0: 'BIG_BOX_LOSSLESS',
  1: 'FULL_HEVC',
  2: 'BIG_BOX_HEVC',
  3: 'CHFFR_ANDROID_H264',
  4: 'FULL_LOSSLESS_CLIP',
  5: 'FRONT',
};

const EXPECTED_CAMERA_FILES = [
  'fcamera.hevc',
  'ecamera.hevc',
  'dcamera.hevc',
  'qcamera.ts',
];

const SEARCH_ROOTS_DEFAULT = [
  process.cwd(),
  path.join(process.cwd(), '..'),
  path.join(process.cwd(), '../..'),
];

function safeDecode(fn) {
  try { return fn(); } catch (e) { return { error: e.message }; }
}

function listToArray(list) {
  if (!list) return null;
  const out = [];
  const len = typeof list.length === 'number' ? list.length : (typeof list.size === 'function' ? list.size() : 0);
  for (let i = 0; i < len; i++) out.push(list.get(i));
  return out;
}

function scanQlogImagery(filePath) {
  const buf = fs.readFileSync(filePath);
  const sourceFile = path.basename(filePath);
  const tagCounts = new Map();
  let initData = null;
  let liveCalibration = null;
  const encodeIndices = [];
  const cameraStates = [];
  const modelV2Frames = [];
  let decodeErrors = 0;

  for (const item of iterateEvents(buf, sourceFile)) {
    tagCounts.set(item.unionTag, (tagCounts.get(item.unionTag) || 0) + 1);
    const { event, unionTag, logMonoTime } = item;

    if (unionTag === 0) {
      initData = safeDecode(() => {
        const init = capnp.Struct.getStruct(0, Log.InitData, event);
        return {
          version: init.getVersion(),
          dongleId: init.getDongleId(),
          deviceType: init.getDeviceType(),
          gitCommit: init.getGitCommit(),
          gitBranch: init.getGitBranch(),
        };
      });
    }

    if (unionTag === 18) {
      liveCalibration = safeDecode(() => {
        const cal = capnp.Struct.getStruct(0, Log.LiveCalibrationData, event);
        return {
          calStatus: cal.getCalStatus(),
          calPerc: cal.getCalPerc(),
          validBlocks: cal.getValidBlocks(),
          hasExtrinsicMatrix: cal.hasExtrinsicMatrix(),
          extrinsicMatrixLength: cal.hasExtrinsicMatrix() ? cal.getExtrinsicMatrix().size() : 0,
          hasRpyCalib: cal.hasRpyCalib(),
          rpyCalib: cal.hasRpyCalib() ? listToArray(cal.getRpyCalib()) : null,
          hasWarpMatrix: cal.hasWarpMatrixDEPRECATED(),
        };
      });
    }

    if (ENCODE_INDEX_TAGS.has(unionTag)) {
      const decoded = safeDecode(() => {
        const idx = capnp.Struct.getStruct(0, Log.EncodeIndex, event);
        return {
          unionTag,
          logMonoTime: logMonoTime.toString(),
          frameId: idx.getFrameId(),
          type: idx.getType(),
          typeName: ENCODE_TYPE_NAMES[idx.getType()] || `unknown_${idx.getType()}`,
          encodeId: idx.getEncodeId(),
          segmentNum: idx.getSegmentNum(),
          segmentId: idx.getSegmentId(),
          segmentIdEncode: idx.getSegmentIdEncode(),
          timestampSof: idx.getTimestampSof().toString(),
          timestampEof: idx.getTimestampEof().toString(),
        };
      });
      if (!decoded.error) encodeIndices.push(decoded);
      else decodeErrors++;
    }

    if (CAMERA_STATE_TAGS.has(unionTag)) {
      const decoded = safeDecode(() => {
        const fd = capnp.Struct.getStruct(0, Log.FrameData, event);
        return {
          unionTag,
          logMonoTime: logMonoTime.toString(),
          frameId: fd.getFrameId(),
          encodeId: fd.getEncodeId(),
          frameLength: fd.getFrameLength(),
          frameType: fd.getFrameType(),
          hasImageBytes: fd.hasImage(),
          imageByteLength: fd.hasImage() ? fd.getImage().length : 0,
          timestampSof: fd.getTimestampSof().toString(),
          timestampEof: fd.getTimestampEof().toString(),
          hasTransform: fd.hasTransform(),
          transformLength: fd.hasTransform() ? fd.getTransform().size() : 0,
        };
      });
      if (!decoded.error) cameraStates.push(decoded);
      else decodeErrors++;
    }

    if (unionTag === 73) {
      const decoded = safeDecode(() => {
        const m = capnp.Struct.getStruct(0, Log.ModelDataV2, event);
        return {
          frameId: m.getFrameId(),
          logMonoTime: logMonoTime.toString(),
        };
      });
      if (!decoded.error) modelV2Frames.push(decoded);
    }
  }

  const encodeSample = encodeIndices.slice(0, 3);
  const encodeTypes = [...new Set(encodeIndices.map((e) => e.typeName))];
  const uniqueSegmentNums = [...new Set(encodeIndices.map((e) => e.segmentNum))].sort((a, b) => a - b);
  const uniqueEncodeIds = [...new Set(encodeIndices.map((e) => e.encodeId))].sort((a, b) => a - b);

  let encodeRateHz = null;
  if (encodeIndices.length >= 2) {
    const t0 = BigInt(encodeIndices[0].logMonoTime);
    const t1 = BigInt(encodeIndices[encodeIndices.length - 1].logMonoTime);
    const dur = Number(t1 - t0) / 1e9;
    if (dur > 0) encodeRateHz = ((encodeIndices.length - 1) / dur).toFixed(2);
  }

  const cameraStateWithPixels = cameraStates.filter((c) => c.hasImageBytes && c.imageByteLength > 0);

  return {
    sourceFile,
    tagCounts: Object.fromEntries([...tagCounts.entries()].sort((a, b) => a[0] - b[0])),
    initData,
    liveCalibration,
    encodeIndexCount: encodeIndices.length,
    encodeIndexDecodeErrors: decodeErrors,
    encodeTypes,
    encodeRateHz,
    uniqueSegmentNums,
    uniqueEncodeIds,
    encodeSample,
    cameraStateCount: cameraStates.length,
    cameraStateWithEmbeddedPixels: cameraStateWithPixels.length,
    cameraStateSample: cameraStates.slice(0, 2),
    modelV2FrameCount: modelV2Frames.length,
    modelV2FrameIdRange: modelV2Frames.length
      ? [modelV2Frames[0].frameId, modelV2Frames[modelV2Frames.length - 1].frameId]
      : null,
    timestampMapping: {
      modelV2LogMonoTimeRange: modelV2Frames.length
        ? [modelV2Frames[0].logMonoTime, modelV2Frames[modelV2Frames.length - 1].logMonoTime]
        : null,
      encodeLogMonoTimeRange: encodeIndices.length
        ? [encodeIndices[0].logMonoTime, encodeIndices[encodeIndices.length - 1].logMonoTime]
        : null,
      modelV2ToEncodeFrameIdOverlap: modelV2Frames.length && encodeIndices.length
        ? modelV2Frames.some((m) => encodeIndices.some((e) => e.frameId === m.frameId))
        : false,
    },
  };
}

function searchCameraFiles(searchRoots, routeHints = []) {
  const routeRelevant = [];
  const unrelatedVideos = [];
  const missing = [];
  const checked = new Set();

  const dirs = new Set(searchRoots);
  for (const hint of routeHints) {
    if (hint) {
      dirs.add(hint);
      dirs.add(path.dirname(hint));
      dirs.add(path.join(path.dirname(hint), '..'));
    }
  }

  for (const root of dirs) {
    if (!root || checked.has(root)) continue;
    checked.add(root);
    if (!fs.existsSync(root)) continue;

    for (const name of EXPECTED_CAMERA_FILES) {
      const full = path.join(root, name);
      if (fs.existsSync(full)) {
        const stat = fs.statSync(full);
        routeRelevant.push({
          path: full,
          name,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          routeRelevant: true,
        });
      }
    }

    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        const lower = ent.name.toLowerCase();
        if (lower.endsWith('.hevc') || lower.endsWith('.h264')) {
          const full = path.join(root, ent.name);
          if (!routeRelevant.find((f) => f.path === full)) {
            const stat = fs.statSync(full);
            routeRelevant.push({
              path: full,
              name: ent.name,
              sizeBytes: stat.size,
              modifiedAt: stat.mtime.toISOString(),
              routeRelevant: true,
            });
          }
        }
      }
    } catch (_) { /* unreadable dir */ }
  }

  for (const name of EXPECTED_CAMERA_FILES) {
    if (!routeRelevant.find((f) => f.name === name)) missing.push(name);
  }

  return {
    routeRelevantFound: routeRelevant,
    unrelatedVideosFound: unrelatedVideos,
    found: routeRelevant,
    missing,
    searchedRoots: [...checked],
  };
}

function buildProjectionRequirements(scan) {
  return {
    requiredForModelV2ToImage: [
      'Decoded HEVC bitstream segments referenced by EncodeIndex (segmentNum, segmentId, encodeId)',
      'HEVC SPS/PPS initialization data (typically in first segment or separate init blob)',
      'Camera intrinsics (focal length, principal point, distortion) — from CarParams or device fingerprint',
      'Camera-to-vehicle extrinsics — from LiveCalibrationData.extrinsicMatrix or warp matrices',
      'Frame dimensions and crop — from FrameData or encoder metadata',
      'Timestamp alignment: EncodeIndex.timestampSof/Eof ↔ modelV2.frameId ↔ logMonoTime',
      'ModelV2 lane/edge (x,y) vehicle-frame to image projection transform',
    ],
    availableInQlog: {
      encodeIndexPointers: scan.encodeIndexCount > 0,
      encodeTypes: scan.encodeTypes,
      liveCalibration: !!(scan.liveCalibration && !scan.liveCalibration.error),
      liveCalibrationExtrinsic: !!(scan.liveCalibration?.hasExtrinsicMatrix),
      liveCalibrationRpy: !!(scan.liveCalibration?.hasRpyCalib),
      embeddedCameraPixels: scan.cameraStateWithEmbeddedPixels > 0,
      initDataVersion: scan.initData?.version ?? null,
    },
    notAvailable: [],
  };
}

function finalizeBlockers(req, fileSearch) {
  const blockers = [];
  if (!fileSearch.routeRelevantFound?.length) {
    blockers.push('No route-matching HEVC camera files (fcamera.hevc, ecamera.hevc, dcamera.hevc) found adjacent to qlog segments');
  }
  if (!req.availableInQlog.encodeIndexPointers) {
    blockers.push('No decodable EncodeIndex events in qlog');
  }
  if (!req.availableInQlog.liveCalibrationExtrinsic && !req.availableInQlog.liveCalibrationRpy) {
    blockers.push('LiveCalibrationData extrinsic/RPY not decoded from qlog');
  }
  if (!req.availableInQlog.embeddedCameraPixels) {
    blockers.push('No embedded FrameData.image bytes in qlog (expected for this dataset — pointers only)');
  }
  blockers.push('Camera intrinsics (focal length, distortion) not extracted — CarParams decode not implemented');
  blockers.push('ModelV2-to-image projection pipeline not implemented');
  return blockers;
}

function auditImageryAcquisition(qlogPath, options = {}) {
  const searchRoots = options.searchRoots || SEARCH_ROOTS_DEFAULT;
  const scan = scanQlogImagery(qlogPath);
  const fileSearch = searchCameraFiles(searchRoots, [qlogPath, path.dirname(qlogPath)]);
  const projectionRequirements = buildProjectionRequirements(scan);
  const blockers = finalizeBlockers(projectionRequirements, fileSearch);

  const expectedLayout = {
    openpilotConvention: '<route_dir>/fcamera.hevc (road), ecamera.hevc (wide road), dcamera.hevc (driver)',
    qlogNaming: 'qlog | qlog_<segment>.bz2 — segment index maps to 60 s chunk',
    encodeIndexFields: 'frameId, encodeId, segmentNum, segmentId, segmentIdEncode, type, timestampSof, timestampEof',
    segmentToQlogMapping: 'qlog_f449c_{N}.bz2 ↔ segment index N; EncodeIndex.segmentNum may reference HEVC segment within stream',
  };

  return {
    qlogFile: path.basename(qlogPath),
    status: blockers.length ? 'blocked' : 'ready_for_decode',
    expectedStorageLayout: expectedLayout,
    qlogScan: scan,
    externalFileSearch: fileSearch,
    projectionRequirements,
    missingInputs: blockers,
    stage12bVerdict: blockers.length
      ? 'BLOCKED — encoded frame references present in qlog but matching camera files and/or calibration decode unavailable'
      : 'UNBLOCKED — files found; decode pipeline still required',
  };
}

module.exports = {
  EXPECTED_CAMERA_FILES,
  ENCODE_TYPE_NAMES,
  scanQlogImagery,
  searchCameraFiles,
  auditImageryAcquisition,
};
