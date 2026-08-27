/**
 * Unit tests for ONNX model download integrity (#130).
 *
 * A killed/interrupted download used to leave a truncated file directly at
 * the final `.onnx` path, which `isModelCached`/`ensureModel` then treated as
 * valid forever. `ensureModel` now streams to a `.partial` path, verifies the
 * byte count against `content-length`, and only renames into place on success.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir: string;
let originalXdg: string | undefined;
let originalFetch: typeof fetch;
let originalChecksumDisabled: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'localpress-models-test-'));
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpDir;
  originalFetch = globalThis.fetch;
  originalChecksumDisabled = process.env.MODEL_CHECKSUM_DISABLED;
  // Most tests use tiny fixtures. Production downloads still enforce the
  // registry's exact, upstream-published checksum and byte size.
  process.env.MODEL_CHECKSUM_DISABLED = '1';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalChecksumDisabled === undefined) {
    process.env.MODEL_CHECKSUM_DISABLED = undefined;
  } else {
    process.env.MODEL_CHECKSUM_DISABLED = originalChecksumDisabled;
  }
  if (originalXdg === undefined) {
    process.env.XDG_CONFIG_HOME = undefined;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdg;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function mockFetchOnce(bytes: Uint8Array, declaredContentLength: number): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(declaredContentLength) },
      }),
    )) as unknown as typeof fetch;
}

describe('ensureModel download integrity', () => {
  test('a truncated download throws and does not create the final .onnx file', async () => {
    const { ensureModel, getModelPath } = await import('../../src/engine/rembg/models.ts');

    const actualBytes = new Uint8Array(10).fill(1);
    mockFetchOnce(actualBytes, 20); // declares 20 bytes but only sends 10

    await expect(ensureModel('u2netp')).rejects.toThrow(/incomplete/i);

    const modelPath = getModelPath('u2netp');
    expect(existsSync(modelPath)).toBe(false);
    expect(existsSync(`${modelPath}.partial`)).toBe(false);
  });

  test('a complete download is renamed into place and passes isModelCached', async () => {
    const { ensureModel, isModelCached, getModelPath } = await import(
      '../../src/engine/rembg/models.ts'
    );

    const actualBytes = new Uint8Array(10).fill(1);
    mockFetchOnce(actualBytes, 10);

    const resultPath = await ensureModel('u2netp');
    const modelPath = getModelPath('u2netp');

    expect(resultPath).toBe(modelPath);
    expect(existsSync(modelPath)).toBe(true);
    expect(existsSync(`${modelPath}.partial`)).toBe(false);
    expect(existsSync(`${modelPath}.integrity.json`)).toBe(true);
    expect(isModelCached('u2netp')).toBe(true);
  });

  test('a stale leftover .partial file from a prior crash is overwritten, not treated as cached', async () => {
    const { ensureModel, getModelPath, getModelsDir } = await import(
      '../../src/engine/rembg/models.ts'
    );
    mkdirSync(getModelsDir(), { recursive: true });
    const modelPath = getModelPath('u2netp');
    writeFileSync(`${modelPath}.partial`, new Uint8Array(3));

    const actualBytes = new Uint8Array(10).fill(1);
    mockFetchOnce(actualBytes, 10);

    await ensureModel('u2netp');
    expect(existsSync(modelPath)).toBe(true);
  });

  test('resumes an interrupted model download when the server supports byte ranges', async () => {
    const { ensureModel, getModelPath, getModelsDir } = await import(
      '../../src/engine/rembg/models.ts'
    );
    mkdirSync(getModelsDir(), { recursive: true });
    const modelPath = getModelPath('u2netp');
    const firstHalf = Buffer.from('first');
    const secondHalf = Buffer.from('second');
    writeFileSync(`${modelPath}.partial`, firstHalf);

    let requestedRange: string | null = null;
    globalThis.fetch = (async (_input, init) => {
      requestedRange = new Headers(init?.headers).get('range');
      return new Response(secondHalf, {
        status: 206,
        headers: {
          'content-length': String(secondHalf.length),
          'content-range': `bytes ${firstHalf.length}-${firstHalf.length + secondHalf.length - 1}/${firstHalf.length + secondHalf.length}`,
        },
      });
    }) as typeof fetch;

    await ensureModel('u2netp');

    expect(String(requestedRange)).toBe(`bytes=${firstHalf.length}-`);
    expect(readFileSync(modelPath)).toEqual(Buffer.concat([firstHalf, secondHalf]));
  });

  test('retries a transient model-download response', async () => {
    const { ensureModel } = await import('../../src/engine/rembg/models.ts');
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) return new Response('busy', { status: 503 });
      return new Response('model-bytes', { headers: { 'content-length': '11' } });
    }) as unknown as typeof fetch;

    await ensureModel('u2netp');
    expect(attempts).toBe(2);
  });

  test('a cached model with the expected size but wrong checksum is discarded', async () => {
    process.env.MODEL_CHECKSUM_DISABLED = undefined;
    const { ensureModel, getModelInfo, getModelPath, getModelsDir } = await import(
      '../../src/engine/rembg/models.ts'
    );

    mkdirSync(getModelsDir(), { recursive: true });
    const modelPath = getModelPath('u2netp');
    writeFileSync(modelPath, Buffer.alloc(getModelInfo('u2netp').sizeBytes));
    globalThis.fetch = (async () =>
      new Response('offline', { status: 503 })) as unknown as typeof fetch;

    await expect(ensureModel('u2netp')).rejects.toThrow(/503/);
    expect(existsSync(modelPath)).toBe(false);
  });

  test('concurrent callers share one model download', async () => {
    const { ensureModel, getModelPath } = await import('../../src/engine/rembg/models.ts');
    const actualBytes = new Uint8Array(10).fill(7);
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(actualBytes.slice(), {
        headers: { 'content-length': String(actualBytes.length) },
      });
    }) as unknown as typeof fetch;

    const [first, second] = await Promise.all([ensureModel('u2netp'), ensureModel('u2netp')]);

    expect(first).toBe(getModelPath('u2netp'));
    expect(second).toBe(first);
    expect(fetches).toBe(1);
    expect(existsSync(`${first}.lock`)).toBe(false);
  });
});
