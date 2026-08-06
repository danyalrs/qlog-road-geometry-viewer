/**
 * Temporal tracker audit export for segments 2, 5, 6.
 * Usage: node audit_tracker.js [qlog_f449c_2.bz2] [--mode A|B|C]
 */
const fs = require('fs');
const path = require('path');
const { processRoute } = require('./lib/process_route');

const ROOT = __dirname;
const file = process.argv[2] || 'qlog_f449c_2.bz2';
const modeArg = process.argv.find((a) => a.startsWith('--mode='));
const pipelineMode = modeArg ? modeArg.split('=')[1] : 'C';

const model = JSON.parse(fs.readFileSync(path.join(ROOT, 'modelV2_extracted.json'), 'utf8'));
const gps = JSON.parse(fs.readFileSync(path.join(ROOT, 'gps_extracted.json'), 'utf8'));

function run() {
  const modelEvents = model.events.filter((e) => e.sourceFile === file);
  const gpsEvents = gps.events.filter((e) => e.sourceFile === file);
  const result = processRoute(modelEvents, gpsEvents, { pipelineMode });
  const chunk = result.routeChunks[0];

  const report = {
    file,
    pipelineMode,
    validModelFrames: result.frames.length,
    chunkId: chunk?.chunkId,
    passes: (chunk?.passCoverage || []).map((p) => {
      const passAudits = (chunk?.framePairAudits || []).filter((a) => a.passId === p.passId);
      const passTracks = (chunk?.laneTracks || []).filter((t) => t.passId === p.passId);
      const tracking = (chunk?.laneTrackingSummary?.passes || []).find((x) => x.passId === p.passId);
      return {
        passId: p.passId,
        frameCount: p.frameCount,
        pathLengthM: p.pathLengthM,
        polygons: p.acceptedPolygonCount,
        tracking: tracking ? {
          createdTracks: tracking.trackCount ?? tracking.createdTracks,
          continuedTracks: tracking.continuedTracks,
          terminatedTracks: tracking.terminatedTracks,
          oneFrameTracks: tracking.oneFrameTracks,
          twoFrameTracks: tracking.twoFrameTracks,
          threePlusFrameTracks: tracking.threePlusFrameTracks,
          medianTrackDurationFrames: tracking.medianTrackDurationFrames,
          maxTrackDurationFrames: tracking.maxTrackDurationFrames,
          fragmentationRate: tracking.fragmentationRate,
          observationAssociationPct: tracking.observationAssociationPct,
          rejectedMatches: tracking.rejectedMatches,
          ambiguousMatches: tracking.ambiguousMatches,
          meanMatchCost: tracking.meanMatchCost,
        } : null,
        framePairAudits: passAudits,
        tracks: passTracks.map((t) => ({
          trackId: t.trackId,
          frameIds: t.frameIds,
          frameCount: t.frameIds?.length,
          coveredDistanceM: t.coveredDistanceM,
          laneOrder: t.laneOrder,
        })),
        geometryLayers: chunk?.geometryLayers ? {
          accepted: chunk.geometryLayers.acceptedFusedLanes?.length ?? 0,
          laneOnly: chunk.geometryLayers.laneOnlyCandidates?.length ?? 0,
          rejected: chunk.geometryLayers.rejectedOutliers?.length ?? 0,
        } : null,
        laneOnlyCount: chunk?.laneOnlyCandidates?.length ?? 0,
      };
    }),
    suspiciousFragments: chunk?.geometryLayers?.suspiciousFragments ?? [],
  };

  const outPath = path.join(ROOT, `audit_tracker_${file.replace('.bz2', '')}_${pipelineMode}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(`\n=== Tracker audit: ${file} mode ${pipelineMode} ===\n`);
  for (const p of report.passes) {
    console.log(`Pass ${p.passId}: ${p.frameCount} frames, ${p.polygons} polygons`);
    if (p.tracking) {
      console.log(`  tracks: ${p.tracking.createdTracks}, continued: ${p.tracking.continuedTracks}, 1-frame: ${p.tracking.oneFrameTracks}, median len: ${p.tracking.medianTrackDurationFrames}`);
    }
    console.log(`  accepted lanes: ${p.geometryLayers?.accepted ?? 'n/a'}, lane-only: ${p.geometryLayers?.laneOnly ?? p.laneOnlyCount}`);
  }
  console.log('\nExported:', outPath);

  if (file === 'qlog_f449c_2.bz2') {
    const p0 = report.passes.find((p) => p.passId === 0);
    if (p0?.tracking) {
      console.log('\n--- Segment 2 Pass 0 fragmentation analysis ---');
      console.log(`Created ${p0.tracking.createdTracks} tracks from ${p0.frameCount} frames`);
      console.log(`Continued: ${p0.tracking.continuedTracks}, 1-frame tracks: ${p0.tracking.oneFrameTracks}`);
      console.log(`Fragmentation rate: ${(p0.tracking.fragmentationRate * 100).toFixed(1)}%`);
      const audits = p0.framePairAudits || [];
      for (const a of audits.slice(0, 3)) {
        console.log(`  Frame pair ${a.prevFrameId} -> ${a.nextFrameId}: ${a.assignments?.length} assignments, ${a.rejections?.length} rejections`);
      }
    }
  }
}

run();
