# Changelog

All notable changes to `@uluops/sdk-core` will be documented in this file.

## [0.14.0] — 2026-07-02

Ships as MINOR per the pre-1.0 versioning policy: additive API (`onSecurityEvent`,
`RedirectError`) plus one contained behavioral change (redirects now throw a
distinct non-retryable error instead of a retryable `NetworkError`). Driven by the
`attack-path-audit` run #19, whose detectability lens scored lowest — the SDK's
highest-value attacker indicators were the least observable. This release folds in
the two unreleased 0.13.x hardening commits (requestId sanitization, logger
routing) alongside the new observability work.

### Added

- **Structured security-event channel (`onSecurityEvent`).** A single, optional,
  discriminated-union callback that delivers the security-relevant events the SDK
  already observes — `auth_failure` (a sent credential rejected with 401),
  `redirect_rejected` (a blocked upstream redirect), `token_refresh_failed`
  (re-login rejected), and `auth_strategy_replaced` (a live credential swap via
  `setAuthStrategy`). Before this, every such event reached the embedder only as
  free-text `console.warn` or an exception to classify; there was no routable
  structured signal. The channel is **reporting, not enforcement**: the SDK sets
  no policy and takes no action — the embedder routes events to its own telemetry
  sink. Delivery is best-effort and fire-and-forget; a handler that throws is
  caught and logged, never propagated into request flow. Every event field is
  credential-safe by construction. New public types exported from the root and
  `/http`: `SecurityEvent`, `SecurityEventHandler`, `SecurityEventType`,
  `AuthType`, and the four event interfaces. (Detectability finding `d2b84bc4`;
  also resolves the observability residue of `848a10e1` and the CD-1 observability
  leg of `251a2d7c`.)
- **`RedirectError` (exported, with `isRedirectError` guard).** A dedicated,
  **non-retryable** error for an upstream 3xx the SDK refuses to follow.

### Changed

- **Redirects now surface as `RedirectError`, not a retryable `NetworkError`.**
  All three `fetch()` call sites moved from `redirect: 'error'` to
  `redirect: 'manual'`; a 3xx from the configured origin is returned as an
  `opaqueredirect` and detected deterministically via `response.type` (with a 3xx
  status-range fallback for non-conforming HTTP stacks), then rejected with
  `RedirectError` and reported via `redirect_rejected`. Previously undici's
  redirect `TypeError` fell through `handleFetchError`'s `TypeError` branch into a
  retryable `NetworkError` — so a redirect (a potential MITM/misroute signal) was
  both auto-retried (pointless; hammered the redirect target) and buried among
  ordinary connection failures. The security property from 0.11.1 is preserved:
  the redirect is rejected before the request body (which can carry credentials on
  login) is replayed. Detection no longer depends on matching an undici-internal
  error string. **Migration:** code that caught redirects as `NetworkError` should
  now catch `RedirectError` (or `isRedirectError(e)`); redirects are no longer
  retried. (Finding `bdee74f9`.)
- **`setAuthStrategy` emits an `auth_strategy_replaced` security event.** The
  method remains an intentional, ungated trusted-caller capability (the login flow
  swaps in a session token) — its trust boundary is the process — but because the
  swap changes which credential every subsequent request carries, it is now
  observable. (Confused-deputy finding `251a2d7c`: addressed via observability +
  documentation, not gating, since gating would break the intended login flow.)

### Security

- **Sanitize the server-controlled `requestId`.** `SdkApiError` now strips control
  characters from the `x-request-id` value at construction, closing a CRLF/ANSI
  log-injection path via `.requestId` access and `toJSON()` — the server-controlled
  sibling of `message` and `details`, which were already sanitized. (Previously
  committed on this branch, unreleased.)
- **Route credential-load anomaly warnings through the structured logger.**
  `loadStoredCredentials` anomaly warnings (world-readable file mode, malformed
  `expiresAt`, invalid field formats) now go through `createLogger` rather than raw
  `console.warn`, giving consumers a single interception surface; and a token
  **refresh failure** is promoted from `debug` to `warn` so it is visible in
  production (a refresh failure means a previously-working credential was rejected
  at re-auth). (Previously committed on this branch, unreleased.)

### Documentation

- **SCOPE.md reconciled with reality.** Corrected the supply-chain posture: the
  `provenance: true` flag is configured but **not active** (local publishing
  produces no attestation; there is no CI), and `dist/` is not version-controlled —
  both gated on standing up an OIDC publish workflow (findings `af25ed88`,
  `aa945dd5`). Documented the `--omit=dev` audit gap (finding `8050bf35`, accepted
  with rationale), the new security-event channel and its reporting-only nature
  (perimeter bullet 8), and the trusted-caller model of `setAuthStrategy` (bullet
  9). Updated the redirect bullet (6) for `manual` + `RedirectError`.

## [0.13.0] — 2026-06-16

Ships as MINOR per the pre-1.0 versioning policy: bug fixes plus two contained
behavioral changes (stricter `isApiKey`, reworded 401 messages). Surfaced by the
registry-sdk `consumer-validate` run #40 (dx-validator).

### Fixed

- **`retries: 0` now makes one attempt instead of zero.** The retry loop used the retry budget directly as the attempt count, so `retries: 0` skipped the loop body entirely — the request was never sent and callers got a contextless `Error('Request failed')`. Attempt count is now floored at 1 (`Math.max(1, …)`), so `retries: 0` means "try once, do not retry" and surfaces the real typed error (e.g. `NetworkError` with the base URL and a curl hint, or the mapped HTTP error). Positive `retries` values are unchanged.

### Changed

- **401 errors now distinguish "credentials rejected" from "no credentials."** When credentials are present but the server returns 401, the SDK preserves the server's (sanitized) reason and **appends** actionable guidance naming the credential type (`api_key` / `session`) and noting it may be expired, revoked, or invalid — e.g. `"Token expired — the provided api_key credential was rejected (401) — it may be expired, revoked, or invalid. …"`. When the server gives no reason it falls back to `"Authentication failed: …"`. The appended text is hand-crafted (no server data), so wrapping the already-sanitized base message introduces no credential-leak path. The no-credentials message is unchanged except that the broken link to the private monorepo (which 404s for external consumers) has been removed; the actionable guidance remains.
- **`isApiKey()` now enforces the minimum key length** (`MIN_API_KEY_LENGTH`, promoted to `@uluops/sdk-core/config` constants and shared with the `ApiKeyAuth` constructor). Previously it checked only the `ulr_` prefix, so values like `ulr_` or `ulr_short` passed the pre-flight check but were then rejected by the constructor as "too short." A value that passes `isApiKey` is now guaranteed to pass the constructor's length gate.

## [0.12.0] — 2026-06-14

### Added

- **Shared content-addressing hash utilities** (`@uluops/sdk-core/utils`): `computeHash`, `computePromptHash`, `verifyHash`, `verifyPromptHash`. This is now the single canonical implementation used by both the registry API (computes/stores `hash` / `prompt_hash` at publish time) and `@uluops/core` (verifies caller-pinned hashes at resolve time), so the two sides hash identically by construction. Part of the registry integrity-verification work.
  - `computeHash(yaml)` normalizes before hashing (`yaml.parse` → `yaml.stringify` with `sortMapEntries`), with a raw-bytes fallback for non-object / unparseable content; `computePromptHash(runtimeMd)` hashes rendered markdown byte-for-byte (no normalization).
  - `verifyHash` / `verifyPromptHash` are timing-safe and **return `false` (never throw) on a malformed or wrong-length expected hash** — a length check precedes `timingSafeEqual`, so a bad caller pin yields a clean refusal instead of a `RangeError`.
  - The internal `normalizeForHash` helper is deliberately **not** exported; its behavior is locked by golden fixtures rather than a public contract.

### Dependencies

- **Add `yaml` pinned exact `2.9.0`** (per the supply-chain exact-pin policy). This is the version that produced the registry's currently-stored hashes; pinning guarantees normalization parity. Golden-fixture tests built from real published definitions fail loudly if a future `yaml` bump changes normalization.

## [0.11.1] — 2026-06-01

### Security

- **Reject HTTP redirects on all requests.** All three `fetch()` call sites now set `redirect: 'error'`. `validateBaseUrl` enforces transport rules at the configured origin but cannot follow redirect chains; per WHATWG fetch, `Authorization` is stripped cross-origin but the request body is not, so a 3xx on the login POST would otherwise replay email+password to an attacker-controlled host.
- **Strip control characters from error messages.** New `stripControlChars` helper (also exported) neutralizes CR/LF/null/tab in caller-supplied identifier fragments (e.g., `NotFoundError`'s `resource`) that previously flowed unfiltered into `error.message` and enabled log spoofing in consumer loggers. `SdkApiError` base constructor wraps the incoming message; `sanitizeString` strips control chars as its first step.
- **Widen header redaction.** `SENSITIVE_KEYS` in `sanitizeForLog` now matches `x-api-key`, `set-cookie`, `proxy-authorization`, and `x-auth-token`. Anchored form retained to avoid over-redacting legitimate fields like `token_count`.
- **Add `column` to `REDACTED_DETAIL_KEYS`.** The category comment promised `table, column, constraint` coverage but the implementation listed only `table` and `constraint`. Closes the comment/code divergence in defense-in-depth scope.
- **Extend `sanitizeString` free-text redaction.** Covers URL userinfo (`https://user:pass@host` — scheme preserved, credentials redacted) and bare JWT shapes (`eyJ`-prefixed `header.payload.signature`).

### Supply chain

- **Pin all dependencies and devDependencies to exact versions.** Adopted in response to today's RedHat-class supply-chain attack pattern. A poisoned upstream release auto-propagates through caret ranges on next `npm install` even with a lockfile present (npm install re-resolves carets when the lockfile drifts or regenerates). Pinning at the manifest level closes the gap — every dependency upgrade is now an explicit reviewable commit. Policy is "until further notice" and documented in `SCOPE.md` Supply Chain Posture.
- **Exclude source maps from the published tarball.** `files` array tightened from `["dist", "LICENSE"]` to `["dist/**/*.js", "dist/**/*.d.ts", "LICENSE"]`. Source maps embed absolute developer paths via `sourceRoot` and inline source via `sourcesContent`; published Node libraries rarely need them.
- **Bump Node engines floor from `>=18.0.0` to `>=20.0.0`.** Node 18 EOL'd April 2025.

### Documentation

- **SCOPE.md gains three Security Perimeter bullets** (5, 6, 7):
  - (5) `$HOME` single-user trust boundary for `~/.uluops/credentials.json` storage — shared-host deployments MUST use env vars instead.
  - (6) Redirect rejection on all `fetch()` calls.
  - (7) Redaction operates on ASCII-canonical key names and external-exposure strings; response key authoring is trusted to the upstream API.
- **SCOPE.md Supply Chain Posture** updated with the new exact-pinning producer-side rule.

## [0.11.0] — 2026-06-01

### Breaking

- **Removed `options.schema` parameter from `request`, `requestRaw`, `get`, `post`, `patch`, `put`, `delete`.**
  The parameter accepted any object with a `.parse()` method, which created a code-execution
  primitive when the schema was supplied by an untrusted source (security audit run #16). The
  SDK no longer invokes consumer-supplied callables.

  **Migration:** parse the result yourself after the call.

  ```ts
  // Before (0.10.x)
  const user = await client.get('/me', undefined, { schema: UserSchema });

  // After (0.11.0)
  const user = UserSchema.parse(await client.get<unknown>('/me'));
  ```

- **Removed `ResponseValidationError` class and `isResponseValidationError` type guard.**
  The class was only thrown by the removed `options.schema` path. Consumers parsing
  responses themselves see `ZodError` directly (or whatever their validation library throws).

- **Removed `ERROR_CODES.RESPONSE_VALIDATION_ERROR` constant.**

- **`zod` moved from `dependencies` to `devDependencies`.** sdk-core no longer
  depends on Zod at runtime. Consumer packages (registry-sdk, registry-mcp,
  ops-sdk, core, cli) that use Zod must declare it directly. Most already do.

### Security

- **`validateBaseUrl` no longer accepts attacker DNS that resembles private IPs.**
  Pre-fix, `host.startsWith('10.')` accepted `10.attacker.com` as a "private" host and allowed
  HTTP, enabling cleartext credential transmission. Now requires `net.isIP() === 4` plus a
  numeric octet match. `0.0.0.0` is also no longer treated as loopback (it is a bind address,
  not a destination).
- **`NetworkError` ctor and `createErrorFromStatus` now sanitize wrapped messages.**
  TypeError messages from `fetch()` may contain credentials embedded in failing URLs; server
  error responses may forward credentials. Both ingress points apply `sanitizeString` so direct
  `err.message` access by logging middleware does not exfiltrate. Hand-crafted SDK error
  messages are unchanged.
- **`loadStoredCredentials` treats malformed `expiresAt` as expired.** Previously
  `new Date('garbage') <= now` evaluated to false, accepting any non-date string as
  never-expires. Now logs a warning and returns null.
- **`HttpClient` constructor validates `defaultHeaders`** against RFC 7230 `tchar` (names)
  and rejects CR/LF/NUL in values. Closes header smuggling via consumer-supplied headers.

### Changed

- `prebuild` no longer uses inline `node -e` to emit `src/config/generated-version.ts`.
  Extracted to `scripts/generate-version.mjs` so the publish-time code path is review-gated.
- `prepublishOnly` now runs `lint && test && audit --omit=dev && build`. Production-dep
  vulnerabilities block publish. Combined with `publishConfig.provenance: true`, this
  pairs producer-side gates with consumer-verifiable Sigstore attestations.
- Lockfile regenerated to align with current package version (was lagging at 0.5.1).

### Supply chain

- Added `"provenance": true` to `publishConfig`. Every published tarball will carry a
  Sigstore attestation linking it to its source commit. Consumers SHOULD run
  `npm audit signatures` in CI to verify.
- `SCOPE.md` now documents the producer-side gates and consumer-side recommendations
  (pin with `--save-exact`, run `npm ci`, avoid `--ignore-scripts`). Five downstream
  packages currently float on `^0.10.2` — switching them to exact pins closes the
  caret-propagation path that synthesis flagged.

### Dev dependencies

- `vitest` ^3.0.4 → ^4.1.8 (closes GHSA-5xrq-8626-4rwp CVSS 9.8 and 5 chained high CVEs in the
  vite/rollup/flatted/minimatch/picomatch transitive tree). `npm audit` reports zero
  vulnerabilities.

## [0.10.2] — 2026-05-25

### Fixed
- **sanitizeForDisplay** now checks sensitive key before recursing into object values — previously `{ password: { hash: 'abc' } }` would recurse and expose contents instead of redacting
- **toJSON()** applies `sanitizeString` to error message field — closes the last unsanitized path in error serialization
- **validateBaseUrl** IPv6 loopback: `[::1]` is now correctly recognized (URL.hostname returns brackets)

### Added
- 19 security-focused tests: toJSON sanitization, validateBaseUrl (HTTPS enforcement, loopback/private ranges), 401 mutation guard
- `SCOPE.md` — package scope, security perimeter, non-goals, downstream SDK boundary
- `docs/adr-001-sanitization-architecture.md` — threat model for three-layer sanitization
- Design comments on CWE-316 JS runtime limitation, SSRF scope, REDACTED_DETAIL_KEYS rationale

## [0.10.1] — 2026-05-21

### Fixed
- Suppress dotenv v17 `Missing .env` tip noise in `loadEnvFiles`
- Surface API validation `errors` array in `SdkApiError.details`

## [0.10.0] — 2026-05-20

### Fixed
- Resolve 3 security findings from Socrates/Explorer composition analysis
- Modernize `REDACTED_DETAIL_KEYS` from frozen v0.1.0 MySQL-only list

## [0.9.0] — 2026-05-18

### Added
- `onRetry` callback: fires before each retry with attempt number, error, and backoff delay

## [0.8.0] — 2026-05-18

### Added
- `NetworkError.isRetryable()` returns `true` — network errors are transient by nature
- `onRateLimitApproaching` callback: fires when remaining/limit drops below threshold

## [0.7.0] — 2026-05-15

### Added
- Enriched `UnauthorizedError` when token refresh unavailable — includes CWE-316 context

## [0.6.0] — 2026-05-11

### Added
- `sanitizeString()` — string-level credential redaction for error messages and log output

## [0.5.8] — 2026-05-05

### Fixed
- Accept opaque (non-JWT) session tokens in `JwtSessionAuth`

## [0.5.7] — 2026-04-30

### Fixed
- Improved credential exhaustion diagnostics
- Document `requestRaw` / `requestBinary` resilience bypass

## [0.5.5] — 2026-04-28

### Fixed
- Sanitize credential file warning messages to prevent path/content leakage

## [0.5.4] — 2026-04-28

### Fixed
- Sync `SDK_CORE_VERSION` constant with package.json
- Restore private network HTTP exemption for VPC connectivity

## [0.5.3] — 2026-04-27

### Fixed
- Move credential clear to `finally` block in `JwtSessionAuth.login()`

## [0.4.0] — 2026-04-20

### Added
- HTTPS enforcement on `baseUrl` for non-loopback targets
- CWE-316: clear plaintext password from memory after login

### Fixed
- `handleFetchError` returns `NetworkError` instead of `UnauthorizedError` for `TypeError`

## [0.1.3] — 2026-03-28

### Changed
- Upgrade zod from v3 to v4

## [0.1.1] — 2026-03-15

### Added
- `getAuthBaseUrl()` getter on `HttpClient`
- `skipAuth` option for unauthenticated requests
- `retryMutations` on `post()` method signature

### Fixed
- Prevent `NotFoundError` from duplicating "not found" in message

## [0.1.0] — 2026-03-10

### Added
- Initial release — extracted shared infrastructure from `@uluops/ops-sdk` and `@uluops/registry-sdk`
- `HttpClient` with retry, backoff, rate limit tracking, and response envelope parsing
- `AuthStrategy` interface with `ApiKeyAuth` and `JwtSessionAuth` implementations
- `SdkApiError` hierarchy with typed errors for all HTTP status codes
- Configuration loaders for env vars, `.env` files, and `~/.uluops/credentials.json`
- `sanitizeForDisplay`, `sanitizeForLog` — object-level credential redaction
- Utility functions: `sleep`, `retry`, `isUuid`, `truncate`, `parseRateLimitHeaders`
