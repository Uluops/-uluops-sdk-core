/**
 * Configuration and credential loading for UluOps SDKs
 *
 * ENV_VARS are not hardcoded — each SDK passes its own env var names
 * via the EnvVarConfig parameter.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { config as loadDotenv } from 'dotenv';
import { CONFIG_PATHS, API_KEY_PREFIX } from './constants.js';
import { ValidationError } from '../errors/errors.js';
import { createLogger } from '../utils/logger.js';

/**
 * Credentials for authentication
 */
export interface Credentials {
  apiKey?: string;
  email?: string;
  password?: string;
  sessionToken?: string;
}

/**
 * Full SDK configuration
 */
export interface SdkConfig {
  baseUrl: string;
  authBaseUrl?: string;
  credentials: Credentials;
  debug: boolean;
  timeout?: number;
  retries?: number;
}

/**
 * Environment variable name mapping — each SDK provides its own
 */
export interface EnvVarConfig {
  apiKey: string;
  email: string;
  password: string;
  sessionToken?: string;
  baseUrl: string;
  authBaseUrl?: string;
  debug: string;
}

/**
 * Stored credentials in credentials.json
 */
interface StoredCredentials {
  default?: StoredProfile;
  [profile: string]: StoredProfile | undefined;
}

interface StoredProfile {
  type: 'api_key' | 'session';
  apiKey?: string;
  sessionToken?: string;
  expiresAt?: string;
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
    loadDotenv({ path: localEnvPath, override: false });
  }

  const globalEnvPath = join(homedir(), CONFIG_PATHS.GLOBAL_ENV);
  if (existsSync(globalEnvPath)) {
    loadDotenv({ path: globalEnvPath, override: false });
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
    const content = readFileSync(credPath, 'utf-8');
    const stored = JSON.parse(content) as StoredCredentials;
    const profileCreds = stored[profile];

    if (!profileCreds) {
      return null;
    }

    // Check if session token is expired
    if (profileCreds.type === 'session' && profileCreds.expiresAt) {
      const expiresAt = new Date(profileCreds.expiresAt);
      if (expiresAt <= new Date()) {
        return null;
      }
    }

    return {
      apiKey: profileCreds.apiKey,
      sessionToken: profileCreds.sessionToken,
      email: profileCreds.email,
    };
  } catch (error) {
    const logger = createLogger('[sdk-core:config]', false);
    logger.debug('Failed to load stored credentials:', error instanceof Error ? error.message : String(error));
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
  loadEnvFiles();

  const envVars = options.envVars;

  // Determine base URL
  const baseUrl = options.baseUrl
    ?? (envVars ? process.env[envVars.baseUrl] : undefined)
    ?? options.defaults?.baseUrl
    ?? 'http://localhost:3100/api/v1';

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
 * Check if credentials look like an API key
 */
export function isApiKey(value: string): boolean {
  return value.startsWith(API_KEY_PREFIX);
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
