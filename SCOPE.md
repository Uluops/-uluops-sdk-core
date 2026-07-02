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
6. **Redirect rejection**: all `fetch()` calls set `redirect: 'manual'`. A 3xx from the configured origin is returned by fetch as an `opaqueredirect` (never followed); the SDK detects it deterministically (`response.type === 'opaqueredirect'`, with a 3xx status-range fallback for non-conforming HTTP stacks) and throws a dedicated, **non-retryable** `RedirectError` — replacing the pre-0.14.0 behavior where undici's redirect `TypeError` was laundered into a retryable `NetworkError`. `validateBaseUrl` enforces transport rules at the configured origin but cannot follow redirect chains. The SDK only talks to the configured baseUrl/authBaseUrl — a malicious or compromised upstream issuing a 3xx redirect to another host is rejected before the request body (which can carry credentials on login) is replayed. Detection changed from an undici-internal error-string match to a `response.type` check (deterministic, stack-independent).
7. **Redaction is ASCII-canonical and external-exposure-scoped**: SENSITIVE_KEYS, REDACTED_DETAIL_KEYS, and CREDENTIAL_VALUE_PATTERNS operate on ASCII key names and free-text strings as authored by the upstream API. Response key authoring is trusted to the API; the SDK does not attempt Unicode-confusable normalization of arbitrary key names. Internal debug paths (`sanitizeForLog`) preserve structure for developers; external-exposure paths (`sanitizeString`, `sanitizeForDisplay`) strip credentials and control characters.
8. **Structured security-event channel** (`onSecurityEvent`, added 0.14.0): the SDK observes security-relevant events — a rejected credential (`auth_failure`), a blocked redirect (`redirect_rejected`), a failed token refresh (`token_refresh_failed`), and a live credential swap (`auth_strategy_replaced`) — and delivers them as a single, structured, discriminated-union channel to the embedding application. This is a **reporting** surface, not an enforcement one: the SDK sets no policy and takes no action; the embedder routes events to its own telemetry sink and decides what constitutes an incident. Events are best-effort and fire-and-forget; a throwing handler is caught and logged, never propagated into request flow. Every event field is credential-safe by construction. This does not make the SDK a telemetry system — it makes the events it already sees routable instead of buried in free-text logs.
9. **Credential replacement is a trusted-caller capability**: `setAuthStrategy` (used by the login flow to swap in a session token) performs no authorization check — any code holding the client reference can replace the credential the client exercises. This is by design: the SDK's trust boundary is the process, and a caller already holding the client reference is inside it. Because the swap changes which credential every subsequent request carries, it emits an `auth_strategy_replaced` event (perimeter bullet 8) so embedders can observe and correlate credential changes; the SDK does not gate the operation itself.

The SDK does **not** enforce security policy, act on security events, sign requests, validate destinations for SSRF, or defend credential reads against local-filesystem TOCTOU (see [ADR-001](docs/adr-001-sanitization-architecture.md) for sanitization rationale; perimeter bullet 5 for the storage trust model; bullet 8 for the reporting-only nature of the event channel). Runtime auth failures — including a substituted-but-invalid credential — surface via `auth_failure`; a substituted-but-valid credential is, by definition, indistinguishable from legitimate use at the client and is the server's authorization concern, not the SDK's.

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

- **Provenance is _configured_ but not yet _active_.** `publishConfig.provenance` is `true`, which is the setting a Sigstore attestation requires — but provenance can only be *generated* from a supported CI runner with OIDC (e.g. GitHub Actions), and this package currently has **no CI workflow**: publishes are run locally from a maintainer machine, where npm produces no attestation (a local `npm publish` effectively resolves `--provenance=false`). So published tarballs do **not** currently carry an attestation despite the flag. The flag is retained as the pre-wired target state; making provenance real is gated on standing up an OIDC publish workflow, which is the same "CI-only publishing" effort deferred above (security audit run #16). **Do not read `provenance: true` as "attestations exist."** (Reconciled 2026-07-02, attack-path-audit run #19 finding `af25ed88`; the earlier "every published tarball carries a Sigstore attestation" claim was aspirational and is corrected here.)
- **Built output (`dist/`) is not version-controlled.** `dist/` is `.gitignore`d and built locally at publish time (`prepublishOnly` runs `build`), so the published artifact is not reproducible from a git tag alone and is not diffable in review. This is a consequence of local (non-CI) publishing; it is closed by the same OIDC-CI effort that activates provenance, or independently by committing build output. Tracked, not yet resolved (finding `aa945dd5`).
- **All `dependencies` and `devDependencies` are pinned to exact versions** (no caret, no tilde). Adopted 2026-06-01 in response to the RedHat-class supply-chain attack pattern. A poisoned upstream release cannot auto-propagate to sdk-core on `npm install` — every dependency upgrade is an explicit reviewable commit. Lockfile alone is insufficient because `npm install` re-resolves carets against the registry; pinning at the manifest level closes the gap.
- **`prepublishOnly` gates publish on `lint && test && audit --omit=dev && build`.** Production-dep vulnerabilities block publish. Note the exposure this leaves open (finding `8050bf35`): `--omit=dev` exempts exactly the `devDependencies` (typescript, the compiler toolchain) that *produce* the shipped `dist/`, so a compromised build dependency could poison the published output without the audit gate firing. This is accepted rather than closed by dropping `--omit=dev`: auditing the full dev tree would block publish on any transitive devDep CVE (mostly test-only, non-shipping) and train maintainers to `--force` past the gate. The build-integrity risk is instead addressed by exact-pinning every devDep (above) — a poisoned build dep cannot auto-propagate — and would be further closed by CI-built, provenance-attested `dist/`. devDep vulnerabilities are surfaced (non-gating) via a plain `npm audit`.
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
