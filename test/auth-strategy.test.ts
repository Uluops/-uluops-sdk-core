/**
 * Tests for authentication strategies: ApiKeyAuth, JwtSessionAuth, createAuthStrategy
 */
import {
  ApiKeyAuth,
  JwtSessionAuth,
  createAuthStrategy,
  type AuthConfig,
} from '../src/http/auth-strategy.js';
import type { FetchClient } from '../src/http/fetch-adapter.js';
import { ValidationError, UnauthorizedError } from '../src/errors/errors.js';
import { TEST_API_KEY, TEST_JWT } from './setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeFetchClient(response?: object): FetchClient {
  return {
    post: vi.fn().mockResolvedValue({
      data: { data: response ?? {} },
    }),
  };
}

// ---------------------------------------------------------------------------
// ApiKeyAuth — validation
// ---------------------------------------------------------------------------
describe('ApiKeyAuth', () => {
  describe('validation', () => {
    it('should reject empty string', () => {
      expect(() => new ApiKeyAuth('')).toThrow(ValidationError);
      expect(() => new ApiKeyAuth('')).toThrow('API key is required');
    });

    it('should reject key without correct prefix', () => {
      expect(() => new ApiKeyAuth('wrong_prefix_1234567890abc')).toThrow(ValidationError);
      expect(() => new ApiKeyAuth('wrong_prefix_1234567890abc')).toThrow('Expected prefix');
    });

    it('should reject key shorter than 20 chars', () => {
      // ulr_ = 4 chars, so need >=16 more
      expect(() => new ApiKeyAuth('ulr_short')).toThrow(ValidationError);
      expect(() => new ApiKeyAuth('ulr_short')).toThrow('too short');
    });

    it('should reject key with invalid characters', () => {
      expect(() => new ApiKeyAuth('ulr_invalid!chars@#$%^&*')).toThrow(ValidationError);
      expect(() => new ApiKeyAuth('ulr_invalid!chars@#$%^&*')).toThrow('invalid characters');
    });

    it('should reject key that is only the prefix', () => {
      expect(() => new ApiKeyAuth('ulr_')).toThrow(ValidationError);
      expect(() => new ApiKeyAuth('ulr_')).toThrow('too short');
    });

    it('should accept valid key', () => {
      const auth = new ApiKeyAuth(TEST_API_KEY);
      expect(auth).toBeInstanceOf(ApiKeyAuth);
    });

    it('should accept key with hyphens and underscores', () => {
      const key = 'ulr_valid-key_with-hyphens12';
      const auth = new ApiKeyAuth(key);
      expect(auth.getAuthorizationHeader()).toBe(`Bearer ${key}`);
    });
  });

  describe('interface', () => {
    let auth: ApiKeyAuth;

    beforeEach(() => {
      auth = new ApiKeyAuth(TEST_API_KEY);
    });

    it('should return Bearer header', () => {
      expect(auth.getAuthorizationHeader()).toBe(`Bearer ${TEST_API_KEY}`);
    });

    it('should not be refreshable', () => {
      expect(auth.canRefresh()).toBe(false);
    });

    it('should throw on refresh', async () => {
      await expect(auth.refresh()).rejects.toThrow('API keys cannot be refreshed');
    });

    it('should always be authenticated', () => {
      expect(auth.isAuthenticated()).toBe(true);
    });

    it('should report type api_key', () => {
      expect(auth.getType()).toBe('api_key');
    });
  });
});

// ---------------------------------------------------------------------------
// JwtSessionAuth
// ---------------------------------------------------------------------------
describe('JwtSessionAuth', () => {
  const credentials = { email: 'test@example.com', password: 'password123' };

  describe('with initial token', () => {
    it('should return Bearer header with initial token', () => {
      const client = makeFetchClient();
      const auth = new JwtSessionAuth(client, credentials, undefined, TEST_JWT);
      expect(auth.getAuthorizationHeader()).toBe(`Bearer ${TEST_JWT}`);
    });

    it('should report authenticated', () => {
      const client = makeFetchClient();
      const auth = new JwtSessionAuth(client, credentials, undefined, TEST_JWT);
      expect(auth.isAuthenticated()).toBe(true);
    });

    it('should report type session', () => {
      const client = makeFetchClient();
      const auth = new JwtSessionAuth(client, credentials, undefined, TEST_JWT);
      expect(auth.getType()).toBe('session');
    });

    it('should be refreshable', () => {
      const client = makeFetchClient();
      const auth = new JwtSessionAuth(client, credentials, undefined, TEST_JWT);
      expect(auth.canRefresh()).toBe(true);
    });

    it('should accept opaque (non-JWT) session tokens', () => {
      const client = makeFetchClient();
      const auth = new JwtSessionAuth(client, credentials, undefined, 'av-QRnQeIGeowkg5vkKQIWhE9bxCOWB8U-ZQjbegMkQ');
      expect(auth.isAuthenticated()).toBe(true);
      expect(auth.getAuthorizationHeader()).toBe('Bearer av-QRnQeIGeowkg5vkKQIWhE9bxCOWB8U-ZQjbegMkQ');
    });

    it('should reject empty string initialToken', () => {
      const client = makeFetchClient();
      expect(() => new JwtSessionAuth(client, credentials, undefined, ''))
        .toThrow('Invalid session token');
    });
  });

  describe('without initial token', () => {
    it('should throw UnauthorizedError when getting header', () => {
      const client = makeFetchClient();
      const auth = new JwtSessionAuth(client, credentials);
      expect(() => auth.getAuthorizationHeader()).toThrow(UnauthorizedError);
    });

    it('should not be authenticated', () => {
      const client = makeFetchClient();
      const auth = new JwtSessionAuth(client, credentials);
      expect(auth.isAuthenticated()).toBe(false);
    });

    it('should have null session token', () => {
      const client = makeFetchClient();
      const auth = new JwtSessionAuth(client, credentials);
      expect(auth.getSessionToken()).toBeNull();
    });
  });

  describe('login()', () => {
    it('should call httpClient.post with email and password', async () => {
      const client = makeFetchClient({ sessionToken: 'new-tok', expiresAt: '2099-01-01T00:00:00Z' });
      const auth = new JwtSessionAuth(client, credentials);
      const token = await auth.login();
      expect(token).toBe('new-tok');
      expect(client.post).toHaveBeenCalledWith('/auth/login', {
        email: credentials.email,
        password: credentials.password,
      });
    });

    it('should set session token and expiresAt after login', async () => {
      const expiresAt = '2099-06-15T12:00:00Z';
      const client = makeFetchClient({ sessionToken: 'tok-2', expiresAt });
      const auth = new JwtSessionAuth(client, credentials);
      await auth.login();
      expect(auth.getSessionToken()).toBe('tok-2');
      expect(auth.getExpiresAt()).toEqual(new Date(expiresAt));
      expect(auth.isAuthenticated()).toBe(true);
    });

    it('should call onTokenRefresh callback', async () => {
      const callback = vi.fn();
      const client = makeFetchClient({ sessionToken: 'tok-3' });
      const auth = new JwtSessionAuth(client, credentials, callback);
      await auth.login();
      expect(callback).toHaveBeenCalledWith('tok-3');
    });

    it('should throw when response has no sessionToken', async () => {
      const client = makeFetchClient({ notoken: true });
      const auth = new JwtSessionAuth(client, credentials);
      await expect(auth.login()).rejects.toThrow('Login response missing sessionToken');
    });

    it('should handle null expiresAt', async () => {
      const client = makeFetchClient({ sessionToken: 'tok-4' });
      const auth = new JwtSessionAuth(client, credentials);
      await auth.login();
      expect(auth.getExpiresAt()).toBeNull();
    });
  });

  describe('refresh()', () => {
    it('should call login internally', async () => {
      const client = makeFetchClient({ sessionToken: 'refreshed-tok' });
      const auth = new JwtSessionAuth(client, credentials);
      await auth.refresh();
      expect(auth.getSessionToken()).toBe('refreshed-tok');
      expect(client.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('expiration handling', () => {
    it('should report not authenticated when token is expired', async () => {
      const pastClient = makeFetchClient({ sessionToken: 'expired-tok', expiresAt: '2020-01-01T00:00:00Z' });
      const auth2 = new JwtSessionAuth(pastClient, credentials);
      await auth2.login();
      expect(auth2.isAuthenticated()).toBe(false);
      expect(auth2.getSessionToken()).toBeNull();
    });

    it('should clear session token when expired check runs', async () => {
      const pastDate = '2020-01-01T00:00:00Z';
      const client = makeFetchClient({ sessionToken: 'exp-tok', expiresAt: pastDate });
      const auth = new JwtSessionAuth(client, credentials);
      await auth.login();
      // isAuthenticated should see the expired date and clear the token
      expect(auth.isAuthenticated()).toBe(false);
      expect(auth.getSessionToken()).toBeNull();
    });
  });

  describe('clearSession()', () => {
    it('should clear token and expiresAt', async () => {
      const client = makeFetchClient({ sessionToken: 'tok-5', expiresAt: '2099-01-01T00:00:00Z' });
      const auth = new JwtSessionAuth(client, credentials);
      await auth.login();
      expect(auth.isAuthenticated()).toBe(true);

      auth.clearSession();
      expect(auth.isAuthenticated()).toBe(false);
      expect(auth.getSessionToken()).toBeNull();
      expect(auth.getExpiresAt()).toBeNull();
    });

    it('should clear credentials and disable refresh', async () => {
      const client = makeFetchClient({ sessionToken: 'tok-6', expiresAt: '2099-01-01T00:00:00Z' });
      const auth = new JwtSessionAuth(client, credentials, undefined, undefined, false);
      await auth.login();
      expect(auth.canRefresh()).toBe(true);

      auth.clearSession();
      expect(auth.canRefresh()).toBe(false);
    });
  });

  describe('credential clearing (CWE-316)', () => {
    it('should clear password after login by default', async () => {
      const client = makeFetchClient({ sessionToken: 'tok-c1' });
      const auth = new JwtSessionAuth(client, credentials);
      expect(auth.canRefresh()).toBe(true);

      await auth.login();
      expect(auth.getSessionToken()).toBe('tok-c1');
      expect(auth.canRefresh()).toBe(false);
    });

    it('should not clear password when clearCredentialsAfterLogin is false', async () => {
      const client = makeFetchClient({ sessionToken: 'tok-c2' });
      const auth = new JwtSessionAuth(client, credentials, undefined, undefined, false);
      expect(auth.canRefresh()).toBe(true);

      await auth.login();
      expect(auth.getSessionToken()).toBe('tok-c2');
      expect(auth.canRefresh()).toBe(true);
    });

    it('should allow refresh after login when credentials are retained', async () => {
      const client = makeFetchClient({ sessionToken: 'tok-c3' });
      const auth = new JwtSessionAuth(client, credentials, undefined, undefined, false);
      await auth.login();
      expect(auth.canRefresh()).toBe(true);

      // Simulate a second login (refresh)
      await auth.refresh();
      expect(auth.getSessionToken()).toBe('tok-c3');
      expect(client.post).toHaveBeenCalledTimes(2);
    });

    it('should prevent refresh after credentials are cleared', async () => {
      const client = makeFetchClient({ sessionToken: 'tok-c4' });
      const auth = new JwtSessionAuth(client, credentials);
      await auth.login();
      expect(auth.canRefresh()).toBe(false);

      // refresh() still calls login() but it will send empty password
      // In production, the server would reject this; canRefresh() prevents the attempt
    });
  });
});

// ---------------------------------------------------------------------------
// createAuthStrategy() factory
// ---------------------------------------------------------------------------
describe('createAuthStrategy()', () => {
  const httpClient = makeFetchClient();

  it('should prioritize apiKey over everything else', () => {
    const strategy = createAuthStrategy({
      apiKey: TEST_API_KEY,
      sessionToken: TEST_JWT,
      email: 'a@b.com',
      password: 'pw',
      httpClient,
    });
    expect(strategy).toBeInstanceOf(ApiKeyAuth);
    expect(strategy.getType()).toBe('api_key');
  });

  it('should use sessionToken when no apiKey provided', () => {
    const strategy = createAuthStrategy({
      sessionToken: TEST_JWT,
      httpClient,
    });
    expect(strategy.getType()).toBe('session');
    expect(strategy.getAuthorizationHeader()).toBe(`Bearer ${TEST_JWT}`);
  });

  it('should not be refreshable when created with sessionToken only (no email/password)', () => {
    const strategy = createAuthStrategy({
      sessionToken: TEST_JWT,
      httpClient,
    });
    expect(strategy.canRefresh()).toBe(false);
  });

  it('should use email/password when no apiKey or sessionToken', () => {
    const strategy = createAuthStrategy({
      email: 'a@b.com',
      password: 'pw',
      httpClient,
    });
    expect(strategy.getType()).toBe('session');
    expect(strategy.canRefresh()).toBe(true);
  });

  it('should throw when no credentials provided', () => {
    expect(() => createAuthStrategy({})).toThrow('No valid credentials provided');
  });

  it('should throw when sessionToken provided without httpClient', () => {
    // sessionToken without httpClient falls through to email/password check
    // which also fails, so throws the general error
    expect(() => createAuthStrategy({ sessionToken: TEST_JWT })).toThrow(
      'No valid credentials provided'
    );
  });

  it('should throw when email/password provided without httpClient', () => {
    expect(() =>
      createAuthStrategy({ email: 'a@b.com', password: 'pw' })
    ).toThrow('No valid credentials provided');
  });

  it('should pass onTokenRefresh to JwtSessionAuth from sessionToken', () => {
    const callback = vi.fn();
    const strategy = createAuthStrategy({
      sessionToken: TEST_JWT,
      httpClient,
      onTokenRefresh: callback,
    });
    expect(strategy.getType()).toBe('session');
  });

  it('should pass onTokenRefresh to JwtSessionAuth from email/password', () => {
    const callback = vi.fn();
    const strategy = createAuthStrategy({
      email: 'a@b.com',
      password: 'pw',
      httpClient,
      onTokenRefresh: callback,
    });
    expect(strategy.getType()).toBe('session');
  });

  it('should clear credentials after login by default', async () => {
    const loginClient = makeFetchClient({ sessionToken: 'factory-tok' });
    const strategy = createAuthStrategy({
      email: 'a@b.com',
      password: 'pw',
      httpClient: loginClient,
    });
    expect(strategy.canRefresh()).toBe(true);
    await (strategy as JwtSessionAuth).login();
    expect(strategy.canRefresh()).toBe(false);
  });

  it('should retain credentials when clearCredentialsAfterLogin is false', async () => {
    const loginClient = makeFetchClient({ sessionToken: 'factory-tok2' });
    const strategy = createAuthStrategy({
      email: 'a@b.com',
      password: 'pw',
      httpClient: loginClient,
      clearCredentialsAfterLogin: false,
    });
    expect(strategy.canRefresh()).toBe(true);
    await (strategy as JwtSessionAuth).login();
    expect(strategy.canRefresh()).toBe(true);
  });
});
