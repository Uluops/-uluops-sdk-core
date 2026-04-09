/**
 * Shared constants for UluOps SDKs
 *
 * SDK-specific values (DEFAULT_BASE_URL, ENV_VARS, USER_AGENT, SDK_VERSION)
 * are NOT included here — each SDK defines those in its own constants file.
 */

/**
 * sdk-core package version
 *
 * Hardcoded instead of reading package.json via createRequire(node:module)
 * so this module can be imported in browser environments.
 * Keep in sync with package.json "version" field.
 */
export const SDK_CORE_VERSION = '0.1.1';

/**
 * Default request timeout in milliseconds
 */
export const DEFAULT_TIMEOUT = 30000;

/**
 * Default retry count for transient errors
 */
export const DEFAULT_RETRY_COUNT = 3;

/**
 * Base delay for exponential backoff (in ms)
 */
export const BACKOFF_BASE_MS = 1000;

/**
 * Maximum backoff delay (in ms)
 */
export const MAX_BACKOFF_MS = 30000;

/**
 * Jitter range for backoff calculation (10-20% of delay)
 */
export const JITTER_MIN = 0.1;
export const JITTER_MAX = 0.2;

/**
 * API key prefix
 */
export const API_KEY_PREFIX = 'ulr_';

/**
 * Config file paths
 */
export const CONFIG_PATHS = {
  LOCAL_ENV: '.env',
  GLOBAL_DIR: '.uluops',
  GLOBAL_ENV: '.uluops/.env',
  CREDENTIALS: '.uluops/credentials.json',
} as const;

/**
 * HTTP status codes (superset of both SDKs)
 */
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
} as const;

/**
 * Retryable HTTP status codes
 */
export const RETRYABLE_STATUS_CODES = new Set([
  HTTP_STATUS.BAD_GATEWAY,
  HTTP_STATUS.SERVICE_UNAVAILABLE,
  HTTP_STATUS.GATEWAY_TIMEOUT,
  HTTP_STATUS.TOO_MANY_REQUESTS,
]);

/**
 * Error codes (superset of both SDKs)
 */
export const ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  UNPROCESSABLE_ENTITY: 'UNPROCESSABLE_ENTITY',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  RESPONSE_VALIDATION_ERROR: 'RESPONSE_VALIDATION_ERROR',
  UNKNOWN: 'UNKNOWN',
} as const;
