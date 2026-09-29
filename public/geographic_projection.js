'use strict';
(function (global) {
  const DEG2RAD = Math.PI / 180;
  const M_PER_DEG_LAT = 110540;
  const M_PER_DEG_LON_AT_EQ = 111320;

  function localToLatLon(east, north, origin) {
    if (!origin || !Number.isFinite(east) || !Number.isFinite(north)) {
      return { latitude: null, longitude: null };
    }
    const cosLat0 = Math.cos(origin.lat * DEG2RAD);
    const lat = origin.lat + north / M_PER_DEG_LAT;
    const lon = origin.lon + east / (M_PER_DEG_LON_AT_EQ * cosLat0);
    return { latitude: lat, longitude: lon };
  }

  function canonicalLocalToLngLat(localEast, localNorth, referencePose, origin) {
    const SLM = global.SegmentLocalMap;
    if (!SLM?.segmentLocalToGlobal || !origin) {
      return { latitude: null, longitude: null };
    }
    if (!Number.isFinite(localEast) || !Number.isFinite(localNorth)) {
      return { latitude: null, longitude: null };
    }
    const g = SLM.segmentLocalToGlobal(localEast, localNorth, referencePose);
    return localToLatLon(g.east, g.north, origin);
  }

  function globalEnToLngLat(east, north, origin) {
    return localToLatLon(east, north, origin);
  }

  global.GeographicProjection = {
    localToLatLon,
    canonicalLocalToLngLat,
    globalEnToLngLat,
  };
})(typeof window !== 'undefined' ? window : global);
