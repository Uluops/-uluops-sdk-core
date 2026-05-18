# Changelog

All notable changes to `@uluops/sdk-core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.3] - 2026-05-18

### Fixed
- `JwtSessionAuth.login()` now clears plaintext password in `finally` block — previously only cleared after successful login, leaving credentials in memory if the login request threw (CWE-316)

## [0.5.2] - 2026-05-18

### Fixed
- `handleFetchError` no longer misclassifies `TypeError` (DNS failure, ECONNREFUSED) as `UnauthorizedError` when no auth strategy is configured. Now returns `NetworkError` with an appended credential hint for the common misconfiguration case. Consumers can catch via `isNetworkError()` regardless of auth state.

## [0.1.0] - 2026-02-06

Initial release. Extracts ~1,500 lines of shared infrastructure from `@uluops/ops-sdk` and `@uluops/registry-sdk` into a single reusable package.

### Added

- **HttpClient** — Native `fetch`-based client with config object pattern
  - Automatic retry with exponential backoff and jitter (GET by default, opt-in for mutations)
  - `{ data: T }` envelope parsing with opt-in Zod schema validation
  - Rate limit header parsing (`x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`)
  - Configurable timeout via `AbortController`
  - `requestRaw()` for non-envelope responses, `requestBinary()` for binary data
  - Separate `authBaseUrl` support for delegated auth endpoints
- **Authentication strategies**
  - `ApiKeyAuth` with strict format validation (`ulr_` prefix, min length, character set)
  - `JwtSessionAuth` with login, token refresh, expiration tracking, and session clearing
  - `createAuthStrategy()` factory with priority chain: apiKey > sessionToken > email/password
  - Automatic token refresh on 401 with concurrent deduplication
- **Error hierarchy** — `SdkApiError` base class with 10 HTTP status-mapped subclasses
  - `ValidationError` (400), `UnauthorizedError` (401), `ForbiddenError` (403), `NotFoundError` (404), `ConflictError` (409), `PayloadTooLargeError` (413), `UnprocessableError` (422), `RateLimitError` (429), `ServiceUnavailableError` (503)
  - `NetworkError` and `TimeoutError` for connectivity issues
  - `createErrorFromStatus()` factory and type guard functions (`isSdkApiError`, `isNotFoundError`, etc.)
  - Safe JSON serialization with server-internal key redaction
- **Configuration loaders** — Credential chain with four sources
  - Explicit constructor arguments (highest priority)
  - Environment variables via SDK-specific `EnvVarConfig`
  - Local `.env` file via `dotenv`
  - Global `~/.uluops/credentials.json` (lowest priority)
  - `validateCredentials()` and `isApiKey()` validation helpers
- **Utilities**
  - `createLogger()` with debug/warn/error levels and sensitive data redaction
  - `sleep()`, `retry()` with exponential backoff, `truncate()`, `isPlainObject()`, `isUuid()`
  - `parseRateLimitHeaders()` and `toQuery()` helpers
  - `redactSensitive()`, `sanitizeForLog()`, `sanitizeForDisplay()` for safe logging
- **Package exports** — Subpath exports for `@uluops/sdk-core/http`, `/errors`, `/config`, `/utils`
- **Documentation** — README with API reference, extension guide, and code examples
- **Test suite** — 268 tests covering all modules

### Fixed

- Error helper URLs now point to correct repository path (`uluops/uluops/tree/main/packages/sdk-core`)
- README `resetAt` references corrected to `reset` matching the `RateLimitInfo` interface
- README `requestBinary` example corrected to show required `method` parameter and `.data` return property
- Unawaited `login().then()` in auth expiration test converted to proper `async/await`

[0.1.0]: https://github.com/uluops/uluops/commits/main/packages/sdk-core
