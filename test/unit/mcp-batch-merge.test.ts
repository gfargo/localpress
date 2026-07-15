/**
 * Unit tests for mergeBatchedOutputs — the generic merge used by
 * runCliBatched (MCP server) to combine per-chunk `--json` output from a
 * batched CLI run without hardcoding any one command's JSON shape.
 *
 * Regression for #208: batched caption (>5 ids) used to return an
 * optimize-shaped object ({processed, failures, totalSavedBytes, results}),
 * dropping caption's `dryRun`/`skipped` fields and injecting a bogus
 * `totalSavedBytes: 0`.
 */

import { describe, expect, test } from 'bun:test';
import { mergeBatchedOutputs } from '../../src/cli/mcp/tools.ts';

describe('mergeBatchedOutputs', () => {
  test('preserves caption shape (dryRun/skipped) and omits totalSavedBytes', () => {
    const merged = mergeBatchedOutputs([
      { dryRun: false, processed: 3, skipped: 1, failures: 0, results: [{ id: 1 }, { id: 2 }] },
      { dryRun: false, processed: 2, skipped: 0, failures: 1, results: [{ id: 3 }] },
    ]);

    expect(merged).toEqual({
      dryRun: false,
      processed: 5,
      skipped: 1,
      failures: 1,
      results: [{ id: 1 }, { id: 2 }, { id: 3 }],
    });
    expect(merged).not.toHaveProperty('totalSavedBytes');
  });

  test('sums totalSavedBytes for optimize-shaped output', () => {
    const merged = mergeBatchedOutputs([
      { processed: 5, failures: 0, totalSavedBytes: 1000, results: [] },
      { processed: 5, failures: 0, totalSavedBytes: 2500, results: [] },
    ]);

    expect(merged.processed).toBe(10);
    expect(merged.totalSavedBytes).toBe(3500);
    expect(merged).not.toHaveProperty('dryRun');
    expect(merged).not.toHaveProperty('skipped');
  });

  test('accounts for a failed chunk that only contributes a failures count', () => {
    const merged = mergeBatchedOutputs([
      { dryRun: true, processed: 2, skipped: 0, failures: 0, results: [{ id: 1 }] },
      { failures: 5 },
    ]);

    expect(merged.processed).toBe(2);
    expect(merged.failures).toBe(5);
    expect(merged.dryRun).toBe(true);
    expect(merged.results).toEqual([{ id: 1 }]);
  });
});
