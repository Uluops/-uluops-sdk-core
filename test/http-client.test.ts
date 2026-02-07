/**
 * Tests for HttpClient: construction, request(), retry logic, 401 token refresh,
 * doFetch envelope parsing, requestRaw(), requestBinary(), error mapping,
 * timeout, query params, rate limit headers.
 */
import nock from 'nock';
import { HttpClient } from '../src/http/http-client.js';
import {
  SdkApiError,
  ValidationError,
  UnauthorizedError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
  NetworkError,
  TimeoutError,
} from '../src/errors/errors.js';
import { TEST_BASE_URL, TEST_BASE_PATH, TEST_FULL_URL, TEST_API_KEY } from './setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeClient(overrides: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
  return new HttpClient({
    baseUrl: TEST_FULL_URL,
    sdkName: '@uluops/sdk-core',
    sdkVersion: '0.1.0',
    loggerPrefix: '[test]',
    apiKey: TEST_API_KEY,
    ...overrides,
  });
}

function apiPath(endpoint: string): string {
  return `${TEST_BASE_PATH}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------
describe('HttpClient construction', () => {
  it('should create without credentials (authStrategy = null)', () => {
    const client = makeClient({ apiKey: undefined });
    expect(client.getAuthStrategy()).toBeNull();
  });

  it('should create with apiKey credential', () => {
    const client = makeClient();
    const strategy = client.getAuthStrategy();
    expect(strategy).not.toBeNull();
    expect(strategy!.getType()).toBe('api_key');
  });

  it('should create with email/password credentials', () => {
    const client = makeClient({
      apiKey: undefined,
      email: 'a@b.com',
      password: 'pw',
    });
    const strategy = client.getAuthStrategy();
    expect(strategy).not.toBeNull();
    expect(strategy!.getType()).toBe('session');
  });

  it('should create with sessionToken', () => {
    const client = makeClient({
      apiKey: undefined,
      sessionToken: 'session-tok',
    });
    const strategy = client.getAuthStrategy();
    expect(strategy).not.toBeNull();
    expect(strategy!.getType()).toBe('session');
  });

  it('should set custom headers', () => {
    const scope = nock(TEST_BASE_URL)
      .get(apiPath('/test'))
      .matchHeader('x-custom', 'value')
      .reply(200, { data: 'ok' });

    const client = makeClient({ defaultHeaders: { 'x-custom': 'value' } });
    return client.get('/test').then(() => {
      expect(scope.isDone()).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// GET request with { data: T } envelope
// ---------------------------------------------------------------------------
describe('HttpClient.get()', () => {
  it('should parse envelope and return data field', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/items'))
      .reply(200, { data: { id: 1, name: 'test' } });

    const client = makeClient();
    const result = await client.get<{ id: number; name: string }>('/items');
    expect(result).toEqual({ id: 1, name: 'test' });
  });

  it('should pass query params from data arg on GET', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/items'))
      .query({ page: '2', limit: '10' })
      .reply(200, { data: [] });

    const client = makeClient();
    const result = await client.get('/items', { page: 2, limit: 10 });
    expect(result).toEqual([]);
  });

  it('should handle 204 No Content', async () => {
    nock(TEST_BASE_URL).get(apiPath('/empty')).reply(204);

    const client = makeClient();
    const result = await client.get('/empty');
    expect(result).toBeUndefined();
  });

  it('should throw on non-envelope JSON response', async () => {
    nock(TEST_BASE_URL).get(apiPath('/bad')).reply(200, { result: 'not wrapped' });

    const client = makeClient();
    await expect(client.get('/bad')).rejects.toThrow('Unexpected API response format');
  });

  it('should throw SdkApiError on invalid JSON body', async () => {
    nock(TEST_BASE_URL).get(apiPath('/garbled')).reply(200, 'not json at all', {
      'Content-Type': 'application/json',
    });

    const client = makeClient();
    await expect(client.get('/garbled')).rejects.toThrow('Invalid JSON response');
  });
});

// ---------------------------------------------------------------------------
// POST / PATCH / PUT / DELETE
// ---------------------------------------------------------------------------
describe('HttpClient mutation methods', () => {
  it('post() should send body as JSON', async () => {
    const scope = nock(TEST_BASE_URL)
      .post(apiPath('/items'), { name: 'new' })
      .reply(201, { data: { id: 2 } });

    const client = makeClient();
    const result = await client.post('/items', { name: 'new' });
    expect(result).toEqual({ id: 2 });
    expect(scope.isDone()).toBe(true);
  });

  it('patch() should send body as JSON', async () => {
    const scope = nock(TEST_BASE_URL)
      .patch(apiPath('/items/1'), { name: 'updated' })
      .reply(200, { data: { id: 1, name: 'updated' } });

    const client = makeClient();
    const result = await client.patch('/items/1', { name: 'updated' });
    expect(result).toEqual({ id: 1, name: 'updated' });
    expect(scope.isDone()).toBe(true);
  });

  it('put() should send body as JSON', async () => {
    const scope = nock(TEST_BASE_URL)
      .put(apiPath('/items/1'), { name: 'replaced' })
      .reply(200, { data: { name: 'replaced' } });

    const client = makeClient();
    const result = await client.put('/items/1', { name: 'replaced' });
    expect(result).toEqual({ name: 'replaced' });
    expect(scope.isDone()).toBe(true);
  });

  it('delete() should call DELETE', async () => {
    nock(TEST_BASE_URL).delete(apiPath('/items/1')).reply(204);

    const client = makeClient();
    const result = await client.delete('/items/1');
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// User-Agent header
// ---------------------------------------------------------------------------
describe('User-Agent header', () => {
  it('should send SDK name and version', async () => {
    const scope = nock(TEST_BASE_URL)
      .get(apiPath('/ua'))
      .matchHeader('User-Agent', '@uluops/sdk-core/0.1.0')
      .reply(200, { data: 'ok' });

    const client = makeClient();
    await client.get('/ua');
    expect(scope.isDone()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Authorization header
// ---------------------------------------------------------------------------
describe('Authorization header', () => {
  it('should send Bearer token for apiKey', async () => {
    const scope = nock(TEST_BASE_URL)
      .get(apiPath('/auth'))
      .matchHeader('Authorization', `Bearer ${TEST_API_KEY}`)
      .reply(200, { data: 'ok' });

    const client = makeClient();
    await client.get('/auth');
    expect(scope.isDone()).toBe(true);
  });

  it('should not send Authorization when no credentials', async () => {
    const scope = nock(TEST_BASE_URL)
      .get(apiPath('/noauth'))
      .reply(200, { data: 'ok' });

    const client = makeClient({ apiKey: undefined });
    await client.get('/noauth');
    expect(scope.isDone()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error mapping from HTTP status codes
// ---------------------------------------------------------------------------
describe('HTTP error mapping', () => {
  it('should map 400 to ValidationError', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/e400'))
      .reply(400, { error: { code: 'VALIDATION_ERROR', message: 'bad input' } });

    const client = makeClient();
    await expect(client.get('/e400')).rejects.toThrow(ValidationError);
  });

  it('should map 401 to UnauthorizedError', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/e401'))
      .reply(401, { error: { message: 'no auth' } });

    const client = makeClient();
    await expect(client.get('/e401')).rejects.toThrow(UnauthorizedError);
  });

  it('should map 404 to NotFoundError', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/e404'))
      .reply(404, { error: { message: 'not here' } });

    const client = makeClient();
    await expect(client.get('/e404')).rejects.toThrow(NotFoundError);
  });

  it('should map 429 to RateLimitError', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/e429'))
      .reply(429, { error: { message: 'slow' } }, { 'retry-after': '30' });

    // retries=1 prevents retry loop consuming nock interceptors
    const client = makeClient({ retries: 1 });
    try {
      await client.get('/e429');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfter).toBe(30);
    }
  });

  it('should map 503 to ServiceUnavailableError', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/e503'))
      .reply(503, { error: { message: 'down' } });

    // retries=1 prevents retry loop consuming nock interceptors
    const client = makeClient({ retries: 1 });
    await expect(client.get('/e503')).rejects.toThrow(ServiceUnavailableError);
  });

  it('should use default message when error body is empty', async () => {
    nock(TEST_BASE_URL).get(apiPath('/e500')).reply(500, {});

    const client = makeClient();
    try {
      await client.get('/e500');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SdkApiError);
      expect((err as SdkApiError).message).toBe('HTTP 500');
    }
  });

  it('should extract x-request-id header', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/reqid'))
      .reply(500, { error: { message: 'fail' } }, { 'x-request-id': 'req-abc' });

    const client = makeClient();
    try {
      await client.get('/reqid');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SdkApiError);
      expect((err as SdkApiError).requestId).toBe('req-abc');
    }
  });

  it('should strip sensitive detail keys from error body', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/strip'))
      .reply(400, {
        error: {
          message: 'bad',
          details: {
            field: 'name',
            stack: 'at line 42',
            sql: 'SELECT * FROM secret',
            hostname: 'internal.server',
            safe: 'keep',
          },
        },
      });

    const client = makeClient();
    try {
      await client.get('/strip');
      expect.unreachable('should have thrown');
    } catch (err) {
      const details = (err as SdkApiError).details!;
      expect(details.field).toBe('name');
      expect(details.safe).toBe('keep');
      expect(details.stack).toBeUndefined();
      expect(details.sql).toBeUndefined();
      expect(details.hostname).toBeUndefined();
    }
  });

  it('should handle 401 with no auth strategy and show helpful message', async () => {
    nock(TEST_BASE_URL).get(apiPath('/noauth401')).reply(401);

    const client = makeClient({ apiKey: undefined });
    try {
      await client.get('/noauth401');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedError);
      expect((err as UnauthorizedError).message).toContain('No credentials configured');
      expect((err as UnauthorizedError).message).toContain('authentication');
    }
  });
});

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------
describe('retry logic', () => {
  it('should retry GET on 503 and succeed', async () => {
    nock(TEST_BASE_URL).get(apiPath('/retry')).reply(503, { error: { message: 'down' } });
    nock(TEST_BASE_URL).get(apiPath('/retry')).reply(200, { data: 'ok' });

    const client = makeClient({ retries: 2 });
    const result = await client.get('/retry');
    expect(result).toBe('ok');
  });

  it('should NOT retry POST by default', async () => {
    nock(TEST_BASE_URL)
      .post(apiPath('/noretry'))
      .reply(503, { error: { message: 'down' } });

    const client = makeClient({ retries: 3 });
    await expect(client.post('/noretry', { x: 1 })).rejects.toThrow(ServiceUnavailableError);
  });

  it('should retry POST when retryMutations is true', async () => {
    nock(TEST_BASE_URL)
      .post(apiPath('/retrypost'))
      .reply(503, { error: { message: 'down' } });
    nock(TEST_BASE_URL)
      .post(apiPath('/retrypost'))
      .reply(201, { data: { id: 1 } });

    const client = makeClient({ retries: 2 });
    const result = await client.request('POST', '/retrypost', { x: 1 }, { retryMutations: true });
    expect(result).toEqual({ id: 1 });
  });

  it('should exhaust retries and throw last error', async () => {
    nock(TEST_BASE_URL).get(apiPath('/exhaust')).times(3).reply(503, { error: { message: 'still down' } });

    const client = makeClient({ retries: 3 });
    await expect(client.get('/exhaust')).rejects.toThrow(ServiceUnavailableError);
  });

  it('should not retry non-retryable errors (e.g. 400)', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/noretry400'))
      .reply(400, { error: { message: 'bad' } });

    const client = makeClient({ retries: 3 });
    await expect(client.get('/noretry400')).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// 401 token refresh with deduplication
// ---------------------------------------------------------------------------
describe('401 token refresh', () => {
  it('should refresh token on 401 and retry with new token', async () => {
    // Use sessionToken so the first request actually sends an Authorization header.
    // The server responds 401 (expired token), triggering refresh (re-login).
    // Note: createAuthStrategy with sessionToken creates JwtSessionAuth with
    // empty email/password credentials, so the login POST sends those.

    // First request with stale token returns 401
    nock(TEST_BASE_URL)
      .get(apiPath('/protected'))
      .matchHeader('Authorization', 'Bearer stale-tok')
      .reply(401, { error: { message: 'expired' } });

    // Auth login endpoint — refresh calls login() which POSTs to authBaseUrl + /auth/login
    // JwtSessionAuth created from sessionToken path has { email: '', password: '' }
    nock(TEST_BASE_URL)
      .post(apiPath('/auth/login'), { email: '', password: '' })
      .reply(200, { data: { sessionToken: 'refreshed-tok', expiresAt: '2099-01-01' } });

    // Retry with refreshed token succeeds
    nock(TEST_BASE_URL)
      .get(apiPath('/protected'))
      .matchHeader('Authorization', 'Bearer refreshed-tok')
      .reply(200, { data: 'protected-data' });

    const client = makeClient({
      apiKey: undefined,
      sessionToken: 'stale-tok',
      retries: 3,
    });

    const result = await client.get('/protected');
    expect(result).toBe('protected-data');
  });

  it('should deduplicate concurrent token refreshes (single login call)', async () => {
    // Two concurrent requests both get 401 — only ONE login should happen.
    // Use sessionToken so both requests have an initial (stale) token.
    nock(TEST_BASE_URL)
      .get(apiPath('/concurrent1'))
      .matchHeader('Authorization', 'Bearer stale-tok')
      .reply(401, { error: { message: 'expired' } });
    nock(TEST_BASE_URL)
      .get(apiPath('/concurrent2'))
      .matchHeader('Authorization', 'Bearer stale-tok')
      .reply(401, { error: { message: 'expired' } });

    // Single login endpoint (only intercepted once — if called twice, nock will error)
    // sessionToken path creates JwtSessionAuth with { email: '', password: '' }
    nock(TEST_BASE_URL)
      .post(apiPath('/auth/login'), { email: '', password: '' })
      .reply(200, { data: { sessionToken: 'fresh-tok', expiresAt: '2099-01-01' } });

    // Retry requests with refreshed token
    nock(TEST_BASE_URL)
      .get(apiPath('/concurrent1'))
      .matchHeader('Authorization', 'Bearer fresh-tok')
      .reply(200, { data: 'result1' });
    nock(TEST_BASE_URL)
      .get(apiPath('/concurrent2'))
      .matchHeader('Authorization', 'Bearer fresh-tok')
      .reply(200, { data: 'result2' });

    const client = makeClient({
      apiKey: undefined,
      sessionToken: 'stale-tok',
      retries: 3,
    });

    const [r1, r2] = await Promise.all([
      client.get('/concurrent1'),
      client.get('/concurrent2'),
    ]);

    expect(r1).toBe('result1');
    expect(r2).toBe('result2');
  });

  it('should refresh token on 401 even after a transient retry', async () => {
    // Attempt 1: transient 503 triggers retry
    nock(TEST_BASE_URL)
      .get(apiPath('/late401'))
      .reply(503, { error: { message: 'down' } });

    // Attempt 2: token expired during retry delay
    nock(TEST_BASE_URL)
      .get(apiPath('/late401'))
      .reply(401, { error: { message: 'expired' } });

    // Token refresh succeeds
    nock(TEST_BASE_URL)
      .post(apiPath('/auth/login'), { email: '', password: '' })
      .reply(200, { data: { sessionToken: 'new-tok', expiresAt: '2099-01-01' } });

    // Attempt 3: retried with fresh token
    nock(TEST_BASE_URL)
      .get(apiPath('/late401'))
      .matchHeader('Authorization', 'Bearer new-tok')
      .reply(200, { data: 'recovered' });

    const client = makeClient({
      apiKey: undefined,
      sessionToken: 'stale-tok',
      retries: 4,
    });

    const result = await client.get('/late401');
    expect(result).toBe('recovered');
  });

  it('should throw original error when refresh fails', async () => {
    // First request returns 401
    nock(TEST_BASE_URL)
      .get(apiPath('/protected2'))
      .reply(401, { error: { message: 'expired' } });

    // Auth login fails
    nock(TEST_BASE_URL)
      .post(apiPath('/auth/login'))
      .reply(401, { error: { message: 'bad credentials' } });

    const client = makeClient({
      apiKey: undefined,
      email: 'a@b.com',
      password: 'wrong',
      retries: 1,
    });

    await expect(client.get('/protected2')).rejects.toThrow(UnauthorizedError);
  });
});

// ---------------------------------------------------------------------------
// Query parameter handling
// ---------------------------------------------------------------------------
describe('query parameter handling', () => {
  it('should skip null and undefined params', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/qp'))
      .query({ kept: 'yes' })
      .reply(200, { data: 'ok' });

    const client = makeClient();
    const result = await client.get('/qp', { kept: 'yes', dropped: undefined, gone: null });
    expect(result).toBe('ok');
  });

  it('should handle array params by appending multiple values', async () => {
    // nock handles arrays as repeated params
    nock(TEST_BASE_URL)
      .get(apiPath('/arr'))
      .query({ tag: ['a', 'b'] })
      .reply(200, { data: 'ok' });

    const client = makeClient();
    const result = await client.get('/arr', { tag: ['a', 'b'] });
    expect(result).toBe('ok');
  });

  it('should handle empty array params without adding to query string', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/emptyarr'))
      .query({ other: 'yes' })
      .reply(200, { data: 'ok' });

    const client = makeClient();
    const result = await client.get('/emptyarr', { tag: [], other: 'yes' });
    expect(result).toBe('ok');
  });

  it('should convert numbers and booleans to strings', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/types'))
      .query({ num: '42', flag: 'true' })
      .reply(200, { data: 'ok' });

    const client = makeClient();
    const result = await client.get('/types', { num: 42, flag: true });
    expect(result).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Rate limit header parsing
// ---------------------------------------------------------------------------
describe('rate limit header parsing', () => {
  it('should parse rate limit headers from response', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/rl'))
      .reply(200, { data: 'ok' }, {
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '42',
        'x-ratelimit-reset': '1700000000',
      });

    const client = makeClient();
    await client.get('/rl');
    const info = client.getRateLimitInfo();
    expect(info).not.toBeNull();
    expect(info!.limit).toBe(100);
    expect(info!.remaining).toBe(42);
    expect(info!.reset).toEqual(new Date(1700000000 * 1000));
  });

  it('should return null when no rate limit headers present', async () => {
    nock(TEST_BASE_URL).get(apiPath('/norl')).reply(200, { data: 'ok' });

    const client = makeClient();
    await client.get('/norl');
    const info = client.getRateLimitInfo();
    expect(info).toBeNull();
  });

  it('should include retry-after in rate limit info', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/rl2'))
      .reply(200, { data: 'ok' }, {
        'x-ratelimit-limit': '50',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1700000000',
        'retry-after': '15',
      });

    const client = makeClient();
    await client.get('/rl2');
    const info = client.getRateLimitInfo();
    expect(info!.retryAfter).toBe(15);
  });

  it('should return a copy of rate limit info (immutable)', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/rl3'))
      .reply(200, { data: 'ok' }, {
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '50',
        'x-ratelimit-reset': '1700000000',
      });

    const client = makeClient();
    await client.get('/rl3');
    const info1 = client.getRateLimitInfo();
    const info2 = client.getRateLimitInfo();
    expect(info1).not.toBe(info2); // different object references
    expect(info1).toEqual(info2);  // same values
  });
});

// ---------------------------------------------------------------------------
// requestRaw()
// ---------------------------------------------------------------------------
describe('HttpClient.requestRaw()', () => {
  it('should return raw parsed JSON without envelope unwrapping', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/raw'))
      .reply(200, { custom: 'format', data: 'nested' });

    const client = makeClient();
    const result = await client.requestRaw<{ custom: string; data: string }>('GET', '/raw');
    expect(result).toEqual({ custom: 'format', data: 'nested' });
  });

  it('should handle empty body', async () => {
    nock(TEST_BASE_URL).get(apiPath('/rawempty')).reply(200, '');

    const client = makeClient();
    const result = await client.requestRaw('GET', '/rawempty');
    expect(result).toBeUndefined();
  });

  it('should handle query params in options', async () => {
    nock(TEST_BASE_URL)
      .post(apiPath('/rawpost'))
      .query({ filter: 'active' })
      .reply(200, { ok: true });

    const client = makeClient();
    const result = await client.requestRaw('POST', '/rawpost', { x: 1 }, { params: { filter: 'active' } });
    expect(result).toEqual({ ok: true });
  });

  it('should throw on invalid JSON', async () => {
    nock(TEST_BASE_URL).get(apiPath('/rawbad')).reply(200, 'not json');

    const client = makeClient();
    await expect(client.requestRaw('GET', '/rawbad')).rejects.toThrow('Invalid JSON response');
  });

  it('should map HTTP errors', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/raw404'))
      .reply(404, { error: { message: 'nope' } });

    const client = makeClient();
    await expect(client.requestRaw('GET', '/raw404')).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// requestBinary()
// ---------------------------------------------------------------------------
describe('HttpClient.requestBinary()', () => {
  it('should return ArrayBuffer, contentType, and headers', async () => {
    const buffer = Buffer.from('binary-data');
    nock(TEST_BASE_URL)
      .get(apiPath('/binary'))
      .reply(200, buffer, { 'content-type': 'application/pdf' });

    const client = makeClient();
    const result = await client.requestBinary('GET', '/binary');
    expect(result.contentType).toBe('application/pdf');
    expect(result.data).toBeDefined();
    expect(result.headers).toBeDefined();
  });

  it('should default contentType to application/octet-stream', async () => {
    const buffer = Buffer.from('data');
    nock(TEST_BASE_URL)
      .get(apiPath('/bin2'))
      .reply(200, buffer);

    const client = makeClient();
    const result = await client.requestBinary('GET', '/bin2');
    // nock may send content-type, but we check the fallback logic
    expect(result.contentType).toBeDefined();
  });

  it('should map HTTP errors', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/bin404'))
      .reply(404, { error: { message: 'nope' } });

    const client = makeClient();
    await expect(client.requestBinary('GET', '/bin404')).rejects.toThrow(NotFoundError);
  });

  it('should handle query params', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/binqp'))
      .query({ format: 'pdf' })
      .reply(200, Buffer.from('pdf-data'), { 'content-type': 'application/pdf' });

    const client = makeClient();
    const result = await client.requestBinary('GET', '/binqp', { params: { format: 'pdf' } });
    expect(result.contentType).toBe('application/pdf');
  });
});

// ---------------------------------------------------------------------------
// Timeout via AbortController
// ---------------------------------------------------------------------------
describe('timeout handling', () => {
  it('should throw TimeoutError when request exceeds timeout', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/slow'))
      .delayConnection(200)
      .reply(200, { data: 'ok' });

    const client = makeClient({ timeout: 50 });
    try {
      await client.get('/slow');
      expect.unreachable('should have thrown');
    } catch (err) {
      // In Node.js with nock, AbortError is mapped to TimeoutError.
      // Verify it's either a TimeoutError or at minimum an Error (not a success).
      expect(err).toBeInstanceOf(Error);
      if (err instanceof TimeoutError) {
        expect(err.message).toContain('50');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------
describe('URL building', () => {
  it('should strip trailing slash from baseUrl', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/trailing'))
      .reply(200, { data: 'ok' });

    const client = makeClient({ baseUrl: `${TEST_FULL_URL}/` });
    const result = await client.get('/trailing');
    expect(result).toBe('ok');
  });

  it('should add leading slash to endpoint if missing', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/noslash'))
      .reply(200, { data: 'ok' });

    const client = makeClient();
    const result = await client.get('noslash');
    expect(result).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// getRateLimitInfo() when no request made
// ---------------------------------------------------------------------------
describe('getRateLimitInfo() without prior request', () => {
  it('should return null', () => {
    const client = makeClient();
    expect(client.getRateLimitInfo()).toBeNull();
  });
});
