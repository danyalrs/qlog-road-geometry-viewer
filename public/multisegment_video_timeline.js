'use strict';

const QLOG_SEGMENT_RE = /^qlog_f449c_(\d+)\.bz2$/i;
const timing = () => window.SegmentVideoTiming;

function parseSourceSegmentId(sourceQlogName) {
  if (!sourceQlogName) return null;
  const match = String(sourceQlogName).match(QLOG_SEGMENT_RE);
  return match ? match[1] : null;
}

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
      const sourceSegmentId = parseSourceSegmentId(sourceQlogName);
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

  const computeElapsed = timing()?.computeLocalElapsedSeconds;
  if (!computeElapsed) return entries;

  for (const entry of entries) {
    entry.globalStartTimeS = computeElapsed(entry.segmentStartLogMonoTime, combinedStartLogMonoTime) ?? 0;
    entry.globalEndTimeS = computeElapsed(entry.segmentEndLogMonoTime, combinedStartLogMonoTime)
      ?? entry.globalStartTimeS;
    entry.localStartTimeS = 0;
    entry.localEndTimeS = computeElapsed(entry.segmentEndLogMonoTime, entry.segmentStartLogMonoTime) ?? 0;
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
  const computeElapsed = timing()?.computeLocalElapsedSeconds;
  if (!computeElapsed) return 0;
  return computeElapsed(currentLogMonoTime, segmentStartLogMonoTime) ?? 0;
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
  const computeExpected = timing()?.computeExpectedVideoTime;
  if (!computeExpected || !provenance) return null;
  return computeExpected(provenance.sourceLocalTimeS, videoStartOffsetSeconds);
}

window.MultisegmentVideoTimeline = {
  parseSourceSegmentId,
  buildSegmentVideoTimeline,
  resolveTimelineEntryForIndex,
  computeSegmentLocalTimeS,
  resolvePlaybackProvenance,
  resolveExpectedVideoTime,
};
