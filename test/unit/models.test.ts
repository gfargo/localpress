/**
 * Unit tests for ONNX model download integrity (#130).
 *
 * A killed/interrupted `Bun.write` used to leave a truncated file directly at
 * the final `.onnx` path, which `isModelCached`/`ensureModel` then treated as
 * valid forever. `ensureModel` now writes to a `.partial` path, verifies the
 * byte count against `content-length`, and only renames into place on success.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir: string;
let originalXdg: string | undefined;
let originalFetch: typeof fetch;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'localpress-models-test-'));
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpDir;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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
    expect(isModelCached('u2netp')).toBe(true);
  });

  test('a stale leftover .partial file from a prior crash is overwritten, not treated as cached', async () => {
    const { ensureModel, getModelPath, getModelsDir } = await import(
      '../../src/engine/rembg/models.ts'
    );
    const { mkdirSync, writeFileSync } = await import('node:fs');

    mkdirSync(getModelsDir(), { recursive: true });
    const modelPath = getModelPath('u2netp');
    writeFileSync(`${modelPath}.partial`, new Uint8Array(3));

    const actualBytes = new Uint8Array(10).fill(1);
    mockFetchOnce(actualBytes, 10);

    await ensureModel('u2netp');
    expect(existsSync(modelPath)).toBe(true);
  });
});
