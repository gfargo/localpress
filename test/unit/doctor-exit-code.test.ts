/**
 * doctor exit-code contract tests.
 *
 * Exercises the exit-code behaviour added in #267 (OSS-1354):
 *   - no sites configured  → exit 3 (ConfigError)
 *   - unreachable site     → exit 4 (NetworkError), connectionOk:false in --json
 *   - healthy site         → exit 0 (manual / integration tests only — needs live WP)
 *
 * All cases use Bun.spawnSync to test exit codes in a subprocess, keeping
 * process.exitCode in the test runner's own process always zero. In-process
 * invocations that set process.exitCode would cause bun test to exit with a
 * non-zero code even when all assertions pass.
 *
 * For unreachable-site cases we use test/fixtures/doctor-unreachable.ts, a
 * small harness that mocks globalThis.fetch before running doctor. This gives
 * us deterministic "connection failed" behaviour regardless of CI network
 * configuration — no real sockets needed.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_ENTRY = join(process.cwd(), 'src', 'cli', 'index.ts');
const UNREACHABLE_FIXTURE = join(process.cwd(), 'test', 'fixtures', 'doctor-unreachable.ts');
const SITE_NAME = 'testsite';

/**
 * Seed a minimal localpress config file in the given config dir so
 * `loadConfig()` finds a site without any real network calls.
 */
function seedConfig(
  configDir: string,
  sites: Record<string, { url: string; username?: string; appPassword?: string }>,
  activeSite = SITE_NAME,
): void {
  mkdirSync(join(configDir, 'localpress'), { recursive: true });
  const config = {
    version: 1,
    activeSite,
    sites: Object.fromEntries(
      Object.entries(sites).map(([name, s]) => [
        name,
        {
          name,
          url: s.url,
          username: s.username ?? 'admin',
          appPassword: s.appPassword ?? 'fake fake fake fake fake fake',
          createdAt: new Date(0).toISOString(),
        },
      ]),
    ),
  };
  writeFileSync(
    join(configDir, 'localpress', 'config.json'),
    JSON.stringify(config, null, 2),
    'utf8',
  );
}

/** Spawn the CLI (no site seeded) with an ephemeral config dir. */
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
 * Spawn the unreachable-fixture script with a pre-seeded config dir so
 * globalThis.fetch is mocked before doctor runs. The fixture exits with
 * process.exitCode set by the doctor action — no pollution of the test
 * runner's own process.exitCode.
 */
function runUnreachable(
  doctorArgs: string[],
  sites: Record<string, { url: string }> = { [SITE_NAME]: { url: 'https://example.test' } },
  activeSite = SITE_NAME,
): { stdout: string; stderr: string; exitCode: number } {
  const configDir = mkdtempSync(join(tmpdir(), 'localpress-doctor-unreachable-'));
  try {
    seedConfig(configDir, sites, activeSite);
    const result = Bun.spawnSync(['bun', 'run', UNREACHABLE_FIXTURE, ...doctorArgs], {
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

// ---------------------------------------------------------------------------
// No sites configured — uses the real CLI entry point, no site seeded.
// ---------------------------------------------------------------------------

describe('doctor exit codes — no sites configured', () => {
  test('doctor with no sites configured exits 3 (ConfigError)', () => {
    const { exitCode } = runCli(['doctor']);
    expect(exitCode).toBe(3);
  });

  test('doctor --all-sites with no sites configured exits 3 (ConfigError)', () => {
    const { exitCode } = runCli(['doctor', '--all-sites']);
    expect(exitCode).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Unreachable site — fetch is mocked inside the subprocess fixture so the
// connection check always fails deterministically, regardless of CI network.
// ---------------------------------------------------------------------------

describe('doctor exit codes — unreachable site', () => {
  test('doctor with unreachable site exits 4 (NetworkError)', () => {
    const { exitCode } = runUnreachable(['doctor']);
    expect(exitCode).toBe(4);
  });

  test('doctor --json with unreachable site exits 4 and emits connectionOk:false', () => {
    const { stdout, exitCode } = runUnreachable(['doctor', '--json']);
    expect(exitCode).toBe(4);

    const lines = stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.connectionOk).toBe(false);

    const errorIssues = (parsed.issues as Array<{ severity: string }>).filter(
      (i) => i.severity === 'error',
    );
    expect(errorIssues.length).toBeGreaterThan(0);
  });

  test('doctor --all-sites with unreachable site exits 4', () => {
    const { exitCode } = runUnreachable(['doctor', '--all-sites'], {
      [SITE_NAME]: { url: 'https://example.test' },
      'second-site': { url: 'https://example2.test' },
    });
    expect(exitCode).toBe(4);
  });

  test('doctor with a second, independent unreachable site exits 4 (NetworkError)', () => {
    const { exitCode } = runUnreachable(
      ['doctor'],
      { 'another-site': { url: 'https://another-example.test' } },
      'another-site',
    );
    expect(exitCode).toBe(4);
  });
});
