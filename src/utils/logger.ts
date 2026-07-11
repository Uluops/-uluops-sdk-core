/**
 * Logger interface and utilities for UluOps SDKs
 */

export {
  stripControlChars,
  sanitizeString,
  sanitizeForLog,
  sanitizeForDisplay,
  redactSensitive,
} from './sanitize.js';
import { sanitizeForLog } from './sanitize.js';

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
