/**
 * Logger interface and utilities for UluOps SDKs
 */

/**
 * Simple debug logger interface.
 *
 * All methods accept a message string and optional extra arguments.
 * When debug mode is disabled, all methods are no-ops.
 */
export interface Logger {
  /** Log a debug-level message (visible only in debug mode) */
  debug(message: string, ...args: unknown[]): void;
  /** Log an informational message */
  info(message: string, ...args: unknown[]): void;
  /** Log a warning */
  warn(message: string, ...args: unknown[]): void;
  /** Log an error */
  error(message: string, ...args: unknown[]): void;
}

/**
 * Regex pattern for keys that should be redacted from logs
 */
const SENSITIVE_KEYS = /^(api[_-]?key|token|bearer[_-]?token|session[_-]?token|secret|api[_-]?secret|password|passwd|authorization|credentials|cookie|access[_-]?token|refresh[_-]?token|jwt|auth[_-]?key)$/i;

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
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = sanitizeForDisplay(value as Record<string, unknown>, seen);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        item && typeof item === 'object'
          ? sanitizeForDisplay(item as Record<string, unknown>, seen)
          : item
      );
    } else if (SENSITIVE_KEYS.test(key) && typeof value === 'string') {
      result[key] = '[REDACTED]';
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Create a logger instance
 * @param prefix - Prefix for log messages (e.g., '[ops-sdk:http]')
 * @param enabled - Whether logging is enabled
 */
export function createLogger(prefix: string, enabled: boolean): Logger {
  const noop = () => {};

  if (!enabled) {
    // Even when debug logging is disabled, error and warn should still
    // emit — these represent real problems that callers need to see.
    const timestamp = () => new Date().toISOString();
    const sanitizeArgs = (args: unknown[]): unknown[] => args.map(a => sanitizeForLog(a));
    return {
      debug: noop,
      info: noop,
      warn(message: string, ...args: unknown[]): void {
        console.warn(`${timestamp()} ${prefix} WARN:`, message, ...sanitizeArgs(args));
      },
      error(message: string, ...args: unknown[]): void {
        console.error(`${timestamp()} ${prefix} ERROR:`, message, ...sanitizeArgs(args));
      },
    };
  }

  const timestamp = () => new Date().toISOString();
  const sanitizeArgs = (args: unknown[]): unknown[] => args.map(a => sanitizeForLog(a));

  return {
    debug(message: string, ...args: unknown[]): void {
      console.debug(`${timestamp()} ${prefix} DEBUG:`, message, ...sanitizeArgs(args));
    },
    info(message: string, ...args: unknown[]): void {
      console.info(`${timestamp()} ${prefix} INFO:`, message, ...sanitizeArgs(args));
    },
    warn(message: string, ...args: unknown[]): void {
      console.warn(`${timestamp()} ${prefix} WARN:`, message, ...sanitizeArgs(args));
    },
    error(message: string, ...args: unknown[]): void {
      console.error(`${timestamp()} ${prefix} ERROR:`, message, ...sanitizeArgs(args));
    },
  };
}

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
];

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
  let safe = message;
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
 * Redact sensitive values for safe logging.
 * Shows only the last N characters.
 */
export function redactSensitive(value: string, showLast = 4): string {
  if (value.length <= showLast) {
    return '[REDACTED]';
  }
  return `${'*'.repeat(Math.min(value.length - showLast, 20))}${value.slice(-showLast)}`;
}
