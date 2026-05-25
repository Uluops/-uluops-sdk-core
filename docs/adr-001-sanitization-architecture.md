# ADR-001: Three-Layer Sanitization Architecture

**Status:** Accepted
**Date:** 2026-05-25
**Context:** Security-focused cognitive lens analysis (6-lens run, sdk-core project)

## Decision

sdk-core uses three distinct sanitization functions, each operating at a different abstraction level:

| Function | Target | Call Site | Mechanism |
|----------|--------|-----------|-----------|
| `sanitizeForDisplay` | Structured objects | `SdkApiError.toJSON()` | Redacts values under sensitive key names |
| `sanitizeForLog` | Log arguments | `createLogger()` internals | Same key-based redaction, different traversal |
| `sanitizeString` | Free-form text | `SdkApiError.toJSON()`, error messages | Regex patterns matching credential values inline |

Additionally, `REDACTED_DETAIL_KEYS` in `http-client.ts` strips server-internal keys (stack traces, SQL, system paths) from API error responses before they reach `SdkApiError.details`.

## Context

Multiple cognitive lens agents flagged the three-layer approach as a maintenance burden (laozi-analyst F-002) and noted the lack of a unifying threat model document (nietzsche-analyst). This ADR serves as that document.

The sanitization layers evolved independently:
1. `sanitizeForLog` was the original (v0.1.0) — protects console output
2. `sanitizeForDisplay` was added for `toJSON()` — protects serialized error objects
3. `sanitizeString` was added later — catches credentials embedded in message strings
4. `REDACTED_DETAIL_KEYS` was added as defense-in-depth against API error passthrough

## Rationale

### Why not unify into one function?

Each layer operates on different input types with different tradeoffs:

- **Object sanitization** (`sanitizeForDisplay`, `sanitizeForLog`) matches on key names. It cannot catch `"Login failed with apiKey=ulr_abc123"` because the credential is embedded in a string value, not a key.
- **String sanitization** (`sanitizeString`) matches on value patterns via regex. It cannot redact `{ token: 'abc' }` because it doesn't see object structure.
- **Key stripping** (`REDACTED_DETAIL_KEYS`) operates on the error response envelope before any SdkApiError is constructed. It removes keys that should never reach the client regardless of their values.

A unified function would need to handle all three input types, which means either:
- Three code paths inside one function (same complexity, worse readability)
- A lowest-common-denominator approach that over-sanitizes or under-sanitizes

### Why a static key list for REDACTED_DETAIL_KEYS?

Pattern matching (e.g., `/sql|query|stack/i`) risks false positives on legitimate detail fields like `queryCount` or `stackSize`. The static list is reviewed periodically (last: 2026-05-23) and covers MySQL, Postgres, and SQLite internals. The API already sanitizes error responses server-side — this is defense-in-depth.

### Why sanitizeForDisplay checks key before recursing

As of commit 95243e2, `sanitizeForDisplay` checks `SENSITIVE_KEYS` before recursing into object values. Previously, `{ password: { hash: 'abc' } }` would recurse into the object and expose its contents. This was a divergence from `sanitizeForLog` which checked keys first. The fix aligns both functions.

## Threat Model

### What we protect against

1. **Credential leakage via error serialization.** When `toJSON()` is called (logging, HTTP response forwarding, error reporting), no credential values should appear in the output. Three vectors:
   - Credentials in `details` object → caught by `sanitizeForDisplay` (key-based)
   - Credentials in `message` string → caught by `sanitizeString` (pattern-based)
   - Server internals in API error body → caught by `REDACTED_DETAIL_KEYS` (pre-construction)

2. **Credential leakage via debug logging.** When the logger emits warn/error output (even with debug disabled), arguments are sanitized via `sanitizeForLog`.

### What we do not protect against

- **Memory inspection.** JavaScript strings are immutable and GC-managed. Credentials remain in heap memory until collected. CWE-316 mitigation (setting to empty string) is best-effort.
- **Destination-level SSRF.** The SDK validates `baseUrl` at construction time but not per-request destinations. This is acceptable because all endpoint paths are SDK-controlled string literals — no consumer input reaches URL construction.
- **Server-side leakage.** If the API returns credentials in its response body outside the `error` envelope, the SDK will not redact them. This is the API's responsibility.

## Consequences

- Three functions to maintain, each with its own pattern set
- New credential formats require updates in multiple places (SENSITIVE_KEYS regex, CREDENTIAL_VALUE_PATTERNS array, REDACTED_DETAIL_KEYS set)
- Test coverage must verify all three layers independently — a gap in one is not caught by the others
