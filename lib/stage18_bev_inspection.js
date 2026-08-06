/**
 * Stage 18 — BEV inspection for lane intervals and count assessments.
 */
const fs = require('fs');
const path = require('path');
const { BEV_REQUIRED_CATEGORIES } = require('./stage18_lane_interval_schema');

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

function toSvg(s, d, bounds, w, h) {
  const x = ((s - bounds.minS) / (bounds.maxS - bounds.minS || 1)) * (w - 40) + 20;
  const y = h - 20 - ((d - bounds.minD) / (bounds.maxD - bounds.minD || 1)) * (h - 40);
  return { x, y };
}

function renderBevSvg(title, data, meta = {}) {
  const w = 800; const h = 520;
  const pts = [];
  for (const r of data.runs || []) {
    for (const p of r.representativeRouteD || []) {
      if (Number.isFinite(p.s) && Number.isFinite(p.d)) pts.push(p);
    }
  }
  for (const iv of data.intervals || []) {
    for (const p of iv.leftRouteD || []) pts.push(p);
    for (const p of iv.rightRouteD || []) pts.push(p);
  }
  const bounds = boundsOfPoints(pts);
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`,
    `<rect width="100%" height="100%" fill="#111"/>`,
    `<text x="20" y="24" fill="#ccc" font-size="14">${title}</text>`,
    `<text x="20" y="42" fill="#888" font-size="10">${meta.selectionRule || ''}</text>`,
  ];

  for (const g of data.gaps || []) {
    const a = toSvg(g.routeSStart, 0, bounds, w, h);
    const b = toSvg(g.routeSEnd, 0, bounds, w, h);
    lines.push(`<line x1="${a.x}" y1="${h/2}" x2="${b.x}" y2="${h/2}" stroke="#f44" stroke-width="4" stroke-dasharray="6,4"/>`);
  }

  for (const r of data.runs || []) {
    const rpts = (r.representativeRouteD || []).filter((p) => Number.isFinite(p.s) && Number.isFinite(p.d)).sort((a, b) => a.s - b.s);
    for (let i = 1; i < rpts.length; i++) {
      const a = toSvg(rpts[i - 1].s, rpts[i - 1].d, bounds, w, h);
      const b = toSvg(rpts[i].s, rpts[i].d, bounds, w, h);
      lines.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#4af" stroke-width="2"/>`);
    }
  }

  for (const iv of data.intervals || []) {
    const samples = iv.widthSamples || [];
    for (const s of samples) {
      const a = toSvg(s.s, s.leftD, bounds, w, h);
      const b = toSvg(s.s, s.rightD, bounds, w, h);
      lines.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#4f4" stroke-width="1" opacity="0.5"/>`);
    }
    const lpts = (iv.leftRouteD || []).sort((a, b) => a.s - b.s);
    for (let i = 1; i < lpts.length; i++) {
      const a = toSvg(lpts[i - 1].s, lpts[i - 1].d, bounds, w, h);
      const b = toSvg(lpts[i].s, lpts[i].d, bounds, w, h);
      lines.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#fa4" stroke-width="2"/>`);
    }
    const rpts = (iv.rightRouteD || []).sort((a, b) => a.s - b.s);
    for (let i = 1; i < rpts.length; i++) {
      const a = toSvg(rpts[i - 1].s, rpts[i - 1].d, bounds, w, h);
      const b = toSvg(rpts[i].s, rpts[i].d, bounds, w, h);
      lines.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#f4a" stroke-width="2"/>`);
    }
  }

  if (meta.countAssessment) {
    lines.push(`<text x="20" y="${h - 24}" fill="#8f8" font-size="10">count: ${meta.countAssessment.laneCountCandidate ?? 'none'} status: ${meta.countAssessment.status}</text>`);
  }
  lines.push(`<text x="20" y="${h - 8}" fill="#666" font-size="10">prototype assessment — not physical-road accuracy</text>`);
  lines.push('</svg>');
  return lines.join('\n');
}

function pickCases(audit, intervals, assessments, runs, gaps, tracks) {
  const accepted = intervals.filter((iv) => iv.pairingOutcome === 'accepted' || iv.assessmentStatus === 'plausible_prototype_interval');
  const rejected = intervals.filter((iv) => iv.pairingOutcome && iv.pairingOutcome !== 'accepted');
  const runById = new Map(runs.map((r) => [r.dividerRunId, r]));
  const picks = [];
  const used = new Set();

  const take = (category, interval, assessment, rule, extra = {}) => {
    if (!interval && !assessment && !extra.forceUnavailable) return false;
    const key = interval?.laneIntervalId || assessment?.countAssessmentId || category;
    if (used.has(key) && !extra.forceUnavailable) return false;
    if (!extra.forceUnavailable) used.add(key);
    const ivRuns = interval ? [runById.get(interval.leftDividerRunId), runById.get(interval.rightDividerRunId)].filter(Boolean) : [];
    picks.push({
      category,
      interval,
      countAssessment: assessment,
      runs: ivRuns,
      gaps: extra.gaps || [],
      selectionRule: rule,
      unavailable: !!extra.forceUnavailable,
      ...extra,
    });
    return true;
  };

  take('stable_one_lane_interval',
    accepted.find((iv) => iv.assessmentStatus === 'plausible_prototype_interval'),
    assessments.find((a) => a.laneCountCandidate === 1 && a.status === 'assessed'),
    'Accepted prototype interval with assessed lane count of 1');

  take('stable_two_lane_assessment',
    null,
    assessments.find((a) => a.laneCountCandidate === 2 && a.status === 'assessed'),
    'Assessed count run with laneCountCandidate = 2');

  const maxCount = Math.max(0, ...assessments.filter((a) => a.laneCountCandidate != null).map((a) => a.laneCountCandidate));
  take('highest_supported_lane_count',
    null,
    assessments.find((a) => a.laneCountCandidate === maxCount && maxCount > 0),
    `Highest laneCountCandidate = ${maxCount}`);

  take('curved_road_intervals',
    [...accepted].sort((a, b) => b.routeSpanM - a.routeSpanM)[0],
    null,
    'Longest route-s span accepted interval');

  take('narrow_width_outlier', accepted.find((iv) => iv.assessmentStatus === 'narrow_width_outlier') || rejected.find((iv) => iv.assessmentStatus === 'narrow_width_outlier'), null, 'Narrow width outlier interval');
  take('wide_width_outlier', accepted.find((iv) => iv.assessmentStatus === 'wide_width_outlier') || rejected.find((iv) => iv.assessmentStatus === 'wide_width_outlier'), null, 'Wide width outlier interval');
  take('unstable_width_interval', rejected.find((iv) => iv.assessmentStatus === 'unstable_width_interval'), null, 'Unstable width interval');

  take('missing_outer_boundary',
    null,
    assessments.find((a) => a.status === 'incomplete_outer_boundary'),
    'Count assessment with incomplete outer boundary');

  const gapTrack = tracks.find((t) => (t.gapIds || []).length > 0);
  take('explicit_stage17_gap', null, null, 'Track with explicit Stage 17 gap', {
    gaps: gapTrack ? gaps.filter((g) => g.parentTrackId === gapTrack.trackId).slice(0, 1) : [],
    runs: gapTrack ? runs.filter((r) => r.parentTrackId === gapTrack.trackId).slice(0, 2) : [],
  });

  take('ambiguous_divider_pairing', rejected.find((iv) => iv.pairingOutcome === 'rejected_ambiguous'), null, 'Rejected ambiguous pairing');
  take('apparent_count_transition', null, null, 'Count transition candidate', {
    countAssessment: audit.countTransitions?.[0] ? { status: audit.countTransitions[0].label, laneCountCandidate: audit.countTransitions[0].laneCountCandidate } : null,
  });

  take('pose_section_boundary', accepted[0], null, 'Representative interval within single pose section');
  take('lane_change_metadata_section', accepted[0], null, 'Representative interval (lane-change metadata proxy)');
  take('repeated_pass_conflict_or_agreement', null, assessments[0], 'Representative count assessment for pass agreement proxy');
  take('stage16_stage17_coverage_outlier', accepted.find((iv) => (iv.sourceSegmentIds || []).some((s) => [57, 62, 65, 66, 96].includes(s))), null, 'Interval in Stage 16/17 coverage outlier segment');

  for (const cat of BEV_REQUIRED_CATEGORIES) {
    if (!picks.find((p) => p.category === cat)) {
      take(cat, null, null, `No matching example for category ${cat}`, { forceUnavailable: true });
    }
  }

  return picks;
}

function generateBevInspections(audit, intervals, assessments, runs, gaps, tracks, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const picks = pickCases(audit, intervals, assessments, runs, gaps, tracks);
  const manifest = [];

  for (const pick of picks) {
    const fname = `stage18_bev_${pick.category}.svg`;
    const title = pick.unavailable ? `${pick.category} — unavailable` : `${pick.category}`;
    const svg = pick.unavailable
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200"><rect width="100%" fill="#111"/><text x="20" y="40" fill="#ccc">${title}</text><text x="20" y="70" fill="#888">${pick.selectionRule}</text></svg>`
      : renderBevSvg(title, { runs: pick.runs, intervals: pick.interval ? [pick.interval] : [], gaps: pick.gaps }, { selectionRule: pick.selectionRule, countAssessment: pick.countAssessment });
    fs.writeFileSync(path.join(outputDir, fname), svg);
    manifest.push({
      category: pick.category,
      available: !pick.unavailable,
      selectionRule: pick.selectionRule,
      laneIntervalId: pick.interval?.laneIntervalId ?? null,
      countAssessmentId: pick.countAssessment?.countAssessmentId ?? null,
      leftDividerRunId: pick.interval?.leftDividerRunId ?? null,
      rightDividerRunId: pick.interval?.rightDividerRunId ?? null,
      supportingRunIds: pick.runs?.map((r) => r.dividerRunId) ?? [],
      gapIds: pick.gaps?.map((g) => g.gapId) ?? [],
      widthStats: pick.interval?.widthStats ?? null,
      countStatus: pick.countAssessment?.status ?? null,
      laneCountCandidate: pick.countAssessment?.laneCountCandidate ?? null,
      file: fname,
    });
  }

  fs.writeFileSync(path.join(outputDir, 'stage18_bev_manifest.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    requiredCategories: BEV_REQUIRED_CATEGORIES,
    artifacts: manifest,
  }, null, 2));
  return manifest;
}

module.exports = { generateBevInspections, pickCases, renderBevSvg };
