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
  it('fires when a sent credential is rejected with 401', async () => {
    const events: SecurityEvent[] = [];
    nock(TEST_BASE_URL).get(apiPath('/e401')).reply(401, { error: { message: 'no auth' } });

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
    nock(TEST_BASE_URL).post(apiPath('/auth/login')).reply(401, { error: { message: 'bad login' } });

    await client_get_ignore(client, '/needsrefresh');

    const refreshFails = events.filter((e) => e.type === 'token_refresh_failed');
    expect(refreshFails).toHaveLength(1);
    if (refreshFails[0].type === 'token_refresh_failed') {
      expect(refreshFails[0].authType).toBe('session');
    }
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
