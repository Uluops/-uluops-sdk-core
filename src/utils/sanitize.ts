/**
 * String and object sanitization utilities for safe logging and display.
 *
 * Five public functions covering the three sanitization concerns:
 *   - Object-level redaction by key name: sanitizeForLog, sanitizeForDisplay
 *   - String-level credential scrubbing: sanitizeString
 *   - Control-character neutralization: stripControlChars
 *   - Value-level masking: redactSensitive
 *
 * This module is intentionally separate from logger.ts so that the error
 * hierarchy (errors/errors.ts) and other non-logging consumers can import
 * sanitization without pulling in the Logger interface or createLogger.
 * logger.ts re-exports all five names for backward compatibility.
 */

/**
 * Regex pattern for keys that should be redacted from logs
 */
const SENSITIVE_KEYS = /^(api[_-]?key|x-api-key|token|bearer[_-]?token|session[_-]?token|secret|api[_-]?secret|password|passwd|authorization|proxy[_-]?authorization|credentials|cookie|set[_-]?cookie|access[_-]?token|refresh[_-]?token|jwt|auth[_-]?key|x-auth-token)$/i;

/**
 * Patterns that match credential values embedded in free-form strings.
 *
 * Complements SENSITIVE_KEYS (which redacts by object key name) —
 * this catches credentials in error messages, URLs, and log output
 * where the value appears inline rather than in a structured field.
 */
const CREDENTIAL_VALUE_PATTERNS: RegExp[] = [
  // API key/token assignments: apiKey=xxx, api_key: xxx
  /(?:api[_-]?key|apiKey)\s*[:=]\s*\S+/gi,
  // Bearer tokens in auth headers
  /bearer\s+[a-zA-Z0-9_\-.]+/gi,
  // Authorization header values (Basic xxx, Bearer xxx, etc.)
  /authorization:\s*\S+(?:\s+\S+)?/gi,
  // UluOps API keys (ulr_ prefix with 20+ chars)
  /ulr_[a-zA-Z0-9]{20,}/g,
  // Token/secret/password assignments with values
  /(?:token|secret|password|passwd)\s*[:=]\s*\S+/gi,
  // Stack traces (internal implementation details)
  /at\s+\S+\s+\(\S+:\d+:\d+\)/g,
  // Bare JWTs (header.payload.signature with eyJ-prefixed base64url parts)
  /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];

// URL userinfo (https://user:pass@host) — preserves scheme, replaces credentials.
const URL_USERINFO_PATTERN = /\b(https?|wss?|ftp):\/\/[^\s/@]+:[^\s/@]+@/gi;

// C0 control chars + DEL (excluding space at 0x20). Neutralizes log-spoofing
// via CR/LF/tab injection in caller-supplied error message fragments. The
// control-char literals are intentional — that's what this regex matches.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_PATTERN = /[\x00-\x1F\x7F]/g;

/**
 * Strip control characters (C0 + DEL) by replacing them with spaces.
 *
 * Defends against CRLF injection / log spoofing in error message fragments
 * that include caller-supplied identifiers (resource names, IDs, etc.).
 * Single-purpose: does NOT redact credentials — use sanitizeString for that.
 */
export function stripControlChars(message: string): string {
  return message.replace(CONTROL_CHARS_PATTERN, ' ');
}

/**
 * Sanitize a string by redacting credential values and truncating.
 *
 * String-level complement to `sanitizeForLog` (object-level) and
 * `sanitizeForDisplay` (object-level). Use this for error messages,
 * log output, and any free-form text that may contain embedded
 * credentials before exposing to external consumers.
 *
 * @param message - The string to sanitize
 * @param maxLength - Maximum output length (default: 1000). 0 = no limit.
 * @returns The sanitized string with credential values replaced by [REDACTED]
 *
 * @example
 * ```typescript
 * import { sanitizeString } from '@uluops/sdk-core';
 *
 * const safe = sanitizeString('Login failed with apiKey=ulr_abc123def456');
 * // => 'Login failed with [REDACTED]'
 * ```
 */
export function sanitizeString(message: string, maxLength = 1000): string {
  let safe = stripControlChars(message);
  URL_USERINFO_PATTERN.lastIndex = 0;
  safe = safe.replace(URL_USERINFO_PATTERN, (_match, scheme: string) => `${scheme}://[REDACTED]@`);
  for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
    // Reset lastIndex for global regexes (stateful across calls)
    pattern.lastIndex = 0;
    safe = safe.replace(pattern, '[REDACTED]');
  }
  if (maxLength > 0 && safe.length > maxLength) {
    safe = safe.slice(0, maxLength) + '... (truncated)';
  }
  return safe;
}

/**
 * Sanitize a single value for safe logging by redacting sensitive fields in objects
 */
export function sanitizeForLog(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(item => sanitizeForLog(item, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.test(key)) {
      result[key] = '[REDACTED]';
    } else if (typeof val === 'object' && val !== null) {
      result[key] = sanitizeForLog(val, seen);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Sanitize an object by redacting sensitive keys.
 * Returns a new object with sensitive string values replaced.
 * Used by error toJSON() for safe serialization.
 */
export function sanitizeForDisplay(obj: Record<string, unknown>, seen = new WeakSet<object>()): Record<string, unknown> {
  if (seen.has(obj)) {
    return { '[Circular]': true };
  }
  seen.add(obj);

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.test(key)) {
      result[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = sanitizeForDisplay(value as Record<string, unknown>, seen);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        item && typeof item === 'object'
          ? sanitizeForDisplay(item as Record<string, unknown>, seen)
          : item
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Redact sensitive values for safe logging.
 * Shows only the last N characters.
 */
export function redactSensitive(value: string, showLast = 4): string {
  if (value.length <= showLast) {
    return '[REDACTED]';
  }
  return `${'*'.repeat(Math.min(value.length - showLast, 20))}${value.slice(-showLast)}`;
}
