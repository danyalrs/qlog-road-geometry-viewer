/**
 * Stage 16 — BEV inspection artifact generator (representative frames).
 */
const fs = require('fs');
const path = require('path');
const { PROJECTION_STATUSES, BEV_REQUIRED_CATEGORIES } = require('./stage16_projection_schema');

function boundsOfPoints(points) {
  let minS = Infinity; let maxS = -Infinity;
  let minD = Infinity; let maxD = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.s) || !Number.isFinite(p.d)) continue;
    minS = Math.min(minS, p.s); maxS = Math.max(maxS, p.s);
    minD = Math.min(minD, p.d); maxD = Math.max(maxD, p.d);
  }
  if (!Number.isFinite(minS)) return { minS: 0, maxS: 100, minD: -10, maxD: 10 };
  const padS = Math.max(5, (maxS - minS) * 0.1);
  const padD = Math.max(2, (maxD - minD) * 0.2);
  return { minS: minS - padS, maxS: maxS + padS, minD: minD - padD, maxD: maxD + padD };
}

function toSvgCoords(s, d, bounds, width, height) {
  const x = ((s - bounds.minS) / (bounds.maxS - bounds.minS || 1)) * (width - 40) + 20;
  const y = height - 20 - ((d - bounds.minD) / (bounds.maxD - bounds.minD || 1)) * (height - 40);
  return { x, y };
}

function slotSummary(ob) {
  const pa = ob.pointAudit || {};
  return {
    slotIndex: ob.sourceSlotIndex,
    inferredRole: ob.inferredSlotRole,
    projectionStatus: ob.projectionStatus,
    rejectionReasons: ob.rejectionReasons || [],
    sourcePointsAfterX: pa.afterXWindowCount ?? ob.deviceFramePoints?.length ?? 0,
    projectedPointCount: pa.projectedPointCount ?? ob.projectedRoutePoints?.length ?? 0,
    rawSourcePointCount: pa.rawSourcePointCount ?? null,
    retainedPointFraction: pa.retainedPointFraction ?? null,
  };
}

function renderBevSvg(title, observations, meta = {}) {
  const projected = observations.filter((o) => o.projectionStatus === PROJECTION_STATUSES.PROJECTED);
  const allPts = projected.flatMap((o) => o.projectedRoutePoints);
  const bounds = boundsOfPoints(allPts);
  const width = 800;
  const height = 520;
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<rect width="100%" height="100%" fill="#111"/>`,
    `<text x="20" y="24" fill="#ccc" font-size="14">${title}</text>`,
    `<text x="20" y="42" fill="#888" font-size="10">${meta.selectionRule || ''}</text>`,
  ];

  const colors = ['#4af', '#4f4', '#fa4', '#f4a'];
  let yOff = 58;
  for (const ob of observations) {
    const color = colors[ob.sourceSlotIndex % colors.length];
    const pts = ob.projectedRoutePoints || [];
    if (ob.projectionStatus !== PROJECTION_STATUSES.PROJECTED) {
      const reason = (ob.rejectionReasons || []).join(', ') || ob.projectionStatus;
      lines.push(`<text x="20" y="${yOff}" fill="#888" font-size="11">slot ${ob.sourceSlotIndex} (${ob.inferredSlotRole}): ${ob.projectionStatus} — ${reason}</text>`);
      yOff += 14;
      continue;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = toSvgCoords(pts[i - 1].s, pts[i - 1].d, bounds, width, height);
      const b = toSvgCoords(pts[i].s, pts[i].d, bounds, width, height);
      lines.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${color}" stroke-width="2"/>`);
    }
    if (pts[0]) {
      const p = toSvgCoords(pts[0].s, pts[0].d, bounds, width, height);
      lines.push(`<text x="${p.x + 4}" y="${p.y - 4}" fill="${color}" font-size="10">${ob.sourceSlotIndex}</text>`);
    }
  }

  if (meta.poseSectionNote) {
    lines.push(`<text x="20" y="${height - 24}" fill="#fa4" font-size="10">${meta.poseSectionNote}</text>`);
  }
  lines.push(`<text x="20" y="${height - 8}" fill="#666" font-size="10">s → | d ↑ | assessment prototype | not ground-truth alignment</text>`);
  lines.push('</svg>');
  return lines.join('\n');
}

function buildFrameIndex(observations, modelEventByKey) {
  const byFrame = new Map();
  for (const ob of observations) {
    const key = `${ob.segmentId}|${ob.logMonoTime}`;
    if (!byFrame.has(key)) byFrame.set(key, { observations: [], key });
    byFrame.get(key).observations.push(ob);
    const ev = modelEventByKey.get(`${ob.sourceFile}|${ob.logMonoTime}`);
    if (ev) byFrame.get(key).modelEvent = ev;
  }
  return byFrame;
}

function headingDeltaDeg(h1, h2) {
  let d = Math.abs(h2 - h1) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

function estimateCurvatureScore(observations, modelEvent) {
  const pose = modelEvent?.pose;
  if (pose?.headingDeg != null) return 0;
  const mv = modelEvent?.modelV2 || {};
  const meta = mv.meta || {};
  if (meta.desireState != null) return 0;
  const projected = observations.filter((o) => o.projectionStatus === PROJECTION_STATUSES.PROJECTED);
  if (projected.length < 2) return 0;
  let maxDSpread = 0;
  for (const ob of projected) {
    const ds = ob.projectedRoutePoints.map((p) => p.d);
    if (ds.length) maxDSpread = Math.max(maxDSpread, Math.max(...ds) - Math.min(...ds));
  }
  return maxDSpread;
}

function hasLaneChangeMetadata(modelEvent) {
  const meta = modelEvent?.modelV2?.meta || {};
  const lcs = meta.laneChangeState;
  const ds = meta.desireState;
  return (lcs != null && lcs !== 0 && lcs !== 'none')
    || (ds != null && String(ds).toLowerCase().includes('lane'));
}

function pickRepresentativeFrames(observations, segmentSummaries, modelEvents = [], routeMeta = {}) {
  const modelEventByKey = new Map();
  for (const ev of modelEvents) {
    modelEventByKey.set(`${ev.sourceFile}|${ev.logMonoTime}`, ev);
  }
  const byFrame = buildFrameIndex(observations, modelEventByKey);
  const frames = [...byFrame.values()];
  const picks = [];
  const used = new Set();

  const take = (label, candidate, selectionRule, extra = {}) => {
    if (!candidate || used.has(candidate.key)) return false;
    used.add(candidate.key);
    picks.push({
      label,
      key: candidate.key,
      observations: candidate.observations,
      modelEvent: candidate.modelEvent,
      selectionRule,
      ...extra,
    });
    return true;
  };

  const scoreStraight = (f) => {
    const proj = f.observations.filter((o) => o.projectionStatus === PROJECTION_STATUSES.PROJECTED);
    if (proj.length < 3) return -1;
    let monotonic = 0;
    for (const ob of proj) {
      const xs = ob.deviceFramePoints.map((p) => p.x);
      if (xs.length >= 2 && xs[xs.length - 1] > xs[0]) monotonic++;
    }
    return monotonic;
  };

  const straight = frames.sort((a, b) => scoreStraight(b) - scoreStraight(a))[0];
  take('straight_road', straight, 'All slots projected; monotonic forward device-x on ≥3 slots');

  const curvedCandidates = frames
    .map((f) => ({ f, score: estimateCurvatureScore(f.observations, f.modelEvent) }))
    .filter((x) => x.score > 1.5)
    .sort((a, b) => b.score - a.score);
  if (curvedCandidates.length) {
    take('curved_road', curvedCandidates[0].f, `Projected lateral spread score ${curvedCandidates[0].score.toFixed(1)} — curved-road geometry`);
  } else {
    const alt = frames.find((f) => f.observations.some((o) => o.projectionStatus === PROJECTION_STATUSES.PROJECTED
      && (o.pointAudit?.projectedRouteSpanM ?? 0) > 30));
    const fallback = frames.find((f) => f.observations.filter((o) => o.projectionStatus === PROJECTION_STATUSES.PROJECTED).length >= 2);
    take('curved_road', alt || fallback, 'Fallback: multi-slot projection with extended route-s span (curved-road proxy)');
  }

  const lowConf = frames.find((f) => f.observations.some((o) => o.projectionStatus === PROJECTION_STATUSES.REJECTED_LOW_ASSESSMENT_CONFIDENCE));
  take('low_confidence', lowConf, 'At least one slot rejected for assessment confidence below Stage 15A threshold');

  const singleSide = frames.find((f) => {
    const proj = f.observations.filter((o) => o.projectionStatus === PROJECTION_STATUSES.PROJECTED);
    return proj.length === 1 || proj.length === 2;
  });
  take('single_valid_side', singleSide, 'Only 1–2 of 4 slots projected; remaining slots rejected');

  const bothInvalid = frames.find((f) => !f.observations.some((o) => o.projectionStatus === PROJECTION_STATUSES.PROJECTED));
  take('both_invalid', bothInvalid, 'No slots projected in frame — all rejected');

  const sectionBoundaries = routeMeta.sectionBoundaryFrames || [];
  const boundaryFrame = frames.find((f) => {
    const onBoundary = sectionBoundaries.some((b) => b.segmentId === f.observations[0]?.segmentId
      && b.logMonoTime === f.observations[0]?.logMonoTime);
    if (!onBoundary) return false;
    const sections = new Set(f.observations.map((o) => o.poseSectionId));
    const proj = f.observations.filter((o) => o.projectionStatus === PROJECTION_STATUSES.PROJECTED);
    return proj.length >= 2 && sections.size === 1;
  }) || frames.find((f) => {
    const obs = f.observations;
    const left = obs.filter((o) => o.inferredSlotRole?.includes('left') || o.sourceSlotIndex <= 1);
    const right = obs.filter((o) => o.inferredSlotRole?.includes('right') || o.sourceSlotIndex >= 2);
    const lp = left.some((o) => o.projectionStatus === PROJECTION_STATUSES.PROJECTED);
    const rp = right.some((o) => o.projectionStatus === PROJECTION_STATUSES.PROJECTED);
    return lp && rp;
  });
  take('pose_section_boundary', boundaryFrame, 'Observations on both sides; geometry scoped to single pose section (no cross-boundary projection)', {
    poseSectionNote: boundaryFrame
      ? `pass=${boundaryFrame.observations[0]?.temporalPassId} section=${boundaryFrame.observations[0]?.poseSectionId}`
      : null,
  });

  const sparseSegIds = new Set(
    (segmentSummaries || [])
      .filter((s) => (s.pctProjected ?? 0) < 0.5 || s.modelV2FrameCount < 5)
      .map((s) => s.segmentId),
  );
  const sparse = frames.find((f) => sparseSegIds.has(f.observations[0]?.segmentId));
  take('sparse_segment', sparse, 'Segment flagged sparse: pctProjected < 50% or modelV2FrameCount < 5 (named assessment criteria)');

  const outlierSegIds = new Set([57, 62, 65, 66, 96]);
  const outlier = frames.find((f) => outlierSegIds.has(f.observations[0]?.segmentId));
  take('stage15_outlier', outlier, 'Segment in Stage 15 coverage outlier set {57,62,65,66,96}');

  const laneChange = frames.find((f) => hasLaneChangeMetadata(f.modelEvent)
    && f.observations.some((o) => o.projectionStatus === PROJECTION_STATUSES.PROJECTED));
  take('apparent_lane_change_geometry', laneChange, 'Metadata-associated: modelV2.meta.laneChangeState or desireState indicates lane-change context', {
    laneChangeMetadata: laneChange?.modelEvent?.modelV2?.meta
      ? {
        laneChangeState: laneChange.modelEvent.modelV2.meta.laneChangeState,
        desireState: laneChange.modelEvent.modelV2.meta.desireState,
      }
      : null,
    labelQualifier: 'metadata-associated',
  });

  for (const cat of BEV_REQUIRED_CATEGORIES) {
    if (!picks.find((p) => p.label === cat)) {
      const fallback = frames.find((f) => !used.has(f.key));
      if (fallback) take(cat, fallback, `Fallback selection for required category ${cat}`);
    }
  }

  return picks;
}

function buildManifestEntry(pick) {
  const obs = pick.observations;
  const first = obs[0] || {};
  const projected = obs.filter((o) => o.projectionStatus === PROJECTION_STATUSES.PROJECTED);
  const rejected = obs.filter((o) => o.projectionStatus !== PROJECTION_STATUSES.PROJECTED);
  return {
    category: pick.label,
    segmentId: first.segmentId,
    chunkId: first.chunkId,
    sourceFrameIndex: first.sourceEventIndex,
    sourceFrameId: first.sourceFrameId,
    logMonoTime: first.logMonoTime,
    temporalPassId: first.temporalPassId,
    poseSectionId: first.poseSectionId,
    selectionRule: pick.selectionRule,
    labelQualifier: pick.labelQualifier || null,
    laneChangeMetadata: pick.laneChangeMetadata || null,
    poseSectionNote: pick.poseSectionNote || null,
    projectedSlotCount: projected.length,
    rejectedSlotCount: rejected.length,
    slots: obs.map(slotSummary),
    rejectedSlots: rejected.map((o) => ({
      slotIndex: o.sourceSlotIndex,
      status: o.projectionStatus,
      reasons: o.rejectionReasons,
    })),
    file: `stage16_bev_${pick.label}.svg`,
  };
}

function generateBevInspections(audit, observations, outputDir, options = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const picks = pickRepresentativeFrames(
    observations,
    audit.segmentSummaries || [],
    options.modelEvents || [],
    options.routeMeta || {},
  );
  const manifest = [];

  for (const pick of picks) {
    const entry = buildManifestEntry(pick);
    const title = `${pick.label} seg${entry.segmentId} t${entry.logMonoTime}`;
    const svg = renderBevSvg(title, pick.observations, {
      selectionRule: pick.selectionRule,
      poseSectionNote: pick.poseSectionNote,
    });
    const outPath = path.join(outputDir, entry.file);
    fs.writeFileSync(outPath, svg);
    manifest.push(entry);
  }

  const categories = manifest.map((m) => m.category);
  const missing = BEV_REQUIRED_CATEGORIES.filter((c) => !categories.includes(c));
  fs.writeFileSync(path.join(outputDir, 'stage16_bev_manifest.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    requiredCategories: BEV_REQUIRED_CATEGORIES,
    categoriesPresent: categories,
    missingCategories: missing,
    artifacts: manifest,
  }, null, 2));
  return manifest;
}

module.exports = {
  renderBevSvg,
  generateBevInspections,
  pickRepresentativeFrames,
  BEV_REQUIRED_CATEGORIES,
};
