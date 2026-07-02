/**
 * Tests for the structured security-event channel (`onSecurityEvent`) and
 * redirect rejection (`RedirectError`), added in 0.14.0.
 *
 * Covers:
 * - auth_failure on a credentialed 401
 * - token_refresh_failed when re-login is rejected
 * - auth_strategy_replaced on setAuthStrategy
 * - redirect_rejected + RedirectError (non-retryable) on a 3xx from the origin
 * - a throwing handler never breaks request flow
 * - RedirectError shape / retryability / type guard
 */
import nock from 'nock';
import { HttpClient } from '../src/http/http-client.js';
import { JwtSessionAuth } from '../src/http/auth-strategy.js';
import { RedirectError, isRedirectError, NetworkError } from '../src/errors/errors.js';
import type { SecurityEvent } from '../src/http/security-events.js';
import { TEST_BASE_URL, TEST_BASE_PATH, TEST_FULL_URL, TEST_API_KEY, TEST_JWT_STALE } from './setup.js';

function apiPath(endpoint: string): string {
  return `${TEST_BASE_PATH}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
}

function makeClient(
  events: SecurityEvent[],
  overrides: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}
) {
  return new HttpClient({
    baseUrl: TEST_FULL_URL,
    sdkName: '@uluops/sdk-core',
    sdkVersion: '0.1.0',
    loggerPrefix: '[test]',
    apiKey: TEST_API_KEY,
    onSecurityEvent: (e) => events.push(e),
    ...overrides,
  });
}

describe('onSecurityEvent — auth_failure', () => {
  it('fires when a sent credential is rejected with 401, propagating the server requestId', async () => {
    const events: SecurityEvent[] = [];
    nock(TEST_BASE_URL)
      .get(apiPath('/e401'))
      .reply(401, { error: { message: 'no auth' } }, { 'x-request-id': 'req-xyz-1' });

    await client_get_ignore(makeClient(events), '/e401');

    const authFailures = events.filter((e) => e.type === 'auth_failure');
    expect(authFailures).toHaveLength(1);
    const evt = authFailures[0];
    expect(evt.type).toBe('auth_failure');
    if (evt.type === 'auth_failure') {
      expect(evt.authType).toBe('api_key');
      expect(evt.statusCode).toBe(401);
      expect(evt.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(evt.message).toContain('api_key');
      // Guards the `requestId: base.requestId` propagation (server correlation id).
      expect(evt.requestId).toBe('req-xyz-1');
    }
  });

  it('fires on requestRaw/requestBinary paths too (executeFetch 401 is terminal)', async () => {
    // requestRaw/requestBinary go through executeFetch, which never refreshes, so
    // a 401 there is a hard rejection and must not be silent on the channel.
    const events: SecurityEvent[] = [];
    nock(TEST_BASE_URL)
      .get(apiPath('/raw401'))
      .reply(401, { error: { message: 'nope' } }, { 'x-request-id': 'raw-req-2' });

    await makeClient(events)
      .requestRaw('GET', '/raw401')
      .catch(() => undefined);

    const authFailures = events.filter((e) => e.type === 'auth_failure');
    expect(authFailures).toHaveLength(1);
    if (authFailures[0].type === 'auth_failure') {
      expect(authFailures[0].authType).toBe('api_key');
      expect(authFailures[0].requestId).toBe('raw-req-2');
    }
  });

  it('does not fire auth_failure when no credentials are configured', async () => {
    const events: SecurityEvent[] = [];
    nock(TEST_BASE_URL).get(apiPath('/noauth401')).reply(401);

    await client_get_ignore(makeClient(events, { apiKey: undefined }), '/noauth401');

    expect(events.filter((e) => e.type === 'auth_failure')).toHaveLength(0);
  });
});

describe('onSecurityEvent — auth_strategy_replaced', () => {
  it('fires on setAuthStrategy with previous/new types', () => {
    const events: SecurityEvent[] = [];
    const client = makeClient(events); // starts with api_key
    client.setAuthStrategy(null);

    const swaps = events.filter((e) => e.type === 'auth_strategy_replaced');
    expect(swaps).toHaveLength(1);
    const evt = swaps[0];
    if (evt.type === 'auth_strategy_replaced') {
      expect(evt.previousType).toBe('api_key');
      expect(evt.newType).toBe('none');
    }
  });
});

describe('onSecurityEvent — token_refresh_failed', () => {
  it('fires when re-login is rejected during 401 refresh', async () => {
    const events: SecurityEvent[] = [];
    // Stale session token that can refresh (email/password present), but the
    // login endpoint rejects the refresh.
    const client = makeClient(events, {
      apiKey: undefined,
      email: 'a@b.com',
      password: 'pw',
      sessionToken: TEST_JWT_STALE,
    });

    nock(TEST_BASE_URL).get(apiPath('/needsrefresh')).reply(401, { error: { message: 'expired' } });
    nock(TEST_BASE_URL)
      .post(apiPath('/auth/login'))
      .reply(401, { error: { message: 'bad login' } }, { 'x-request-id': 'refresh-req-9' });

    await client_get_ignore(client, '/needsrefresh');

    const refreshFails = events.filter((e) => e.type === 'token_refresh_failed');
    expect(refreshFails).toHaveLength(1);
    if (refreshFails[0].type === 'token_refresh_failed') {
      expect(refreshFails[0].authType).toBe('session');
      // Correlation id from the refresh rejection propagates to the event.
      expect(refreshFails[0].requestId).toBe('refresh-req-9');
    }
    // A refreshable 401 must NOT also emit auth_failure — that would double-signal
    // and page consumers on routine token rotation. token_refresh_failed is the
    // single correct signal for a failed re-login.
    expect(events.filter((e) => e.type === 'auth_failure')).toHaveLength(0);
  });

  it('does not emit auth_failure on a refreshable 401 that recovers', async () => {
    const events: SecurityEvent[] = [];
    const client = makeClient(events, {
      apiKey: undefined,
      email: 'a@b.com',
      password: 'pw',
      sessionToken: TEST_JWT_STALE,
    });
    nock(TEST_BASE_URL).get(apiPath('/rotate')).reply(401, { error: { message: 'expired' } });
    nock(TEST_BASE_URL)
      .post(apiPath('/auth/login'))
      .reply(200, { data: { sessionToken: 'fresh-tok', expiresAt: '2099-01-01' } });
    nock(TEST_BASE_URL).get(apiPath('/rotate')).reply(200, { data: 'ok' });

    await client_get_ignore(client, '/rotate');

    // Routine expiry → refresh succeeds → NO security event of any kind.
    expect(events).toHaveLength(0);
  });

  it('emits auth_failure on a second 401 after a successful refresh (no silent dead-zone, non-clearing session)', async () => {
    // With clearCredentialsAfterLogin:false (MCP/daemon mode), canRefresh() stays
    // true after a refresh. Suppression keys on refreshAttempted, not canRefresh,
    // so the second — genuinely unrecoverable — 401 still surfaces auth_failure
    // rather than going silent.
    const events: SecurityEvent[] = [];
    const client = makeClient(events, {
      apiKey: undefined,
      email: 'a@b.com',
      password: 'pw',
      sessionToken: TEST_JWT_STALE,
    });
    // Swap in a non-clearing session strategy (not reachable via HttpClientConfig),
    // sharing the client's own fetch client for login. Reset events after the swap.
    const nonClearing = new JwtSessionAuth(
      client.createFetchClient(),
      { email: 'a@b.com', password: 'pw' },
      undefined,
      TEST_JWT_STALE,
      false, // clearCredentialsAfterLogin = false
    );
    client.setAuthStrategy(nonClearing);
    events.length = 0;

    nock(TEST_BASE_URL).get(apiPath('/twice')).reply(401, { error: { message: 'expired' } });
    nock(TEST_BASE_URL)
      .post(apiPath('/auth/login'))
      .reply(200, { data: { sessionToken: 'fresh-tok', expiresAt: '2099-01-01' } });
    nock(TEST_BASE_URL).get(apiPath('/twice')).reply(401, { error: { message: 'revoked' } });

    await client_get_ignore(client, '/twice');

    // The second 401 (post-refresh, unrecoverable) must emit auth_failure.
    expect(events.some((e) => e.type === 'auth_failure')).toBe(true);
  });
});

describe('redirect rejection', () => {
  it('throws RedirectError (not NetworkError) and fires redirect_rejected on a 3xx from the origin', async () => {
    const events: SecurityEvent[] = [];
    nock(TEST_BASE_URL)
      .get(apiPath('/redir'))
      .reply(302, undefined, { Location: 'https://evil.example/steal' });

    const err = await makeClient(events)
      .get('/redir')
      .catch((e: unknown) => e);

    expect(isRedirectError(err)).toBe(true);
    expect(err).not.toBeInstanceOf(NetworkError);
    expect((err as RedirectError).isRetryable()).toBe(false);

    const redir = events.filter((e) => e.type === 'redirect_rejected');
    expect(redir).toHaveLength(1);
    if (redir[0].type === 'redirect_rejected') {
      expect(redir[0].baseUrl).toBe(TEST_FULL_URL);
    }
  });

  it('fires redirect_rejected + RedirectError via the real opaqueredirect signal (undici path)', async () => {
    // nock surfaces the raw 3xx status (Signal 2, the fallback). Real undici under
    // redirect:'manual' masks a redirect to status 0 + type:'opaqueredirect'
    // (Signal 1 — the production path). Stub fetch to emit exactly that so the
    // primary detection branch has automated coverage: without this test, deleting
    // the `response.type === 'opaqueredirect'` check passes CI while production
    // redirect blocking silently breaks. Complements the live smoke test.
    const events: SecurityEvent[] = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      type: 'opaqueredirect',
      status: 0,
      ok: false,
      headers: new Headers(),
      json: async () => ({}),
      text: async () => '',
    })) as unknown as typeof fetch;
    try {
      const err = await makeClient(events)
        .get('/opaque')
        .catch((e: unknown) => e);
      expect(isRedirectError(err)).toBe(true);
      expect((err as RedirectError).isRetryable()).toBe(false);
      expect(events.some((e) => e.type === 'redirect_rejected')).toBe(true);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('does NOT treat a 304 Not Modified as a redirect (no RedirectError, no event)', async () => {
    // 304 is in the 3xx band but is a normal conditional-GET response, not a
    // redirect. A naive 300-399 check would flag it and page "MITM" on every
    // ETag/CDN cache hit. It must pass through to normal (non-redirect) handling.
    const events: SecurityEvent[] = [];
    nock(TEST_BASE_URL).get(apiPath('/cond')).reply(304);

    const err = await makeClient(events)
      .get('/cond')
      .catch((e: unknown) => e);

    expect(isRedirectError(err)).toBe(false);
    expect(events.filter((e) => e.type === 'redirect_rejected')).toHaveLength(0);
  });

  it('reports authBaseUrl (not baseUrl) when the login/refresh POST is redirected', async () => {
    // The auth POST hits authBaseUrl. A redirect there — the credential-carrying
    // login — must name authBaseUrl in the telemetry, not baseUrl (the registry
    // SDK runs authBaseUrl != baseUrl).
    const AUTH_BASE = `${TEST_BASE_URL}/auth/v1`;
    const events: SecurityEvent[] = [];
    const client = makeClient(events, {
      apiKey: undefined,
      email: 'a@b.com',
      password: 'pw',
      sessionToken: TEST_JWT_STALE,
      authBaseUrl: AUTH_BASE,
    });
    nock(TEST_BASE_URL).get(apiPath('/needs-auth')).reply(401, { error: { message: 'expired' } });
    nock(TEST_BASE_URL)
      .post('/auth/v1/auth/login')
      .reply(302, undefined, { Location: 'https://evil.example/' });

    await client_get_ignore(client, '/needs-auth');

    const redir = events.filter((e) => e.type === 'redirect_rejected');
    expect(redir).toHaveLength(1);
    if (redir[0].type === 'redirect_rejected') {
      expect(redir[0].baseUrl).toBe(AUTH_BASE);
    }
  });

  it('does not retry a redirect (single upstream hit)', async () => {
    const events: SecurityEvent[] = [];
    const scope = nock(TEST_BASE_URL)
      .get(apiPath('/redir-once'))
      .reply(302, undefined, { Location: 'https://evil.example/' });

    await makeClient(events)
      .get('/redir-once')
      .catch(() => undefined);

    // GET is retryable by default; a RedirectError must NOT trigger a retry.
    expect(scope.isDone()).toBe(true);
    expect(scope.pendingMocks()).toHaveLength(0);
  });
});

describe('handler robustness', () => {
  it('a throwing onSecurityEvent handler does not break the request', async () => {
    nock(TEST_BASE_URL).get(apiPath('/ok')).reply(401, { error: { message: 'x' } });
    const client = new HttpClient({
      baseUrl: TEST_FULL_URL,
      sdkName: '@uluops/sdk-core',
      sdkVersion: '0.1.0',
      loggerPrefix: '[test]',
      apiKey: TEST_API_KEY,
      onSecurityEvent: () => {
        throw new Error('handler boom');
      },
    });

    // The 401 still surfaces as an UnauthorizedError — the handler throw is swallowed.
    const err = await client.get('/ok').catch((e: unknown) => e);
    expect((err as Error).name).toBe('UnauthorizedError');
  });

  it('an async handler that rejects does not surface as an unhandled rejection', async () => {
    // The handler type is (e)=>void, but TS void-assignability lets consumers pass
    // an async handler. A post-await rejection must be caught internally, not crash
    // the process. We assert the request still surfaces its normal error and that
    // no rejection escapes (a leaked rejection would fail the test run).
    nock(TEST_BASE_URL).get(apiPath('/async-boom')).reply(401, { error: { message: 'x' } });
    const client = new HttpClient({
      baseUrl: TEST_FULL_URL,
      sdkName: '@uluops/sdk-core',
      sdkVersion: '0.1.0',
      loggerPrefix: '[test]',
      apiKey: TEST_API_KEY,
      onSecurityEvent: async () => {
        await Promise.resolve();
        throw new Error('async handler boom');
      },
    });
    const err = await client.get('/async-boom').catch((e: unknown) => e);
    expect((err as Error).name).toBe('UnauthorizedError');
    // Give any (incorrectly) leaked rejection a tick to surface before the test ends.
    await new Promise((r) => setTimeout(r, 10));
  });

  it('works with no handler configured', async () => {
    nock(TEST_BASE_URL).get(apiPath('/plain')).reply(200, { data: 'ok' });
    const client = new HttpClient({
      baseUrl: TEST_FULL_URL,
      sdkName: '@uluops/sdk-core',
      sdkVersion: '0.1.0',
      loggerPrefix: '[test]',
      apiKey: TEST_API_KEY,
    });
    await expect(client.get('/plain')).resolves.toBe('ok');
  });
});

describe('baseUrl credential safety', () => {
  it('rejects a baseUrl with embedded user credentials (would leak via error/event origin)', () => {
    expect(
      () =>
        new HttpClient({
          baseUrl: 'https://user:secret@api.example.com/v1',
          sdkName: '@uluops/sdk-core',
          sdkVersion: '0.1.0',
          loggerPrefix: '[test]',
          apiKey: TEST_API_KEY,
        })
    ).toThrow(/must not contain embedded user credentials/);
  });
});

describe('RedirectError shape', () => {
  it('is non-retryable, carries the REDIRECT_ERROR code, and is guarded', () => {
    const err = new RedirectError(TEST_FULL_URL);
    expect(err.name).toBe('RedirectError');
    expect(err.code).toBe('REDIRECT_ERROR');
    expect(err.statusCode).toBe(0);
    expect(err.isRetryable()).toBe(false);
    expect(isRedirectError(err)).toBe(true);
    expect(err.message).toContain(TEST_FULL_URL);
  });
});

/** Fire a GET, discard success/failure — for tests asserting only on emitted events. */
async function client_get_ignore(client: HttpClient, endpoint: string): Promise<void> {
  await client.get(endpoint).catch(() => undefined);
}
