/**
 * Stage 13 — zero-polygon segment diagnostics (read-only).
 */
const path = require('path');
const { loadSegmentsData } = require('./qlog_data');
const { processRoute } = require('./process_route');
const { qualifySegments } = require('./segment_qualify');
const { detectPasses, assignFramesToPasses } = require('./passes');
const { trackLanesAndEdgesInPass } = require('./lane_tracking');
const { assignPoseSections, applyPoseSectionsToFrames } = require('./pose_continuity');
const { diagnoseSegmentFusion } = require('./stage10_diagnostics');
const {
  collectEdgeObservations,
  fuseSideBoundary,
  splitSupportedRuns,
  pairSupportedRuns,
  resolveMaxInterpolationSpanM,
} = require('./sd_fusion');
const { buildReferenceTrajectory } = require('./trajectory');
const { DEFAULT_OPTS } = require('./stage11_fragment_audit');

const ZERO_POLYGON_SEGMENTS = [9, 17, 26, 31, 37, 50, 57, 60, 62, 65, 87, 90, 96];

const STAGE13_CLASSIFICATIONS = [
  'correctly_rejected_for_insufficient_evidence',
  'blocked_by_pose_fragmentation',
  'blocked_by_multi_pass_ambiguity',
  'blocked_by_boundary_mismatch',
  'blocked_by_polygon_validation',
  'potentially_recoverable_through_dataset_wide_rule',
  'inconclusive_without_camera_imagery',
];

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function classifyRoadShape(vehiclePath) {
  if (!vehiclePath?.length || vehiclePath.length < 2) return 'sparse_gps';
  let maxDelta = 0;
  for (let i = 1; i < vehiclePath.length; i++) {
    const h0 = vehiclePath[i - 1].headingDeg ?? 0;
    const h1 = vehiclePath[i].headingDeg ?? 0;
    maxDelta = Math.max(maxDelta, Math.abs(((h1 - h0 + 540) % 360) - 180));
  }
  if (maxDelta < 5) return 'straight';
  if (maxDelta < 20) return 'gradual_curve';
  return 'tight_curve';
}

function classifyGpsQuality(audit, trajectory) {
  const flags = [];
  if ((audit?.gpsCount ?? 0) < 15) flags.push('sparse_gps_count');
  if (trajectory?.maxStepM > 40) flags.push('large_gps_steps');
  if (trajectory?.maxImpliedSpeedMps > 35) flags.push('high_implied_speed');
  if ((audit?.durationSec?.gps ?? 0) < (audit?.durationSec?.modelV2 ?? 0) * 0.5) {
    flags.push('gps_duration_short_vs_model');
  }
  return flags.length ? flags.join('+') : 'adequate';
}

function summarizePoseRejections(poseResult) {
  const breakdown = {};
  for (const t of poseResult.rejectedTransitions || []) {
    const reason = t.rejectionReason || t.reason || 'unknown';
    breakdown[reason] = (breakdown[reason] || 0) + 1;
  }
  return {
    rejectedCount: poseResult.rejectedTransitions?.length ?? 0,
    breakdown,
    transitions: (poseResult.rejectedTransitions || []).map((t) => ({
      fromFrameId: t.fromFrameId,
      toFrameId: t.toFrameId,
      reason: t.rejectionReason || t.reason,
      stepM: t.stepM,
      impliedSpeedMps: t.impliedSpeedMps,
      headingDisagreementDeg: t.headingMotionDisagreementDeg,
    })),
  };
}

function analyzeSupportedRuns(leftFused, rightFused, opts) {
  const maxSpan = resolveMaxInterpolationSpanM(opts);
  const leftRuns = splitSupportedRuns(leftFused, maxSpan);
  const rightRuns = splitSupportedRuns(rightFused, maxSpan);
  const paired = pairSupportedRuns(leftRuns, rightRuns);
  return {
    leftSupportedRunCount: leftRuns.length,
    rightSupportedRunCount: rightRuns.length,
    pairedRunCount: paired.length,
    pairedRunOverlaps: paired.map((p) => ({
      overlapM: p.overlapM,
      overlapStart: p.overlapStart,
      overlapEnd: p.overlapEnd,
    })),
  };
}

function classifyZeroPolygonSegment(metrics) {
  const classifications = [];
  if (metrics.fusion.longitudinalCoverageM.paired < 20 && metrics.attemptedPolygonCount === 0) {
    classifications.push('correctly_rejected_for_insufficient_evidence');
  }
  if (metrics.temporalPassCount > 1) classifications.push('blocked_by_multi_pass_ambiguity');
  if (metrics.poseSectionCount > 1 || metrics.poseRejection.rejectedCount > 0) {
    classifications.push('blocked_by_pose_fragmentation');
  }
  if (metrics.fusion.pairedFrames.pairedFrameCount === 0 && metrics.fusion.edgeObservationCount > 0) {
    classifications.push('blocked_by_boundary_mismatch');
  }
  if (metrics.attemptedPolygonCount > 0 && metrics.acceptedPolygonCount === 0) {
    classifications.push('blocked_by_polygon_validation');
  }
  if (metrics.recoverabilityHint === 'dataset_wide_rule_possible') {
    classifications.push('potentially_recoverable_through_dataset_wide_rule');
  }
  if (!classifications.length) {
    classifications.push('inconclusive_without_camera_imagery');
  }
  return classifications;
}

function assessRecoverability(metrics) {
  const missing = [];
  let hint = 'none';
  if (metrics.fusion.longitudinalCoverageM.paired < 20) {
    missing.push('paired longitudinal coverage >= 20 m');
  }
  if (metrics.fusion.pairedFrames.pairedFrameCount < 5) {
    missing.push('sufficient paired L/R frames per section');
  }
  if (metrics.poseRejection.rejectedCount > 0) {
    missing.push('continuous pose section without GPS outliers');
  }
  if (metrics.temporalPassCount > 1) {
    missing.push('single temporal pass or verified multi-pass alignment');
  }
  if (metrics.rejectedPolygonCount > 0 && metrics.attemptedPolygonCount > 0) {
    const topReason = metrics.exactRejectionReasons[0];
    if (topReason?.includes('selfIntersecting') || topReason?.includes('vertexJump')) {
      hint = 'dataset_wide_rule_possible';
      missing.push('supported-run geometry fix (not segment-specific)');
    }
  }
  return { recoverableWithCurrentEvidence: missing.length === 0, missingEvidence: missing, recoverabilityHint: hint };
}

function diagnoseZeroPolygonSegment(segmentId, opts = DEFAULT_OPTS) {
  const filename = `qlog_f449c_${segmentId}.bz2`;
  const loaded = loadSegmentsData(process.cwd(), [filename], opts);
  const audit = loaded.audits[0];
  const quals = qualifySegments(loaded.audits);
  const procOpts = { ...opts, segmentQualifications: quals, fileAudits: loaded.audits };
  const result = processRoute(loaded.modelEvents, loaded.gpsEvents, procOpts);
  const chunk = result.routeChunks[0];
  const chunkFiles = chunk?.files || [filename];
  const frames = (chunk?.frames || result.frames).filter((f) => chunkFiles.includes(f.sourceFile));
  const vehiclePath = chunk?.vehiclePath || result.vehiclePath;

  const { passes } = detectPasses(vehiclePath, procOpts);
  const assignedFrames = assignFramesToPasses(frames, passes);
  const pathWithPassIds = passes.flatMap((p) => p.points.map((pt) => ({ ...pt, passId: p.passId })));
  const poseResult = assignPoseSections(pathWithPassIds, procOpts);
  const framesWithPose = applyPoseSectionsToFrames(assignedFrames, poseResult.annotatedPoints);
  const poseRejection = summarizePoseRejections(poseResult);

  const sectionDiagnostics = [];
  let totalAttempted = 0;
  let totalAccepted = 0;
  const allRejectionReasons = [];

  for (const pass of passes) {
    const passFrames = framesWithPose.filter((f) => f.passId === pass.passId);
    const sectionIds = [...new Set(passFrames.map((f) => f.poseSectionId ?? 0))];
    for (const poseSectionId of sectionIds) {
      const sectionFrames = passFrames.filter((f) => (f.poseSectionId ?? 0) === poseSectionId);
      const tracked = trackLanesAndEdgesInPass(sectionFrames, procOpts);
      const sectionPath = poseResult.annotatedPoints.filter(
        (p) => p.passId === pass.passId && p.poseSectionId === poseSectionId
      );
      const passPath = sectionPath.length ? sectionPath : pass.points;
      const fusion = diagnoseSegmentFusion(tracked.frames, passPath, procOpts);

      const trajectory = buildReferenceTrajectory(passPath);
      const { observations } = collectEdgeObservations(tracked.frames, trajectory, procOpts);
      const leftResult = fuseSideBoundary(observations, 'left', procOpts);
      const rightResult = fuseSideBoundary(observations, 'right', procOpts);
      const supportedRuns = analyzeSupportedRuns(leftResult.fusedPoints, rightResult.fusedPoints, procOpts);

      totalAttempted += fusion.acceptedPolygonCount + fusion.rejectedPolygonCount;
      totalAccepted += fusion.acceptedPolygonCount;
      for (const r of fusion.rejectedPolygons || []) {
        for (const reason of r.rejectionReasons || []) allRejectionReasons.push(reason);
      }

      sectionDiagnostics.push({
        temporalPassId: pass.passId,
        poseSectionId,
        frameCount: sectionFrames.length,
        leftObservationCount: fusion.leftObservationCount,
        rightObservationCount: fusion.rightObservationCount,
        pairedFrames: fusion.pairedFrames,
        pairedBinCounts: fusion.occupiedFusionBinCount,
        supportedRuns,
        longitudinalCoverageM: fusion.longitudinalCoverageM,
        maxSourceBinGapM: Math.max(
          fusion.fusionBins.left.maxBinGapM ?? 0,
          fusion.fusionBins.right.maxBinGapM ?? 0
        ),
        widthDistribution: fusion.rejectedPolygons?.[0]?.laneWidthDistribution
          || fusion.acceptedPolygons?.[0]?.stats
          ? {
            median: fusion.acceptedPolygons?.[0]?.stats?.medianWidth
              ?? fusion.rejectedPolygons?.[0]?.laneWidthDistribution?.median,
            min: fusion.acceptedPolygons?.[0]?.stats?.minWidth
              ?? fusion.rejectedPolygons?.[0]?.laneWidthDistribution?.min,
            max: fusion.acceptedPolygons?.[0]?.stats?.maxWidth
              ?? fusion.rejectedPolygons?.[0]?.laneWidthDistribution?.max,
          }
          : null,
        attemptedPolygonCount: fusion.acceptedPolygonCount + fusion.rejectedPolygonCount,
        acceptedPolygonCount: fusion.acceptedPolygonCount,
        rejectedPolygonCount: fusion.rejectedPolygonCount,
        exactRejectionReasons: [...new Set(
          (fusion.rejectedPolygons || []).flatMap((r) => r.rejectionReasons || [])
        )],
        rejectedPolygonDetails: (fusion.rejectedPolygons || []).map((r) => ({
          fragmentIndex: r.fragmentIndex,
          reasons: r.rejectionReasons,
          exactRejectionConditions: r.exactRejectionConditions,
          inferredRootCauses: r.inferredRootCauses,
        })),
      });
    }
  }

  const primarySection = sectionDiagnostics[0];
  const fusionAgg = primarySection ? {
    edgeObservationCount: primarySection.leftObservationCount + primarySection.rightObservationCount,
    pairedFrames: primarySection.pairedFrames,
    longitudinalCoverageM: primarySection.longitudinalCoverageM,
    maxSourceBinGapM: Math.max(...sectionDiagnostics.map((s) => s.maxSourceBinGapM)),
  } : { edgeObservationCount: 0, pairedFrames: { pairedFrameCount: 0 }, longitudinalCoverageM: { paired: 0 }, maxSourceBinGapM: 0 };

  const metrics = {
    segmentId,
    temporalPassCount: chunk?.passDiagnostics?.passCount ?? passes.length,
    poseSectionCount: chunk?.passDiagnostics?.poseSectionCount ?? 1,
    poseRejection,
    fusion: fusionAgg,
    attemptedPolygonCount: totalAttempted,
    acceptedPolygonCount: totalAccepted,
    rejectedPolygonCount: totalAttempted - totalAccepted,
    exactRejectionReasons: [...new Set(allRejectionReasons)],
    roadShape: classifyRoadShape(vehiclePath),
    gpsQuality: classifyGpsQuality(audit, chunk?.trajectory),
    polygonCount: chunk?.roadSurfacePolygons?.length ?? 0,
  };

  const recoverability = assessRecoverability({
    ...metrics,
    fusion: { ...fusionAgg, longitudinalCoverageM: fusionAgg.longitudinalCoverageM },
  });
  metrics.recoverabilityHint = recoverability.recoverabilityHint;
  metrics.recoverableWithCurrentEvidence = recoverability.recoverableWithCurrentEvidence;
  metrics.missingEvidenceForRecovery = recoverability.missingEvidence;

  const classifications = classifyZeroPolygonSegment(metrics);

  return {
    ...metrics,
    classifications,
    primaryClassification: classifications[0],
    sectionDiagnostics,
    recoverability,
  };
}

function summarizeZeroPolygonAudit(results) {
  const byClass = {};
  for (const r of results) {
    for (const c of r.classifications) {
      byClass[c] = (byClass[c] || 0) + 1;
    }
  }
  return {
    segmentCount: results.length,
    byClassification: byClass,
    poseFragmented: results.filter((r) => r.classifications.includes('blocked_by_pose_fragmentation')).map((r) => r.segmentId),
    multiPass: results.filter((r) => r.classifications.includes('blocked_by_multi_pass_ambiguity')).map((r) => r.segmentId),
    insufficientEvidence: results.filter((r) => r.classifications.includes('correctly_rejected_for_insufficient_evidence')).map((r) => r.segmentId),
    polygonValidation: results.filter((r) => r.classifications.includes('blocked_by_polygon_validation')).map((r) => r.segmentId),
    potentiallyRecoverable: results.filter((r) => r.classifications.includes('potentially_recoverable_through_dataset_wide_rule')).map((r) => r.segmentId),
  };
}

module.exports = {
  ZERO_POLYGON_SEGMENTS,
  STAGE13_CLASSIFICATIONS,
  diagnoseZeroPolygonSegment,
  summarizeZeroPolygonAudit,
  classifyZeroPolygonSegment,
};
