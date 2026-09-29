'use strict';

const { localToLatLon } = require('./projection');
const { segmentLocalToGlobal } = require('./segment_local_map');

function enToLngLat(east, north, origin) {
  if (!origin || !Number.isFinite(east) || !Number.isFinite(north)) {
    return { longitude: null, latitude: null };
  }
  const ll = localToLatLon(east, north, origin);
  return { longitude: ll.longitude, latitude: ll.latitude };
}

function canonicalLocalToLngLat(localEast, localNorth, referencePose, origin) {
  if (!Number.isFinite(localEast) || !Number.isFinite(localNorth)) {
    return { longitude: null, latitude: null };
  }
  const g = segmentLocalToGlobal(localEast, localNorth, referencePose);
  return enToLngLat(g.east, g.north, origin);
}

function buildGpsRouteGeoJson({ origin, trajectory, gpsTrajectory, referencePose } = {}) {
  const coords = [];
  const pointFeatures = [];
  let source = 'none';
  if (Array.isArray(gpsTrajectory) && gpsTrajectory.length) {
    source = 'gpsTrajectory';
    for (let i = 0; i < gpsTrajectory.length; i++) {
      const p = gpsTrajectory[i];
      const lat = p.latitude ?? p.lat;
      const lon = p.longitude ?? p.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      coords.push([lon, lat]);
      pointFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { index: i, source: 'gpsTrajectory' },
      });
    }
  }
  if (!coords.length && Array.isArray(trajectory) && trajectory.length && origin) {
    source = referencePose ? 'trajectorySegmentLocal' : 'trajectoryGlobalEn';
    for (let i = 0; i < trajectory.length; i++) {
      const t = trajectory[i];
      let ll = { longitude: null, latitude: null };
      if (Number.isFinite(t.localEast) && Number.isFinite(t.localNorth)) {
        ll = canonicalLocalToLngLat(t.localEast, t.localNorth, referencePose, origin);
      } else if (Number.isFinite(t.east) && Number.isFinite(t.north) && referencePose) {
        ll = canonicalLocalToLngLat(t.east, t.north, referencePose, origin);
      } else if (Number.isFinite(t.east) && Number.isFinite(t.north)) {
        ll = enToLngLat(t.east, t.north, origin);
      } else {
        continue;
      }
      if (!Number.isFinite(ll.longitude) || !Number.isFinite(ll.latitude)) continue;
      coords.push([ll.longitude, ll.latitude]);
      pointFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [ll.longitude, ll.latitude] },
        properties: {
          index: i,
          source: 'trajectory',
          timelineIndex: t.timelineIndex ?? i,
          frameId: t.frameId ?? null,
        },
      });
    }
  }
  const line = coords.length >= 2 ? {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
    properties: { source },
  } : null;
  return {
    source,
    pointCount: coords.length,
    line,
    points: {
      type: 'FeatureCollection',
      features: pointFeatures,
    },
    bounds: boundsFromCoords(coords),
  };
}

function boundsFromCoords(coords) {
  if (!coords.length) return null;
  let minLon = coords[0][0];
  let maxLon = coords[0][0];
  let minLat = coords[0][1];
  let maxLat = coords[0][1];
  for (const c of coords) {
    minLon = Math.min(minLon, c[0]);
    maxLon = Math.max(maxLon, c[0]);
    minLat = Math.min(minLat, c[1]);
    maxLat = Math.max(maxLat, c[1]);
  }
  return { minLon, maxLon, minLat, maxLat };
}

function buildVehiclePointGeoJson({ east, north, origin, headingDeg = null } = {}) {
  const ll = enToLngLat(east, north, origin);
  if (!Number.isFinite(ll.longitude) || !Number.isFinite(ll.latitude)) {
    return { type: 'FeatureCollection', features: [] };
  }
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [ll.longitude, ll.latitude] },
      properties: { role: 'vehicle', headingDeg },
    }],
  };
}

function buildRepresentativeLinesGeoJson(polylines, referencePose, origin) {
  const features = [];
  let converted = 0;
  let missing = 0;
  for (const poly of polylines || []) {
    const coords = [];
    for (const pt of poly.points || []) {
      const le = pt.localEast;
      const ln = pt.localNorth;
      if (!Number.isFinite(le) || !Number.isFinite(ln)) {
        missing += 1;
        continue;
      }
      const ll = canonicalLocalToLngLat(le, ln, referencePose, origin);
      if (!Number.isFinite(ll.longitude) || !Number.isFinite(ll.latitude)) {
        missing += 1;
        continue;
      }
      coords.push([ll.longitude, ll.latitude]);
      converted += 1;
    }
    if (coords.length < 2) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {
        groupTrackId: poly.groupTrackId ?? null,
        laneIndex: poly.laneIndex ?? null,
        side: poly.side ?? null,
        colour: poly.colour ?? null,
      },
    });
  }
  return {
    type: 'FeatureCollection',
    features,
    stats: { converted, missing, lineCount: features.length },
  };
}

function buildObservationPointsGeoJson(points, referencePose, origin, { maxPoints = 8000 } = {}) {
  const features = [];
  let converted = 0;
  let missing = 0;
  const step = points?.length > maxPoints ? Math.ceil(points.length / maxPoints) : 1;
  for (let i = 0; i < (points || []).length; i += step) {
    const pt = points[i];
    const le = pt.localEast;
    const ln = pt.localNorth;
    if (!Number.isFinite(le) || !Number.isFinite(ln)) {
      missing += 1;
      continue;
    }
    const ll = canonicalLocalToLngLat(le, ln, referencePose, origin);
    if (!Number.isFinite(ll.longitude) || !Number.isFinite(ll.latitude)) {
      missing += 1;
      continue;
    }
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [ll.longitude, ll.latitude] },
      properties: {
        groupTrackId: pt.groupTrackId ?? null,
        laneIndex: pt.laneIndex ?? null,
        side: pt.side ?? null,
      },
    });
    converted += 1;
  }
  return {
    type: 'FeatureCollection',
    features,
    stats: { converted, missing },
  };
}

module.exports = {
  enToLngLat,
  canonicalLocalToLngLat,
  buildGpsRouteGeoJson,
  buildVehiclePointGeoJson,
  buildRepresentativeLinesGeoJson,
  buildObservationPointsGeoJson,
};
