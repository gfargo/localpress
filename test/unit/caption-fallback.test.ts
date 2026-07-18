/**
 * Unit tests for generateCaptionWithFallback — specifically the error and
 * garbage-output paths that the original implementation didn't guard.
 *
 * We avoid touching the network by monkey-patching globalThis.fetch before
 * each scenario and restoring it after. The approach mirrors caption-clean.test.ts
 * (no heavy mocking framework needed — Bun's built-in test runner is enough).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { generateCaptionWithFallback, looksLikeGarbage } from '../../src/engine/caption/ollama.ts';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Minimal Ollama /api/generate response body. */
function ollamaResponse(text: string): Response {
  return new Response(JSON.stringify({ model: 'test-model', response: text, done: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A tiny 1×1 red PNG — valid enough for the downscale logic to accept. */
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==';

function tinyPngBuffer(): Buffer {
  return Buffer.from(TINY_PNG_B64, 'base64');
}

// Preserve the real fetch so we can restore it.
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// looksLikeGarbage
// ---------------------------------------------------------------------------

describe('looksLikeGarbage', () => {
  test('returns true for very short text', () => {
    expect(looksLikeGarbage('A.')).toBe(true);
    expect(looksLikeGarbage('Watch.')).toBe(true);
    expect(looksLikeGarbage('')).toBe(true);
  });

  test('returns true for coordinate arrays', () => {
    expect(looksLikeGarbage('[0.3, 0.13, 0.64, 0.26]')).toBe(true);
    expect(looksLikeGarbage('ids: [0.25, 0.39]')).toBe(true);
  });

  test('returns true for mostly-numeric content', () => {
    expect(looksLikeGarbage('0.12 0.45 0.67 0.89 0.23')).toBe(true);
  });

  test('returns false for a normal description', () => {
    expect(looksLikeGarbage('A red ceramic mug on a wooden desk.')).toBe(false);
  });

  test('returns false for a short-but-valid title (>= 10 chars)', () => {
    expect(looksLikeGarbage('Red mug on')).toBe(false);
  });

  test('classify: valid labels are not garbage even though they are short', () => {
    expect(looksLikeGarbage('photo', 'classify')).toBe(false);
    expect(looksLikeGarbage('diagram', 'classify')).toBe(false);
    expect(looksLikeGarbage('screenshot', 'classify')).toBe(false);
    expect(looksLikeGarbage('illustration', 'classify')).toBe(false);
  });

  test('classify: anything outside the closed label set is garbage', () => {
    expect(looksLikeGarbage('unknown', 'classify')).toBe(true);
    expect(looksLikeGarbage('abstract art', 'classify')).toBe(true);
    expect(looksLikeGarbage('', 'classify')).toBe(true);
  });

  test('tags: a non-empty cleaned tag list is never garbage regardless of length', () => {
    expect(looksLikeGarbage('cat', 'tags')).toBe(false);
    expect(looksLikeGarbage('cat, outdoor, grass', 'tags')).toBe(false);
  });

  test('tags: an empty cleaned tag list (nothing survived filtering) is garbage', () => {
    expect(looksLikeGarbage('', 'tags')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// generateCaptionWithFallback — fallback call throws
// ---------------------------------------------------------------------------

describe('generateCaptionWithFallback — fallback error path', () => {
  test('returns primary result when fallback throws (primary is garbage but fallback errors)', async () => {
    // Primary model returns garbage. Fallback model throws. We expect the
    // primary (garbage) result to come back rather than an unhandled exception.

    let callCount = 0;
    globalThis.fetch = (async (input: string | URL, _init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();

      // /api/tags — both models "installed"
      if (url.endsWith('/api/tags')) {
        return new Response(
          JSON.stringify({
            models: [
              { name: 'good-model', size: 1 },
              { name: 'bad-fallback', size: 1 },
            ],
          }),
          { status: 200 },
        );
      }

      // /api/generate
      if (url.endsWith('/api/generate')) {
        callCount++;
        if (callCount === 1) {
          // Primary returns garbage (very short — triggers looksLikeGarbage).
          return ollamaResponse('A.');
        }
        // Fallback throws network-style error.
        throw new Error('Simulated fallback network failure');
      }

      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const buf = tinyPngBuffer();
    const result = await generateCaptionWithFallback(buf, {
      model: 'good-model',
      fallbackModel: 'bad-fallback',
      ollamaUrl: 'http://localhost:11434',
    });

    // Should return the primary (garbage) caption, not throw.
    expect(result.caption).toBeTruthy();
    // Two generate calls were attempted (primary + fallback attempt).
    expect(callCount).toBe(2);
  });

  test('returns fallback result when primary is garbage and fallback succeeds', async () => {
    let callCount = 0;
    globalThis.fetch = (async (input: string | URL, _init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.endsWith('/api/tags')) {
        return new Response(
          JSON.stringify({
            models: [
              { name: 'primary', size: 1 },
              { name: 'fallback', size: 1 },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.endsWith('/api/generate')) {
        callCount++;
        if (callCount === 1) {
          return ollamaResponse('A.'); // garbage
        }
        return ollamaResponse('A red ceramic mug on a wooden desk.'); // good fallback
      }

      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const buf = tinyPngBuffer();
    const result = await generateCaptionWithFallback(buf, {
      model: 'primary',
      fallbackModel: 'fallback',
      ollamaUrl: 'http://localhost:11434',
    });

    expect(result.caption).toBe('A red ceramic mug on a wooden desk.');
    expect(callCount).toBe(2);
  });

  test('skips fallback when primary result looks fine', async () => {
    let callCount = 0;
    globalThis.fetch = (async (input: string | URL, _init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'primary', size: 1 }] }), {
          status: 200,
        });
      }

      if (url.endsWith('/api/generate')) {
        callCount++;
        return ollamaResponse('A red ceramic mug on a wooden desk.');
      }

      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const buf = tinyPngBuffer();
    const result = await generateCaptionWithFallback(buf, {
      model: 'primary',
      fallbackModel: 'fallback',
      ollamaUrl: 'http://localhost:11434',
    });

    expect(result.caption).toBe('A red ceramic mug on a wooden desk.');
    // Only one generate call — fallback was never needed.
    expect(callCount).toBe(1);
  });

  test('classify: does not spuriously trigger fallback for a valid short label', async () => {
    // Regression test: "photo" and "diagram" are valid classify outputs but
    // are under 10 chars, so the generic prose heuristic would have wrongly
    // flagged them as garbage and discarded the correct classification in
    // favor of whatever the fallback model returned.
    let callCount = 0;
    globalThis.fetch = (async (input: string | URL, _init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.endsWith('/api/tags')) {
        return new Response(
          JSON.stringify({
            models: [
              { name: 'primary', size: 1 },
              { name: 'fallback', size: 1 },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.endsWith('/api/generate')) {
        callCount++;
        // Primary correctly classifies as a photo.
        return ollamaResponse('photo');
      }

      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const buf = tinyPngBuffer();
    const result = await generateCaptionWithFallback(buf, {
      kind: 'classify',
      model: 'primary',
      fallbackModel: 'fallback',
      ollamaUrl: 'http://localhost:11434',
    });

    expect(result.caption).toBe('photo');
    // Only one generate call — the valid classification was never treated as garbage.
    expect(callCount).toBe(1);
  });

  test('skips fallback when no fallbackModel is configured', async () => {
    let callCount = 0;
    globalThis.fetch = (async (input: string | URL, _init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/generate')) {
        callCount++;
        return ollamaResponse('A.'); // garbage, but no fallback configured
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const buf = tinyPngBuffer();
    const result = await generateCaptionWithFallback(buf, {
      model: 'primary',
      // no fallbackModel
      ollamaUrl: 'http://localhost:11434',
    });

    // Garbage primary is returned as-is since there's no fallback.
    expect(result.caption).toBeTruthy();
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Config type round-trip — captionFallbackModel field exists
// ---------------------------------------------------------------------------

describe('Config type — captionFallbackModel field', () => {
  test('captionFallbackModel persists through saveConfig/loadConfig round-trip', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const tempDir = mkdtempSync(join(tmpdir(), 'lp-fallback-test-'));
    const originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tempDir;

    try {
      const { loadConfig, saveConfig } = await import('../../src/cli/utils/config.ts');
      // We only need the type shape — annotate locally rather than a dynamic type import.

      const config = {
        version: 1 as const,
        sites: {} as Record<string, never>,
        defaults: {
          captionModel: 'moondream',
          captionFallbackModel: 'llava-llama3',
        },
      };

      await saveConfig(config);
      const loaded = await loadConfig();

      expect(loaded.defaults?.captionModel).toBe('moondream');
      expect(loaded.defaults?.captionFallbackModel).toBe('llava-llama3');
    } finally {
      process.env.XDG_CONFIG_HOME = originalXdg;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
