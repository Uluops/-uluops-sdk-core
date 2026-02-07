/**
 * Tests for utility helpers: sleep, retry, isPlainObject, isUuid, truncate,
 * parseRateLimitHeaders, toQuery
 */
import {
  sleep,
  retry,
  isPlainObject,
  isUuid,
  truncate,
  parseRateLimitHeaders,
  toQuery,
} from '../src/utils/helpers.js';
import { TEST_UUID } from './setup.js';

// ---------------------------------------------------------------------------
// sleep()
// ---------------------------------------------------------------------------
describe('sleep()', () => {
  it('should resolve after the specified delay', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // allow some tolerance
  });

  it('should resolve with undefined', async () => {
    const result = await sleep(1);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// retry()
// ---------------------------------------------------------------------------
describe('retry()', () => {
  it('should return result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await retry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and eventually succeed', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValue('success');

    const result = await retry(fn, { maxRetries: 3, baseDelayMs: 1 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw after maxRetries exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fail'));
    await expect(retry(fn, { maxRetries: 2, baseDelayMs: 1 })).rejects.toThrow('always fail');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should stop retrying when shouldRetry returns false', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('non-retryable'));
    await expect(
      retry(fn, {
        maxRetries: 5,
        baseDelayMs: 1,
        shouldRetry: () => false,
      })
    ).rejects.toThrow('non-retryable');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should use exponential backoff', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockResolvedValue('done');

    const start = Date.now();
    await retry(fn, { maxRetries: 3, baseDelayMs: 20 });
    const elapsed = Date.now() - start;
    // First retry: 20ms, second retry: 40ms, total ~60ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('should cap delay at maxDelayMs', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockResolvedValue('done');

    const start = Date.now();
    await retry(fn, { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 10 });
    const elapsed = Date.now() - start;
    // Should be capped at 10ms, not 100ms
    expect(elapsed).toBeLessThan(100);
  });

  it('should use defaults when no options provided', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await retry(fn);
    expect(result).toBe(42);
  });

  it('should handle concurrent retry calls independently', async () => {
    let call1Count = 0;
    let call2Count = 0;
    const fn1 = vi.fn(async () => {
      call1Count++;
      if (call1Count < 2) throw new Error('fn1-fail');
      return 'fn1-ok';
    });
    const fn2 = vi.fn(async () => {
      call2Count++;
      if (call2Count < 3) throw new Error('fn2-fail');
      return 'fn2-ok';
    });

    const [r1, r2] = await Promise.all([
      retry(fn1, { maxRetries: 3, baseDelayMs: 1 }),
      retry(fn2, { maxRetries: 3, baseDelayMs: 1 }),
    ]);

    expect(r1).toBe('fn1-ok');
    expect(r2).toBe('fn2-ok');
    expect(fn1).toHaveBeenCalledTimes(2);
    expect(fn2).toHaveBeenCalledTimes(3);
  });

  it('should throw immediately on maxRetries of 1', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('single'));
    await expect(retry(fn, { maxRetries: 1, baseDelayMs: 1 })).rejects.toThrow('single');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// isPlainObject()
// ---------------------------------------------------------------------------
describe('isPlainObject()', () => {
  it('should return true for plain objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it('should return true for Object.create(null) since toString returns [object Object]', () => {
    // Object.prototype.toString.call(Object.create(null)) === '[object Object]'
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it('should return false for arrays', () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject([1, 2])).toBe(false);
  });

  it('should return false for null', () => {
    expect(isPlainObject(null)).toBe(false);
  });

  it('should return false for primitives', () => {
    expect(isPlainObject(42)).toBe(false);
    expect(isPlainObject('string')).toBe(false);
    expect(isPlainObject(true)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });

  it('should return false for Date', () => {
    expect(isPlainObject(new Date())).toBe(false);
  });

  it('should return false for RegExp', () => {
    expect(isPlainObject(/abc/)).toBe(false);
  });

  it('should return false for Map and Set', () => {
    expect(isPlainObject(new Map())).toBe(false);
    expect(isPlainObject(new Set())).toBe(false);
  });

  it('should return true for Object.create(Object.prototype)', () => {
    expect(isPlainObject(Object.create(Object.prototype))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isUuid()
// ---------------------------------------------------------------------------
describe('isUuid()', () => {
  it('should accept valid UUID v4', () => {
    expect(isUuid(TEST_UUID)).toBe(true);
  });

  it('should accept UUID v1', () => {
    expect(isUuid('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(true);
  });

  it('should accept UUID v5', () => {
    expect(isUuid('886313e1-3b8a-5372-9b90-0c9aee199e5d')).toBe(true);
  });

  it('should accept uppercase UUIDs', () => {
    expect(isUuid('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it('should reject strings that are not UUIDs', () => {
    expect(isUuid('')).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('550e8400-e29b-41d4-a716')).toBe(false); // too short
    expect(isUuid('550e8400-e29b-41d4-a716-446655440000-extra')).toBe(false);
    expect(isUuid('gggggggg-gggg-4ggg-8ggg-gggggggggggg')).toBe(false);
  });

  it('should reject UUID with version 0 or 6+', () => {
    // version digit (5th group, first char) must be 1-5
    expect(isUuid('550e8400-e29b-01d4-a716-446655440000')).toBe(false);
    expect(isUuid('550e8400-e29b-61d4-a716-446655440000')).toBe(false);
  });

  it('should reject UUID with invalid variant', () => {
    // variant digit (4th group, first char) must be 8, 9, a, or b
    expect(isUuid('550e8400-e29b-41d4-0716-446655440000')).toBe(false);
    expect(isUuid('550e8400-e29b-41d4-c716-446655440000')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// truncate()
// ---------------------------------------------------------------------------
describe('truncate()', () => {
  it('should return string unchanged if within limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('should truncate and append ... if over limit', () => {
    expect(truncate('hello world', 8)).toBe('hello...');
  });

  it('should handle exact boundary', () => {
    expect(truncate('abcde', 5)).toBe('abcde');
    expect(truncate('abcdef', 5)).toBe('ab...');
  });

  it('should handle very short maxLength', () => {
    expect(truncate('abcdefgh', 3)).toBe('...');
  });

  it('should handle empty string', () => {
    expect(truncate('', 5)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseRateLimitHeaders()
// ---------------------------------------------------------------------------
describe('parseRateLimitHeaders()', () => {
  function makeHeaders(obj: Record<string, string>): Headers {
    return new Headers(obj);
  }

  it('should parse all rate limit headers', () => {
    const headers = makeHeaders({
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '42',
      'x-ratelimit-reset': '1700000000',
    });
    const info = parseRateLimitHeaders(headers);
    expect(info).not.toBeNull();
    expect(info!.limit).toBe(100);
    expect(info!.remaining).toBe(42);
    expect(info!.reset).toEqual(new Date(1700000000 * 1000));
    expect(info!.retryAfter).toBeUndefined();
  });

  it('should include retry-after when present', () => {
    const headers = makeHeaders({
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1700000000',
      'retry-after': '30',
    });
    const info = parseRateLimitHeaders(headers);
    expect(info!.retryAfter).toBe(30);
  });

  it('should return null when required headers are missing', () => {
    const headers = makeHeaders({ 'x-ratelimit-limit': '100' });
    expect(parseRateLimitHeaders(headers)).toBeNull();
  });

  it('should return null when limit is non-numeric', () => {
    const headers = makeHeaders({
      'x-ratelimit-limit': 'abc',
      'x-ratelimit-remaining': '42',
      'x-ratelimit-reset': '1700000000',
    });
    expect(parseRateLimitHeaders(headers)).toBeNull();
  });

  it('should return null when remaining is non-numeric', () => {
    const headers = makeHeaders({
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': 'xyz',
      'x-ratelimit-reset': '1700000000',
    });
    expect(parseRateLimitHeaders(headers)).toBeNull();
  });

  it('should return null when reset is non-numeric', () => {
    const headers = makeHeaders({
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '42',
      'x-ratelimit-reset': 'not-a-number',
    });
    expect(parseRateLimitHeaders(headers)).toBeNull();
  });

  it('should return null when all headers missing', () => {
    const headers = makeHeaders({});
    expect(parseRateLimitHeaders(headers)).toBeNull();
  });

  it('should handle zero values correctly', () => {
    const headers = makeHeaders({
      'x-ratelimit-limit': '0',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '0',
    });
    const info = parseRateLimitHeaders(headers);
    expect(info).not.toBeNull();
    expect(info!.limit).toBe(0);
    expect(info!.remaining).toBe(0);
  });

  it('should handle non-numeric retry-after gracefully', () => {
    const headers = makeHeaders({
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '42',
      'x-ratelimit-reset': '1700000000',
      'retry-after': 'abc',
    });
    const info = parseRateLimitHeaders(headers);
    expect(info).not.toBeNull();
    expect(info!.retryAfter).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// toQuery()
// ---------------------------------------------------------------------------
describe('toQuery()', () => {
  it('should return undefined for undefined input', () => {
    expect(toQuery(undefined)).toBeUndefined();
  });

  it('should filter out undefined values', () => {
    const result = toQuery({ a: 'x', b: undefined, c: 42 });
    expect(result).toEqual({ a: 'x', c: 42 });
    expect(result).not.toHaveProperty('b');
  });

  it('should keep null values', () => {
    const result = toQuery({ a: null });
    expect(result).toEqual({ a: null });
  });

  it('should keep boolean and number values', () => {
    const result = toQuery({ flag: true, count: 0 });
    expect(result).toEqual({ flag: true, count: 0 });
  });

  it('should return empty object for empty input', () => {
    const result = toQuery({});
    expect(result).toEqual({});
  });

  it('should handle all values being undefined', () => {
    const result = toQuery({ a: undefined, b: undefined });
    expect(result).toEqual({});
  });
});
