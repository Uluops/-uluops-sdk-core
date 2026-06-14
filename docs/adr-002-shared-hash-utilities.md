# ADR-002: Shared Content-Addressing Hash Utilities

**Status:** Accepted
**Date:** 2026-06-14
**Context:** Registry integrity-verification (Phase 1/2), `registry-integrity-verification-spec-v0.2.1`

## Decision

The canonical content-addressing hash implementation lives in `@uluops/sdk-core`
(`src/utils/hash.ts`, exported from `utils/index.ts` and the package root). Both
the registry API (which computes and stores `hash` / `prompt_hash` at publish
time) and `@uluops/core` (which verifies caller-pinned hashes at resolve time)
import it, so the two sides hash **identically by construction**.

Four functions are exported; the `normalizeForHash` helper is deliberately not:

| Function | Target | Rule |
|----------|--------|------|
| `computeHash(yaml)` | YAML source | `sha256` over normalized YAML (`yaml.parse` → `yaml.stringify({ sortMapEntries: true })`), raw-bytes fallback for non-object/unparseable input |
| `computePromptHash(runtimeMd)` | Rendered prompt | `sha256` over the raw markdown bytes — **no** normalization |
| `verifyHash` / `verifyPromptHash` | — | Timing-safe comparison; **return `false` (never throw) on a malformed/wrong-length expected hash** |

`yaml` is pinned **exact `2.9.0`** — the version that produced the registry's
currently-stored hashes.

## Context

`@uluops/core` documented "SHA-256 hash verification on registry-resolved
definitions" but never performed it. Adding the real guarantee (caller-pinned
verification, fail-closed) requires that core compute a hash byte-identical to
the one the registry stored. Before this ADR there were **two** independent
implementations: the canonical one in `uluops-registry-api/src/utils/hash.ts`
and a raw `crypto.createHash` call in core's `resolveLocal`. Two implementations
cannot be relied on to agree, and content-addressing is worthless if the two
sides disagree on a single byte.

## Rationale

### Why sdk-core hosts it

sdk-core is the shared infrastructure both `@uluops/registry-sdk`/registry-api
and `@uluops/core` already depend on. Placing the util here makes parity a
compile-time property (one implementation, imported everywhere) rather than a
convention that drifts. registry-api's `src/utils/hash.ts` becomes a thin
re-export, preserving its import path and five internal importers.

### Why two different hashing rules

YAML source and rendered prompt are different artifacts with different identity
semantics:

- **YAML** is authored; semantically identical documents may differ in key order
  or formatting. Normalizing (parse + sorted re-stringify) makes the hash a
  function of *meaning*, not *byte layout*. The raw-bytes fallback handles
  scalars/empty/unparseable content that has no object form to normalize.
- **Rendered prompt** (`runtime_md`) is deterministic machine output frozen at
  publish/retranslate time. It is hashed raw because the executed bytes *are* the
  artifact — any transformation would hash something other than what runs.

Using `computeHash` on a prompt (or `computePromptHash` on YAML) is a category
error and produces a different, wrong value; the names and docs make this
explicit.

### Why `yaml` is pinned exact (and why 2.9.0)

The stored hash is only reproducible if normalization is byte-stable, and
`yaml.stringify` output can change across `yaml` minor versions. `2.9.0` is the
version registry-api had installed when it produced the current stored hashes;
core's own `yaml@2.8.3` (used only for *parsing*) is irrelevant because all
*hashing* flows through sdk-core's pinned copy. Golden-fixture tests built from
real published definitions (an agent with prompt hash, a workflow) reproduce the
registry's stored hashes byte-for-byte and fail loudly if a future `yaml` bump
changes normalization.

### Why verification is timing-safe and never throws

The expected hash can arrive from an untrusted external channel (a CLI `--hash`
flag, an SDK caller's pin). `crypto.timingSafeEqual` throws `RangeError` on
unequal-length buffers, so a length check precedes it: a malformed or
wrong-length pin yields a clean `false` (refusal), not a crash. This makes the
functions safe to call directly on caller input. (The previous registry-api
`verifyHash` used `===`; the shared version is timing-safe with identical boolean
semantics, so existing callers and tests are unaffected.)

### Why `normalizeForHash` is not exported

It is an implementation detail of `computeHash`. Its behavior is locked by the
`computeHash` golden fixtures rather than a public contract, leaving us free to
change *how* normalization is implemented as long as the output is stable.

## Migration note: the legacy raw-hash population

Adopting normalized hashing surfaced a pre-existing inconsistency in the
registry. Definitions created **2026-02-11 → 02-28** had stored a **raw**
`sha256(yaml)`; everything from **03-02** onward stores the normalized
`computeHash(yaml)` (a normalization-scheme change introduced ~2026-03-01, clean
temporal split, no overlap). 133 of 1441 `definitions` (and 133 of 1407
`definition_versions`) were raw-era. Caller-pinned verification normalizes, so it
would have failed closed against every raw-era definition.

This was resolved with a one-time canonicalization
(`uluops-registry-api/scripts/backfill-normalize-hashes.ts`) that rewrites
raw → normalized in both tables (idempotent, transactional, refuses any row that
is neither raw nor normalized), gated by `scripts/verify-hash-parity.ts`
(exhaustive GREEN on dev, then dev→prod DB load). Current publish code already
normalizes, so this is a closed historical artifact, not an active source.

## Consequences

- One implementation to maintain; parity between registry and core is structural,
  not aspirational.
- The `yaml` version is now a load-bearing, reviewed decision — a bump is a
  deliberate change guarded by golden fixtures, and (if normalization changes)
  would require a re-hash/migration like the one above.
- Consumers must choose the correct function per artifact type; misuse is silent
  (a valid-looking but wrong hash), mitigated by naming and documentation.
- Verification accepts arbitrary caller input safely (no throw on malformed
  pins), which the integrity feature in core relies on for fail-closed behavior.
