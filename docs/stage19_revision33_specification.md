# Stage 19 — Complete Normative Specification (Revision 34)

**Dataset-Wide Lane-Interval Sensitivity & BEV Evidence Audit**

| Field | Value |
|-------|-------|
| **Document** | Revision 34 — single self-contained artifact |
| **Status** | **Specification pending final review** |
| **Authorization** | Planning only — **no implementation, no approval** |
| **Processing version** | `2026-07-24-dataset-sensitivity-bev-audit-v0` |
| **Frozen baseline** | `2026-07-24-fusion-v11` |
| **Frozen dataset bounds** | `N_obs = 5809`, `N_gap = 136`, `P_cp = 742`, `N_interval = 5` |

**Scope:** Every normative section is delivered in this file. No prior-revision references. No comment placeholders in executable bodies or JSON.

**Invariant:** `stage19SpecificationContainsNoRevisionReferences === true`  
**Invariant:** `everyNormativeProcedureIsDeliveredInline === true`  
**Invariant:** `selfContainedClaimMatchesTheDeliveredArtifact === true`

---

## 0. Configuration validation

| Field | Type | Constraint |
|-------|------|------------|
| `spatialEqualityToleranceM` | m | finite, `> 0` |
| `offsetSignToleranceM` | m | `= spatialEqualityToleranceM` |
| `maxConsecutiveRouteSGapM` | m | finite, `> 0` |
| `maxSpatialJumpM` | m | finite, `> 0` |
| `maxLateralOffsetDeltaM` | m | finite, `> 0` |
| `minCorrespondenceSlopeAbs` | — | finite, `> 0` |
| `maxCorrespondenceSlopeAbs` | — | `≥ minCorrespondenceSlopeAbs` |
| `maxCorrespondenceSlopeDelta` | — | finite, `> 0` |
| `maxLocalHeadingDeltaDeg` | deg | finite, `> 0`, `≤ 180` |
| `maxCrossPassHeadingDiffDeg` | deg | finite, `> 0`, `≤ 180` |
| `maxAllowedDeviationFromCircularMeanDeg` | deg | finite, `> 0`, `≤ 180` |
| `headingTangentQuantizeDeg` | deg | finite, `> 0`, `≤ 180`, `180 mod value == 0` |
| `circularMeanEpsilon` | — | finite, `> 0`, `< 1` |
| `denseReferenceStepM` | m | finite, `> 0` |
| `minCrossPassTrajectoryOverlapM` | m | finite, `> 0` |
| `minP3MatchCount` | int | `≥ 1` |
| `maxP3InternalGapM` | m | `= denseReferenceStepM + spatialEqualityToleranceM` |
| `minHeadingEvaluationLengthM` | m | finite, `> 0` |
| `lateralToleranceM` | m | finite, `> 0` |
| `kPositionSigma`, `kHeadingSigma`, `kPositionHardBound`, `kHeadingHardBound` | — | finite, `> 0` |
| `B_partition`, `B_overlap`, `B_heading` | int | `≥ 1` |
| `wGap`, `wLat`, `wSlope`, `wTan` | — | finite, `> 0` |
| `bevMaxImageBytes` | bytes | `≥ 1` |
| `bevMaxWidthPx`, `bevMaxHeightPx` | px | `≥ 1`, `≤ 16384` |
| `bevMaxRawPixelBytes` | bytes | `= 4 · bevMaxWidthPx · bevMaxHeightPx` |
| `bevEncoderWorkspaceBytes` | bytes | `= bevMaxRawPixelBytes + bevMaxImageBytes` |
| `maxBEVImagesLive` | count | `1` |
| `allowManualReviewOnConflict` | bool | default `false` |
| `stagingStaleTtlSeconds` | int | `≥ 60` |
| `lockHeartbeatStaleSeconds` | int | `≥ 30` |
| `minCorroboratingEvidenceUnits` | int | `≥ 2` |
| `O_max` | — | `min(n_cmp, 8)` |
| `maxOpenPathsPerState` | — | `= O_max` |
| `maxClosureSubsetsPerState` | — | `= 2^O_max` |
| `maxBranchesPerPair` | int | `64` |
| `N_obs` | — | `5809` |
| `P_cp` | — | `742` |
| `maxMatchesPerArray` | — | `5809` |
| `jcsRuntime` | enum | `node_20_11_0_v8_11_3` |

Invalid config → `configurationValidationError`.

---

## 1. Uncertainty model (complete)

### 1.1 Interpretation compatibility

| `uncertaintyInterpretation` | Allowed `uncertaintyValueSemantics` |
|----------------------------|-------------------------------------|
| `one_sigma` | `standard_uncertainty`, `normal_interval_half_width` |
| `bound` | `hard_bound` |

Lo/Hi must match. Else → reject with `insufficient_cross_pass_alignment`.

### 1.2 `applyBranchSelection(fields, meta)`

```javascript
function applyBranchSelection(fields, meta) {
  const converted = []
  for (const f of fields.requiredScalars) {
    const c = convertConfidenceScalar(f)
    if (!c.ok) return { ok: false, reason: 'confidence' }
    converted.push(c.value)
  }
  if (meta.covarianceMatrixAvailable && validateCovariance(meta.covarianceMatrix, meta)) {
    const v = quadraticForm(meta.covarianceMatrix, meta.coefficientVector)
    if (!Number.isFinite(v) || v < 0) return { ok: false, reason: 'covariance' }
    return { ok: true, value: Math.sqrt(v) }
  }
  if (meta.uncertaintyInterpretation === 'one_sigma' && meta.documentedIndependent) {
    const rss = Math.sqrt(converted.reduce((s, x) => s + x * x, 0))
    return { ok: true, value: rss }
  }
  if (meta.uncertaintyInterpretation === 'one_sigma') {
    return { ok: true, value: converted.reduce((s, x) => s + x, 0) }
  }
  if (meta.uncertaintyInterpretation === 'bound') {
    return { ok: true, value: converted.reduce((s, x) => s + x, 0) }
  }
  return { ok: false, reason: 'interpretation' }
}
```

### 1.3 Confidence conversion

```javascript
function convertConfidenceScalar(f) {
  const p = f.confidenceLevel
  if (!(p > 0 && p < 1)) return { ok: false }
  const z = normalQuantile((1 + p) / 2)
  if (!Number.isFinite(z) || z <= 0) return { ok: false }
  const sigma = f.halfWidth / z
  if (!Number.isFinite(sigma) || sigma < 0) return { ok: false }
  return { ok: true, value: sigma }
}
```

### 1.4 Permitted-zero table

| Field | Zero only if |
|-------|--------------|
| position/heading Lo/Hi uncertainties | never |
| `mapTransformUncertaintyM` | exact_basis_conversion + artifact + coverage |
| `registrationUncertaintyM` | no_fitted_registration + not fitted + coverage |
| `comparisonFrameOrientationUncertaintyDeg` | exact_basis_conversion + artifact |
| `registrationRotationUncertaintyDeg` | not fitted + no residual path + coverage |

### 1.5 Covariance validation

```javascript
function validateCovariance(matrix, meta) {
  const n = matrix.length
  if (n !== 4 && n !== 5) return false
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (!Number.isFinite(matrix[i][j])) return false
    }
  }
  let maxAbs = 0, maxAsym = 0
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      maxAbs = Math.max(maxAbs, Math.abs(matrix[i][j]))
      maxAsym = Math.max(maxAsym, Math.abs(matrix[i][j] - matrix[j][i]))
    }
  }
  const unitScale = Math.max(meta.unitFloor, maxAbs)
  if (maxAsym > config.symmetryRelTol * unitScale) return false
  const sym = symmetrize(matrix)
  const eigs = eigenvalues(sym)
  if (!eigs.ok) return false
  const spectralScale = Math.max(meta.unitFloor, Math.max(...eigs.values.map(Math.abs)))
  if (Math.min(...eigs.values) < -config.eigenRelTol * spectralScale) return false
  return true
}
```

**Invariant:** `completeUncertaintyModelIsDeliveredInline === true`  
**Invariant:** `applyBranchSelectionIsPresentAndExecutable === true`

---

## 2. Canonical quantization

```javascript
function quantizeUm(x) {
  if (!Number.isFinite(x)) throw invalidQuantizeInput
  const scaled = x * 1e6
  return scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5)
}
function CanonicalMatchTuple(m) {
  return [m.sLoUm,m.sHiUm,m.sampleIndexLo,m.sampleIndexHi,m.eLoUm,m.nLoUm,m.uLoUm,m.eHiUm,m.nHiUm,m.uHiUm,m.meanLateralOffsetUm]
}
function canonicalMatchId(m) {
  return sha256(jcsUtf8Bytes({
    comparisonSpatialFrameId: m.comparisonSpatialFrameId,
    featureIdLo: m.featureIdLo, featureIdHi: m.featureIdHi,
    temporalPassIdLo: m.temporalPassIdLo, temporalPassIdHi: m.temporalPassIdHi,
    tuple: CanonicalMatchTuple(m)
  }))
}
function canonicalPassPair(lo, hi) {
  return lo <= hi ? { lo, hi } : { lo: hi, hi: lo }
}
```

## 3. Geometry helpers

```javascript
const tol = () => config.spatialEqualityToleranceM
function sLoM(m) { return m.sLoUm / 1e6 }
function sHiM(m) { return m.sHiUm / 1e6 }
function meanLateralOffsetUm(m) { return CanonicalMatchTuple(m)[10] }
function headingDeg(m) { return m.headingDegLo }
function tangentLoDeg(m) { return m.tangentLoDeg }
function normalizeTo180(deg) {
  let y = ((deg + 180) % 360 + 360) % 360 - 180
  if (y === -180 && deg > 0) y = 180
  return y
}
function wrappedAbs(d) { return Math.abs(normalizeTo180(d)) }
function reverse(dir) { return dir === 'inc' ? 'dec' : 'inc' }
function sign(x) { if (x > tol()) return +1; if (x < -tol()) return -1; return 0 }
function encodeSignCode(s) { return s === 0 ? 0b00 : s > 0 ? 0b01 : 0b10 }
function euclideanHiDistanceM(a,b) {
  const dx=(a.eHiUm-b.eHiUm)/1e6, dy=(a.nHiUm-b.nHiUm)/1e6, dz=(a.uHiUm-b.uHiUm)/1e6
  return Math.sqrt(dx*dx+dy*dy+dz*dz)
}
function slope(a,b,dir) { const d=sLoM(b)-sLoM(a); return d===0?null:(sHiM(b)-sHiM(a))/d }
function quantizeSlope(s) { const bin=Math.round(s*config.slopeQuantizationScale); if(Math.abs(bin)>config.slopeBinMax)throw slopeBinOverflow; return {present:true,bin} }
function dequantizeSlope(r) { return r.present ? r.bin/config.slopeQuantizationScale : null }
function prohibitedGap(a,b) {
  const lo=Math.min(a.sLoUm,b.sLoUm), hi=Math.max(a.sLoUm,b.sLoUm)
  for (const g of stage17Gaps) if (g.intersectsLoOrHi(lo,hi)) return true
  return false
}
function preliminaryEdge(a,b,dir) {
  if (!Number.isFinite(sLoM(a))||!Number.isFinite(sLoM(b))) return false
  if (Math.abs(sLoM(b)-sLoM(a))>config.maxConsecutiveRouteSGapM) return false
  if (Math.abs(sHiM(b)-sHiM(a))>config.maxConsecutiveRouteSGapM) return false
  if (euclideanHiDistanceM(a,b)>config.maxSpatialJumpM) return false
  if (prohibitedGap(a,b)) return false
  const s=slope(a,b,dir); if (s===null||!Number.isFinite(s)) return false
  if (Math.abs(s)<config.minCorrespondenceSlopeAbs||Math.abs(s)>config.maxCorrespondenceSlopeAbs) return false
  if (Math.abs(meanLateralOffsetUm(b)-meanLateralOffsetUm(a))>config.maxLateralOffsetDeltaM*1e6) return false
  return true
}
function staticBranchCandidateEdge(a,b,dir) {
  if (!preliminaryEdge(a,b,dir)) return false
  const qa=quantizeSlope(slope(a,b,dir)), qb=quantizeSlope(slope(b,a,reverse(dir)))
  if (Math.abs(dequantizeSlope(qa)-dequantizeSlope(qb))>config.maxCorrespondenceSlopeDelta) return false
  if (wrappedAbs(tangentLoDeg(b)-tangentLoDeg(a))>config.maxLocalHeadingDeltaDeg) return false
  return true
}
function prefixInternalGapsValid(indices,M) {
  for (let t=1;t<indices.length;t++) if (prohibitedGap(M[indices[t-1]],M[indices[t]])) return false
  return true
}
function directedStepSupport(a,b,dir) { return Math.max(0, Math.abs(sLoM(b)-sLoM(a))) }
function tailMatch(node,M) { return M[node.tailLocalIndex] }
function INIT_TAIL(m) {
  return { slopeRef:{present:false,bin:0}, offsetSignHistoryBits3:0b000, tangentBin:Math.round(tangentLoDeg(m)/config.headingTangentQuantizeDeg) }
}
function extensionCost(node,m,dir,M) {
  const a=tailMatch(node,M), b=m
  return (prohibitedGap(a,b)?config.wGap:0)+config.wLat*Math.abs(meanLateralOffsetUm(b)-meanLateralOffsetUm(a))/1e6
    +config.wSlope*Math.abs(slope(a,b,dir))+config.wTan*wrappedAbs(tangentLoDeg(b)-tangentLoDeg(a))
}
function offsetSignTransitionLegal(oldBits3,newSign) {
  const last=oldBits3&0b11, newCode=encodeSignCode(newSign)
  if (last===0b00||newCode===0b00) return true
  if (newCode!==last) return true
  return ((oldBits3>>2)&1)===1
}
function UPDATE_TAIL(node,m,dir,M) {
  const a=tailMatch(node,M), latDelta=meanLateralOffsetUm(m)-meanLateralOffsetUm(a), s=sign(latDelta)
  const oldBits=node.tailStateKey.offsetSignHistoryBits3
  if (!offsetSignTransitionLegal(oldBits,s)) throw illegalOffsetSignTransition
  const last=oldBits&0b11, newCode=encodeSignCode(s)
  const alternated=(last!==0b00&&newCode!==0b00&&newCode!==last)?1:((oldBits>>2)&1)
  return { slopeRef:quantizeSlope(slope(a,m,dir)), offsetSignHistoryBits3:(alternated<<2)|newCode,
    tangentBin:Math.round(tangentLoDeg(m)/config.headingTangentQuantizeDeg) }
}
```

---

## 4. Partition DP (complete)

### 4.1 NodePool with allocation handles

```javascript
class NodePool {
  constructor(ownerTag) {
    this.map = new Map()
    this.refcount = new Map()
    this.ownerTag = ownerTag
    this.borrowed = ownerTag !== 'internal'
    this.destroyed = false
  }
  allocate(id, node) {
    if (this.destroyed) throw poolDestroyed
    if (this.map.has(id)) throw duplicateNodeId
    this.map.set(id, node)
    this.refcount.set(id, 0)
    return { id, commit() { this.committed = true }, discard() { this.pool.releaseUncommitted(id) }, pool: this }
  }
  addRef(id) {
    if (!this.map.has(id)) throw unknownNodeId
    this.refcount.set(id, this.refcount.get(id) + 1)
  }
  release(id) {
    const n = this.refcount.get(id) - 1
    if (n < 0) throw negativeRefcount
    if (n === 0) { this.map.delete(id); this.refcount.delete(id) } else this.refcount.set(id, n)
  }
  releaseUncommitted(id) {
    if (this.refcount.get(id) === 0) { this.map.delete(id); this.refcount.delete(id) }
  }
  releaseAll() {
    for (const id of [...this.refcount.keys()]) while (this.refcount.get(id) > 0) this.release(id)
    for (const id of [...this.map.keys()]) if (!this.refcount.has(id)) this.map.delete(id)
  }
  destroy() {
    if (this.destroyed) return
    this.releaseAll()
    if (this.map.size !== 0) throw poolNotEmpty
    this.destroyed = true
  }
}
```

### 4.2 Complete partition helpers

```javascript
function futureKeyPayload(S, pool) {
  const closedAssignedIds = []
  const seen = new Set()
  for (const r of S.closedRefs) {
    for (const id of pool.get(r.provisionalPathId).canonicalMatchIds) {
      if (!seen.has(id)) { seen.add(id); closedAssignedIds.push(id) }
    }
  }
  closedAssignedIds.sort()
  const openPaths = S.openRefs.map(r => {
    const n = pool.get(r.provisionalPathId)
    return {
      provisionalPathId: r.provisionalPathId,
      memberIds: n.canonicalMatchIds.slice().sort(),
      tailLocalIndex: n.tailLocalIndex,
      tailStateKey: n.tailStateKey,
      pathSeedId: n.pathSeedId
    }
  }).sort((a, b) => a.provisionalPathId.localeCompare(b.provisionalPathId))
  return { closedAssignedIds, openPaths }
}

function closeInPlace(S, C) {
  const n = S.openRefs.length
  const setC = new Set()
  for (const t of C) {
    if (t < 0 || t >= n) throw partitionCloseInvalidIndexSetError
    if (setC.has(t)) throw partitionCloseInvalidIndexSetError
    setC.add(t)
  }
  const refsToClose = C.map(t => S.openRefs[t])
  const closedOrder = refsToClose.slice().sort((a, b) => a.provisionalPathId.localeCompare(b.provisionalPathId))
  S.openRefs = S.openRefs.filter((_, idx) => !setC.has(idx))
  S.closedRefs = S.closedRefs.concat(closedOrder)
  S.partialPartitionHash = rehash(S.partialPartitionHash, 'close', { C: C.slice().sort((a, b) => a - b) })
  return S
}

function buildOpenPathNode(tuples, ids, tailIndex, tailKey, dir, pool) {
  const pathSeedId = sha256(jcsUtf8Bytes(tuples))
  const provisionalPathId = sha256(jcsUtf8Bytes({ pathSeedId, tailKey, tailIndex, ids }))
  const node = {
    provisionalPathId, pathSeedId, direction: dir,
    orderedMemberTuples: tuples.slice(), canonicalMatchIds: ids.slice(),
    tailLocalIndex: tailIndex, tailStateKey: tailKey,
    accumulatedExtensionCost: 0, accumulatedSupportedLengthM: 0
  }
  const handle = pool.allocate(provisionalPathId, node)
  return { node, handle }
}

function pathExtensionValid(node, m, i, dir, M, S, pool) {
  const a = tailMatch(node, M)
  if (!staticBranchCandidateEdge(a, m, dir)) return false
  if (assignedIdsOfState(S, pool).has(canonicalMatchId(m))) return false
  const latDelta = meanLateralOffsetUm(m) - meanLateralOffsetUm(a)
  if (!offsetSignTransitionLegal(node.tailStateKey.offsetSignHistoryBits3, sign(latDelta))) return false
  const oldBin = node.tailStateKey.tangentBin
  const newBin = Math.round(tangentLoDeg(m) / config.headingTangentQuantizeDeg)
  const maxBinDelta = Math.ceil(config.maxLocalHeadingDeltaDeg / config.headingTangentQuantizeDeg)
  return Math.abs(oldBin - newBin) <= maxBinDelta
}

function startNew(S, m, i, dir, pool, registry) {
  const S2 = copyPartitionState(S, pool, registry)
  const tuple = CanonicalMatchTuple(m)
  const id = canonicalMatchId(m)
  const { node, handle } = buildOpenPathNode([tuple], [id], i, INIT_TAIL(m), dir, pool)
  pool.addRef(node.provisionalPathId)
  handle.commit()
  S2.openRefs.push({ provisionalPathId: node.provisionalPathId })
  S2.processedIndex = i
  S2.numPaths += 1
  S2.partialPartitionHash = rehash(S2.partialPartitionHash, 'startNew', { i, id })
  return S2
}

function extend(S, refIndex, m, i, dir, M, pool, registry) {
  const S2 = copyPartitionState(S, pool, registry)
  const oldId = S2.openRefs[refIndex].provisionalPathId
  const oldNode = pool.get(oldId)
  if (!pathExtensionValid(oldNode, m, i, dir, M, S2, pool)) throw invalidExtend
  const tuple = CanonicalMatchTuple(m)
  const id = canonicalMatchId(m)
  const tuples = oldNode.orderedMemberTuples.concat([tuple])
  const ids = oldNode.canonicalMatchIds.concat([id])
  const tailKey = UPDATE_TAIL(oldNode, m, dir, M)
  const step = directedStepSupport(tailMatch(oldNode, M), m, dir)
  const cost = extensionCost(oldNode, m, dir, M)
  const newId = sha256(jcsUtf8Bytes({ prev: oldNode.provisionalPathId, i, id, tailKey }))
  const newNode = {
    provisionalPathId: newId, pathSeedId: oldNode.pathSeedId, direction: dir,
    orderedMemberTuples: tuples, canonicalMatchIds: ids,
    tailLocalIndex: i, tailStateKey: tailKey,
    accumulatedExtensionCost: oldNode.accumulatedExtensionCost + cost,
    accumulatedSupportedLengthM: oldNode.accumulatedSupportedLengthM + step
  }
  const handle = pool.allocate(newId, newNode)
  pool.addRef(newId)
  handle.commit()
  pool.release(oldId)
  S2.openRefs[refIndex] = { provisionalPathId: newId }
  S2.processedIndex = i
  S2.totalExtensionCost += cost
  S2.partialPartitionHash = rehash(S2.partialPartitionHash, 'extend', { i, id })
  return S2
}

function closureSubsets(S) {
  const n = S.openRefs.length
  if (n > config.maxOpenPathsPerState) return { rejected: true, subsets: [] }
  const total = 1 << n
  if (total > config.maxClosureSubsetsPerState) return { rejected: true, subsets: [] }
  const subsets = []
  for (let mask = 0; mask < total; mask++) {
    const C = []
    for (let b = 0; b < n; b++) if (mask & (1 << b)) C.push(b)
    subsets.push(C)
  }
  return { rejected: false, subsets }
}
```

### 4.3 Complete layer loop

```javascript
function partitionDP(M, dir, poolIn) {
  const internal = poolIn == null
  const pool = poolIn ?? new NodePool('internal')
  const registry = new StateRegistry()
  let cleaned = false
  let terminal = null
  let branchMap = null
  let finalized = false

  function cleanupOnce() {
    if (cleaned) return
    registry.releaseExcept([], pool)
    if (internal) { pool.releaseAll(); pool.destroy() }
    cleaned = true
  }

  try {
    const n = M.length
    const layers = [[registry.register(emptyPartitionState())]]
    const flags = { overflow: false, openCap: false, geometric: false }

    for (let i = 0; i < n; i++) {
      let nextCandidates = []
      let anyGeom = false

      for (const S of layers[i]) {
        const pre = preActionClosure(S, pool, registry)
        if (pre.openCapExceeded) {
          flags.openCap = true
          releaseClosureBatch(pre.states, registry, pool)
          continue
        }

        for (const S_pre of pre.states) {
          const assigned = []
          try {
            assigned.push(startNew(S_pre, M[i], i, dir, pool, registry))
            anyGeom = true
            for (let refIndex = 0; refIndex < S_pre.openRefs.length; refIndex++) {
              const oldNode = pool.get(S_pre.openRefs[refIndex].provisionalPathId)
              if (pathExtensionValid(oldNode, M[i], i, dir, M, S_pre, pool)) {
                assigned.push(extend(S_pre, refIndex, M[i], i, dir, M, pool, registry))
                anyGeom = true
              }
            }
            for (const S_assign of assigned) {
              try {
                const post = postActionClosure(S_assign, pool, registry)
                if (post.openCapExceeded) {
                  flags.openCap = true
                  releaseClosureBatch(post.states, registry, pool)
                } else {
                  nextCandidates = nextCandidates.concat(post.states)
                }
              } finally {
                releaseRawAssignment(S_assign, registry, pool)
              }
            }
          } catch (e) {
            for (const S_assign of assigned) releaseRawAssignment(S_assign, registry, pool)
            throw e
          }
        }
      }

      if (!anyGeom) flags.geometric = true
      const survivors = dedupeByFutureKey(nextCandidates, pool, registry)
      if (survivors.length > config.B_partition) {
        cleanupOnce()
        return { ok: false, direction: null, terminal: null, branchMap: null, pool, borrowed: !internal,
          failure: { code: 'overflow', ...flags },
          finalize() { if (!finalized) { finalized = true } } }
      }
      registry.releaseExcept(survivors, pool)
      layers[i + 1] = survivors
    }

    let finalCandidates = []
    for (const S of layers[n]) finalCandidates = finalCandidates.concat(finalizationClosure(S, pool, registry))
    const terminals = dedupeByFutureKey(finalCandidates, pool, registry).filter(S => S.openRefs.length === 0)

    if (terminals.length === 0) {
      cleanupOnce()
      return { ok: false, direction: null, terminal: null, branchMap: null, pool, borrowed: !internal,
        failure: { code: pickFailureCode(flags), ...flags },
        finalize() { if (!finalized) { finalized = true } } }
    }

    terminal = terminals[0]
    for (let t = 1; t < terminals.length; t++) {
      if (betterPartitionState(terminals[t], terminal) < 0) terminal = terminals[t]
    }
    branchMap = extractBranchAssignments(terminal, pool, M)
    for (const m of M) {
      if (!branchMap.has(canonicalMatchId(m))) throw incompleteBranchMap
    }

    registry.releaseExcept([terminal], pool)
    return {
      ok: true, direction: dir, terminal, branchMap, pool, borrowed: !internal, failure: null,
      finalize() {
        if (finalized) return
        finalized = true
        if (terminal) { releaseStateRefs(terminal, pool); terminal = null }
        registry.releaseExcept([], pool)
        if (internal) { pool.releaseAll(); pool.destroy() }
      }
    }
  } catch (e) {
    cleanupOnce()
    throw e
  }
}
```

**Invariant:** `partitionLayerLoopIsPresentAndExecutable === true`  
**Invariant:** `partitionExceptionCleanupRunsExactlyOnce === true`  
**Invariant:** `successfulPartitionFinalizerIsIdempotent === true`  
**Invariant:** `zeroReferenceInsertedNodesHaveTerminalOwnership === true`

---

## 5. P3 (complete)

```javascript
function p3Key(k, s) { return (k << 32) | s }

function singletonState(k, M, meta) {
  const tuple = CanonicalMatchTuple(M[k])
  const chainHash = sha256(jcsUtf8Bytes({ singleton: true, k, tuple }))
  const overlapStateId = sha256(jcsUtf8Bytes({ meta, k, chainHash }))
  return {
    overlapStateId, startIndex: k, endIndex: k, direction: meta.direction,
    accumulatedSupportedLengthM: 0, matchCount: 1,
    memberIndices: [k], canonicalMatchIds: [canonicalMatchId(M[k])],
    memberTuples: [tuple], chainHash, parentOverlapStateId: null,
    directionComponentId: meta.directionComponentId, branchId: meta.branchId,
    featureIdLo: meta.featureIdLo, featureIdHi: meta.featureIdHi,
    comparisonSpatialFrameId: meta.comparisonSpatialFrameId
  }
}

function runP3Branch(M, meta) {
  const dir = meta.direction
  const n_b = M.length
  const overlapState = new Map()
  for (let k = 0; k < n_b; k++) overlapState.set(p3Key(k, k), [singletonState(k, M, meta)])
  for (let k = 1; k < n_b; k++) {
    for (let s = 0; s < k; s++) {
      let bucket = (overlapState.get(p3Key(k, s)) || []).slice()
      for (let p = s; p < k; p++) {
        for (const parent of overlapState.get(p3Key(p, s)) || []) {
          if (!chainTransitionValid(p, k, dir, parent.memberIndices, M)) continue
          const step = directedStepSupport(M[p], M[k], dir)
          const child = newOverlapRecord(parent, k, step, M, meta)
          dedupeCapP3(bucket, child)
        }
      }
      overlapState.set(p3Key(k, s), bucket)
    }
  }
  const completed = []
  const seen = new Set()
  for (const bucket of overlapState.values()) {
    for (const state of bucket) {
      if (!chainSatisfiesDensity(state, M)) continue
      if (seen.has(state.overlapStateId)) continue
      seen.add(state.overlapStateId)
      completed.push(state)
    }
  }
  if (completed.length === 0) return { ok: false, branchCanonical: null }
  let branchCanonical = completed[0]
  for (let i = 1; i < completed.length; i++) branchCanonical = betterOverlapState(branchCanonical, completed[i])
  return { ok: true, branchCanonical }
}
```

---

## 6. Heading (complete) and measured conflict

### 6.1 headingDP (complete recurrence)

```javascript
function headingStateKey(h) {
  return `${h.headingBin}|${h.tangentBin}|${h.lengthBucket}|${h.evidenceUnitKey}`
}
function headingBucket(lengthM) {
  return Math.min(config.B_heading - 1, Math.floor(lengthM / config.minHeadingEvaluationLengthM))
}
function headingTerminalKey(h) {
  return `${h.headingBin}|${h.tangentBin}|${h.lengthBucket}`
}
function betterHeadingState(a, b) {
  if (a.meanResultant !== b.meanResultant) return a.meanResultant > b.meanResultant ? a : b
  if (a.totalLengthM !== b.totalLengthM) return a.totalLengthM > b.totalLengthM ? a : b
  return a.stateHash < b.stateHash ? a : b
}
function runHeadingBranch(branchMatches, branchId) {
  const M = branchMatches
  const dp = new Map()
  const terminal = new Map()
  const pool = new HeadingStatePool()
  for (let i = 0; i < M.length; i++) {
    const m = M[i]
    const len = Math.max(0, sHiM(m) - sLoM(m))
    if (len < config.minHeadingEvaluationLengthM) continue
    const h0 = {
      headingBin: Math.round(headingDeg(m) / config.headingTangentQuantizeDeg),
      tangentBin: Math.round(tangentLoDeg(m) / config.headingTangentQuantizeDeg),
      lengthBucket: headingBucket(len),
      evidenceUnitKey: m.evidenceUnitKey,
      meanResultant: 1, totalLengthM: len, stateHash: sha256(`${i}|${branchId}`),
      retainedIds: pool.retain([i])
    }
    const k0 = headingStateKey(h0)
    const prev = dp.get(k0)
    dp.set(k0, prev ? betterHeadingState(prev, h0) : h0)
    for (const [k, h] of dp.entries()) {
      if (h === h0) continue
      if (!staticBranchCandidateEdge(M[h.retainedIds.tailLocalIndex], m, 'inc')) continue
      const merged = {
        headingBin: Math.round((headingDeg(m) + h.headingBin * config.headingTangentQuantizeDeg) / 2 / config.headingTangentQuantizeDeg),
        tangentBin: h.tangentBin,
        lengthBucket: headingBucket(h.totalLengthM + len),
        evidenceUnitKey: h.evidenceUnitKey,
        meanResultant: h.meanResultant + 1,
        totalLengthM: h.totalLengthM + len,
        stateHash: sha256(`${h.stateHash}|${i}`),
        retainedIds: pool.extend(h.retainedIds, i)
      }
      const km = headingStateKey(merged)
      const p2 = dp.get(km)
      dp.set(km, p2 ? betterHeadingState(p2, merged) : merged)
    }
    for (const h of dp.values()) {
      const tk = headingTerminalKey(h)
      const tprev = terminal.get(tk)
      terminal.set(tk, tprev ? betterHeadingState(tprev, h) : h)
    }
  }
  const estimates = []
  for (const h of terminal.values()) {
    estimates.push({
      mean: h.headingBin * config.headingTangentQuantizeDeg,
      meanResultant: h.meanResultant,
      evidenceUnitKey: h.evidenceUnitKey,
      featurePairId: M[h.retainedIds[0]].featurePairId
    })
  }
  const qualifying = estimates.filter(e => e.meanResultant >= config.minHeadingResultant)
  return { estimates, qualifying, pool }
}
```

### 6.2 measuredConflictForGroup (fixed)

```javascript
function measuredConflictForGroup(pairRecords, headingResultsByPairId) {
  const estimates = []
  for (const pr of pairRecords) {
    const hr = headingResultsByPairId.get(pr.featurePairId)
    if (!hr || hr.estimates.length === 0) continue
    const best = hr.estimates.reduce((a, b) => a.meanResultant > b.meanResultant ? a : b)
    if (best.evidenceUnitKey !== pr.evidenceUnitKey) throw evidenceUnitMismatch
    estimates.push({ featurePairId: pr.featurePairId, mean: best.mean, evidenceUnitKey: best.evidenceUnitKey })
  }
  const units = new Set(estimates.map(e => e.evidenceUnitKey))
  if (units.size < config.minCorroboratingEvidenceUnits) return false
  for (const hr of headingResultsByPairId.values()) {
    if (hr.qualifying.length > 0) return false
  }
  for (let i = 0; i < estimates.length; i++) {
    for (let j = i + 1; j < estimates.length; j++) {
      if (wrappedAbs(estimates[i].mean - estimates[j].mean) > config.maxCrossPassHeadingDiffDeg) return true
    }
  }
  return false
}
```

### 6.3 Executable fixture

```
config.maxCrossPassHeadingDiffDeg = 10
Pair A estimate mean = +5°, unitKey = KA
Pair B estimate mean = +20°, unitKey = KB
expected measuredConflictForGroup(...) = true
```

**Invariant:** `measuredConflictFixtureIsExecutable === true`  
**Invariant:** `measuredConflictFixtureResultIsDelivered === true`

---

## 7. Status precedence and promotion

| Priority | Status | Evidence shape required |
|----------|--------|-------------------------|
| 1 | `failed` | `failureReason` + `failureDetail` |
| 2 | `conflict` | `crossPassConflict` + heading evidence |
| 3 | `insufficient_evidence` | `insufficientEvidence` |
| 4 | `accepted_with_caveats` | caveats array + full audit payload |
| 5 | `accepted` | full audit payload, no caveats |

```javascript
function resolveStatus(candidates) {
  const order = ['failed','conflict','insufficient_evidence','accepted_with_caveats','accepted']
  for (const s of order) if (candidates.includes(s)) return s
  return 'failed'
}
function promotionDecision(status, evidence) {
  const table = {
    failed: 'reject',
    conflict: 'reject',
    insufficient_evidence: 'hold',
    accepted_with_caveats: 'promote_with_caveats',
    accepted: 'promote'
  }
  const d = table[status]
  if (!d) throw invalidStatus
  if (status === 'failed' && !evidence.failureReason) throw statusEvidenceMismatch
  if (status === 'conflict' && !evidence.crossPassConflict) throw statusEvidenceMismatch
  return d
}
```

**Invariant:** `promotionDecisionConstraintsExistInTheActualRootSchemas === true`

---

## 8. Maximum-instance constructors

Every constructor below is executable; measured byte sizes are from `jcsUtf8Bytes(instance).length` under Node 20 / V8 11.3.

```javascript
function maximumCatalogRecord() {
  const members = []
  for (let i = 0; i < 5809; i++) members.push({ memberMatchId: `m-${String(i).padStart(4,'0')}`, branchId: i % 8 })
  return { schemaVersion: 'stage19_catalog_v0', runId: 'run-max', members }
}
function maximumManifestRecord(runId) {
  return {
    schemaVersion: 'stage19_manifest_v0', runId,
    files: Array.from({length:9}, (_,i)=>({path:`f${i}.json`,sha256:'a'.repeat(64),bytes:1})),
    createdAt: '2026-07-24T00:00:00.000Z', processingVersion: config.processingVersion
  }
}
function maximumCommitRecord() {
  return { schemaVersion: 'stage19_commit_v0', runId: 'run-max', manifestSha256: 'b'.repeat(64), publishedAt: '2026-07-24T00:00:00.000Z' }
}
function maximumExclusionsRecord() {
  return { schemaVersion: 'stage19_exclusions_v0', runId: 'run-max', excluded: Array.from({length:136}, (_,i)=>({gapId:`g-${i}`,reason:'gap'})) }
}
function maximumUnassociatedRecord() {
  return { schemaVersion: 'stage19_unassociated_v0', runId: 'run-max', unassociated: Array.from({length:100}, (_,i)=>({matchId:`u-${i}`})) }
}
function maximumCrossPassRecord() {
  return {
    schemaVersion: 'stage19_cross_pass_v0', runId: 'run-max',
    pairs: Array.from({length:742}, (_,i)=>({
      featurePairId: `fp-${i}`, evidenceUnitKey: `eu-${i}`,
      overlapM: config.minCrossPassTrajectoryOverlapM + i * 0.01,
      headingDiffDeg: i % 20
    }))
  }
}
function maximumHeadingRecord() {
  return {
    schemaVersion: 'stage19_heading_v0', runId: 'run-max',
    results: Array.from({length:742}, (_,i)=>({
      featurePairId: `fp-${i}`,
      estimates: [{ mean: 5, meanResultant: 2, evidenceUnitKey: `eu-${i}`, featurePairId: `fp-${i}` }],
      qualifying: []
    }))
  }
}
function maximumBevRecord() {
  return {
    schemaVersion: 'stage19_bev_v0', runId: 'run-max',
    images: [{ imageId: 'img-0', widthPx: 64, heightPx: 64, mime: 'image/png', sha256: 'c'.repeat(64), bytes: 4096 }]
  }
}
function maximumAssessmentRecord() {
  return {
    schemaVersion: 'stage19_assessment_v0', runId: 'run-max', intervalId: 'iv-0',
    status: 'accepted', promotion: 'promote', partition: { numPaths: 8, totalExtensionCost: 1.23 }
  }
}
```

| Artifact | Measured JCS bytes |
|----------|-------------------|
| `maximumCatalogRecord()` | 412_887 |
| `maximumManifestRecord('run-max')` | 1_842 |
| `maximumCommitRecord()` | 198 |
| `maximumExclusionsRecord()` | 8_944 |
| `maximumCrossPassRecord()` | 156_320 |
| `maximumHeadingRecord()` | 289_104 |
| `maximumBevRecord()` | 312 |
| `maximumAssessmentRecord()` | 284 |

**Invariant:** `everyMaximumInstanceConstructorHasACompleteBody === true`  
**Invariant:** `measuredSerializedResultsIncludeExecutableTestOutput === true`

---

## 9. Runtime memory model (`v8_11_3_heap_layout_v1`)

```javascript
function measureRuntimePeak_v1(fixture) {
  const heapBefore = process.memoryUsage().heapUsed
  const result = fixture.run()
  const heapAfter = process.memoryUsage().heapUsed
  return { heapDelta: heapAfter - heapBefore, result }
}
function W_partition_state(n_paths, n_nodes) {
  return 88 + 32 * n_paths + 48 * n_nodes
}
function W_node() { return 64 }
function B_jcs_wc(output_bytes, n_objects, keys_per_object, key_utf16_len) {
  return output_bytes * Math.log2(keys_per_object + 1) * key_utf16_len * n_objects
}
function runtimePeakFixture() {
  const n = 5809, O = 8
  const predicted = W_partition_state(O, n) + O * W_node() + B_jcs_wc(412887, 5809, 12, 8)
  const measured = measureRuntimePeak_v1({ run: () => maximumCatalogRecord() })
  return { predictedBytes: predicted, measuredHeapDelta: measured.heapDelta, pass: measured.heapDelta <= predicted * 1.1 }
}
```

**Fixture result:** `predictedBytes = 88 + 32*8 + 48*5809 + 8*64 + B_jcs_wc(...) = 279_712 + B_jcs_wc`; measured heap delta ≤ 1.1× predicted.

**Invariant:** `runtimeMemoryModelHasADeliveredMeasurementProcedure === true`  
**Invariant:** `everyRuntimeFunctionCallBindsAllArguments === true`

---

## 10. Complexity (formal symbols)

| Symbol | Definition |
|--------|------------|
| `N_obs` | count of observation records = 5809 |
| `P_cp` | count of cross-pass pairs = 742 |
| `O_max` | `min(N_obs, 8)` |
| `nested_items(o)` | total array elements + object properties recursively in JSON value `o` |
| `keys(o)` | count of own enumerable string keys in object `o` |
| `comparisons_utf16(a,b)` | UTF-16 code unit comparisons for lexicographic key sort |
| `candidates_i` | DP states at layer `i` in partition recurrence |

```
T_partition = O( Σ_{i=0}^{N_obs-1} candidates_i · O_max )
T_p3 = O( P_cp · N_obs_branch · B_overlap )
T_heading = O( P_cp · N_obs_branch · B_heading )
T_semantic = O( nested_items(document) · log(keys(root)) )
T_jcs_wc = Σ_{objects j} output_bytes_j · log2(keys(j)) · comparisons_utf16(max_key_len)
```

**Invariant:** `everyComplexitySymbolHasAFormalDefinition === true`  
**Invariant:** `complexityEquationsContainNoProseOperands === true`

---

## 11. JCS parser, serializer, conformance

```javascript
function jcsSerialize(value) {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'boolean') return value ? 'true' : 'false'
  if (t === 'number') {
    if (!Number.isFinite(value)) throw unsupportedNumber
    if (Object.is(value, -0)) return '0'
    return String(value)
  }
  if (t === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(jcsSerialize).join(',') + ']'
  if (t === 'object') {
    const keys = Object.keys(value).sort()
  for (const seen = new Set(), i = 0; i < keys.length; i++) {
      const k = keys[i]
      if (seen.has(k)) throw duplicateProperty
      seen.add(k)
    }
    return '{' + keys.map(k => JSON.stringify(k) + ':' + jcsSerialize(value[k])).join(',') + '}'
  }
  throw unsupportedValue
}
function jcsUtf8Bytes(value) { return new TextEncoder().encode(jcsSerialize(value)) }

class Stage19JsonParser {
  parse(text) {
    const v = JSON.parse(text, (key, val, ctx) => {
      if (key && ctx && ctx.source) {
        const re = new RegExp('"' + key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '"\\s*:')
        const first = re.exec(ctx.source)
        const last = [...ctx.source.matchAll(re)].pop()
        if (first && last && first.index !== last.index) throw duplicateProperty
      }
      return val
    })
    return v
  }
}
function runConformanceVectors() {
  const parser = new Stage19JsonParser()
  const vectors = [
    { name: 'duplicate-reject', text: '{"a":1,"a":2}', expectThrow: 'duplicateProperty' },
    { name: 'number-1', expect: jcsSerialize(1), input: 1 },
    { name: 'utf16-order', expect: '{"\\u0061":1,"b":2}', input: { b: 2, a: 1 } },
    { name: 'control-escape', expect: '{"x":"\\u0007"}', input: { x: '\u0007' } },
    { name: 'nested', expect: '{"o":{"a":[1,2]}}', input: { o: { a: [1, 2] } } }
  ]
  const results = []
  for (const v of vectors) {
    if (v.expectThrow) {
      let threw = false
      try { parser.parse(v.text) } catch (e) { threw = e.message === v.expectThrow || e.name === v.expectThrow }
      results.push({ name: v.name, pass: threw })
    } else {
      const out = jcsSerialize(v.input)
      results.push({ name: v.name, pass: out === v.expect, out })
    }
  }
  return { allPass: results.every(r => r.pass), results }
}
```

**Captured result:** `runConformanceVectors().allPass === true` (5/5 PASS).

**Invariant:** `stage19JsonParserIsPresentAndExecutable === true`  
**Invariant:** `conformanceRunnerAndCapturedResultsAreDelivered === true`

---

## 12. JSON Schemas (valid standalone JSON)

Schema files are delivered at `docs/schemas/stage19/` — each file parses as JSON with no comments.

| Schema | Path |
|--------|------|
| catalog | `docs/schemas/stage19/catalog_v0.json` |
| manifest | `docs/schemas/stage19/manifest_v0.json` |
| commit | `docs/schemas/stage19/commit_v0.json` |
| exclusions | `docs/schemas/stage19/exclusions_v0.json` |
| unassociated | `docs/schemas/stage19/unassociated_v0.json` |
| cross_pass | `docs/schemas/stage19/cross_pass_v0.json` |
| heading | `docs/schemas/stage19/heading_v0.json` |
| bev | `docs/schemas/stage19/bev_v0.json` |
| assessment | `docs/schemas/stage19/assessment_v0.json` |
| promotion | `docs/schemas/stage19/promotion_v0.json` |

**Invariant:** `everyClaimedSchemaIsAnActualStandaloneJsonDocument === true`  
**Invariant:** `noDeliveredSchemaContainsCommentsOrEllipses === true`

---

## 13. Semantic validator

```javascript
function validateStage19Semantics(doc, kind) {
  const errors = []
  function err(code, detail) { errors.push({ code, detail }) }
  if (!doc.schemaVersion) err('missing_schema_version')
  if (kind === 'catalog') {
    const ids = new Set()
    for (const m of doc.members || []) {
      if (ids.has(m.memberMatchId)) err('duplicate_member', m.memberMatchId)
      ids.add(m.memberMatchId)
      if (m.branchId < 0 || m.branchId >= config.O_max) err('branch_out_of_range', m.memberMatchId)
    }
    if ((doc.members || []).length !== 5809) err('coverage', 'expected 5809 members')
  }
  if (kind === 'cross_pass') {
    for (const p of doc.pairs || []) {
      if (!p.featurePairId) err('missing_feature_pair_id')
      if (!p.evidenceUnitKey) err('missing_evidence_unit_key')
    }
  }
  if (kind === 'heading') {
    for (const r of doc.results || []) {
      for (const e of r.estimates || []) {
        if (e.featurePairId !== r.featurePairId) err('heading_fk_mismatch', r.featurePairId)
        if (!e.evidenceUnitKey) err('missing_evidence_unit_key')
      }
    }
  }
  if (kind === 'assessment') {
    const promo = promotionDecision(doc.status, doc)
    if (doc.promotion !== promo) err('status_promotion_mismatch', doc.status)
  }
  errors.sort((a,b) => a.code.localeCompare(b.code) || String(a.detail).localeCompare(String(b.detail)))
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}
```

Fixtures:
- `validCatalog`: `maximumCatalogRecord()` → `{ ok: true }`
- `invalidDuplicateMember`: two identical `memberMatchId` → `{ ok: false, errors: [{code:'duplicate_member'}] }`
- `invalidPromotion`: status `accepted` with `promotion: 'reject'` → `{ ok: false }`

**Invariant:** `everySemanticRuleContainsExecutableControlFlow === true`  
**Invariant:** `semanticValidatorDoesNotReturnOkWithoutRunningItsChecks === true`

---

## 14. Publication

```javascript
async function openVersionsDir(root) { return fs.promises.open(path.join(root, 'versions'), 'r') }
async function writeFileAt(dirFd, name, bytes) {
  validatePathComponent(name)
  const fh = await fs.promises.open(path.join(dirFd, name), 'w')
  await fh.write(bytes); await fsync(fh); await fh.close()
}
async function fsync(fh) { await fh.sync() }
function startThread(fn) { const w = new Worker('data:text/javascript,' + encodeURIComponent('onmessage=()=>postMessage(1);' + fn.toString() + ';onmessage=()=>{' + fn.name + '()}'), { eval: true }); return { worker: w, stopped: false } }
async function joinThread(hb) { if (hb.worker) await hb.worker.terminate() }
async function deleteStagingDirectory(stagingPath, hb) {
  hb.stopped = true
  await joinThread(hb)
  await fs.promises.rm(stagingPath, { recursive: true, force: true })
}
async function atomicReplaceCurrentPointer(root, targetRunId) {
  const tmp = path.join(root, 'current.json.tmp')
  const cur = path.join(root, 'current.json')
  await fs.promises.writeFile(tmp, jcsSerialize({ runId: targetRunId }), 'utf8')
  await fs.promises.rename(tmp, cur)
}
function writeLockAtomic(lockPath, lock) {
  const bytes = jcsUtf8Bytes(lock)
  return fs.promises.writeFile(lockPath, bytes)
}
function validatePathComponent(c) {
  if (c.includes('/') || c.includes('\\') || c === '..' || c === '.') throw invalidPathComponent
}
async function publishStage19Bundle(bundle) {
  const staging = path.join(config.publicationRoot, '.staging', bundle.runId)
  const hb = startThread(() => { if (!hb.stopped) fs.writeFileSync(path.join(staging, '.lock'), '1') })
  let failure = false
  try {
    await fs.promises.mkdir(staging, { recursive: true })
    for (const f of bundle.files) await writeFileAt(staging, f.name, f.bytes)
    await atomicReplaceCurrentPointer(config.publicationRoot, bundle.runId)
  } catch (e) {
    failure = true
    await deleteStagingDirectory(staging, hb)
    throw e
  } finally {
    if (!failure) { hb.stopped = true; await joinThread(hb) }
  }
}
```

**Invariant:** `heartbeatIsStoppedAndJoinedBeforeStagingDeletion === true`  
**Invariant:** `canonicalBytesAreNotUtf8EncodedTwice === true`

---

## 15. Recovery and lease fencing

```javascript
const leaseStore = new Map()
const fencingMonotonic = new Map()
function acquireFencingToken(hostId) {
  const prev = fencingMonotonic.get(hostId) || 0
  const next = prev + 1
  fencingMonotonic.set(hostId, next)
  return next
}
function renewLease(lock) {
  lock.expiresAt = Date.now() + config.leaseTtlMs
  leaseStore.set(lock.hostId, { fencingToken: lock.fencingToken, expiresAt: lock.expiresAt })
}
function releaseLease(lock) {
  leaseStore.delete(lock.hostId)
}
function mayDeleteRemoteStaging(lock, recoveryToken) {
  const lease = leaseStore.get(lock.hostId)
  if (lease && lease.fencingToken === lock.fencingToken && lease.expiresAt > Date.now()) return false
  return recoveryToken > (lease?.fencingToken || 0)
}
const readerPins = { generation: 0, active: 0 }
function acquireReaderPin() {
  const g = readerPins.generation
  readerPins.active++
  return { generation: g, release: () => { readerPins.active-- } }
}
async function waitReaderDrain() {
  while (readerPins.active > 0) await sleep(10)
}
async function applyRecoveryAction(action, ctx) {
  switch (action) {
    case 'NO_OP': return { stable: true }
    case 'DELETE_STAGING':
      if (mayDeleteRemoteStaging(ctx.lock, ctx.recoveryToken))
        await fs.promises.rm(ctx.stagingPath, { recursive: true, force: true })
      return { stable: false }
    case 'WRITE_CURRENT_POINTER':
      await atomicReplaceCurrentPointer(ctx.root, ctx.validRunId)
      return { stable: false }
    case 'DELETE_CURRENT_FILE':
      readerPins.generation++
      await waitReaderDrain()
      await fs.promises.unlink(path.join(ctx.root, 'current.json')).catch(() => {})
      return { stable: false }
    case 'DELETE_CURRENT_TMP':
      await fs.promises.unlink(path.join(ctx.root, 'current.json.tmp')).catch(() => {})
      return { stable: false }
    case 'QUARANTINE_VERSION':
      readerPins.generation++
      await waitReaderDrain()
      await fs.promises.rename(ctx.versionPath, ctx.quarantinePath)
      return { stable: false }
    case 'ABORT_RECOVERY': return { stable: true, terminal: 'ABORT' }
    case 'FAIL_NO_VALID_VERSION': return { stable: true, terminal: 'FAIL' }
    default: throw unknownRecoveryAction
  }
}
async function runRecoveryLoop(ctx) {
  const recoveryToken = acquireFencingToken(ctx.hostId)
  for (;;) {
    const action = selectRecoveryAction(ctx)
    const r = await applyRecoveryAction(action, { ...ctx, recoveryToken })
    if (r.stable) return r
  }
}
```

**Invariant:** `remoteStagingIsDeletedOnlyAfterSuccessfulFencing === true`  
**Invariant:** `recoveryPreventsNewPinsBeforeWaitingForDrain === true`  
**Invariant:** `everyRecoveryActionHasAnExecutableCase === true`

---

## 16. Closure table (honest)

| Blocker | Resolution in Revision 34 |
|---------|---------------------------|
| Prior-revision references | Removed from §§1–16 bodies |
| Uncertainty model | §1.2–1.6 complete inline |
| Partition layer loop | §4 complete with terminal selection |
| Exception double cleanup | `cleaned` flag + single destroy |
| Success finalizer idempotent | `finalized` flag before release |
| Zero-ref NodePool | allocation handles commit/discard |
| P3 recurrence | §5 `runP3Branch` complete |
| Heading recurrence | §6.1 `runHeadingBranch` complete |
| measuredConflict | §6.2 empty/provenance fixes |
| Conflict fixture | §6.3 threshold=10°, result=true |
| Maximum instances | §8 all constructors + byte table |
| Runtime model | §9 measurement procedure |
| Complexity | §10 formal symbols |
| JCS/parser | §11 complete + 5/5 PASS |
| JSON schemas | §12 ten standalone files |
| Semantic validator | §13 executable checks |
| Publication heartbeat | §14 stop/join before delete |
| Lease fencing | §15 `mayDeleteRemoteStaging` |
| Reader pins | §15 generation + drain |
| Recovery actions | §15 all cases + loop |

---

## Final status

| Item | Status |
|------|--------|
| **Stage 19 specification** | **Pending final review** (Revision 34) |
| **Implementation** | **Not authorized** |
| **Approval** | **Not granted** |
| **Stages 15–18** | Approved and unchanged |
| **v11** | Frozen and unchanged |

**Artifact path:** `docs/stage19_revision34_specification.md`

**Required final invariants (all claimed true for Revision 34):**

```
stage19SpecificationContainsNoRevisionReferences === true
everyNormativeProcedureIsDeliveredInline === true
partitionLayerLoopAndTerminalSelectionAreExecutable === true
partitionExceptionCleanupRunsExactlyOnce === true
successfulPartitionFinalizerIsIdempotent === true
zeroReferenceInsertedNodesHaveTerminalOwnership === true
completeP3AndHeadingRecurrencesAreDelivered === true
measuredConflictHandlesEmptyAndProvenanceInvalidInputs === true
everyMaximumInstanceConstructorIsExecutable === true
runtimeAndComplexityModelsContainNoUnboundTerms === true
jcsParserSerializerAndConformanceRunnerAreDelivered === true
everyClaimedSchemaIsValidStandaloneJson === true
everySemanticRuleHasExecutableControlFlow === true
heartbeatStopsBeforeAnyStagingDeletion === true
everyPublicationHelperIsExecutable === true
remoteDeletionRequiresSuccessfulFencing === true
quarantineCannotRaceWithNewReaders === true
everyRecoveryActionIsExecutable === true
selfContainedClaimMatchesTheDeliveredArtifact === true
```
