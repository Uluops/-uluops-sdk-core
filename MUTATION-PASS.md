# Mutation pass — P0s (sdk-core retry opt-out)

Definition-version-comparison spec v0.10.0 §11 item 20; checklist v0.12.0 §P0s. Each row is a §11 item 11 control this phase owns, run against the defect it names. The failing run is a pushed branch holding the mutated tree (one commit on top of `feat/p0s-retry-opt-out` at `0e87c48`); re-run with `git checkout <branch> && npx vitest run test/retry-opt-out.test.ts`. Every run below exited 1. Run 2026-10-03.

| control | defect (mutation) | failing run |
|---|---|---|
| A GET 503/502/504 with `details.retryable === false` is not retried | `retry-opt-out`: `isRetryable()` decides by status code alone (the opt-out line removed) — the pre-0.19.0 rule | `mutation/p0s/retry-opt-out` — 7 failed / 6 passed; `× GET 503 with details.retryable=false (busy) is not retried and keeps details.reason` → `AssertionError: expected 3 to be 1` |
| `createErrorFromStatus` passes `details` for 502/503/504 | `details-threaded`: factory calls `new ServiceUnavailableError(safe, retryAfter, requestId)` without details | `mutation/p0s/details-threaded` — 9 failed / 4 passed; `× 503 keeps every detail and merges retryAfter` → `AssertionError: expected { retryAfter: 7 } to deeply equal { retryable: false, …(2) }` |
| `ServiceUnavailableError` keeps `details`, merged with `retryAfter` (which wins) | `constructor-keeps-details`: constructor builds `{ retryAfter }` only, dropping the passed details | `mutation/p0s/constructor-keeps-details` — 10 failed / 3 passed; `× constructor-supplied retryAfter wins over a details.retryAfter` |
| Other 503s still retry | `other-503s-retry`: over-broad opt-out — any detail other than `retryAfter` without `retryable: true` disables retry | `mutation/p0s/other-503s-retry` — 2 failed / 11 passed; `× a 503 whose details do not opt out (retryable absent) is still retried and keeps its details` → `AssertionError: expected 1 to be 2` |
| Only a literal `false` opts out | `literal-false-only`: the string `'false'` also opts out | `mutation/p0s/literal-false-only` — 1 failed / 12 passed; `× only a literal \`false\` opts out — a truthy-looking string does not` → `AssertionError: expected 1 to be 2` |

The phase's original negative control (all of the above at once: source at `c6f6bac`, sdk-core 0.18.1) is in the `0e87c48` commit body: 10 failed / 3 passed.
