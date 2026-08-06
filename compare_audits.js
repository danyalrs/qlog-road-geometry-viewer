#!/usr/bin/env node
/**
 * Compare two dataset audit JSON files (e.g. v6b vs v7).
 * Usage: node compare_audits.js audit_dataset_full.json audit_dataset_v7_full.json [out.json]
 */
const fs = require('fs');

const STABILITY_GROUP = new Set([
  0, 1, 3, 4, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 29, 30, 31, 32, 33, 34, 35, 36, 37,
  39, 40, 41, 42, 43, 44, 45, 47, 48, 49, 51, 53, 55, 63, 68, 69, 71, 73, 74, 75, 81, 82, 83, 84,
  85, 86, 87, 88, 89, 90, 91, 93, 94, 98, 100,
]);

function load(p) {
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!Array.isArray(data.results)) {
    throw new Error(`${p} is not a dataset audit file (missing results[])`);
  }
  return data;
}

function byId(results) {
  const m = new Map();
  for (const r of results) {
    if (r.segmentId != null) m.set(r.segmentId, r);
  }
  return m;
}

function main() {
  const [aPath, bPath] = process.argv.slice(2);
  if (!aPath || !bPath) {
    console.error('Usage: node compare_audits.js <baseline.json> <current.json>');
    process.exit(1);
  }
  const a = load(aPath);
  const b = load(bPath);
  const aMap = byId(a.results);
  const bMap = byId(b.results);

  const passChanges = [];
  const regressions = [];
  const improvements = [];

  for (const [id, oldR] of aMap) {
    const newR = bMap.get(id);
    if (!newR || newR.error) continue;
    const dPass = (newR.temporalPassCount ?? 0) - (oldR.temporalPassCount ?? 0);
    const dPoly = (newR.polygonCount ?? 0) - (oldR.polygonCount ?? 0);
    if (dPass !== 0 || dPoly !== 0) {
      const entry = {
        segmentId: id,
        passCountBefore: oldR.temporalPassCount,
        passCountAfter: newR.temporalPassCount,
        passDelta: dPass,
        polygonDelta: dPoly,
        splitBefore: oldR.splitEvents,
        splitAfter: newR.splitEvents,
        suppressedAfter: newR.suppressedReversalCount ?? 0,
        changeReason: explainPassChange(oldR, newR),
        inStabilityGroup: STABILITY_GROUP.has(id),
      };
      passChanges.push(entry);
      if (dPass > 0 || (STABILITY_GROUP.has(id) && dPass !== 0)) regressions.push(entry);
      if (dPass < 0) improvements.push(entry);
    }
  }

  const summary = {
    baselineVersion: a.processingVersion,
    currentVersion: b.processingVersion,
    segmentCount: b.results.length,
    baselineMultiPass: a.multiPassCount,
    currentMultiPass: b.multiPassCount,
    baselineMedianMs: a.medianProcessingMs,
    currentMedianMs: b.medianProcessingMs,
    failuresBefore: a.results.filter((r) => r.error).length,
    failuresAfter: b.results.filter((r) => r.error).length,
    passCountChanges: passChanges.length,
    improvements: improvements.length,
    regressions: regressions.filter((r) => r.passDelta > 0).length,
    stabilityGroupRegressions: regressions.filter((r) => r.inStabilityGroup && r.passDelta > 0),
    largestPassIncreases: [...passChanges].filter((c) => c.passDelta > 0).sort((x, y) => y.passDelta - x.passDelta).slice(0, 10),
    largestPassDecreases: [...passChanges].filter((c) => c.passDelta < 0).sort((x, y) => x.passDelta - y.passDelta).slice(0, 15),
    allPassChanges: passChanges.sort((x, y) => x.passDelta - y.passDelta),
    movementAggregate: {
      baselineSuppressedReversals: 0,
      currentSuppressedReversals: b.results.reduce((n, r) => n + (r.suppressedReversalCount ?? 0), 0),
      currentMovementStates: aggregateMovement(b.results),
    },
  };

  const out = process.argv[4] || 'audit_comparison_v6b_v7.json';
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

function explainPassChange(oldR, newR) {
  const before = oldR.temporalPassCount;
  const after = newR.temporalPassCount;
  if (before === after) return 'unchanged';
  const oldReasons = [...new Set((oldR.splitEvents || []).map((e) => e.reason))].join(',') || 'none';
  const newReasons = [...new Set((newR.splitEvents || []).map((e) => e.reason))].join(',') || 'none';
  const sup = newR.suppressedReversalCount ?? 0;
  if (after < before && sup > 0) {
    return `passes reduced ${before}→${after}; suppressed ${sup} reversal candidate(s); splits now: ${newReasons}; was: ${oldReasons}`;
  }
  if (after < before) {
    return `passes reduced ${before}→${after}; movement-state gating removed splits (${oldReasons} → ${newReasons})`;
  }
  return `passes increased ${before}→${after}; splits: ${newReasons}`;
}

function aggregateMovement(results) {
  const totals = { moving: 0, stationary: 0, creeping: 0, uncertain: 0 };
  for (const r of results) {
    const m = r.movementStates || {};
    for (const k of Object.keys(totals)) totals[k] += m[k] || 0;
  }
  return totals;
}

if (require.main === module) main();
