/**
 * HTTP client for UluOps APIs using native fetch
 *
 * Single class with config object pattern. Each SDK creates a subclass
 * that passes SDK-specific defaults (baseUrl, sdkName, loggerPrefix, etc.).
 */

import { isIP } from 'node:net';
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
  RateLimitError,
  ServiceUnavailableError,
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
  /**
   * Called when the rate limit remaining drops below the threshold ratio.
   * Fires at most once per threshold crossing (resets when remaining recovers).
   * @param info - Current rate limit state from response headers
   */
  onRateLimitApproaching?: (info: RateLimitInfo) => void;
  /**
   * Ratio of remaining/limit below which `onRateLimitApproaching` fires.
   * Default: 0.1 (10% remaining).
   */
  rateLimitThreshold?: number;
  /**
   * Called before each retry attempt. Receives the attempt number, max attempts,
   * the error that triggered the retry, and the backoff delay in ms.
   * Fires for both transient HTTP errors and network errors.
   */
  onRetry?: (info: { attempt: number; maxAttempts: number; error: Error; delayMs: number }) => void;
}

/**
 * Keys stripped from error details to prevent leaking server internals.
 * Defense-in-depth: the API error handlers already sanitize responses,
 * but this catches leakage through ApiError.details if a developer
 * passes raw error fields through.
 *
 * Categories:
 * - Stack traces: stack, trace, stackTrace
 * - Database internals: query, sql, sqlMessage, sqlState, table, column,
 *   constraint (MySQL/Postgres leakage via raw error passthrough)
 * - System internals: errno, syscall, hostname, address, port, pid, path
 * - Framework internals: internal, cause, original, source, raw
 *
 * This is defense-in-depth: the API error handlers already sanitize responses
 * server-side. This client-side list catches leakage through ApiError.details
 * if a developer passes raw error fields through. A static list will miss keys
 * from new ORMs or frameworks — accept this tradeoff over pattern-matching
 * heuristics that risk false positives on legitimate detail fields.
 *
 * Last reviewed: 2026-05-23 (expanded from v0.1.0 MySQL-only list)
 */
const REDACTED_DETAIL_KEYS = new Set([
  // Stack traces
  'stack', 'trace', 'stackTrace',
  // Database internals (MySQL, Postgres, SQLite)
  'query', 'sql', 'sqlMessage', 'sqlState', 'table', 'column', 'constraint',
  // System/OS internals
  'errno', 'syscall', 'hostname', 'address', 'port', 'pid', 'path',
  // Framework/error-chain internals
  'internal', 'cause', 'original', 'source', 'raw',
]);

/**
 * Type guard: value is a non-null object with string-keyed properties
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Safely extract error fields from an unknown API response body
 */
function extractErrorBody(
  data: unknown
): { code?: string; message?: string; details?: Record<string, unknown> } | undefined {
  if (!isRecord(data) || !('error' in data)) return undefined;
  const error = data.error;
  if (!isRecord(error)) return undefined;
  // API validation errors use `errors` (Zod issues), other errors use `details`
  const details = isRecord(error.details)
    ? error.details
    : Array.isArray(error.errors)
      ? { errors: error.errors }
      : undefined;

  return {
    code: typeof error.code === 'string' ? error.code : undefined,
    message: typeof error.message === 'string' ? error.message : undefined,
    details,
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
  private authStrategy: AuthStrategy | null;
  private readonly logger: Logger;
  private readonly retries: number;
  private readonly defaultHeaders: Record<string, string>;
  private lastRateLimitInfo: RateLimitInfo | null = null;
  private refreshPromise: Promise<void> | null = null;
  private readonly onRateLimitApproaching?: (info: RateLimitInfo) => void;
  private readonly rateLimitThreshold: number;
  private rateLimitWarningFired = false;
  private readonly onRetry?: (info: { attempt: number; maxAttempts: number; error: Error; delayMs: number }) => void;

  constructor(config: HttpClientConfig) {
    this.logger = createLogger(config.loggerPrefix, config.debug ?? false);
    this.retries = config.retries ?? DEFAULT_RETRY_COUNT;
    this.onRateLimitApproaching = config.onRateLimitApproaching;
    this.rateLimitThreshold = config.rateLimitThreshold ?? 0.1;
    this.onRetry = config.onRetry;
    this.baseUrl = config.baseUrl;
    this.authBaseUrl = config.authBaseUrl ?? config.baseUrl;
    HttpClient.validateBaseUrl(this.baseUrl);
    if (this.authBaseUrl !== this.baseUrl) {
      HttpClient.validateBaseUrl(this.authBaseUrl);
    }
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    HttpClient.validateHeaders(config.defaultHeaders);
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
  createFetchClient(): FetchClient {
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
            redirect: 'error',
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
   * need runtime guarantees that the response matches `T`, parse the result
   * yourself with a Zod schema after the call:
   *
   * ```ts
   * const data = FooSchema.parse(await client.get<unknown>('/foo'));
   * ```
   *
   * The SDK does not accept caller-supplied schemas. Earlier versions exposed
   * an `options.schema` parameter that invoked `.parse()` internally; this was
   * removed because the structural type accepted any object with a `parse`
   * method, creating a code-execution primitive when the schema was supplied
   * by an untrusted source. See CHANGELOG 0.11.0.
   *
   * **204 No Content:** Returns `undefined as T`. Callers expecting a 204
   * should type as `request<void>(...)` or handle the undefined case.
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
      skipAuth?: boolean;
      /** Return the full JSON body without unwrapping the `{ data: T }` envelope */
      rawEnvelope?: boolean;
    }
  ): Promise<T> {
    // `retries` is the retry budget; floor the attempt count at 1 so that
    // `retries: 0` still makes one attempt (and surfaces the real error, e.g.
    // NetworkError) rather than skipping the loop entirely and throwing a bare
    // `Error('Request failed')` with no context.
    const maxAttempts = Math.max(1, options?.retries ?? this.retries);
    const canRetry = method === 'GET' || (options?.retryMutations === true);
    let lastError: Error | null = null;
    let refreshAttempted = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.doFetch<T>(method, endpoint, data, options);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error), { cause: error });

        if (this.shouldRetryTransient(lastError, canRetry, attempt, maxAttempts)) {
          const delay = this.calculateBackoffWithRetryAfter(lastError, attempt);
          this.logger.warn(`Attempt ${attempt}/${maxAttempts} failed (${lastError.message}), retrying after ${delay}ms`);
          this.onRetry?.({ attempt, maxAttempts, error: lastError, delayMs: delay });
          await sleep(delay);
          continue;
        }

        // Token refresh: attempt to refresh the token on 401 errors.
        // For GET requests, retry automatically after refresh.
        // For mutations (POST/PUT/PATCH/DELETE), only retry after refresh
        // if retryMutations is enabled — a server that partially processes
        // before returning 401 would cause silent double-execution.
        if (!refreshAttempted && await this.attemptTokenRefresh(lastError)) {
          refreshAttempted = true;
          if (canRetry) {
            continue;
          }
          // Mutation without retryMutations: refresh succeeded but we
          // don't retry the request — caller should handle the retry
          // decision for non-idempotent operations.
          this.logger.warn(
            `Token refreshed but ${method} ${endpoint} not retried (mutation). ` +
            `Set retryMutations: true for idempotent mutation endpoints.`
          );
          throw lastError;
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
   * Attempt a token refresh on 401 errors (deduplicated).
   * Returns true if refresh succeeded and the request should be retried.
   */
  private async attemptTokenRefresh(error: Error): Promise<boolean> {
    if (!(error instanceof UnauthorizedError)) return false;
    if (!this.authStrategy?.canRefresh()) {
      if (this.authStrategy?.getType() === 'session') {
        this.logger.debug(
          'Token refresh skipped — credentials were cleared after login (CWE-316 mitigation). ' +
          'Set clearCredentialsAfterLogin: false for long-lived sessions that need automatic re-authentication.'
        );
        // Throw a new error with enriched context rather than mutating the
        // original — direct message mutation bypasses sanitizeForDisplay in
        // toJSON(), which only sanitizes the details field.
        throw new UnauthorizedError(
          'Session token expired and automatic refresh is unavailable — ' +
          'credentials were cleared after login. Call login() again to re-authenticate.'
        );
      }
      return false;
    }

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
   * Build a URL with query parameters applied
   */
  private buildRequestUrl(
    endpoint: string,
    method: string,
    data?: object,
    params?: object
  ): URL {
    const url = new URL(this.buildUrl(endpoint));
    const queryParams = method === 'GET' ? data : params;
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
    return url;
  }

  /**
   * Parse a JSON response body, unwrap the `{ data: T }` envelope, and return T
   */
  private parseJsonEnvelope<T>(text: string, status: number, method: string, endpoint: string): T {
    let responseData: unknown;
    try {
      responseData = JSON.parse(text);
    } catch {
      throw new SdkApiError(status, `Invalid JSON response from ${method} ${endpoint}`);
    }

    if (!isDataEnvelope(responseData)) {
      throw new SdkApiError(
        status,
        `Unexpected API response format: expected { data: ... } wrapper but received ${
          responseData === null ? 'null' : typeof responseData
        }`
      );
    }
    // SAFETY: `as T` — the generic is asserted at the JSON boundary, not validated
    // at runtime. This matches the convention used by axios/ky/got. For runtime
    // guarantees, callers should parse the result with a Zod schema themselves:
    // `FooSchema.parse(await client.get<unknown>('/foo'))`.
    return responseData.data as T;
  }

  /**
   * Execute a fetch request
   */
  private async doFetch<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    endpoint: string,
    data?: object,
    options?: { params?: object; headers?: Record<string, string>; skipAuth?: boolean; rawEnvelope?: boolean }
  ): Promise<T> {
    const url = this.buildRequestUrl(endpoint, method, data, options?.params);

    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...options?.headers,
    };
    if (this.authStrategy && !options?.skipAuth) {
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
        redirect: 'error',
      });

      this.logger.debug(`${method} ${endpoint} -> ${response.status}`);
      this.lastRateLimitInfo = parseRateLimitHeaders(response.headers);
      this.checkRateLimitThreshold();

      if (!response.ok) {
        if (response.status === 401) {
          if (!this.authStrategy) {
            throw new UnauthorizedError(
              'No credentials configured. Set ULUOPS_API_KEY environment variable, ' +
              'pass apiKey to the constructor, or provide sessionToken.'
            );
          }
          // Credentials were sent but the server rejected them. Distinguish this
          // from the no-credentials case so the caller knows the credential
          // itself — not its absence — is the problem. Message is hand-crafted
          // (no server-supplied text or URL), so it bypasses createErrorFromStatus
          // and carries no credential-leak risk.
          const requestId = response.headers.get('x-request-id') ?? undefined;
          throw new UnauthorizedError(
            `Authentication failed: the provided ${this.authStrategy.getType()} credential was rejected (401). ` +
            'It may be expired, revoked, or invalid. Verify the credential and that it has access to this resource.',
            requestId,
          );
        }
        const errorData = await response.json().catch(() => ({}));
        throw this.createHttpError(response.status, errorData, response.headers);
      }

      if (response.status === 204) {
        // SAFETY: `as T` — 204 No Content has no body; callers should type as `request<void>(...)`
        return undefined as T;
      }

      const text = await response.text();
      if (!text) {
        // SAFETY: `as T` — empty body equivalent to 204; see above
        return undefined as T;
      }

      if (options?.rawEnvelope) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new SdkApiError(response.status, `Invalid JSON response from ${method} ${endpoint}`);
        }
        return parsed as T;
      }

      return this.parseJsonEnvelope<T>(text, response.status, method, endpoint);
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
   * Low-level fetch primitive shared by requestRaw and requestBinary.
   * Handles URL building, auth headers, timeout, and error mapping.
   */
  private async executeFetch(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    endpoint: string,
    options?: {
      params?: object;
      headers?: Record<string, string>;
      body?: string;
      removeContentType?: boolean;
      skipAuth?: boolean;
    }
  ): Promise<Response> {
    const url = new URL(this.buildUrl(endpoint));
    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...options?.headers,
    };
    if (options?.removeContentType) {
      delete headers['Content-Type'];
    }
    if (this.authStrategy && !options?.skipAuth) {
      headers['Authorization'] = this.authStrategy.getAuthorizationHeader();
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        body: options?.body,
        signal: controller.signal,
        redirect: 'error',
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw this.createHttpError(response.status, errorData, response.headers);
      }

      return response;
    } catch (error) {
      throw this.handleFetchError(error);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Make a request that returns the full response (for non-standard responses).
   *
   * **⚠️ No resilience features.** Unlike {@link request}, this method bypasses:
   * - **Retry with backoff** — transient 502/503/504 errors are not retried
   * - **Token refresh on 401** — expired sessions are not automatically re-authenticated
   * - **Rate limit tracking** — `Retry-After` headers are not parsed or respected
   *
   * Use this only for endpoints that return non-standard response envelopes.
   * For standard API calls, prefer {@link request} which includes all resilience features.
   */
  async requestRaw<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    endpoint: string,
    data?: object,
    options?: { params?: object; headers?: Record<string, string> }
  ): Promise<T> {
    const params = method === 'GET' ? data : options?.params;
    const body = method !== 'GET' ? JSON.stringify(data) : undefined;

    const response = await this.executeFetch(method, endpoint, {
      params: params as object,
      headers: options?.headers,
      body,
    });

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

    return parsed as T;
  }

  /**
   * Make a request that returns binary data (ArrayBuffer).
   *
   * **⚠️ No resilience features.** Unlike {@link request}, this method bypasses:
   * - **Retry with backoff** — transient 502/503/504 errors are not retried
   * - **Token refresh on 401** — expired sessions are not automatically re-authenticated
   * - **Rate limit tracking** — `Retry-After` headers are not parsed or respected
   *
   * Use this only for binary downloads (e.g., avatar images).
   * For standard API calls, prefer {@link request} which includes all resilience features.
   */
  async requestBinary(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    endpoint: string,
    options?: { params?: object; headers?: Record<string, string> }
  ): Promise<{ data: ArrayBuffer; contentType: string; headers: Headers }> {
    const response = await this.executeFetch(method, endpoint, {
      params: options?.params as object,
      headers: options?.headers,
      removeContentType: true,
    });

    const responseData = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    return { data: responseData, contentType, headers: response.headers };
  }

  /**
   * Send a GET request. Automatically retried on transient errors.
   * @param endpoint - API endpoint path (e.g. '/items')
   * @param params - Query parameters as key-value pairs
   * @returns Response body of type T (unvalidated — parse with a Zod schema if needed)
   */
  async get<T>(endpoint: string, params?: object): Promise<T> {
    return this.request<T>('GET', endpoint, params);
  }

  /**
   * Send a POST request. Not retried by default (use `retryMutations` to opt in).
   * @param endpoint - API endpoint path
   * @param data - Request body
   * @param options - skipAuth to bypass auth, retryMutations to enable retry
   * @returns Response body of type T (unvalidated — parse with a Zod schema if needed)
   */
  async post<T>(endpoint: string, data?: object, options?: { skipAuth?: boolean; retryMutations?: boolean }): Promise<T> {
    return this.request<T>('POST', endpoint, data, options);
  }

  /**
   * Send a PATCH request. Not retried by default.
   * @param endpoint - API endpoint path
   * @param data - Request body with partial update fields
   * @param options - params for query parameters, skipAuth to bypass auth
   * @returns Response body of type T (unvalidated — parse with a Zod schema if needed)
   */
  async patch<T>(endpoint: string, data?: object, options?: { params?: object; skipAuth?: boolean }): Promise<T> {
    return this.request<T>('PATCH', endpoint, data, options);
  }

  /**
   * Send a PUT request. Not retried by default.
   * @param endpoint - API endpoint path
   * @param data - Request body
   * @param options - skipAuth to bypass auth
   * @returns Response body of type T (unvalidated — parse with a Zod schema if needed)
   */
  async put<T>(endpoint: string, data?: object, options?: { skipAuth?: boolean }): Promise<T> {
    return this.request<T>('PUT', endpoint, data, options);
  }

  /**
   * Send a DELETE request. Not retried by default.
   * @param endpoint - API endpoint path
   * @param data - Optional request body
   * @param options - skipAuth to bypass auth, retryMutations to enable retry
   * @returns Response body of type T (unvalidated — parse with a Zod schema if needed)
   */
  async delete<T>(endpoint: string, data?: object, options?: { skipAuth?: boolean; retryMutations?: boolean }): Promise<T> {
    return this.request<T>('DELETE', endpoint, data, options);
  }

  /**
   * Get the auth base URL (for creating temporary clients with same auth endpoint)
   */
  getAuthBaseUrl(): string {
    return this.authBaseUrl;
  }

  /**
   * Get the auth strategy (for session management)
   */
  getAuthStrategy(): AuthStrategy | null {
    return this.authStrategy;
  }

  /**
   * Replace the auth strategy (e.g., after login obtains a session token).
   */
  setAuthStrategy(strategy: AuthStrategy | null): void {
    this.authStrategy = strategy;
  }

  /**
   * Get the last rate limit info from a response
   */
  getRateLimitInfo(): RateLimitInfo | null {
    if (!this.lastRateLimitInfo) return null;
    return { ...this.lastRateLimitInfo };
  }

  /**
   * Fire onRateLimitApproaching when remaining/limit drops below threshold.
   * Resets the flag when remaining recovers above threshold.
   */
  private checkRateLimitThreshold(): void {
    if (!this.onRateLimitApproaching || !this.lastRateLimitInfo) return;
    const { remaining, limit } = this.lastRateLimitInfo;
    if (limit <= 0) return;

    const ratio = remaining / limit;
    if (ratio <= this.rateLimitThreshold) {
      if (!this.rateLimitWarningFired) {
        this.rateLimitWarningFired = true;
        this.onRateLimitApproaching({ ...this.lastRateLimitInfo });
      }
    } else {
      this.rateLimitWarningFired = false;
    }
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
      const hint = !this.authStrategy
        ? ' (No credentials configured — if this is not a public endpoint, set ULUOPS_API_KEY or pass apiKey to the constructor.)'
        : '';
      return new NetworkError(
        `${error.message}${hint}. Try: curl -I ${this.baseUrl ?? '<baseUrl>'}`,
        this.baseUrl
      );
    }

    if (error instanceof Error) {
      return error;
    }

    return new Error(String(error));
  }

  /**
   * Calculate backoff delay, preferring the server's retry-after header
   * when available. Falls back to exponential backoff with jitter.
   */
  private calculateBackoffWithRetryAfter(error: Error, attempt: number): number {
    // Prefer server-specified retry-after (in seconds) from 429/503 responses
    if (error instanceof RateLimitError || error instanceof ServiceUnavailableError) {
      const { retryAfter } = error;
      if (typeof retryAfter === 'number' && retryAfter > 0) {
        // Cap at MAX_BACKOFF_MS to prevent absurd waits
        return Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
      }
    }
    return this.calculateBackoff(attempt);
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
   * Validate that a base URL uses HTTPS for non-loopback targets.
   * Prevents SSRF via environment variable injection and cleartext credential transmission.
   *
   * Scope: validates the configured origin only, not per-request destinations.
   * This is sufficient because runtime URLs are constructed via buildUrl() which
   * concatenates this validated baseUrl with SDK-controlled endpoint path literals
   * (e.g., '/auth/login', '/definitions/:type/:name'). No consumer-supplied strings
   * reach URL construction, so destination-level SSRF is not possible through the SDK.
   *
   * HTTP is allowed only for loopback names ('localhost', '127.0.0.1', '[::1]')
   * and IP literals in RFC1918 ranges. Hostnames that visually resemble private
   * IPs ('10.attacker.example') do not qualify — only actual IPv4 literals
   * (verified via node:net isIP) are tested against the private ranges.
   * '0.0.0.0' is rejected because it is a bind address, not a valid destination.
   */
  private static validateBaseUrl(url: string): void {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') return;
      const host = parsed.hostname;
      const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
      // Only treat as private when host is an actual IPv4 literal — DNS names whose
      // labels start with '10.' or '192.168.' must not bypass HTTPS enforcement.
      const isPrivateIp =
        isIP(host) === 4 &&
        (
          /^10\./.test(host) ||
          /^192\.168\./.test(host) ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(host)
        );
      if (!isLoopback && !isPrivateIp) {
        throw new Error(
          `baseUrl must use HTTPS for non-loopback targets (got ${parsed.protocol}//${parsed.hostname}). ` +
          `HTTP is only allowed for localhost/127.0.0.1/[::1] and IPv4 literals in RFC1918 ranges.`
        );
      }
    } catch (e) {
      if (e instanceof TypeError) {
        throw new Error(`Invalid baseUrl: ${url}`);
      }
      throw e;
    }
  }

  /**
   * Validate header names and values against RFC 7230 to reject CR/LF/NUL
   * injection (request smuggling) and out-of-spec characters. Applied to
   * consumer-supplied `defaultHeaders` at construction; per-request `headers`
   * passed to individual fetch methods are still validated by the underlying
   * fetch implementation, but defenders should also sanitize at the caller.
   *
   * RFC 7230 §3.2.6 — header name is `1*tchar`; value is VCHAR/obs-text.
   * CR (0x0D), LF (0x0A), and NUL (0x00) are explicitly forbidden in both.
   */
  private static validateHeaders(headers: Record<string, string> | undefined): void {
    if (!headers) return;
    const tchar = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
    const forbiddenValueChars = /[\r\n\0]/;
    for (const [name, value] of Object.entries(headers)) {
      if (typeof name !== 'string' || typeof value !== 'string') {
        throw new Error(`Invalid header: name and value must be strings`);
      }
      if (!tchar.test(name)) {
        throw new Error(
          `Invalid header name "${name}": must match RFC 7230 tchar (alphanumeric and !#$%&'*+-.^_\`|~)`
        );
      }
      if (forbiddenValueChars.test(value)) {
        throw new Error(
          `Invalid header value for "${name}": CR, LF, and NUL characters are forbidden (header smuggling prevention)`
        );
      }
    }
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
