'use strict';

/**
 * Unconfirmed per-frame lane evidence — display-only diagnostic layer (Section 13).
 * Builds gated polylines from processData.frames[].lanes[].points only.
 * Never mutates production map structures or export paths.
 */
(function candidateLayerDisplayModule(global) {
  const MIN_LANE_PROB = 0.5;
  const MIN_USABLE_SPAN_M = 3;

  function sideFromLaneIndex(laneIndex) {
    if (laneIndex == null) return null;
    return laneIndex <= 1 ? 'right' : 'left';
  }

  function polylineLengthM(points) {
    let len = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      len += Math.hypot(
        (b.localEast ?? b.east) - (a.localEast ?? a.east),
        (b.localNorth ?? b.north) - (a.localNorth ?? a.north),
      );
    }
    return len;
  }

  function orient(p, q, r) {
    return (q.localEast - p.localEast) * (r.localNorth - p.localNorth)
      - (q.localNorth - p.localNorth) * (r.localEast - p.localEast);
  }

  function onSeg(p, q, r) {
    return Math.min(p.localEast, r.localEast) <= q.localEast && q.localEast <= Math.max(p.localEast, r.localEast)
      && Math.min(p.localNorth, r.localNorth) <= q.localNorth && q.localNorth <= Math.max(p.localNorth, r.localNorth);
  }

  function segmentsIntersect(a1, a2, b1, b2) {
    const o1 = orient(a1, a2, b1);
    const o2 = orient(a1, a2, b2);
    const o3 = orient(b1, b2, a1);
    const o4 = orient(b1, b2, a2);
    if (o1 === 0 && onSeg(a1, b1, a2)) return true;
    if (o2 === 0 && onSeg(a1, b2, a2)) return true;
    if (o3 === 0 && onSeg(b1, a1, b2)) return true;
    if (o4 === 0 && onSeg(b1, a2, b2)) return true;
    return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
  }

  function hasSelfIntersection(points) {
    if (points.length < 4) return false;
    for (let i = 0; i < points.length - 1; i++) {
      for (let j = i + 2; j < points.length - 1; j++) {
        if (i === 0 && j === points.length - 2) continue;
        if (segmentsIntersect(points[i], points[i + 1], points[j], points[j + 1])) return true;
      }
    }
    return false;
  }

  function isCandidatesFeatureEnabled(search) {
    if (search != null && search !== '') {
      return new URLSearchParams(search).get('candidates') === '1';
    }
    if (typeof global.location !== 'undefined' && global.location.search) {
      return new URLSearchParams(global.location.search).get('candidates') === '1';
    }
    return false;
  }

  /**
   * @param {object} processData — /api/process payload (frames, timeline, …)
   * @param {{ referencePose, chunkId, passId, bounds }} options
   * @returns {{ candidates, rejections, gates }}
   */
  function buildGatedCandidatePolylines(processData, options = {}) {
    const SLM = global.SegmentLocalMap;
    const PA = global.PointAccumulation;
    const sideFn = PA?.sideFromLaneIndex || sideFromLaneIndex;
    const frames = processData?.frames || [];
    const referencePose = options.referencePose ?? null;
    const chunkId = options.chunkId ?? 0;
    const passId = options.passId ?? 0;
    const bounds = options.bounds ?? null;

    const candidates = [];
    const rejections = {
      lowProb: 0,
      shortSpan: 0,
      nonFinite: 0,
      selfIntersection: 0,
      outOfBounds: 0,
      tooFewPoints: 0,
    };

    for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
      const frame = frames[frameIndex];
      if (frame.chunkId != null && frame.chunkId !== chunkId) continue;
      const fPass = frame.passId ?? frame.temporalPassId ?? 0;
      if (passId != null && fPass !== passId) continue;

      const frameId = frame.frameId ?? frame.logMonoTime ?? frameIndex;

      for (const lane of frame.lanes || []) {
        const prob = lane.prob ?? 1;
        if (prob < MIN_LANE_PROB) {
          rejections.lowProb++;
          continue;
        }

        const rawPts = lane.points || [];
        if (rawPts.length < 2) {
          rejections.tooFewPoints++;
          continue;
        }

        let localPts;
        if (referencePose && SLM?.transformPolylineToSegmentLocal) {
          localPts = SLM.transformPolylineToSegmentLocal(rawPts, referencePose);
        } else {
          localPts = rawPts.map((p) => ({
            ...p,
            localEast: p.localEast ?? p.east,
            localNorth: p.localNorth ?? p.north,
          }));
        }

        localPts.sort((a, b) => (a.modelX ?? a.s ?? 0) - (b.modelX ?? b.s ?? 0));

        if (localPts.some((p) => !Number.isFinite(p.localEast) || !Number.isFinite(p.localNorth))) {
          rejections.nonFinite++;
          continue;
        }

        const span = polylineLengthM(localPts);
        if (span < MIN_USABLE_SPAN_M) {
          rejections.shortSpan++;
          continue;
        }
        if (hasSelfIntersection(localPts)) {
          rejections.selfIntersection++;
          continue;
        }

        if (bounds?.finite) {
          const oob = localPts.some((p) => p.localEast < bounds.minE || p.localEast > bounds.maxE
            || p.localNorth < bounds.minN || p.localNorth > bounds.maxN);
          if (oob) {
            rejections.outOfBounds++;
            continue;
          }
        }

        const laneIndex = lane.laneIndex;
        candidates.push({
          frameId,
          frameIndex,
          chunkId: frame.chunkId ?? chunkId,
          passId: fPass,
          laneIndex,
          side: sideFn(laneIndex),
          prob,
          spanM: +span.toFixed(3),
          points: localPts,
        });
      }
    }

    return {
      candidates,
      rejections,
      gates: {
        minLaneProb: MIN_LANE_PROB,
        minUsableSpanM: MIN_USABLE_SPAN_M,
        perFrameOnly: true,
        noCrossFrameMerge: true,
      },
    };
  }

  const api = {
    MIN_LANE_PROB,
    MIN_USABLE_SPAN_M,
    sideFromLaneIndex,
    polylineLengthM,
    hasSelfIntersection,
    isCandidatesFeatureEnabled,
    buildGatedCandidatePolylines,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.CandidateLayerDisplay = api;
}(typeof window !== 'undefined' ? window : globalThis));
