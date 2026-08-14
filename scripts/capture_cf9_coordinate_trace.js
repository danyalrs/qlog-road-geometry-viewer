'use strict';

const path = require('path');
const fs = require('fs');
const { processRoute, buildTimeline } = require('../lib/process_route');
const { enrichTimelineWithMovement } = require('../lib/vehicle_movement_display');
const SLM = require('../lib/segment_local_map');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'reports', 'fitted_layer_probe', 'cf9_coordinate_trace.json');

function dist(a, b) {
  return Math.hypot(a.east - b.east, a.north - b.north);
}

function screen(e, n, me, mn, mirror, refNorth) {
  const scale = 8;
  const w = 800;
  const h = 600;
  const offsetX = 0;
  const offsetY = 0;
  let ee = e;
  let nn = n;
  if (mirror) {
    if (me != null && mn != null) { ee = me; nn = mn; }
    else { nn = 2 * refNorth - n; }
  }
  return { x: w / 2 + offsetX + ee * scale, y: h / 2 + offsetY - nn * scale };
}

function main() {
  const seg = 'qlog_f449c_2.bz2';
  const segPath = path.join(ROOT, seg);
  const me = extractModel(segPath).map((e) => ({ ...e, sourceFile: seg }));
  const ge = extractGps(segPath).map((e) => ({ ...e, sourceFile: seg }));
  const data = processRoute(me, ge, { pipelineMode: 'C' });
  const timeline = enrichTimelineWithMovement(buildTimeline(data.frames), data.vehiclePath);
  const map = SLM.buildSegmentLocalMap(data, {
    geometrySource: 'pointAccumulated',
    timelineIndex: 0,
    fitEnabled: true,
  });
  const pa = map.pointAccumulated;
  const cf = pa.constructedFragments;
  const fp = pa.fittedPolylines;
  const cf9 = cf.fragments.find((f) => f.fragmentId === 'CF9');
  const fit9 = fp.results.find((r) => r.fragmentId === 'CF9');
  const rawIdx = cf.fragments.findIndex((f) => f.fragmentId === 'CF9');
  const rawRun = cf.runs[rawIdx];
  const poly = Array.isArray(fit9.fittedPolyline[0]) ? fit9.fittedPolyline[0] : fit9.fittedPolyline;
  const ref = map.referencePose;

  const indices = [0, Math.floor(rawRun.length / 4), Math.floor(rawRun.length / 2),
    Math.floor(3 * rawRun.length / 4), rawRun.length - 1];
  const trace = indices.map((i) => {
    const obs = rawRun[i];
    const fp = cf9.points[Math.min(i, cf9.points.length - 1)];
    const fitIdx = Math.min(Math.floor((i / Math.max(1, rawRun.length - 1)) * (poly.length - 1)), poly.length - 1);
    const fitPt = poly[fitIdx];
    return {
      i,
      observation: {
        globalEast: obs.east,
        globalNorth: obs.north,
        localEast: obs.localEast,
        localNorth: obs.localNorth,
        mirroredLocalEast: obs.mirroredLocalEast,
        mirroredLocalNorth: obs.mirroredLocalNorth,
        s: obs.s,
        d: obs.d,
        frameIndex: obs.frameIndex,
      },
      fragmentPoint: {
        east: fp.east,
        north: fp.north,
        mirroredEast: fp.mirroredEast,
        mirroredNorth: fp.mirroredNorth,
        mapDistToFit: dist(fp, fitPt),
      },
      fittedPoint: {
        east: fitPt.east,
        north: fitPt.north,
        mirroredEast: fitPt.mirroredEast ?? null,
        mirroredNorth: fitPt.mirroredNorth ?? null,
      },
      screen: {
        fitMirrorOff: screen(fitPt.east, fitPt.north, null, null, false),
        fitWrongMirrorFallback: screen(fitPt.east, fitPt.north, null, null, true, ref.north),
        fitCorrectMirror: screen(fitPt.east, fitPt.north, obs.mirroredLocalEast, obs.mirroredLocalNorth, true),
        fragmentMirror: screen(fp.east, fp.north, fp.mirroredEast, fp.mirroredNorth, true),
      },
    };
  });

  const report = {
    segment: seg,
    referencePose: ref,
    fitBounds: map.fitBounds,
    bounds: map.bounds,
    fitStatus: fit9.status,
    maxFragToFitDist: Math.max(...cf9.points.map((p) => {
      let best = Infinity;
      for (const v of poly) best = Math.min(best, dist(p, v));
      return best;
    })),
    endpoints: {
      fragment: [cf9.points[0], cf9.points[cf9.points.length - 1]],
      fitted: [poly[0], poly[poly.length - 1]],
    },
    trace,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main();
