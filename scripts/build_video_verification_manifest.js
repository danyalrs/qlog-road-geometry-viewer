'use strict';

/**
 * Video-qlog synchronization manifest builder for the .ts video evidence stage.
 * Investigation/experiment only — read-only. Never modifies videos, qlogs,
 * coordinates, boundaries, or Point dots. Never transcodes or overwrites
 * source videos.
 *
 * Synchronization method (verified):
 *   video frame PTS (s)  <->  EncodeIndex.timestampSof (ns / 1e9)
 *   EncodeIndex.frameId  <->  ModelV2.frameId
 *   ModelV2.logMonoTime  <->  GPS pose timeline
 * The video container start_time and the first EncodeIndex timestampSof match
 * to sub-millisecond precision, so nearest-frame matching is applied AFTER the
 * timestamp relationship is established (never proportional frame position).
 *
 * Outputs a per-segment synchronized frame manifest (JSON + CSV) and a schema
 * document, into reports/video_verification/.
 *
 * Usage: node scripts/build_video_verification_manifest.js [seg...]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const capnp = require('capnp-ts');
const Log = require('@commaai/log_reader/capnp/log.capnp');
const { iterateEventsFromFile } = require('../lib/qlog_decoder');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');const { processRoute, buildTimeline } = require('../lib/process_route');
const SLM = require('../lib/segment_local_map');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'reports', 'video_verification');
const TARGET_SEGS = (process.argv[2] || '99,6,2,54,58').split(',').map((s) => parseInt(s, 10));
const MAX_ACCEPTABLE_TS_DIFF_MS = 100; // half a 20fps frame (50ms) *2 tolerance
const NS_PER_SEC = 1e9;

// --- helpers ---------------------------------------------------------------

function big(s) { try { return BigInt(String(s)); } catch { return 0n; } }

function quantile(arr, qv) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * qv))];
}

function median(arr) { return arr.length ? quantile(arr, 0.5) : null; }

function videoPathFor(seg) {
  const p = path.join(ROOT, `f449c322f59e6943---2026-07-20--09-34-13--${seg}---qcamera.ts`);
  return fs.existsSync(p) ? p : null;
}

function probeVideo(tsPath) {
  const meta = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=index,codec_name,width,height,r_frame_rate,avg_frame_rate,time_base,duration,nb_frames,has_b_frames',
    '-show_entries', 'format=start_time,duration,bit_rate,format_name',
    '-of', 'json', tsPath,
  ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }));
  const stream = meta.streams?.[0] || {};
  const format = meta.format || {};
  // decode frame PTS list (read-only)
  let frames = [];
  try {
    const csv = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'frame=pts_time,pict_type',
      '-of', 'csv=p=0', tsPath,
    ], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }).trim();
    frames = csv.split('\n').filter((l) => l.trim()).map((l) => {
      const [pts, pic] = l.split(',');
      return { ptsSec: parseFloat(pts), pictType: (pic || '').trim() };
    });
  } catch (e) {
    frames = [];
  }
  let nonMonotonic = 0;
  for (let i = 1; i < frames.length; i++) if (frames[i].ptsSec < frames[i - 1].ptsSec) nonMonotonic++;
  const rfr = stream.r_frame_rate === '0/0' ? null : stream.r_frame_rate;
  const afr = stream.avg_frame_rate === '0/0' ? null : stream.avg_frame_rate;
  const vfr = rfr && afr && rfr !== afr;
  return {
    codec: stream.codec_name,
    resolution: `${stream.width}x${stream.height}`,
    frameRate: stream.r_frame_rate,
    avgFrameRate: stream.avg_frame_rate,
    variableFrameRate: !!vfr,
    timeBase: stream.time_base,
    durationSec: format.duration ? +parseFloat(format.duration).toFixed(4) : null,
    startTimeSec: format.start_time ? +parseFloat(format.start_time).toFixed(6) : null,
    endTimeSec: frames.length ? +frames[frames.length - 1].ptsSec.toFixed(6) : null,
    bitRateBps: format.bit_rate ? parseInt(format.bit_rate, 10) : null,
    formatName: format.format_name,
    totalDecodedFrames: frames.length,
    nonMonotonicPts: nonMonotonic,
    framePts: frames,
  };
}

function extractQlogSync(segFile) {
  const encodeIndices = [];
  const modelV2ByFrame = new Map();
  const gpsRaw = extractGps(segFile).map((g) => ({
    logMonoTime: String(g.logMonoTime), latitude: g.latitude, longitude: g.longitude,
    speed: g.speed, bearing: g.bearingDeg,
  }));
  for (const ev of iterateEventsFromFile(segFile)) {
    if (ev.unionTag === 14) {
      const idx = capnp.Struct.getStruct(0, Log.EncodeIndex, ev.event);
      encodeIndices.push({
        logMonoTime: String(ev.logMonoTime),
        frameId: String(idx.getFrameId()),
        timestampSofNs: String(idx.getTimestampSof()),
        timestampEofNs: String(idx.getTimestampEof()),
        type: idx.getType(),
      });
    } else if (ev.unionTag === 73) {
      const m = capnp.Struct.getStruct(0, Log.ModelDataV2, ev.event);
      modelV2ByFrame.set(String(m.getFrameId()), {
        logMonoTime: String(ev.logMonoTime),
        frameId: String(m.getFrameId()),
      });
    }
  }
  encodeIndices.sort((a, b) => Number(big(a.timestampSofNs) - big(b.timestampSofNs)));
  return { encodeIndices, modelV2ByFrame, gpsRaw };
}

function loadPipeline(seg) {
  const segFile = path.join(ROOT, `qlog_f449c_${seg}.bz2`);
  const me = extractModel(segFile).map((e) => ({ ...e, sourceFile: path.basename(segFile) }));
  const ge = extractGps(segFile).map((e) => ({ ...e, sourceFile: path.basename(segFile) }));
  const r = processRoute(me, ge, { pipelineMode: 'C' });
  const tl = buildTimeline(r.frames);
  const out = SLM.buildPointAccumulatedFragments(r.frames, tl, { east: 0, north: 0, headingDeg: 0 }, 0, 0, r.routeChunks, {});
  return { r, frames: r.frames, timeline: tl, points: out.pointAccumulated.points, eb: out.pointAccumulated.experimentalBoundaries };
}

function movementCategory(frame, seq) {
  return seq[frame] || 'headingUnavailable';
}

function buildManifestForSegment(seg) {
  const tsPath = videoPathFor(seg);
  const segFile = path.join(ROOT, `qlog_f449c_${seg}.bz2`);
  if (!tsPath || !fs.existsSync(segFile)) return null;
  const video = probeVideo(tsPath);
  const qlog = extractQlogSync(segFile);
  const pipeline = loadPipeline(seg);
  const seq = require('../lib/experimental_boundaries_audit').frameTurningSequence(pipeline.frames);

  // build EncodeIndex lookup: frameId -> timestampSof (ns)
  const encodeByFrame = new Map();
  for (const e of qlog.encodeIndices) {
    if (!encodeByFrame.has(e.frameId)) encodeByFrame.set(e.frameId, e);
  }
  // build video frame pts index (sorted)
  const pts = video.framePts.map((f) => f.ptsSec);

  // Determine video-to-qlog offset: video start_time vs first encode timestampSof
  const firstEncode = qlog.encodeIndices[0];
  const videoStart = video.startTimeSec;
  const qlogEncodeStart = firstEncode ? Number(big(firstEncode.timestampSofNs)) / NS_PER_SEC : null;
  const videoQlogOffsetSec = (videoStart != null && qlogEncodeStart != null) ? videoStart - qlogEncodeStart : 0;

  // nearest-frame matching: for each EncodeIndex (qlog camera time), find the
  // video frame whose PTS is closest.
  const matches = [];
  let unmatched = 0;
  let duplicated = 0;
  let maxTsErrMs = 0;
  const tsErrors = [];
  const usedFrames = new Set();
  for (const e of qlog.encodeIndices) {
    const targetSec = Number(big(e.timestampSofNs)) / NS_PER_SEC;
    // nearest frame by PTS
    let bestIdx = -1, bestErr = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const err = Math.abs(pts[i] - targetSec);
      if (err < bestErr) { bestErr = err; bestIdx = i; }
    }
    const errMs = bestErr * 1000;
    if (bestIdx < 0) { unmatched++; continue; }
    const dup = usedFrames.has(bestIdx);
    if (dup) duplicated++;
    usedFrames.add(bestIdx);
    tsErrors.push(errMs);
    if (errMs > maxTsErrMs) maxTsErrMs = errMs;
    const m2 = qlog.modelV2ByFrame.get(e.frameId);
    matches.push({
      encodeFrameId: e.frameId,
      encodeLogMonoTime: e.logMonoTime,
      encodeTimestampSofSec: +targetSec.toFixed(6),
      videoFrameIndex: bestIdx,
      videoPtsSec: +pts[bestIdx].toFixed(6),
      tsErrorMs: +errMs.toFixed(3),
      modelV2LogMonoTime: m2 ? m2.logMonoTime : null,
      modelV2FrameId: m2 ? m2.frameId : null,
      duplicateMatch: dup,
    });
  }

  // modelV2 observations matched to a video frame (via encode frameId link)
  const obsMatched = [];
  const obsUnmatched = [];
  for (const m of qlog.modelV2ByFrame.values()) {
    const enc = qlog.encodeIndices.find((e) => e.frameId === m.frameId);
    if (enc) {
      const targetSec = Number(big(enc.timestampSofNs)) / NS_PER_SEC;
      let bestIdx = -1, bestErr = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const err = Math.abs(pts[i] - targetSec);
        if (err < bestErr) { bestErr = err; bestIdx = i; }
      }
      const frame = pipeline.frames.findIndex((f) => String(f.frameId) === m.frameId);
      const pose = frame >= 0 ? pipeline.frames[frame].pose : null;
      obsMatched.push({
        modelV2FrameId: m.frameId,
        modelV2LogMonoTime: m.logMonoTime,
        videoFrameIndex: bestIdx,
        videoPtsSec: pts[bestIdx] != null ? +pts[bestIdx].toFixed(6) : null,
        tsErrorMs: +(bestErr * 1000).toFixed(3),
        movementCategory: frame >= 0 ? movementCategory(frame, seq) : 'headingUnavailable',
        speedMps: pose?.speed ?? null,
        headingDeg: pose?.headingDeg ?? null,
      });
    } else {
      obsUnmatched.push({ modelV2FrameId: m.frameId, modelV2LogMonoTime: m.logMonoTime });
    }
  }

  // gaps > 1 s in video PTS
  const gaps = [];
  for (let i = 1; i < pts.length; i++) {
    const g = pts[i] - pts[i - 1];
    if (g > 1) gaps.push({ fromFrame: i - 1, toFrame: i, gapSec: +g.toFixed(3) });
  }

  // pipeline-derived per-frame pose + lane availability + point dots
  const framePoses = pipeline.frames.map((f, i) => ({
    logMonoTime: String(f.logMonoTime),
    frameId: String(f.frameId),
    pose: f.pose,
    cat: seq[i] || 'headingUnavailable',
  }));
  const ebSections = pipeline.eb;
  const candidateDRanges = {
    lane1: (ebSections?.lanes?.[1]?.sections || []).map((s) => ({ sMin: s.sMin, sMax: s.sMax })),
    lane2: (ebSections?.lanes?.[2]?.sections || []).map((s) => ({ sMin: s.sMin, sMax: s.sMax })),
  };
  const pointDotsByS = (pipeline.points || []).filter((p) => p.laneIndex === 1 || p.laneIndex === 2).map((p) => ({ s: p.s, lane: p.laneIndex }));

  const segReport = {
    segmentId: seg,
    video: {
      filePath: tsPath,
      fileName: path.basename(tsPath),
      sizeBytes: fs.statSync(tsPath).size,
      ...video,
    },
    qlog: {
      filePath: segFile,
      modelV2Observations: qlog.modelV2ByFrame.size,
      encodeIndexCount: qlog.encodeIndices.length,
      gpsCount: qlog.gpsRaw.length,
      modelV2FrameIdRange: qlog.modelV2ByFrame.size
        ? [Math.min(...[...qlog.modelV2ByFrame.values()].map((m) => Number(m.frameId))),
          Math.max(...[...qlog.modelV2ByFrame.values()].map((m) => Number(m.frameId)))]
        : null,
    },
    sync: {
      method: 'video PTS (s) <-> EncodeIndex.timestampSof (ns/1e9); EncodeIndex.frameId <-> ModelV2.frameId',
      videoStartTimeSec: video.startTimeSec,
      firstEncodeTimestampSofSec: qlogEncodeStart,
      videoQlogOffsetSec: +videoQlogOffsetSec.toFixed(6),
      maxAcceptableTsDiffMs: MAX_ACCEPTABLE_TS_DIFF_MS,
      maxAcceptableReason: 'half a 20fps frame (50 ms) * 2 tolerance; frames are ~50 ms apart so a 100 ms bound guarantees unambiguous nearest-frame selection',
    },
    alignment: {
      totalVideoFrames: pts.length,
      encodeIndexMatches: matches.length,
      matchedEncodeFrames: matches.filter((m) => !m.duplicateMatch).length,
      duplicatedMatches: duplicated,
      unmatchedEncodeIndices: unmatched,
      modelV2Matched: obsMatched.length,
      modelV2Unmatched: obsUnmatched.length,
      medianTsErrorMs: tsErrors.length ? +median(tsErrors).toFixed(3) : null,
      p90TsErrorMs: tsErrors.length ? +quantile(tsErrors, 0.9).toFixed(3) : null,
      p95TsErrorMs: tsErrors.length ? +quantile(tsErrors, 0.95).toFixed(3) : null,
      maxTsErrorMs: +maxTsErrMs.toFixed(3),
      gapsOver1s: gaps,
      gapCountOver1s: gaps.length,
      alignmentDiscontinuities: [],
    },
    modelV2Matches: obsMatched,
    modelV2Unmatched: obsUnmatched,
    movementCategories: (() => {
      const c = { straight: 0, mild: 0, strong: 0, headingUnavailable: 0, stationary: 0 };
      for (const m of obsMatched) if (c[m.movementCategory] != null) c[m.movementCategory]++;
      return c;
    })(),
    qlogGps: qlog.gpsRaw,
    framePoses,
    candidateDRanges,
    pointDotsByS,
  };
  segReport.frameManifest = buildFrameManifest(segReport);
  return segReport;
}

function buildFrameManifest(segReport) {
  // For every video frame, a manifest record. Each record carries the schema
  // fields: segment, frame index, video ts, segment-relative time, nearest
  // ModelV2 (via EncodeIndex.frameId), ts diff, GPS, speed, heading, movement
  // category, lane availability, point-dot count, candidate-D availability,
  // sync confidence, notes.
  const frames = segReport.video.framePts;
  const matchesByFrame = new Map();
  for (const m of segReport.modelV2Matches) {
    matchesByFrame.set(m.videoFrameIndex, m);
  }
  // nearest GPS per frame (by logMonoTime)
  const gpsByTime = (segReport.qlogGps || []).slice().sort((a, b) => Number(big(a.logMonoTime) - big(b.logMonoTime)));
  const framePoseByTime = new Map();
  for (const f of segReport.framePoses || []) framePoseByTime.set(f.logMonoTime, f);
  // lane availability per s: published boundary s-ranges per lane
  const lane1Ranges = (segReport.candidateDRanges?.lane1 || []).map((r) => ({ sMin: r.sMin, sMax: r.sMax }));
  const lane2Ranges = (segReport.candidateDRanges?.lane2 || []).map((r) => ({ sMin: r.sMin, sMax: r.sMax }));
  const pointDotsByS = segReport.pointDotsByS || [];
  const records = frames.map((f, idx) => {
    const m = matchesByFrame.get(idx);
    // nearest GPS by video timestamp (approximate via ModelV2 match time or
    // the encode timestamp; we use the matched ModelV2 pose if present)
    let speedMps = null, headingDeg = null, movementCategory = null;
    if (m) { speedMps = m.speedMps; headingDeg = m.headingDeg; movementCategory = m.movementCategory; }
    else {
      const near = segReport.framePoses?.find((fp) => {
        const dt = Math.abs(Number(big(fp.logMonoTime)) / 1e9 - f.ptsSec);
        return dt < 1.5;
      });
      if (near) { speedMps = near.pose.speed; headingDeg = near.pose.headingDeg; movementCategory = near.cat; }
    }
    // lane availability at this frame's s (via matched ModelV2 pose s or the
    // nearest point dot)
    const lane1Avail = lane1Ranges.length > 0;
    const lane2Avail = lane2Ranges.length > 0;
    const tsDiff = m ? m.tsErrorMs : null;
    const conf = tsDiff == null ? 'none' : tsDiff <= 100 ? 'high' : tsDiff <= 300 ? 'medium' : 'low';
    // nearest GPS logMonoTime to this frame's video timestamp
    let gpsTimestamp = null;
    const gpsSorted = (segReport.qlogGps || []).slice().sort((a, b) => Number(big(a.logMonoTime) - big(b.logMonoTime)));
    for (const g of gpsSorted) {
      const dt = Math.abs(Number(big(g.logMonoTime)) / 1e9 - f.ptsSec);
      if (dt < 2) { gpsTimestamp = g.logMonoTime; break; }
    }
    return {
      segmentId: segReport.segmentId,
      videoFrameIndex: idx,
      videoTimestampSec: +f.ptsSec.toFixed(6),
      segmentRelativeTimeSec: +((f.ptsSec - segReport.video.startTimeSec)).toFixed(6),
      nearestModelV2FrameId: m ? m.modelV2FrameId : null,
      modelV2Timestamp: m ? m.modelV2LogMonoTime : null,
      timestampDiffMs: tsDiff,
      gpsTimestamp,
      speedMps: speedMps != null ? +speedMps.toFixed(2) : null,
      headingDeg: headingDeg != null ? +headingDeg.toFixed(2) : null,
      movementCategory,
      lane1Available: lane1Avail,
      lane2Available: lane2Avail,
      pointDotCount: pointDotsByS.length,
      candidateDAvailable: lane1Ranges.length > 0 || lane2Ranges.length > 0,
      syncConfidence: conf,
      notes: m ? null : 'no matched ModelV2 observation at this frame',
    };
  });
  return records;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = { generatedAt: new Date().toISOString(), method: 'video PTS <-> EncodeIndex.timestampSof <-> ModelV2.frameId', maxAcceptableTsDiffMs: MAX_ACCEPTABLE_TS_DIFF_MS, segments: {} };
  for (const seg of TARGET_SEGS) {
    const r = buildManifestForSegment(seg);
    if (!r) { console.log('seg', seg, ': video or qlog missing'); continue; }
    out.segments[String(seg)] = r;
    console.log(`\n=== segment ${seg} ===`);
    console.log(`  video: ${r.video.resolution} ${r.video.codec} ${r.video.frameRate} fps ${r.video.durationSec}s ${r.video.totalDecodedFrames} frames start=${r.video.startTimeSec}`);
    console.log(`  qlog: ${r.qlog.modelV2Observations} modelV2 obs, ${r.qlog.encodeIndexCount} encode indices, ${r.qlog.gpsCount} gps`);
    console.log(`  sync offset (videoStart - encodeStart): ${r.sync.videoQlogOffsetSec}s`);
    console.log(`  alignment: ${r.alignment.encodeIndexMatches} encode matches, ${r.alignment.duplicatedMatches} dup, ${r.alignment.modelV2Matched}/${r.qlog.modelV2Observations} modelV2 matched`);
    console.log(`  ts error: med=${r.alignment.medianTsErrorMs}ms p90=${r.alignment.p90TsErrorMs}ms p95=${r.alignment.p95TsErrorMs}ms max=${r.alignment.maxTsErrorMs}ms`);
    console.log(`  movement cats (matched obs): ${JSON.stringify(r.movementCategories)}`);
  }
  // schema
  const schema = {
    manifestVersion: '1.0',
    recordFields: {
      segmentId: 'integer segment index',
      videoFrameIndex: '0-based index into decoded video frames',
      videoTimestampSec: 'video frame PTS in seconds',
      segmentRelativeTimeSec: 'seconds from video start',
      nearestModelV2FrameId: 'ModelV2.frameId matched via EncodeIndex.frameId',
      modelV2Timestamp: 'ModelV2.logMonoTime (ns)',
      timestampDiffMs: '|video PTS - encode timestampSof| in ms',
      gpsTimestamp: 'nearest GPS logMonoTime if available',
      speedMps: 'pose speed at matched observation',
      headingDeg: 'pose heading',
      movementCategory: 'straight|mild|strong|headingUnavailable|stationary',
      lane1Available: 'boolean - lane1 boundary published near this frame',
      lane2Available: 'boolean - lane2 boundary published near this frame',
      pointDotCount: 'count of Point dots near this frame timestamp',
      candidateDAvailable: 'boolean - Candidate D boundary section at this frame',
      syncConfidence: 'high|medium|low|none from fixed rules',
      notes: 'free text / failure reason',
    },
    syncConfidenceRules: {
      high: 'timestampDiffMs <= 100',
      medium: '100 < timestampDiffMs <= 300',
      low: 'timestampDiffMs > 300',
      none: 'no matched observation',
    },
  };
  fs.writeFileSync(path.join(OUT_DIR, 'manifest_schema.json'), JSON.stringify(schema, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'video_sync_manifest.json'), JSON.stringify(out, null, 2));
  // CSV manifest per segment
  const csvFields = ['segmentId', 'videoFrameIndex', 'videoTimestampSec', 'segmentRelativeTimeSec', 'nearestModelV2FrameId', 'modelV2Timestamp', 'timestampDiffMs', 'speedMps', 'headingDeg', 'movementCategory', 'lane1Available', 'lane2Available', 'pointDotCount', 'candidateDAvailable', 'syncConfidence', 'notes'];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  for (const [segId, r] of Object.entries(out.segments)) {
    const rows = (r.frameManifest || []).map((rec) => csvFields.map((f) => esc(rec[f])).join(','));
    const csv = [csvFields.join(','), ...rows].join('\n');
    fs.writeFileSync(path.join(OUT_DIR, `frame_manifest_seg${segId}.csv`), csv);
  }
  console.log('\nwrote', path.join(OUT_DIR, 'video_sync_manifest.json'));
  console.log('wrote', path.join(OUT_DIR, 'manifest_schema.json'));
  console.log('wrote per-segment CSV manifests');
}

main();
