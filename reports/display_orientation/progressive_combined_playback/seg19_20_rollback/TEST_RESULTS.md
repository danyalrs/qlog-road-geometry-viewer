# Phase 2 — Seg19→Seg20 rollback — Test results

## Completed batches (remaining regression coverage)

| Batch | Tests | Pass | Fail | Skipped | Duration |
|---|---|---|---|---|---|
| `uds-1..3` | 3 | 3 | 0 | 45 | 1.3 s |
| `uds-4..6` | 3 | 3 | 0 | 45 | 51.6 s |
| `uds-7..9` | 3 | 3 | 0 | 45 | 44.4 s |
| `uds-10..13` | 4 | 4 | 0 | 44 | 3 m 35 s |
| `uds-14..17` | 4 | 4 | 0 | 44 | 7 m 48 s |
| `candidate-off` | 1 | 1 | 0 | 47 | 7.6 s |

Command form: `node --test --test-name-pattern="<group>" tests/progressive_combined_playback.test.js`
No test was deleted, skipped, or weakened; no arbitrary timeouts were increased.

## Progressive combined playback suite — now complete
- numeric batch (tests 1–19): 19/19 (completed earlier)
- playback batch (playback-1..11): 11/11 (completed earlier)
- UDS + candidate-off batch (uds-1..17, candidate-off): 18/18 (this task)
- Total: **48/48**

## Focused transaction tests
- `tests/progressive_transaction_scope.test.js`: **22/22** (completed earlier; not rerun)

## Previously completed suites (not rerun)
- viewport + local playback + geometry + stationary + purityRevisit: 140/140
- combined regression set: 58/58

## Outcome
No regressions. No batch timed out when split into the groups above.
