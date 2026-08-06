#!/usr/bin/env node
/**
 * Stage 11 visual inspection — SVG overlays per segment.
 * Usage: node stage11_visual_inspection.js [--segments 2,10,46] [--out-dir audit_stage11_visual]
 */
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_OPTS,
  REPRESENTATIVE_SEGMENTS,
  CONTROL_SEGMENTS,
  auditSegmentFragments,
  loadV10PolygonCounts,
} = require('./lib/stage11_fragment_audit');
const { loadSegmentsData } = require('./lib/qlog_data');
const { processRoute } = require('./lib/process_route');
const { qualifySegments } = require('./lib/segment_qualify');

const ROOT = __dirname;
const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4',
  '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9A6324',
  '#800000', '#aaffc3', '#808000', '#ffd8b1', '#000075', '#a9a9a9',
];

function parseArgs() {
  const args = process.argv.slice(2);
  let segments = null;
  let outDir = path.join(ROOT, 'audit_stage11_visual');
  let allHigh = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--segments' && args[i + 1]) {
      segments = args[++i].split(',').map((n) => parseInt(n.trim(), 10));
    } else if (args[i] === '--out-dir' && args[i + 1]) outDir = args[++i];
    else if (args[i] === '--all-high') allHigh = true;
  }
  return { segments, outDir, allHigh };
}

function boundsOf(points) {
  let minE = Infinity; let maxE = -Infinity; let minN = Infinity; let maxN = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.east) || !Number.isFinite(p.north)) continue;
    minE = Math.min(minE, p.east); maxE = Math.max(maxE, p.east);
    minN = Math.min(minN, p.north); maxN = Math.max(maxN, p.north);
  }
  const pad = 15;
  return { minE: minE - pad, maxE: maxE + pad, minN: minN - pad, maxN: maxN + pad };
}

function toSvg(x, y, b, width, height) {
  const sx = ((x - b.minE) / (b.maxE - b.minE || 1)) * width;
  const sy = height - ((y - b.minN) / (b.maxN - b.minN || 1)) * height;
  return [sx, sy];
}

function renderSegmentSvg(segmentId, audit, vehiclePath, polygons) {
  const pts = [];
  for (const p of vehiclePath || []) pts.push({ east: p.east, north: p.north });
  for (const poly of polygons || []) {
    for (const pt of poly.ring || []) pts.push({ east: pt.east, north: pt.north });
  }
  const b = boundsOf(pts);
  const W = 1200; const H = 800;
  const lines = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  lines.push(`<rect width="100%" height="100%" fill="#111"/>`);
  lines.push(`<text x="12" y="24" fill="#fff" font-size="14">Segment ${segmentId} — ${audit.polygonCount} polygons (v10 ${audit.v10PolygonCount ?? '?'})</text>`);

  if (vehiclePath?.length >= 2) {
    const pathD = vehiclePath.map((p, i) => {
      const [x, y] = toSvg(p.east, p.north, b, W, H);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    lines.push(`<path d="${pathD}" fill="none" stroke="#888" stroke-width="1.5" stroke-dasharray="4,3"/>`);
  }

  const sorted = [...(audit.fragments || [])].sort((a, c) => (a.sRange?.[0] ?? 0) - (c.sRange?.[0] ?? 0));
  for (let i = 0; i < sorted.length; i++) {
    const frag = sorted[i];
    const poly = polygons.find((p) => p.fragmentIndex === frag.fragmentIndex && p.passId === frag.passId);
    const ring = poly?.ring || [];
    if (ring.length < 3) continue;
    const color = PALETTE[i % PALETTE.length];
    const d = ring.map((pt, j) => {
      const [x, y] = toSvg(pt.east, pt.north, b, W, H);
      return `${j === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ') + ' Z';
    lines.push(`<path d="${d}" fill="${color}55" stroke="${color}" stroke-width="1.2"/>`);
    const [lx, ly] = toSvg(ring[0].east, ring[0].north, b, W, H);
    lines.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" fill="${color}" font-size="10">f${frag.fragmentIndex}</text>`);

    if (frag.gapToNextAlongTrackM != null && frag.gapToNextAlongTrackM > 4) {
      const next = sorted[i + 1];
      if (next && ring.length) {
        const end = ring[Math.floor(ring.length / 2) - 1] || ring[0];
        const nPoly = polygons.find((p) => p.fragmentIndex === next.fragmentIndex);
        const nStart = nPoly?.ring?.[0];
        if (nStart) {
          const [x1, y1] = toSvg(end.east, end.north, b, W, H);
          const [x2, y2] = toSvg(nStart.east, nStart.north, b, W, H);
          lines.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#ff0" stroke-width="2" stroke-dasharray="6,4"/>`);
          lines.push(`<text x="${((x1 + x2) / 2).toFixed(1)}" y="${((y1 + y2) / 2).toFixed(1)}" fill="#ff0" font-size="9">gap ${frag.gapToNextAlongTrackM.toFixed(1)}m</text>`);
        }
      }
    }
  }

  lines.push('</svg>');
  return lines.join('\n');
}

function main() {
  const { segments: argSegs, outDir, allHigh } = parseArgs();
  const v10 = loadV10PolygonCounts();
  let segments = argSegs;
  if (!segments) {
    segments = [...new Set([...REPRESENTATIVE_SEGMENTS, ...CONTROL_SEGMENTS])];
    if (allHigh) {
      const auditPath = path.join(ROOT, 'audit_stage11_fragments_v11.json');
      if (fs.existsSync(auditPath)) {
        const data = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
        segments.push(...(data.segmentsWithAtLeast10Polygons || []));
      }
    }
    segments = [...new Set(segments)].sort((a, b) => a - b);
  }

  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Rendering ${segments.length} segment SVG(s) → ${outDir}`);

  for (const seg of segments) {
    const audit = auditSegmentFragments(seg, DEFAULT_OPTS, v10.get(seg) ?? null);
    const filename = `qlog_f449c_${seg}.bz2`;
    const loaded = loadSegmentsData(ROOT, [filename], DEFAULT_OPTS);
    const result = processRoute(loaded.modelEvents, loaded.gpsEvents, {
      ...DEFAULT_OPTS,
      segmentQualifications: qualifySegments(loaded.audits),
      fileAudits: loaded.audits,
    });
    const chunk = result.routeChunks[0];
    const svg = renderSegmentSvg(seg, audit, chunk?.vehiclePath, result.roadSurfacePolygons);
    const outPath = path.join(outDir, `segment_${seg}_fragments.svg`);
    fs.writeFileSync(outPath, svg);
    console.log(`  seg ${seg} → ${outPath}`);
  }
}

if (require.main === module) main();

module.exports = { renderSegmentSvg, main };
