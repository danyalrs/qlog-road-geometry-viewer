'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
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

const NORMATIVE_CALLEES = [
  { name: 'partitionDP', module: 'partition', exercise: 'partitionDP' },
  { name: 'preActionClosure', module: 'partition', exercise: 'preActionClosure' },
  { name: 'postActionClosure', module: 'partition', exercise: 'postActionClosure' },
  { name: 'dedupeByFutureKey', module: 'partition', exercise: 'dedupeByFutureKey' },
  { name: 'finalizationClosure', module: 'partition', exercise: 'finalizationClosure' },
  { name: 'applyBranchSelection', module: 'uncertainty', exercise: 'applyBranchSelection' },
  { name: 'validateCovariance', module: 'uncertainty', exercise: 'validateCovariance' },
  { name: 'normalQuantile', module: 'math', exercise: 'normalQuantile' },
  { name: 'eigenvalues', module: 'math', exercise: 'eigenvalues' },
  { name: 'runP3Branch', module: 'p3', exercise: 'runP3Branch' },
  { name: 'chainTransitionValid', module: 'p3', exercise: 'chainTransitionValid' },
  { name: 'newOverlapRecord', module: 'p3', exercise: 'newOverlapRecord' },
  { name: 'runHeadingBranch', module: 'heading', exercise: 'runHeadingBranch' },
  { name: 'measuredConflictForGroup', module: 'conflict', exercise: 'measuredConflictForGroup' },
  { name: 'jcsSerialize', module: 'jcs', exercise: 'jcsSerialize' },
  { name: 'Stage19JsonParser', module: 'jcs', exercise: 'Stage19JsonParser' },
  { name: 'validateStage19Semantics', module: 'semantic', exercise: 'validateStage19Semantics' },
  { name: 'publishStage19Bundle', module: 'publication', exercise: 'publishStage19Bundle' },
  { name: 'selectRecoveryAction', module: 'recovery', exercise: 'selectRecoveryAction' },
  { name: 'applyRecoveryAction', module: 'recovery', exercise: 'applyRecoveryAction' },
  { name: 'runRecoveryLoop', module: 'recovery', exercise: 'runRecoveryLoop' },
  { name: 'mayDeleteRemoteStaging', module: 'recovery', exercise: 'mayDeleteRemoteStaging' },
];

async function exerciseCallee(name) {
  switch (name) {
    case 'partitionDP': {
      const M = [
        partition.makeTestMatch(0, 0, 0),
        partition.makeTestMatch(1, 5, 0.1),
      ];
      const r = partition.partitionDP(M, 'inc');
      r.finalize();
      return { pass: r.ok === true, detail: { branchMapSize: r.branchMap?.size } };
    }
    case 'preActionClosure':
    case 'postActionClosure': {
      const pool = new partition.NodePool('exercise');
      const registry = new partition.StateRegistry();
      const S = registry.register(partition.emptyPartitionState()).state;
      const fn = partition[name];
      const r = fn(S, pool, registry);
      return { pass: r.openCapExceeded === false && r.states.length >= 1 };
    }
    case 'dedupeByFutureKey': {
      const pool = new partition.NodePool('exercise');
      const registry = new partition.StateRegistry();
      const S = registry.register(partition.emptyPartitionState()).state;
      const out = partition.dedupeByFutureKey([S], pool);
      return { pass: out.length === 1 };
    }
    case 'finalizationClosure': {
      const pool = new partition.NodePool('exercise');
      const registry = new partition.StateRegistry();
      const S = registry.register(partition.emptyPartitionState()).state;
      const out = partition.finalizationClosure(S, pool, registry);
      return { pass: out.length === 1 && out[0].openRefs.length === 0 };
    }
    case 'applyBranchSelection': {
      const r = uncertainty.applyBranchSelection(
        { requiredScalars: [{ confidenceLevel: 0.95, halfWidth: 1.96 }] },
        { uncertaintyInterpretation: 'one_sigma', documentedIndependent: false },
      );
      return { pass: r.ok === true && r.value > 0 };
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
      const M = [partition.makeTestMatch(0, 0), partition.makeTestMatch(1, 5)];
      const r = p3.runP3Branch(M, {
        direction: 'inc', directionComponentId: 'dc', branchId: 0,
        featureIdLo: 'f', featureIdHi: 'g', comparisonSpatialFrameId: 'csf',
      });
      return { pass: typeof r.ok === 'boolean' };
    }
    case 'chainTransitionValid': {
      const M = [partition.makeTestMatch(0, 0), partition.makeTestMatch(1, 0.5)];
      return { pass: p3.chainTransitionValid(0, 1, 'inc', [0], M) === true };
    }
    case 'newOverlapRecord': {
      const M = [partition.makeTestMatch(0, 0), partition.makeTestMatch(1, 5)];
      const meta = {
        direction: 'inc', directionComponentId: 'dc', branchId: 0,
        featureIdLo: 'f', featureIdHi: 'g', comparisonSpatialFrameId: 'csf',
      };
      const parent = p3.singletonState(0, M, meta);
      const child = p3.newOverlapRecord(parent, 1, 5, M, meta);
      return { pass: child.matchCount === 2 };
    }
    case 'runHeadingBranch': {
      const M = [partition.makeTestMatch(0, 0), partition.makeTestMatch(1, 5)];
      M[0].sHiUm = Math.round(15 * 1e6);
      M[1].sHiUm = Math.round(20 * 1e6);
      const r = heading.runHeadingBranch(M, 0);
      return { pass: Array.isArray(r.estimates) };
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
      const r = await recovery.applyRecoveryAction('NO_OP', { recoveryToken: 1 });
      return { pass: r.stable === true };
    }
    case 'runRecoveryLoop': {
      const r = await recovery.runRecoveryLoop({
        hostId: 'inv', stagingExists: false, rewritePointer: false,
        currentTmpExists: false, quarantineNeeded: false,
        currentPointsToMissing: false, currentMissing: false,
      });
      return { pass: r.terminal === 'STABLE' };
    }
    case 'mayDeleteRemoteStaging': {
      recovery.leaseStore.clear();
      recovery.fencingMonotonic.clear();
      const lock = { hostId: 'h', fencingToken: 1, expiresAt: Date.now() - 1 };
      return { pass: recovery.mayDeleteRemoteStaging(lock, 2) === true };
    }
    default:
      return { pass: false, detail: 'unknownCallee' };
  }
}

const MODULES = {
  partition, uncertainty, math, p3, heading, conflict, jcs, semantic, publication, recovery,
};

function resolveExport(name) {
  const entry = NORMATIVE_CALLEES.find((c) => c.name === name);
  if (!entry) return undefined;
  if (name === 'Stage19JsonParser') return jcs.Stage19JsonParser;
  return MODULES[entry.module][name];
}

async function verifyNormativeCallees() {
  const results = [];
  for (const callee of NORMATIVE_CALLEES) {
    const exp = resolveExport(callee.name);
    const resolved = typeof exp === 'function';
    let exercised = { pass: false };
    if (resolved) exercised = await exerciseCallee(callee.name);
    results.push({
      name: callee.name,
      module: callee.module,
      resolved,
      exercised: exercised.pass,
      pass: resolved && exercised.pass,
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
  exerciseCallee,
  verifyNormativeCallees,
};
