/**
 * Local multi-frame support filtering and geometry layer classification.
 */

const { dist2d } = require('./chunking');

const CLASS = {
  RAW: 'unsupported_raw',
  TRACKED: 'tracked_temp',
  LANE_ONLY: 'lane_only_candidate',
  ACCEPTED: 'supported_fused_lane',
  REJECTED: 'rejected_outlier',
};

const DEFAULT_SUPPORT = {
  intervalM: 5,
  minFramesPerInterval: 1,
  minTrackFrames: 2,
  minTrackDurationSec: 0,
  minCoveredDistanceM: 5,
  minMeanConfidence: 0.35,
  maxFrameGapM: 40,
  maxLateralVariance: 2.5,
};

function timeGapSec(a, b) {
  return Math.abs(Number(BigInt(b) - BigInt(a))) / 1e9;
}

function buildTrackIntervals(track, frames, trajectory, options = {}) {
  const opts = { ...DEFAULT_SUPPORT, ...options };
  const trackFrames = frames.filter((f) =>
    (f.lanes || []).some((l) => l.laneTrackId === track.trackId));

  const observations = [];
  for (const f of trackFrames) {
    for (const lane of f.lanes || []) {
      if (lane.laneTrackId !== track.trackId) continue;
      const pts = lane.points || [];
      const mid = pts[Math.floor(pts.length / 2)];
      if (!mid) continue;
      observations.push({
        frameId: f.frameId,
        logMonoTime: f.logMonoTime,
        east: mid.east,
        north: mid.north,
        modelY: mid.modelY ?? 0,
        confidence: lane.prob ?? 1,
        s: mid.s ?? null,
      });
    }
  }

  if (!observations.length) return [];

  let sValues = observations.map((o) => o.s).filter((s) => s != null);
  if (!sValues.length) {
    let cum = 0;
    for (let i = 0; i < observations.length; i++) {
      if (i > 0) cum += dist2d(observations[i - 1], observations[i]);
      observations[i].s = cum;
      sValues.push(cum);
    }
  }

  const sMin = Math.min(...sValues);
  const sMax = Math.max(...sValues);
  const intervals = [];

  for (let s = Math.floor(sMin / opts.intervalM) * opts.intervalM; s <= sMax; s += opts.intervalM) {
    const inInterval = observations.filter((o) => o.s >= s && o.s < s + opts.intervalM);
    const frameIds = [...new Set(inInterval.map((o) => o.frameId))];
    const confs = inInterval.map((o) => o.confidence);
    const latVals = inInterval.map((o) => o.modelY);
    const meanLat = latVals.length ? latVals.reduce((a, b) => a + b, 0) / latVals.length : 0;
    const latVar = latVals.length > 1
      ? latVals.reduce((sum, v) => sum + (v - meanLat) ** 2, 0) / latVals.length
      : 0;

    intervals.push({
      s0: s,
      s1: s + opts.intervalM,
      observationCount: inInterval.length,
      independentFrames: frameIds.length,
      frameIds,
      meanConfidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0,
      minConfidence: confs.length ? Math.min(...confs) : 0,
      lateralVariance: latVar,
      supported: frameIds.length >= opts.minFramesPerInterval
        && latVar <= opts.maxLateralVariance,
    });
  }
  return intervals;
}

function classifyTrack(track, frames, options = {}) {
  const opts = { ...DEFAULT_SUPPORT, ...options };
  const frameIds = track.frameIds || [];
  const frameCount = frameIds.length;

  if (frameCount < 1) return { classification: CLASS.RAW, reason: 'noFrames' };

  const durationSec = frameCount >= 2
    ? timeGapSec(
      frames.find((f) => f.frameId === frameIds[0])?.logMonoTime ?? 0,
      frames.find((f) => f.frameId === frameIds[frameIds.length - 1])?.logMonoTime ?? 0
    ) : 0;

  const intervals = buildTrackIntervals(track, frames, null, opts);
  const supportedIntervals = intervals.filter((i) => i.supported);
  const supportedLengthM = supportedIntervals.length * opts.intervalM;
  const totalLengthM = intervals.length * opts.intervalM;
  const supportPct = totalLengthM > 0 ? (supportedLengthM / totalLengthM) * 100 : 0;

  const confs = [];
  for (const fid of frameIds) {
    const f = frames.find((fr) => fr.frameId === fid);
    for (const lane of f?.lanes || []) {
      if (lane.laneTrackId === track.trackId) confs.push(lane.prob ?? 1);
    }
  }
  const meanConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;

  const meta = {
    laneTrackId: track.trackId,
    passId: track.passId,
    chunkId: track.chunkId,
    sessionId: track.sessionId,
    supportingFrameIds: frameIds,
    independentFrameCount: frameCount,
    temporalDurationSec: durationSec,
    coveredDistanceM: track.coveredDistanceM ?? 0,
    meanConfidence: meanConf,
    minConfidence: confs.length ? Math.min(...confs) : 0,
    maxFrameGapM: opts.maxFrameGapM,
    supportedLengthM,
    supportPct,
    intervals,
    supportedIntervals: supportedIntervals.length,
  };

  if (frameCount === 1) {
    return { classification: CLASS.RAW, reason: 'oneFrameOnly', ...meta };
  }

  if (frameCount >= 2 && meanConf >= opts.minMeanConfidence) {
    return { classification: CLASS.ACCEPTED, reason: 'multiFrameTrack', ...meta };
  }

  if (frameCount < opts.minTrackFrames || meanConf < opts.minMeanConfidence) {
    return { classification: CLASS.LANE_ONLY, reason: 'insufficientTrackSupport', ...meta };
  }

  if (supportedIntervals.length === 0) {
    return { classification: CLASS.LANE_ONLY, reason: 'noSupportedIntervals', ...meta };
  }
}

function filterFusedLaneFragments(fusedLanes, tracks, frames, polygons, options = {}) {
  const accepted = [];
  const laneOnly = [];
  const rejected = [];
  const trackById = new Map(tracks.map((t) => [t.trackId, t]));

  for (const frag of fusedLanes || []) {
    const trackId = frag.laneTrackId ?? frag.trackId;
    const track = trackById.get(trackId);
    const cls = track
      ? classifyTrack(track, frames, options)
      : { classification: CLASS.RAW, reason: 'noTrack' };

    const enriched = {
      ...frag,
      classification: cls.classification,
      acceptanceReason: cls.reason,
      supportMeta: cls,
    };

    if (cls.classification === CLASS.ACCEPTED) accepted.push(enriched);
    else if (cls.classification === CLASS.LANE_ONLY) laneOnly.push(enriched);
    else if (cls.classification === CLASS.REJECTED) rejected.push(enriched);
    else rejected.push({ ...enriched, classification: CLASS.RAW });
  }

  return { accepted, laneOnly, rejected };
}

function auditFragmentAgainstPolygon(frag, polygons, edges, options = {}) {
  const maxBeyondM = options.maxBeyondPolygonM ?? 15;
  const pts = frag.points || [];
  if (!pts.length || !polygons?.length) {
    return { outsidePolygon: true, nearEdge: false, reason: 'noPolygon' };
  }

  let insideCount = 0;
  for (const pt of pts) {
    for (const poly of polygons) {
      if (pointInPolygon(pt, poly.ring)) { insideCount++; break; }
    }
  }
  const insidePct = insideCount / pts.length;

  return {
    insidePolygonPct: insidePct * 100,
    outsidePolygon: insidePct < 0.3,
    nearEdge: insidePct >= 0.3 && insidePct < 0.8,
    reason: insidePct < 0.3 ? 'extendsOutsidePolygon' : null,
  };
}

function pointInPolygon(pt, ring) {
  if (!ring?.length) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].east; const yi = ring[i].north;
    const xj = ring[j].east; const yj = ring[j].north;
    if (((yi > pt.north) !== (yj > pt.north))
      && (pt.east < (xj - xi) * (pt.north - yi) / (yj - yi + 1e-12) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function buildGeometryLayers(frames, tracks, fusedLanes, fusedEdges, polygons, options = {}) {
  const { accepted, laneOnly, rejected } = filterFusedLaneFragments(fusedLanes, tracks, frames, polygons, options);

  const suspiciousFragments = [];
  for (const frag of [...accepted, ...laneOnly]) {
    const audit = auditFragmentAgainstPolygon(frag, polygons, fusedEdges, options);
    const singleFrame = frag.supportMeta?.independentFrameCount === 1;
    if (audit.outsidePolygon && singleFrame) {
      suspiciousFragments.push({
        ...frag,
        polygonAudit: audit,
        action: 'demoteToLaneOnly',
      });
    }
  }

  const demoteIds = new Set(suspiciousFragments.filter((s) => s.action === 'demoteToLaneOnly').map((s) => s.laneTrackId));
  const finalAccepted = accepted.filter((f) => !demoteIds.has(f.laneTrackId));
  const demoted = accepted.filter((f) => demoteIds.has(f.laneTrackId));

  return {
    raw: frames,
    tracked: tracks,
    laneOnlyCandidates: [...laneOnly, ...demoted],
    acceptedFusedLanes: finalAccepted,
    rejectedOutliers: rejected,
    fusedEdges,
    roadSurfacePolygons: polygons,
    suspiciousFragments,
  };
}

module.exports = {
  CLASS,
  DEFAULT_SUPPORT,
  classifyTrack,
  buildTrackIntervals,
  filterFusedLaneFragments,
  auditFragmentAgainstPolygon,
  buildGeometryLayers,
};
