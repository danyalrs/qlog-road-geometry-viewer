const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  scanQlogImagery,
  searchCameraFiles,
  auditImageryAcquisition,
  ENCODE_TYPE_NAMES,
} = require('../lib/stage12b_imagery_acquisition');

describe('Stage 12B imagery acquisition', () => {
  it('scans qlog for EncodeIndex references', () => {
    const sample = path.join(__dirname, '..', 'qlog_f449c_0.bz2');
    if (!fs.existsSync(sample)) return;
    const scan = scanQlogImagery(sample);
    assert.ok(scan.encodeIndexCount > 0, 'expected EncodeIndex events');
    assert.ok(scan.encodeTypes.length > 0);
    assert.ok(scan.initData?.version);
    assert.equal(scan.cameraStateWithEmbeddedPixels, 0);
  });

  it('reports blocked when no external camera files found', () => {
    const sample = path.join(__dirname, '..', 'qlog_f449c_0.bz2');
    if (!fs.existsSync(sample)) return;
    const audit = auditImageryAcquisition(sample, { searchRoots: [path.join(__dirname, '..', '.empty_dir')] });
    assert.equal(audit.status, 'blocked');
    assert.ok(audit.missingInputs.length > 0);
    assert.ok(audit.missingInputs.some((m) => m.includes('HEVC') || m.includes('camera')));
  });

  it('encode type names are defined', () => {
    assert.ok(ENCODE_TYPE_NAMES[1] === 'FULL_HEVC');
  });

  it('searchCameraFiles returns missing expected names when absent', () => {
    const result = searchCameraFiles([path.join(__dirname, '..')]);
    assert.ok(Array.isArray(result.missing));
    assert.ok(result.missing.includes('fcamera.hevc'));
  });
});
