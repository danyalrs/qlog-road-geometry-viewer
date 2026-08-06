/**
 * WGS-84 lat/lon to local east/north metres.
 * Uses equirectangular approximation (accurate for local road-scale routes).
 */

const DEG2RAD = Math.PI / 180;
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON_AT_EQ = 111320;

function latLonToLocal(lat, lon, origin) {
  const cosLat0 = Math.cos(origin.lat * DEG2RAD);
  const east = (lon - origin.lon) * M_PER_DEG_LON_AT_EQ * cosLat0;
  const north = (lat - origin.lat) * M_PER_DEG_LAT;
  return { east, north };
}

function localToLatLon(east, north, origin) {
  const cosLat0 = Math.cos(origin.lat * DEG2RAD);
  const lat = origin.lat + north / M_PER_DEG_LAT;
  const lon = origin.lon + east / (M_PER_DEG_LON_AT_EQ * cosLat0);
  return { latitude: lat, longitude: lon };
}

function setLocalCoords(records, origin) {
  for (const r of records) {
    const { east, north } = latLonToLocal(r.latitude, r.longitude, origin);
    r.east = east;
    r.north = north;
  }
  return records;
}

function trajectoryDistance(records) {
  let dist = 0;
  for (let i = 1; i < records.length; i++) {
    const a = records[i - 1];
    const b = records[i];
    if (!Number.isFinite(a.east) || !Number.isFinite(b.east)) continue;
    dist += Math.hypot(b.east - a.east, b.north - a.north);
  }
  return dist;
}

module.exports = {
  latLonToLocal,
  localToLatLon,
  setLocalCoords,
  trajectoryDistance,
};
