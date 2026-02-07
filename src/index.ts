// HTTP
export { HttpClient, type HttpClientConfig } from './http/http-client.js';
export {
  ApiKeyAuth,
  JwtSessionAuth,
  createAuthStrategy,
  type AuthStrategy,
  type AuthConfig,
} from './http/auth-strategy.js';
export type { FetchClient } from './http/fetch-adapter.js';

// Errors
export {
  SdkApiError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  PayloadTooLargeError,
  UnprocessableError,
  RateLimitError,
  ServiceUnavailableError,
  NetworkError,
  TimeoutError,
  createErrorFromStatus,
  isSdkApiError,
  isValidationError,
  isNotFoundError,
  isConflictError,
  isUnprocessableError,
  isRateLimitError,
} from './errors/errors.js';

// Config
export {
  loadCredentials,
  loadConfig,
  loadEnvFiles,
  loadStoredCredentials,
  getGlobalConfigDir,
  getCredentialsPath,
  isApiKey,
  validateCredentials,
  type Credentials,
  type SdkConfig,
  type EnvVarConfig,
} from './config/loaders.js';

export {
  DEFAULT_TIMEOUT,
  DEFAULT_RETRY_COUNT,
  BACKOFF_BASE_MS,
  MAX_BACKOFF_MS,
  JITTER_MIN,
  JITTER_MAX,
  API_KEY_PREFIX,
  CONFIG_PATHS,
  HTTP_STATUS,
  ERROR_CODES,
  RETRYABLE_STATUS_CODES,
} from './config/constants.js';

// Utils
export {
  sleep,
  retry,
  isPlainObject,
  isUuid,
  truncate,
  parseRateLimitHeaders,
  toQuery,
  type RateLimitInfo,
  type QueryParams,
  type QueryParamValue,
} from './utils/helpers.js';

export {
  createLogger,
  redactSensitive,
  sanitizeForDisplay,
  sanitizeForLog,
  type Logger,
} from './utils/logger.js';
