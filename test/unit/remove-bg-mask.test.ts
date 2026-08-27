import { describe, expect, test } from 'bun:test';
import {
  applyAlphaMask,
  normalizeRgbPixels,
  removeBackground,
  resizeAlphaMask,
  validateAlphaThreshold,
} from '../../src/engine/rembg/remove-bg.ts';

describe('applyAlphaMask', () => {
  test('combines the generated mask with source transparency', () => {
    const rgba = Buffer.from([10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 0]);

    applyAlphaMask(rgba, Buffer.from([128, 128, 255]));

    expect([...rgba]).toEqual([10, 20, 30, 128, 40, 50, 60, 64, 70, 80, 90, 0]);
  });

  test('rejects mismatched mask dimensions', () => {
    expect(() => applyAlphaMask(Buffer.alloc(8), Buffer.alloc(1))).toThrow(/size mismatch/i);
  });
});

describe('resizeAlphaMask', () => {
  test('returns exactly one byte per resized pixel', async () => {
    const resized = await resizeAlphaMask(Buffer.alloc(4 * 4, 128), 4, 3, 2);

    expect(resized.length).toBe(6);
    expect([...resized]).toEqual([128, 128, 128, 128, 128, 128]);
  });

  test('rejects a malformed model mask', async () => {
    await expect(resizeAlphaMask(Buffer.alloc(15), 4, 3, 2)).rejects.toThrow(/size mismatch/i);
  });
});

describe('validateAlphaThreshold', () => {
  test.each([0, 10, 255])('accepts %d', (value) => {
    expect(validateAlphaThreshold(value)).toBe(value);
  });

  test.each([-1, 256, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (value) => {
    expect(() => validateAlphaThreshold(value)).toThrow(/alpha threshold/i);
  });
});

describe('removeBackground option validation', () => {
  test('rejects an unknown model before loading native dependencies', async () => {
    await expect(
      removeBackground(Buffer.alloc(0), { model: 'not-a-model' as 'u2net' }),
    ).rejects.toThrow(/unknown background-removal model/i);
  });

  test('rejects an out-of-range threshold before downloading a model', async () => {
    await expect(removeBackground(Buffer.alloc(0), { alphaThreshold: 256 })).rejects.toThrow(
      /alpha threshold/i,
    );
  });
});

describe('normalizeRgbPixels', () => {
  test('uses ISNet mean/std values', () => {
    const tensor = normalizeRgbPixels(Buffer.from([255, 255, 255]), 'isnet-general-use');

    expect([...tensor]).toEqual([0.5, 0.5, 0.5]);
  });

  test('scales U2-Net-family inputs by their brightest value', () => {
    const tensor = normalizeRgbPixels(Buffer.from([128, 64, 32]), 'u2net');

    expect(tensor[0]).toBeCloseTo((1 - 0.485) / 0.229, 5);
    expect(tensor[1]).toBeCloseTo((0.5 - 0.456) / 0.224, 5);
    expect(tensor[2]).toBeCloseTo((0.25 - 0.406) / 0.225, 5);
  });

  test('uses a fixed /255 rescale for BiRefNet', () => {
    const tensor = normalizeRgbPixels(Buffer.from([128, 64, 32]), 'birefnet-lite');

    expect(tensor[0]).toBeCloseTo((128 / 255 - 0.485) / 0.229, 5);
  });
});
