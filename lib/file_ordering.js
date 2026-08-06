/** Determine chronological file order from log data, not lexicographic names. */

function analyzeFile(modelEvents, gpsEvents, sourceFile) {
  const models = modelEvents.filter((e) => e.sourceFile === sourceFile);
  const gps = gpsEvents.filter((e) => e.sourceFile === sourceFile);
  const allTimes = [
    ...models.map((e) => BigInt(e.logMonoTime)),
    ...gps.map((e) => BigInt(e.logMonoTime)),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const validGps = gps.filter((g) =>
    g.flags > 0 && Math.abs(g.latitude) > 0.0001 && Math.abs(g.longitude) > 0.0001
  );

  return {
    sourceFile,
    modelCount: models.length,
    gpsCount: gps.length,
    firstLogMonoTime: allTimes.length ? allTimes[0].toString() : null,
    lastLogMonoTime: allTimes.length ? allTimes[allTimes.length - 1].toString() : null,
    firstGpsTime: validGps.length ? validGps[0].logMonoTime : null,
    lastGpsTime: validGps.length ? validGps[validGps.length - 1].logMonoTime : null,
    firstGps: validGps.length ? { lat: validGps[0].latitude, lon: validGps[0].longitude } : null,
    lastGps: validGps.length
      ? { lat: validGps[validGps.length - 1].latitude, lon: validGps[validGps.length - 1].longitude }
      : null,
    sessionId: sourceFile.replace(/\.bz2$/i, ''),
  };
}

function sortFilesByLogTime(modelEvents, gpsEvents, files) {
  const analyses = files.map((f) => analyzeFile(modelEvents, gpsEvents, f));
  analyses.sort((a, b) => {
    const ta = a.firstLogMonoTime ? BigInt(a.firstLogMonoTime) : 0n;
    const tb = b.firstLogMonoTime ? BigInt(b.firstLogMonoTime) : 0n;
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    const na = parseInt(a.sourceFile.match(/_(\d+)\.bz2$/i)?.[1] ?? '0', 10);
    const nb = parseInt(b.sourceFile.match(/_(\d+)\.bz2$/i)?.[1] ?? '0', 10);
    return na - nb;
  });
  return analyses;
}

function detectOverlaps(analyses) {
  const overlaps = [];
  for (let i = 0; i < analyses.length; i++) {
    for (let j = i + 1; j < analyses.length; j++) {
      const a = analyses[i];
      const b = analyses[j];
      if (!a.firstLogMonoTime || !b.firstLogMonoTime) continue;
      const a0 = BigInt(a.firstLogMonoTime);
      const a1 = BigInt(a.lastLogMonoTime);
      const b0 = BigInt(b.firstLogMonoTime);
      const b1 = BigInt(b.lastLogMonoTime);
      if (a0 <= b1 && b0 <= a1) {
        overlaps.push({ fileA: a.sourceFile, fileB: b.sourceFile });
      }
    }
  }
  return overlaps;
}

function detectOrderingUncertainty(analyses) {
  const uncertain = [];
  for (let i = 1; i < analyses.length; i++) {
    const prev = analyses[i - 1];
    const curr = analyses[i];
    if (!prev.lastLogMonoTime || !curr.firstLogMonoTime) continue;
    if (BigInt(curr.firstLogMonoTime) < BigInt(prev.lastLogMonoTime)) {
      uncertain.push({ file: curr.sourceFile, reason: 'starts_before_previous_ends' });
    }
  }
  return uncertain;
}

module.exports = {
  analyzeFile,
  sortFilesByLogTime,
  detectOverlaps,
  detectOrderingUncertainty,
};
