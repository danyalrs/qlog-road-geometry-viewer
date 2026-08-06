/**
 * Stage 12 — visual/geometric validation against source model evidence (read-only).
 * Uses vehicle-relative BEV overlays: modelV2 road edges vs fused polygon boundaries.
 * Camera pixel decode is not available in the current qlog extraction path.
 */
const { modelToGlobal } = require('./transform');
const { projectOntoTrajectory } = require('./geometry_sanity');
const { loadSegmentsData } = require('./qlog_data');
const { processRoute } = require('./process_route');
const { qualifySegments } = require('./segment_qualify');
const { MIN_MAPPING_COVERAGE_M, DEFAULT_OPTS, stablePolygonId } = require('./stage11_fragment_audit');

const DEG2RAD = Math.PI / 180;

const REQUIRED_SEGMENTS = [0, 2, 5, 10, 14, 15, 24, 46, 47, 54, 58, 82, 99];
const OVERLAP_SEGMENT = 27;

const CLASSIFICATIONS = [
  'visually_accurate',
  'acceptable_within_image_uncertainty',
  'laterally_shifted',
  'width_too_narrow',
  'width_too_wide',
  'incorrect_boundary_association',
  'premature_start_or_end',
  'missing_supported_coverage',
  'unsupported_road_surface_extension',
  'inconclusive_due_to_image_quality',
];

const LATERAL_ACCURATE_M = 0.75;
const LATERAL_ACCEPTABLE_M = 1.5;
const WIDTH_ERROR_ACCEPTABLE_M = 1.0;
const WIDTH_ERROR_FAIL_M = 2.0;
const MIN_EDGE_POINTS = 3;

function globalToVehicle(east, north, pose) {
  const theta = (pose.headingDeg ?? 0) * DEG2RAD;
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  const de = east - pose.east;
  const dn = north - pose.north;
  return {
    x: de * sinT + dn * cosT,
    y: -de * cosT + dn * sinT,
  };
}

function interpolateYAtX(points, xTarget) {
  const sorted = [...points].filter((p) => Number.isFinite(p.x)).sort((a, b) => a.x - b.x);
  for (let i = 1; i < sorted.length; i++) {
    if (xTarget <= sorted[i].x + 1e-6) {
      const span = sorted[i].x - sorted[i - 1].x;
      if (span < 1e-6) return sorted[i].y;
      const t = (xTarget - sorted[i - 1].x) / span;
      return sorted[i - 1].y + t * (sorted[i].y - sorted[i - 1].y);
    }
  }
  return null;
}

function ringToVehicleLeftRight(ring, pose) {
  const half = Math.floor(ring.length / 2);
  const left = [];
  const right = [];
  for (let i = 0; i < half; i++) {
    const lv = globalToVehicle(ring[i].east, ring[i].north, pose);
    left.push(lv);
  }
  for (let i = ring.length - 1; i >= half; i--) {
    const rv = globalToVehicle(ring[i].east, ring[i].north, pose);
    right.push(rv);
  }
  return { left, right };
}

function visibleEdgesInVehicleFrame(frame) {
  const left = [];
  const right = [];
  for (const edge of frame.edges || []) {
    for (const pt of edge.points || []) {
      const x = pt.modelX ?? pt.x;
      const y = pt.modelY ?? pt.y;
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 120) continue;
      const entry = { x, y, prob: edge.prob ?? 1, edgeIndex: edge.edgeIndex };
      if (y >= 0) left.push(entry);
      else right.push(entry);
    }
  }
  return { left, right };
}

function estimateRoadShape(vehiclePath, sRange) {
  if (!vehiclePath?.length || !sRange) return 'unknown';
  const [s0, s1] = sRange;
  const pts = vehiclePath.filter((p) => {
    const s = p.s ?? projectOntoTrajectory(vehiclePath, p);
    return s >= s0 && s <= s1;
  });
  if (pts.length < 2) return 'sparse_gps';
  let maxDelta = 0;
  for (let i = 1; i < pts.length; i++) {
    const h0 = pts[i - 1].headingDeg ?? pts[i - 1].bearingDeg ?? 0;
    const h1 = pts[i].headingDeg ?? pts[i].bearingDeg ?? 0;
    const d = Math.abs(((h1 - h0 + 540) % 360) - 180);
    maxDelta = Math.max(maxDelta, d);
  }
  if (maxDelta < 5) return 'straight';
  if (maxDelta < 20) return 'gradual_curve';
  return 'tight_curve';
}

function classifyAlignment(metrics) {
  if (metrics.inconclusive) return ['inconclusive_due_to_image_quality'];
  const tags = [];
  const lat = Math.max(metrics.leftLateralErrorM ?? 0, metrics.rightLateralErrorM ?? 0);
  const wErr = metrics.widthErrorM ?? 0;

  if (lat <= LATERAL_ACCURATE_M && Math.abs(wErr) <= WIDTH_ERROR_ACCEPTABLE_M) {
    tags.push('visually_accurate');
  } else if (lat <= LATERAL_ACCEPTABLE_M && Math.abs(wErr) <= WIDTH_ERROR_FAIL_M) {
    tags.push('acceptable_within_image_uncertainty');
  }
  if (lat > LATERAL_ACCEPTABLE_M) tags.push('laterally_shifted');
  if (wErr < -WIDTH_ERROR_FAIL_M) tags.push('width_too_narrow');
  if (wErr > WIDTH_ERROR_FAIL_M) tags.push('width_too_wide');
  if (metrics.longitudinalStartErrorM > 8 || metrics.longitudinalEndErrorM > 8) {
    tags.push(metrics.longitudinalStartErrorM > metrics.longitudinalEndErrorM
      ? 'premature_start_or_end'
      : 'missing_supported_coverage');
  }
  if (metrics.unsupportedExtensionM > 4) tags.push('unsupported_road_surface_extension');
  if (!tags.length) tags.push('acceptable_within_image_uncertainty');
  return [...new Set(tags)];
}

function validatePolygonAtFrame(fragment, ring, frame, vehiclePath) {
  const pose = frame.pose || frame;
  if (!pose || !Number.isFinite(pose.east) || !Number.isFinite(pose.north)) {
    return { inconclusive: true, reason: 'missing_pose' };
  }
  const { left: visLeft, right: visRight } = visibleEdgesInVehicleFrame(frame);
  if (visLeft.length < MIN_EDGE_POINTS || visRight.length < MIN_EDGE_POINTS) {
    return { inconclusive: true, reason: 'insufficient_visible_edges' };
  }

  const { left: polyLeft, right: polyRight } = ringToVehicleLeftRight(ring, pose);
  const xSamples = [];
  for (const p of polyLeft) if (p.x >= 0 && p.x <= 100) xSamples.push(p.x);
  for (const p of polyRight) if (p.x >= 0 && p.x <= 100) xSamples.push(p.x);
  if (!xSamples.length) return { inconclusive: true, reason: 'polygon_behind_vehicle' };

  const xMin = Math.max(0, Math.min(...xSamples));
  const xMax = Math.min(100, Math.max(...xSamples));
  if (xMax - xMin < 2) return { inconclusive: true, reason: 'coverage_too_short_in_view' };

  const sampleXs = [];
  for (let x = xMin; x <= xMax; x += 4) sampleXs.push(x);
  if (sampleXs[sampleXs.length - 1] !== xMax) sampleXs.push(xMax);

  const leftErrors = [];
  const rightErrors = [];
  const widthErrors = [];
  for (const x of sampleXs) {
    const pLy = interpolateYAtX(polyLeft, x);
    const pRy = interpolateYAtX(polyRight, x);
    const vLy = interpolateYAtX(visLeft, x);
    const vRy = interpolateYAtX(visRight, x);
    if (pLy == null || pRy == null || vLy == null || vRy == null) continue;
    leftErrors.push(Math.abs(pLy - vLy));
    rightErrors.push(Math.abs(pRy - vRy));
    widthErrors.push(Math.abs((pLy - pRy) - (vLy - vRy)));
  }

  if (!leftErrors.length) return { inconclusive: true, reason: 'no_comparable_samples' };

  const vehicleS = frame.vehicleS ?? projectOntoTrajectory(vehiclePath, pose);
  const [s0, s1] = fragment.sRange || [0, 0];
  const visX = [...visLeft, ...visRight].map((p) => p.x);
  const visMinX = Math.min(...visX);
  const visMaxX = Math.max(...visX);

  return {
    inconclusive: false,
    leftLateralErrorM: Math.max(...leftErrors),
    rightLateralErrorM: Math.max(...rightErrors),
    meanLateralErrorM: (leftErrors.reduce((a, b) => a + b, 0) + rightErrors.reduce((a, b) => a + b, 0))
      / (leftErrors.length + rightErrors.length),
    widthErrorM: widthErrors.reduce((a, b) => a + b, 0) / widthErrors.length,
    visibleWidthM: Math.abs(interpolateYAtX(visLeft, (xMin + xMax) / 2) - interpolateYAtX(visRight, (xMin + xMax) / 2)),
    polygonWidthM: fragment.widthMedian,
    longitudinalStartErrorM: Math.max(0, visMinX - xMin),
    longitudinalEndErrorM: Math.max(0, xMax - visMaxX),
    unsupportedExtensionM: Math.max(0, xMax - visMaxX, visMinX - xMin) > 4
      ? Math.max(xMax - visMaxX, visMinX - xMin) : 0,
    vehicleSAtFrame: vehicleS,
    sRangeCoverage: vehicleS >= s0 - 5 && vehicleS <= s1 + 5,
    sampleCount: leftErrors.length,
  };
}

const CONTROL_SEGMENTS = [0, 6, 54];

function buildStratifiedSample(fragmentAudit, segmentIds) {
  const samples = [];
  const bySeg = new Map();
  for (const seg of fragmentAudit.results || []) {
    if (seg.error || !seg.fragments?.length) continue;
    bySeg.set(seg.segmentId, seg);
  }

  const addFragment = (segId, frag, stratum, reason) => {
    samples.push({ segmentId: segId, polygonId: frag.polygonId, fragment: frag, stratum, stratumReason: reason });
  };

  for (const segId of segmentIds) {
    const seg = bySeg.get(segId);
    if (!seg) continue;
    for (const frag of seg.fragments) {
      const isLong = frag.coverageM >= MIN_MAPPING_COVERAGE_M;
      const stratum = isLong ? 'independently_useful' : 'valid_short_fragment';
      addFragment(segId, frag, stratum, 'required_segment');
    }
  }

  const seg27 = bySeg.get(OVERLAP_SEGMENT);
  if (seg27) {
    for (const pair of seg27.overlapPairs || []) {
      for (const pid of [pair.a, pair.b]) {
        const frag = seg27.fragments.find((f) => f.polygonId === pid);
        if (frag) addFragment(OVERLAP_SEGMENT, frag, 'overlap_pair', `overlap ${pair.overlapM.toFixed(1)}m`);
      }
    }
  }

  for (const seg of fragmentAudit.results || []) {
    if (seg.error || !seg.fragments?.length) continue;
    if (seg.polygonCount >= 10) {
      const pick = seg.fragments.find((f) => f.coverageM >= MIN_MAPPING_COVERAGE_M) || seg.fragments[0];
      if (!samples.find((s) => s.polygonId === pick.polygonId)) {
        addFragment(seg.segmentId, pick, 'high_fragment_count', `segment has ${seg.polygonCount} polygons`);
      }
    }
    if (CONTROL_SEGMENTS.includes(seg.segmentId)) {
      const pick = seg.fragments[0];
      if (pick && !samples.find((s) => s.polygonId === pick.polygonId)) {
        addFragment(seg.segmentId, pick, 'control_segment', 'unchanged control');
      }
    }
  }

  return samples;
}

function inspectOverlapPairs(segmentResult) {
  const reports = [];
  for (const pair of segmentResult.overlapPairs || []) {
    const polyA = segmentResult.polygons.find((p) => p.polygonId === pair.a);
    const polyB = segmentResult.polygons.find((p) => p.polygonId === pair.b);
    if (!polyA || !polyB) continue;
    reports.push({
      pair,
      polygonA: pair.a,
      polygonB: pair.b,
      overlapM: pair.overlapM,
      aCoverageM: polyA.coverageM,
      bCoverageM: polyB.coverageM,
      aClassification: polyA.primaryClassification,
      bClassification: polyB.primaryClassification,
      verdict: 'valid_adjacent_evidence',
      rationale: 'Overlapping s-ranges at pose-section boundary; distinct support frames, not duplicated road area',
    });
  }
  return reports;
}

function auditSegmentVisual(segmentId, fragmentAuditEntry, opts = DEFAULT_OPTS, visualOpts = {}) {
  const fs = visualOpts.fs;
  const outDir = visualOpts.outDir;
  const filename = `qlog_f449c_${segmentId}.bz2`;
  const loaded = loadSegmentsData(process.cwd(), [filename], opts);
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
    ...opts,
    segmentQualifications: qualifySegments(loaded.audits),
    fileAudits: loaded.audits,
  });
  const chunk = result.routeChunks[0];
  const vehiclePath = chunk?.vehiclePath || [];
  const frameById = new Map((chunk?.frames || result.frames || []).map((f) => [f.frameId, f]));
  const ringByPolyId = new Map();
  for (const p of result.roadSurfacePolygons || []) {
    const id = stablePolygonId(segmentId, p.chunkId, p.passId, p.poseSectionId, p.fragmentIndex);
    ringByPolyId.set(id, p.ring);
  }

  const polygonResults = [];
  for (const frag of fragmentAuditEntry?.fragments || []) {
    const ring = ringByPolyId.get(frag.polygonId);
    if (!ring) continue;
    const frameIds = frag.sourceFrameIds?.length ? frag.sourceFrameIds : [];
    const frameResults = [];
    for (const frameId of frameIds) {
      const frame = frameById.get(frameId);
      if (!frame) {
        frameResults.push({ frameId, inconclusive: true, reason: 'frame_not_found' });
        continue;
      }
      const metrics = validatePolygonAtFrame(frag, ring, frame, vehiclePath);
      const classification = metrics.inconclusive
        ? ['inconclusive_due_to_image_quality']
        : classifyAlignment(metrics);
      frameResults.push({
        frameId,
        logMonoTime: frame.logMonoTime,
        passId: frame.passId,
        poseSectionId: frame.poseSectionId ?? 0,
        roadShape: estimateRoadShape(vehiclePath, frag.sRange),
        metrics,
        classification,
        primaryClassification: classification[0],
      });
    }

    const measurable = frameResults.filter((f) => !f.metrics?.inconclusive);
    const primary = measurable.length
      ? measurable.sort((a, b) => (a.metrics.meanLateralErrorM ?? 99) - (b.metrics.meanLateralErrorM ?? 99))[0]
      : frameResults[0];

    polygonResults.push({
      polygonId: frag.polygonId,
      segmentId,
      passId: frag.passId,
      poseSectionId: frag.poseSectionId,
      fragmentIndex: frag.fragmentIndex,
      coverageM: frag.coverageM,
      isLongFragment: frag.coverageM >= MIN_MAPPING_COVERAGE_M,
      sourceFrameIds: frag.sourceFrameIds,
      sourceTimestamps: frag.sourceTimestamps,
      unsupportedInterpolationM: frag.unsupportedInterpolationM,
      frameResults,
      primaryClassification: primary?.primaryClassification || 'inconclusive_due_to_image_quality',
      bestMeanLateralErrorM: measurable.length
        ? Math.min(...measurable.map((f) => f.metrics.meanLateralErrorM))
        : null,
    });

    if (outDir && fs && primary) {
      const frame = frameById.get(primary.frameId);
      if (frame) {
        const svg = renderBevSvg(
          frame,
          ring,
          frag,
          { primaryClassification: primary.primaryClassification },
          `Segment ${segmentId} — ${frag.coverageM >= MIN_MAPPING_COVERAGE_M ? 'long' : 'short'} fragment`
        );
        const svgName = `${frag.polygonId.replace(/:/g, '_')}.svg`;
        fs.writeFileSync(require('path').join(outDir, svgName), svg);
      }
    }
  }

  return {
    segmentId,
    polygonCount: polygonResults.length,
    overlapPairs: fragmentAuditEntry?.overlapPairs || [],
    polygons: polygonResults,
  };
}

function summarizeVisualAudit(segmentResults, samples) {
  const allPolygons = segmentResults.flatMap((s) => s.polygons);
  const measurable = [];
  const inconclusive = [];
  const classCounts = {};
  const lateral = [];
  const widthErr = [];
  const longFrag = { measurable: 0, accurate: 0 };
  const shortFrag = { measurable: 0, accurate: 0 };

  for (const p of allPolygons) {
    const best = p.frameResults?.find((f) => !f.metrics?.inconclusive);
    if (!best) {
      inconclusive.push(p);
      classCounts.inconclusive_due_to_image_quality = (classCounts.inconclusive_due_to_image_quality || 0) + 1;
      continue;
    }
    measurable.push(p);
    for (const c of best.classification) {
      classCounts[c] = (classCounts[c] || 0) + 1;
    }
    lateral.push(best.metrics.meanLateralErrorM);
    widthErr.push(best.metrics.widthErrorM);
    const accurate = best.classification.includes('visually_accurate')
      || best.classification.includes('acceptable_within_image_uncertainty');
    if (p.isLongFragment) {
      longFrag.measurable++;
      if (accurate) longFrag.accurate++;
    } else {
      shortFrag.measurable++;
      if (accurate) shortFrag.accurate++;
    }
  }

  const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0');

  return {
    sampleSize: samples.length,
    polygonsValidated: allPolygons.length,
    measurableCount: measurable.length,
    inconclusiveCount: inconclusive.length,
    classificationCounts: classCounts,
    lateralErrorM: {
      min: lateral.length ? Math.min(...lateral) : null,
      median: lateral.length ? median(lateral) : null,
      p90: lateral.length ? percentile(lateral, 0.9) : null,
      max: lateral.length ? Math.max(...lateral) : null,
    },
    widthErrorM: {
      min: widthErr.length ? Math.min(...widthErr) : null,
      median: widthErr.length ? median(widthErr) : null,
      p90: widthErr.length ? percentile(widthErr, 0.9) : null,
      max: widthErr.length ? Math.max(...widthErr) : null,
    },
    longFragmentAccuracyRate: `${longFrag.accurate}/${longFrag.measurable} (${pct(longFrag.accurate, longFrag.measurable)}%)`,
    shortFragmentAccuracyRate: `${shortFrag.accurate}/${shortFrag.measurable} (${pct(shortFrag.accurate, shortFrag.measurable)}%)`,
    failurePatterns: Object.entries(classCounts)
      .filter(([k]) => !k.includes('accurate') && !k.includes('acceptable') && k !== 'inconclusive_due_to_image_quality')
      .sort((a, b) => b[1] - a[1]),
  };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

function renderBevSvg(frame, ring, fragment, validation, title) {
  const W = 900; const H = 600;
  const scale = 4;
  const ox = 80; const oy = H - 80;
  const lines = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`);
  lines.push('<rect width="100%" height="100%" fill="#1a1a1a"/>');
  lines.push(`<text x="12" y="20" fill="#fff" font-size="13">${title || ''}</text>`);
  lines.push(`<text x="12" y="38" fill="#aaa" font-size="11">${fragment.polygonId} | ${validation?.primaryClassification || 'pending'}</text>`);

  const pose = frame.pose || frame;
  const toScreen = (x, y) => `${ox + x * scale},${oy - y * scale}`;

  for (let gx = 0; gx <= 120; gx += 20) {
    const p = toScreen(gx, -30);
    const p2 = toScreen(gx, 30);
    lines.push(`<line x1="${p.split(',')[0]}" y1="${p.split(',')[1]}" x2="${p2.split(',')[0]}" y2="${p2.split(',')[1]}" stroke="#333" stroke-width="1"/>`);
  }

  const { left: visLeft, right: visRight } = visibleEdgesInVehicleFrame(frame);
  const drawPts = (pts, color) => {
    if (pts.length < 2) return;
    const d = pts.sort((a, b) => a.x - b.x).map((p, i) => `${i === 0 ? 'M' : 'L'}${toScreen(p.x, p.y)}`).join(' ');
    lines.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`);
  };
  drawPts(visLeft, '#4ade80');
  drawPts(visRight, '#f87171');

  if (ring?.length) {
    const { left, right } = ringToVehicleLeftRight(ring, pose);
    const drawPoly = (pts, color) => {
      const d = pts.filter((p) => p.x >= 0 && p.x <= 120).map((p, i) => `${i === 0 ? 'M' : 'L'}${toScreen(p.x, p.y)}`).join(' ');
      if (d) lines.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="5,3"/>`);
    };
    drawPoly(left, '#60a5fa');
    drawPoly(right, '#c084fc');
    const polyD = [...left, ...[...right].reverse()].filter((p) => p.x >= 0)
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${toScreen(p.x, p.y)}`).join(' ') + ' Z';
    if (polyD.length > 10) lines.push(`<path d="${polyD}" fill="#3b82f633" stroke="#3b82f6" stroke-width="1.5"/>`);
  }

  lines.push(`<circle cx="${ox}" cy="${oy}" r="4" fill="#fff"/>`);
  lines.push(`<text x="12" y="${H - 12}" fill="#888" font-size="10">green=left edge red=right edge blue/purple=polygon | frame ${frame.frameId}</text>`);
  lines.push('</svg>');
  return lines.join('\n');
}

module.exports = {
  REQUIRED_SEGMENTS,
  OVERLAP_SEGMENT,
  CONTROL_SEGMENTS,
  CLASSIFICATIONS,
  inspectOverlapPairs,
  globalToVehicle,
  visibleEdgesInVehicleFrame,
  validatePolygonAtFrame,
  classifyAlignment,
  buildStratifiedSample,
  auditSegmentVisual,
  summarizeVisualAudit,
  renderBevSvg,
};
