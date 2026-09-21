# Seg19→Seg20 rollback — Diagnosis

## Summary
Primary classification: **rollback-scope bug**.
Trigger subtype: **later hidden-source preparation failure** (`missingNewSourceChunk` for Seg22).

The optional preparation of the next hidden lookahead source (Seg22) ran inside the same
transaction as the required Seg19→Seg20 reveal. When that optional preparation failed, the
append handler rolled the already-committed Seg20 back to Seg19.

## Evidence

### Sparse numbering (correct)
Available numeric sources around the boundary: `18, 19, 20, 22, 23, 24`. There is **no Seg21**.
The resolver sorts by numeric ID and selects the smallest available ID greater than the current one:
- `nextAfter19` = Seg20
- `nextAfter19+20` = Seg22
- `nextAfter20` = Seg22

The resolver does **not** invent Seg21. Source resolution is not the defect.

### Seg19→Seg20 reveal succeeds and commits
`revealPreparedLookahead` returned `ok: true`; the prepared checksum equals the revealed checksum
(`5d001e15…08bcf4`). The visible prefix became `[Seg19, Seg20]` and Seg20 entered playback
(arrow and video on Seg20). Seg20 is committed **before** the failure.

### The failure is preparing the later hidden source Seg22
`prepareHiddenLookaheadSource(Seg22)` →
`applyProgressiveFrozenAppend` → `{ ok: false, reason: 'missingNewSourceChunk' }`.

Cause of `missingNewSourceChunk`: Seg22 is present in the combined `timeline` (30 frames) and in
`vehiclePath` (30 points), but it is **absent from `map.trajectory`** (0 points). `applyProgressiveFrozenAppend`
splits `freshBaseMap.trajectory` by source and therefore finds no Seg22 chunk.

### Old transaction (too broad)
`progressiveRevealPrepared` performed the required reveal+commit and then, in the same flow, awaited the
optional later preparation. The throw from the optional preparation propagated to `progressiveAppendNext`,
whose catch ran `restoreProgressiveStateSnapshot(prefixSnapshotKey([Seg19]))`, restoring Seg19 and removing
the committed Seg20.

### New transaction (narrow)
- Required stage: reveal must succeed to commit; a reveal failure still rolls back.
- Optional stage: the later-lookahead preparation runs in its own try/catch. On failure it:
  - keeps the committed Seg20 (does not roll back);
  - clears only `hiddenLookahead`;
  - reports the failed source.
- `progressiveAppendNext` adds a retry path (re-attempt preparation of the next available source) and a
  true terminal-source path.
- `updateProgressiveCombinedStatusLabel` disables append controls only for a true terminal source.

### Guarantees verified by the new focused tests (22/22)
- A genuine reveal failure still rolls back (`revealOk: false` → rollback).
- A true final source (no following) is terminal: commit stands, append controls disable,
  status "End of available segments".
- A stale later-preparation failure clears only `hiddenLookahead` and never rewrites `visiblePrefix`.
- Hidden Seg22 remains excluded from the visible display map.
- Display-map coordinate checksums remain unchanged across reveal (visible prefix stable).

## Not changed
No changes to geometry, placement mathematics, boundary thresholds, combined orientation, CVLP,
purityRevisit, representative lines, or lane mapping. The fix is confined to the progressive append
transaction scope and next-source handling.
