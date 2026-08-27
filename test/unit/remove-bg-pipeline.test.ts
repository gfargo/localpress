import { describe, expect, test } from 'bun:test';
import { loadSharp } from '../../src/engine/image/sharp-loader.ts';
import type {
  OnnxInferenceSession,
  OnnxRuntime,
  OnnxTensor,
} from '../../src/engine/rembg/onnx-types.ts';
import { processBackgroundWithSession } from '../../src/engine/rembg/remove-bg.ts';

describe('background-removal image pipeline', () => {
  test('turns a deterministic segmentation mask into the expected cutout', async () => {
    const sharp = await loadSharp();
    const sourcePixels = Buffer.from([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 0, 255, 0, 255, 255, 0, 255, 255,
      255, 255, 255, 255, 255, 20, 30, 40, 128,
    ]);
    const source = await sharp(sourcePixels, {
      raw: { width: 4, height: 2, channels: 4 },
    })
      .png()
      .toBuffer();
    const { runtime, session } = fakeModelSession(splitMask());

    const result = await processBackgroundWithSession(source, 'u2netp', {}, runtime, session);
    const { data, info } = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true });

    expect(result.width).toBe(4);
    expect(result.height).toBe(2);
    expect(info.width).toBe(4);
    expect(info.height).toBe(2);
    expect(info.channels).toBe(4);

    const alpha = [data[3], data[7], data[11], data[15], data[19], data[23], data[27], data[31]];
    expect(alpha[0]).toBeLessThanOrEqual(5);
    expect(alpha[3]).toBe(0); // Existing source transparency stays transparent.
    expect(alpha[4]).toBeLessThanOrEqual(5);
    expect(alpha[7]).toBeGreaterThanOrEqual(120); // Existing 128 alpha is preserved, not replaced.
    expect(alpha[2]).toBeGreaterThanOrEqual(235);
    expect(alpha[6]).toBeGreaterThanOrEqual(235);
  });

  test('flattens removed pixels onto a requested background color', async () => {
    const sharp = await loadSharp();
    const source = await sharp({
      create: { width: 4, height: 2, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const { runtime, session } = fakeModelSession(splitMask());

    const result = await processBackgroundWithSession(
      source,
      'u2netp',
      { backgroundColor: '#ffffff' },
      runtime,
      session,
    );
    const { data, info } = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true });

    expect(info.channels).toBe(3);
    expect([...data.subarray(0, 3)]).toEqual([255, 255, 255]);
    expect([...data.subarray(9, 12)]).toEqual([10, 20, 30]);
  });

  test('supports concurrent inference through one shared session', async () => {
    const sharp = await loadSharp();
    const source = await sharp({
      create: { width: 3, height: 2, channels: 3, background: { r: 50, g: 100, b: 150 } },
    })
      .png()
      .toBuffer();
    let active = 0;
    let maxActive = 0;
    const { runtime, session } = fakeModelSession(splitMask(), async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    });

    const outputs = await Promise.all(
      Array.from({ length: 3 }, () =>
        processBackgroundWithSession(source, 'u2netp', {}, runtime, session),
      ),
    );

    expect(maxActive).toBe(3);
    expect(outputs[1].bytes).toEqual(outputs[0].bytes);
    expect(outputs[2].bytes).toEqual(outputs[0].bytes);
  });
});

function splitMask(): Float32Array {
  const size = 320;
  const mask = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = size / 2; x < size; x += 1) mask[y * size + x] = 1;
  }
  return mask;
}

function fakeModelSession(
  mask: Float32Array,
  beforeResult?: () => Promise<void>,
): { runtime: OnnxRuntime; session: OnnxInferenceSession } {
  const session: OnnxInferenceSession = {
    inputNames: ['input'],
    outputNames: ['output'],
    async run() {
      await beforeResult?.();
      const output: OnnxTensor = {
        data: mask,
        dims: [1, 1, 320, 320],
        type: 'float32',
      };
      return { output };
    },
    async release() {},
  };
  const runtime: OnnxRuntime = {
    InferenceSession: {
      async create() {
        return session;
      },
    },
    Tensor: class {
      constructor(
        readonly type: string,
        readonly data: Float32Array,
        readonly dims: number[],
      ) {}
    },
  };
  return { runtime, session };
}
