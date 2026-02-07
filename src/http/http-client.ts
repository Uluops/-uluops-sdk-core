/**
 * HTTP client for UluOps APIs using native fetch
 *
 * Single class with config object pattern. Each SDK creates a thin subclass
 * that passes SDK-specific defaults (baseUrl, sdkName, loggerPrefix, etc.).
 */

import type { ZodType } from 'zod';
import {
  DEFAULT_TIMEOUT,
  DEFAULT_RETRY_COUNT,
  BACKOFF_BASE_MS,
  MAX_BACKOFF_MS,
  JITTER_MIN,
  JITTER_MAX,
} from '../config/constants.js';
import {
  SdkApiError,
  createErrorFromStatus,
  NetworkError,
  TimeoutError,
  UnauthorizedError,
} from '../errors/errors.js';
import { createAuthStrategy, type AuthStrategy, type AuthConfig } from './auth-strategy.js';
import type { FetchClient } from './fetch-adapter.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { sleep, parseRateLimitHeaders, type RateLimitInfo } from '../utils/helpers.js';

/**
 * HTTP client configuration
 */
export interface HttpClientConfig {
  /** Base URL for API requests */
  baseUrl: string;
  /** Separate base URL for auth endpoints (e.g., registry delegates auth to ops API) */
  authBaseUrl?: string;
  /** SDK name for User-Agent header (e.g., '@uluops/ops-sdk') */
  sdkName: string;
  /** SDK version for User-Agent header */
  sdkVersion: string;
  /** Logger prefix (e.g., '[ops-sdk:http]') */
  loggerPrefix: string;
  /** Request timeout in ms */
  timeout?: number;
  /** Max retry attempts */
  retries?: number;
  /** Enable debug logging */
  debug?: boolean;
  /** Extra default headers beyond Content-Type and User-Agent */
  defaultHeaders?: Record<string, string>;
  /** Auth credentials */
  apiKey?: string;
  email?: string;
  password?: string;
  sessionToken?: string;
  onTokenRefresh?: (token: string) => void;
}

/**
 * Keys that should be stripped from error details to prevent leaking server internals
 */
const REDACTED_DETAIL_KEYS = new Set([
  'stack', 'trace', 'stackTrace', 'internal', 'query', 'sql', 'sqlMessage',
  'sqlState', 'errno', 'syscall', 'hostname', 'address',
]);

/**
 * Safely extract error fields from an unknown API response body
 */
function extractErrorBody(
  data: unknown
): { code?: string; message?: string; details?: Record<string, unknown> } | undefined {
  if (typeof data !== 'object' || data === null || !('error' in data)) return undefined;
  const error = (data as Record<string, unknown>).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const err = error as Record<string, unknown>;
  return {
    code: typeof err.code === 'string' ? err.code : undefined,
    message: typeof err.message === 'string' ? err.message : undefined,
    details:
      typeof err.details === 'object' && err.details !== null
        ? (err.details as Record<string, unknown>)
        : undefined,
  };
}

/**
 * Type guard for the standard API response envelope `{ data: T }`
 */
function isDataEnvelope(value: unknown): value is { data: unknown } {
  return value !== null && typeof value === 'object' && 'data' in value;
}

/**
 * HTTP client for UluOps APIs using native fetch
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly authBaseUrl: string;
  private readonly timeout: number;
  private readonly authStrategy: AuthStrategy | null;
  private readonly logger: Logger;
  private readonly retries: number;
  private readonly defaultHeaders: Record<string, string>;
  private lastRateLimitInfo: RateLimitInfo | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(config: HttpClientConfig) {
    this.logger = createLogger(config.loggerPrefix, config.debug ?? false);
    this.retries = config.retries ?? DEFAULT_RETRY_COUNT;
    this.baseUrl = config.baseUrl;
    this.authBaseUrl = config.authBaseUrl ?? config.baseUrl;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': `${config.sdkName}/${config.sdkVersion}`,
      ...config.defaultHeaders,
    };

    // Create auth strategy if credentials provided
    const hasCredentials = config.apiKey || config.sessionToken || (config.email && config.password);
    if (hasCredentials) {
      const authConfig: AuthConfig = {
        apiKey: config.apiKey,
        email: config.email,
        password: config.password,
        sessionToken: config.sessionToken,
        httpClient: this.createFetchClient(),
        onTokenRefresh: config.onTokenRefresh,
      };
      this.authStrategy = createAuthStrategy(authConfig);
    } else {
      this.authStrategy = null;
    }
  }

  /**
   * Create a minimal FetchClient for auth strategy use (login/refresh).
   * Uses authBaseUrl for authentication endpoints.
   */
  private createFetchClient(): FetchClient {
    return {
      post: async <T>(url: string, body: object) => {
        const fullUrl = this.buildAuthUrl(url);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
          const response = await fetch(fullUrl, {
            method: 'POST',
            headers: this.defaultHeaders,
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw this.createHttpError(response.status, data, response.headers);
          }

          const data = await response.json();
          return { data } as { data: { data: T } };
        } catch (error) {
          throw this.handleFetchError(error);
        } finally {
          clearTimeout(timeoutId);
        }
      },
    };
  }

  /**
   * Make an authenticated request with retry support
   *
   * By default, only GET requests are retried on transient errors.
   * Set `retryMutations: true` in options to also retry POST/PUT/DELETE
   * (only use this for idempotent endpoints).
   *
   * @remarks
   * The generic parameter `T` is asserted at the JSON boundary, not validated
   * at runtime. This matches the convention used by axios, ky, and got. If you
   * need runtime guarantees that the response matches `T`, pass a Zod schema
   * via `options.schema` — the response will be parsed and any mismatch throws
   * a ZodError before the value reaches your code.
   */
  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    endpoint: string,
    data?: object,
    options?: {
      params?: object;
      retries?: number;
      retryMutations?: boolean;
      headers?: Record<string, string>;
      schema?: ZodType<T>;
    }
  ): Promise<T> {
    const maxAttempts = options?.retries ?? this.retries;
    const canRetry = method === 'GET' || (options?.retryMutations === true);
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.doFetch<T>(method, endpoint, data, options);
        if (options?.schema) {
          return options.schema.parse(result);
        }
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (this.shouldRetryTransient(lastError, canRetry, attempt, maxAttempts)) {
          const delay = this.calculateBackoff(attempt);
          this.logger.debug(`Attempt ${attempt}/${maxAttempts} failed, retrying after ${delay}ms`);
          await sleep(delay);
          continue;
        }

        if (await this.attemptTokenRefresh(lastError, attempt)) {
          continue;
        }

        throw lastError;
      }
    }

    throw lastError ?? new Error('Request failed');
  }

  /**
   * Determine whether a transient error should be retried
   */
  private shouldRetryTransient(
    error: Error,
    canRetry: boolean,
    attempt: number,
    maxAttempts: number
  ): boolean {
    return (
      canRetry &&
      error instanceof SdkApiError &&
      error.isRetryable() &&
      attempt < maxAttempts
    );
  }

  /**
   * Attempt a token refresh on 401 errors (first attempt only, deduplicated).
   * Returns true if refresh succeeded and the request should be retried.
   */
  private async attemptTokenRefresh(error: Error, attempt: number): Promise<boolean> {
    if (attempt !== 1) return false;
    if (!(error instanceof UnauthorizedError)) return false;
    if (!this.authStrategy?.canRefresh()) return false;

    try {
      this.logger.debug('Token expired, attempting refresh...');
      if (!this.refreshPromise) {
        this.refreshPromise = this.authStrategy.refresh().finally(() => {
          this.refreshPromise = null;
        });
      }
      await this.refreshPromise;
      return true;
    } catch (refreshError) {
      this.logger.debug(
        `Token refresh failed: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`
      );
      return false;
    }
  }

  /**
   * Execute a fetch request
   */
  private async doFetch<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    endpoint: string,
    data?: object,
    options?: { params?: object; headers?: Record<string, string> }
  ): Promise<T> {
    const url = new URL(this.buildUrl(endpoint));

    // For GET requests, data goes into query params
    // For other methods, params go into query string
    const queryParams = method === 'GET' ? data : options?.params;
    if (queryParams) {
      for (const [key, value] of Object.entries(queryParams)) {
        if (value === undefined || value === null) {
          continue;
        }
        if (Array.isArray(value)) {
          for (const item of value) {
            url.searchParams.append(key, String(item));
          }
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }

    // Build headers
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...options?.headers,
    };
    if (this.authStrategy) {
      headers['Authorization'] = this.authStrategy.getAuthorizationHeader();
    }

    // Prepare request body
    const body = method !== 'GET' ? JSON.stringify(data) : undefined;

    // Fetch with timeout using AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      this.logger.debug(`${method} ${endpoint} -> ${response.status}`);

      // Parse rate limit headers
      this.lastRateLimitInfo = parseRateLimitHeaders(response.headers);

      // Handle errors
      if (!response.ok) {
        if (response.status === 401 && !this.authStrategy) {
          throw new UnauthorizedError(
            'No credentials configured. Set ULUOPS_API_KEY environment variable, ' +
            'pass apiKey to the constructor, or provide sessionToken. ' +
            'See: https://github.com/Uluops/-uluops-sdk-core#authentication'
          );
        }
        const errorData = await response.json().catch(() => ({}));
        throw this.createHttpError(response.status, errorData, response.headers);
      }

      // Handle 204 No Content
      if (response.status === 204) {
        return undefined as T;
      }

      // Parse response
      const text = await response.text();
      if (!text) {
        return undefined as T;
      }

      let responseData: unknown;
      try {
        responseData = JSON.parse(text);
      } catch {
        throw new SdkApiError(response.status, `Invalid JSON response from ${method} ${endpoint}`);
      }

      if (!isDataEnvelope(responseData)) {
        throw new Error(
          `Unexpected API response format: expected { data: ... } wrapper but received ${
            responseData === null ? 'null' : typeof responseData
          }`
        );
      }
      return responseData.data as T;
    } catch (error) {
      if (error instanceof SdkApiError) {
        this.logger.debug(`${method} ${endpoint} -> ${error.statusCode ?? 'ERROR'}`);
      }
      throw this.handleFetchError(error);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Make a request that returns the full response (for non-standard responses)
   */
  async requestRaw<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    endpoint: string,
    data?: object,
    options?: { params?: object; headers?: Record<string, string>; schema?: ZodType<T> }
  ): Promise<T> {
    const url = new URL(this.buildUrl(endpoint));
    const queryParams = method === 'GET' ? data : options?.params;
    if (queryParams) {
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...options?.headers,
    };
    if (this.authStrategy) {
      headers['Authorization'] = this.authStrategy.getAuthorizationHeader();
    }

    const body = method !== 'GET' ? JSON.stringify(data) : undefined;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw this.createHttpError(response.status, errorData, response.headers);
      }

      const text = await response.text();
      if (!text) {
        return undefined as T;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new SdkApiError(response.status, 'Invalid JSON response');
      }

      if (options?.schema) {
        return options.schema.parse(parsed);
      }
      return parsed as T;
    } catch (error) {
      throw this.handleFetchError(error);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Make a request that returns the raw Response object (for binary data, streaming, etc.)
   */
  async requestBinary(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    endpoint: string,
    options?: { params?: object; headers?: Record<string, string> }
  ): Promise<{ data: ArrayBuffer; contentType: string; headers: Headers }> {
    const url = new URL(this.buildUrl(endpoint));
    const queryParams = options?.params;
    if (queryParams) {
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...options?.headers,
    };
    delete headers['Content-Type'];
    if (this.authStrategy) {
      headers['Authorization'] = this.authStrategy.getAuthorizationHeader();
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw this.createHttpError(response.status, errorData, response.headers);
      }

      const responseData = await response.arrayBuffer();
      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      return { data: responseData, contentType, headers: response.headers };
    } catch (error) {
      throw this.handleFetchError(error);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async get<T>(endpoint: string, params?: object, options?: { schema?: ZodType<T> }): Promise<T> {
    return this.request<T>('GET', endpoint, params, options);
  }

  async post<T>(endpoint: string, data?: object, options?: { schema?: ZodType<T> }): Promise<T> {
    return this.request<T>('POST', endpoint, data, options);
  }

  async patch<T>(endpoint: string, data?: object, options?: { params?: object }): Promise<T> {
    return this.request<T>('PATCH', endpoint, data, options);
  }

  async put<T>(endpoint: string, data?: object, options?: { schema?: ZodType<T> }): Promise<T> {
    return this.request<T>('PUT', endpoint, data, options);
  }

  async delete<T>(endpoint: string, data?: object, options?: { schema?: ZodType<T> }): Promise<T> {
    return this.request<T>('DELETE', endpoint, data, options);
  }

  /**
   * Get the auth strategy (for session management)
   */
  getAuthStrategy(): AuthStrategy | null {
    return this.authStrategy;
  }

  /**
   * Get the last rate limit info from a response
   */
  getRateLimitInfo(): RateLimitInfo | null {
    if (!this.lastRateLimitInfo) return null;
    return { ...this.lastRateLimitInfo };
  }

  /**
   * Create an HTTP error from response data
   */
  private createHttpError(
    status: number,
    data: unknown,
    headers: Headers
  ): SdkApiError {
    const apiError = extractErrorBody(data);
    const requestId = headers.get('x-request-id') ?? undefined;
    const retryAfter = headers.get('retry-after');

    // Fast path: no details and no retry-after to process
    if (!apiError?.details && !retryAfter) {
      return createErrorFromStatus(
        status,
        apiError?.message ?? `HTTP ${status}`,
        apiError?.code,
        undefined,
        requestId
      );
    }

    // Copy details, stripping keys that could contain server internals
    const details: Record<string, unknown> = {};
    if (apiError?.details) {
      for (const [key, value] of Object.entries(apiError.details)) {
        if (!REDACTED_DETAIL_KEYS.has(key)) {
          details[key] = value;
        }
      }
    }

    if (retryAfter) {
      const parsedRetryAfter = parseInt(retryAfter, 10);
      if (!isNaN(parsedRetryAfter)) {
        details.retryAfter = parsedRetryAfter;
      }
    }

    return createErrorFromStatus(
      status,
      apiError?.message ?? `HTTP ${status}`,
      apiError?.code,
      Object.keys(details).length > 0 ? details : undefined,
      requestId
    );
  }

  /**
   * Handle fetch-specific errors (network, timeout, etc.)
   */
  private handleFetchError(error: unknown): Error {
    if (error instanceof SdkApiError) {
      return error;
    }

    if (error instanceof DOMException && error.name === 'AbortError') {
      return new TimeoutError(this.timeout);
    }

    if (error instanceof TypeError) {
      if (!this.authStrategy) {
        return new UnauthorizedError(
          'No credentials configured. Set ULUOPS_API_KEY environment variable, ' +
          'pass apiKey to the constructor, or provide sessionToken. ' +
          `See: https://github.com/Uluops/-uluops-sdk-core#authentication (Network error: ${error.message})`
        );
      }
      return new NetworkError(error.message, this.baseUrl);
    }

    if (error instanceof Error) {
      return error;
    }

    return new Error(String(error));
  }

  /**
   * Calculate exponential backoff delay with jitter
   */
  private calculateBackoff(attempt: number): number {
    const delay = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
    const jitterRange = JITTER_MAX - JITTER_MIN;
    const jitter = delay * (JITTER_MIN + Math.random() * jitterRange);
    return Math.min(delay + jitter, MAX_BACKOFF_MS);
  }

  /**
   * Normalize a base URL and endpoint into a full URL
   */
  private static joinUrl(base: string, endpoint: string): string {
    const normalizedBase = base.replace(/\/$/, '');
    const normalizedPath = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return `${normalizedBase}${normalizedPath}`;
  }

  /**
   * Build full URL by concatenating baseUrl and endpoint
   */
  private buildUrl(endpoint: string): string {
    return HttpClient.joinUrl(this.baseUrl, endpoint);
  }

  /**
   * Build full URL using authBaseUrl (for login/refresh)
   */
  private buildAuthUrl(endpoint: string): string {
    return HttpClient.joinUrl(this.authBaseUrl, endpoint);
  }
}
