# @uluops/sdk-core — Scope

## What This Package Is

Shared infrastructure for UluOps SDKs. Every UluOps SDK (`@uluops/ops-sdk`, `@uluops/registry-sdk`) extends this core rather than implementing HTTP, auth, errors, and configuration independently.

### Responsibilities

- **HTTP client** (`HttpClient`): fetch-based request execution with retry, backoff, rate limit tracking, and response envelope parsing. SDKs subclass this with their own baseUrl and defaults.
- **Authentication** (`AuthStrategy`): API key and JWT session strategies. Handles credential validation, token refresh with deduplication, and CWE-316 credential clearing.
- **Error hierarchy** (`SdkApiError` and subclasses): typed errors for every HTTP status code the APIs return. Includes retryability classification, sanitized serialization, and type guards.
- **Configuration** (`loadCredentials`, `loadConfig`): environment variable loading, `.env` file discovery, and `~/.uluops/credentials.json` storage.
- **Sanitization** (`sanitizeForDisplay`, `sanitizeForLog`, `sanitizeString`): three-layer redaction covering structured objects, log arguments, and free-form strings.
- **Utilities**: sleep, retry, UUID validation, rate limit header parsing, query parameter conversion.

### Security Perimeter

The SDK operates as a **client library** — it sends authenticated requests to UluOps APIs. Its security scope is:

1. **Credential protection**: never leak API keys, tokens, or passwords through error serialization, logging, or stack traces.
2. **Transport security**: enforce HTTPS for non-loopback targets. HTTP is allowed only for localhost, 127.0.0.1, [::1], and RFC 1918 private ranges.
3. **Error sanitization**: strip server internals (stack traces, SQL, system paths) from error details before exposing to consumers.
4. **Retry safety**: only retry idempotent operations (GET) by default. Mutations require explicit opt-in via `retryMutations`.

The SDK does **not** perform runtime security telemetry, request signing, or destination-level SSRF validation (see [ADR-001](docs/adr-001-sanitization-architecture.md) for rationale).

## What This Package Is Not

- **Not an API client.** It provides no domain-specific methods (create project, query issues, publish definition). Those belong in `@uluops/ops-sdk` and `@uluops/registry-sdk`.
- **Not a platform service.** It has no server component, no database, no background jobs. Security telemetry, rate limiting enforcement, and audit logging belong server-side.
- **Not a standalone product.** End users install an SDK, not sdk-core directly. The public API surface is designed for SDK authors, not application developers.

## Explicit Non-Goals

- IPv6 unique-local (`fc00::/7`) and link-local (`fe80::/10`) allowlisting. Rejecting these is the safer default; no UluOps deployment uses IPv6 private addressing.
- Pattern-matching heuristics for `REDACTED_DETAIL_KEYS`. A static allowlist with periodic review is preferred over regex that risks false positives on legitimate detail fields.
- Unified sanitization function. The three layers (`sanitizeForDisplay`, `sanitizeForLog`, `sanitizeString`) serve distinct purposes at distinct call sites — collapsing them would either weaken the highest-stakes path or over-sanitize benign data.
- Runtime memory clearing of credentials. JavaScript provides no `memset` equivalent; setting to empty string is the best available userland mitigation.

## Boundary with Downstream SDKs

sdk-core exports everything downstream SDKs need to build their API surface:

```
sdk-core provides          │  downstream SDKs provide
───────────────────────────┼──────────────────────────────
HttpClient (base class)    │  domain-specific subclass
AuthStrategy               │  constructor that selects strategy
SdkApiError hierarchy      │  re-exported with SDK-specific alias
loadCredentials/loadConfig │  SDK-specific env var names
sanitize* functions        │  (used internally, not re-exported)
```

Downstream SDKs should never duplicate core infrastructure. If a pattern is needed by more than one SDK, it belongs here.
