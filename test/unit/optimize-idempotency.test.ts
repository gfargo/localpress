/**
 * Unit tests for the optimize idempotency decision (#97).
 *
 * The skip must compare the current file hash against the PREVIOUS OUTPUT
 * (resultHash), not the previous source — otherwise a re-run re-compresses
 * every image, and an undone file can never be re-optimized.
 */

import { describe, expect, test } from 'bun:test';
import { shouldSkipOptimize } from '../../src/cli/commands/optimize.ts';

const params = JSON.stringify({ toFormat: 'webp', quality: 80 });

describe('shouldSkipOptimize', () => {
  test('skips when current file is the prior output with the same params', () => {
    const last = { status: 'success', resultHash: 'OUT', paramsJson: params };
    // After replace-in-place, the server file hash == the previous resultHash.
    expect(shouldSkipOptimize(last, 'OUT', params)).toBe(true);
  });

  test('does NOT skip when the file still equals the original source', () => {
    // e.g. right after an undo restored the original bytes.
    const last = { status: 'success', resultHash: 'OUT', paramsJson: params };
    expect(shouldSkipOptimize(last, 'ORIGINAL', params)).toBe(false);
  });

  test('does NOT skip when params differ', () => {
    const last = { status: 'success', resultHash: 'OUT', paramsJson: params };
    const otherParams = JSON.stringify({ toFormat: 'avif', quality: 50 });
    expect(shouldSkipOptimize(last, 'OUT', otherParams)).toBe(false);
  });

  test('does NOT skip on a failed prior run, or with no history', () => {
    expect(
      shouldSkipOptimize(
        { status: 'failure', resultHash: 'OUT', paramsJson: params },
        'OUT',
        params,
      ),
    ).toBe(false);
    expect(shouldSkipOptimize(null, 'OUT', params)).toBe(false);
  });
});
