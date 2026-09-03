'use strict';

const HAVE_CURRENT_DATA = 2;
const DEFAULT_TIME_TOLERANCE_S = 0.10;

function parseSegmentIdFromSourceFile(sourceFile) {
  if (!sourceFile) return null;
  const match = String(sourceFile).match(/^qlog_f449c_(\d+)\.bz2$/i);
  return match ? match[1] : null;
}

function crossesSegmentBoundary(timeline, fromIdx, toIdx) {
  if (!timeline?.length || fromIdx == null || toIdx == null) return false;
  const from = timeline[fromIdx];
  const to = timeline[toIdx];
  if (!from?.sourceFile || !to?.sourceFile) return false;
  return from.sourceFile !== to.sourceFile;
}

function isVideoFrameReady(video, targetTimeS, toleranceS = DEFAULT_TIME_TOLERANCE_S) {
  if (!video) return false;
  if (video.readyState < HAVE_CURRENT_DATA) return false;
  if (video.seeking) return false;
  const current = Number(video.currentTime);
  const target = Number(targetTimeS);
  if (!Number.isFinite(current) || !Number.isFinite(target)) return false;
  return Math.abs(current - target) <= toleranceS;
}

function createRouteTransitionState() {
  return {
    state: 'idle',
    pendingBoundaryIndex: null,
    pendingBoundarySegmentId: null,
    pendingBoundaryLocalTimeS: 0,
    boundarySwitchToken: 0,
    resumeAfterBoundary: false,
    boundaryLoadingStartedAt: null,
    frozenBoundaryIndex: null,
    frozenTickCount: 0,
    arrowMovementDuringBoundaryM: 0,
    timelineMovementDuringBoundaryS: 0,
    staleCallbackCount: 0,
    boundarySrcChangeCount: 0,
  };
}

module.exports = {
  HAVE_CURRENT_DATA,
  DEFAULT_TIME_TOLERANCE_S,
  parseSegmentIdFromSourceFile,
  crossesSegmentBoundary,
  isVideoFrameReady,
  createRouteTransitionState,
};
