/**
 * Regression test for the `optimize --preview` apply-fallback path, which used
 * to hardcode `-optimized.webp` regardless of the format the preview actually
 * produced. Uploading AVIF bytes under a `.webp` name makes WordPress derive
 * the wrong mime type from the extension.
 */

import { describe, expect, test } from 'bun:test';
import { mimeToExtension } from '../../src/cli/commands/optimize.ts';

describe('mimeToExtension', () => {
  test('maps known image mime types to their extension', () => {
    expect(mimeToExtension('image/avif')).toBe('.avif');
    expect(mimeToExtension('image/webp')).toBe('.webp');
    expect(mimeToExtension('image/jpeg')).toBe('.jpg');
    expect(mimeToExtension('image/png')).toBe('.png');
    expect(mimeToExtension('image/gif')).toBe('.gif');
  });

  test('returns undefined for an unknown mime type', () => {
    expect(mimeToExtension('image/tiff')).toBeUndefined();
  });
});

describe('preview onApply filename derivation', () => {
  // Mirrors the logic in optimize.ts's onApply callback: derive the upload
  // extension from resultMimeType, falling back to the source item's mime
  // type when the preview process didn't report one.
  function deriveFilename(
    originalFilename: string,
    resultMimeType: string | null,
    itemMimeType: string,
  ) {
    const ext = mimeToExtension(resultMimeType ?? itemMimeType) ?? '.jpg';
    return originalFilename.replace(/\.[^.]+$/, `-optimized${ext}`);
  }

  test('uses the result mime type when the preview converted format', () => {
    expect(deriveFilename('logo.png', 'image/avif', 'image/png')).toBe('logo-optimized.avif');
  });

  test('falls back to the source mime type when resultMimeType is null', () => {
    expect(deriveFilename('photo.jpg', null, 'image/jpeg')).toBe('photo-optimized.jpg');
  });

  test('falls back to .jpg when neither mime type is recognized', () => {
    expect(deriveFilename('scan.tiff', null, 'image/tiff')).toBe('scan-optimized.jpg');
  });
});
