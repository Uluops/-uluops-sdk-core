/**
 * Live smoke test for the 0.14.0 security-event channel + RedirectError.
 *
 * Unlike the vitest suite (which mocks HTTP via nock), this runs against a REAL
 * local http server with REAL undici `fetch`. Its whole point is to exercise the
 * paths the mock cannot faithfully reproduce — most importantly the redirect
 * rejection, which depends on undici returning `response.type === 'opaqueredirect'`
 * under `redirect: 'manual'`. nock surfaces the raw 3xx instead, so only a live
 * server proves the real detection path.
 *
 * Run against the BUILT artifact (imports ../dist), so it also validates the
 * package's public export surface:
 *
 *   npm run build && node scripts/live-test-security-events.mjs
 *
 * Exit code 0 = all four event types observed + RedirectError thrown; 1 = a gap.
 */
import http from 'node:http';
import { HttpClient, ApiKeyAuth, isRedirectError, NetworkError } from '../dist/index.js';

const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const API_KEY = 'ulr_livetest_key_000000'; // ulr_ + 18 chars = 22 (>= MIN_API_KEY_LENGTH)

// ---------------------------------------------------------------------------
// A tiny server that produces each security-relevant condition on demand.
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const json = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  switch (`${req.method} ${req.url}`) {
    case 'GET /api/v1/auth-fail':
      return json(401, { error: { message: 'invalid api key' } }, { 'x-request-id': 'req-abc-123' });
    case 'GET /api/v1/redirect':
      res.writeHead(302, { location: 'https://evil.example/steal' });
      return res.end();
    case 'GET /api/v1/protected':
      return json(401, { error: { message: 'session expired' } });
    case 'POST /api/v1/auth/login':
      return json(401, { error: { message: 'bad credentials' } }); // refresh re-login fails
    default:
      return json(200, { data: 'ok' });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const seen = new Set();
const label = (s) => `\x1b[36m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;

function makeClient(collector, overrides = {}) {
  return new HttpClient({
    baseUrl: BASE,
    sdkName: '@uluops/sdk-core',
    sdkVersion: 'live-test',
    loggerPrefix: '[live]',
    apiKey: API_KEY,
    onSecurityEvent: (event) => {
      seen.add(event.type);
      collector.push(event);
      console.log(`  ${ok('▸ event')} ${label(event.type)} ${JSON.stringify(redact(event))}`);
    },
    ...overrides,
  });
}

/** Confirm nothing secret leaks into an event we print. */
function redact(event) {
  const { type, timestamp, message, ...rest } = event;
  return { message, ...rest };
}

async function scenario(name, fn) {
  console.log(`\n${label('■ ' + name)}`);
  await fn();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
console.log(`live server on ${BASE}\n`);

let redirectWasTyped = false;

try {
  await scenario('auth_failure — server rejects a sent credential (401)', async () => {
    const events = [];
    await makeClient(events).get('/auth-fail').catch(() => {});
    assert(events.some((e) => e.type === 'auth_failure' && e.authType === 'api_key' && e.requestId === 'req-abc-123'),
      'expected auth_failure with authType=api_key and the server requestId');
  });

  await scenario('redirect_rejected — REAL undici opaqueredirect path', async () => {
    const events = [];
    const err = await makeClient(events).get('/redirect').catch((e) => e);
    redirectWasTyped = isRedirectError(err) && !(err instanceof NetworkError) && err.isRetryable() === false;
    console.log(`  thrown error: ${err?.name} (isRedirectError=${isRedirectError(err)}, retryable=${err?.isRetryable?.()})`);
    assert(redirectWasTyped, 'expected a non-retryable RedirectError (NOT NetworkError)');
    assert(events.some((e) => e.type === 'redirect_rejected' && e.baseUrl === BASE),
      'expected redirect_rejected event carrying baseUrl');
  });

  await scenario('token_refresh_failed — session re-login rejected', async () => {
    const events = [];
    const client = makeClient(events, {
      apiKey: undefined,
      email: 'a@b.com',
      password: 'pw',
      sessionToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdGFsZSJ9.stale_sig',
    });
    // GET /protected → 401 → refresh via POST /auth/login → 401 → refresh fails.
    // A refreshable session suppresses auth_failure (the refresh path owns the
    // signal), so token_refresh_failed is the only event here.
    await client.get('/protected').catch(() => {});
    assert(events.some((e) => e.type === 'token_refresh_failed' && e.authType === 'session'),
      'expected token_refresh_failed with authType=session');
  });

  await scenario('auth_strategy_replaced — live credential swap', async () => {
    const events = [];
    const client = makeClient(events); // starts api_key
    client.setAuthStrategy(new ApiKeyAuth('ulr_swapped_key_000000'));
    client.setAuthStrategy(null);
    assert(events.filter((e) => e.type === 'auth_strategy_replaced').length === 2,
      'expected two auth_strategy_replaced events (api_key→api_key, api_key→none)');
  });

  await scenario('handler robustness — a throwing handler never breaks the request', async () => {
    const client = new HttpClient({
      baseUrl: BASE, sdkName: '@uluops/sdk-core', sdkVersion: 'live-test',
      loggerPrefix: '[live]', apiKey: API_KEY,
      onSecurityEvent: () => { throw new Error('handler boom'); },
    });
    const err = await client.get('/auth-fail').catch((e) => e);
    assert(err?.name === 'UnauthorizedError', 'expected the 401 to still surface as UnauthorizedError');
    console.log(`  ${ok('▸ request still threw')} ${err?.name} (handler throw swallowed)`);
  });

  // -------------------------------------------------------------------------
  const required = ['auth_failure', 'redirect_rejected', 'token_refresh_failed', 'auth_strategy_replaced'];
  const missing = required.filter((t) => !seen.has(t));
  console.log('\n' + '─'.repeat(60));
  if (missing.length === 0 && redirectWasTyped) {
    console.log(ok('✓ ALL FOUR EVENT TYPES OBSERVED + RedirectError typed correctly'));
    console.log(`  observed: ${[...seen].join(', ')}`);
  } else {
    console.log(bad(`✗ gaps: missing=[${missing.join(', ')}] redirectTyped=${redirectWasTyped}`));
    process.exitCode = 1;
  }
} catch (err) {
  console.log(bad(`\n✗ assertion failed: ${err.message}`));
  process.exitCode = 1;
} finally {
  server.close();
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
