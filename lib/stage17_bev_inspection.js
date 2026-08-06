/**
 * Stage 17 — BEV inspection artifacts for divider tracks and supported runs.
 */
const fs = require('fs');
const path = require('path');
const { BEV_REQUIRED_CATEGORIES } = require('./stage17_tracking_schema');
const { observationId } = require('./stage17_divider_association');
const { ASSOCIATION_OUTCOMES } = require('./stage17_tracking_schema');

function boundsOfGeometry(points) {
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

function toSvg(s, d, bounds, w, h) {
  const x = ((s - bounds.minS) / (bounds.maxS - bounds.minS || 1)) * (w - 40) + 20;
  const y = h - 20 - ((d - bounds.minD) / (bounds.maxD - bounds.minD || 1)) * (h - 40);
  return { x, y };
}

function collectPoints(track, obsMap, runs) {
  const pts = [];
  for (const id of track.observationIds || []) {
    const ob = obsMap.get(id);
    if (!ob) continue;
    for (const p of ob.projectedRoutePoints || []) {
      if (Number.isFinite(p.s) && Number.isFinite(p.d)) pts.push({ ...p, observationId: id });
    }
  }
  for (const r of runs || []) {
    for (const p of r.representativeRouteD || []) pts.push({ s: p.s, d: p.d, runId: r.dividerRunId });
  }
  return pts;
}

function timestampRange(track, obsMap) {
  const times = [];
  for (const id of track.observationIds || []) {
    const ob = obsMap.get(id);
    if (ob?.logMonoTime) times.push(BigInt(ob.logMonoTime));
  }
  if (!times.length) return null;
  times.sort((a, b) => (a < b ? -1 : 1));
  return { start: times[0].toString(), end: times[times.length - 1].toString() };
}

function renderBevSvg(title, track, obsMap, runs, gaps, meta = {}) {
  const pts = collectPoints(track, obsMap, runs);
  const bounds = boundsOfGeometry(pts);
  const w = 800; const h = 520;
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`,
    `<rect width="100%" height="100%" fill="#111"/>`,
    `<text x="20" y="24" fill="#ccc" font-size="14">${title}</text>`,
    `<text x="20" y="42" fill="#888" font-size="10">${meta.selectionRule || ''}</text>`,
    `<text x="20" y="56" fill="#888" font-size="10">track ${track.trackId} | obs ${track.observationCount} | runs ${(runs||[]).length} | gaps ${(gaps||[]).length}</text>`,
  ];
  if (meta.auditCategory) {
    lines.push(`<text x="20" y="70" fill="#fa4" font-size="10">audit: ${meta.auditCategory}</text>`);
  }

  for (const g of gaps || []) {
    const a = toSvg(g.routeSStart, 0, bounds, w, h);
    const b = toSvg(g.routeSEnd, 0, bounds, w, h);
    lines.push(`<line x1="${a.x}" y1="${h/2}" x2="${b.x}" y2="${h/2}" stroke="#f44" stroke-width="4" stroke-dasharray="6,4"/>`);
    lines.push(`<text x="${(a.x+b.x)/2}" y="${h/2-6}" fill="#f88" font-size="9">${g.reason}</text>`);
  }

  const colors = ['#4af', '#4f4', '#fa4', '#f4a'];
  for (const r of runs || []) {
    const rpts = (r.representativeRouteD || []).sort((a, b) => a.s - b.s);
    for (let i = 1; i < rpts.length; i++) {
      const a = toSvg(rpts[i - 1].s, rpts[i - 1].d, bounds, w, h);
      const b = toSvg(rpts[i].s, rpts[i].d, bounds, w, h);
      lines.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#4f4" stroke-width="3"/>`);
    }
  }

  const obsIds = new Set(track.observationIds || []);
  let ci = 0;
  for (const id of obsIds) {
    const ob = obsMap.get(id);
    if (!ob) continue;
    const color = colors[ci++ % colors.length];
    const rpts = (ob.projectedRoutePoints || []).sort((a, b) => a.s - b.s);
    for (let i = 1; i < rpts.length; i++) {
      const a = toSvg(rpts[i - 1].s, rpts[i - 1].d, bounds, w, h);
      const b = toSvg(rpts[i].s, rpts[i].d, bounds, w, h);
      lines.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${color}" stroke-width="1" opacity="0.6"/>`);
    }
  }

  lines.push(`<text x="20" y="${h - 8}" fill="#666" font-size="10">s → | d ↑ | prototype assessment | not physical-road accuracy</text>`);
  lines.push('</svg>');
  return lines.join('\n');
}

function pickRepresentativeCases(audit, tracks, runs, gaps, outcomes, observations) {
  const obsMap = new Map(observations.map((o) => [observationId(o), o]));
  const outcomeMap = new Map((outcomes || []).map((o) => [o.observationId, o]));
  const runsByTrack = new Map();
  for (const r of runs) {
    if (!runsByTrack.has(r.parentTrackId)) runsByTrack.set(r.parentTrackId, []);
    runsByTrack.get(r.parentTrackId).push(r);
  }
  const gapsByTrack = new Map();
  for (const g of gaps) {
    if (!gapsByTrack.has(g.parentTrackId)) gapsByTrack.set(g.parentTrackId, []);
    gapsByTrack.get(g.parentTrackId).push(g);
  }

  const picks = [];
  const used = new Set();
  const take = (label, track, rule, extra = {}) => {
    if (!track || used.has(track.trackId)) return false;
    used.add(track.trackId);
    picks.push({
      label,
      track,
      runs: runsByTrack.get(track.trackId) || [],
      gaps: gapsByTrack.get(track.trackId) || [],
      selectionRule: rule,
      ...extra,
    });
    return true;
  };

  const sorted = [...tracks].sort((a, b) => a.trackId.localeCompare(b.trackId));

  take('stable_straight_divider',
    sorted.find((t) => t.observationIds.length >= 5 && (t.routeSpanM ?? 0) > 30),
    'Multi-observation track with route-s span > 30 m');

  take('curved_divider',
    sorted.sort((a, b) => (b.routeSpanM ?? 0) - (a.routeSpanM ?? 0)).find((t) => t.observationIds.length >= 3),
    'Longest route-s span multi-observation track (curved-road proxy)');

  take('sparse_support',
    sorted.find((t) => t.observationIds.length === 1),
    'Single-observation track (sparse support)');

  take('explicit_observation_gap',
    sorted.find((t) => (gapsByTrack.get(t.trackId) || []).length > 0),
    'Track with explicit recorded gap between supported runs');

  const amb = (outcomes || []).find((o) => o.primaryOutcome === ASSOCIATION_OUTCOMES.REJECTED_AMBIGUOUS);
  if (amb) {
    const ob = obsMap.get(amb.observationId);
    const near = sorted.filter((t) => t.temporalPassId === ob?.temporalPassId && t.poseSectionId === ob?.poseSectionId)
      .sort((a, b) => b.observationIds.length - a.observationIds.length)[0];
    take('ambiguous_association', near, `Near ambiguous-rejected observation ${amb.observationId}`, {
      ambiguousObservationId: amb.observationId,
      competingCandidates: amb.candidateScores,
      ambiguity: amb.ambiguity,
    });
  }

  const orderEp = (audit.lateralOrderAudit?.episodes || []).find((e) => e.trackPair && e.episodeType !== 'support_change_only')
    || audit.lateralOrderAudit?.episodes?.[0];
  take('crossing_lateral_order',
    orderEp?.trackPair ? sorted.find((t) => orderEp.trackPair.includes(t.trackId)) : sorted.find((t) => t.observationIds.length >= 2),
    'Track involved in deduplicated lateral-order episode',
    { auditCategory: orderEp?.auditCategory, orderEpisode: orderEp });

  const lcOb = observations.find((o) => o.modelV2?.meta?.laneChangeState != null || String(o.modelV2?.meta?.desireState || '').toLowerCase().includes('lane'));
  if (lcOb) {
    const t = sorted.find((tr) => tr.observationIds.includes(observationId(lcOb)));
    take('lane_change_metadata', t, 'Metadata-associated lane-change context', { laneChangeMetadata: lcOb.modelV2?.meta });
  }

  const crossChunk = sorted.find((t) => false);
  take('chunk_boundary_continuation',
    crossChunk,
    'Not applicable — cross-chunk association forbidden by chunkId grouping key');

  take('boundary_separation',
    sorted.find((t) => (t.chunkIds || [t.chunkId]).length === 1 && (t.segmentIds || []).length > 1),
    'Track spanning multiple segments within one chunk (boundary separation, not cross-chunk)');

  take('pose_section_boundary',
    sorted.find((t) => t.observationIds.length >= 2),
    'Representative track scoped to single pose section (no cross-boundary geometry)');

  const outlierSegs = new Set([57, 62, 65, 66, 96]);
  take('stage16_coverage_outlier',
    sorted.find((t) => (t.segmentIds || []).some((s) => outlierSegs.has(s))),
    'Track with observations in Stage 15/16 coverage outlier segment');

  for (const cat of BEV_REQUIRED_CATEGORIES) {
    if (!picks.find((p) => p.label === cat)) {
      const fallback = sorted.find((t) => !used.has(t.trackId));
      if (fallback) take(cat, fallback, `Fallback for required category ${cat}`);
    }
  }

  return picks;
}

function buildManifestEntry(pick, obsMap, outcomeMap) {
  const track = pick.track;
  const ts = timestampRange(track, obsMap);
  const obsOutcomes = (track.observationIds || []).map((id) => {
    const o = outcomeMap.get(id);
    return {
      observationId: id,
      primaryOutcome: o?.primaryOutcome,
      birthReason: o?.birthReason,
      selectedCost: o?.selectedCost,
      candidateScores: o?.candidateScores,
    };
  });

  return {
    category: pick.label,
    trackId: track.trackId,
    chunkId: track.chunkId,
    chunkIds: track.chunkIds || [track.chunkId],
    temporalPassId: track.temporalPassId,
    poseSectionId: track.poseSectionId,
    segmentIdRange: track.segmentIdRange,
    segmentIds: track.segmentIds,
    selectionRule: pick.selectionRule,
    observationCount: track.observationCount,
    supportedRunCount: pick.runs.length,
    gapCount: pick.gaps.length,
    observationIds: track.observationIds,
    supportedRunIds: pick.runs.map((r) => r.dividerRunId),
    gapIds: pick.gaps.map((g) => g.gapId),
    gapReasons: pick.gaps.map((g) => g.reason),
    sourceTimestampRange: ts,
    observationOutcomes: obsOutcomes,
    competingCandidates: pick.competingCandidates,
    ambiguity: pick.ambiguity,
    birthReason: obsOutcomes.find((o) => o.birthReason)?.birthReason,
    auditCategory: pick.auditCategory,
    orderEpisode: pick.orderEpisode,
    chunkBoundaryContinuations: pick.chunkBoundaryContinuations,
    laneChangeMetadata: pick.laneChangeMetadata,
    file: `stage17_bev_${pick.label}.svg`,
  };
}

function generateBevInspections(audit, tracks, runs, gaps, outcomes, observations, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const obsMap = new Map(observations.map((o) => [observationId(o), o]));
  const outcomeMap = new Map((outcomes || []).map((o) => [o.observationId, o]));
  const picks = pickRepresentativeCases(audit, tracks, runs, gaps, outcomes, observations);
  const manifest = [];

  for (const pick of picks) {
    const entry = buildManifestEntry(pick, obsMap, outcomeMap);
    const title = `${pick.label} — ${pick.track.trackId}`;
    const svg = renderBevSvg(title, pick.track, obsMap, pick.runs, pick.gaps, {
      selectionRule: pick.selectionRule,
      auditCategory: pick.auditCategory,
    });
    fs.writeFileSync(path.join(outputDir, entry.file), svg);
    manifest.push(entry);
  }

  fs.writeFileSync(path.join(outputDir, 'stage17_bev_manifest.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    requiredCategories: BEV_REQUIRED_CATEGORIES,
    categoriesPresent: manifest.map((m) => m.category),
    missingCategories: BEV_REQUIRED_CATEGORIES.filter((c) => !manifest.find((m) => m.category === c)),
    artifacts: manifest,
  }, null, 2));
  return manifest;
}

module.exports = {
  generateBevInspections,
  pickRepresentativeCases,
  renderBevSvg,
  buildManifestEntry,
};
