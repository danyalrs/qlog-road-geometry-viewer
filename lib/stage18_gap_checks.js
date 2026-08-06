/**
 * Stage 18 — shared gap / interval overlap helpers.
 */
function gapOverlapsInterval(iv, gap) {
  const onBoundary = iv.leftParentTrackId === gap.parentTrackId
    || iv.rightParentTrackId === gap.parentTrackId;
  if (!onBoundary) return false;
  const lo = Math.max(iv.routeSStart, gap.routeSStart);
  const hi = Math.min(iv.routeSEnd, gap.routeSEnd);
  return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo;
}

module.exports = {
  gapOverlapsInterval,
};
