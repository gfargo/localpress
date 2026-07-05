/**
 * Unit tests for EXIF-orientation handling in remove-bg.
 *
 * `removeBackground()` itself needs onnxruntime-node + a downloaded model, so
 * it isn't exercised directly here. Instead we test the dimension-swap math
 * that determines whether the mask/output are sized against the rotated
 * (upright) image or the raw stored image — getting this wrong is exactly
 * what made cutouts sideways for EXIF-oriented photos.
 */

import { describe, expect, test } from 'bun:test';
import { getOrientedDimensions } from '../../src/engine/rembg/remove-bg.ts';

describe('getOrientedDimensions', () => {
  test('no orientation tag keeps original dimensions', () => {
    expect(getOrientedDimensions({ width: 100, height: 50 })).toEqual({
      width: 100,
      height: 50,
    });
  });

  test.each([1, 2, 3, 4])('orientation %d does not swap dimensions', (orientation) => {
    expect(getOrientedDimensions({ width: 100, height: 50, orientation })).toEqual({
      width: 100,
      height: 50,
    });
  });

  test.each([5, 6, 7, 8])('orientation %d swaps width/height', (orientation) => {
    expect(getOrientedDimensions({ width: 100, height: 50, orientation })).toEqual({
      width: 50,
      height: 100,
    });
  });
});
