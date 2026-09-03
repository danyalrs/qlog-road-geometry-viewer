'use strict';

const { parseSegmentIdFromQlogFilename, computeLocalElapsedSeconds } = require('./segment_video');

/**
 * Build ordered video timeline entries from combined playback timeline.
 * Order follows combined arrow/map playback (logMonoTime order), not DOM selection order.
 */
function buildSegmentVideoTimeline(timeline, selectedQlogs = []) {
  if (!timeline?.length) return [];

  const combinedStartLogMonoTime = timeline[0].logMonoTime;
  const entries = [];
  let current = null;

  for (let i = 0; i < timeline.length; i++) {
    const t = timeline[i];
    const sourceQlogName = t.sourceFile;
    if (!sourceQlogName) continue;

    if (!current || current.sourceQlogName !== sourceQlogName) {
      if (current) entries.push(current);
      const sourceSegmentId = parseSegmentIdFromQlogFilename(sourceQlogName);
      const selectionIdx = Array.isArray(selectedQlogs)
        ? selectedQlogs.indexOf(sourceQlogName)
        : -1;
      current = {
        sourceSegmentId,
        sourceQlogName,
        sourceSelectionIndex: selectionIdx >= 0 ? selectionIdx : entries.length,
        videoUrl: null,
        globalStartTimeS: 0,
        globalEndTimeS: 0,
        localStartTimeS: 0,
        localEndTimeS: 0,
        segmentStartLogMonoTime: t.logMonoTime,
        segmentEndLogMonoTime: t.logMonoTime,
        timelineStartIdx: i,
        timelineEndIdx: i,
        videoStartOffsetSeconds: 0,
        durationSec: null,
      };
    }
    current.timelineEndIdx = i;
    current.segmentEndLogMonoTime = t.logMonoTime;
  }
  if (current) entries.push(current);

  for (const entry of entries) {
    entry.globalStartTimeS = computeLocalElapsedSeconds(
      entry.segmentStartLogMonoTime,
      combinedStartLogMonoTime,
    ) ?? 0;
    entry.globalEndTimeS = computeLocalElapsedSeconds(
      entry.segmentEndLogMonoTime,
      combinedStartLogMonoTime,
    ) ?? entry.globalStartTimeS;
    entry.localStartTimeS = 0;
    entry.localEndTimeS = computeLocalElapsedSeconds(
      entry.segmentEndLogMonoTime,
      entry.segmentStartLogMonoTime,
    ) ?? 0;
  }

  return entries;
}

function resolveTimelineEntryForIndex(entries, timelineIdx) {
  if (!entries?.length || timelineIdx == null) return null;
  const idx = Number(timelineIdx);
  if (!Number.isFinite(idx)) return null;
  return entries.find((e) => idx >= e.timelineStartIdx && idx <= e.timelineEndIdx) || null;
}

function computeSegmentLocalTimeS(currentLogMonoTime, segmentStartLogMonoTime) {
  return computeLocalElapsedSeconds(currentLogMonoTime, segmentStartLogMonoTime) ?? 0;
}

function resolvePlaybackProvenance(timeline, timelineIdx, selectedQlogs, currentLogMonoTime, entries = null) {
  const timelineEntries = entries || buildSegmentVideoTimeline(timeline, selectedQlogs);
  const entry = resolveTimelineEntryForIndex(timelineEntries, timelineIdx);
  if (!entry) return null;

  const sourceLocalTimeS = currentLogMonoTime != null
    ? computeSegmentLocalTimeS(currentLogMonoTime, entry.segmentStartLogMonoTime)
    : 0;

  return {
    sourceSegmentId: entry.sourceSegmentId,
    sourceQlogName: entry.sourceQlogName,
    sourceSelectionIndex: entry.sourceSelectionIndex,
    sourceLocalTimeS,
    sourceVideoUrl: entry.videoUrl,
    segmentStartLogMonoTime: entry.segmentStartLogMonoTime,
    timelineIndex: timelineIdx,
    globalStartTimeS: entry.globalStartTimeS,
    globalEndTimeS: entry.globalEndTimeS,
    videoStartOffsetSeconds: entry.videoStartOffsetSeconds,
    durationSec: entry.durationSec,
  };
}

function resolveExpectedVideoTime(provenance, videoStartOffsetSeconds) {
  const offset = Number(videoStartOffsetSeconds) || 0;
  const local = Number(provenance?.sourceLocalTimeS);
  if (!Number.isFinite(local)) return null;
  return Math.max(0, local + offset);
}

module.exports = {
  buildSegmentVideoTimeline,
  resolveTimelineEntryForIndex,
  computeSegmentLocalTimeS,
  resolvePlaybackProvenance,
  resolveExpectedVideoTime,
};
