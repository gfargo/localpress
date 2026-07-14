/**
 * Dry-run honesty assertion.
 *
 * Verifies that every mutating command routes its mutation path through the
 * shared `resolveDryRun` helper from '../utils/run-mode.ts'.
 *
 * This is a static code-analysis test — it reads the source files and checks
 * for a literal `resolveDryRun(` call. If a new mutating command is added
 * without wiring the shared helper into its execution path, this test fails.
 *
 * The check deliberately requires the literal call (not just the substring
 * `dryRun` or `isDryRun`) so a comment, an unrelated identifier, or a
 * bulk-only `isBulk && !parentOpts.apply` check can't satisfy it — that
 * looser pattern previously let `optimize.ts`, `undo.ts`, and `posts.ts`
 * pass this test while their explicit-ID paths still reached live mutations.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const COMMANDS_DIR = join(import.meta.dir, '../../src/cli/commands');

/**
 * Commands that perform mutations (write to WordPress or local state).
 * These MUST route through `resolveDryRun`.
 */
const MUTATING_COMMANDS = [
  'optimize.ts',
  'convert.ts',
  'resize.ts',
  'remove-bg.ts',
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
  'references.ts',
];

describe('dry-run honesty — all mutating commands gate execution', () => {
  const commandFiles = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.ts'));

  for (const filename of MUTATING_COMMANDS) {
    test(`${filename} calls resolveDryRun(`, () => {
      const filepath = join(COMMANDS_DIR, filename);
      expect(commandFiles).toContain(filename);

      const source = readFileSync(filepath, 'utf8');
      expect(source).toContain('resolveDryRun(');
    });
  }
});
