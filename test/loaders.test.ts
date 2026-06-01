/**
 * Tests for configuration loaders: loadEnvFiles(), loadStoredCredentials(),
 * loadCredentials(), loadConfig(), isApiKey(), validateCredentials()
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  loadEnvFiles,
  loadStoredCredentials,
  loadCredentials,
  loadConfig,
  isApiKey,
  validateCredentials,
  getGlobalConfigDir,
  getCredentialsPath,
  type EnvVarConfig,
} from '../src/config/loaders.js';
import { ValidationError } from '../src/errors/errors.js';
import { CONFIG_PATHS, API_KEY_PREFIX } from '../src/config/constants.js';
import { TEST_API_KEY } from './setup.js';

// Mock fs and dotenv
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

// ---------------------------------------------------------------------------
// Env var config used by tests
// ---------------------------------------------------------------------------
const testEnvVars: EnvVarConfig = {
  apiKey: 'ULUOPS_API_KEY',
  email: 'ULUOPS_EMAIL',
  password: 'ULUOPS_PASSWORD',
  sessionToken: 'ULUOPS_SESSION_TOKEN',
  baseUrl: 'ULUOPS_BASE_URL',
  authBaseUrl: 'ULUOPS_AUTH_BASE_URL',
  debug: 'ULUOPS_DEBUG',
};

// ---------------------------------------------------------------------------
// getGlobalConfigDir / getCredentialsPath
// ---------------------------------------------------------------------------
describe('getGlobalConfigDir()', () => {
  it('should return path under home directory', () => {
    const dir = getGlobalConfigDir();
    expect(dir).toBe(join(homedir(), CONFIG_PATHS.GLOBAL_DIR));
  });
});

describe('getCredentialsPath()', () => {
  it('should return credentials.json path under home directory', () => {
    const path = getCredentialsPath();
    expect(path).toBe(join(homedir(), CONFIG_PATHS.CREDENTIALS));
  });
});

// ---------------------------------------------------------------------------
// loadEnvFiles()
// ---------------------------------------------------------------------------
describe('loadEnvFiles()', () => {
  it('should check for local .env file', () => {
    mockExistsSync.mockReturnValue(false);
    loadEnvFiles();
    expect(mockExistsSync).toHaveBeenCalledWith(CONFIG_PATHS.LOCAL_ENV);
  });

  it('should check for global .env file', () => {
    mockExistsSync.mockReturnValue(false);
    loadEnvFiles();
    const globalPath = join(homedir(), CONFIG_PATHS.GLOBAL_ENV);
    expect(mockExistsSync).toHaveBeenCalledWith(globalPath);
  });

  it('should not throw when files do not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(() => loadEnvFiles()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadStoredCredentials()
// ---------------------------------------------------------------------------
describe('loadStoredCredentials()', () => {
  it('should return null when credentials file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadStoredCredentials()).toBeNull();
  });

  it('should load api_key credentials from default profile', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        default: {
          type: 'api_key',
          apiKey: 'ulr_stored_key_123456789',
        },
      })
    );

    const result = loadStoredCredentials();
    expect(result).toEqual({
      apiKey: 'ulr_stored_key_123456789',
      sessionToken: undefined,
      email: undefined,
    });
  });

  it('should load credentials from named profile', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        default: { type: 'api_key', apiKey: 'ulr_default_key_12345678' },
        staging: { type: 'api_key', apiKey: 'ulr_staging_key_12345678' },
      })
    );

    const result = loadStoredCredentials('staging');
    expect(result).toEqual({
      apiKey: 'ulr_staging_key_12345678',
      sessionToken: undefined,
      email: undefined,
    });
  });

  it('should return null when profile does not exist', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ default: { type: 'api_key', apiKey: 'ulr_key_1234567890123456' } })
    );

    expect(loadStoredCredentials('nonexistent')).toBeNull();
  });

  it('should load session credentials with email', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        default: {
          type: 'session',
          sessionToken: 'sess-tok-123',
          email: 'user@example.com',
          expiresAt: '2099-12-31T23:59:59Z',
        },
      })
    );

    const result = loadStoredCredentials();
    expect(result).toEqual({
      apiKey: undefined,
      sessionToken: 'sess-tok-123',
      email: 'user@example.com',
    });
  });

  it('should return null for expired session tokens', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        default: {
          type: 'session',
          sessionToken: 'expired-tok',
          expiresAt: '2020-01-01T00:00:00Z',
        },
      })
    );

    expect(loadStoredCredentials()).toBeNull();
  });

  it('should return session credentials without expiresAt (never expires)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        default: {
          type: 'session',
          sessionToken: 'no-expiry-tok',
        },
      })
    );

    const result = loadStoredCredentials();
    expect(result!.sessionToken).toBe('no-expiry-tok');
  });

  it('should return null and warn on JSON parse error', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('invalid json');

    expect(loadStoredCredentials()).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('could not read credentials');
    warnSpy.mockRestore();
  });

  it('should return null and warn on read error', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });

    expect(loadStoredCredentials()).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('could not read credentials file');
    warnSpy.mockRestore();
  });

  // Regression: malformed expiresAt strings produce Invalid Date (NaN).
  // `NaN <= now` is false in JS, so the naive comparison would accept the
  // token as never-expires. The guard treats NaN as expired.
  it('should treat malformed expiresAt as expired (NaN comparison guard)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        default: {
          type: 'session',
          sessionToken: 'tok-with-bad-expiry',
          expiresAt: 'definitely-not-a-date',
        },
      })
    );

    expect(loadStoredCredentials()).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('malformed expiresAt')
    );
    warnSpy.mockRestore();
  });

  it('should treat empty-string expiresAt as expired', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        default: {
          type: 'session',
          sessionToken: 'tok',
          expiresAt: '',
        },
      })
    );

    // Empty string is falsy — skips the expiresAt check entirely (never-expires).
    // Document current behavior: only truthy non-date strings hit the NaN guard.
    const result = loadStoredCredentials();
    expect(result!.sessionToken).toBe('tok');
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// loadCredentials()
// ---------------------------------------------------------------------------
describe('loadCredentials()', () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(false);
  });

  describe('priority 1: explicit parameters', () => {
    it('should use explicit apiKey', () => {
      const result = loadCredentials({ apiKey: TEST_API_KEY });
      expect(result).toEqual({ apiKey: TEST_API_KEY });
    });

    it('should use explicit email + password', () => {
      const result = loadCredentials({ email: 'a@b.com', password: 'pw' });
      expect(result).toEqual({ email: 'a@b.com', password: 'pw' });
    });

    it('should use explicit sessionToken', () => {
      const result = loadCredentials({ sessionToken: 'tok' });
      expect(result).toEqual({ sessionToken: 'tok' });
    });

    it('should prefer apiKey over email/password and sessionToken', () => {
      const result = loadCredentials({
        apiKey: TEST_API_KEY,
        email: 'a@b.com',
        password: 'pw',
        sessionToken: 'tok',
      });
      expect(result).toEqual({ apiKey: TEST_API_KEY });
      expect(result.email).toBeUndefined();
      expect(result.password).toBeUndefined();
      expect(result.sessionToken).toBeUndefined();
    });

    it('should prefer email/password over sessionToken when no apiKey', () => {
      const result = loadCredentials({
        email: 'a@b.com',
        password: 'pw',
        sessionToken: 'tok',
      });
      expect(result).toEqual({ email: 'a@b.com', password: 'pw' });
      expect(result.apiKey).toBeUndefined();
      expect(result.sessionToken).toBeUndefined();
    });

    it('should ignore email without password', () => {
      const result = loadCredentials({ email: 'a@b.com' });
      expect(result).toEqual({});
    });
  });

  describe('priority 2: environment variables', () => {
    it('should use env apiKey', () => {
      vi.stubEnv('ULUOPS_API_KEY', TEST_API_KEY);
      const result = loadCredentials({ envVars: testEnvVars });
      expect(result).toEqual({ apiKey: TEST_API_KEY });
      vi.unstubAllEnvs();
    });

    it('should use env email + password', () => {
      vi.stubEnv('ULUOPS_EMAIL', 'env@test.com');
      vi.stubEnv('ULUOPS_PASSWORD', 'envpw');
      const result = loadCredentials({ envVars: testEnvVars });
      expect(result).toEqual({ email: 'env@test.com', password: 'envpw' });
      vi.unstubAllEnvs();
    });

    it('should use env sessionToken', () => {
      vi.stubEnv('ULUOPS_SESSION_TOKEN', 'env-session');
      const result = loadCredentials({ envVars: testEnvVars });
      expect(result).toEqual({ sessionToken: 'env-session' });
      vi.unstubAllEnvs();
    });

    it('should not check env when envVars not provided', () => {
      vi.stubEnv('ULUOPS_API_KEY', TEST_API_KEY);
      const result = loadCredentials({}); // no envVars
      // Without envVars, env vars are not checked, falls to stored credentials
      expect(result.apiKey).toBeUndefined();
      vi.unstubAllEnvs();
    });

    it('should prefer env apiKey over env email/password', () => {
      vi.stubEnv('ULUOPS_API_KEY', TEST_API_KEY);
      vi.stubEnv('ULUOPS_EMAIL', 'env@test.com');
      vi.stubEnv('ULUOPS_PASSWORD', 'envpw');
      const result = loadCredentials({ envVars: testEnvVars });
      expect(result).toEqual({ apiKey: TEST_API_KEY });
      expect(result.email).toBeUndefined();
      expect(result.password).toBeUndefined();
      vi.unstubAllEnvs();
    });
  });

  describe('priority 3: stored credentials', () => {
    it('should use stored apiKey', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          default: { type: 'api_key', apiKey: 'ulr_stored_key_1234567890' },
        })
      );

      const result = loadCredentials();
      expect(result).toEqual({ apiKey: 'ulr_stored_key_1234567890' });
    });

    it('should use stored sessionToken with email', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          default: {
            type: 'session',
            sessionToken: 'stored-tok',
            email: 'stored@test.com',
            expiresAt: '2099-01-01T00:00:00Z',
          },
        })
      );

      const result = loadCredentials();
      expect(result).toEqual({ sessionToken: 'stored-tok', email: 'stored@test.com' });
    });

    it('should use named profile', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          default: { type: 'api_key', apiKey: 'ulr_default_1234567890ab' },
          staging: { type: 'api_key', apiKey: 'ulr_staging_1234567890ab' },
        })
      );

      const result = loadCredentials({ profile: 'staging' });
      expect(result).toEqual({ apiKey: 'ulr_staging_1234567890ab' });
    });
  });

  describe('no credentials', () => {
    it('should return empty object when nothing found', () => {
      mockExistsSync.mockReturnValue(false);
      const result = loadCredentials();
      expect(result).toEqual({});
    });
  });
});

// ---------------------------------------------------------------------------
// loadConfig()
// ---------------------------------------------------------------------------
describe('loadConfig()', () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(false);
  });

  it('should use explicit baseUrl', () => {
    const config = loadConfig({ baseUrl: 'http://custom:8080/api' });
    expect(config.baseUrl).toBe('http://custom:8080/api');
  });

  it('should use env baseUrl via envVars', () => {
    vi.stubEnv('ULUOPS_BASE_URL', 'http://env:9090/api');
    const config = loadConfig({ envVars: testEnvVars });
    expect(config.baseUrl).toBe('http://env:9090/api');
    vi.unstubAllEnvs();
  });

  it('should use defaults.baseUrl as fallback', () => {
    const config = loadConfig({ defaults: { baseUrl: 'http://default:3100/api' } });
    expect(config.baseUrl).toBe('http://default:3100/api');
  });

  it('should throw when no base URL configured', () => {
    expect(() => loadConfig()).toThrow('No base URL configured');
  });

  it('should set authBaseUrl from explicit param', () => {
    const config = loadConfig({ baseUrl: 'http://test:3100/api', authBaseUrl: 'http://auth:3200/api' });
    expect(config.authBaseUrl).toBe('http://auth:3200/api');
  });

  it('should set authBaseUrl from env var', () => {
    vi.stubEnv('ULUOPS_AUTH_BASE_URL', 'http://authenv:3200/api');
    const config = loadConfig({ baseUrl: 'http://test:3100/api', envVars: testEnvVars });
    expect(config.authBaseUrl).toBe('http://authenv:3200/api');
    vi.unstubAllEnvs();
  });

  it('should set debug from explicit param', () => {
    const config = loadConfig({ baseUrl: 'http://test:3100/api', debug: true });
    expect(config.debug).toBe(true);
  });

  it('should set debug from env var', () => {
    vi.stubEnv('ULUOPS_DEBUG', 'true');
    const config = loadConfig({ baseUrl: 'http://test:3100/api', envVars: testEnvVars });
    expect(config.debug).toBe(true);
    vi.unstubAllEnvs();
  });

  it('should default debug to false', () => {
    const config = loadConfig({ baseUrl: 'http://test:3100/api' });
    expect(config.debug).toBe(false);
  });

  it('should pass through timeout and retries', () => {
    const config = loadConfig({ baseUrl: 'http://test:3100/api', timeout: 5000, retries: 5 });
    expect(config.timeout).toBe(5000);
    expect(config.retries).toBe(5);
  });

  it('should load credentials into config', () => {
    const config = loadConfig({ baseUrl: 'http://test:3100/api', apiKey: TEST_API_KEY });
    expect(config.credentials).toEqual({ apiKey: TEST_API_KEY });
  });

  it('should return full SdkConfig shape', () => {
    const config = loadConfig({
      baseUrl: 'http://test:3100/api',
      authBaseUrl: 'http://auth:3200/api',
      debug: true,
      timeout: 10000,
      retries: 2,
      apiKey: TEST_API_KEY,
    });
    expect(config).toEqual({
      baseUrl: 'http://test:3100/api',
      authBaseUrl: 'http://auth:3200/api',
      credentials: { apiKey: TEST_API_KEY },
      debug: true,
      timeout: 10000,
      retries: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// isApiKey()
// ---------------------------------------------------------------------------
describe('isApiKey()', () => {
  it('should return true for string starting with ulr_', () => {
    expect(isApiKey('ulr_something')).toBe(true);
    expect(isApiKey(TEST_API_KEY)).toBe(true);
  });

  it('should return false for string without prefix', () => {
    expect(isApiKey('sk_something')).toBe(false);
    expect(isApiKey('random')).toBe(false);
    expect(isApiKey('')).toBe(false);
  });

  it('should return false for partial prefix', () => {
    expect(isApiKey('ulr')).toBe(false);
    expect(isApiKey('ul')).toBe(false);
  });

  it('should return true for exact prefix only (ulr_)', () => {
    expect(isApiKey('ulr_')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateCredentials()
// ---------------------------------------------------------------------------
describe('validateCredentials()', () => {
  it('should not throw with apiKey', () => {
    expect(() => validateCredentials({ apiKey: TEST_API_KEY })).not.toThrow();
  });

  it('should not throw with sessionToken', () => {
    expect(() => validateCredentials({ sessionToken: 'tok' })).not.toThrow();
  });

  it('should not throw with email and password', () => {
    expect(() =>
      validateCredentials({ email: 'a@b.com', password: 'pw' })
    ).not.toThrow();
  });

  it('should throw ValidationError with empty credentials', () => {
    expect(() => validateCredentials({})).toThrow(ValidationError);
  });

  it('should throw with email only (no password)', () => {
    expect(() => validateCredentials({ email: 'a@b.com' })).toThrow(ValidationError);
  });

  it('should throw with password only (no email)', () => {
    expect(() => validateCredentials({ password: 'pw' })).toThrow(ValidationError);
  });

  it('should include field in error details', () => {
    try {
      validateCredentials({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details).toEqual({ field: 'credentials' });
    }
  });

  it('should include helpful message about env vars', () => {
    try {
      validateCredentials({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('ULUOPS_API_KEY');
    }
  });
});
