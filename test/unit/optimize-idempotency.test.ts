/**
 * Unit tests for `shouldSkipOptimize` — the pure idempotency decision used by
 * `optimize` to decide whether an attachment can be skipped.
 *
 * Regression coverage for localpress#97: re-runs re-compressing the whole
 * library (double-counted stats), `undo` permanently blocking re-optimizing,
 * and changed options being silently ignored.
 */

import { describe, expect, test } from 'bun:test';

import { shouldSkipOptimize } from '../../src/cli/commands/optimize.ts';
import type { OptimizeOptions } from '../../src/engine/image/types.ts';
import type { ProcessingHistoryRecord } from '../../src/engine/state/db.ts';

function record(overrides: Partial<ProcessingHistoryRecord> = {}): ProcessingHistoryRecord {
  return {
    id: 1,
    siteName: 'test-site',
    wpId: 1,
    operation: 'optimize',
    paramsJson: JSON.stringify({}),
    sourceHash: 'source-hash',
    resultHash: 'result-hash',
    bytesBefore: 1000,
    bytesAfter: 500,
    resultWpId: null,
    ranAt: Date.now(),
    durationMs: 100,
    status: 'success',
    errorMessage: null,
    revertedAt: null,
    ...overrides,
  };
}

const OPTS: OptimizeOptions = { toFormat: 'webp', quality: 80 };

describe('shouldSkipOptimize', () => {
  test('no prior run: never skip', () => {
    expect(shouldSkipOptimize(null, 'result-hash', OPTS, false)).toBe(false);
  });

  test('optimize -> optimize with no changes: skips (live file hash matches prior RESULT hash)', () => {
    const last = record({ resultHash: 'result-hash', paramsJson: JSON.stringify(OPTS) });
    // The server file after replace-in-place now has the hash of the PREVIOUS
    // run's output, so the current download hash equals resultHash.
    expect(shouldSkipOptimize(last, 'result-hash', OPTS, false)).toBe(true);
  });

  test('does NOT skip when compared against sourceHash instead of resultHash (bug #1 regression)', () => {
    const last = record({
      sourceHash: 'original-hash',
      resultHash: 'result-hash',
      paramsJson: JSON.stringify(OPTS),
    });
    // A naive comparison against sourceHash would fail to match the live
    // file's hash (which now equals resultHash), so this must skip.
    expect(shouldSkipOptimize(last, 'result-hash', OPTS, false)).toBe(true);
    // And must NOT skip if compared incorrectly against the old sourceHash.
    expect(shouldSkipOptimize(last, 'original-hash', OPTS, false)).toBe(false);
  });

  test('optimize -> undo -> optimize: re-optimizes (restored bytes no longer match resultHash)', () => {
    const last = record({ resultHash: 'result-hash', paramsJson: JSON.stringify(OPTS) });
    // After undo restores the original bytes, the live file hash reverts to
    // the original source hash, which differs from the recorded resultHash.
    expect(shouldSkipOptimize(last, 'original-hash', OPTS, false)).toBe(false);
  });

  test('webp-would-be-larger skip, then --to avif: new params force a re-run', () => {
    const skippedOpts: OptimizeOptions = { toFormat: 'webp' };
    const last = record({
      status: 'skipped',
      sourceHash: 'source-hash',
      resultHash: 'source-hash', // "skipped" path records resultHash === sourceHash
      paramsJson: JSON.stringify(skippedOpts),
    });
    const newOpts: OptimizeOptions = { toFormat: 'avif', targetSizeBytes: 100_000 };
    expect(shouldSkipOptimize(last, 'source-hash', newOpts, false)).toBe(false);
  });

  test('identical params after a skipped run: still skips (nothing changed)', () => {
    const skippedOpts: OptimizeOptions = { toFormat: 'webp' };
    const last = record({
      status: 'skipped',
      sourceHash: 'source-hash',
      resultHash: 'source-hash',
      paramsJson: JSON.stringify(skippedOpts),
    });
    expect(shouldSkipOptimize(last, 'source-hash', skippedOpts, false)).toBe(true);
  });

  test('a prior failure never causes a skip', () => {
    const last = record({ status: 'failure', resultHash: 'result-hash' });
    expect(shouldSkipOptimize(last, 'result-hash', OPTS, false)).toBe(false);
  });

  test('--force always bypasses the skip, even for an exact match', () => {
    const last = record({ resultHash: 'result-hash', paramsJson: JSON.stringify(OPTS) });
    expect(shouldSkipOptimize(last, 'result-hash', OPTS, true)).toBe(false);
  });

  test('different params on an otherwise-matching hash: does not skip', () => {
    const last = record({ resultHash: 'result-hash', paramsJson: JSON.stringify(OPTS) });
    const differentOpts: OptimizeOptions = { toFormat: 'avif', quality: 80 };
    expect(shouldSkipOptimize(last, 'result-hash', differentOpts, false)).toBe(false);
  });

  // --- Upload-as-new fallback (REST-only, no replace-in-place) --------------
  // Here the source attachment is never rewritten, so the live download hash
  // stays equal to the ORIGINAL source hash — resultWpId is the new attachment.

  test('upload-as-new fallback: unchanged source skips (no duplicate re-upload)', () => {
    // First run uploaded the optimized bytes as a *new* attachment (#123) and
    // left the source untouched. The prior record therefore has a non-null
    // resultWpId, sourceHash = original, resultHash = optimized (different).
    const last = record({
      sourceHash: 'original-hash',
      resultHash: 'optimized-hash',
      resultWpId: 123,
      paramsJson: JSON.stringify(OPTS),
    });
    // Second run downloads the still-original source, whose hash matches the
    // recorded sourceHash → skip instead of spawning another duplicate.
    expect(shouldSkipOptimize(last, 'original-hash', OPTS, false)).toBe(true);
  });

  test('upload-as-new fallback: changed source re-optimizes', () => {
    const last = record({
      sourceHash: 'original-hash',
      resultHash: 'optimized-hash',
      resultWpId: 123,
      paramsJson: JSON.stringify(OPTS),
    });
    // The source bytes changed (re-uploaded), so the live hash differs.
    expect(shouldSkipOptimize(last, 'different-source-hash', OPTS, false)).toBe(false);
  });

  test('upload-as-new fallback: changed params force a re-run', () => {
    const last = record({
      sourceHash: 'original-hash',
      resultHash: 'optimized-hash',
      resultWpId: 123,
      paramsJson: JSON.stringify(OPTS),
    });
    const differentOpts: OptimizeOptions = { toFormat: 'avif', quality: 80 };
    expect(shouldSkipOptimize(last, 'original-hash', differentOpts, false)).toBe(false);
  });
});
