/**
 * Tests that generateCaption / generateText surface a friendly error message
 * when AbortSignal.timeout() fires.
 *
 * Under Bun (and browsers), AbortSignal.timeout() aborts the fetch with a
 * DOMException whose name is "TimeoutError", NOT "AbortError".  The fix is
 * to check for both names so the user sees the "model may be wedged" message
 * instead of the raw runtime error.
 */

import { describe, expect, mock, test } from 'bun:test';

// -------------------------------------------------------------------
// Helpers to build the two DOMException variants we need to test
// -------------------------------------------------------------------

function makeTimeoutError(): DOMException {
  const e = new DOMException('The operation timed out.', 'TimeoutError');
  return e;
}

function makeAbortError(): DOMException {
  const e = new DOMException('The user aborted a request.', 'AbortError');
  return e;
}

// -------------------------------------------------------------------
// generateCaption — timeout detection
// -------------------------------------------------------------------

describe('generateCaption timeout handling', () => {
  test('throws friendly message on TimeoutError (AbortSignal.timeout() behaviour)', async () => {
    // Stub global fetch to reject with a TimeoutError DOMException.
    const originalFetch = global.fetch;
    global.fetch = mock(async () => {
      throw makeTimeoutError();
    }) as unknown as typeof fetch;

    try {
      const { generateCaption } = await import('../../src/engine/caption/ollama.ts');
      // Provide a minimal 1×1 PNG buffer so we bypass any sharp resize path.
      const tiny1x1png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      );
      await generateCaption(tiny1x1png, { ollamaUrl: 'http://localhost:11434' });
      throw new Error('Expected generateCaption to throw');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/did not respond within/);
      expect(msg).toMatch(/model may be wedged/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('throws friendly message on AbortError (manual AbortController usage)', async () => {
    const originalFetch = global.fetch;
    global.fetch = mock(async () => {
      throw makeAbortError();
    }) as unknown as typeof fetch;

    try {
      const { generateCaption } = await import('../../src/engine/caption/ollama.ts');
      const tiny1x1png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      );
      await generateCaption(tiny1x1png, { ollamaUrl: 'http://localhost:11434' });
      throw new Error('Expected generateCaption to throw');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/did not respond within/);
      expect(msg).toMatch(/model may be wedged/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('re-throws non-DOMException errors unchanged', async () => {
    const originalFetch = global.fetch;
    const networkErr = new Error('ECONNREFUSED');
    global.fetch = mock(async () => {
      throw networkErr;
    }) as unknown as typeof fetch;

    try {
      const { generateCaption } = await import('../../src/engine/caption/ollama.ts');
      const tiny1x1png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      );
      await generateCaption(tiny1x1png, { ollamaUrl: 'http://localhost:11434' });
      throw new Error('Expected generateCaption to throw');
    } catch (err: unknown) {
      expect(err).toBe(networkErr);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// -------------------------------------------------------------------
// generateText — timeout detection
// -------------------------------------------------------------------

describe('generateText timeout handling', () => {
  test('throws friendly message on TimeoutError', async () => {
    const originalFetch = global.fetch;
    global.fetch = mock(async () => {
      throw makeTimeoutError();
    }) as unknown as typeof fetch;

    try {
      const { generateText } = await import('../../src/engine/caption/ollama.ts');
      await generateText('Describe this site.', { ollamaUrl: 'http://localhost:11434' });
      throw new Error('Expected generateText to throw');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/did not respond within/);
      expect(msg).toMatch(/model may be wedged/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  test('throws friendly message on AbortError', async () => {
    const originalFetch = global.fetch;
    global.fetch = mock(async () => {
      throw makeAbortError();
    }) as unknown as typeof fetch;

    try {
      const { generateText } = await import('../../src/engine/caption/ollama.ts');
      await generateText('Describe this site.', { ollamaUrl: 'http://localhost:11434' });
      throw new Error('Expected generateText to throw');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/did not respond within/);
      expect(msg).toMatch(/model may be wedged/);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
