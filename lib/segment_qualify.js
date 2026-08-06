/**
 * Segment completeness and evidence classification.
 */
const EXPECTED_SEGMENT_DURATION_SEC = 58;
const EXPECTED_MODELV2_COUNT = 25;

function gapSec(tA, tB) {
  if (!tA || !tB) return null;
  return Math.abs(Number(BigInt(tB) - BigInt(tA))) / 1e9;
}

function classifySegment(audit, context = {}) {
  const flags = [];
  const reasons = [];

  const modelDur = audit.durationSec?.modelV2 ?? 0;
  const modelCount = audit.modelV2Count ?? 0;
  const gpsDur = audit.durationSec?.gps ?? 0;

  if (modelDur < EXPECTED_SEGMENT_DURATION_SEC * 0.25) {
    flags.push('incompleteLog');
    reasons.push(`modelV2 duration ${modelDur.toFixed(1)}s < expected ~${EXPECTED_SEGMENT_DURATION_SEC}s`);
  }

  if (modelCount < 3) {
    flags.push('insufficientTemporalObservations');
    reasons.push(`only ${modelCount} modelV2 message(s)`);
  }

  if (modelCount < EXPECTED_MODELV2_COUNT * 0.15) {
    flags.push('insufficientLaneSupport');
    reasons.push(`modelV2 count ${modelCount} far below expected ~${EXPECTED_MODELV2_COUNT}`);
  }

  if (audit.fileSizeBytes < 500_000 && modelCount < 10) {
    flags.push('incompleteLog');
    reasons.push(`file size ${audit.fileSizeBytes} bytes suggests truncated log`);
  }

  const gapToNext = context.gapToNextSec;
  if (gapToNext != null && gapToNext > 30) {
    flags.push('adjacentSegmentGap');
    reasons.push(`${gapToNext.toFixed(1)}s gap before next segment`);
  }

  const gapFromPrev = context.gapFromPrevSec;
  if (gapFromPrev != null && gapFromPrev > 30) {
    flags.push('adjacentSegmentGap');
    reasons.push(`${gapFromPrev.toFixed(1)}s gap after previous segment`);
  }

  const allowFusion = !flags.some((f) =>
    f === 'incompleteLog'
    || f === 'insufficientTemporalObservations'
    || f === 'insufficientLaneSupport'
  );

  const allowPasses = allowFusion && modelCount >= 3;

  return {
    filename: audit.filename,
    fileSha256: audit.sha256,
    flags: [...new Set(flags)],
    reasons,
    allowFusion,
    allowPasses,
    allowTemporalTracks: allowFusion && modelCount >= 2,
    poseUnavailable: false,
    modelV2Count: modelCount,
    recordedDurationSec: modelDur,
    gpsDurationSec: gpsDur,
  };
}

function qualifySegments(audits) {
  const sorted = [...audits].sort((a, b) => {
    const ta = a.lastTimestamp?.modelV2 || a.firstTimestamp?.modelV2 || '0';
    const tb = b.lastTimestamp?.modelV2 || b.firstTimestamp?.modelV2 || '0';
    return Number(BigInt(ta) - BigInt(tb));
  });

  return sorted.map((audit, i) => {
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    const gapFromPrev = prev
      ? gapSec(prev.lastTimestamp?.modelV2, audit.firstTimestamp?.modelV2)
      : null;
    const gapToNext = next
      ? gapSec(audit.lastTimestamp?.modelV2, next.firstTimestamp?.modelV2)
      : null;
    return classifySegment(audit, { gapFromPrevSec: gapFromPrev, gapToNextSec: gapToNext });
  });
}

module.exports = {
  classifySegment,
  qualifySegments,
  EXPECTED_SEGMENT_DURATION_SEC,
};
