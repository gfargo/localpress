/**
 * Dry-run honesty assertion.
 *
 * Verifies that every mutating command either:
 *   a) imports and calls `resolveDryRun` from '../utils/run-mode.ts', OR
 *   b) implements the equivalent inline pattern (`parentOpts.apply` / `isDryRun`)
 *
 * This is a static code-analysis test — it reads the source files and checks
 * for the presence of dry-run gating patterns. If a new mutating command is
 * added without proper dry-run handling, this test fails.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const COMMANDS_DIR = join(import.meta.dir, '../../src/cli/commands');

/**
 * Commands that perform mutations (write to WordPress or local state).
 * These MUST gate execution behind a dry-run check.
 *
 * Excluded: convert, resize, remove-bg, classify, push — these are
 * explicit-ID-only commands with no --all/--unoptimized bulk mode.
 * They execute immediately by design (same as `optimize 123`).
 */
const MUTATING_COMMANDS = [
  'optimize.ts',
  'caption.ts',
  'title.ts',
  'describe.ts',
  'tag.ts',
  'vision.ts',
  'rename.ts',
  'delete.ts',
  'metadata.ts',
  'import.ts',
  'regenerate.ts',
  'undo.ts',
  'posts.ts',
];

/**
 * Patterns that indicate proper dry-run gating.
 * A command must contain at least one of these.
 */
const DRY_RUN_PATTERNS = [
  'resolveDryRun', // uses the shared helper
  'isDryRun', // inline boolean variable
  'dryRun', // general reference to dry-run logic
  'parentOpts.apply', // checks --apply flag directly
  'options.apply', // MCP-style apply check
];

describe('dry-run honesty — all mutating commands gate execution', () => {
  const commandFiles = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.ts'));

  for (const filename of MUTATING_COMMANDS) {
    test(`${filename} contains dry-run gating`, () => {
      const filepath = join(COMMANDS_DIR, filename);
      expect(commandFiles).toContain(filename);

      const source = readFileSync(filepath, 'utf8');
      const hasDryRunCheck = DRY_RUN_PATTERNS.some((pattern) => source.includes(pattern));

      expect(hasDryRunCheck).toBe(true);
    });
  }
});
