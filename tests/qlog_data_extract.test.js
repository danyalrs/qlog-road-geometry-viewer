const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { loadSegmentsData, clearParseCache } = require('../lib/qlog_data');
const { loadJsonExtract } = require('../lib/json_extract');
const { auditSegment } = require('../dataset_audit');

const ROOT = path.join(__dirname, '..');
const LEGACY_MODEL = path.join(ROOT, 'modelV2_extracted.json');

function withLegacyModel(content, fn) {
  const hadFile = fs.existsSync(LEGACY_MODEL);
  const backup = hadFile ? fs.readFileSync(LEGACY_MODEL) : null;
  try {
    if (content === null) {
      if (hadFile) fs.unlinkSync(LEGACY_MODEL);
    } else {
      fs.writeFileSync(LEGACY_MODEL, content);
    }
    clearParseCache();
    return fn();
  } finally {
    clearParseCache();
    if (backup) fs.writeFileSync(LEGACY_MODEL, backup);
    else if (fs.existsSync(LEGACY_MODEL)) fs.unlinkSync(LEGACY_MODEL);
  }
}

describe('legacy JSON extract tolerance', () => {
  it('loadJsonExtract reports malformed JSON without throwing', () => {
    const tmp = path.join(ROOT, '.tmp_malformed_test.json');
    fs.writeFileSync(tmp, '{ broken');
    const r = loadJsonExtract(tmp);
    assert.equal(r.status, 'malformed');
    assert.ok(r.error);
    fs.unlinkSync(tmp);
  });

  it('loadSegmentsData continues with live bz2 when legacy extract is malformed', () => {
    withLegacyModel('{not valid json<<<', () => {
      const result = loadSegmentsData(ROOT, ['qlog_f449c_2.bz2'], {});
      assert.ok(result.modelEvents.length > 0);
      assert.ok(result.legacyExtractWarnings.some((w) => w.status === 'malformed'));
      assert.match(result.legacyExtractWarnings[0].message, /malformed/i);
    });
  });

  it('loadSegmentsData works when legacy extract is missing', () => {
    withLegacyModel(null, () => {
      const result = loadSegmentsData(ROOT, ['qlog_f449c_2.bz2'], {});
      assert.ok(result.modelEvents.length > 0);
      assert.ok(result.legacyExtractWarnings.some((w) => w.status === 'missing'));
    });
  });

  it('dataset audit segment succeeds with malformed legacy modelV2_extracted.json', () => {
    if (!fs.existsSync(path.join(ROOT, 'qlog_f449c_2.bz2'))) return;
    withLegacyModel('{"events": [', () => {
      const r = auditSegment('qlog_f449c_2.bz2');
      assert.ok(r.temporalPassCount >= 1);
      assert.ok(r.modelV2Count >= 1);
      assert.equal(r.error, undefined);
    });
  });
});
