#!/usr/bin/env node
/**
 * Stage 10 per-candidate diagnostics for zero-polygon tuning.
 *
 * Usage:
 *   node stage10_candidate_diagnostics.js --candidates12 --out audit_stage10_diagnostics.json
 *   node stage10_candidate_diagnostics.js --segments 58,99
 */
const fs = require('fs');
const path = require('path');
const { loadSegmentsData } = require('./lib/qlog_data');
const { PROCESSING_VERSION } = require('./lib/version');
const {
  STAGE10_CANDIDATES,
  STAGE10_GROUPS,
  diagnoseCandidateSegment,
} = require('./lib/stage10_diagnostics');

const ROOT = __dirname;
const DEFAULT_OPTS = {
  minLaneProb: 0.5,
  maxAccuracyM: 50,
  maxModelGpsDeltaNs: 2e9,
  maxForwardM: 120,
  fusionIntervalM: 2,
  minSpeedForGpsBearing: 2,
  pipelineMode: 'C',
  laneTrackingEnabled: true,
  localSupportFilter: true,
};

function parseArgs() {
  const args = process.argv.slice(2);
  let segments = null;
  let out = path.join(ROOT, 'audit_stage10_diagnostics.json');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--candidates12') {
      segments = STAGE10_CANDIDATES.map((n) => `qlog_f449c_${n}.bz2`);
    } else if (args[i] === '--segments' && args[i + 1]) {
      segments = args[++i].split(',').map((n) => `qlog_f449c_${n.trim()}.bz2`);
    } else if (args[i] === '--out' && args[i + 1]) out = args[++i];
  }
  if (!segments) segments = STAGE10_CANDIDATES.map((n) => `qlog_f449c_${n}.bz2`);
  return { segments, out };
}

function summarizeSegment(diag) {
  const f = diag.primarySection?.fusion;
  if (!f) return { segmentId: diag.segmentId, error: 'no fusion data' };
  const rej = f.rejectedPolygons[0];
  return {
    segmentId: diag.segmentId,
    group: diag.stage10Group,
    temporalPass: diag.temporalPassCount,
    poseSection: diag.poseSectionCount,
    pairedFrames: f.pairedFrames.pairedFrameCount,
    leftObs: f.leftObservationCount,
    rightObs: f.rightObservationCount,
    occupiedBins: `${f.occupiedFusionBinCount.left}/${f.occupiedFusionBinCount.right}`,
    pairedCoverageM: f.longitudinalCoverageM.paired.toFixed(1),
    maxVertexJumpM: rej?.maxVertexJump?.distanceM?.toFixed(2) ?? 'n/a',
    selfIntersections: rej?.selfIntersections?.length ?? 0,
    rejection: rej?.rejectionReasons?.join('+') ?? (f.acceptedPolygonCount > 0 ? 'accepted' : 'none'),
    rootCauses: rej?.inferredRootCauses ?? [],
    exactCondition: rej?.exactRejectionConditions?.[0] ?? null,
  };
}

function main() {
  const { segments, out } = parseArgs();
  const results = [];
  console.log(`Stage 10 diagnostics, version ${PROCESSING_VERSION}`);
  for (const filename of segments) {
    const segNum = parseInt(filename.match(/_(\d+)/)[1], 10);
    process.stdout.write(`  seg ${segNum}...`);
    try {
      const loaded = loadSegmentsData(ROOT, [filename], DEFAULT_OPTS);
      const diag = diagnoseCandidateSegment(loaded, DEFAULT_OPTS);
      results.push(diag);
      const s = summarizeSegment(diag);
      console.log(` ${s.group} | ${s.rejection} | causes: ${s.rootCauses.join(', ') || 'n/a'}`);
    } catch (err) {
      console.log(` ERROR ${err.message}`);
      results.push({ segmentId: segNum, error: err.message });
    }
  }

  const byGroup = {};
  for (const r of results) {
    const g = r.stage10Group || 'error';
    if (!byGroup[g]) byGroup[g] = [];
    byGroup[g].push(summarizeSegment(r));
  }

  const output = {
    auditedAt: new Date().toISOString(),
    processingVersion: PROCESSING_VERSION,
    candidateCount: results.length,
    groups: STAGE10_GROUPS,
    summaries: results.map(summarizeSegment),
    byGroup,
    results,
  };

  fs.writeFileSync(path.isAbsolute(out) ? out : path.join(ROOT, out), JSON.stringify(output, null, 2));
  console.log(`\nWrote ${out}`);
}

if (require.main === module) main();
