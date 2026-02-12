# @uluops/sdk-core

[![npm version](https://img.shields.io/npm/v/@uluops/sdk-core.svg)](https://www.npmjs.com/package/@uluops/sdk-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

Shared infrastructure for UluOps SDKs. Provides HTTP client, authentication strategies, error hierarchy, configuration loaders, and utility functions used by [`@uluops/ops-sdk`](https://www.npmjs.com/package/@uluops/ops-sdk) and [`@uluops/registry-sdk`](https://www.npmjs.com/package/@uluops/registry-sdk).

**Current version: 0.1.0**

## Quick Start

### Building an SDK on top of sdk-core

```typescript
import { HttpClient, type HttpClientConfig } from '@uluops/sdk-core/http';

// Extend HttpClient with your SDK's defaults
class MyHttpClient extends HttpClient {
  constructor(config: Partial<HttpClientConfig> = {}) {
    super({
      baseUrl: config.baseUrl ?? 'https://api.example.com/v1',
      sdkName: '@my-org/my-sdk',
      sdkVersion: '1.0.0',
      loggerPrefix: '[my-sdk:http]',
      ...config,
    });
  }
}

const http = new MyHttpClient({ apiKey: 'ulr_your-api-key-here' });

// Type-safe API calls with automatic retry, auth, and error mapping
const data = await http.get<{ items: string[] }>('/items');
const created = await http.post<{ id: string }>('/items', { name: 'new item' });
```

> See [Error handling with typed errors](#error-handling-with-typed-errors) below for `try/catch` patterns.

### Using the HTTP client directly

```typescript
import { HttpClient } from '@uluops/sdk-core';

const client = new HttpClient({
  baseUrl: 'https://api.example.com/v1',
  sdkName: 'my-app',
  sdkVersion: '1.0.0',
  loggerPrefix: '[my-app]',
  apiKey: 'ulr_your-api-key-here',
  timeout: 30000,
  retries: 3,
});

const result = await client.get<MyType>('/endpoint');
```

### Error handling with typed errors

```typescript
import { NotFoundError, RateLimitError, isSdkApiError } from '@uluops/sdk-core/errors';

try {
  await client.get('/missing-resource');
} catch (error) {
  if (error instanceof NotFoundError) {
    console.log('Not found:', error.message);
  } else if (error instanceof RateLimitError) {
    console.log(`Rate limited. Retry after ${error.retryAfter}s`);
  } else if (isSdkApiError(error)) {
    console.log(`API error [${error.code}]: ${error.message}`);
  }
}
```

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [API Reference](#api-reference)
  - [HttpClient](#httpclient)
  - [Authentication](#authentication)
  - [Errors](#errors)
  - [Configuration](#configuration)
  - [Utilities](#utilities)
- [Package Exports](#package-exports)
- [Extending for Your SDK](#extending-for-your-sdk)
- [License](#license)

## Overview

This package extracts the shared infrastructure that was duplicated across `@uluops/ops-sdk` and `@uluops/registry-sdk`. It provides:

- **HTTP Client**: Native `fetch`-based client with timeout, retry, auth, rate limiting, and `{ data: T }` envelope parsing
- **Authentication**: API key and JWT session strategies with automatic token refresh
- **Error Hierarchy**: 10 typed error classes mapped to HTTP status codes, plus type guard functions
- **Configuration**: Credential chain loader (constructor > env vars > .env files > stored credentials)
- **Utilities**: Logger with sensitive data redaction, retry with exponential backoff, rate limit header parsing

## Prerequisites

- Node.js 18.0.0 or higher (uses native `fetch`)
- TypeScript 5.0+ (for TypeScript users)
- ESM project (`"type": "module"` in package.json) — this package is ESM-only

## Installation

```bash
# npm
npm install @uluops/sdk-core

# yarn
yarn add @uluops/sdk-core

# pnpm
pnpm add @uluops/sdk-core
```

## API Reference

### HttpClient

The core HTTP client using native `fetch` with automatic retry, auth, and error mapping.

#### Configuration

```typescript
import { HttpClient, type HttpClientConfig } from '@uluops/sdk-core/http';

const client = new HttpClient({
  // Required
  baseUrl: 'https://api.example.com/v1',   // API base URL
  sdkName: '@my-org/my-sdk',               // For User-Agent header
  sdkVersion: '1.0.0',                     // For User-Agent header
  loggerPrefix: '[my-sdk:http]',           // Log message prefix

  // Authentication (choose one)
  apiKey: 'ulr_...',                        // API key (preferred)
  sessionToken: 'jwt-token',               // Existing session token
  email: 'user@example.com',               // Email for login
  password: 'password',                    // Password for login

  // Optional
  authBaseUrl: 'https://auth.example.com', // Separate auth endpoint URL
  timeout: 30000,                          // Request timeout in ms (default: 30000)
  retries: 3,                              // Max retry attempts (default: 3)
  debug: false,                            // Enable debug logging
  defaultHeaders: { 'X-Custom': 'value' }, // Extra default headers
  onTokenRefresh: (token) => { /* ... */ },// Token refresh callback
});
```

#### Request Methods

```typescript
// GET — always retried on transient errors
const data = await client.get<MyType>('/endpoint', { page: 1 });

// POST
const created = await client.post<MyType>('/endpoint', { name: 'value' });

// PUT
const updated = await client.put<MyType>('/endpoint/123', { name: 'updated' });

// PATCH (supports options: params, skipAuth)
const patched = await client.patch<MyType>('/endpoint/123', { name: 'patched' }, { skipAuth: true });

// DELETE
await client.delete('/endpoint/123');
```

#### Advanced Request Options

```typescript
// Retry mutations (POST/PUT/DELETE are NOT retried by default)
const result = await client.request<MyType>('POST', '/idempotent-endpoint', {
  body: { key: 'value' },
  retryMutations: true,
});

// Zod schema validation on response
import { z } from 'zod';
const schema = z.object({ id: z.string(), name: z.string() });
const validated = await client.request<z.infer<typeof schema>>('GET', '/endpoint', {
  schema,
});

// Raw response (without { data: T } envelope unwrapping, no automatic retry)
const raw = await client.requestRaw<MyRawType>('GET', '/endpoint');
console.log(raw); // parsed JSON without envelope unwrapping

// Binary response (no automatic retry — see requestBinary docs)
const binary = await client.requestBinary('GET', '/files/report.pdf');
console.log(binary.data, binary.contentType);
```

#### Rate Limit Info

```typescript
// After any request, check rate limit headers
const info = client.getRateLimitInfo();
if (info) {
  console.log(`${info.remaining}/${info.limit} requests remaining`);
  console.log(`Resets at: ${info.reset}`);
}
```

#### Automatic Retries

The client automatically retries on transient errors (502, 503, 504, 429) with exponential backoff and jitter:

- **GET requests**: Always retried (up to `retries` attempts)
- **Mutations (POST/PUT/DELETE)**: Only retried when `retryMutations: true`
- **Backoff**: Exponential with jitter (base: 1s, max: 30s)
- **401 handling**: Automatic token refresh with deduplication (one refresh at a time)

---

### Authentication

Three authentication strategies, resolved via priority chain.

#### API Key (Recommended)

Keys must start with `ulr_`, be at least 20 characters, and contain only alphanumeric characters, underscores, and hyphens.

```typescript
import { ApiKeyAuth } from '@uluops/sdk-core/http';

const auth = new ApiKeyAuth('ulr_your-api-key-here');
auth.getAuthorizationHeader(); // 'Bearer ulr_your-api-key-here'
auth.getType();                // 'api_key'
auth.isAuthenticated();        // true
```

#### JWT Session

```typescript
import { JwtSessionAuth } from '@uluops/sdk-core/http';
import type { FetchClient } from '@uluops/sdk-core/http';

const auth = new JwtSessionAuth({
  email: 'user@example.com',
  password: 'password',
  httpClient: myFetchClient,          // For login/refresh requests
  onTokenRefresh: (token) => { /* save token */ },
});

// Login happens automatically on first request
await auth.refresh();
auth.getSessionToken();  // 'jwt-token-here'
auth.getExpiresAt();     // Date
```

#### Strategy Factory

```typescript
import { createAuthStrategy } from '@uluops/sdk-core/http';

// Priority: apiKey > sessionToken > email/password
const strategy = createAuthStrategy({
  apiKey: 'ulr_...',
});
strategy.getType(); // 'api_key'
```

---

### Errors

All API errors extend `SdkApiError` and include `statusCode`, `code`, `message`, `details`, and `requestId`.

#### Error Classes

| Error | Status | When It Happens |
|-------|--------|-----------------|
| `ValidationError` | 400 | Invalid request data |
| `UnauthorizedError` | 401 | Missing or invalid credentials |
| `ForbiddenError` | 403 | Valid credentials but insufficient permissions |
| `NotFoundError` | 404 | Resource doesn't exist |
| `ConflictError` | 409 | Name collision or state conflict |
| `PayloadTooLargeError` | 413 | Request body exceeds size limit |
| `UnprocessableError` | 422 | Valid syntax but invalid semantics |
| `RateLimitError` | 429 | Too many requests (`retryAfter` property) |
| `ServiceUnavailableError` | 503 | Server temporarily down (`retryAfter` property) |
| `NetworkError` | 0 | DNS failure, connection refused |
| `TimeoutError` | 0 | Request exceeded timeout |

#### Error Factory

```typescript
import { createErrorFromStatus } from '@uluops/sdk-core/errors';

// Create the appropriate error subclass from an HTTP status code
const error = createErrorFromStatus(404, 'NOT_FOUND', 'Project not found', { id: '123' });
error instanceof NotFoundError; // true
error.isRetryable();            // false
```

#### Type Guards

```typescript
import {
  isSdkApiError,
  isValidationError,
  isNotFoundError,
  isConflictError,
  isUnprocessableError,
  isRateLimitError,
} from '@uluops/sdk-core/errors';

if (isSdkApiError(error)) {
  console.log(error.code, error.statusCode);
}
```

#### Error Serialization

Errors safely serialize to JSON with sensitive details redacted:

```typescript
const error = new NotFoundError('Item not found', { id: '123', sql: 'SELECT ...' });
console.log(JSON.stringify(error));
// { "name": "SdkApiError", "code": "NOT_FOUND", "statusCode": 404,
//   "message": "Item not found", "details": { "id": "123" } }
// Note: 'sql' key is automatically stripped
```

---

### Configuration

#### Credential Loading

Loads credentials from multiple sources in priority order:

1. **Explicit arguments**: `apiKey`, `sessionToken`, `email`/`password`
2. **Environment variables**: via SDK-specific `EnvVarConfig`
3. **Local `.env` file**: via `dotenv` in the current working directory
4. **Global credentials**: `~/.uluops/credentials.json`

```typescript
import {
  loadCredentials,
  loadConfig,
  type EnvVarConfig,
  type Credentials,
  type SdkConfig,
} from '@uluops/sdk-core/config';

// Each SDK passes its own env var names
const MY_ENV_VARS: EnvVarConfig = {
  apiKey: 'MY_API_KEY',
  email: 'MY_EMAIL',
  password: 'MY_PASSWORD',
  baseUrl: 'MY_BASE_URL',
  debug: 'MY_DEBUG',
};

// Load credentials with priority chain
const creds: Credentials = loadCredentials({ envVars: MY_ENV_VARS });

// Load full config (credentials + baseUrl + debug)
const config: SdkConfig = loadConfig({
  envVars: MY_ENV_VARS,
  defaults: { baseUrl: 'https://api.example.com/v1' },
});
```

#### Credential Validation

```typescript
import { validateCredentials, isApiKey, API_KEY_PREFIX } from '@uluops/sdk-core/config';

// Throws ValidationError if no credentials found
validateCredentials({ apiKey: process.env.MY_API_KEY });

// Check API key format
isApiKey('ulr_abc123def456ghij'); // true
isApiKey('invalid');               // false
```

#### Stored Credentials

```typescript
import { loadStoredCredentials, getCredentialsPath } from '@uluops/sdk-core/config';

// Path: ~/.uluops/credentials.json
console.log(getCredentialsPath());

// Load from stored file (returns undefined if not found)
const stored = loadStoredCredentials();
```

#### Constants

```typescript
import {
  DEFAULT_TIMEOUT,       // 30000 ms
  DEFAULT_RETRY_COUNT,   // 3
  BACKOFF_BASE_MS,       // 1000 ms
  MAX_BACKOFF_MS,        // 30000 ms
  API_KEY_PREFIX,        // 'ulr_'
  HTTP_STATUS,           // { OK: 200, CREATED: 201, ... }
  ERROR_CODES,           // { NOT_FOUND: 'NOT_FOUND', ... }
  RETRYABLE_STATUS_CODES,// Set(502, 503, 504, 429)
  CONFIG_PATHS,          // { configDir, envFile, credentialsFile }
} from '@uluops/sdk-core/config';
```

---

### Utilities

#### Logger

```typescript
import { createLogger, type Logger } from '@uluops/sdk-core/utils';

const logger: Logger = createLogger('[my-sdk]', true);
logger.debug('Fetching', '/api/items');
logger.warn('Retry attempt', 2);
logger.error('Request failed', error);

// Disabled logger (no-ops)
const silent = createLogger('[my-sdk]', false);
```

#### Sensitive Data Redaction

```typescript
import { redactSensitive, sanitizeForLog, sanitizeForDisplay } from '@uluops/sdk-core/utils';

// Redact showing last 4 chars
redactSensitive('ulr_secret_key_12345678', 4); // '***5678'

// Sanitize a value for logging (redacts strings matching sensitive patterns)
sanitizeForLog('ulr_secret_key_12345678'); // '[REDACTED]'

// Sanitize an object for display (deep, strips sensitive keys)
sanitizeForDisplay({ apiKey: 'ulr_...', name: 'safe' });
// { apiKey: '[REDACTED]', name: 'safe' }
```

#### Retry with Backoff

```typescript
import { retry, sleep } from '@uluops/sdk-core/utils';

// Retry an async operation with exponential backoff
const result = await retry(
  () => fetchData(),
  { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000 },
);

// Simple delay
await sleep(1000);
```

#### Helpers

```typescript
import { isPlainObject, isUuid, truncate, toQuery } from '@uluops/sdk-core/utils';

isPlainObject({});           // true
isPlainObject([]);           // false
isUuid('550e8400-...');      // true
truncate('long string', 5); // 'long ...'

// Build query params from an object
const params = toQuery({ page: 1, tags: ['a', 'b'], empty: undefined });
// { page: '1', tags: ['a', 'b'] } — undefined values stripped
```

#### Rate Limit Parsing

```typescript
import { parseRateLimitHeaders, type RateLimitInfo } from '@uluops/sdk-core/utils';

const headers = new Headers({
  'x-ratelimit-limit': '100',
  'x-ratelimit-remaining': '42',
  'x-ratelimit-reset': '1700000000',
});

const info: RateLimitInfo | undefined = parseRateLimitHeaders(headers);
// { limit: 100, remaining: 42, reset: Date }
```

## Package Exports

| Export Path | Contents |
|------------|----------|
| `@uluops/sdk-core` | Everything (HttpClient, errors, config, utils) |
| `@uluops/sdk-core/http` | `HttpClient`, `ApiKeyAuth`, `JwtSessionAuth`, `createAuthStrategy` |
| `@uluops/sdk-core/errors` | `SdkApiError` + all error subclasses, `createErrorFromStatus`, type guards |
| `@uluops/sdk-core/config` | `loadCredentials`, `loadConfig`, constants, `EnvVarConfig` |
| `@uluops/sdk-core/utils` | `createLogger`, `redactSensitive`, `sleep`, `retry`, `toQuery` |

## Extending for Your SDK

This package is designed to be extended, not used directly by end users. Here's the pattern used by `@uluops/ops-sdk` and `@uluops/registry-sdk`:

### 1. Extend HttpClient with SDK defaults

```typescript
// my-sdk/src/http/http-client.ts
import { HttpClient, type HttpClientConfig } from '@uluops/sdk-core/http';
import { SDK_VERSION, DEFAULT_BASE_URL } from '../config/constants.js';

export class MyHttpClient extends HttpClient {
  constructor(config: Partial<HttpClientConfig> = {}) {
    super({
      ...config,
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      sdkName: '@my-org/my-sdk',
      sdkVersion: SDK_VERSION,
      loggerPrefix: '[my-sdk:http]',
    });
  }
}
```

### 2. Alias the base error class

```typescript
// my-sdk/src/errors/errors.ts
export {
  SdkApiError as MyApiError,
  isSdkApiError as isMyApiError,
  ValidationError,
  NotFoundError,
  // ... all other errors
} from '@uluops/sdk-core/errors';
```

### 3. Wrap config loaders with SDK-specific env vars

```typescript
// my-sdk/src/config/loaders.ts
import { loadConfig as coreLoadConfig, type EnvVarConfig } from '@uluops/sdk-core/config';

const MY_ENV_VARS: EnvVarConfig = {
  apiKey: 'MY_SDK_API_KEY',
  email: 'MY_SDK_EMAIL',
  password: 'MY_SDK_PASSWORD',
  baseUrl: 'MY_SDK_BASE_URL',
  debug: 'MY_SDK_DEBUG',
};

export function loadConfig(options = {}) {
  return coreLoadConfig({
    ...options,
    envVars: MY_ENV_VARS,
    defaults: { baseUrl: 'https://api.my-service.com/v1' },
  });
}
```

### 4. Re-export shared utilities

```typescript
// my-sdk/src/utils/helpers.ts
export { sleep, retry, truncate, isPlainObject, isUuid } from '@uluops/sdk-core/utils';

// Add SDK-specific helpers
export function myCustomHelper() { /* ... */ }
```

## License

MIT License - see [LICENSE](./LICENSE) for details.
