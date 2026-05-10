/**
 * Unit tests for multi-select bulk action dispatch logic.
 *
 * Tests that bulk actions produce the correct command arguments
 * when dispatched from the interactive browser.
 */

import { describe, expect, test } from 'bun:test';

import type { MediaBrowserAction } from '../../src/cli/components/MediaBrowser.tsx';

describe('MediaBrowserAction bulk types', () => {
  test('bulk-optimize action has ids array', () => {
    const action: MediaBrowserAction = {
      type: 'bulk-optimize',
      ids: [123, 456, 789],
      page: 1,
      cursor: 0,
      quality: 85,
      to: 'webp',
    };
    expect(action.type).toBe('bulk-optimize');
    expect(action.ids).toEqual([123, 456, 789]);
    expect(action.quality).toBe(85);
    expect(action.to).toBe('webp');
  });

  test('bulk-remove-bg action has ids array', () => {
    const action: MediaBrowserAction = {
      type: 'bulk-remove-bg',
      ids: [100, 200],
      page: 2,
      cursor: 3,
    };
    expect(action.type).toBe('bulk-remove-bg');
    expect(action.ids).toHaveLength(2);
  });

  test('bulk-convert action has ids and format', () => {
    const action: MediaBrowserAction = {
      type: 'bulk-convert',
      ids: [1, 2, 3, 4, 5],
      page: 1,
      cursor: 0,
      to: 'avif',
    };
    expect(action.ids).toHaveLength(5);
    expect(action.to).toBe('avif');
  });

  test('bulk-pull action has ids array', () => {
    const action: MediaBrowserAction = {
      type: 'bulk-pull',
      ids: [10, 20, 30],
      page: 1,
      cursor: 0,
    };
    expect(action.ids).toEqual([10, 20, 30]);
  });
});

describe('bulk action command arg building', () => {
  // Replicate the dispatch logic from list.ts for testing.
  function buildBulkArgs(action: MediaBrowserAction): {
    subCmd: string;
    targetIds: string[];
    extraArgs: string[];
  } {
    let subCmd = '';
    let extraArgs: string[] = [];
    let targetIds: string[] = [];

    switch (action.type) {
      case 'optimize':
        subCmd = 'optimize';
        targetIds = [String(action.id)];
        if (action.quality !== undefined) extraArgs.push('--quality', String(action.quality));
        if (action.to) extraArgs.push('--to', action.to);
        if (action.keepOriginal) extraArgs.push('--keep-original');
        if (action.preview) extraArgs.push('--preview');
        break;
      case 'bulk-optimize':
        subCmd = 'optimize';
        targetIds = action.ids.map(String);
        if (action.quality !== undefined) extraArgs.push('--quality', String(action.quality));
        if (action.to) extraArgs.push('--to', action.to);
        extraArgs.push('--apply');
        break;
      case 'remove-bg':
        subCmd = 'remove-bg';
        targetIds = [String(action.id)];
        if (action.preview) extraArgs.push('--preview');
        break;
      case 'bulk-remove-bg':
        subCmd = 'remove-bg';
        targetIds = action.ids.map(String);
        extraArgs.push('--apply');
        break;
      case 'bulk-convert':
        subCmd = 'convert';
        targetIds = action.ids.map(String);
        extraArgs = ['--to', action.to];
        extraArgs.push('--apply');
        break;
      case 'bulk-pull':
        subCmd = 'pull';
        targetIds = action.ids.map(String);
        break;
      default:
        break;
    }

    return { subCmd, targetIds, extraArgs };
  }

  test('single optimize produces correct args', () => {
    const { subCmd, targetIds, extraArgs } = buildBulkArgs({
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
    const { subCmd, targetIds, extraArgs } = buildBulkArgs({
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
    const { subCmd, targetIds, extraArgs } = buildBulkArgs({
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
    const { subCmd, targetIds, extraArgs } = buildBulkArgs({
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
    const { subCmd, targetIds, extraArgs } = buildBulkArgs({
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
    const { subCmd, targetIds, extraArgs } = buildBulkArgs({
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
});
