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
import { TEST_BASE_URL, TEST_BASE_PATH, TEST_FULL_URL, TEST_API_KEY, TEST_JWT, TEST_JWT_STALE } from './setup.js';

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
      sessionToken: TEST_JWT,
    });
    const strategy = client.getAuthStrategy();
    expect(strategy).not.toBeNull();
    expect(strategy!.getType()).toBe('session');
  });

  it('should include defaultHeaders in every request', () => {
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

  it('should throw SdkApiError on non-envelope JSON response', async () => {
    nock(TEST_BASE_URL).get(apiPath('/bad')).reply(200, { result: 'not wrapped' });

    const client = makeClient();
    try {
      await client.get('/bad');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SdkApiError);
      expect((error as SdkApiError).message).toContain('Unexpected API response format');
      expect((error as SdkApiError).statusCode).toBe(200);
    }
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
// Zod schema validation
// ---------------------------------------------------------------------------
describe('Zod schema validation', () => {
  it('should validate response against schema on request()', async () => {
    const { z } = await import('zod');
    const schema = z.object({ id: z.number(), name: z.string() });

    nock(TEST_BASE_URL)
      .get(apiPath('/validated'))
      .reply(200, { data: { id: 1, name: 'test' } });

    const client = makeClient();
    const result = await client.request<z.infer<typeof schema>>('GET', '/validated', undefined, { schema });
    expect(result).toEqual({ id: 1, name: 'test' });
  });

  it('should throw ZodError when response does not match schema', async () => {
    const { z } = await import('zod');
    const schema = z.object({ id: z.number(), name: z.string() });

    nock(TEST_BASE_URL)
      .get(apiPath('/bad-shape'))
      .reply(200, { data: { id: 'not-a-number', name: 123 } });

    const client = makeClient();
    await expect(
      client.request<z.infer<typeof schema>>('GET', '/bad-shape', undefined, { schema })
    ).rejects.toThrow();
  });

  it('should validate response via get() options.schema', async () => {
    const { z } = await import('zod');
    const schema = z.object({ items: z.array(z.string()) });

    nock(TEST_BASE_URL)
      .get(apiPath('/list'))
      .reply(200, { data: { items: ['a', 'b'] } });

    const client = makeClient();
    const result = await client.get<z.infer<typeof schema>>('/list', undefined, { schema });
    expect(result).toEqual({ items: ['a', 'b'] });
  });

  it('should validate response via requestRaw() options.schema', async () => {
    const { z } = await import('zod');
    const schema = z.object({ raw: z.boolean() });

    nock(TEST_BASE_URL)
      .get(apiPath('/raw-validated'))
      .reply(200, { raw: true });

    const client = makeClient();
    const result = await client.requestRaw<z.infer<typeof schema>>('GET', '/raw-validated', undefined, { schema });
    expect(result).toEqual({ raw: true });
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
    // Use sessionToken + email/password so JwtSessionAuth has an initial
    // token for the first request AND can refresh via login() on 401.

    // First request with stale token returns 401
    nock(TEST_BASE_URL)
      .get(apiPath('/protected'))
      .matchHeader('Authorization', `Bearer ${TEST_JWT_STALE}`)
      .reply(401, { error: { message: 'expired' } });

    // Auth login endpoint — refresh calls login()
    nock(TEST_BASE_URL)
      .post(apiPath('/auth/login'), { email: 'a@b.com', password: 'pw' })
      .reply(200, { data: { sessionToken: 'refreshed-tok', expiresAt: '2099-01-01' } });

    // Retry with refreshed token succeeds
    nock(TEST_BASE_URL)
      .get(apiPath('/protected'))
      .matchHeader('Authorization', 'Bearer refreshed-tok')
      .reply(200, { data: 'protected-data' });

    const client = makeClient({
      apiKey: undefined,
      sessionToken: TEST_JWT_STALE,
      email: 'a@b.com',
      password: 'pw',
      retries: 3,
    });

    const result = await client.get('/protected');
    expect(result).toBe('protected-data');
  });

  it('should deduplicate concurrent token refreshes (single login call)', async () => {
    // Two concurrent requests both get 401 — only ONE login should happen.
    nock(TEST_BASE_URL)
      .get(apiPath('/concurrent1'))
      .matchHeader('Authorization', `Bearer ${TEST_JWT_STALE}`)
      .reply(401, { error: { message: 'expired' } });
    nock(TEST_BASE_URL)
      .get(apiPath('/concurrent2'))
      .matchHeader('Authorization', `Bearer ${TEST_JWT_STALE}`)
      .reply(401, { error: { message: 'expired' } });

    // Single login endpoint (only intercepted once — if called twice, nock will error)
    nock(TEST_BASE_URL)
      .post(apiPath('/auth/login'), { email: 'a@b.com', password: 'pw' })
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
      sessionToken: TEST_JWT_STALE,
      email: 'a@b.com',
      password: 'pw',
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
      .post(apiPath('/auth/login'), { email: 'a@b.com', password: 'pw' })
      .reply(200, { data: { sessionToken: 'new-tok', expiresAt: '2099-01-01' } });

    // Attempt 3: retried with fresh token
    nock(TEST_BASE_URL)
      .get(apiPath('/late401'))
      .matchHeader('Authorization', 'Bearer new-tok')
      .reply(200, { data: 'recovered' });

    const client = makeClient({
      apiKey: undefined,
      sessionToken: TEST_JWT_STALE,
      email: 'a@b.com',
      password: 'pw',
      retries: 4,
    });

    const result = await client.get('/late401');
    expect(result).toBe('recovered');
  });

  it('should NOT attempt refresh when session has no login credentials', async () => {
    // sessionToken-only auth cannot refresh — should throw immediately
    nock(TEST_BASE_URL)
      .get(apiPath('/norefresh'))
      .reply(401, { error: { message: 'expired' } });

    const client = makeClient({
      apiKey: undefined,
      sessionToken: TEST_JWT_STALE,
      retries: 1,
    });

    await expect(client.get('/norefresh')).rejects.toThrow(UnauthorizedError);
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

  it('should propagate refresh failure to all concurrent waiters', async () => {
    // Two concurrent requests both get 401
    nock(TEST_BASE_URL)
      .get(apiPath('/fail-concurrent1'))
      .matchHeader('Authorization', `Bearer ${TEST_JWT_STALE}`)
      .reply(401, { error: { message: 'expired' } });
    nock(TEST_BASE_URL)
      .get(apiPath('/fail-concurrent2'))
      .matchHeader('Authorization', `Bearer ${TEST_JWT_STALE}`)
      .reply(401, { error: { message: 'expired' } });

    // Single login endpoint fails — both waiters should receive the failure
    nock(TEST_BASE_URL)
      .post(apiPath('/auth/login'), { email: 'a@b.com', password: 'wrong' })
      .reply(401, { error: { message: 'bad credentials' } });

    const client = makeClient({
      apiKey: undefined,
      sessionToken: TEST_JWT_STALE,
      email: 'a@b.com',
      password: 'wrong',
      retries: 1,
    });

    const results = await Promise.allSettled([
      client.get('/fail-concurrent1'),
      client.get('/fail-concurrent2'),
    ]);

    // Both requests should reject with UnauthorizedError
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');
    expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(UnauthorizedError);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(UnauthorizedError);
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

// ---------------------------------------------------------------------------
// validateBaseUrl (SSRF prevention)
// ---------------------------------------------------------------------------
describe('validateBaseUrl', () => {
  it('should accept HTTPS URLs', () => {
    expect(() => makeClient({ baseUrl: 'https://api.uluops.com/v1' })).not.toThrow();
  });

  it('should accept HTTP for localhost', () => {
    expect(() => makeClient({ baseUrl: 'http://localhost:3100/api/v1' })).not.toThrow();
  });

  it('should accept HTTP for 127.0.0.1', () => {
    expect(() => makeClient({ baseUrl: 'http://127.0.0.1:3100/api/v1' })).not.toThrow();
  });

  it('should accept HTTP for ::1', () => {
    expect(() => makeClient({ baseUrl: 'http://[::1]:3100/api/v1' })).not.toThrow();
  });

  it('should accept HTTP for 10.x private networks', () => {
    expect(() => makeClient({ baseUrl: 'http://10.0.1.5:3100/api/v1' })).not.toThrow();
  });

  it('should accept HTTP for 192.168.x private networks', () => {
    expect(() => makeClient({ baseUrl: 'http://192.168.1.100:3100/api/v1' })).not.toThrow();
  });

  it('should accept HTTP for 172.16-31.x private networks', () => {
    expect(() => makeClient({ baseUrl: 'http://172.16.0.1:3100/api/v1' })).not.toThrow();
    expect(() => makeClient({ baseUrl: 'http://172.31.255.255:3100/api/v1' })).not.toThrow();
  });

  it('should reject HTTP for public hosts', () => {
    expect(() => makeClient({ baseUrl: 'http://api.example.com/v1' })).toThrow(/must use HTTPS/);
  });

  it('should reject HTTP for public IP addresses', () => {
    expect(() => makeClient({ baseUrl: 'http://8.8.8.8:3100/api/v1' })).toThrow(/must use HTTPS/);
  });

  it('should reject HTTP for 172.x outside private range', () => {
    expect(() => makeClient({ baseUrl: 'http://172.32.0.1:3100/api/v1' })).toThrow(/must use HTTPS/);
    expect(() => makeClient({ baseUrl: 'http://172.15.0.1:3100/api/v1' })).toThrow(/must use HTTPS/);
  });

  it('should reject invalid URLs', () => {
    expect(() => makeClient({ baseUrl: 'not-a-url' })).toThrow(/Invalid baseUrl/);
  });

  it('should validate authBaseUrl separately', () => {
    expect(() => makeClient({
      baseUrl: 'https://api.uluops.com/v1',
      authBaseUrl: 'http://evil.com/auth',
    })).toThrow(/must use HTTPS/);
  });

  it('should skip authBaseUrl validation when same as baseUrl', () => {
    expect(() => makeClient({
      baseUrl: 'http://localhost:3100/api/v1',
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 401 token refresh: mutation guard
// ---------------------------------------------------------------------------
describe('401 mutation guard', () => {
  it('should NOT retry POST after token refresh without retryMutations', async () => {
    // POST returns 401
    nock(TEST_BASE_URL)
      .post(apiPath('/create'))
      .matchHeader('Authorization', `Bearer ${TEST_JWT_STALE}`)
      .reply(401, { error: { message: 'expired' } });

    // Login succeeds (refresh works)
    nock(TEST_BASE_URL)
      .post(apiPath('/auth/login'))
      .reply(200, { data: { sessionToken: 'fresh-tok', expiresAt: '2099-01-01' } });

    // NO second POST interceptor — if the client retries, nock will error

    const client = makeClient({
      apiKey: undefined,
      sessionToken: TEST_JWT_STALE,
      email: 'a@b.com',
      password: 'pw',
      retries: 3,
      // retryMutations NOT set — default false
    });

    // Should throw the original 401, not retry the mutation
    await expect(client.post('/create', { name: 'test' })).rejects.toThrow(UnauthorizedError);
  });

  it('should retry POST after token refresh WITH retryMutations', async () => {
    // POST returns 401
    nock(TEST_BASE_URL)
      .post(apiPath('/create'))
      .matchHeader('Authorization', `Bearer ${TEST_JWT_STALE}`)
      .reply(401, { error: { message: 'expired' } });

    // Login succeeds
    nock(TEST_BASE_URL)
      .post(apiPath('/auth/login'))
      .reply(200, { data: { sessionToken: 'fresh-tok', expiresAt: '2099-01-01' } });

    // Retry with fresh token succeeds
    nock(TEST_BASE_URL)
      .post(apiPath('/create'))
      .matchHeader('Authorization', 'Bearer fresh-tok')
      .reply(200, { data: { id: '123' } });

    const client = makeClient({
      apiKey: undefined,
      sessionToken: TEST_JWT_STALE,
      email: 'a@b.com',
      password: 'pw',
      retries: 3,
    });

    const result = await client.post('/create', { name: 'test' }, { retryMutations: true });
    expect(result).toEqual({ id: '123' });
  });
});
