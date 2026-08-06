const fs = require('fs');
const path = require('path');
const dir = 'C:\\Users\\danya\\OneDrive\\Documents\\Default Project';

const MARKER = Buffer.from([0x02, 0x00, 0x01, 0x00]);

const EVENT_NAMES = {
  1:'initData',2:'roadCameraState',5:'can',6:'deviceState',7:'controlsState',
  13:'radarState',16:'liveTracks',17:'sendcan',18:'logMessage',19:'liveCalibration',
  20:'androidLog',21:'gpsLocation',22:'carState',23:'carControl',24:'longitudinalPlan',
  33:'procLog',34:'ubloxGnss',48:'gpsLocationExternal',60:'boot',61:'liveParameters',
  63:'cameraOdometry',66:'thumbnail',68:'onroadEvents',69:'carParams',
  70:'driverCameraState',71:'driverMonitoringState',72:'liveLocationKalman',
  73:'sentinel',74:'wideRoadCameraState',75:'modelV2',76:'driverEncodeIdx',
  77:'wideRoadEncodeIdx',78:'managerState',79:'uploaderState',80:'peripheralState',
  81:'pandaStates',91:'gnssMeasurements',92:'driverStateV2',93:'liveTorqueParameters',
  94:'magnetometer',95:'lightSensor',96:'temperatureSensor',97:'accelerometer',
  98:'gyroscope',99:'gyroscope2',100:'accelerometer2',101:'temperatureSensor2',
  103:'microphone',104:'navModel',105:'mapRenderState',106:'uiPlan',
};

function parseEvents(buf) {
  const events = [];
  let pos = 0;
  while (pos < buf.length - MARKER.length) {
    const mi = buf.indexOf(MARKER, pos);
    if (mi === -1 || mi + 28 > buf.length) break;
    const ts = Number(buf.readBigUInt64LE(mi + 4));
    const type = buf.readUInt32LE(mi + 12);
    const payloadStart = mi + 24;
    const nextMarker = buf.indexOf(MARKER, payloadStart);
    const payloadSize = nextMarker !== -1 ? nextMarker - payloadStart : buf.length - payloadStart;
    if (ts > 0 && ts < 2e11 && type >= 0 && type <= 126) {
      events.push({ timestamp: ts, type, typeName: EVENT_NAMES[type] || 'unknown_' + type, payloadStart, payloadSize });
    }
    if (nextMarker !== -1) pos = nextMarker;
    else pos = mi + payloadSize + 24;
    if (pos <= mi) pos = mi + 1;
  }
  return events;
}

// GpsLocationData struct layout (from schema):
// Word 0: [flags:u16@0][source:u16@8][speed:float32@4] bytes 0-7
// Word 1: [latitude:float64@1] bytes 8-15
// Word 2: [longitude:float64@2] bytes 16-23
// Word 3: [altitude:float64@3] bytes 24-31
// Word 4: [bearingDeg:float32@5][horizontalAccuracy:float32@6] bytes 32-39
// Word 5: [unixTimestampMillis:int64@7] bytes 40-47
function decodeGps(pl) {
  if (pl.length < 48) return null;
  return {
    flags: pl.readUInt16LE(0),
    source: pl.readUInt16LE(2),
    speed: pl.readFloatLE(4),
    latitude: pl.readDoubleLE(8),
    longitude: pl.readDoubleLE(16),
    altitude: pl.readDoubleLE(24),
    bearingDeg: pl.readFloatLE(32),
    horizontalAccuracy: pl.readFloatLE(36),
    unixTimestampMillis: Number(pl.readBigInt64LE(40)),
  };
}

const files = fs.readdirSync(dir).filter(f => f.startsWith('qlog_f449c') && f.endsWith('.bz2')).sort();

let totalGPS = 0, totalGPSwithFix = 0, totalGPSwithValidCoord = 0;
let totalModelV2 = 0;
let modelFilesWithData = 0;
let gpsFileResults = [];

for (const file of files) {
  const buf = fs.readFileSync(path.join(dir, file));
  const events = parseEvents(buf);
  if (events.length === 0) continue;

  const gpsEvents = events.filter(e => e.type === 21);
  const mvlEvents = events.filter(e => e.type === 75);
  totalGPS += gpsEvents.length;
  totalModelV2 += mvlEvents.length;

  // ---- GPS ANALYSIS ----
  let gpsFix = 0, gpsValidCoord = 0, gpsNonZeroLat = 0;
  let gpsLats = [], gpsLons = [], gpsFlags = new Set();
  let gpsFirst = null, gpsLast = null;

  for (const ev of gpsEvents) {
    const pl = buf.slice(ev.payloadStart, ev.payloadStart + Math.min(ev.payloadSize, 64));
    const g = decodeGps(pl);
    if (!g) continue;
    gpsFlags.add(g.flags);
    if (g.flags > 0) gpsFix++;
    if (Math.abs(g.latitude) > 0.0001 || Math.abs(g.longitude) > 0.0001) gpsNonZeroLat++;
    if (g.flags > 0 && Math.abs(g.latitude) > 0.0001 && Math.abs(g.longitude) > 0.0001) {
      gpsValidCoord++;
      gpsLats.push(g.latitude);
      gpsLons.push(g.longitude);
      if (!gpsFirst) gpsFirst = { lat: g.latitude, lon: g.longitude, ts: ev.timestamp, alt: g.altitude, speed: g.speed, bearing: g.bearingDeg, acc: g.horizontalAccuracy };
      gpsLast = { lat: g.latitude, lon: g.longitude, ts: ev.timestamp, alt: g.altitude, speed: g.speed, bearing: g.bearingDeg, acc: g.horizontalAccuracy };
    }
  }
  if (gpsValidCoord > 0) totalGPSwithValidCoord += gpsValidCoord;
  if (gpsFix > 0) totalGPSwithFix += gpsFix;

  // ---- MODELV2 ANALYSIS ----
  let mvlFloatCount = 0, mvlFloats = [];
  for (const ev of mvlEvents) {
    const pl = buf.slice(ev.payloadStart, ev.payloadStart + Math.min(ev.payloadSize, 128));
    for (let off = 32; off + 4 <= pl.length; off += 4) {
      const f = pl.readFloatLE(off);
      if (Math.abs(f) > 0.01 && Math.abs(f) < 1000) {
        mvlFloatCount++;
        if (mvlFloats.length < 10) mvlFloats.push({off, val: f});
      }
    }
  }
  if (mvlFloatCount > 10) modelFilesWithData++;

  // ---- PRINTS ----
  const tsEnd = gpsEvents.length > 0 ? (gpsEvents[gpsEvents.length-1].timestamp / 1e9).toFixed(0) + 's' : '?';
  const evCount = events.length;

  // Only print detailed info for files with actual content
  if (evCount > 200) {
    console.log('=== ' + file + ' === ' + evCount + ' events, ends @' + tsEnd);
    console.log('  GPS ' + gpsEvents.length + ': flags=[' + [...gpsFlags].join(',') + '] fix=' + gpsFix + ' nonZero=' + gpsNonZeroLat + ' valid=' + gpsValidCoord);
    if (gpsFirst) {
      console.log('  First GPS: lat=' + gpsFirst.lat.toFixed(6) + ' lon=' + gpsFirst.lon.toFixed(6) + ' alt=' + gpsFirst.alt.toFixed(1) + ' speed=' + gpsFirst.speed.toFixed(2) + ' bearing=' + gpsFirst.bearing.toFixed(1) + ' acc=' + gpsFirst.acc.toFixed(1));
    }
    if (gpsLast && gpsLast !== gpsFirst) {
      console.log('  Last GPS:  lat=' + gpsLast.lat.toFixed(6) + ' lon=' + gpsLast.lon.toFixed(6) + ' alt=' + gpsLast.alt.toFixed(1) + ' speed=' + gpsLast.speed.toFixed(2) + ' bearing=' + gpsLast.bearing.toFixed(1) + ' acc=' + gpsLast.acc.toFixed(1));
      if (gpsLats.length > 1) {
        const dLat = Math.max(...gpsLats) - Math.min(...gpsLats);
        const dLon = Math.max(...gpsLons) - Math.min(...gpsLons);
        console.log('  GPS range: dLat=' + dLat.toFixed(6) + ' dLon=' + dLon.toFixed(6) + ' (' + (gpsLats.length) + ' changing points)');
      }
    }
    if (gpsFix > 0 && gpsNonZeroLat === 0) {
      console.log('  >>> flags > 0 but all lat/lon = 0 (no position fix)');
    }
    console.log('  ModelV2 ' + mvlEvents.length + ': nonZeroFloats=' + mvlFloatCount + (mvlFloats.length > 0 ? ' samples=' + mvlFloats.map(f => '@' + f.off + '=' + f.val.toFixed(4)).join(',') : ''));
    
    // Check other event types
    const byType = {};
    for (const ev of events) byType[ev.type] = (byType[ev.type] || 0) + 1;
    const others = Object.entries(byType).filter(([t]) => parseInt(t) !== 21 && parseInt(t) !== 75).sort((a,b) => b[1]-a[1]).slice(0, 8).map(([t,c]) => (EVENT_NAMES[t]||'unk_'+t)+'='+c).join(', ');
    console.log('  Other events: ' + others);
    console.log('');
  }
}

console.log('========================================');
console.log('TOTALS across ' + files.length + ' files:');
console.log('  gpsLocation events: ' + totalGPS + ' (' + totalGPSwithFix + ' with fix flag, ' + totalGPSwithValidCoord + ' with non-zero coordinates)');
console.log('  modelV2 events: ' + totalModelV2 + ' (in ' + modelFilesWithData + ' files with >10 non-zero floats)');
if (totalGPSwithValidCoord === 0) console.log('  >>> No valid GPS route data in any file <<<');
else console.log('  >>> VALID GPS DATA EXISTS <<<');
