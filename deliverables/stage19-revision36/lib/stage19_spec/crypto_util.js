'use strict';

const crypto = require('crypto');
const { jcsUtf8Bytes } = require('./jcs');

function sha256(bytesOrString) {
  const buf = typeof bytesOrString === 'string'
    ? Buffer.from(bytesOrString, 'utf8')
    : Buffer.from(bytesOrString);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function rehash(prev, op, payload) {
  return sha256(jcsUtf8Bytes({ prev: prev || '', op, payload }));
}

module.exports = { sha256, rehash };
