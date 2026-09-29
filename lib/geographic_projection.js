'use strict';

const { localToLatLon, latLonToLocal } = require('./projection');
const { segmentLocalToGlobal, globalToSegmentLocal } = require('./segment_local_map');

function canonicalLocalToGlobal(localEast, localNorth, referencePose) {
  if (!Number.isFinite(localEast) || !Number.isFinite(localNorth)) {
    return { east: null, north: null };
  }
  const g = segmentLocalToGlobal(localEast, localNorth, referencePose);
  return { east: g.east, north: g.north };
}

function canonicalLocalToLngLat(localEast, localNorth, referencePose, origin) {
  const g = canonicalLocalToGlobal(localEast, localNorth, referencePose);
  if (!Number.isFinite(g.east) || !Number.isFinite(g.north) || !origin) {
    return { longitude: null, latitude: null };
  }
  const ll = localToLatLon(g.east, g.north, origin);
  return { longitude: ll.longitude, latitude: ll.latitude };
}

function lngLatToCanonicalLocal(longitude, latitude, referencePose, origin) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || !origin) {
    return { localEast: null, localNorth: null };
  }
  const { east, north } = latLonToLocal(latitude, longitude, origin);
  const local = globalToSegmentLocal(east, north, referencePose);
  if (local && Number.isFinite(local.east) && Number.isFinite(local.north)) {
    return { localEast: local.east, localNorth: local.north };
  }
  return { localEast: null, localNorth: null };
}

function roundTripErrorM(localEast, localNorth, referencePose, origin) {
  const ll = canonicalLocalToLngLat(localEast, localNorth, referencePose, origin);
  if (!Number.isFinite(ll.longitude) || !Number.isFinite(ll.latitude)) return null;
  const back = lngLatToCanonicalLocal(ll.longitude, ll.latitude, referencePose, origin);
  if (!Number.isFinite(back.localEast) || !Number.isFinite(back.localNorth)) return null;
  const dE = back.localEast - localEast;
  const dN = back.localNorth - localNorth;
  return Math.hypot(dE, dN);
}

module.exports = {
  canonicalLocalToGlobal,
  canonicalLocalToLngLat,
  lngLatToCanonicalLocal,
  roundTripErrorM,
};
