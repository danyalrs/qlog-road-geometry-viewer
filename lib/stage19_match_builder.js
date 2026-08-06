/**
 * Stage 19 — map Stage 16 projected observations to normative match records.
 */
const { observationId } = require('./stage17_divider_association');
const { runProductionPartition } = require('./stage19_partition_production');

function normalizeHeadingDeg(deg) {
  if (!Number.isFinite(deg)) return 0;
  return ((deg % 360) + 360) % 360;
}

function computeTangentDeg(pts, fallbackHeading) {
  if (!pts || pts.length < 2) return normalizeHeadingDeg(fallbackHeading);
  const sorted = [...pts].sort((a, b) => a.s - b.s);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const dx = last.east - first.east;
  const dy = last.north - first.north;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return normalizeHeadingDeg(fallbackHeading);
  return normalizeHeadingDeg((Math.atan2(dx, dy) * 180) / Math.PI);
}

function observationToMatch(ob, trackId, sampleIndex) {
  const pts = (ob.projectedRoutePoints || []).filter((p) => Number.isFinite(p.s) && Number.isFinite(p.d));
  if (pts.length < 1) return null;
  const sLo = Math.min(...pts.map((p) => p.s));
  const sHi = Math.max(...pts.map((p) => p.s));
  const meanD = pts.reduce((sum, p) => sum + p.d, 0) / pts.length;
  const sorted = [...pts].sort((a, b) => a.s - b.s);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const heading = ob.poseRecord?.headingDeg ?? 0;
  const tangent = computeTangentDeg(pts, heading);
  const csf = `${ob.chunkId}:${ob.temporalPassId}:${ob.poseSectionId}`;
  const oid = observationId(ob);
  const tid = trackId || oid;
  return {
    observationId: oid,
    comparisonSpatialFrameId: csf,
    featureIdLo: tid,
    featureIdHi: tid,
    temporalPassIdLo: String(ob.temporalPassId),
    temporalPassIdHi: String(ob.temporalPassId),
    sLoUm: Math.round(sLo * 1e6),
    sHiUm: Math.round(Math.max(sHi, sLo + 1) * 1e6),
    sampleIndexLo: sampleIndex,
    sampleIndexHi: sampleIndex + 1,
    eLoUm: Math.round((first.east ?? 0) * 1e6),
    nLoUm: Math.round((first.north ?? 0) * 1e6),
    uLoUm: 0,
    eHiUm: Math.round((last.east ?? 0) * 1e6),
    nHiUm: Math.round((last.north ?? 0) * 1e6),
    uHiUm: 0,
    meanLateralOffsetUm: Math.round(meanD * 1e6),
    headingDegLo: heading,
    tangentLoDeg: tangent,
    evidenceUnitKey: `${ob.chunkId}:${ob.temporalPassId}`,
    featurePairId: tid,
  };
}

function buildMatchRecords(context) {
  const { observationById, observationToTrack } = context;
  const matches = [];
  const observationIds = [];
  let sampleIndex = 0;
  for (const [oid, ob] of observationById.entries()) {
    const trackId = observationToTrack.get(oid);
    const m = observationToMatch(ob, trackId, sampleIndex);
    if (!m) continue;
    matches.push(m);
    observationIds.push(oid);
    sampleIndex += 1;
  }
  observationIds.sort();
  matches.sort((a, b) => a.observationId.localeCompare(b.observationId));
  return { matches, observationIds };
}

function buildCatalogMembers(matches, observationIds, partitionOutcome) {
  const { branchByObs, partitionResults, failedObservations, stats } = partitionOutcome;
  const members = [];
  for (const oid of observationIds) {
    if (failedObservations.has(oid)) continue;
    members.push({
      memberMatchId: oid,
      branchId: branchByObs.get(oid) ?? 0,
    });
  }
  return { members, partitionResults, partitionStats: stats, branchByObs, failedObservations };
}

function attachBranchIdsToMatches(matches, branchByObs, failedObservations) {
  for (const m of matches) {
    if (failedObservations?.has(m.observationId)) {
      m.partitionFailed = true;
      continue;
    }
    m.branchId = branchByObs.get(m.observationId);
  }
  return matches;
}

function runProductionMatchPartition(matches, deps = {}) {
  return runProductionPartition(matches, deps);
}

module.exports = {
  observationToMatch,
  buildMatchRecords,
  buildCatalogMembers,
  attachBranchIdsToMatches,
  runProductionMatchPartition,
};
