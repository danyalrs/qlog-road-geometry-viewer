'use strict';
(function (global) {
  const GP = () => global.GeographicProjection;
  const SLM = () => global.SegmentLocalMap;

  function enToLngLat(east, north, origin) {
    return GP()?.globalEnToLngLat?.(east, north, origin)
      || { longitude: null, latitude: null };
  }

  function canonicalLocalToLngLat(localEast, localNorth, referencePose, origin) {
    return GP()?.canonicalLocalToLngLat?.(localEast, localNorth, referencePose, origin)
      || { longitude: null, latitude: null };
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
        } else continue;
        if (!Number.isFinite(ll.longitude) || !Number.isFinite(ll.latitude)) continue;
        coords.push([ll.longitude, ll.latitude]);
        pointFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [ll.longitude, ll.latitude] },
          properties: { index: i, source: 'trajectory', timelineIndex: t.timelineIndex ?? i },
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
      points: { type: 'FeatureCollection', features: pointFeatures },
    };
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
        if (!Number.isFinite(le) || !Number.isFinite(ln)) { missing += 1; continue; }
        const ll = canonicalLocalToLngLat(le, ln, referencePose, origin);
        if (!Number.isFinite(ll.longitude) || !Number.isFinite(ll.latitude)) { missing += 1; continue; }
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
        },
      });
    }
    return { type: 'FeatureCollection', features, stats: { converted, missing, lineCount: features.length } };
  }

  function buildObservationPointsGeoJson(points, referencePose, origin, options = {}) {
    const maxPoints = options.maxPoints || 8000;
    const features = [];
    let converted = 0;
    let missing = 0;
    const step = points?.length > maxPoints ? Math.ceil(points.length / maxPoints) : 1;
    for (let i = 0; i < (points || []).length; i += step) {
      const pt = points[i];
      if (!Number.isFinite(pt.localEast) || !Number.isFinite(pt.localNorth)) { missing += 1; continue; }
      const ll = canonicalLocalToLngLat(pt.localEast, pt.localNorth, referencePose, origin);
      if (!Number.isFinite(ll.longitude) || !Number.isFinite(ll.latitude)) { missing += 1; continue; }
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [ll.longitude, ll.latitude] },
        properties: { groupTrackId: pt.groupTrackId ?? null, laneIndex: pt.laneIndex ?? null },
      });
      converted += 1;
    }
    return { type: 'FeatureCollection', features, stats: { converted, missing } };
  }

  global.GeographicGeoJson = {
    buildGpsRouteGeoJson,
    buildVehiclePointGeoJson,
    buildRepresentativeLinesGeoJson,
    buildObservationPointsGeoJson,
  };
})(typeof window !== 'undefined' ? window : global);
