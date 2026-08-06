'use strict';

const crypto = require('crypto');
const { MEASUREMENT_FINGERPRINT_FIELDS } = require('./stage20_b_motion_review_constants');

function buildMeasurementFingerprint(pair) {
  const payload = {};
  for (const key of MEASUREMENT_FINGERPRINT_FIELDS) {
    payload[key] = pair[key] ?? null;
  }
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function expectedReviewPairId(pair) {
  return `${pair.observationIdA}|${pair.observationIdB}`;
}

function reversedReviewPairId(pair) {
  return `${pair.observationIdB}|${pair.observationIdA}`;
}

module.exports = {
  buildMeasurementFingerprint,
  expectedReviewPairId,
  reversedReviewPairId,
};
