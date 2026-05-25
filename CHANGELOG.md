# Changelog

All notable changes to `@uluops/sdk-core` will be documented in this file.

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
