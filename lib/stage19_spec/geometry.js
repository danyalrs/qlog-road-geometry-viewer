'use strict';

const { config, stage17Gaps } = require('./config');
const { CanonicalMatchTuple } = require('./canonical');

const tol = () => config.spatialEqualityToleranceM;

function sLoM(m) { return m.sLoUm / 1e6; }
function sHiM(m) { return m.sHiUm / 1e6; }
function meanLateralOffsetUm(m) { return CanonicalMatchTuple(m)[10]; }
function headingDeg(m) { return m.headingDegLo; }
function tangentLoDeg(m) { return m.tangentLoDeg; }

function normalizeTo180(deg) {
  let y = ((deg + 180) % 360 + 360) % 360 - 180;
  if (y === -180 && deg > 0) y = 180;
  return y;
}

function wrappedAbs(d) { return Math.abs(normalizeTo180(d)); }
function reverse(dir) { return dir === 'inc' ? 'dec' : 'inc'; }

function sign(x) {
  if (x > tol()) return 1;
  if (x < -tol()) return -1;
  return 0;
}

function encodeSignCode(s) {
  if (s === 0) return 0b00;
  return s > 0 ? 0b01 : 0b10;
}

function euclideanHiDistanceM(a, b) {
  const dx = (a.eHiUm - b.eHiUm) / 1e6;
  const dy = (a.nHiUm - b.nHiUm) / 1e6;
  const dz = (a.uHiUm - b.uHiUm) / 1e6;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function slope(a, b, dir) {
  const d = sLoM(b) - sLoM(a);
  return d === 0 ? null : (sHiM(b) - sHiM(a)) / d;
}

function quantizeSlope(s) {
  const bin = Math.round(s * config.slopeQuantizationScale);
  if (Math.abs(bin) > config.slopeBinMax) throw new Error('slopeBinOverflow');
  return { present: true, bin };
}

function dequantizeSlope(r) {
  return r.present ? r.bin / config.slopeQuantizationScale : null;
}

function prohibitedGap(a, b) {
  const lo = Math.min(a.sLoUm, b.sLoUm);
  const hi = Math.max(a.sLoUm, b.sLoUm);
  for (const g of stage17Gaps) {
    if (g.intersectsLoOrHi(lo, hi)) return true;
  }
  return false;
}

function preliminaryEdge(a, b, dir) {
  if (!Number.isFinite(sLoM(a)) || !Number.isFinite(sLoM(b))) return false;
  if (Math.abs(sLoM(b) - sLoM(a)) > config.maxConsecutiveRouteSGapM) return false;
  if (Math.abs(sHiM(b) - sHiM(a)) > config.maxConsecutiveRouteSGapM) return false;
  if (euclideanHiDistanceM(a, b) > config.maxSpatialJumpM) return false;
  if (prohibitedGap(a, b)) return false;
  const s = slope(a, b, dir);
  if (s === null || !Number.isFinite(s)) return false;
  if (Math.abs(s) < config.minCorrespondenceSlopeAbs || Math.abs(s) > config.maxCorrespondenceSlopeAbs) return false;
  if (Math.abs(meanLateralOffsetUm(b) - meanLateralOffsetUm(a)) > config.maxLateralOffsetDeltaM * 1e6) return false;
  return true;
}

function staticBranchCandidateEdge(a, b, dir) {
  if (!preliminaryEdge(a, b, dir)) return false;
  const qa = quantizeSlope(slope(a, b, dir));
  const qb = quantizeSlope(slope(b, a, reverse(dir)));
  if (Math.abs(dequantizeSlope(qa) - dequantizeSlope(qb)) > config.maxCorrespondenceSlopeDelta) return false;
  if (wrappedAbs(tangentLoDeg(b) - tangentLoDeg(a)) > config.maxLocalHeadingDeltaDeg) return false;
  return true;
}

function directedStepSupport(a, b, dir) {
  return Math.max(0, Math.abs(sLoM(b) - sLoM(a)));
}

function tailMatch(node, M) {
  return M[node.tailLocalIndex];
}

function INIT_TAIL(m) {
  return {
    slopeRef: { present: false, bin: 0 },
    offsetSignHistoryBits3: 0b000,
    tangentBin: Math.round(tangentLoDeg(m) / config.headingTangentQuantizeDeg),
  };
}

function extensionCost(node, m, dir, M) {
  const a = tailMatch(node, M);
  const b = m;
  return (prohibitedGap(a, b) ? config.wGap : 0)
    + config.wLat * Math.abs(meanLateralOffsetUm(b) - meanLateralOffsetUm(a)) / 1e6
    + config.wSlope * Math.abs(slope(a, b, dir))
    + config.wTan * wrappedAbs(tangentLoDeg(b) - tangentLoDeg(a));
}

function offsetSignTransitionLegal(oldBits3, newSign) {
  const last = oldBits3 & 0b11;
  const newCode = encodeSignCode(newSign);
  if (last === 0b00 || newCode === 0b00) return true;
  if (newCode !== last) return true;
  return ((oldBits3 >> 2) & 1) === 1;
}

function UPDATE_TAIL(node, m, dir, M) {
  const a = tailMatch(node, M);
  const latDelta = meanLateralOffsetUm(m) - meanLateralOffsetUm(a);
  const s = sign(latDelta);
  const oldBits = node.tailStateKey.offsetSignHistoryBits3;
  if (!offsetSignTransitionLegal(oldBits, s)) throw new Error('illegalOffsetSignTransition');
  const last = oldBits & 0b11;
  const newCode = encodeSignCode(s);
  const alternated = (last !== 0b00 && newCode !== 0b00 && newCode !== last)
    ? 1
    : ((oldBits >> 2) & 1);
  return {
    slopeRef: quantizeSlope(slope(a, m, dir)),
    offsetSignHistoryBits3: (alternated << 2) | newCode,
    tangentBin: Math.round(tangentLoDeg(m) / config.headingTangentQuantizeDeg),
  };
}

module.exports = {
  tol,
  sLoM,
  sHiM,
  meanLateralOffsetUm,
  headingDeg,
  tangentLoDeg,
  normalizeTo180,
  wrappedAbs,
  reverse,
  sign,
  preliminaryEdge,
  staticBranchCandidateEdge,
  directedStepSupport,
  tailMatch,
  INIT_TAIL,
  extensionCost,
  offsetSignTransitionLegal,
  UPDATE_TAIL,
};
