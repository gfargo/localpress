/**
 * `localpress completions` — verifies the generated scripts are derived from
 * the live command tree instead of a hand-maintained list that can drift.
 *
 * Runs the real CLI as a subprocess (no mocks) so this exercises the actual
 * `program` built in src/cli/index.ts.
 */

import { describe, expect, test } from 'bun:test';

const CLI_ENTRY = new URL('../../src/cli/index.ts', import.meta.url).pathname;

const ALL_TOP_LEVEL_COMMANDS = [
  'init',
  'sites',
  'doctor',
  'config',
  'list',
  'show',
  'stats',
  'caption',
  'title',
  'describe',
  'classify',
  'tag',
  'vision',
  'metadata',
  'delete',
  'audit',
  'a11y',
  'optimize',
  'convert',
  'resize',
  'remove-bg',
  'edit',
  'pull',
  'push',
  'export',
  'import',
  'references',
  'regenerate',
  'rename',
  'history',
  'undo',
  'update',
  'watch',
  'watch-status',
  'posts',
  'mcp',
];

async function runCompletions(shell: string): Promise<string> {
  const proc = Bun.spawn([process.execPath, 'run', CLI_ENTRY, 'completions', shell], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(exitCode).toBe(0);
  return stdout;
}

describe('localpress completions', () => {
  test('bash output includes every registered top-level command', async () => {
    const bash = await runCompletions('bash');
    for (const cmd of ALL_TOP_LEVEL_COMMANDS) {
      expect(bash).toContain(cmd);
    }
  }, 30_000);

  test('convert advertises --to, not --format, and no --encoder', async () => {
    const bash = await runCompletions('bash');
    const convertBlock = bash.slice(bash.indexOf('convert)'), bash.indexOf('convert)') + 200);
    expect(convertBlock).toContain('--to');
    expect(convertBlock).not.toContain('--format');
    expect(convertBlock).not.toContain('--encoder');
  }, 30_000);

  test('optimize advertises --to (not --format)', async () => {
    const bash = await runCompletions('bash');
    const optimizeBlock = bash.slice(bash.indexOf('optimize)'), bash.indexOf('optimize)') + 400);
    expect(optimizeBlock).toContain('--to');
    expect(optimizeBlock).not.toContain('--format');
  }, 30_000);

  test('sites run subcommand is present', async () => {
    const bash = await runCompletions('bash');
    expect(bash).toContain('run) COMPREPLY=');
  }, 30_000);

  test('zsh output includes every registered top-level command and posts nesting', async () => {
    const zsh = await runCompletions('zsh');
    for (const cmd of ALL_TOP_LEVEL_COMMANDS) {
      expect(zsh).toContain(`'${cmd}:`);
    }
    expect(zsh).toContain('posts subcommand');
  }, 30_000);

  test('fish output includes every registered top-level command', async () => {
    const fish = await runCompletions('fish');
    for (const cmd of ALL_TOP_LEVEL_COMMANDS) {
      expect(fish).toContain(`-a "${cmd}"`);
    }
  }, 30_000);
});
