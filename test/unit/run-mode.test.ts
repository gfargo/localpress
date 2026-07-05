/**
 * Unit tests for the shared dry-run/apply resolution used by destructive
 * commands (delete, posts delete/update, metadata, references --update-to).
 */

import { describe, expect, test } from 'bun:test';
import { resolveDryRun } from '../../src/cli/utils/run-mode.ts';

describe('resolveDryRun', () => {
  test('explicit-destructive default (false): executes when no flags', () => {
    expect(resolveDryRun({}, false)).toBe(false);
  });

  test('explicit --dry-run forces preview for a default-execute command', () => {
    expect(resolveDryRun({ dryRun: true }, false)).toBe(true);
  });

  test('--apply always wins over --dry-run', () => {
    expect(resolveDryRun({ dryRun: true, apply: true }, false)).toBe(false);
    expect(resolveDryRun({ dryRun: true, apply: true }, true)).toBe(false);
  });

  test('bulk default (true): dry-run unless --apply', () => {
    expect(resolveDryRun({}, true)).toBe(true);
    expect(resolveDryRun({ apply: true }, true)).toBe(false);
  });
});
