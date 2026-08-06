'use strict';

/**
 * Lane coverage audit: Segment 44 (reference) vs Segment 27 (low coverage).
 * Read-only diagnostics — no threshold or geometry changes.
 *
 * Usage: node scripts/audit_lane_coverage_segments.js
 */

const fs = require('fs');
const path = require('path');
const { processRoute } = require('../lib/process_route');
const { extractFromFile: extractModel } = require('../extract_modelv2');
const { extractFromFile: extractGps } = require('../extract_gps');
const { auditSegment } = require('../lib/lane_coverage_audit');
const { PROCESSING_VERSION } = require('../lib/version');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'reports', 'lane_coverage_audit');
const SEGMENTS = [
  { id: 44, file: 'qlog_f449c_44.bz2', role: 'high_coverage_reference' },
  { id: 27, file: 'qlog_f449c_27.bz2', role: 'low_coverage_case' },
];

function loadSegment(file) {
  const segPath = path.join(ROOT, file);
  const modelEvents = extractModel(segPath).map((e) => ({ ...e, sourceFile: file }));
  const gpsEvents = extractGps(segPath).map((e) => ({ ...e, sourceFile: file }));
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode: 'C' });
  return { result, modelEvents, gpsEvents };
}

function summarizeComparison(seg44, seg27) {
  const q1 = seg27.usableLaneObservationCount < seg44.usableLaneObservationCount;
  const rawLoss = seg44.coverageComparison.rawMappedSpanSumM - seg27.coverageComparison.rawMappedSpanSumM;
  const fusedLoss = seg44.coverageComparison.fusedLengthSumM - seg27.coverageComparison.fusedLengthSumM;

  const seg27fragments = seg27.identityChanges.filter((x) => x.likelySameLane);
  const seg44fragments = seg44.identityChanges.filter((x) => x.likelySameLane);

  const stageLoss = [];
  if (q1) stageLoss.push({ stage: 'raw_observations', delta: seg44.usableLaneObservationCount - seg27.usableLaneObservationCount });
  const projLoss = seg44.coverageGraph.gapSections.filter((g) => g.classification === 'projectionRejected').length
    - seg27.coverageGraph.gapSections.filter((g) => g.classification === 'projectionRejected').length;
  const trackLoss = seg44.coverageGraph.gapSections.filter((g) => g.classification === 'trackerAssociationFailed').length
    - seg27.coverageGraph.gapSections.filter((g) => g.classification === 'trackerAssociationFailed').length;
  const fusionLoss = seg44.coverageGraph.gapSections.filter((g) => g.classification === 'insufficientFusionSupport').length
    - seg27.coverageGraph.gapSections.filter((g) => g.classification === 'insufficientFusionSupport').length;
  stageLoss.push({ stage: 'projectionRejected_gaps', delta: projLoss });
  stageLoss.push({ stage: 'trackerAssociationFailed_gaps', delta: trackLoss });
  stageLoss.push({ stage: 'insufficientFusionSupport_gaps', delta: fusionLoss });

  const largestStage = [...stageLoss].sort((a, b) => b.delta - a.delta)[0];

  return {
    q1_fewerRawObservationsOnSeg27: q1,
    q2_rawPresentButRemovedDuringFusion: !q1 && fusedLoss > rawLoss * 0.2,
    q3_probableLaneSplitIntoSeparateIdentities: seg27fragments.length > seg44fragments.length,
    q4_largestCoverageLossStage: largestStage?.stage ?? null,
    q5_qlogPipelineCanFixWithoutInventingConnections: largestStage?.stage === 'raw_observations' || largestStage?.stage === 'projectionRejected_gaps',
    q6_shouldMoveToHigherFrameRateTsVideo: q1 && seg27.frameCount <= seg44.frameCount * 0.85,
    metrics: {
      usableObsDelta: seg44.usableLaneObservationCount - seg27.usableLaneObservationCount,
      rawSpanDeltaM: Math.round(rawLoss * 10) / 10,
      fusedSpanDeltaM: Math.round(fusedLoss * 10) / 10,
      seg27IdentitySplits: seg27fragments.length,
      seg44IdentitySplits: seg44fragments.length,
      seg27RejectedCleanup: seg27.rejectedCleanupFragments.length,
      seg44RejectedCleanup: seg44.rejectedCleanupFragments.length,
    },
    stageLossRanking: stageLoss.sort((a, b) => b.delta - a.delta),
  };
}

function writeMarkdownReport(report) {
  const lines = [];
  lines.push('# Lane coverage audit — Segments 44 vs 27');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Processing version: ${report.processingVersion}`);
  lines.push('');
  for (const seg of report.segments) {
    lines.push(`## Segment ${seg.id} (${seg.role})`);
    lines.push('');
    lines.push(`- modelV2 frames: ${seg.modelV2ObservationCount}`);
    lines.push(`- usable lane observations: ${seg.usableLaneObservationCount}`);
    lines.push(`- obs spacing mean/median: ${seg.observationSpacingMeanM?.toFixed(2)} / ${seg.observationSpacingMedianM?.toFixed(2)} m`);
    lines.push(`- fused tracks: ${seg.fusedTrackCount}`);
    lines.push(`- path length: ${seg.pathLengthM} m`);
    lines.push(`- raw mapped span sum: ${seg.coverageComparison.rawMappedSpanSumM} m`);
    lines.push(`- fused length sum: ${seg.coverageComparison.fusedLengthSumM} m`);
    lines.push('');
    lines.push('### Raw mapped length by lane index');
    for (const [idx, len] of Object.entries(seg.rawMappedLengthByLaneIndex)) {
      lines.push(`- lane ${idx}: ${Math.round(len * 10) / 10} m`);
    }
    lines.push('');
    lines.push('### Fused tracks');
    for (const t of seg.fusedTracks) {
      lines.push(`- track ${t.trackId}: length ${Math.round(t.fusedLengthM)} m, route coverage ${t.routeCoveragePct}%, largest gap ${t.largestUnsupportedGapM} m, lane indices [${t.dominantLaneIndices.join(',')}]`);
    }
    lines.push('');
    lines.push('### Tracker summary');
    lines.push('```json');
    lines.push(JSON.stringify(seg.trackerSummary, null, 2));
    lines.push('```');
    lines.push('');
  }
  lines.push('## Comparison answers');
  lines.push('');
  const c = report.comparison;
  lines.push(`1. Fewer raw obs on seg 27: **${c.q1_fewerRawObservationsOnSeg27}**`);
  lines.push(`2. Raw present but removed in fusion: **${c.q2_rawPresentButRemovedDuringFusion}**`);
  lines.push(`3. Probable lane identity split: **${c.q3_probableLaneSplitIntoSeparateIdentities}**`);
  lines.push(`4. Largest loss stage: **${c.q4_largestCoverageLossStage}**`);
  lines.push(`5. Qlog fix without inventing connections: **${c.q5_qlogPipelineCanFixWithoutInventingConnections}**`);
  lines.push(`6. Move to higher-frame-rate .ts video: **${c.q6_shouldMoveToHigherFrameRateTsVideo}**`);
  lines.push('');
  return lines.join('\n');
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const segmentReports = [];

  for (const seg of SEGMENTS) {
    console.log(`Auditing ${seg.file}...`);
    const { result, modelEvents } = loadSegment(seg.file);
    const audit = auditSegment(result, modelEvents, seg.file);
    segmentReports.push({ id: seg.id, role: seg.role, ...audit });

    fs.writeFileSync(
      path.join(OUT_DIR, `segment_${seg.id}_audit.json`),
      JSON.stringify(audit, null, 2),
    );
    fs.writeFileSync(
      path.join(OUT_DIR, `segment_${seg.id}_coverage_graph.svg`),
      audit.coverageGraphSvg,
    );
    console.log(`  frames=${audit.frameCount} usableObs=${audit.usableLaneObservationCount} fusedTracks=${audit.fusedTrackCount}`);
  }

  const comparison = summarizeComparison(segmentReports[0], segmentReports[1]);
  const report = {
    generatedAt: new Date().toISOString(),
    processingVersion: PROCESSING_VERSION,
    segments: segmentReports,
    comparison,
  };

  fs.writeFileSync(path.join(OUT_DIR, 'lane_coverage_audit.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'lane_coverage_audit.md'), writeMarkdownReport(report));
  console.log('\nWrote reports to', OUT_DIR);
  console.log('\nComparison:', JSON.stringify(comparison, null, 2));
}

main();
