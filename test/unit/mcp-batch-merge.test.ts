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
import {
  mergeBatchedOutputs,
  resolveChunkOutput,
  shapeCliResponse,
} from '../../src/cli/mcp/tools.ts';

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

  test('merges the dry-run `changes` block across chunks instead of keeping only the first (N-05 regression)', () => {
    const chunk = (start: number, count: number) => ({
      dryRun: true,
      processed: count,
      changes: {
        operation: 'optimize',
        count,
        items: Array.from({ length: count }, (_, i) => ({ id: start + i })),
      },
    });

    const merged = mergeBatchedOutputs([chunk(1, 5), chunk(6, 5)]);

    expect(merged.processed).toBe(10);
    expect(merged.changes).toEqual({
      operation: 'optimize',
      count: 10,
      items: [
        { id: 1 },
        { id: 2 },
        { id: 3 },
        { id: 4 },
        { id: 5 },
        { id: 6 },
        { id: 7 },
        { id: 8 },
        { id: 9 },
        { id: 10 },
      ],
    });
  });

  test('keeps `fields` from the first chunk when merging a metadata-shaped `changes` block', () => {
    const merged = mergeBatchedOutputs([
      {
        dryRun: true,
        changes: { operation: 'metadata', count: 1, items: [{ id: 1 }], fields: { title: 'a' } },
      },
      {
        dryRun: true,
        changes: { operation: 'metadata', count: 1, items: [{ id: 2 }], fields: { title: 'a' } },
      },
    ]);

    expect(merged.changes).toEqual({
      operation: 'metadata',
      count: 2,
      items: [{ id: 1 }, { id: 2 }],
      fields: { title: 'a' },
    });
  });
});

describe('resolveChunkOutput', () => {
  test('a chunk that partially fails but printed valid JSON is trusted (#197)', () => {
    const stdout = {
      processed: 4,
      failures: 1,
      results: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    };
    const { output, stderrNote } = resolveChunkOutput({ ok: false, stdout, exitCode: 1 }, 5, 2);

    expect(output).toEqual(stdout);
    expect(output.failures).toBe(1);
    expect(stderrNote).toContain('Batch 2 exited 1');
  });

  test('a chunk that hard-fails without parseable JSON falls back to a synthetic failure count', () => {
    const { output, stderrNote } = resolveChunkOutput(
      { ok: false, stdout: 'some raw error text', exitCode: 1 },
      5,
      1,
    );

    expect(output).toEqual({ failures: 5 });
    expect(stderrNote).toContain('Batch 1 failed (exit 1)');
  });

  test('a chunk with null stdout (spawn error) falls back to a synthetic failure count', () => {
    const { output, stderrNote } = resolveChunkOutput(
      { ok: false, stdout: null, exitCode: -1 },
      3,
      3,
    );

    expect(output).toEqual({ failures: 3 });
    expect(stderrNote).toContain('Batch 3 failed (exit -1)');
  });

  test('array stdout (NDJSON) is not treated as a usable object', () => {
    const { output, stderrNote } = resolveChunkOutput(
      { ok: false, stdout: [{ id: 1 }, { id: 2 }], exitCode: 1 },
      2,
      1,
    );

    expect(output).toEqual({ failures: 2 });
    expect(stderrNote).toContain('Batch 1 failed (exit 1)');
  });

  test('a fully successful chunk passes its JSON through unchanged with no stderr note', () => {
    const stdout = { processed: 5, failures: 0, results: [{ id: 1 }] };
    const { output, stderrNote } = resolveChunkOutput({ ok: true, stdout, exitCode: 0 }, 5, 1);

    expect(output).toEqual(stdout);
    expect(stderrNote).toBeUndefined();
  });
});

describe('shapeCliResponse', () => {
  test('a non-zero exit with a parseable JSON object attaches structuredContent and is not an error (#272)', () => {
    const stdout = { deleted: 2, failures: 1, results: [{ id: 1 }, { id: 2 }] };
    const response = shapeCliResponse({ ok: false, stdout, stderr: '', exitCode: 4 });

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toEqual(stdout);
    expect(response.content[0].text).toContain('exit 4');
  });

  test('a non-zero exit with array stdout (NDJSON) is still a hard error', () => {
    const response = shapeCliResponse({
      ok: false,
      stdout: [{ id: 1 }, { id: 2 }],
      stderr: '',
      exitCode: 1,
    });

    expect(response.isError).toBe(true);
    expect((response as { structuredContent?: unknown }).structuredContent).toBeUndefined();
  });

  test('a non-zero exit with raw text stdout is a hard error', () => {
    const response = shapeCliResponse({ ok: false, stdout: 'boom', stderr: '', exitCode: 1 });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('boom');
    expect(response.content[0].text).toContain('(exit 1)');
    expect((response as { structuredContent?: unknown }).structuredContent).toBeUndefined();
  });

  test('a non-zero exit with null stdout (spawn error) is a hard error', () => {
    const response = shapeCliResponse({
      ok: false,
      stdout: null,
      stderr: 'spawn failed',
      exitCode: -1,
    });

    expect(response.isError).toBe(true);
    expect((response as { structuredContent?: unknown }).structuredContent).toBeUndefined();
  });

  test('a successful run with object stdout attaches structuredContent and includes stderr in text', () => {
    const stdout = { processed: 3 };
    const response = shapeCliResponse({
      ok: true,
      stdout,
      stderr: 'a warning',
      exitCode: 0,
    });

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toEqual(stdout);
    expect(response.content[0].text).toContain('--- stderr ---\na warning');
  });

  test('a successful run with array stdout wraps structuredContent in items', () => {
    const response = shapeCliResponse({
      ok: true,
      stdout: [{ id: 1 }, { id: 2 }],
      stderr: '',
      exitCode: 0,
    });

    expect(response.structuredContent).toEqual({ items: [{ id: 1 }, { id: 2 }] });
  });
});
