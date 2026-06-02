/**
 * Error hierarchy for UluOps SDKs
 *
 * Base class is SdkApiError. Each SDK re-exports with an alias:
 *   ops-sdk:      SdkApiError as OpsApiError
 *   registry-sdk: SdkApiError as RegistryApiError
 */

import { HTTP_STATUS, ERROR_CODES } from '../config/constants.js';
import { sanitizeForDisplay, sanitizeString, stripControlChars } from '../utils/logger.js';

/**
 * Base API error class for all UluOps SDK errors
 */
export class SdkApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string = ERROR_CODES.UNKNOWN,
    public readonly details?: Record<string, unknown>,
    public readonly requestId?: string
  ) {
    super(stripControlChars(message));
    this.name = 'SdkApiError';
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Check if this error is retryable (transient server errors)
   */
  isRetryable(): boolean {
    return (
      this.statusCode === HTTP_STATUS.BAD_GATEWAY ||
      this.statusCode === HTTP_STATUS.SERVICE_UNAVAILABLE ||
      this.statusCode === HTTP_STATUS.GATEWAY_TIMEOUT ||
      this.statusCode === HTTP_STATUS.TOO_MANY_REQUESTS
    );
  }

  /**
   * Convert to JSON for logging/serialization (sensitive values redacted)
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: sanitizeString(this.message, 0),
      statusCode: this.statusCode,
      code: this.code,
      details: this.details ? sanitizeForDisplay(this.details) : undefined,
      requestId: this.requestId,
    };
  }
}

/**
 * 400 Bad Request - Validation errors
 */
export class ValidationError extends SdkApiError {
  constructor(message: string, details?: Record<string, unknown>, requestId?: string) {
    super(HTTP_STATUS.BAD_REQUEST, message, ERROR_CODES.VALIDATION_ERROR, details, requestId);
    this.name = 'ValidationError';
  }
}

/**
 * 401 Unauthorized - Authentication required
 */
export class UnauthorizedError extends SdkApiError {
  constructor(message = 'Authentication required', requestId?: string) {
    super(HTTP_STATUS.UNAUTHORIZED, message, ERROR_CODES.UNAUTHORIZED, undefined, requestId);
    this.name = 'UnauthorizedError';
  }
}

/**
 * 403 Forbidden - Access denied
 */
export class ForbiddenError extends SdkApiError {
  constructor(message = 'Access denied', requestId?: string) {
    super(HTTP_STATUS.FORBIDDEN, message, ERROR_CODES.FORBIDDEN, undefined, requestId);
    this.name = 'ForbiddenError';
  }
}

/**
 * 404 Not Found - Resource not found
 */
export class NotFoundError extends SdkApiError {
  constructor(resource: string, identifier?: string, requestId?: string) {
    // If resource already contains "not found" (e.g., from API response), use it as-is
    const message = resource.toLowerCase().includes('not found')
      ? resource
      : identifier
        ? `${resource} '${identifier}' not found`
        : `${resource} not found`;
    super(
      HTTP_STATUS.NOT_FOUND,
      message,
      ERROR_CODES.NOT_FOUND,
      identifier ? { resource, identifier } : { resource },
      requestId
    );
    this.name = 'NotFoundError';
  }
}

/**
 * 409 Conflict - Resource already exists or state conflict
 */
export class ConflictError extends SdkApiError {
  constructor(message: string, details?: Record<string, unknown>, requestId?: string) {
    super(HTTP_STATUS.CONFLICT, message, ERROR_CODES.CONFLICT, details, requestId);
    this.name = 'ConflictError';
  }
}

/**
 * 413 Payload Too Large - Request body exceeds size limit
 */
export class PayloadTooLargeError extends SdkApiError {
  constructor(message = 'Request payload too large', maxSize?: number, requestId?: string) {
    super(HTTP_STATUS.PAYLOAD_TOO_LARGE, message, ERROR_CODES.PAYLOAD_TOO_LARGE, { maxSize }, requestId);
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * 422 Unprocessable Entity - Request is valid but cannot be processed
 */
export class UnprocessableError extends SdkApiError {
  constructor(message: string, details?: Record<string, unknown>, requestId?: string) {
    super(HTTP_STATUS.UNPROCESSABLE_ENTITY, message, ERROR_CODES.UNPROCESSABLE_ENTITY, details, requestId);
    this.name = 'UnprocessableError';
  }
}

/**
 * 429 Too Many Requests - Rate limit exceeded
 */
export class RateLimitError extends SdkApiError {
  public readonly retryAfter?: number;

  constructor(message?: string, retryAfter?: number, requestId?: string) {
    const msg = message ?? (retryAfter
      ? `Rate limit exceeded. Retry after ${retryAfter} seconds`
      : 'Rate limit exceeded');
    super(HTTP_STATUS.TOO_MANY_REQUESTS, msg, ERROR_CODES.RATE_LIMITED, { retryAfter }, requestId);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/**
 * 503 Service Unavailable - Server temporarily unavailable
 */
export class ServiceUnavailableError extends SdkApiError {
  public readonly retryAfter?: number;

  constructor(message = 'Service temporarily unavailable', retryAfter?: number, requestId?: string) {
    super(HTTP_STATUS.SERVICE_UNAVAILABLE, message, ERROR_CODES.SERVICE_UNAVAILABLE, {
      retryAfter,
    }, requestId);
    this.name = 'ServiceUnavailableError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Network/connection error (no response received).
 *
 * The wrapped fetch-error message is sanitized at construction because it may
 * contain credentials embedded in the failing URL (e.g., a session token in
 * a query parameter that reached the fetch call). This is the proven exfil
 * path — direct `.message` access by logging middleware would otherwise leak
 * the upstream credential. Sanitizing at construction rather than at log sites
 * means consumers reading `err.message` directly (Sentry, winston) are safe.
 */
export class NetworkError extends SdkApiError {
  constructor(message: string, baseUrl?: string) {
    const hint = baseUrl
      ? `Failed to connect to ${baseUrl}. Verify the API server is running and the URL is correct.`
      : 'Network request failed. Check your connection and baseUrl configuration.';
    super(0, `${hint} (${sanitizeString(message, 0)})`, ERROR_CODES.NETWORK_ERROR, baseUrl ? { baseUrl } : undefined);
    this.name = 'NetworkError';
  }

  /**
   * Network errors are retryable — transient DNS failures, connection resets,
   * and ECONNREFUSED are all potentially recoverable on retry.
   */
  override isRetryable(): boolean {
    return true;
  }
}

/**
 * Request timeout error
 */
export class TimeoutError extends SdkApiError {
  constructor(timeoutMs: number) {
    super(
      -1,
      `Request timed out after ${timeoutMs}ms. Consider increasing timeout with { timeout: ${Math.max(timeoutMs * 2, 60000)} } or check network connectivity.`,
      ERROR_CODES.TIMEOUT,
      { timeoutMs }
    );
    this.name = 'TimeoutError';
  }
}

/**
 * Create appropriate error from HTTP status code.
 *
 * Server-returned messages are sanitized at this trust boundary so credentials
 * embedded in upstream API error responses cannot reach `err.message` access
 * by logging middleware. This is the second proven exfil path (in addition to
 * NetworkError). Hand-crafted error messages constructed elsewhere in the SDK
 * are not affected because they bypass this function.
 */
export function createErrorFromStatus(
  statusCode: number,
  message: string,
  code?: string,
  details?: Record<string, unknown>,
  requestId?: string
): SdkApiError {
  const safe = sanitizeString(message, 0);
  switch (statusCode) {
    case HTTP_STATUS.BAD_REQUEST:
      return new ValidationError(safe, details, requestId);
    case HTTP_STATUS.UNAUTHORIZED:
      return new UnauthorizedError(safe, requestId);
    case HTTP_STATUS.FORBIDDEN:
      return new ForbiddenError(safe, requestId);
    case HTTP_STATUS.NOT_FOUND:
      return new NotFoundError(safe, undefined, requestId);
    case HTTP_STATUS.CONFLICT:
      return new ConflictError(safe, details, requestId);
    case HTTP_STATUS.PAYLOAD_TOO_LARGE: {
      const maxSize = typeof details?.maxSize === 'number' ? details.maxSize : undefined;
      return new PayloadTooLargeError(safe, maxSize, requestId);
    }
    case HTTP_STATUS.UNPROCESSABLE_ENTITY:
      return new UnprocessableError(safe, details, requestId);
    case HTTP_STATUS.TOO_MANY_REQUESTS: {
      const retryAfter = typeof details?.retryAfter === 'number' ? details.retryAfter : undefined;
      return new RateLimitError(safe, retryAfter, requestId);
    }
    case HTTP_STATUS.SERVICE_UNAVAILABLE:
    case HTTP_STATUS.BAD_GATEWAY:
    case HTTP_STATUS.GATEWAY_TIMEOUT: {
      const retryAfter = typeof details?.retryAfter === 'number' ? details.retryAfter : undefined;
      return new ServiceUnavailableError(safe, retryAfter, requestId);
    }
    default:
      return new SdkApiError(statusCode, safe, code, details, requestId);
  }
}

/**
 * Type guard to check if an error is an SdkApiError
 */
export function isSdkApiError(error: unknown): error is SdkApiError {
  return error instanceof SdkApiError;
}

/**
 * Type guard for ValidationError
 */
export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}

/**
 * Type guard for NotFoundError
 */
export function isNotFoundError(error: unknown): error is NotFoundError {
  return error instanceof NotFoundError;
}

/**
 * Type guard for ConflictError
 */
export function isConflictError(error: unknown): error is ConflictError {
  return error instanceof ConflictError;
}

/**
 * Type guard for UnprocessableError
 */
export function isUnprocessableError(error: unknown): error is UnprocessableError {
  return error instanceof UnprocessableError;
}

/**
 * Type guard for RateLimitError
 */
export function isRateLimitError(error: unknown): error is RateLimitError {
  return error instanceof RateLimitError;
}

/**
 * Type guard for UnauthorizedError
 */
export function isUnauthorizedError(error: unknown): error is UnauthorizedError {
  return error instanceof UnauthorizedError;
}

/**
 * Type guard for ForbiddenError
 */
export function isForbiddenError(error: unknown): error is ForbiddenError {
  return error instanceof ForbiddenError;
}

/**
 * Type guard for PayloadTooLargeError
 */
export function isPayloadTooLargeError(error: unknown): error is PayloadTooLargeError {
  return error instanceof PayloadTooLargeError;
}

/**
 * Type guard for ServiceUnavailableError
 */
export function isServiceUnavailableError(error: unknown): error is ServiceUnavailableError {
  return error instanceof ServiceUnavailableError;
}

/**
 * Type guard for NetworkError
 */
export function isNetworkError(error: unknown): error is NetworkError {
  return error instanceof NetworkError;
}

/**
 * Type guard for TimeoutError
 */
export function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof TimeoutError;
}

