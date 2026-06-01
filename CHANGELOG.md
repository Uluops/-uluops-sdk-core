# Changelog

All notable changes to `@uluops/sdk-core` will be documented in this file.

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
