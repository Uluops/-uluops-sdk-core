/**
 * Tests for createLogger(), redactSensitive(), sanitizeForDisplay(), sanitizeForLog()
 */
import {
  createLogger,
  redactSensitive,
  sanitizeForDisplay,
  sanitizeForLog,
} from '../src/utils/logger.js';

// ---------------------------------------------------------------------------
// createLogger()
// ---------------------------------------------------------------------------
describe('createLogger()', () => {
  describe('when disabled', () => {
    it('should suppress debug and info', () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const logger = createLogger('[test]', false);

      logger.debug('should not appear');
      logger.info('should not appear');

      expect(debugSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      debugSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('should still emit warn even when disabled', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logger = createLogger('[test]', false);

      logger.warn('important warning');

      expect(spy).toHaveBeenCalledTimes(1);
      const firstArg = spy.mock.calls[0][0] as string;
      expect(firstArg).toContain('[test]');
      expect(firstArg).toContain('WARN:');
      spy.mockRestore();
    });

    it('should still emit error even when disabled', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logger = createLogger('[test]', false);

      logger.error('critical error');

      expect(spy).toHaveBeenCalledTimes(1);
      const firstArg = spy.mock.calls[0][0] as string;
      expect(firstArg).toContain('[test]');
      expect(firstArg).toContain('ERROR:');
      spy.mockRestore();
    });

    it('should sanitize args in warn/error even when disabled', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logger = createLogger('[test]', false);

      logger.warn('data', { apiKey: 'secret', safe: 'visible' });

      const extraArg = spy.mock.calls[0][2];
      expect(extraArg).toEqual({ apiKey: '[REDACTED]', safe: 'visible' });
      spy.mockRestore();
    });
  });

  describe('when enabled', () => {
    it('should call console.debug with prefix', () => {
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const logger = createLogger('[sdk]', true);

      logger.debug('hello');

      expect(spy).toHaveBeenCalledTimes(1);
      const [firstArg, secondArg] = spy.mock.calls[0];
      expect(firstArg).toMatch(/\d{4}-\d{2}-\d{2}T/); // ISO timestamp
      expect(firstArg).toContain('[sdk]');
      expect(firstArg).toContain('DEBUG:');
      expect(secondArg).toBe('hello');
      spy.mockRestore();
    });

    it('should call console.info for info level', () => {
      const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const logger = createLogger('[sdk]', true);

      logger.info('info msg');

      expect(spy).toHaveBeenCalledTimes(1);
      const firstArg = spy.mock.calls[0][0] as string;
      expect(firstArg).toContain('INFO:');
      spy.mockRestore();
    });

    it('should call console.warn for warn level', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logger = createLogger('[sdk]', true);

      logger.warn('warn msg');

      expect(spy).toHaveBeenCalledTimes(1);
      const firstArg = spy.mock.calls[0][0] as string;
      expect(firstArg).toContain('WARN:');
      spy.mockRestore();
    });

    it('should call console.error for error level', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logger = createLogger('[sdk]', true);

      logger.error('error msg');

      expect(spy).toHaveBeenCalledTimes(1);
      const firstArg = spy.mock.calls[0][0] as string;
      expect(firstArg).toContain('ERROR:');
      spy.mockRestore();
    });

    it('should sanitize extra args (redact sensitive keys)', () => {
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const logger = createLogger('[sdk]', true);

      logger.debug('data', { apiKey: 'secret', safe: 'visible' });

      expect(spy).toHaveBeenCalledTimes(1);
      const extraArg = spy.mock.calls[0][2];
      expect(extraArg).toEqual({ apiKey: '[REDACTED]', safe: 'visible' });
      spy.mockRestore();
    });

    it('should handle multiple extra args', () => {
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const logger = createLogger('[sdk]', true);

      logger.debug('multi', { token: 'secret' }, { password: 'pw' });

      const args = spy.mock.calls[0];
      expect(args[2]).toEqual({ token: '[REDACTED]' });
      expect(args[3]).toEqual({ password: '[REDACTED]' });
      spy.mockRestore();
    });
  });
});

// ---------------------------------------------------------------------------
// redactSensitive()
// ---------------------------------------------------------------------------
describe('redactSensitive()', () => {
  it('should show last 4 characters by default', () => {
    const result = redactSensitive('my-secret-api-key-1234');
    expect(result).toContain('1234');
    expect(result).toContain('*');
    expect(result).not.toContain('secret');
  });

  it('should show custom number of trailing chars', () => {
    const result = redactSensitive('abcdefghij', 6);
    expect(result).toContain('efghij');
    expect(result).toContain('*');
  });

  it('should return [REDACTED] if value is shorter than showLast', () => {
    expect(redactSensitive('abc', 4)).toBe('[REDACTED]');
    expect(redactSensitive('ab', 4)).toBe('[REDACTED]');
  });

  it('should return [REDACTED] if value length equals showLast', () => {
    expect(redactSensitive('abcd', 4)).toBe('[REDACTED]');
  });

  it('should cap asterisk length at 20', () => {
    const long = 'a'.repeat(100) + 'tail';
    const result = redactSensitive(long);
    const asterisks = result.match(/\*/g);
    expect(asterisks!.length).toBe(20);
  });

  it('should handle empty string', () => {
    expect(redactSensitive('')).toBe('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// sanitizeForDisplay()
// ---------------------------------------------------------------------------
describe('sanitizeForDisplay()', () => {
  it('should redact sensitive string keys', () => {
    const input = {
      apiKey: 'secret-key',
      token: 'bearer-tok',
      password: 'pass123',
      safe: 'visible',
    };
    const result = sanitizeForDisplay(input);
    expect(result.apiKey).toBe('[REDACTED]');
    expect(result.token).toBe('[REDACTED]');
    expect(result.password).toBe('[REDACTED]');
    expect(result.safe).toBe('visible');
  });

  it('should recursively sanitize nested objects', () => {
    const input = {
      outer: {
        api_key: 'key',
        data: 'ok',
      },
    };
    const result = sanitizeForDisplay(input);
    expect((result.outer as Record<string, unknown>).api_key).toBe('[REDACTED]');
    expect((result.outer as Record<string, unknown>).data).toBe('ok');
  });

  it('should handle arrays with objects', () => {
    const input = {
      items: [
        { token: 'tok1', name: 'a' },
        { secret: 'sec', name: 'b' },
      ],
    };
    const result = sanitizeForDisplay(input);
    const items = result.items as Array<Record<string, unknown>>;
    expect(items[0].token).toBe('[REDACTED]');
    expect(items[0].name).toBe('a');
    expect(items[1].secret).toBe('[REDACTED]');
    expect(items[1].name).toBe('b');
  });

  it('should preserve non-string sensitive values (only redacts strings)', () => {
    const input = { api_key: 12345, token: true };
    const result = sanitizeForDisplay(input);
    // sanitizeForDisplay only redacts string values for sensitive keys
    expect(result.api_key).toBe(12345);
    expect(result.token).toBe(true);
  });

  it('should handle arrays with primitives', () => {
    const input = { items: [1, 'two', true] };
    const result = sanitizeForDisplay(input);
    expect(result.items).toEqual([1, 'two', true]);
  });

  it('should handle empty objects', () => {
    expect(sanitizeForDisplay({})).toEqual({});
  });

  it('should match various key patterns case-insensitively', () => {
    const input = {
      Authorization: 'Bearer xxx',
      SESSION_TOKEN: 'tok',
      'access-token': 'at',
      'refresh_token': 'rt',
      cookie: 'session=abc',
      credentials: 'user:pass',
    };
    const result = sanitizeForDisplay(input);
    expect(result.Authorization).toBe('[REDACTED]');
    expect(result.SESSION_TOKEN).toBe('[REDACTED]');
    expect(result['access-token']).toBe('[REDACTED]');
    expect(result['refresh_token']).toBe('[REDACTED]');
    expect(result.cookie).toBe('[REDACTED]');
    expect(result.credentials).toBe('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// sanitizeForLog()
// ---------------------------------------------------------------------------
describe('sanitizeForLog()', () => {
  it('should return primitives unchanged', () => {
    expect(sanitizeForLog(null)).toBeNull();
    expect(sanitizeForLog(undefined)).toBeUndefined();
    expect(sanitizeForLog(42)).toBe(42);
    expect(sanitizeForLog('hello')).toBe('hello');
    expect(sanitizeForLog(true)).toBe(true);
  });

  it('should redact sensitive keys in objects', () => {
    const result = sanitizeForLog({ apiKey: 'key', safe: 'ok' });
    expect(result).toEqual({ apiKey: '[REDACTED]', safe: 'ok' });
  });

  it('should handle arrays by mapping each element', () => {
    const input = [{ token: 'tok' }, { name: 'a' }];
    const result = sanitizeForLog(input) as Array<Record<string, unknown>>;
    expect(result[0].token).toBe('[REDACTED]');
    expect(result[1].name).toBe('a');
  });

  it('should recursively sanitize nested objects', () => {
    const result = sanitizeForLog({
      outer: {
        password: 'pw',
        inner: {
          secret: 'sec',
          data: 'visible',
        },
      },
    }) as Record<string, unknown>;

    const outer = result.outer as Record<string, unknown>;
    expect(outer.password).toBe('[REDACTED]');
    const inner = outer.inner as Record<string, unknown>;
    expect(inner.secret).toBe('[REDACTED]');
    expect(inner.data).toBe('visible');
  });

  it('should redact all variants of sensitive key names', () => {
    const input = {
      api_key: 'val',
      'api-key': 'val',
      apiKey: 'val',
      Token: 'val',
      session_token: 'val',
      'session-token': 'val',
      sessionToken: 'val',
      Secret: 'val',
      Password: 'val',
      Authorization: 'val',
      Credentials: 'val',
      Cookie: 'val',
      access_token: 'val',
      'access-token': 'val',
      accessToken: 'val',
      refresh_token: 'val',
      'refresh-token': 'val',
      refreshToken: 'val',
    };
    const result = sanitizeForLog(input) as Record<string, unknown>;
    for (const value of Object.values(result)) {
      expect(value).toBe('[REDACTED]');
    }
  });

  it('should NOT redact keys that partially match', () => {
    const input = { apiKeyId: 'visible', mytoken: 'visible', passwordHash: 'visible' };
    const result = sanitizeForLog(input) as Record<string, unknown>;
    // These keys don't exactly match the SENSITIVE_KEYS pattern, so they stay
    // (The regex requires exact match with ^ and $)
    expect(result.apiKeyId).toBe('visible');
    expect(result.mytoken).toBe('visible');
    expect(result.passwordHash).toBe('visible');
  });
});
