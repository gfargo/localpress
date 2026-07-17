/**
 * CLI-level test for `sites --json` with no sites configured.
 *
 * Regression for #213 (1/3): the empty-sites branch used to route through
 * `info()`, which is suppressed in `--json`/`--quiet` mode, so `sites --json`
 * printed nothing at all. An agent (or the MCP `sites_list` tool, which always
 * calls with `--json --quiet`) couldn't tell "no sites configured" apart from
 * a broken invocation. It must now print a parseable `[]`.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_ENTRY = join(process.cwd(), 'src', 'cli', 'index.ts');

function run(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const configDir = mkdtempSync(join(tmpdir(), 'localpress-sites-json-test-'));
  try {
    const result = spawnSync('bun', ['run', CLI_ENTRY, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, XDG_CONFIG_HOME: configDir },
      timeout: 30_000,
    });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.status ?? 1,
    };
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

describe('sites --json with no sites configured', () => {
  test('prints a parseable empty array, not empty stdout', () => {
    const { stdout, exitCode } = run(['sites', '--json', '--quiet']);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).not.toBe('');
    expect(JSON.parse(stdout.trim())).toEqual([]);
  });

  test('non-JSON mode still prints the human-readable message', () => {
    const { stdout, exitCode } = run(['sites']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('No sites configured');
  });
});
