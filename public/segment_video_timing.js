'use strict';

const DRIFT_NONE_MAX_SEC = 0.10;
const DRIFT_RATE_MAX_SEC = 0.40;
const PLAYBACK_RATE_MIN = 0.95;
const PLAYBACK_RATE_MAX = 1.05;
const LOG_MONO_TIME_NS_PER_SEC = 1_000_000_000n;

function logMonoTimeToBigInt(logMonoTime) {
  if (logMonoTime == null) return null;
  try {
    return BigInt(String(logMonoTime));
  } catch {
    return null;
  }
}

function computeLocalElapsedSeconds(currentLogMonoTime, timelineStartLogMonoTime) {
  const currentNs = logMonoTimeToBigInt(currentLogMonoTime);
  const startNs = logMonoTimeToBigInt(timelineStartLogMonoTime);
  if (currentNs == null || startNs == null) return null;
  const deltaNs = currentNs >= startNs ? currentNs - startNs : 0n;
  return Number(deltaNs) / Number(LOG_MONO_TIME_NS_PER_SEC);
}

function computeExpectedVideoTime(localElapsedSeconds, videoStartOffsetSeconds = 0) {
  if (!Number.isFinite(localElapsedSeconds)) return null;
  const offset = Number(videoStartOffsetSeconds) || 0;
  return Math.max(0, localElapsedSeconds + offset);
}

function computeSyncAction(driftSeconds) {
  const drift = Number(driftSeconds);
  if (!Number.isFinite(drift)) return { action: 'none', playbackRate: 1 };
  const abs = Math.abs(drift);
  if (abs < DRIFT_NONE_MAX_SEC) return { action: 'none', playbackRate: 1 };
  if (abs <= DRIFT_RATE_MAX_SEC) {
    const playbackRate = drift > 0
      ? Math.max(PLAYBACK_RATE_MIN, 1 - Math.min(0.05, abs * 0.15))
      : Math.min(PLAYBACK_RATE_MAX, 1 + Math.min(0.05, abs * 0.15));
    return { action: 'rate', playbackRate, drift };
  }
  return { action: 'seek', drift };
}

window.SegmentVideoTiming = {
  DRIFT_NONE_MAX_SEC,
  DRIFT_RATE_MAX_SEC,
  computeLocalElapsedSeconds,
  computeExpectedVideoTime,
  computeSyncAction,
};
