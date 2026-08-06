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

const files = fs.readdirSync(dir).filter(f => f.startsWith('qlog_f449c') && f.endsWith('.bz2')).sort();
console.log('Found ' + files.length + ' files\n');

let totalGPS = 0, totalGPSvalid = 0, totalModelV2 = 0, gpsValidFiles = 0;

for (const file of files) {
  const buf = fs.readFileSync(path.join(dir, file));
  const events = parseEvents(buf);
  if (events.length === 0) continue;

  const byType = {};
  for (const ev of events) byType[ev.type] = (byType[ev.type] || 0) + 1;

  const gpsCount = byType[21] || 0;
  const mvlCount = byType[75] || 0;
  totalGPS += gpsCount;
  totalModelV2 += mvlCount;

  // Check GPS for VALID coordinates near Malaysia
  let gpsValid = 0, gpsFix = 0, firstLat = 0, firstLon = 0, lastLat = 0, lastLon = 0;
  for (const ev of events) {
    if (ev.type !== 21) continue;
    const pl = buf.slice(ev.payloadStart, ev.payloadStart + Math.min(ev.payloadSize, 64));
    if (pl.length < 24) continue;
    const flags = pl.readUInt16LE(0);
    const lat = pl.readDoubleLE(8);
    const lon = pl.readDoubleLE(16);
    if (flags > 0) gpsFix++;
    if (flags > 0 && Math.abs(lat) > 0.001 && Math.abs(lon) > 0.001 && lat > -90 && lat < 90 && lon > -180 && lon < 180) {
      gpsValid++;
      if (firstLat === 0) { firstLat = lat; firstLon = lon; }
      lastLat = lat; lastLon = lon;
    }
  }
  if (gpsValid > 0) {
    gpsValidFiles++;
    totalGPSvalid += gpsValid;
  }

  // Check modelV2 non-zero data (past 32 bytes to skip header)
  let mvlNonZero = 0;
  for (const ev of events) {
    if (ev.type !== 75) continue;
    const pl = buf.slice(ev.payloadStart, ev.payloadStart + Math.min(ev.payloadSize, 80));
    for (let off = 32; off + 4 <= pl.length; off += 4) {
      const f = pl.readFloatLE(off);
      if (Math.abs(f) > 0.01 && Math.abs(f) < 1000) mvlNonZero++;
    }
  }

  const lastTs = events[events.length - 1].timestamp;
  const tsStr = lastTs > 0 ? (lastTs / 1e9).toFixed(0) + 's' : '?';
  const flagStr = gpsFix > 0 ? ' gpsFix=' + gpsFix : ' (flags=0)';
  const validStr = gpsValid > 0 ? ' *** VALID:' + gpsValid + ' GPS: lat=' + firstLat.toFixed(5) + ',' + firstLon.toFixed(5) + ' -> ' + lastLat.toFixed(5) + ',' + lastLon.toFixed(5) : '';
  const modelStr = mvlNonZero > 0 ? ' model=' + mvlNonZero : '';
  
  const typeSummary = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([t, c]) => EVENT_NAMES[t] + '=' + c).join(' | ');
  console.log(file + ': ' + events.length + ' ev @' + tsStr + ' ' + typeSummary + flagStr + validStr + modelStr);
}

console.log('\n=== FINAL ===');
console.log('Files scanned: ' + files.length);
console.log('Total gpsLocation: ' + totalGPS);
console.log('Valid GPS coordinates: ' + totalGPSvalid + ' (in ' + gpsValidFiles + ' files)');
console.log('Total modelV2: ' + totalModelV2);
if (totalGPSvalid > 0) console.log('>>> CAN DRAW GPS ROUTE <<<');
else console.log('>>> No valid GPS data <<<');
