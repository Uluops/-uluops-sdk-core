/**
 * Shared utility functions for UluOps SDKs
 */

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff.
 *
 * @typeParam T - The return type of the function being retried.
 *   Must be inferrable from `fn` — callers should not need to specify it explicitly.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    shouldRetry = () => true,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Check if a value is a plain object (not an array, Date, etc.)
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}

/**
 * Check if a string is a valid UUID (v1-v5)
 */
export function isUuid(value: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}

/**
 * Truncate a string to a maximum length, appending `...` if trimmed
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Rate limit information from response headers
 */
export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: Date;
  retryAfter?: number;
}

/**
 * Parse rate limit headers from a fetch Response
 */
export function parseRateLimitHeaders(headers: Headers): RateLimitInfo | null {
  const limit = headers.get('x-ratelimit-limit');
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  const retryAfter = headers.get('retry-after');

  if (!limit || !remaining || !reset) {
    return null;
  }

  const parsedLimit = parseInt(limit, 10);
  const parsedRemaining = parseInt(remaining, 10);
  const parsedReset = parseInt(reset, 10);

  if (isNaN(parsedLimit) || isNaN(parsedRemaining) || isNaN(parsedReset)) {
    return null;
  }

  const parsedRetryAfter = retryAfter ? parseInt(retryAfter, 10) : undefined;

  return {
    limit: parsedLimit,
    remaining: parsedRemaining,
    reset: new Date(parsedReset * 1000),
    retryAfter: parsedRetryAfter !== undefined && isNaN(parsedRetryAfter) ? undefined : parsedRetryAfter,
  };
}

/**
 * Allowed types for query parameter values
 */
export type QueryParamValue = string | number | boolean | undefined | null;

/**
 * Query parameters for HTTP requests
 */
export type QueryParams = Record<string, QueryParamValue>;

/**
 * Convert a typed query object to QueryParams.
 * Filters out undefined values.
 */
export function toQuery(query: object | undefined): QueryParams | undefined {
  if (!query) return undefined;
  const params: QueryParams = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      params[key] = value;
    }
  }
  return params;
}
