/**
 * Tests for the streaming transport surface added in 0.15.0:
 * requestStream() / getStream() — full resilience through headers (retry,
 * refresh, redirect rejection, rate-limit tracking, typed non-2xx errors),
 * then hands off the unconsumed 2xx Response. After handoff the transport
 * steps back: no retry, timeout released, body lifetime caller-governed via
 * AbortSignal.
 *
 * The existing suites (http-client.test.ts, security-events.test.ts) are the
 * regression gate for the doFetchCore/runWithResilience extraction and are
 * deliberately untouched — this file covers only the NEW surface.
 *
 * Two harnesses:
 * - nock for pre-headers behavior (retry/refresh/redirect/errors), matching
 *   the existing suites' idiom.
 * - a real local http.Server for post-handoff body-lifecycle behavior
 *   (mid-body abort, timer-after-handoff, no-retry-after-handoff): nock cannot
 *   faithfully model socket-level body streaming, and these tests exist to
 *   verify real undici behavior end to end.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import nock from 'nock';
import { HttpClient } from '../src/http/http-client.js';
import {
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
  TimeoutError,
  isRedirectError,
} from '../src/errors/errors.js';
import type { SecurityEvent } from '../src/http/security-events.js';
import {
  TEST_BASE_URL,
  TEST_BASE_PATH,
  TEST_FULL_URL,
  TEST_API_KEY,
  TEST_JWT_STALE,
} from './setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeClient(
  overrides: Partial<ConstructorParameters<typeof HttpClient>[0]> = {},
  events?: SecurityEvent[]
) {
  return new HttpClient({
    baseUrl: TEST_FULL_URL,
    sdkName: '@uluops/sdk-core',
    sdkVersion: '0.1.0',
    loggerPrefix: '[test]',
    apiKey: TEST_API_KEY,
    ...(events ? { onSecurityEvent: (e: SecurityEvent) => void events.push(e) } : {}),
    ...overrides,
  });
}

function apiPath(endpoint: string): string {
  return `${TEST_BASE_PATH}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
}

const NDJSON_BODY = '{"id":"a","n":1}\n{"id":"b","n":2}\n{"id":"c","n":3}\n';

// ---------------------------------------------------------------------------
// Happy path (nock)
// ---------------------------------------------------------------------------
describe('requestStream() happy path', () => {
  it('returns the 2xx Response with the body UNREAD and streamable', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/export/projects/p1/issues'))
      .reply(200, NDJSON_BODY, {
        'Content-Type': 'application/x-ndjson',
        'X-Export-Total-Rows': '3',
      });

    const client = makeClient();
    const response = await client.requestStream('GET', '/export/projects/p1/issues');

    // Handed off unconsumed: the transport must not have touched the body.
    expect(response.status).toBe(200);
    expect(response.bodyUsed).toBe(false);
    expect(response.body).not.toBeNull();
    // Headers are readable at handoff (the export consumer contract).
    expect(response.headers.get('x-export-total-rows')).toBe('3');

    // The caller can now consume the stream in full.
    expect(await response.text()).toBe(NDJSON_BODY);
  });

  it('getStream() passes query params', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/export/projects/p1/issues'))
      .query({ format: 'ndjson', include_resolved: 'true' })
      .reply(200, NDJSON_BODY);

    const client = makeClient();
    const response = await client.getStream('/export/projects/p1/issues', {
      format: 'ndjson',
      include_resolved: 'true',
    });
    expect(await response.text()).toBe(NDJSON_BODY);
  });

  it('sends the Authorization header (auth parity with request())', async () => {
    const scope = nock(TEST_BASE_URL)
      .get(apiPath('/export'))
      .matchHeader('Authorization', `Bearer ${TEST_API_KEY}`)
      .reply(200, 'x');

    await makeClient().getStream('/export');
    expect(scope.isDone()).toBe(true);
  });

  it('tracks rate-limit headers on the streaming response (getRateLimitInfo + threshold callback)', async () => {
    nock(TEST_BASE_URL).get(apiPath('/export')).reply(200, NDJSON_BODY, {
      'x-ratelimit-limit': '10',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1234567890',
    });

    let approached = false;
    const client = makeClient({ onRateLimitApproaching: () => { approached = true; } });
    await client.getStream('/export');

    expect(client.getRateLimitInfo()).toMatchObject({ limit: 10, remaining: 0 });
    expect(approached).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Non-2xx: buffered envelope, typed errors (parity with request())
// ---------------------------------------------------------------------------
describe('requestStream() non-2xx error parity', () => {
  it('buffers the error envelope and throws the typed error (404)', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/export/projects/nope/issues'))
      .reply(404, { error: { code: 'PROJECT_NOT_FOUND', message: 'project not found' } }, {
        'x-request-id': 'req-123',
      });

    const err = await makeClient()
      .getStream('/export/projects/nope/issues')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).message).toContain('project not found');
    expect((err as NotFoundError).requestId).toBe('req-123');
  });

  it('throws ValidationError on 400 without retrying', async () => {
    const scope = nock(TEST_BASE_URL)
      .get(apiPath('/export'))
      .reply(400, { error: { message: 'bad as_of' } });

    const err = await makeClient({ retries: 3 })
      .getStream('/export')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(scope.isDone()).toBe(true);
    expect(nock.pendingMocks()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Resilience through headers (nock)
// ---------------------------------------------------------------------------
describe('requestStream() resilience before headers', () => {
  it('retries a transient 503 before headers and then streams', async () => {
    nock(TEST_BASE_URL).get(apiPath('/flaky')).reply(503, { error: { message: 'down' } });
    nock(TEST_BASE_URL).get(apiPath('/flaky')).reply(200, NDJSON_BODY);

    const response = await makeClient({ retries: 2 }).getStream('/flaky');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(NDJSON_BODY);
  });

  it('exhausts retries and throws the typed last error', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/dead'))
      .times(2)
      .reply(503, { error: { message: 'still down' } });

    const err = await makeClient({ retries: 2 })
      .getStream('/dead')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
  });

  it('refreshes the token on 401 and retries the stream with the fresh credential', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/protected-stream'))
      .matchHeader('Authorization', `Bearer ${TEST_JWT_STALE}`)
      .reply(401, { error: { message: 'expired' } });
    nock(TEST_BASE_URL)
      .post(apiPath('/auth/login'), { email: 'a@b.com', password: 'pw' })
      .reply(200, { data: { sessionToken: 'refreshed-tok', expiresAt: '2099-01-01' } });
    nock(TEST_BASE_URL)
      .get(apiPath('/protected-stream'))
      .matchHeader('Authorization', 'Bearer refreshed-tok')
      .reply(200, NDJSON_BODY);

    const events: SecurityEvent[] = [];
    const client = makeClient(
      { apiKey: undefined, sessionToken: TEST_JWT_STALE, email: 'a@b.com', password: 'pw', retries: 3 },
      events
    );

    const response = await client.getStream('/protected-stream');
    expect(await response.text()).toBe(NDJSON_BODY);
    // Recovered transparently: the refresh owns the outcome, no auth_failure.
    expect(events.filter((e) => e.type === 'auth_failure')).toHaveLength(0);
  });

  it('throws UnauthorizedError and emits auth_failure exactly once on 401 after a successful refresh', async () => {
    nock(TEST_BASE_URL)
      .get(apiPath('/still-401'))
      .reply(401, { error: { message: 'expired' } });
    nock(TEST_BASE_URL)
      .post(apiPath('/auth/login'))
      .reply(200, { data: { sessionToken: 'fresh-tok', expiresAt: '2099-01-01' } });
    nock(TEST_BASE_URL)
      .get(apiPath('/still-401'))
      .matchHeader('Authorization', 'Bearer fresh-tok')
      .reply(401, { error: { message: 'revoked' } });

    const events: SecurityEvent[] = [];
    const client = makeClient(
      { apiKey: undefined, sessionToken: TEST_JWT_STALE, email: 'a@b.com', password: 'pw', retries: 3 },
      events
    );

    const err = await client.getStream('/still-401').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    // The refreshAttempted guard: the post-refresh, unrecoverable 401 emits —
    // once, not twice (the pre-refresh 401 stays silent; the re-login owns it).
    expect(events.filter((e) => e.type === 'auth_failure')).toHaveLength(1);
  });

  it('refreshes AT MOST ONCE per request: a 401 after a successful refresh never triggers a second login', async () => {
    // Falsifier for the loop-level `!refreshAttempted` guard in
    // runWithResilience. This must use a NON-clearing session strategy: with
    // the default clearCredentialsAfterLogin=true, the CWE-316 credential
    // clearing independently blocks a second refresh (canRefresh() flips
    // false after login), masking a removed loop guard. Only the long-lived
    // non-clearing session exercises the guard itself — remove it and the
    // second 401 kicks off a SECOND login (consuming extraLogin below) plus a
    // third request attempt.
    const { JwtSessionAuth } = await import('../src/http/auth-strategy.js');
    const client = makeClient({ apiKey: undefined, retries: 4 });
    client.setAuthStrategy(
      new JwtSessionAuth(
        client.createFetchClient(),
        { email: 'a@b.com', password: 'pw' },
        undefined,
        TEST_JWT_STALE,
        false, // clearCredentialsAfterLogin = false — canRefresh() stays true after refresh
      )
    );

    nock(TEST_BASE_URL)
      .get(apiPath('/seq-401'))
      .reply(401, { error: { message: 'expired' } });
    nock(TEST_BASE_URL)
      .post(apiPath('/auth/login'))
      .reply(200, { data: { sessionToken: 'fresh-tok', expiresAt: '2099-01-01' } });
    nock(TEST_BASE_URL)
      .get(apiPath('/seq-401'))
      .matchHeader('Authorization', 'Bearer fresh-tok')
      .reply(401, { error: { message: 'revoked' } });
    // Bait for the mutant: a second login interceptor that a correct client
    // must never consume.
    const extraLogin = nock(TEST_BASE_URL)
      .post(apiPath('/auth/login'))
      .reply(200, { data: { sessionToken: 'should-never-be-fetched', expiresAt: '2099-01-01' } });

    const err = await client.getStream('/seq-401').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(extraLogin.isDone()).toBe(false);
  });

  it('retryMutations allows a POST stream to retry a transient 503 before headers', async () => {
    nock(TEST_BASE_URL).post(apiPath('/flaky-post')).reply(503, { error: { message: 'down' } });
    nock(TEST_BASE_URL).post(apiPath('/flaky-post')).reply(201, NDJSON_BODY);

    const response = await makeClient({ retries: 2 }).requestStream('POST', '/flaky-post', {
      retryMutations: true,
    });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe(NDJSON_BODY);
  });

  it('handles a 2xx stream with an empty body', async () => {
    nock(TEST_BASE_URL).get(apiPath('/empty-stream')).reply(200, '');

    const response = await makeClient().getStream('/empty-stream');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('rejects a raw-3xx redirect with RedirectError + redirect_rejected before any body handoff', async () => {
    const events: SecurityEvent[] = [];
    nock(TEST_BASE_URL)
      .get(apiPath('/redir-stream'))
      .reply(302, undefined, { Location: 'https://evil.example/steal' });

    const err = await makeClient({}, events)
      .getStream('/redir-stream')
      .catch((e: unknown) => e);

    expect(isRedirectError(err)).toBe(true);
    expect(events.filter((e) => e.type === 'redirect_rejected')).toHaveLength(1);
  });

  it('rejects an opaqueredirect (real undici manual-mode signal) the same way', async () => {
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
      const err = await makeClient({}, events)
        .getStream('/opaque-stream')
        .catch((e: unknown) => e);
      expect(isRedirectError(err)).toBe(true);
      expect(events.some((e) => e.type === 'redirect_rejected')).toBe(true);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Post-handoff contract (real local HTTP server — nock cannot model
// socket-level body streaming)
// ---------------------------------------------------------------------------
describe('requestStream() post-handoff contract (live socket)', () => {
  let server: Server;
  let baseUrl: string;
  let requestCount: number;

  afterEach(async () => {
    if (!server) return;
    // hung-body/die-mid-body leave sockets open — force-close them so the
    // close callback actually fires and no socket leaks across tests.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Start a server on an ephemeral loopback port; sets `baseUrl` for clients. */
  async function startServer(handler: Parameters<typeof createServer>[1]): Promise<void> {
    requestCount = 0;
    server = createServer((req, res) => {
      requestCount++;
      handler!(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/api/v1`;
  }

  it('timeout covers time-to-headers only: a body slower than the timeout still completes', async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      // Dribble the body across 3 × 60ms = ~180ms, far past the 100ms timeout.
      // If the internal timer were still armed after handoff, this read would
      // abort mid-body.
      let i = 0;
      const iv = setInterval(() => {
        res.write(`{"n":${i}}\n`);
        if (++i === 3) {
          clearInterval(iv);
          res.end();
        }
      }, 60);
    });

    const response = await makeClient({ baseUrl, timeout: 100 }).getStream('/slow-body');
    const text = await response.text();
    expect(text).toBe('{"n":0}\n{"n":1}\n{"n":2}\n');
  });

  it('timeout before headers still fires as TimeoutError', async () => {
    await startServer((_req, res) => {
      // Never send headers within the timeout window.
      setTimeout(() => {
        res.writeHead(200);
        res.end('late');
      }, 500);
    });

    const err = await makeClient({ baseUrl, timeout: 50 })
      .getStream('/slow-headers')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
  });

  it('caller AbortSignal cancels mid-body', async () => {
    const controller = new AbortController();
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write('{"n":0}\n');
      // Keep the connection open; more data never arrives.
    });

    const response = await makeClient({ baseUrl }).getStream('/hung-body', undefined, {
      signal: controller.signal,
    });

    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('{"n":0}\n');

    // The idle-watchdog pattern (BFF D13.3): abort the caller signal mid-body.
    setTimeout(() => controller.abort(), 20);
    await expect(reader.read()).rejects.toThrow();
  });

  it('caller AbortSignal aborting BEFORE headers propagates as an abort, not a TimeoutError', async () => {
    const controller = new AbortController();
    await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end('late');
      }, 500);
    });

    setTimeout(() => controller.abort(), 20);
    const err = await makeClient({ baseUrl, timeout: 5_000 })
      .getStream('/pre-headers-abort', undefined, { signal: controller.signal })
      .catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(TimeoutError);
    expect((err as Error).name).toBe('AbortError');
  });

  it('caller abort works without AbortSignal.any (Node 20.0–20.2 fallback composition)', async () => {
    // The engines floor (>=20.3.0) is advisory; the signal-passing path is the
    // flagship BFF idle-watchdog path and must not crash on older 20.x. Hide
    // AbortSignal.any and verify the manual composition still cancels mid-body.
    const anyFn = AbortSignal.any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (AbortSignal as any).any = undefined;
    try {
      const controller = new AbortController();
      await startServer((_req, res) => {
        res.writeHead(200);
        res.write('{"n":0}\n');
        // Keep open; nothing more arrives.
      });

      const response = await makeClient({ baseUrl }).getStream('/fallback-abort', undefined, {
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      await reader.read();
      setTimeout(() => controller.abort(), 20);
      await expect(reader.read()).rejects.toThrow();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (AbortSignal as any).any = anyFn;
    }
  });

  it('a chunked stream that dies mid-body surfaces an error (incomplete chunked framing is LOUD)', async () => {
    // No Content-Length → Node auto-chunks. Destroying the socket before the
    // terminal zero-chunk leaves the framing incomplete, and undici rejects
    // the read. This is the loud truncation variant.
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); // chunked
      res.write('{"n":0}\n');
      setTimeout(() => res.destroy(), 30);
    });

    const response = await makeClient({ baseUrl }).getStream('/chunked-die');
    await expect(response.text()).rejects.toThrow();
    expect(requestCount).toBe(1); // and still no retry after handoff
  });

  it('a chunked stream ended cleanly-but-early reads as SUCCESS — silent truncation is real and is the consumer\'s integrity check to catch', async () => {
    // The server "completes" the response after fewer rows than intended
    // (crash-then-graceful-shutdown, buggy upstream loop, proxy cut with clean
    // FIN). The chunked framing is VALID — terminal zero-chunk sent — so no
    // transport layer can flag it. This test pins the reality that motivates
    // the export design's in-band verification (X-Export-Total-Rows counted by
    // the consumer, spec D6/D14): the ONLY defense against this variant lives
    // in the consumer, not the transport.
    await startServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'X-Export-Total-Rows': '3', // promised three...
      });
      res.write('{"n":0}\n');
      res.end(); // ...delivered one, cleanly.
    });

    const response = await makeClient({ baseUrl }).getStream('/chunked-early-end');
    const text = await response.text(); // resolves — NO error
    const rows = text.split('\n').filter(Boolean).length;
    expect(rows).toBe(1);
    expect(Number(response.headers.get('x-export-total-rows'))).toBe(3);
    // rows !== total: detectable ONLY by the consumer comparing in-band count.
  });

  it('never retries after body handoff: a mid-body death is the consumer\'s to detect', async () => {
    await startServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Content-Length': '1000', // promise more than we deliver
      });
      res.write('{"n":0}\n');
      // Kill the socket mid-body — the classic 200-then-die.
      setTimeout(() => res.destroy(), 30);
    });

    const response = await makeClient({ baseUrl, retries: 3 }).getStream('/die-mid-body');
    expect(response.status).toBe(200);

    // The body read fails...
    await expect(response.text()).rejects.toThrow();
    // ...and the transport did NOT re-issue the request (retries only before headers).
    expect(requestCount).toBe(1);
  });
});
