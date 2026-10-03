/**
 * Server retry opt-out (`details.retryable === false`) — definition-version-comparison
 * spec v0.10.0 §11 item 11, checklist P0s.
 *
 * The tracker's version-dispositions route answers 503 with
 * `details: { retryable: false, reason: 'busy' | 'query_timeout' }` when its
 * isolated pool is saturated or a query times out. Retrying that response only
 * adds load to the pool that refused it, so the SDK must honour the opt-out —
 * and `details.reason` must survive to the thrown error so MCP/CLI consumers can
 * render a typed message.
 *
 * Before 0.19.0 both failed: `createErrorFromStatus` built
 * `ServiceUnavailableError(message, retryAfter, requestId)` and discarded every
 * other detail, and `isRetryable()` decided by status code alone, so every GET
 * 503 was retried. These tests run end to end — nock response -> HttpClient's
 * real `createHttpError` -> `createErrorFromStatus` -> `runWithResilience` — so
 * a regression in any hop fails here, not only a unit-level change.
 */
import nock from 'nock';
import { HttpClient } from '../src/http/http-client.js';
import {
  ServiceUnavailableError,
  SdkApiError,
  createErrorFromStatus,
} from '../src/errors/errors.js';
import { TEST_BASE_URL, TEST_BASE_PATH, TEST_FULL_URL, TEST_API_KEY } from './setup.js';

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
  return `${TEST_BASE_PATH}${endpoint}`;
}

/** Answer every GET to `endpoint` with `status`/`body`, counting attempts. */
function countingReply(endpoint: string, status: number, body: object) {
  const counter = { attempts: 0 };
  nock(TEST_BASE_URL)
    .get(apiPath(endpoint))
    .times(5)
    .reply(() => {
      counter.attempts += 1;
      return [status, body];
    });
  return counter;
}

describe('server retry opt-out, end to end through createErrorFromStatus', () => {
  it.each([
    [503, 'busy'],
    [503, 'query_timeout'],
    [502, 'busy'],
    [504, 'query_timeout'],
  ])('GET %i with details.retryable=false (%s) is not retried and keeps details.reason', async (status, reason) => {
    const counter = countingReply('/dispositions', status, {
      error: { message: 'busy', details: { retryable: false, reason } },
    });
    const retries: number[] = [];
    const client = makeClient({ retries: 3, onRetry: (info) => retries.push(info.attempt) });

    const err = await client.get('/dispositions').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(counter.attempts).toBe(1);
    expect(retries).toEqual([]);
    expect((err as SdkApiError).isRetryable()).toBe(false);
    expect((err as SdkApiError).details?.reason).toBe(reason);
    expect((err as SdkApiError).details?.retryable).toBe(false);
  });

  it('a plain 503 (no details) is still retried', async () => {
    const counter = countingReply('/plain', 503, { error: { message: 'down' } });
    const client = makeClient({ retries: 3 });

    const err = await client.get('/plain').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(counter.attempts).toBe(3);
    expect((err as SdkApiError).isRetryable()).toBe(true);
  });

  it.each([
    ['retryable: true', { retryable: true, reason: 'maintenance' }],
    ['retryable absent', { reason: 'maintenance' }],
  ])('a 503 whose details do not opt out (%s) is still retried and keeps its details', async (_label, details) => {
    const counter = countingReply('/other', 503, { error: { message: 'down', details } });
    const client = makeClient({ retries: 2 });

    const err = await client.get('/other').catch((e: unknown) => e);

    expect(counter.attempts).toBe(2);
    expect((err as SdkApiError).details?.reason).toBe('maintenance');
  });

  it('only a literal `false` opts out — a truthy-looking string does not', async () => {
    const counter = countingReply('/stringy', 503, {
      error: { message: 'down', details: { retryable: 'false' } },
    });
    const client = makeClient({ retries: 2 });

    await client.get('/stringy').catch(() => undefined);

    expect(counter.attempts).toBe(2);
  });
});

describe('createErrorFromStatus threads details into ServiceUnavailableError', () => {
  it.each([503, 502, 504])('%i keeps every detail and merges retryAfter', (status) => {
    const err = createErrorFromStatus(status, 'busy', undefined, {
      retryable: false,
      reason: 'busy',
      retryAfter: 7,
    });

    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err.details).toEqual({ retryable: false, reason: 'busy', retryAfter: 7 });
    expect((err as ServiceUnavailableError).retryAfter).toBe(7);
    expect(err.isRetryable()).toBe(false);
  });

  it('constructor-supplied retryAfter wins over a details.retryAfter', () => {
    const err = new ServiceUnavailableError('down', 9, undefined, { retryAfter: 1, reason: 'x' });
    expect(err.details).toEqual({ retryAfter: 9, reason: 'x' });
    expect(err.retryAfter).toBe(9);
  });

  it('the pre-0.19.0 call shape (message, retryAfter, requestId) is unchanged', () => {
    const err = new ServiceUnavailableError('down', 30, 'req-1');
    expect(err.details).toEqual({ retryAfter: 30 });
    expect(err.requestId).toBe('req-1');
    expect(err.isRetryable()).toBe(true);
  });
});
