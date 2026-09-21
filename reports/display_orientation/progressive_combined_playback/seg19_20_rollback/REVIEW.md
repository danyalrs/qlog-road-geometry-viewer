# Seg19→Seg20 rollback — Review package

## Status
ROLLBACK FIX IMPLEMENTED — USER VISUAL REVIEW REQUIRED

## What changed (uncommitted, Phase 2)
- `lib/progressive_combined_playback.js` (canonical) + `public/progressive_combined_playback.js` (mirror)
  - added `resolveAppendTransaction` (required-vs-optional transaction rule)
  - added `formatAppendStatusLabel` (terminal / failed-source status text)
- `public/app.js`
  - `progressiveRevealPrepared`: optional later-lookahead preparation wrapped in its own try/catch;
    keeps the committed reveal; clears only `hiddenLookahead`; reports the failed source
  - `progressiveAppendNext`: retry path + true terminal-source handling
  - `updateProgressiveCombinedStatusLabel`: disables append controls only at a true terminal source
- `tests/progressive_transaction_scope.test.js` (new focused tests)

## Results
- Focused transaction tests: 22/22
- Progressive combined playback suite (complete): 48/48 (numeric 19, playback 11, UDS+candidate-off 18)
- Prior suites (not rerun): viewport+local+geometry+stationary+purityRevisit 140/140; combined set 58/58
- Canonical/public sync: idempotent; expected browser-wrapper difference only
- Syntax: all changed JS files pass `node --check`

## Failure classification
Primary: rollback-scope bug. Trigger: later hidden-source preparation failure (`missingNewSourceChunk` for Seg22).
Seg20 reveal succeeds and commits; Seg22 hidden preparation fails; the old transaction rolled Seg20 back.

## Manual review URL
```
http://localhost:3847/?segments=19&local=1&fit=1&mirror=1&progressiveCombinedPlaybackCandidate=1&progressiveViewportCandidate=1
```

## Manual review steps
1. Process Seg19.
2. Confirm `Next prepared: Seg20`.
3. Click **Append next segment**.
4. Confirm Seg20 remains visible.
5. Confirm the status reports the Seg22 preparation failure **without returning to Seg19**.
6. Remove Seg20 and confirm exact Seg19 restoration.
7. Retry with **Append next and continue**.
8. Confirm arrow and video enter Seg20.
9. Confirm Seg20 remains visible after the Seg22 preparation failure.
10. Confirm retry controls remain available (append buttons enabled because Seg22 exists).
11. Confirm no hidden Seg22 geometry appears in the visible display.
12. Confirm viewport and top playback controls remain synchronized.

## Evidence files
- `DIAGNOSIS.md`
- `source_resolution_trace.json`
- `transaction_stage_trace.json`
- `append_mode_comparison.json`
- `TEST_RESULTS.md`
- `REVIEW.md` (this file)

## Limitations
- Phase 2 remains uncommitted by instruction.
- Live browser automation was not used; manual review is requested.
- The underlying reason Seg22 is absent from `map.trajectory` (present in timeline and vehiclePath) is a
  separate processing/data characteristic and is out of scope for this transaction fix.
