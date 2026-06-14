/**
 * Tests for the shared content-addressing hash utilities:
 * computeHash, computePromptHash, verifyHash, verifyPromptHash.
 *
 * The golden fixtures are real published definitions whose `hash`/`promptHash`
 * were stored by the registry API at publish time (yaml@2.9.0). They prove
 * BOTH (a) normalization is locked — a future yaml bump that changes output
 * fails here — and (b) byte-parity with production stored hashes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  computeHash,
  computePromptHash,
  verifyHash,
  verifyPromptHash,
} from '../src/utils/hash.js';

const goldenDir = fileURLToPath(new URL('./fixtures/golden/', import.meta.url));
const read = (file: string): string => readFileSync(goldenDir + file, 'utf8');

interface GoldenFixture {
  name: string;
  type: string;
  version: string;
  yamlFile: string;
  runtimeFile?: string;
  hash: string;
  promptHash?: string;
  translatorVersion?: string;
}

const manifest = JSON.parse(read('manifest.json')) as { fixtures: GoldenFixture[] };

// A well-known constant: sha256 of the empty string.
const EMPTY_SHA256 =
  'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('golden fixtures (production parity)', () => {
  it('has at least one fixture covering each hash function', () => {
    expect(manifest.fixtures.length).toBeGreaterThan(0);
    expect(manifest.fixtures.some((f) => f.hash)).toBe(true);
    expect(manifest.fixtures.some((f) => f.promptHash)).toBe(true);
  });

  for (const fx of manifest.fixtures) {
    describe(`${fx.type}:${fx.name}@${fx.version}`, () => {
      it('computeHash(yaml) reproduces the stored registry hash', () => {
        expect(computeHash(read(fx.yamlFile))).toBe(fx.hash);
      });

      it('verifyHash accepts the stored hash', () => {
        expect(verifyHash(read(fx.yamlFile), fx.hash)).toBe(true);
      });

      if (fx.promptHash && fx.runtimeFile) {
        it('computePromptHash(runtimeMd) reproduces the stored prompt hash', () => {
          expect(computePromptHash(read(fx.runtimeFile!))).toBe(fx.promptHash);
        });

        it('verifyPromptHash accepts the stored prompt hash', () => {
          expect(verifyPromptHash(read(fx.runtimeFile!), fx.promptHash!)).toBe(true);
        });
      }
    });
  }
});

describe('computeHash', () => {
  it('returns a sha256-prefixed hash', () => {
    const h = computeHash('test content');
    expect(h.startsWith('sha256:')).toBe(true);
    expect(h.length).toBe(7 + 64);
  });

  it('is deterministic for identical content', () => {
    expect(computeHash('some: yaml')).toBe(computeHash('some: yaml'));
  });

  it('hashes the empty string to the known constant', () => {
    expect(computeHash('')).toBe(EMPTY_SHA256);
  });

  it('normalizes structured YAML so key order does not change the hash', () => {
    expect(computeHash('a: 1\nb: 2')).toBe(computeHash('b: 2\na: 1'));
  });

  it('distinguishes content with leading/trailing whitespace in scalars', () => {
    // Plain scalars fall through normalization (raw bytes), so whitespace matters.
    expect(computeHash('content')).not.toBe(computeHash(' content'));
  });
});

describe('normalizeForHash totality (via computeHash)', () => {
  it('resolves anchors/aliases deterministically', () => {
    const withAlias = 'base: &b\n  k: v\nuse: *b';
    expect(() => computeHash(withAlias)).not.toThrow();
    expect(computeHash(withAlias)).toBe(computeHash(withAlias));
  });

  it('handles a multi-document stream without throwing (raw fallback)', () => {
    const multi = '---\na: 1\n---\nb: 2\n';
    expect(() => computeHash(multi)).not.toThrow();
    expect(computeHash(multi)).toBe(computeHash(multi));
  });

  it('falls back to raw bytes for plain scalars', () => {
    // A bare scalar is not an object → normalization returns it unchanged,
    // so the hash equals a raw sha256 of those bytes (whitespace-sensitive).
    expect(computeHash('just a scalar')).not.toBe(computeHash('just a scalar ')); // trailing space differs
  });

  it('falls back to raw bytes on unparseable YAML', () => {
    const broken = 'a: [1, 2\nb: : :';
    expect(() => computeHash(broken)).not.toThrow();
    expect(computeHash(broken)).toBe(computeHash(broken));
  });
});

describe('computePromptHash', () => {
  it('returns a sha256-prefixed hash', () => {
    const h = computePromptHash('# Prompt\n\nDo the thing.');
    expect(h.startsWith('sha256:')).toBe(true);
    expect(h.length).toBe(7 + 64);
  });

  it('hashes the empty string to the known constant', () => {
    expect(computePromptHash('')).toBe(EMPTY_SHA256);
  });

  it('does NOT normalize — whitespace changes the hash', () => {
    expect(computePromptHash('line1\nline2')).not.toBe(computePromptHash('line1\n\nline2'));
  });

  it('differs from computeHash for structured YAML input', () => {
    const yaml = 'b: 2\na: 1';
    expect(computePromptHash(yaml)).not.toBe(computeHash(yaml));
  });

  it('detects single-character changes', () => {
    expect(computePromptHash('threshold: 70')).not.toBe(computePromptHash('threshold: 71'));
  });
});

describe('verifyHash', () => {
  it('returns true for a matching hash', () => {
    const c = 'content: here';
    expect(verifyHash(c, computeHash(c))).toBe(true);
  });

  it('returns false for a non-matching hash', () => {
    expect(
      verifyHash('content', `sha256:${'0'.repeat(64)}`),
    ).toBe(false);
  });
});

describe('verifyPromptHash', () => {
  it('returns true for a matching prompt hash', () => {
    const md = '# Rendered prompt';
    expect(verifyPromptHash(md, computePromptHash(md))).toBe(true);
  });

  it('returns false for a non-matching prompt hash', () => {
    expect(
      verifyPromptHash('# Rendered prompt', `sha256:${'0'.repeat(64)}`),
    ).toBe(false);
  });

  it('does not apply YAML normalization (unlike verifyHash)', () => {
    const md = '# Prompt\n\nb: 2\na: 1';
    const ph = computePromptHash(md);
    expect(verifyPromptHash(md, ph)).toBe(true);
    // verifyHash would normalize the markdown-as-YAML and fail.
    expect(verifyHash(md, ph)).toBe(false);
  });
});

describe('length-mismatch guard (no RangeError on malformed pins)', () => {
  // timingSafeEqual throws on unequal-length buffers; the guard must return
  // false first so a malformed caller pin yields a clean refusal, not a crash.
  const malformed = ['', 'sha256:short', 'not-a-hash', `sha256:${'0'.repeat(63)}`];

  for (const bad of malformed) {
    it(`verifyHash returns false (not throw) for ${JSON.stringify(bad)}`, () => {
      let result: boolean | undefined;
      expect(() => {
        result = verifyHash('some content', bad);
      }).not.toThrow();
      expect(result).toBe(false);
    });

    it(`verifyPromptHash returns false (not throw) for ${JSON.stringify(bad)}`, () => {
      let result: boolean | undefined;
      expect(() => {
        result = verifyPromptHash('some prompt', bad);
      }).not.toThrow();
      expect(result).toBe(false);
    });
  }
});
