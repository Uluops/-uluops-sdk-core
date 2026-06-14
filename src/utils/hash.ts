/**
 * Shared content-addressing hash utilities for UluOps.
 *
 * This is the single canonical implementation used by both the registry API
 * (which computes and stores `hash` / `prompt_hash` at publish time) and
 * `@uluops/core` (which verifies caller-pinned hashes at resolve time).
 * Parity is by construction: both sides import from here.
 *
 * Two artifacts are hashed with two different rules and are NOT interchangeable:
 *  - YAML source   → `computeHash`        (normalized: parse + sort keys)
 *  - rendered prompt→ `computePromptHash`  (raw bytes, no normalization)
 *
 * The `yaml` dependency is pinned exact (2.9.0) to match the version that
 * produced the registry's currently-stored hashes — see the golden fixtures.
 */

import { createHash, timingSafeEqual } from 'crypto';
import yaml from 'yaml';

/**
 * Normalize YAML content for deterministic hashing.
 * Parses the YAML and re-stringifies with sorted map entries so identical
 * content produces the same hash regardless of key ordering.
 *
 * Falls back to raw content if parsing fails or produces a non-object result
 * (empty strings, plain scalars, multi-document streams that parse to a scalar).
 *
 * Internal: behavior is locked by the `computeHash` golden fixtures, not a
 * public API. Deliberately NOT exported from `utils/index.ts`.
 */
function normalizeForHash(content: string): string {
  try {
    const parsed: unknown = yaml.parse(content);
    // Only normalize structured YAML (objects/arrays); scalars/null/undefined fall through.
    if (parsed !== null && parsed !== undefined && typeof parsed === 'object') {
      return yaml.stringify(parsed, { sortMapEntries: true });
    }
    return content;
  } catch {
    return content;
  }
}

/**
 * Timing-safe comparison of two `sha256:`-prefixed hash strings.
 *
 * Returns `false` immediately on length mismatch — `timingSafeEqual` throws a
 * `RangeError` on unequal-length buffers, so a malformed caller-supplied pin
 * must yield a clean refusal, not a crash.
 */
function timingSafeHashEqual(computed: string, expected: string): boolean {
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Compute the SHA-256 content hash of YAML source.
 * YAML is normalized (sorted keys) before hashing so semantically identical
 * documents hash identically.
 *
 * @param content - YAML source string
 * @returns hash as `sha256:<hex>`
 */
export function computeHash(content: string): string {
  const normalized = normalizeForHash(content);
  const hash = createHash('sha256').update(normalized, 'utf8').digest('hex');
  return `sha256:${hash}`;
}

/**
 * Compute the SHA-256 hash of a rendered prompt (runtime markdown).
 * No normalization is applied — the rendered markdown is deterministic output
 * from the rendering pipeline and is hashed byte-for-byte.
 *
 * WARNING: do not use `computeHash` for prompt content — its YAML normalization
 * would corrupt the comparison.
 *
 * @param runtimeMd - rendered markdown prompt
 * @returns hash as `sha256:<hex>`
 */
export function computePromptHash(runtimeMd: string): string {
  const hash = createHash('sha256').update(runtimeMd, 'utf8').digest('hex');
  return `sha256:${hash}`;
}

/**
 * Verify YAML content against an expected `sha256:` hash.
 *
 * Timing-safe: the expected hash may arrive from an external source (CLI flag,
 * SDK caller) when used as a caller pin, so comparison avoids a timing oracle.
 * Returns `false` (never throws) on a malformed or wrong-length expected hash.
 *
 * @param content - YAML source to verify
 * @param expectedHash - expected hash (with `sha256:` prefix)
 */
export function verifyHash(content: string, expectedHash: string): boolean {
  return timingSafeHashEqual(computeHash(content), expectedHash);
}

/**
 * Verify rendered prompt content against an expected `sha256:` prompt hash.
 *
 * Timing-safe; returns `false` (never throws) on a malformed or wrong-length
 * expected hash.
 *
 * @param runtimeMd - rendered markdown to verify
 * @param expectedHash - expected hash (with `sha256:` prefix)
 */
export function verifyPromptHash(runtimeMd: string, expectedHash: string): boolean {
  return timingSafeHashEqual(computePromptHash(runtimeMd), expectedHash);
}
