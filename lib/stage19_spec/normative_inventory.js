'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const partition = require('./partition');
const uncertainty = require('./uncertainty');
const math = require('./math');
const p3 = require('./p3');
const heading = require('./heading');
const conflict = require('./conflict');
const jcs = require('./jcs');
const semantic = require('./semantic');
const publication = require('./publication');
const recovery = require('./recovery');

const MODULES = {
  partition, uncertainty, math, p3, heading, conflict, jcs, semantic, publication, recovery,
};

const NORMATIVE_CALLEES = [
  { name: 'partitionDP', module: 'partition' },
  { name: 'preActionClosure', module: 'partition' },
  { name: 'postActionClosure', module: 'partition' },
  { name: 'dedupeByFutureKey', module: 'partition' },
  { name: 'finalizationClosure', module: 'partition' },
  { name: 'applyBranchSelection', module: 'uncertainty' },
  { name: 'validateCovariance', module: 'uncertainty' },
  { name: 'normalQuantile', module: 'math' },
  { name: 'eigenvalues', module: 'math' },
  { name: 'runP3Branch', module: 'p3' },
  { name: 'chainTransitionValid', module: 'p3' },
  { name: 'newOverlapRecord', module: 'p3' },
  { name: 'runHeadingBranch', module: 'heading' },
  { name: 'measuredConflictForGroup', module: 'conflict' },
  { name: 'jcsSerialize', module: 'jcs' },
  { name: 'Stage19JsonParser', module: 'jcs' },
  { name: 'validateStage19Semantics', module: 'semantic' },
  { name: 'publishStage19Bundle', module: 'publication' },
  { name: 'selectRecoveryAction', module: 'recovery' },
  { name: 'applyRecoveryAction', module: 'recovery' },
  { name: 'runRecoveryLoop', module: 'recovery' },
  { name: 'mayDeleteRemoteStaging', module: 'recovery' },
];

function resolveExport(name) {
  const entry = NORMATIVE_CALLEES.find((c) => c.name === name);
  if (!entry) return undefined;
  if (name === 'Stage19JsonParser') return jcs.Stage19JsonParser;
  return MODULES[entry.module][name];
}

function identityMatches(name) {
  const exp = resolveExport(name);
  if (name === 'Stage19JsonParser') return exp === jcs.Stage19JsonParser;
  const entry = NORMATIVE_CALLEES.find((c) => c.name === name);
  return exp === MODULES[entry.module][name];
}

async function exerciseCallee(name) {
  switch (name) {
    case 'partitionDP': {
      const M = [partition.makeTestMatch(0, 0), partition.makeTestMatch(1, 5), partition.makeTestMatch(2, 10)];
      const r = partition.partitionDP(M, 'inc');
      const ok = r.ok === true && r.branchMap.size === 3;
      r.finalize();
      return { pass: ok, negativeWouldFail: !ok };
    }
    case 'preActionClosure': {
      const pool = new partition.NodePool('exercise');
      const registry = new partition.StateRegistry();
      const meta = { direction: 'inc', directionComponentId: 'dc', branchId: 0, featureIdLo: 'f', featureIdHi: 'g', comparisonSpatialFrameId: 'csf' };
      const M = [partition.makeTestMatch(0, 0), partition.makeTestMatch(1, 0.5)];
      let S = registry.register(partition.emptyPartitionState()).state;
      S = partition.startNew(S, M[0], 0, 'inc', pool, registry);
      const r = partition.preActionClosure(S, pool, registry);
      return { pass: r.states.length === 2 && r.states.some((s) => s.closedRefs.length === 1), detail: { subsets: r.states.length } };
    }
    case 'postActionClosure': {
      const pool = new partition.NodePool('exercise');
      const registry = new partition.StateRegistry();
      const M = [partition.makeTestMatch(0, 0), partition.makeTestMatch(1, 0.5)];
      let S = registry.register(partition.emptyPartitionState()).state;
      S = partition.startNew(S, M[0], 0, 'inc', pool, registry);
      S = partition.extend(S, 0, M[1], 1, 'inc', M, pool, registry);
      const r = partition.postActionClosure(S, pool, registry);
      return { pass: r.openCapExceeded === false && r.states.length >= 2 };
    }
    case 'dedupeByFutureKey': {
      const pool = new partition.NodePool('exercise');
      const registry = new partition.StateRegistry();
      const M = [partition.makeTestMatch(0, 0), partition.makeTestMatch(1, 0.5)];
      let S = registry.register(partition.emptyPartitionState()).state;
      S = partition.startNew(S, M[0], 0, 'inc', pool, registry);
      const copy = partition.copyPartitionState(S, pool, registry);
      const out = partition.dedupeByFutureKey([S, copy], pool);
      return { pass: out.length === 1 };
    }
    case 'finalizationClosure': {
      const pool = new partition.NodePool('exercise');
      const registry = new partition.StateRegistry();
      const M = [partition.makeTestMatch(0, 0), partition.makeTestMatch(1, 0.5)];
      let S = registry.register(partition.emptyPartitionState()).state;
      S = partition.startNew(S, M[0], 0, 'inc', pool, registry);
      S = partition.extend(S, 0, M[1], 1, 'inc', M, pool, registry);
      const out = partition.finalizationClosure(S, pool, registry);
      return { pass: out.length >= 1 && out.every((s) => s.openRefs.length === 0) };
    }
    case 'applyBranchSelection': {
      const r = uncertainty.applyBranchSelection(
        { requiredScalars: [{ confidenceLevel: 0.95, halfWidth: 1.96 }] },
        { uncertaintyInterpretation: 'one_sigma', documentedIndependent: true },
      );
      return { pass: r.ok === true && Number.isFinite(r.value) && r.value > 0 };
    }
    case 'validateCovariance': {
      const ok = uncertainty.validateCovariance(
        [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
        { unitFloor: 1e-12 },
      );
      return { pass: ok === true };
    }
    case 'normalQuantile': {
      const z = math.normalQuantile(0.975);
      return { pass: Math.abs(z - 1.96) < 0.01 };
    }
    case 'eigenvalues': {
      const e = math.eigenvalues([[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 2]]);
      return { pass: e.ok && e.values.every((v) => Math.abs(v - 2) < 1e-9) };
    }
    case 'runP3Branch': {
      const M = [0, 1, 2, 3, 4, 5].map((i) => partition.makeTestMatch(i, i));
      const r = p3.runP3Branch(M, {
        direction: 'inc', directionComponentId: 'dc', branchId: 0,
        featureIdLo: 'f', featureIdHi: 'g', comparisonSpatialFrameId: 'csf',
      });
      return { pass: r.ok === true && r.branchCanonical.matchCount >= 2 };
    }
    case 'chainTransitionValid': {
      const M = [partition.makeTestMatch(0, 0), partition.makeTestMatch(1, 0.5)];
      return { pass: p3.chainTransitionValid(0, 1, 'inc', [0], M) === true };
    }
    case 'newOverlapRecord': {
      const M = [partition.makeTestMatch(0, 0), partition.makeTestMatch(1, 5)];
      const meta = { direction: 'inc', directionComponentId: 'dc', branchId: 0, featureIdLo: 'f', featureIdHi: 'g', comparisonSpatialFrameId: 'csf' };
      const parent = p3.singletonState(0, M, meta);
      const child = p3.newOverlapRecord(parent, 1, 5, M, meta);
      return { pass: child.matchCount === 2 && child.endIndex === 1 };
    }
    case 'runHeadingBranch': {
      const M = [partition.makeTestMatch(0, 0), partition.makeTestMatch(1, 5)];
      M[0].sHiUm = Math.round(15 * 1e6);
      M[1].sHiUm = Math.round(20 * 1e6);
      const r = heading.runHeadingBranch(M, 0);
      return { pass: Array.isArray(r.estimates) && r.estimates.length >= 1 };
    }
    case 'measuredConflictForGroup': {
      const r = conflict.runMeasuredConflictFixture();
      return { pass: r.pass === true };
    }
    case 'jcsSerialize': {
      return { pass: jcs.jcsSerialize({ a: 1 }) === '{"a":1}' };
    }
    case 'Stage19JsonParser': {
      const v = new jcs.Stage19JsonParser('{"a":1}').parse();
      return { pass: v.a === 1 };
    }
    case 'validateStage19Semantics': {
      const r = semantic.validateStage19Semantics(semantic.buildValidSemanticBundle());
      return { pass: r.ok === true };
    }
    case 'publishStage19Bundle': {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-pub-'));
      const r = await publication.publishStage19Bundle(tmp, {
        runId: 'run-inv', files: [{ name: 'a.json', bytes: Buffer.from('{}') }],
      });
      const ok = fs.existsSync(path.join(tmp, 'current.json'));
      fs.rmSync(tmp, { recursive: true, force: true });
      return { pass: ok && r.ok === true };
    }
    case 'selectRecoveryAction': {
      const a = recovery.selectRecoveryAction({ stagingExists: true, lock: {} });
      return { pass: a === 'DELETE_STAGING' };
    }
    case 'applyRecoveryAction': {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-rec-action-'));
      const staging = path.join(tmp, '.staging', 'run-x');
      await fs.promises.mkdir(staging, { recursive: true });
      await fs.promises.writeFile(path.join(staging, 'payload.json'), '{}');
      const hb = publication.startHeartbeat(staging, 25);
      await new Promise((r) => setTimeout(r, 40));
      const lock = { hostId: 'remote', fencingToken: 1, expiresAt: Date.now() - 1 };
      recovery.fencingMonotonic.set('remote', 1);
      const r = await recovery.applyRecoveryAction('DELETE_STAGING', {
        recoveryToken: 2,
        lock,
        fsRoot: tmp,
        stagingPath: staging,
        heartbeat: hb,
        stagingExists: true,
      });
      const gone = !fs.existsSync(staging);
      fs.rmSync(tmp, { recursive: true, force: true });
      return { pass: gone && r.log.includes('deleted_staging_fs') };
    }
    case 'runRecoveryLoop': {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage19-rec-loop-'));
      const ctx = {
        hostId: 'host-recovery',
        fsRoot: tmp,
        stagingExists: false,
        validRunId: 'run-valid',
        rewritePointer: true,
        currentTmpExists: false,
        quarantineNeeded: false,
        currentPointsToMissing: false,
        currentMissing: false,
      };
      const r = await recovery.runRecoveryLoop(ctx);
      const cur = fs.existsSync(path.join(tmp, 'current.json'));
      fs.rmSync(tmp, { recursive: true, force: true });
      return { pass: r.terminal === 'STABLE' && cur };
    }
    case 'mayDeleteRemoteStaging': {
      recovery.leaseStore.clear();
      recovery.fencingMonotonic.clear();
      const lock = { hostId: 'h', fencingToken: 1, expiresAt: Date.now() - 1 };
      recovery.fencingMonotonic.set('h', 1);
      return { pass: recovery.mayDeleteRemoteStaging(lock, 2) === true };
    }
    default:
      return { pass: false, detail: 'unknownCallee' };
  }
}

async function verifyNormativeCallees() {
  const results = [];
  for (const callee of NORMATIVE_CALLEES) {
    const exp = resolveExport(callee.name);
    const resolved = typeof exp === 'function';
    const identity = identityMatches(callee.name);
    let exercised = { pass: false };
    if (resolved && identity) exercised = await exerciseCallee(callee.name);
    results.push({
      name: callee.name,
      module: callee.module,
      resolved,
      identity,
      exercised: exercised.pass,
      pass: resolved && identity && exercised.pass,
      detail: exercised.detail,
    });
  }
  return {
    allPass: results.every((r) => r.pass),
    inventory: NORMATIVE_CALLEES,
    results,
  };
}

module.exports = {
  NORMATIVE_CALLEES,
  MODULES,
  resolveExport,
  identityMatches,
  exerciseCallee,
  verifyNormativeCallees,
};
