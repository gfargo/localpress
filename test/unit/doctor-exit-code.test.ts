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
 *
 * "Unreachable" is simulated with a syntactically-invalid site URL rather
 * than an actually-unreachable network address. We tried two real-network
 * approaches first — a hardcoded low port + `.invalid` hostname, then an
 * OS-assigned loopback port bound and closed just before use — and *both*
 * passed reliably locally but produced exit 0 in CI (i.e. the REST call
 * apparently succeeded, or at least didn't throw). That points at CI's
 * network layer not refusing connections/failing DNS the same way a local
 * machine does, for reasons we can't control from here. A malformed URL
 * sidesteps the network stack entirely: `RestAdapter.apiUrl()` calls
 * `new URL(...)` on `${site.url}/wp-json/wp/v2${path}`, which throws
 * synchronously for a string with no valid scheme — no socket is ever
 * opened, so there's nothing for a network layer to intercept. Doctor's
 * catch block treats any non-`WpApiError` thrown from the connectivity
 * check as `code: 'network'` (see src/cli/commands/doctor.ts), so this
 * still exercises the real "connection check failed" → NetworkError path.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_ENTRY = join(process.cwd(), 'src', 'cli', 'index.ts');

/** No scheme — `new URL()` throws synchronously, before any socket is opened. */
const UNREACHABLE_SITE_URL = 'not-a-valid-url-without-a-scheme';
/** A second, distinct malformed URL for the "independent failure" test below. */
const UNREACHABLE_SITE_URL_2 = 'ht!tp://also-not-a-valid-url';

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
  // Unreachable site — connectivity check throws
  // -------------------------------------------------------------------------
  test('doctor with unreachable site exits 4 (NetworkError)', () => {
    const { exitCode } = runCliWithSite(['doctor'], UNREACHABLE_SITE_URL);
    expect(exitCode).toBe(4);
  });

  test('doctor --json with unreachable site exits 4 and emits connectionOk:false', () => {
    const { stdout, exitCode } = runCliWithSite(['doctor', '--json'], UNREACHABLE_SITE_URL);
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
    const { exitCode } = runCliWithSite(['doctor', '--all-sites'], UNREACHABLE_SITE_URL);
    expect(exitCode).toBe(4);
  });

  // -------------------------------------------------------------------------
  // A second, distinct malformed URL — exercises the same "any non-WpApiError
  // thrown from the connectivity check is a NetworkError" path with a
  // different failure shape (unparseable scheme vs. no scheme at all).
  // -------------------------------------------------------------------------
  test('doctor with a second unreachable site exits 4 (NetworkError)', () => {
    const { exitCode } = runCliWithSite(['doctor'], UNREACHABLE_SITE_URL_2);
    expect(exitCode).toBe(4);
  });
});
