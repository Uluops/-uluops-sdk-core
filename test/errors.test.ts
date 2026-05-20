/**
 * Tests for error hierarchy, factory, type guards, retryability, and toJSON
 */
import {
  SdkApiError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  PayloadTooLargeError,
  UnprocessableError,
  RateLimitError,
  ServiceUnavailableError,
  NetworkError,
  TimeoutError,
  createErrorFromStatus,
  isSdkApiError,
  isValidationError,
  isNotFoundError,
  isConflictError,
  isUnprocessableError,
  isRateLimitError,
} from '../src/errors/errors.js';
import { HTTP_STATUS, ERROR_CODES } from '../src/config/constants.js';

// ---------------------------------------------------------------------------
// SdkApiError (base)
// ---------------------------------------------------------------------------
describe('SdkApiError', () => {
  it('should set all properties', () => {
    const err = new SdkApiError(500, 'boom', 'MY_CODE', { foo: 'bar' }, 'req-1');
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(500);
    expect(err.message).toBe('boom');
    expect(err.code).toBe('MY_CODE');
    expect(err.details).toEqual({ foo: 'bar' });
    expect(err.requestId).toBe('req-1');
    expect(err.name).toBe('SdkApiError');
  });

  it('should default code to UNKNOWN when omitted', () => {
    const err = new SdkApiError(418, 'teapot');
    expect(err.code).toBe(ERROR_CODES.UNKNOWN);
    expect(err.details).toBeUndefined();
    expect(err.requestId).toBeUndefined();
  });

  it('should have a stack trace', () => {
    const err = new SdkApiError(500, 'boom');
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('SdkApiError');
  });
});

// ---------------------------------------------------------------------------
// Concrete error subclasses
// ---------------------------------------------------------------------------
describe('ValidationError', () => {
  it('should set statusCode 400 and VALIDATION_ERROR code', () => {
    const err = new ValidationError('bad input', { field: 'name' });
    expect(err.statusCode).toBe(HTTP_STATUS.BAD_REQUEST);
    expect(err.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    expect(err.name).toBe('ValidationError');
    expect(err.message).toBe('bad input');
    expect(err.details).toEqual({ field: 'name' });
  });

  it('should be instanceof SdkApiError', () => {
    const err = new ValidationError('oops');
    expect(err).toBeInstanceOf(SdkApiError);
  });
});

describe('UnauthorizedError', () => {
  it('should default message', () => {
    const err = new UnauthorizedError();
    expect(err.statusCode).toBe(HTTP_STATUS.UNAUTHORIZED);
    expect(err.code).toBe(ERROR_CODES.UNAUTHORIZED);
    expect(err.name).toBe('UnauthorizedError');
    expect(err.message).toBe('Authentication required');
  });

  it('should accept custom message', () => {
    const err = new UnauthorizedError('custom');
    expect(err.message).toBe('custom');
  });
});

describe('ForbiddenError', () => {
  it('should default message', () => {
    const err = new ForbiddenError();
    expect(err.statusCode).toBe(HTTP_STATUS.FORBIDDEN);
    expect(err.code).toBe(ERROR_CODES.FORBIDDEN);
    expect(err.name).toBe('ForbiddenError');
    expect(err.message).toBe('Access denied');
  });

  it('should accept custom message', () => {
    const err = new ForbiddenError('nope');
    expect(err.message).toBe('nope');
  });
});

describe('NotFoundError', () => {
  it('should format message with identifier', () => {
    const err = new NotFoundError('Project', 'abc');
    expect(err.statusCode).toBe(HTTP_STATUS.NOT_FOUND);
    expect(err.code).toBe(ERROR_CODES.NOT_FOUND);
    expect(err.name).toBe('NotFoundError');
    expect(err.message).toBe("Project 'abc' not found");
    expect(err.details).toEqual({ resource: 'Project', identifier: 'abc' });
  });

  it('should format message without identifier', () => {
    const err = new NotFoundError('Widget');
    expect(err.message).toBe('Widget not found');
    expect(err.details).toEqual({ resource: 'Widget' });
  });
});

describe('ConflictError', () => {
  it('should set statusCode 409 and CONFLICT code', () => {
    const err = new ConflictError('duplicate', { key: 'val' });
    expect(err.statusCode).toBe(HTTP_STATUS.CONFLICT);
    expect(err.code).toBe(ERROR_CODES.CONFLICT);
    expect(err.name).toBe('ConflictError');
    expect(err.message).toBe('duplicate');
    expect(err.details).toEqual({ key: 'val' });
  });
});

describe('PayloadTooLargeError', () => {
  it('should default message and include maxSize', () => {
    const err = new PayloadTooLargeError(undefined, 1024);
    expect(err.statusCode).toBe(HTTP_STATUS.PAYLOAD_TOO_LARGE);
    expect(err.code).toBe(ERROR_CODES.PAYLOAD_TOO_LARGE);
    expect(err.name).toBe('PayloadTooLargeError');
    expect(err.message).toBe('Request payload too large');
    expect(err.details).toEqual({ maxSize: 1024 });
  });

  it('should use custom message', () => {
    const err = new PayloadTooLargeError('too big');
    expect(err.message).toBe('too big');
  });
});

describe('UnprocessableError', () => {
  it('should set statusCode 422 and UNPROCESSABLE_ENTITY code', () => {
    const err = new UnprocessableError('cannot process', { reason: 'x' });
    expect(err.statusCode).toBe(HTTP_STATUS.UNPROCESSABLE_ENTITY);
    expect(err.code).toBe(ERROR_CODES.UNPROCESSABLE_ENTITY);
    expect(err.name).toBe('UnprocessableError');
    expect(err.details).toEqual({ reason: 'x' });
  });
});

describe('RateLimitError', () => {
  it('should include retryAfter in message when provided', () => {
    const err = new RateLimitError(undefined, 60);
    expect(err.statusCode).toBe(HTTP_STATUS.TOO_MANY_REQUESTS);
    expect(err.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(err.name).toBe('RateLimitError');
    expect(err.retryAfter).toBe(60);
    expect(err.message).toContain('60');
    expect(err.details).toEqual({ retryAfter: 60 });
  });

  it('should handle missing retryAfter', () => {
    const err = new RateLimitError();
    expect(err.retryAfter).toBeUndefined();
    expect(err.message).toBe('Rate limit exceeded');
  });

  it('should accept custom message', () => {
    const err = new RateLimitError('Per-project rate limit exceeded', 30);
    expect(err.message).toBe('Per-project rate limit exceeded');
    expect(err.retryAfter).toBe(30);
  });
});

describe('ServiceUnavailableError', () => {
  it('should set statusCode 503 and include retryAfter', () => {
    const err = new ServiceUnavailableError('down', 30);
    expect(err.statusCode).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
    expect(err.code).toBe(ERROR_CODES.SERVICE_UNAVAILABLE);
    expect(err.name).toBe('ServiceUnavailableError');
    expect(err.retryAfter).toBe(30);
    expect(err.details).toEqual({ retryAfter: 30 });
  });

  it('should default message', () => {
    const err = new ServiceUnavailableError();
    expect(err.message).toBe('Service temporarily unavailable');
  });
});

describe('NetworkError', () => {
  it('should include hint with baseUrl', () => {
    const err = new NetworkError('ECONNREFUSED', 'http://localhost:3100');
    expect(err.statusCode).toBe(0);
    expect(err.code).toBe(ERROR_CODES.NETWORK_ERROR);
    expect(err.name).toBe('NetworkError');
    expect(err.message).toContain('ECONNREFUSED');
    expect(err.message).toContain('http://localhost:3100');
    expect(err.details).toEqual({ baseUrl: 'http://localhost:3100' });
  });

  it('should produce generic hint without baseUrl', () => {
    const err = new NetworkError('network fail');
    expect(err.message).toContain('Check your connection');
    expect(err.details).toBeUndefined();
  });
});

describe('TimeoutError', () => {
  it('should include timeout ms and suggest doubling', () => {
    const err = new TimeoutError(5000);
    expect(err.statusCode).toBe(-1);
    expect(err.code).toBe(ERROR_CODES.TIMEOUT);
    expect(err.name).toBe('TimeoutError');
    expect(err.message).toContain('5000ms');
    expect(err.message).toContain('60000'); // max(10000, 60000)
    expect(err.details).toEqual({ timeoutMs: 5000 });
  });

  it('should suggest double when that exceeds 60000', () => {
    const err = new TimeoutError(40000);
    expect(err.message).toContain('80000'); // max(80000, 60000) = 80000
  });
});

// ---------------------------------------------------------------------------
// isRetryable()
// ---------------------------------------------------------------------------
describe('isRetryable()', () => {
  it.each([
    [HTTP_STATUS.BAD_GATEWAY, true],
    [HTTP_STATUS.SERVICE_UNAVAILABLE, true],
    [HTTP_STATUS.GATEWAY_TIMEOUT, true],
    [HTTP_STATUS.TOO_MANY_REQUESTS, true],
    [HTTP_STATUS.BAD_REQUEST, false],
    [HTTP_STATUS.UNAUTHORIZED, false],
    [HTTP_STATUS.FORBIDDEN, false],
    [HTTP_STATUS.NOT_FOUND, false],
    [HTTP_STATUS.CONFLICT, false],
    [HTTP_STATUS.INTERNAL_SERVER_ERROR, false],
  ])('statusCode %i -> retryable=%s', (statusCode, expected) => {
    const err = new SdkApiError(statusCode, 'test');
    expect(err.isRetryable()).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// toJSON() with sanitization
// ---------------------------------------------------------------------------
describe('toJSON()', () => {
  it('should serialise all fields', () => {
    const err = new SdkApiError(500, 'fail', 'X', { info: 1 }, 'req-2');
    const json = err.toJSON();
    expect(json).toEqual({
      name: 'SdkApiError',
      message: 'fail',
      statusCode: 500,
      code: 'X',
      details: { info: 1 },
      requestId: 'req-2',
    });
  });

  it('should omit details when undefined', () => {
    const err = new SdkApiError(404, 'nope');
    const json = err.toJSON();
    expect(json.details).toBeUndefined();
  });

  it('should redact sensitive keys in details', () => {
    const err = new SdkApiError(500, 'err', 'X', {
      apiKey: 'secret-key-value',
      token: 'tok',
      safe: 'visible',
    });
    const json = err.toJSON();
    const details = json.details as Record<string, unknown>;
    expect(details.apiKey).toBe('[REDACTED]');
    expect(details.token).toBe('[REDACTED]');
    expect(details.safe).toBe('visible');
  });
});

// ---------------------------------------------------------------------------
// createErrorFromStatus() factory
// ---------------------------------------------------------------------------
describe('createErrorFromStatus()', () => {
  it('should create ValidationError for 400', () => {
    const err = createErrorFromStatus(400, 'bad', undefined, { field: 'x' });
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.details).toEqual({ field: 'x' });
  });

  it('should create UnauthorizedError for 401', () => {
    const err = createErrorFromStatus(401, 'no auth');
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it('should create ForbiddenError for 403', () => {
    const err = createErrorFromStatus(403, 'nope');
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it('should create NotFoundError for 404', () => {
    const err = createErrorFromStatus(404, 'missing');
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('should create ConflictError for 409', () => {
    const err = createErrorFromStatus(409, 'dup');
    expect(err).toBeInstanceOf(ConflictError);
  });

  it('should create PayloadTooLargeError for 413', () => {
    const err = createErrorFromStatus(413, 'big', undefined, { maxSize: 1024 });
    expect(err).toBeInstanceOf(PayloadTooLargeError);
  });

  it('should create UnprocessableError for 422', () => {
    const err = createErrorFromStatus(422, 'nope');
    expect(err).toBeInstanceOf(UnprocessableError);
  });

  it('should create RateLimitError for 429', () => {
    const err = createErrorFromStatus(429, 'slow down', undefined, { retryAfter: 10 });
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBe(10);
  });

  it('should create ServiceUnavailableError for 503', () => {
    const err = createErrorFromStatus(503, 'down', undefined, { retryAfter: 5 });
    expect(err).toBeInstanceOf(ServiceUnavailableError);
  });

  it('should create ServiceUnavailableError for 502', () => {
    const err = createErrorFromStatus(502, 'bad gw');
    expect(err).toBeInstanceOf(ServiceUnavailableError);
  });

  it('should create ServiceUnavailableError for 504', () => {
    const err = createErrorFromStatus(504, 'gw timeout');
    expect(err).toBeInstanceOf(ServiceUnavailableError);
  });

  it('should fall back to SdkApiError for unknown status', () => {
    const err = createErrorFromStatus(418, 'teapot', 'TEA', { brew: true }, 'req-99');
    expect(err.constructor).toBe(SdkApiError);
    expect(err.statusCode).toBe(418);
    expect(err.code).toBe('TEA');
    expect(err.requestId).toBe('req-99');
  });

  it('should ignore non-numeric retryAfter in details for 429', () => {
    const err = createErrorFromStatus(429, 'limit', undefined, { retryAfter: 'invalid' });
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBeUndefined();
  });

  it('should preserve server message for 429 RateLimitError', () => {
    const err = createErrorFromStatus(429, 'Per-project limit exceeded', undefined, { retryAfter: 10 });
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.message).toBe('Per-project limit exceeded');
    expect((err as RateLimitError).retryAfter).toBe(10);
  });

  it.each([
    [400, ValidationError],
    [401, UnauthorizedError],
    [403, ForbiddenError],
    [404, NotFoundError],
    [409, ConflictError],
    [413, PayloadTooLargeError],
    [422, UnprocessableError],
    [429, RateLimitError],
    [503, ServiceUnavailableError],
  ] as const)('should propagate requestId for status %i', (status, ErrorClass) => {
    const err = createErrorFromStatus(status, 'msg', undefined, undefined, 'req-abc');
    expect(err).toBeInstanceOf(ErrorClass);
    expect(err.requestId).toBe('req-abc');
  });
});

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------
describe('type guards', () => {
  it('isSdkApiError recognises base and subclasses', () => {
    expect(isSdkApiError(new SdkApiError(500, 'a'))).toBe(true);
    expect(isSdkApiError(new ValidationError('b'))).toBe(true);
    expect(isSdkApiError(new RateLimitError())).toBe(true);
    expect(isSdkApiError(new Error('plain'))).toBe(false);
    expect(isSdkApiError(null)).toBe(false);
    expect(isSdkApiError(undefined)).toBe(false);
    expect(isSdkApiError('string')).toBe(false);
  });

  it('isValidationError', () => {
    expect(isValidationError(new ValidationError('v'))).toBe(true);
    expect(isValidationError(new SdkApiError(400, 'x'))).toBe(false);
    expect(isValidationError(new Error('y'))).toBe(false);
  });

  it('isNotFoundError', () => {
    expect(isNotFoundError(new NotFoundError('X'))).toBe(true);
    expect(isNotFoundError(new SdkApiError(404, 'z'))).toBe(false);
  });

  it('isConflictError', () => {
    expect(isConflictError(new ConflictError('c'))).toBe(true);
    expect(isConflictError(new SdkApiError(409, 'z'))).toBe(false);
  });

  it('isUnprocessableError', () => {
    expect(isUnprocessableError(new UnprocessableError('u'))).toBe(true);
    expect(isUnprocessableError(new SdkApiError(422, 'z'))).toBe(false);
  });

  it('isRateLimitError', () => {
    expect(isRateLimitError(new RateLimitError(undefined, 10))).toBe(true);
    expect(isRateLimitError(new SdkApiError(429, 'z'))).toBe(false);
  });
});
