/**
 * doctor exit-code contract tests.
 *
 * Exercises the exit-code behaviour added in #267 (OSS-1354):
 *   - no sites configured  → exit 3 (ConfigError)
 *   - unreachable site     → exit 4 (NetworkError), connectionOk:false in --json
 *   - healthy site         → exit 0 (manual / integration tests only — needs live WP)
 *
 * Technique: Bun.spawnSync + isolated XDG_CONFIG_HOME (same pattern as
 * cli-error-handling.test.ts). We use Bun.spawnSync rather than
 * node:child_process's spawnSync because other unit test files replace the
 * whole node:child_process module process-wide via `mock.module()` (see
 * preview-server.test.ts / editor-detect.test.ts / quick-view-auth.test.ts)
 * without restoring it — depending on file load order that leaves `spawnSync`
 * undefined when this file imports it. Bun.spawnSync isn't affected.
 * Unreachable URLs use 127.0.0.1:1 to force an immediate ECONNREFUSED without
 * touching DNS.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_ENTRY = join(process.cwd(), 'src', 'cli', 'index.ts');

/** Spawn the CLI with an ephemeral config dir.  No site is seeded by default. */
function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number } {
  const configDir = mkdtempSync(join(tmpdir(), 'localpress-doctor-test-'));
  try {
    const result = Bun.spawnSync(['bun', 'run', CLI_ENTRY, ...args], {
      env: { ...process.env, XDG_CONFIG_HOME: configDir, ...extraEnv },
      timeout: 30_000,
    });
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode ?? 1,
    };
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

/**
 * Spawn the CLI with a pre-seeded config file pointing at a fake site URL.
 * The config is the minimal shape accepted by loadConfig().
 */
function runCliWithSite(
  args: string[],
  siteUrl: string,
): { stdout: string; stderr: string; exitCode: number } {
  const configDir = mkdtempSync(join(tmpdir(), 'localpress-doctor-site-test-'));
  try {
    // Write a minimal config.json understood by src/cli/utils/config.ts.
    const localpressDir = join(configDir, 'localpress');
    mkdirSync(localpressDir, { recursive: true });
    const config = {
      version: 1,
      activeSite: 'test-site',
      sites: {
        'test-site': {
          name: 'test-site',
          url: siteUrl,
          username: 'admin',
          appPassword: 'fake fake fake fake fake fake',
          createdAt: new Date().toISOString(),
        },
      },
    };
    writeFileSync(join(localpressDir, 'config.json'), JSON.stringify(config), { mode: 0o600 });

    const result = Bun.spawnSync(['bun', 'run', CLI_ENTRY, ...args], {
      env: { ...process.env, XDG_CONFIG_HOME: configDir },
      timeout: 30_000,
    });
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode ?? 1,
    };
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

describe('doctor exit codes', () => {
  // -------------------------------------------------------------------------
  // No sites configured
  // -------------------------------------------------------------------------
  test('doctor with no sites configured exits 3 (ConfigError)', () => {
    const { exitCode } = runCli(['doctor']);
    expect(exitCode).toBe(3);
  });

  test('doctor --all-sites with no sites configured exits 3 (ConfigError)', () => {
    const { exitCode } = runCli(['doctor', '--all-sites']);
    expect(exitCode).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Unreachable site — connection refused
  // -------------------------------------------------------------------------
  test('doctor with unreachable site exits 4 (NetworkError)', () => {
    // Port 1 on loopback is reliably refused without DNS involvement.
    const { exitCode } = runCliWithSite(['doctor'], 'http://127.0.0.1:1');
    expect(exitCode).toBe(4);
  });

  test('doctor --json with unreachable site exits 4 and emits connectionOk:false', () => {
    const { stdout, exitCode } = runCliWithSite(['doctor', '--json'], 'http://127.0.0.1:1');
    expect(exitCode).toBe(4);

    // stdout should contain a JSON object with connectionOk:false
    const lines = stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.connectionOk).toBe(false);

    // There should be at least one error-severity issue.
    const errorIssues = (parsed.issues as Array<{ severity: string }>).filter(
      (i) => i.severity === 'error',
    );
    expect(errorIssues.length).toBeGreaterThan(0);
  });

  test('doctor --all-sites with unreachable site exits 4', () => {
    const { exitCode } = runCliWithSite(['doctor', '--all-sites'], 'http://127.0.0.1:1');
    expect(exitCode).toBe(4);
  });

  // -------------------------------------------------------------------------
  // Bogus hostname — DNS error (ENOTFOUND)
  // -------------------------------------------------------------------------
  test('doctor with bogus hostname exits 4 (NetworkError)', () => {
    const { exitCode } = runCliWithSite(
      ['doctor'],
      'http://localpress-test-bogus-hostname-that-does-not-exist.invalid',
    );
    expect(exitCode).toBe(4);
  });
});
