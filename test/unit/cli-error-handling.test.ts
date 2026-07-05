/**
 * CLI-level exit code / error-shape tests.
 *
 * Invokes the CLI entry point directly via `bun run src/cli/index.ts` with an
 * isolated XDG_CONFIG_HOME so there's never an active site configured — that
 * lets us exercise the top-level error/exit-code contract documented in
 * skill/SKILL.md without needing a real WordPress backend.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_ENTRY = join(process.cwd(), 'src', 'cli', 'index.ts');

function run(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const configDir = mkdtempSync(join(tmpdir(), 'localpress-cli-error-test-'));
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

describe('CLI error handling', () => {
  test('list --json with no active site: structured JSON error, exit 3', () => {
    const { stderr, exitCode } = run(['list', '--json']);
    expect(exitCode).toBe(3);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.level).toBe('error');
    expect(parsed.message).toContain('No active site configured');
  });

  test('list with no active site (no --json): plain-text error, exit 3', () => {
    const { stderr, exitCode } = run(['list']);
    expect(exitCode).toBe(3);
    expect(stderr.trim()).toStartWith('error: ');
    expect(stderr).toContain('No active site configured');
  });

  test('unknown command exits 2', () => {
    const { exitCode } = run(['frobnicate']);
    expect(exitCode).toBe(2);
  });

  test('unknown command with --json exits 2 with structured error', () => {
    const { stderr, exitCode } = run(['frobnicate', '--json']);
    expect(exitCode).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.level).toBe('error');
  });

  test('list --limit abc is a usage error (exit 2), not a config error', () => {
    const { exitCode } = run(['list', '--limit', 'abc']);
    expect(exitCode).toBe(2);
  });

  test('--help exits 0', () => {
    const { exitCode } = run(['--help']);
    expect(exitCode).toBe(0);
  });

  test('--version exits 0', () => {
    const { exitCode } = run(['--version']);
    expect(exitCode).toBe(0);
  });
});
