/**
 * Authentication strategies for UluOps SDKs
 *
 * Supports three authentication methods:
 * 1. API Key - Bearer token using API key (preferred)
 * 2. Session Token - Token from the ops-uluops-api
 * 3. Email/Password - Login via ops-uluops-api to obtain a session token
 */

import type { FetchClient } from './fetch-adapter.js';
import { API_KEY_PREFIX } from '../config/constants.js';
import { ValidationError, UnauthorizedError } from '../errors/errors.js';

/**
 * Authentication strategy interface.
 *
 * Implementations handle credential storage and header generation.
 * Use {@link createAuthStrategy} to instantiate the correct strategy
 * from an {@link AuthConfig}.
 */
export interface AuthStrategy {
  /** Return the `Authorization` header value (e.g. `"Bearer <token>"`) */
  getAuthorizationHeader(): string;
  /** Whether the strategy supports token refresh (true for session auth) */
  canRefresh(): boolean;
  /** Refresh the credential (re-login). Throws if not refreshable. */
  refresh(): Promise<void>;
  /** Whether the strategy currently holds a valid credential */
  isAuthenticated(): boolean;
  /** Discriminator for the credential type */
  getType(): 'api_key' | 'session';
}

/**
 * Configuration for creating an auth strategy
 */
export interface AuthConfig {
  apiKey?: string;
  email?: string;
  password?: string;
  sessionToken?: string;
  httpClient?: FetchClient;
  onTokenRefresh?: (token: string) => void;
}

/**
 * Minimum API key length (prefix + at least 16 chars)
 */
const MIN_API_KEY_LENGTH = 20;

/**
 * Valid API key character pattern (alphanumeric, underscores, hyphens)
 */
const API_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * API key authentication strategy
 */
export class ApiKeyAuth implements AuthStrategy {
  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new ValidationError('API key is required', { field: 'apiKey' });
    }
    if (!apiKey.startsWith(API_KEY_PREFIX)) {
      throw new ValidationError(`Invalid API key format. Expected prefix: ${API_KEY_PREFIX}`, { field: 'apiKey' });
    }
    if (apiKey.length < MIN_API_KEY_LENGTH) {
      throw new ValidationError(`Invalid API key format. Key too short (min ${MIN_API_KEY_LENGTH} chars)`, { field: 'apiKey', minLength: MIN_API_KEY_LENGTH });
    }
    if (!API_KEY_PATTERN.test(apiKey)) {
      throw new ValidationError('Invalid API key format. Key contains invalid characters', { field: 'apiKey' });
    }
  }

  getAuthorizationHeader(): string {
    return `Bearer ${this.apiKey}`;
  }

  canRefresh(): boolean {
    return false;
  }

  async refresh(): Promise<void> {
    throw new Error('API keys cannot be refreshed');
  }

  isAuthenticated(): boolean {
    return true;
  }

  getType(): 'api_key' {
    return 'api_key';
  }
}

/**
 * Shape of the login endpoint response used internally for token extraction
 */
interface LoginApiResponse {
  data?: {
    data?: {
      sessionToken?: string;
      expiresAt?: string;
    };
  };
}

/**
 * JWT session authentication strategy
 */
export class JwtSessionAuth implements AuthStrategy {
  private sessionToken: string | null;
  private expiresAt: Date | null = null;
  private readonly hasLoginCredentials: boolean;

  constructor(
    private readonly httpClient: FetchClient,
    private readonly credentials: { email: string; password: string },
    private readonly onTokenRefresh?: (token: string) => void,
    initialToken?: string
  ) {
    this.sessionToken = initialToken ?? null;
    this.hasLoginCredentials = !!(credentials.email && credentials.password);
  }

  /**
   * Login and get a new session token
   */
  async login(): Promise<string> {
    const response = await this.httpClient.post('/auth/login', {
      email: this.credentials.email,
      password: this.credentials.password,
    });

    const loginData = (response as LoginApiResponse)?.data?.data;

    if (!loginData?.sessionToken) {
      throw new Error('Login response missing sessionToken');
    }

    this.sessionToken = loginData.sessionToken;
    this.expiresAt = loginData.expiresAt ? new Date(loginData.expiresAt) : null;

    this.onTokenRefresh?.(loginData.sessionToken);

    return loginData.sessionToken;
  }

  getAuthorizationHeader(): string {
    if (!this.sessionToken) {
      throw new UnauthorizedError(
        'Session expired or not authenticated. Call client.login(email, password) to obtain a new session.'
      );
    }
    return `Bearer ${this.sessionToken}`;
  }

  canRefresh(): boolean {
    return this.hasLoginCredentials;
  }

  async refresh(): Promise<void> {
    await this.login();
  }

  isAuthenticated(): boolean {
    if (!this.sessionToken) return false;

    if (this.expiresAt && this.expiresAt <= new Date()) {
      this.sessionToken = null;
      return false;
    }

    return true;
  }

  getType(): 'session' {
    return 'session';
  }

  /**
   * Get the current session token (for storage)
   */
  getSessionToken(): string | null {
    return this.sessionToken;
  }

  /**
   * Get the token expiration time
   */
  getExpiresAt(): Date | null {
    return this.expiresAt;
  }

  /**
   * Clear the session (logout)
   */
  clearSession(): void {
    this.sessionToken = null;
    this.expiresAt = null;
  }
}

/**
 * Create an auth strategy from config
 */
export function createAuthStrategy(config: AuthConfig): AuthStrategy {
  // Priority 1: API key
  if (config.apiKey) {
    return new ApiKeyAuth(config.apiKey);
  }

  // Priority 2: Session token (already logged in)
  // Pass email/password through when available so refresh can re-login
  if (config.sessionToken && config.httpClient) {
    return new JwtSessionAuth(
      config.httpClient,
      { email: config.email ?? '', password: config.password ?? '' },
      config.onTokenRefresh,
      config.sessionToken
    );
  }

  // Priority 3: Email/password for session auth
  if (config.email && config.password && config.httpClient) {
    return new JwtSessionAuth(config.httpClient, { email: config.email, password: config.password }, config.onTokenRefresh);
  }

  throw new Error(
    'No valid credentials provided. ' +
    'Set ULUOPS_API_KEY env var, or pass one of: apiKey, sessionToken, or email/password to the constructor. ' +
    'Priority: apiKey > sessionToken > email/password.'
  );
}
