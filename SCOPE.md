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
5. **Local credential storage trust model**: `~/.uluops/credentials.json` is read with a `statSync` → `readFileSync` pattern that does not defend against local-filesystem TOCTOU swaps or symlink redirection. This is intentional. sdk-core treats `$HOME` as a single-user trust boundary: an attacker with write access to `~/.uluops/` can replace credentials directly, so race-window and symlink hardening would defend against a threat that already has the credential. Shared-host and multi-tenant deployments (CI runners, build agents, jump hosts) MUST source credentials from environment variables instead — the filesystem path is for developer laptops.
6. **Redirect rejection**: all `fetch()` calls set `redirect: 'error'`. `validateBaseUrl` enforces transport rules at the configured origin but cannot follow redirect chains. The SDK only talks to the configured baseUrl/authBaseUrl — a malicious or compromised upstream issuing a 3xx redirect to another host is rejected before the request body (which can carry credentials on login) is replayed.
7. **Redaction is ASCII-canonical and external-exposure-scoped**: SENSITIVE_KEYS, REDACTED_DETAIL_KEYS, and CREDENTIAL_VALUE_PATTERNS operate on ASCII key names and free-text strings as authored by the upstream API. Response key authoring is trusted to the API; the SDK does not attempt Unicode-confusable normalization of arbitrary key names. Internal debug paths (`sanitizeForLog`) preserve structure for developers; external-exposure paths (`sanitizeString`, `sanitizeForDisplay`) strip credentials and control characters.

The SDK does **not** perform runtime security telemetry, request signing, destination-level SSRF validation, or local-filesystem TOCTOU defense on credential reads (see [ADR-001](docs/adr-001-sanitization-architecture.md) for sanitization rationale; perimeter bullet 5 for the storage trust model).

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

## Supply Chain Posture

sdk-core sits upstream of five consumer packages via npm caret ranges, so a poisoned publish auto-propagates on next `npm install`. The posture below is the minimum baseline; full CI-only publishing is deferred until a break-glass design exists (see security audit run #16).

### Producer-side (this package)

- **Provenance is enabled** in `publishConfig` (`"provenance": true`). Every published tarball carries a Sigstore attestation linking it to the source commit and build environment.
- **`prepublishOnly` gates publish on `lint && test && audit --omit=dev && build`.** Production-dep vulnerabilities block publish; devDep vulnerabilities surface separately via `npm audit`.
- **Publish requires npm 2FA on auth-and-writes.** Set on the npm account, not in this repo. Maintainers MUST NOT use account tokens that bypass 2FA for publish.
- **`prebuild` is a checked-in script**, not an inline `node -e`. Any change to `scripts/generate-version.mjs` is review-gated like any other source.
- **No postinstall, preinstall, or install lifecycle scripts** ship with the package. Consumers run zero arbitrary code from sdk-core at install time.

### Consumer-side (downstream packages)

Consumers — including the five UluOps SDKs that depend on sdk-core — SHOULD:

- **Pin sdk-core with `--save-exact`** (e.g., `"@uluops/sdk-core": "0.11.0"`, not `"^0.11.0"`). A poisoned 0.11.1 cannot auto-propagate to a consumer that pins exact.
- **Run `npm audit signatures`** in CI on install to verify the provenance attestation.
- **Use `npm ci` rather than `npm install`** in CI to enforce the lockfile.
- **Avoid `--ignore-scripts` defeats** of their own `prepublishOnly` gates.

### What this posture does NOT defend against

- A compromised maintainer machine running `npm publish` with valid credentials. Provenance attests origin but cannot verify intent.
- A `--ignore-scripts` bypass at the producer side. The gate is advisory, not enforced by npm.
- A successful workflow-edit attack if CI-only publish is later adopted without action SHA-pinning and branch protection on `.github/workflows/`.

These residual risks are accepted for now and tracked in `sdk-core` security-audit findings.
