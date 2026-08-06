/** Verify API returns pass-aware geometry for segments 2 and 6. */
const http = require('http');

const PORT = process.env.PORT || 3847;

function post(segments) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ segments, bustCache: true, options: { laneTrackingEnabled: true } });
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path: '/api/process',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  for (const file of ['qlog_f449c_2.bz2', 'qlog_f449c_6.bz2']) {
    const data = await post([file]);
    const g = data.geometryDebug;
    console.log(`\n=== API ${file} ===`);
    console.log('version:', data.processingVersion);
    console.log('processedAt:', data.processedAt);
    console.log('passCount:', g.passCount, 'polygonCount:', g.polygonCount);
    console.log('passIds:', g.passIds);
    console.log('polygons:', g.polygons);
    console.log('splitEvents:', g.splitEvents);
  }
}

main().catch((e) => {
  console.error('Start server first: node server.js');
  console.error(e.message);
  process.exit(1);
});
