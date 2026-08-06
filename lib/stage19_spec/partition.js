'use strict';

const { config } = require('./config');
const { sha256, rehash } = require('./crypto_util');
const { jcsUtf8Bytes } = require('./jcs');
const { CanonicalMatchTuple, canonicalMatchId } = require('./canonical');
const {
  tailMatch,
  INIT_TAIL,
  extensionCost,
  UPDATE_TAIL,
  directedStepSupport,
  staticBranchCandidateEdge,
  offsetSignTransitionLegal,
  sign,
  meanLateralOffsetUm,
  tangentLoDeg,
} = require('./geometry');

const REGISTRY_ID = Symbol('registryId');

class NodePool {
  constructor(ownerTag) {
    this.map = new Map();
    this.refcount = new Map();
    this.ownerTag = ownerTag;
    this.borrowed = ownerTag !== 'internal';
    this.destroyed = false;
  }

  get(id) {
    if (!this.map.has(id)) throw new Error('unknownNodeId');
    return this.map.get(id);
  }

  allocate(id, node) {
    if (this.destroyed) throw new Error('poolDestroyed');
    if (this.map.has(id)) throw new Error('duplicateNodeId');
    this.map.set(id, node);
    this.refcount.set(id, 0);
    const pool = this;
    return {
      id,
      committed: false,
      commit() { this.committed = true; },
      discard() { pool.releaseUncommitted(id); },
      pool,
    };
  }

  addRef(id) {
    if (!this.map.has(id)) throw new Error('unknownNodeId');
    this.refcount.set(id, this.refcount.get(id) + 1);
  }

  release(id) {
    if (!this.refcount.has(id)) throw new Error('unknownNodeId');
    const n = this.refcount.get(id) - 1;
    if (n < 0) throw new Error('negativeRefcount');
    if (n === 0) {
      this.map.delete(id);
      this.refcount.delete(id);
    } else {
      this.refcount.set(id, n);
    }
  }

  releaseUncommitted(id) {
    if (this.refcount.get(id) === 0) {
      this.map.delete(id);
      this.refcount.delete(id);
    }
  }

  releaseAll() {
    for (const id of [...this.refcount.keys()]) {
      while (this.refcount.get(id) > 0) this.release(id);
    }
    for (const id of [...this.map.keys()]) {
      if (!this.refcount.has(id)) this.map.delete(id);
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.releaseAll();
    if (this.map.size !== 0) throw new Error('poolNotEmpty');
    this.destroyed = true;
  }

  liveRefcountTotal() {
    let total = 0;
    for (const n of this.refcount.values()) total += n;
    return total;
  }
}

class StateRegistry {
  constructor() {
    this.states = new Map();
    this.nextId = 0;
  }

  register(state) {
    const id = `S${this.nextId++}`;
    state[REGISTRY_ID] = id;
    this.states.set(id, state);
    return { id, state };
  }

  getRegistryId(stateOrId) {
    if (typeof stateOrId === 'string') return stateOrId;
    if (stateOrId && stateOrId[REGISTRY_ID]) return stateOrId[REGISTRY_ID];
    throw new Error('missingRegistryId');
  }

  resolveKeepIds(keepRefs) {
    return keepRefs.map((r) => this.getRegistryId(r));
  }

  has(id) {
    return this.states.has(id);
  }

  size() {
    return this.states.size;
  }

  releaseExcept(keepRefs, pool) {
    const keep = new Set(this.resolveKeepIds(keepRefs));
    for (const [id, state] of [...this.states.entries()]) {
      if (!keep.has(id)) {
        releaseOwnedNodes(state, pool);
        delete state[REGISTRY_ID];
        delete state._nodeOwnership;
        this.states.delete(id);
      }
    }
  }
}

function emptyPartitionState() {
  return {
    openRefs: [],
    closedRefs: [],
    processedIndex: -1,
    numPaths: 0,
    totalExtensionCost: 0,
    partialPartitionHash: sha256('empty'),
  };
}

function initNodeOwnership(state) {
  if (!state._nodeOwnership) state._nodeOwnership = new Map();
  return state._nodeOwnership;
}

function ownNodeRef(state, pool, nodeId, count = 1) {
  const own = initNodeOwnership(state);
  pool.addRef(nodeId);
  own.set(nodeId, (own.get(nodeId) || 0) + count);
}

function releaseOwnedNodes(state, pool) {
  const own = state._nodeOwnership;
  if (!own) return;
  for (const [id, count] of own.entries()) {
    for (let i = 0; i < count; i++) pool.release(id);
  }
  own.clear();
}

function transferNodeOwnership(from, to, nodeId) {
  const fromOwn = initNodeOwnership(from);
  const toOwn = initNodeOwnership(to);
  const count = fromOwn.get(nodeId) || 0;
  if (count > 0) {
    fromOwn.delete(nodeId);
    toOwn.set(nodeId, (toOwn.get(nodeId) || 0) + count);
  }
}

function copyPartitionState(S, pool, registry) {
  const S2 = {
    openRefs: S.openRefs.map((r) => ({ provisionalPathId: r.provisionalPathId })),
    closedRefs: S.closedRefs.map((r) => ({ provisionalPathId: r.provisionalPathId })),
    processedIndex: S.processedIndex,
    numPaths: S.numPaths,
    totalExtensionCost: S.totalExtensionCost,
    partialPartitionHash: S.partialPartitionHash,
    _nodeOwnership: new Map(),
  };
  for (const r of [...S2.openRefs, ...S2.closedRefs]) ownNodeRef(S2, pool, r.provisionalPathId);
  return registry.register(S2).state;
}

function assignedIdsOfState(S, pool) {
  const ids = new Set();
  for (const r of [...S.openRefs, ...S.closedRefs]) {
    for (const id of pool.get(r.provisionalPathId).canonicalMatchIds) ids.add(id);
  }
  return ids;
}

function betterPartitionState(a, b) {
  if (a.numPaths !== b.numPaths) return a.numPaths < b.numPaths ? -1 : 1;
  if (a.totalExtensionCost !== b.totalExtensionCost) {
    return a.totalExtensionCost < b.totalExtensionCost ? -1 : 1;
  }
  return a.partialPartitionHash < b.partialPartitionHash ? -1 : 1;
}

function futureKeyPayload(S, pool) {
  const closedAssignedIds = [];
  const seen = new Set();
  for (const r of S.closedRefs) {
    for (const id of pool.get(r.provisionalPathId).canonicalMatchIds) {
      if (!seen.has(id)) {
        seen.add(id);
        closedAssignedIds.push(id);
      }
    }
  }
  closedAssignedIds.sort();
  const openPaths = S.openRefs.map((r) => {
    const n = pool.get(r.provisionalPathId);
    return {
      provisionalPathId: r.provisionalPathId,
      memberIds: n.canonicalMatchIds.slice().sort(),
      tailLocalIndex: n.tailLocalIndex,
      tailStateKey: n.tailStateKey,
      pathSeedId: n.pathSeedId,
    };
  }).sort((a, b) => a.provisionalPathId.localeCompare(b.provisionalPathId));
  return { closedAssignedIds, openPaths };
}

function futureKey(S, pool) {
  return sha256(jcsUtf8Bytes(futureKeyPayload(S, pool)));
}

function dedupeByFutureKey(candidates, pool) {
  const best = new Map();
  for (const S of candidates) {
    const k = futureKey(S, pool);
    const prev = best.get(k);
    if (!prev || betterPartitionState(S, prev) < 0) best.set(k, S);
  }
  return [...best.values()];
}

function closureSubsets(S) {
  const n = S.openRefs.length;
  if (n > config.maxOpenPathsPerState) return { rejected: true, subsets: [] };
  const total = 1 << n;
  if (total > config.maxClosureSubsetsPerState) return { rejected: true, subsets: [] };
  const subsets = [];
  for (let mask = 0; mask < total; mask++) {
    const C = [];
    for (let b = 0; b < n; b++) if (mask & (1 << b)) C.push(b);
    subsets.push(C);
  }
  return { rejected: false, subsets };
}

function closeInPlace(S, C) {
  const n = S.openRefs.length;
  const setC = new Set();
  for (const t of C) {
    if (t < 0 || t >= n) throw new Error('partitionCloseInvalidIndexSetError');
    if (setC.has(t)) throw new Error('partitionCloseInvalidIndexSetError');
    setC.add(t);
  }
  const refsToClose = C.map((t) => S.openRefs[t]);
  const closedOrder = refsToClose.slice().sort((a, b) => a.provisionalPathId.localeCompare(b.provisionalPathId));
  S.openRefs = S.openRefs.filter((_, idx) => !setC.has(idx));
  S.closedRefs = S.closedRefs.concat(closedOrder);
  S.partialPartitionHash = rehash(S.partialPartitionHash, 'close', { C: C.slice().sort((a, b) => a - b) });
  return S;
}

function preActionClosure(S, pool, registry) {
  const { rejected, subsets } = closureSubsets(S);
  if (rejected) return { openCapExceeded: true, states: [] };
  const states = [];
  for (const C of subsets) {
    const copy = copyPartitionState(S, pool, registry);
    states.push(closeInPlace(copy, C));
  }
  return { openCapExceeded: false, states };
}

function postActionClosure(S, pool, registry) {
  return preActionClosure(S, pool, registry);
}

function finalizationClosure(S, pool, registry) {
  const n = S.openRefs.length;
  if (n === 0) return [S];
  const all = [];
  for (let mask = 1; mask < (1 << n); mask++) {
    const C = [];
    for (let b = 0; b < n; b++) if (mask & (1 << b)) C.push(b);
    const copy = copyPartitionState(S, pool, registry);
    all.push(closeInPlace(copy, C));
  }
  return all.filter((s) => s.openRefs.length === 0);
}

function buildOpenPathNode(tuples, ids, tailIndex, tailKey, dir, pool, disambiguator) {
  const pathSeedId = sha256(jcsUtf8Bytes(tuples));
  const provisionalPathId = sha256(jcsUtf8Bytes({ pathSeedId, tailKey, tailIndex, ids, disambiguator }));
  const node = {
    provisionalPathId,
    pathSeedId,
    direction: dir,
    orderedMemberTuples: tuples.slice(),
    canonicalMatchIds: ids.slice(),
    tailLocalIndex: tailIndex,
    tailStateKey: tailKey,
    accumulatedExtensionCost: 0,
    accumulatedSupportedLengthM: 0,
  };
  const handle = pool.allocate(provisionalPathId, node);
  return { node, handle };
}

function pathExtensionValid(node, m, i, dir, M, S, pool) {
  const a = tailMatch(node, M);
  if (!staticBranchCandidateEdge(a, m, dir)) return false;
  if (assignedIdsOfState(S, pool).has(canonicalMatchId(m))) return false;
  const latDelta = meanLateralOffsetUm(m) - meanLateralOffsetUm(a);
  if (!offsetSignTransitionLegal(node.tailStateKey.offsetSignHistoryBits3, sign(latDelta))) return false;
  const oldBin = node.tailStateKey.tangentBin;
  const newBin = Math.round(tangentLoDeg(m) / config.headingTangentQuantizeDeg);
  const maxBinDelta = Math.ceil(config.maxLocalHeadingDeltaDeg / config.headingTangentQuantizeDeg);
  return Math.abs(oldBin - newBin) <= maxBinDelta;
}

function startNew(S, m, i, dir, pool, registry) {
  const S2 = copyPartitionState(S, pool, registry);
  const tuple = CanonicalMatchTuple(m);
  const id = canonicalMatchId(m);
  const { node, handle } = buildOpenPathNode(
    [tuple], [id], i, INIT_TAIL(m), dir, pool, registry.getRegistryId(S2),
  );
  ownNodeRef(S2, pool, node.provisionalPathId);
  handle.commit();
  S2.openRefs.push({ provisionalPathId: node.provisionalPathId });
  S2.processedIndex = i;
  S2.numPaths += 1;
  S2.partialPartitionHash = rehash(S2.partialPartitionHash, 'startNew', { i, id });
  return S2;
}

function extend(S, refIndex, m, i, dir, M, pool, registry) {
  const S2 = copyPartitionState(S, pool, registry);
  const oldId = S2.openRefs[refIndex].provisionalPathId;
  const oldNode = pool.get(oldId);
  if (!pathExtensionValid(oldNode, m, i, dir, M, S2, pool)) throw new Error('invalidExtend');
  const tuple = CanonicalMatchTuple(m);
  const id = canonicalMatchId(m);
  const tuples = oldNode.orderedMemberTuples.concat([tuple]);
  const ids = oldNode.canonicalMatchIds.concat([id]);
  const tailKey = UPDATE_TAIL(oldNode, m, dir, M);
  const step = directedStepSupport(tailMatch(oldNode, M), m, dir);
  const cost = extensionCost(oldNode, m, dir, M);
  const newId = sha256(jcsUtf8Bytes({
    prev: oldNode.provisionalPathId, i, id, tailKey, disambiguator: registry.getRegistryId(S2),
  }));
  const newNode = {
    provisionalPathId: newId,
    pathSeedId: oldNode.pathSeedId,
    direction: dir,
    orderedMemberTuples: tuples,
    canonicalMatchIds: ids,
    tailLocalIndex: i,
    tailStateKey: tailKey,
    accumulatedExtensionCost: oldNode.accumulatedExtensionCost + cost,
    accumulatedSupportedLengthM: oldNode.accumulatedSupportedLengthM + step,
  };
  const handle = pool.allocate(newId, newNode);
  ownNodeRef(S2, pool, newId);
  handle.commit();
  const own = initNodeOwnership(S2);
  const oldCount = own.get(oldId) || 0;
  if (oldCount > 0) {
    own.set(oldId, oldCount - 1);
    pool.release(oldId);
    if (own.get(oldId) === 0) own.delete(oldId);
  }
  S2.openRefs[refIndex] = { provisionalPathId: newId };
  S2.processedIndex = i;
  S2.totalExtensionCost += cost;
  S2.partialPartitionHash = rehash(S2.partialPartitionHash, 'extend', { i, id });
  return S2;
}

function releaseStateRefs(S, pool) {
  releaseOwnedNodes(S, pool);
}

function releaseRawAssignment(S, pool) {
  releaseStateRefs(S, pool);
}

function releaseClosureBatch(states, pool) {
  for (const S of states) releaseStateRefs(S, pool);
}

function extractBranchAssignments(terminal, pool, M) {
  const map = new Map();
  let branchId = 0;
  for (const r of terminal.closedRefs) {
    const node = pool.get(r.provisionalPathId);
    for (const id of node.canonicalMatchIds) map.set(id, branchId);
    branchId += 1;
  }
  return map;
}

function pickFailureCode(flags) {
  if (flags.openCap) return 'open_cap_exceeded';
  if (flags.geometric) return 'no_geometric_cover';
  return 'no_terminal_partition';
}

function partitionDP(M, dir, poolIn, options = {}) {
  const audit = options.audit || null;
  const internal = poolIn == null;
  const pool = poolIn ?? new NodePool('internal');
  const registry = new StateRegistry();
  let cleaned = false;
  let terminal = null;
  let branchMap = null;
  let finalized = false;

  function cleanupOnce() {
    if (cleaned) return;
    registry.releaseExcept([], pool);
    if (internal) {
      pool.releaseAll();
      pool.destroy();
    }
    cleaned = true;
  }

  try {
    const n = M.length;
    const initial = registry.register(emptyPartitionState()).state;
    const layers = [[initial]];
    const flags = { overflow: false, openCap: false, geometric: false };

    for (let i = 0; i < n; i++) {
      let nextCandidates = [];
      let anyGeom = false;

      for (const S of layers[i]) {
        const pre = preActionClosure(S, pool, registry);
        if (pre.openCapExceeded) {
          flags.openCap = true;
          releaseClosureBatch(pre.states, pool);
          continue;
        }

        for (const S_pre of pre.states) {
          const assigned = [];
          try {
            assigned.push(startNew(S_pre, M[i], i, dir, pool, registry));
            anyGeom = true;
            for (let refIndex = 0; refIndex < S_pre.openRefs.length; refIndex++) {
              const oldNode = pool.get(S_pre.openRefs[refIndex].provisionalPathId);
              if (pathExtensionValid(oldNode, M[i], i, dir, M, S_pre, pool)) {
                assigned.push(extend(S_pre, refIndex, M[i], i, dir, M, pool, registry));
                anyGeom = true;
              }
            }
            for (const S_assign of assigned) {
              try {
                const post = postActionClosure(S_assign, pool, registry);
                if (post.openCapExceeded) {
                  flags.openCap = true;
                  releaseClosureBatch(post.states, pool);
                } else {
                  nextCandidates = nextCandidates.concat(post.states);
                }
              } finally {
                releaseRawAssignment(S_assign, pool);
              }
            }
          } catch (e) {
            for (const S_assign of assigned) releaseRawAssignment(S_assign, pool);
            throw e;
          } finally {
            releaseStateRefs(S_pre, pool);
          }
        }
      }

      if (!anyGeom) flags.geometric = true;
      const survivors = dedupeByFutureKey(nextCandidates, pool);
      if (audit) {
        audit.beforeReleaseExcept(i, nextCandidates, survivors, registry, pool);
      }
      if (survivors.length > config.B_partition) {
        cleanupOnce();
        return {
          ok: false,
          direction: null,
          terminal: null,
          branchMap: null,
          pool,
          registry,
          borrowed: !internal,
          failure: { code: 'overflow', ...flags },
          finalize() {
            if (!finalized) finalized = true;
          },
        };
      }
      registry.releaseExcept(survivors, pool);
      if (audit) {
        audit.afterReleaseExcept(i, survivors, registry, pool);
      }
      layers[i + 1] = survivors;
    }

    let finalCandidates = [];
    for (const S of layers[n]) {
      finalCandidates = finalCandidates.concat(finalizationClosure(S, pool, registry));
    }
    const terminals = dedupeByFutureKey(finalCandidates, pool).filter((S) => S.openRefs.length === 0);

    if (terminals.length === 0) {
      cleanupOnce();
      return {
        ok: false,
        direction: null,
        terminal: null,
        branchMap: null,
        pool,
        registry,
        borrowed: !internal,
        failure: { code: pickFailureCode(flags), ...flags },
        finalize() {
          if (!finalized) finalized = true;
        },
      };
    }

    terminal = terminals[0];
    for (let t = 1; t < terminals.length; t++) {
      if (betterPartitionState(terminals[t], terminal) < 0) terminal = terminals[t];
    }
    branchMap = extractBranchAssignments(terminal, pool, M);
    for (const m of M) {
      if (!branchMap.has(canonicalMatchId(m))) throw new Error('incompleteBranchMap');
    }

    return {
      ok: true,
      direction: dir,
      terminal,
      branchMap,
      pool,
      registry,
      borrowed: !internal,
      failure: null,
      finalize() {
        if (finalized) return;
        finalized = true;
        if (terminal) {
          releaseStateRefs(terminal, pool);
          terminal = null;
        }
        registry.releaseExcept([], pool);
        if (internal) {
          pool.releaseAll();
          pool.destroy();
        }
      },
    };
  } catch (e) {
    cleanupOnce();
    throw e;
  }
}

function makeTestMatch(i, sLo, latUm = 0) {
  return {
    comparisonSpatialFrameId: 'csf-0',
    featureIdLo: 'f-lo',
    featureIdHi: 'f-hi',
    temporalPassIdLo: 'p-lo',
    temporalPassIdHi: 'p-hi',
    sLoUm: Math.round(sLo * 1e6),
    sHiUm: Math.round((sLo + 10) * 1e6),
    sampleIndexLo: i,
    sampleIndexHi: i + 1,
    eLoUm: 0,
    nLoUm: Math.round(latUm * 1e6),
    uLoUm: 0,
    eHiUm: 0,
    nHiUm: Math.round(latUm * 1e6),
    uHiUm: 0,
    meanLateralOffsetUm: Math.round(latUm * 1e6),
    headingDegLo: 0,
    tangentLoDeg: 0,
    evidenceUnitKey: `eu-${i}`,
    featurePairId: `fp-${i}`,
  };
}

function assertKeeperNodesReachable(survivors, registry, pool) {
  for (const S of survivors) {
    const id = registry.getRegistryId(S);
    if (!registry.has(id)) throw new Error('survivorNotRegistered');
    for (const r of [...S.openRefs, ...S.closedRefs]) {
      if (!pool.map.has(r.provisionalPathId)) throw new Error('keeperNodeMissing');
    }
  }
}

function runPartitionLayerOwnershipTests() {
  const M = [
    makeTestMatch(0, 0, 0),
    makeTestMatch(1, 5, 0.1),
    makeTestMatch(2, 10, 0.2),
  ];
  const checks = [];
  const rejectedIds = [];
  const audit = {
    beforeReleaseExcept(layer, candidates, survivors, registry) {
      const keep = new Set(survivors.map((s) => registry.getRegistryId(s)));
      for (const [id] of registry.states) {
        if (!keep.has(id) && !candidates.some((c) => registry.getRegistryId(c) === id)) {
          rejectedIds.push({ layer, id });
        }
      }
    },
    afterReleaseExcept(layer, survivors, registry, pool) {
      try {
        assertKeeperNodesReachable(survivors, registry, pool);
        checks.push({ name: `layer-${layer}-keepers-reachable`, pass: true });
      } catch (e) {
        checks.push({ name: `layer-${layer}-keepers-reachable`, pass: false, error: e.message });
      }
      const allRegistered = survivors.every((S) => registry.has(registry.getRegistryId(S)));
      checks.push({ name: `layer-${layer}-survivor-registered`, pass: allRegistered });
    },
  };
  const result = partitionDP(M, 'inc', null, { audit });
  checks.push({ name: 'full-dp-completes', pass: result.ok === true });
  const refsBefore = result.pool.liveRefcountTotal();
  result.finalize();
  checks.push({ name: 'finalize-zero-refs', pass: result.pool.liveRefcountTotal() === 0 });
  checks.push({ name: 'finalize-empty-registry', pass: result.registry.size() === 0 });
  checks.push({ name: 'no-negative-refcount', pass: refsBefore >= 0 });
  return { allPass: checks.every((c) => c.pass), results: checks, rejectedIds };
}

function runPartitionRegistryTests() {
  const M = [
    makeTestMatch(0, 0, 0),
    makeTestMatch(1, 5, 0.1),
    makeTestMatch(2, 10, 0.2),
  ];
  const result = partitionDP(M, 'inc');
  const checks = [];
  try {
    checks.push({
      name: 'partition-completes',
      pass: result.ok === true,
    });
    checks.push({
      name: 'terminal-has-registry-id',
      pass: result.terminal && result.registry.has(result.registry.getRegistryId(result.terminal)),
    });
    checks.push({
      name: 'branch-map-covers-all-matches',
      pass: result.branchMap && result.branchMap.size === M.length,
    });
    const refsBefore = result.pool.liveRefcountTotal();
    result.finalize();
    checks.push({
      name: 'finalize-zero-refs',
      pass: result.pool.liveRefcountTotal() === 0,
    });
    checks.push({
      name: 'finalize-idempotent',
      pass: (result.finalize(), true),
    });
    checks.push({
      name: 'registry-empty-after-finalize',
      pass: result.registry.size() === 0,
    });
    checks.push({ name: 'no-negative-refcount', pass: refsBefore >= 0 });
  } catch (e) {
    checks.push({ name: 'partition-exception', pass: false, error: e.message });
  }
  return { allPass: checks.every((c) => c.pass), results: checks };
}

function runPartitionOwnershipTests() {
  const results = [];
  const pool = new NodePool('test');
  const handle = pool.allocate('n1', { canonicalMatchIds: ['a'] });
  handle.discard();
  let destroyOk = true;
  try {
    pool.destroy();
  } catch (e) {
    destroyOk = false;
  }
  results.push({ name: 'abandoned-allocation-discard', pass: destroyOk });

  const pool2 = new NodePool('test2');
  const h2 = pool2.allocate('n2', { canonicalMatchIds: ['b'] });
  pool2.addRef('n2');
  h2.commit();
  pool2.release('n2');
  let destroy2Ok = true;
  try {
    pool2.destroy();
  } catch (e) {
    destroy2Ok = false;
  }
  results.push({ name: 'committed-ref-released', pass: destroy2Ok });

  const pool3 = new NodePool('test3');
  const h3 = pool3.allocate('n3', { canonicalMatchIds: ['c'] });
  pool3.addRef('n3');
  h3.commit();
  let doubleRelease = false;
  try {
    pool3.release('n3');
    pool3.release('n3');
  } catch (e) {
    doubleRelease = e.message === 'negativeRefcount' || e.message === 'unknownNodeId';
  }
  results.push({ name: 'double-release-throws', pass: doubleRelease });

  const registryTests = runPartitionRegistryTests();
  results.push({ name: 'partition-dp-registry', pass: registryTests.allPass });
  const layerTests = runPartitionLayerOwnershipTests();
  results.push({ name: 'partition-layer-ownership', pass: layerTests.allPass });

  return { allPass: results.every((r) => r.pass), results };
}

module.exports = {
  REGISTRY_ID,
  NodePool,
  StateRegistry,
  emptyPartitionState,
  copyPartitionState,
  assignedIdsOfState,
  betterPartitionState,
  futureKeyPayload,
  futureKey,
  dedupeByFutureKey,
  closureSubsets,
  closeInPlace,
  preActionClosure,
  postActionClosure,
  finalizationClosure,
  buildOpenPathNode,
  pathExtensionValid,
  startNew,
  extend,
  releaseStateRefs,
  releaseRawAssignment,
  releaseClosureBatch,
  extractBranchAssignments,
  pickFailureCode,
  partitionDP,
  makeTestMatch,
  runPartitionRegistryTests,
  runPartitionLayerOwnershipTests,
  runPartitionOwnershipTests,
  initNodeOwnership,
  ownNodeRef,
  releaseOwnedNodes,
};
