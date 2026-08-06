# Amendment A — Test Matrix Specification

**Status:** DRAFT — NOT APPROVED  
**Specification version:** `stage20-amendment-a-spec-v3` (scope correction)  
**Parent:** [stage20-amendment-a-specification.md](./stage20-amendment-a-specification.md)

Tests are **specified only** — not implemented.

**v3 changes:** Separated comparison-key match from corridor linkage. Renamed real-data pairs to key-collision linkage hypotheses. Added linkage-record fixtures. Repaired T-A-034 positive fixture.

---

## 1. Emission and propagation (`flushRun`)

### T-A-001 — Valid single-observation run

| Field | Value |
|-------|-------|
| **Fixture** | Track `0:0:0:0`, `trackIndex: 0` |
| **Expected output** | v1 run; `dividerCorridorId: "0:0:0"`; `boundaryProvenance.comparisonKeyScope: "within_segment"` |
| **Invariant** | SAT-6 |

### T-A-002 — Valid multi-observation run

Unchanged (uniform `segmentId`).

### T-A-003 through T-A-013

Unchanged from v1 (missing fields, conflicts, serialization).

### T-A-014 — `dividerCorridorId` as comparison key

| Field | Value |
|-------|-------|
| **Fixture** | Track `chunkId:0, poseSectionId:4, trackIndex:2, segmentId:10` |
| **Expected output** | `dividerCorridorId: "0:4:2"` — within-segment key only |
| **Invariant** | Not corridor identity |

### T-A-015 — `trackIndex` propagation

Unchanged.

---

## 2. Identity conflicts

### T-A-020 — Same parentTrackId, different temporalPassId

| **Expected** | Reject `A-PTR-001` |
| **Invariant** | SAT-3 |

### T-A-021 — Run temporalPassId differs from parent track

| **Expected** | Reject `A-PTR-001` |

---

## 3. Comparison-key match and linkage (v3)

### T-A-030 — Valid same-pass grouping

| **Expected** | `true` when all identity fields equal |

### T-A-031 — Same-pass cannot be corridor-linked

| **Expected** | `false` — requires different `parentTrackId` |

### T-A-032 — Comparison-key match (same segment)

| Field | Value |
|-------|-------|
| **Fixture** | Run A: `segmentId:10, parentTrackId:"0:0:4:0", temporalPassId:0, dividerCorridorId:"0:4:0"`; Run B: `segmentId:10, parentTrackId:"0:1:4:0", temporalPassId:1, dividerCorridorId:"0:4:0"` |
| **Action** | `isComparisonKeyMatch(A, B)` |
| **Expected** | `true` |
| **Must NOT** | Imply corridor-linked |

### T-A-033 — Comparison-key match without linkage record

| Field | Value |
|-------|-------|
| **Fixture** | T-A-032 pair, no corridor linkage artifact |
| **Action** | Cross-pass promotion |
| **Expected** | **Linkage hypothesis** or provisional only — NOT structural, NOT genuine |
| **Code** | `A-XPS-012` if promotion attempted |

### T-A-034 — Structural candidate: positive fixture (repaired)

| Field | Value |
|-------|-------|
| **Fixture** | **Synthetic same-segment:** Run A `segmentId:10, parentTrackId:"0:0:4:0", temporalPassId:0, chunkId:0, poseSectionId:4, trackIndex:0, dividerCorridorId:"0:4:0", routeS 0–100`; Run B `segmentId:10, parentTrackId:"0:1:4:0", temporalPassId:1, chunkId:0, poseSectionId:4, trackIndex:0, dividerCorridorId:"0:4:0", routeS 50–120`; **plus** validated corridor linkage record `linkageType:same_segment, segmentId:10, validationState:validated, roadCorridorId:"corridor:test-040", endpoints` matching both runs with scoped `poseSectionRef` |
| **Action** | Structural cross-pass evaluation |
| **Expected** | Structural candidate; overlap ≥ 5 m |
| **Invariant** | **SAT-1** — satisfiable without out-of-scope ID comparison |

### T-A-035 — Cross-segment key collision (real data shape)

| Field | Value |
|-------|-------|
| **Fixture** | Run A `segmentId:64, parentTrackId:"0:0:4:0", dividerCorridorId:"0:4:0"`; Run B `segmentId:57, parentTrackId:"0:1:4:0", dividerCorridorId:"0:4:0"` — no alignment record |
| **Action** | Cross-pass evaluation |
| **Expected** | **Linkage hypothesis (cross-segment key collision)** — NOT comparison-key match, NOT corridor-linked, NOT structural |
| **Code** | `A-XPS-013` |
| **Invariant** | SAT-5 |

### T-A-036 — Equal chunkId across segments without linkage

| Field | Value |
|-------|-------|
| **Fixture** | Run A `segmentId:2, chunkId:0`; Run B `segmentId:5, chunkId:0` |
| **Expected** | Unavailable / reject direct comparison `A-XPS-010` |

### T-A-037 — Equal poseSectionId across passes without linkage

| Field | Value |
|-------|-------|
| **Fixture** | Pass 0 `poseSectionId:4`; Pass 1 `poseSectionId:4`; no corridor linkage record |
| **Expected** | Comparison-key match at most — NOT corridor-linked |
| **Invariant** | SAT-4 |

### T-A-038 — Valid authoritative corridor linkage (same segment)

| Field | Value |
|-------|-------|
| **Fixture** | T-A-032 pair + linkage record `validationState:validated`, endpoints with full scoped refs |
| **Expected** | **Corridor-linked** |

### T-A-039 — Conflicting linkage records

| Field | Value |
|-------|-------|
| **Fixture** | Two records, same endpoint pair, different `roadCorridorId` |
| **Expected** | `validationState: conflict`, `A-LNK-002` |

### T-A-040 — Missing linkage provenance

| Field | Value |
|-------|-------|
| **Fixture** | Linkage record without `provenance` |
| **Expected** | Reject `A-LNK-005` |

### T-A-041 — Cross-segment with validated alignment

| Field | Value |
|-------|-------|
| **Fixture** | T-A-035 pair + validated cross-segment linkage + validated alignment record |
| **Expected** | Eligible for structural (if overlap rules met) |

### T-A-042 — Same segmentId without traversal proof

| **Expected** | Structural at most; genuine requires traversal linkage — else provisional `A-XPS-007` |

### T-A-043 — Deterministic linkage grouping

| Field | Value |
|-------|-------|
| **Fixture** | Multiple validated linkage records |
| **Action** | Group by `roadCorridorId`, order by `corridorLinkageId` |
| **Expected** | Deterministic |

### T-A-044 — Equal dividerCorridorId text without linkage (negative)

| Field | Value |
|-------|-------|
| **Fixture** | Comparison-key match; no linkage artifact |
| **Expected** | Linkage hypothesis only — never structural |

### T-A-045 — Equal local numerics across segments without linkage (negative)

| Field | Value |
|-------|-------|
| **Fixture** | Segments 64/57, key text `0:4:0`, no alignment |
| **Expected** | Unavailable for structural promotion |
| **Invariant** | SAT-7 |

### T-A-046 — Self-pair rejection

| **Code** | `A-XPS-002` |

### T-A-047 — Cross-chunk same pass

| **Code** | `A-XPS-003` |

### T-A-048 — Duplicate feature pair

| **Code** | `A-DUP-003` |

### T-A-049 — Geometry overlap not corridor identity

| **Code** | `A-LEG-003` |

---

## 4. Legacy and immutability

T-A-050 through T-A-053 unchanged (v5 bundle, v11, current.json, Rev 37 12 m).

---

## 5. Real-data linkage hypotheses (terminology)

| Pair | Classification under v3 |
|------|-------------------------|
| `0:0:4:0` (seg 64) ↔ `0:1:4:0` (seg 57) | Cross-segment key collision → linkage hypothesis |
| `0:0:4:1` (seg 64) ↔ `0:1:4:1` (seg 57) | Cross-segment key collision → linkage hypothesis |
| `0:0:4:2` (seg 64) ↔ `0:1:4:2` (seg 57) | Cross-segment key collision → linkage hypothesis |

**MUST NOT** be labelled corridor-matched or corridor-linked without validated linkage + alignment records.

---

## 6. Coverage summary

| Category | Tests | Invariants |
|----------|------:|------------|
| Emission | 15 | SAT-6 |
| Identity conflicts | 2 | SAT-3 |
| Comparison-key / linkage | 20 | SAT-1, SAT-2, SAT-4, SAT-5, SAT-7 |
| Legacy / immutability | 4 | — |
| **Total** | **41** | All SAT-* |

---

*v3 test matrix — not implemented.*
