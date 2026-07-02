/**
 * Configuration and credential loading for UluOps SDKs
 *
 * ENV_VARS are not hardcoded — each SDK passes its own env var names
 * via the EnvVarConfig parameter.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { config as loadDotenv } from 'dotenv';
import { CONFIG_PATHS, API_KEY_PREFIX, MIN_API_KEY_LENGTH } from './constants.js';
import { ValidationError } from '../errors/errors.js';
import { createLogger } from '../utils/logger.js';

// Config credential-load anomalies are routed through the SDK logger rather
// than raw console.warn so consumers have a single, structured interception
// surface (level tag + prefix). createLogger's warn/error emit unconditionally
// regardless of the enabled flag, and the debug flag is not yet resolved this
// early in bootstrap, so `enabled: false` is correct here.
const logger = createLogger('[sdk-core:config]', false);


/**
 * Credentials for authentication.
 * Exactly one authentication method should be populated.
 */
export interface Credentials {
  /** API key (e.g. `ulr_...`). Takes highest priority. */
  apiKey?: string;
  /** Email for session-based auth (requires `password`). */
  email?: string;
  /** Password for session-based auth (requires `email`). */
  password?: string;
  /** Pre-existing session token from a prior login. */
  sessionToken?: string;
}

/**
 * Full SDK configuration returned by {@link loadConfig}.
 */
export interface SdkConfig {
  /** Base URL for API requests */
  baseUrl: string;
  /** Separate base URL for auth endpoints (registry delegates to ops API) */
  authBaseUrl?: string;
  /** Resolved credentials from the priority chain */
  credentials: Credentials;
  /** Whether debug logging is enabled */
  debug: boolean;
  /** Request timeout in ms */
  timeout?: number;
  /** Max retry attempts for transient errors */
  retries?: number;
}

/**
 * Environment variable name mapping — each SDK provides its own.
 *
 * @example
 * ```ts
 * const OPS_ENV_VARS: EnvVarConfig = {
 *   apiKey: 'ULUOPS_API_KEY',
 *   email: 'ULUOPS_EMAIL',
 *   password: 'ULUOPS_PASSWORD',
 *   baseUrl: 'ULUOPS_BASE_URL',
 *   debug: 'ULUOPS_DEBUG',
 * };
 * ```
 */
export interface EnvVarConfig {
  /** Env var name for the API key (e.g. `'ULUOPS_API_KEY'`) */
  apiKey: string;
  /** Env var name for the email */
  email: string;
  /** Env var name for the password */
  password: string;
  /** Env var name for a pre-existing session token */
  sessionToken?: string;
  /** Env var name for the base URL */
  baseUrl: string;
  /** Env var name for the auth base URL (registry-sdk only) */
  authBaseUrl?: string;
  /** Env var name for the debug flag */
  debug: string;
}

/**
 * Stored credentials in `~/.uluops/credentials.json`.
 * Supports multiple named profiles with a required `default` profile.
 */
interface StoredCredentials {
  default?: StoredProfile;
  [profile: string]: StoredProfile | undefined;
}

/**
 * A single credential profile stored on disk.
 * Either an API key (`type: 'api_key'`) or a session token (`type: 'session'`).
 */
interface StoredProfile {
  /** Credential type determines which fields are populated */
  type: 'api_key' | 'session';
  /** API key (present when `type` is `'api_key'`) */
  apiKey?: string;
  /** JWT session token (present when `type` is `'session'`) */
  sessionToken?: string;
  /** ISO 8601 expiration timestamp for session tokens */
  expiresAt?: string;
  /** Email associated with the session */
  email?: string;
}

/**
 * Get the global config directory
 */
export function getGlobalConfigDir(): string {
  return join(homedir(), CONFIG_PATHS.GLOBAL_DIR);
}

/**
 * Get path to credentials file
 */
export function getCredentialsPath(): string {
  return join(homedir(), CONFIG_PATHS.CREDENTIALS);
}

/**
 * Load environment variables from .env files
 * Priority: local .env > global ~/.uluops/.env
 */
export function loadEnvFiles(): void {
  const localEnvPath = CONFIG_PATHS.LOCAL_ENV;
  if (existsSync(localEnvPath)) {
    loadDotenv({ path: localEnvPath, override: false, quiet: true });
  }

  const globalEnvPath = join(homedir(), CONFIG_PATHS.GLOBAL_ENV);
  if (existsSync(globalEnvPath)) {
    loadDotenv({ path: globalEnvPath, override: false, quiet: true });
  }
}

/**
 * Load stored credentials from credentials.json
 */
export function loadStoredCredentials(profile = 'default'): Partial<Credentials> | null {
  const credPath = getCredentialsPath();

  if (!existsSync(credPath)) {
    return null;
  }

  try {
    // Check file permissions on Unix-like systems — warn if world-readable
    if (platform() !== 'win32') {
      try {
        const stat = statSync(credPath);
        const mode = stat.mode & 0o777;
        if (mode & 0o044) {
          logger.warn(
            `credentials file is readable by other users (mode ${mode.toString(8)}). ` +
            'Run: chmod 600 ~/.uluops/credentials.json'
          );
        }
      } catch {
        // stat failed — proceed with read attempt
      }
    }

    const content = readFileSync(credPath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const stored = parsed as StoredCredentials;
    const profileCreds = stored[profile];

    if (!profileCreds) {
      return null;
    }

    // Check if session token is expired.
    // Malformed expiresAt strings produce Invalid Date (NaN). `NaN <= date` is
    // false in JS, so the naive `expiresAt <= now` check would accept any
    // garbage as never-expires. Treat NaN as expired and warn so the corruption
    // is visible — the caller falls back to re-authentication, which is the
    // safe outcome.
    if (profileCreds.type === 'session' && profileCreds.expiresAt) {
      const expiresAt = new Date(profileCreds.expiresAt);
      if (isNaN(expiresAt.getTime())) {
        logger.warn(
          'credentials.json has malformed expiresAt — treating session as expired. ' +
          'Re-authenticate to refresh.'
        );
        return null;
      }
      if (expiresAt <= new Date()) {
        return null;
      }
    }

    // Validate field types before returning
    const result: Partial<Credentials> = {};
    if (profileCreds.apiKey !== undefined) {
      if (typeof profileCreds.apiKey !== 'string' || !profileCreds.apiKey.startsWith(API_KEY_PREFIX)) {
        logger.warn('credentials.json contains invalid apiKey format, ignoring');
      } else {
        result.apiKey = profileCreds.apiKey;
      }
    }
    if (profileCreds.sessionToken !== undefined) {
      if (typeof profileCreds.sessionToken !== 'string' || profileCreds.sessionToken.length === 0) {
        logger.warn('credentials.json contains invalid sessionToken, ignoring');
      } else {
        result.sessionToken = profileCreds.sessionToken;
      }
    }
    if (profileCreds.email !== undefined) {
      if (typeof profileCreds.email !== 'string' || profileCreds.email.length === 0) {
        logger.warn('credentials.json contains invalid email, ignoring');
      } else {
        result.email = profileCreds.email;
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch (error) {
    // Credentials file exists but can't be parsed — warn the user so they know
    // their config is corrupt, then fall through to other credential sources.
    // Avoid leaking file path or parse error details (could contain file content).
    const reason = error instanceof Error ? error.constructor.name : 'unknown error';
    logger.warn(
      `could not read credentials file (${reason}). ` +
      'Check ~/.uluops/credentials.json is valid JSON. Falling back to environment variables.'
    );
    return null;
  }
}

/**
 * Load credentials with priority chain
 * Priority: explicit params > env vars > stored credentials
 */
export function loadCredentials(options: {
  apiKey?: string;
  email?: string;
  password?: string;
  sessionToken?: string;
  profile?: string;
  envVars?: EnvVarConfig;
} = {}): Credentials {
  loadEnvFiles();

  // Priority 1: Explicit parameters
  if (options.apiKey) {
    return { apiKey: options.apiKey };
  }

  if (options.email && options.password) {
    return { email: options.email, password: options.password };
  }

  if (options.sessionToken) {
    return { sessionToken: options.sessionToken };
  }

  // Priority 2: Environment variables (if envVars mapping provided)
  if (options.envVars) {
    const envApiKey = process.env[options.envVars.apiKey];
    if (envApiKey) {
      return { apiKey: envApiKey };
    }

    const envEmail = process.env[options.envVars.email];
    const envPassword = process.env[options.envVars.password];
    if (envEmail && envPassword) {
      return { email: envEmail, password: envPassword };
    }

    if (options.envVars.sessionToken) {
      const envSessionToken = process.env[options.envVars.sessionToken];
      if (envSessionToken) {
        return { sessionToken: envSessionToken };
      }
    }
  }

  // Priority 3: Stored credentials
  const stored = loadStoredCredentials(options.profile);
  if (stored?.apiKey) {
    return { apiKey: stored.apiKey };
  }
  if (stored?.sessionToken) {
    return { sessionToken: stored.sessionToken, email: stored.email };
  }

  // No credentials found
  return {};
}

/**
 * Load full SDK configuration
 */
export function loadConfig(options: {
  apiKey?: string;
  email?: string;
  password?: string;
  sessionToken?: string;
  baseUrl?: string;
  authBaseUrl?: string;
  profile?: string;
  debug?: boolean;
  timeout?: number;
  retries?: number;
  envVars?: EnvVarConfig;
  defaults?: {
    baseUrl?: string;
    authBaseUrl?: string;
  };
} = {}): SdkConfig {
  // Note: loadEnvFiles() is called inside loadCredentials() below,
  // so we don't need to call it here.

  const envVars = options.envVars;

  // Determine base URL
  const baseUrl = options.baseUrl
    ?? (envVars ? process.env[envVars.baseUrl] : undefined)
    ?? options.defaults?.baseUrl;

  if (!baseUrl) {
    throw new Error(
      'No base URL configured. Provide baseUrl via options, environment variable, or defaults.'
    );
  }

  // Determine auth base URL
  const authBaseUrl = options.authBaseUrl
    ?? (envVars?.authBaseUrl ? process.env[envVars.authBaseUrl] : undefined)
    ?? options.defaults?.authBaseUrl;

  // Determine debug mode
  const debug = options.debug ?? (envVars ? process.env[envVars.debug] === 'true' : false);

  // Load credentials
  const credentials = loadCredentials({
    apiKey: options.apiKey,
    email: options.email,
    password: options.password,
    sessionToken: options.sessionToken,
    profile: options.profile,
    envVars,
  });

  return {
    baseUrl,
    authBaseUrl,
    credentials,
    debug,
    timeout: options.timeout,
    retries: options.retries,
  };
}

/**
 * Check if credentials look like an API key.
 *
 * Matches the `ApiKeyAuth` constructor's accept criteria (prefix + minimum
 * length) so a value that passes this pre-flight check will not be rejected
 * by the constructor as too short.
 */
export function isApiKey(value: string): boolean {
  return value.startsWith(API_KEY_PREFIX) && value.length >= MIN_API_KEY_LENGTH;
}

/**
 * Validate that required credentials are present
 */
export function validateCredentials(credentials: Credentials): void {
  const hasApiKey = !!credentials.apiKey;
  const hasSession = !!credentials.sessionToken;
  const hasPassword = !!credentials.email && !!credentials.password;

  if (!hasApiKey && !hasSession && !hasPassword) {
    throw new ValidationError(
      'No credentials found. Set ULUOPS_API_KEY environment variable, ' +
        'provide apiKey in constructor, or use email/password.',
      { field: 'credentials' }
    );
  }
}
