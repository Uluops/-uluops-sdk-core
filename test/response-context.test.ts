import { describe, it, expect } from 'vitest';
import nock from 'nock';
import { HttpClient } from '../src/http/http-client.js';
import { TEST_BASE_URL, TEST_BASE_PATH, TEST_FULL_URL, TEST_API_KEY } from './setup.js';
const headers = (slug = 'team-a') => ({ 'X-UluOps-Context-Version': '1', 'X-UluOps-Org-Slug': slug, 'X-UluOps-Org-Source': 'bound-key' });
const client = () => new HttpClient({ baseUrl: TEST_FULL_URL, sdkName: 'test', sdkVersion: '1', loggerPrefix: 'test', apiKey: TEST_API_KEY, retries: 0 });
const context = (orgSlug = 'team-a') => ({ version: 1, orgSlug, source: 'bound-key' });
describe('F13 response context', () => {
  it('preserves default shapes and supports opt-in envelopes, raw envelopes and 204', async () => {
    nock(TEST_BASE_URL).get(`${TEST_BASE_PATH}/old`).reply(200, { data: [1] }, headers())
      .get(`${TEST_BASE_PATH}/new`).reply(200, { data: [2] }, headers())
      .get(`${TEST_BASE_PATH}/raw`).reply(200, { data: [3], total: 1 }, headers())
      .delete(`${TEST_BASE_PATH}/empty`).reply(204, undefined, headers());
    const c = client();
    expect(await c.request('GET', '/old')).toEqual([1]);
    expect(await c.request('GET', '/new', undefined, { withResponseContext: true })).toEqual({ data: [2], context: context() });
    expect(await c.request('GET', '/raw', undefined, { withResponseContext: true, rawEnvelope: true })).toEqual({ data: { data: [3], total: 1 }, context: context() });
    expect(await c.request('DELETE', '/empty', undefined, { withResponseContext: true })).toEqual({ data: undefined, context: context() });
  });
  it.each([{}, { ...headers(), 'X-UluOps-Context-Version': '2' }, { ...headers(), 'X-UluOps-Org-Slug': 'invalid slug' }, { ...headers(), 'X-UluOps-Org-Source': 'workspace' }])('keeps successful data with invalid/absent context', async h => {
    nock(TEST_BASE_URL).post(`${TEST_BASE_PATH}/write`).reply(201, { data: { saved: true } }, h);
    expect(await client().request('POST', '/write', {}, { withResponseContext: true })).toEqual({ data: { saved: true }, context: null });
  });
  it('keeps concurrent responses isolated', async () => {
    nock(TEST_BASE_URL).get(`${TEST_BASE_PATH}/a`).delay(30).reply(200, { data: 'A' }, headers('team-a'))
      .get(`${TEST_BASE_PATH}/b`).reply(200, { data: 'B' }, headers('team-b'));
    const c = client();
    const [a,b] = await Promise.all(['a','b'].map(p => c.request('GET', `/${p}`, undefined, { withResponseContext: true })));
    expect(a).toEqual({ data: 'A', context: context('team-a') });
    expect(b).toEqual({ data: 'B', context: context('team-b') });
  });
  it.each([401, 409, 500])('attaches context to final HTTP %s errors', async status => {
    nock(TEST_BASE_URL).post(`${TEST_BASE_PATH}/error`).reply(status, { error: { message: 'Refused' } }, headers());
    await expect(client().request('POST', '/error', {})).rejects.toMatchObject({ responseContext: context() });
  });
  it('attaches same-response context to raw and binary errors', async () => {
    const c = client();
    for (const endpoint of ['/raw-error', '/binary-error']) {
      nock(TEST_BASE_URL).get(`${TEST_BASE_PATH}${endpoint}`).reply(403, { error: { message: 'Refused' } }, headers());
    }
    await expect(c.requestRaw('GET', '/raw-error')).rejects.toMatchObject({ responseContext: context() });
    await expect(c.requestBinary('GET', '/binary-error')).rejects.toMatchObject({ responseContext: context() });
  });
  it('attaches same-response context to auth-fetch HTTP and parse errors', async () => {
    nock(TEST_BASE_URL).post(`${TEST_BASE_PATH}/login`).reply(403, { error: { message: 'Refused' } }, headers())
      .post(`${TEST_BASE_PATH}/login`).reply(200, 'broken-json', headers());
    const auth = client().createFetchClient();
    await expect(auth.post('/login', {})).rejects.toMatchObject({ responseContext: context() });
    await expect(auth.post('/login', {})).rejects.toMatchObject({ responseContext: context() });
  });
  it('preserves context on successful-response parse errors', async () => {
    nock(TEST_BASE_URL).post(`${TEST_BASE_PATH}/error`).reply(201, 'broken-json', headers());
    await expect(client().request('POST', '/error', {})).rejects.toMatchObject({ responseContext: context() });
  });
});
