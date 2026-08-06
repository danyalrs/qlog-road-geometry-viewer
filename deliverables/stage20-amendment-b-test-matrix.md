# Amendment B — Test Matrix Specification

**Status:** DRAFT — NOT APPROVED  
**Specification version:** `stage20-amendment-b-spec-v1`  
**Parent:** [stage20-amendment-b-specification.md](./stage20-amendment-b-specification.md)

Tests are **specified only** — not implemented.

**Total specified cases:** **44** (18 B-MOTION + 26 B-TRAV)

---

## Legend

| Column | Meaning |
|--------|---------|
| **Status** | `authoritative` = validated record expected; `provisional` = hypothesis/unavailable for promotion |
| **Determinism** | `required` = byte-identical rerun on fixed inputs |
| **Protected** | `v5-unchanged` = Stage 19 v5 bundle hash unchanged |

---

## Part 1 — B-MOTION (within-track linking)

### T-B-M-001 — Rev 37 baseline when module disabled

| Field | Value |
|-------|-------|
| **Requirement** | Default path uses Rev 37 `staticBranchCandidateEdge` unchanged |
| **Fixture** | Standard Stage 19 partition fixture |
| **Input** | `motionLinkingEnabled: false` |
| **Expected** | Identical chains to v5 baseline |
| **Code** | — |
| **Status** | authoritative |
| **Determinism** | required |
| **Protected** | v5-unchanged |

### T-B-M-002 — Low residual same boundary accepted

| Fixture | `FX-M-001` — consecutive obs, residual < cap, same chunk/pass/section |
| **Expected** | `decision: accepted` |
| **Code** | — |
| **Invariant** | SAT-M-1 |

### T-B-M-003 — High residual rejected

| Fixture | `FX-M-002` |
| **Expected** | `decision: rejected` |
| **Code** | `B-MOT-030` |

### T-B-M-004 — Stage 17 gap intersection

| Fixture | `FX-M-003` |
| **Expected** | rejected |
| **Code** | `B-MOT-010` |

### T-B-M-005 — Cross-chunk rejection

| **Expected** | rejected | **Code** | `B-MOT-011` |

### T-B-M-006 — Cross-pose-section rejection

| **Expected** | rejected | **Code** | `B-MOT-012` |

### T-B-M-007 — Cross-pass (different temporalPassId) rejection

| **Expected** | rejected | **Code** | `B-MOT-013` |

### T-B-M-008 — Cross-segment rejection

| **Expected** | rejected | **Code** | `B-MOT-014` |

### T-B-M-009 — Missing pose

| **Expected** | rejected | **Code** | `B-MOT-020` |

### T-B-M-010 — Pose inconsistency / GPS jump

| **Expected** | rejected | **Code** | `B-MOT-021` |

### T-B-M-011 — Stationary pair low displacement

| **Expected** | accepted when both displacements < 2 m and residual ≤ cap |

### T-B-M-012 — Deterministic edge ordering

| **Action** | Build audit artifact twice |
| **Expected** | Identical `contentHashSha256` |
| **Determinism** | required |

### T-B-M-013 — Duplicate edgeId in artifact

| **Expected** | envelope reject | **Code** | `B-MOT-031` |

### T-B-M-014 — No cross-pass artifact emission

| **Action** | Enable B-MOTION on multi-pass dataset |
| **Expected** | Zero corridor/traversal linkage records emitted |

### T-B-M-015 — v5 bundle immutable

| **Expected** | Published v5 manifest hash unchanged |
| **Protected** | v5-unchanged |

### T-B-M-016 — Residual cap not approved flag

| **Expected** | `residualCapApproved: false` until checkpoint |

### T-B-M-017 — Long Δt rejection

| **Expected** | rejected when Δt > Stage 17 envelope |

### T-B-M-018 — Implausible speed

| **Expected** | rejected | **Code** | `B-MOT-022` |

---

## Part 2 — B-TRAV (traversal evidence and linkage)

### T-B-T-001 — Valid same-segment traversal linkage

| Fixture | `FX-B-001` |
| **Input** | v1 runs + validated corridor linkage + movement evidence |
| **Expected** | `validationState: validated` on traversal linkage |
| **Status** | authoritative |
| **Invariant** | SAT-B-1 (part) |

### T-B-T-002 — Valid cross-segment traversal with alignment

| Fixture | `FX-B-002` |
| **Expected** | validated traversal + cross-segment corridor alignment present |
| **Invariant** | SAT-B-1 |

### T-B-T-003 — Same local IDs without linkage unavailable

| Fixture | `FX-B-003` |
| **Expected** | `unavailable` — not structural/genuine |
| **Invariant** | SAT-B-4 |

### T-B-T-004 — Same pass as two traversals

| Fixture | `FX-B-004` |
| **Expected** | unavailable | **Code** | `B-TRV-003` |

### T-B-T-005 — Stationary GPS drift

| Fixture | `FX-B-005` |
| **Expected** | reject evidence | **Code** | `B-TRV-031` |

### T-B-T-006 — Heading reversal without proof

| Fixture | `FX-B-006` |
| **Expected** | reject | **Code** | `B-TRV-032` |

### T-B-T-007 — Missing movement evidence

| Fixture | `FX-B-007` |
| **Expected** | reject | **Code** | `B-TRV-030` |

### T-B-T-008 — Route-s overlap without corridor linkage

| Fixture | `FX-B-008` |
| **Expected** | provisional only — not structural |
| **Invariant** | SAT-B-2 |

### T-B-T-009 — Corridor without traversal

| Fixture | `FX-B-009` |
| **Expected** | structural max provisional (`A-XPS-007`) |
| **Invariant** | SAT-B-3 (partial) |

### T-B-T-010 — Traversal without corridor

| Fixture | `FX-B-010` |
| **Expected** | reject linkage | **Code** | `B-TRV-020` |
| **Invariant** | SAT-B-2 |

### T-B-T-011 — Duplicate traversal pair

| Fixture | `FX-B-011` |
| **Expected** | reject | **Code** | `B-TRV-004` |

### T-B-T-012 — Reversed duplicate pair

| **Expected** | reject | **Code** | `B-TRV-005` |

### T-B-T-013 — Conflicting traversal records

| Fixture | `FX-B-012` |
| **Expected** | `validationState: conflict` | **Code** | `B-TRV-038` |

### T-B-T-014 — Missing endpoint

| **Expected** | reject | **Code** | `B-TRV-001` |

### T-B-T-015 — Unresolved endpoint FK

| **Expected** | reject | **Code** | `B-TRV-002` |

### T-B-T-016 — Unvalidated corridor linkage

| **Expected** | provisional only | **Code** | `B-TRV-021` |

### T-B-T-017 — Timestamp conflict

| **Expected** | reject | **Code** | `B-TRV-033` |

### T-B-T-018 — Implausible displacement/speed

| **Expected** | reject | **Code** | `B-TRV-035` |

### T-B-T-019 — Cross-segment alignment unavailable

| **Expected** | unavailable for structural | **Code** | `B-TRV-036` |

### T-B-T-020 — Missing provenance

| **Expected** | reject | **Code** | `B-TRV-037` |

### T-B-T-021 — Motion similarity not corridor identity

| **Expected** | unavailable | **Code** | `B-TRV-040` |

### T-B-T-022 — Geometry-only corridor claim

| **Expected** | reject | **Code** | `B-TRV-041` |

### T-B-T-023 — temporalPassId alone not traversal proof

| **Expected** | unavailable | **Code** | `B-TRV-042` |

### T-B-T-024 — Deterministic linkage grouping

| **Action** | Sort traversal linkage records |
| **Expected** | Stable `traversalLinkageId` order |
| **Determinism** | required |

### T-B-T-025 — Genuine evidence requires both linkages

| Fixture | `FX-B-001` + validated traversal |
| **Expected** | `genuine_cross_pass_evidence` via Amendment A consumer |
| **Invariant** | SAT-B-1 |

### T-B-T-026 — Zero real-data genuine is valid

| Fixture | Real v1 artifact, no linkage files |
| **Expected** | `genuine: 0`, `structural: 0` — pass |
| **Invariant** | SAT-B-5 |

---

## Coverage summary

| Category | Tests | Invariants |
|----------|------:|------------|
| B-MOTION linking | 18 | SAT-M-1 |
| B-TRAV evidence/linkage | 26 | SAT-B-1 … SAT-B-5 |
| **Total** | **44** | |

---

## Satisfiability tests (mandatory before implementation approval)

| ID | Statement | Test IDs |
|----|-----------|----------|
| SAT-B-1 | Synthetic fixture reaches genuine evidence | T-B-T-001, T-B-T-002, T-B-T-025 |
| SAT-B-2 | Missing corridor → no structural/genuine | T-B-T-008, T-B-T-010 |
| SAT-B-3 | Missing traversal → no genuine | T-B-T-009, T-B-T-025 (negative branch) |
| SAT-B-4 | Equal local IDs without linkage unavailable | T-B-T-003 |
| SAT-B-5 | Zero real-data genuine valid | T-B-T-026 |
| SAT-M-1 | Motion module forms ≥1 accepted edge on fixture | T-B-M-002 |

---

*v1 test matrix — not implemented.*
