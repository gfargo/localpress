/**
 * Unit tests for multi-select bulk action dispatch logic.
 *
 * Tests that bulk actions produce the correct command arguments
 * when dispatched from the interactive browser. Exercises the real
 * `buildDispatchArgs` export used by `list.ts`, not a hand-copied
 * re-implementation.
 */

import { describe, expect, test } from 'bun:test';

import { buildDispatchArgs } from '../../src/cli/utils/dispatch.ts';

describe('bulk action command arg building', () => {
  test('single optimize produces correct args', () => {
    const { subCmd, targetIds, extraArgs } = buildDispatchArgs({
      type: 'optimize',
      id: 2204,
      page: 1,
      cursor: 0,
      quality: 90,
      to: 'webp',
    });
    expect(subCmd).toBe('optimize');
    expect(targetIds).toEqual(['2204']);
    expect(extraArgs).toContain('--quality');
    expect(extraArgs).toContain('90');
    expect(extraArgs).toContain('--to');
    expect(extraArgs).toContain('webp');
    expect(extraArgs).not.toContain('--apply');
  });

  test('bulk optimize passes --apply and all IDs', () => {
    const { subCmd, targetIds, extraArgs } = buildDispatchArgs({
      type: 'bulk-optimize',
      ids: [100, 200, 300],
      page: 1,
      cursor: 0,
      quality: 80,
    });
    expect(subCmd).toBe('optimize');
    expect(targetIds).toEqual(['100', '200', '300']);
    expect(extraArgs).toContain('--apply');
    expect(extraArgs).toContain('--quality');
    expect(extraArgs).toContain('80');
  });

  test('bulk remove-bg passes --apply and all IDs', () => {
    const { subCmd, targetIds, extraArgs } = buildDispatchArgs({
      type: 'bulk-remove-bg',
      ids: [1, 2, 3],
      page: 1,
      cursor: 0,
    });
    expect(subCmd).toBe('remove-bg');
    expect(targetIds).toEqual(['1', '2', '3']);
    expect(extraArgs).toContain('--apply');
  });

  test('bulk convert passes format and --apply', () => {
    const { subCmd, targetIds, extraArgs } = buildDispatchArgs({
      type: 'bulk-convert',
      ids: [10, 20],
      page: 1,
      cursor: 0,
      to: 'avif',
    });
    expect(subCmd).toBe('convert');
    expect(targetIds).toEqual(['10', '20']);
    expect(extraArgs).toContain('--to');
    expect(extraArgs).toContain('avif');
    expect(extraArgs).toContain('--apply');
  });

  test('bulk pull passes all IDs without --apply', () => {
    const { subCmd, targetIds, extraArgs } = buildDispatchArgs({
      type: 'bulk-pull',
      ids: [5, 10, 15, 20],
      page: 1,
      cursor: 0,
    });
    expect(subCmd).toBe('pull');
    expect(targetIds).toEqual(['5', '10', '15', '20']);
    expect(extraArgs).not.toContain('--apply');
  });

  test('full command array is correct for bulk optimize', () => {
    const { subCmd, targetIds, extraArgs } = buildDispatchArgs({
      type: 'bulk-optimize',
      ids: [123, 456],
      page: 1,
      cursor: 0,
      to: 'webp',
    });
    // The full command would be: localpress optimize 123 456 --to webp --apply
    const fullArgs = [subCmd, ...targetIds, ...extraArgs];
    expect(fullArgs).toEqual(['optimize', '123', '456', '--to', 'webp', '--apply']);
  });

  test('single remove-bg with preview passes --preview', () => {
    const { subCmd, targetIds, extraArgs } = buildDispatchArgs({
      type: 'remove-bg',
      id: 99,
      page: 1,
      cursor: 0,
      preview: true,
    });
    expect(subCmd).toBe('remove-bg');
    expect(targetIds).toEqual(['99']);
    expect(extraArgs).toContain('--preview');
  });

  test('resize passes max-width and max-height when present', () => {
    const { subCmd, targetIds, extraArgs } = buildDispatchArgs({
      type: 'resize',
      id: 7,
      page: 1,
      cursor: 0,
      maxWidth: 1024,
      maxHeight: 768,
    });
    expect(subCmd).toBe('resize');
    expect(targetIds).toEqual(['7']);
    expect(extraArgs).toEqual(['--max-width', '1024', '--max-height', '768']);
  });

  test('caption dispatches with only the target id', () => {
    const { subCmd, targetIds, extraArgs } = buildDispatchArgs({
      type: 'caption',
      id: 42,
      page: 1,
      cursor: 0,
    });
    expect(subCmd).toBe('caption');
    expect(targetIds).toEqual(['42']);
    expect(extraArgs).toEqual([]);
  });

  test('unrecognized action type falls back to edit with the id', () => {
    const { subCmd, targetIds } = buildDispatchArgs({
      type: 'show',
      id: 5,
      page: 1,
      cursor: 0,
    });
    expect(subCmd).toBe('edit');
    expect(targetIds).toEqual(['5']);
  });
});
