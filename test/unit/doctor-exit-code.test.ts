/**
 * doctor exit-code contract tests.
 *
 * Exercises the exit-code behaviour added in #267 (OSS-1354):
 *   - no sites configured  → exit 3 (ConfigError)
 *   - unreachable site     → exit 4 (NetworkError), connectionOk:false in --json
 *   - healthy site         → exit 0 (manual / integration tests only — needs live WP)
 *
 * Two techniques are used, split by whether the code path under test calls
 * `process.exit()` directly:
 *
 * - "no sites configured" calls `process.exit(ExitCode.ConfigError)` inline
 *   (src/cli/commands/doctor.ts), which would kill the whole test runner if
 *   invoked in-process — so those cases spawn a real CLI subprocess via
 *   Bun.spawnSync (same pattern as cli-error-handling.test.ts).
 *
 * - "unreachable site" only ever sets `process.exitCode` (never calls
 *   `process.exit()`), so it's safe to invoke doctor's action in-process. We
 *   tried simulating an unreachable site over real sockets/DNS (a hardcoded
 *   low port + `.invalid` hostname, then an OS-assigned loopback port bound
 *   and closed just before use, then a syntactically-invalid URL that never
 *   opens a socket at all) — all three passed reliably locally but produced
 *   exit 0 in CI, for reasons that don't point at any single layer we can
 *   control from a test. Rather than keep guessing at CI's network/DNS
 *   behavior, we sidestep it entirely: mock `globalThis.fetch` directly
 *   (the same technique already used by dry-run-honesty-behavior.test.ts and
 *   models.test.ts in this repo) so the "connection check failed" path is
 *   exercised deterministically regardless of environment.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command, Option } from 'commander';
import { registerDoctorCommand } from '../../src/cli/commands/doctor.ts';
import { saveConfig } from '../../src/cli/utils/config.ts';
import { setOutputOptions } from '../../src/cli/utils/output.ts';
import { preflightJsquashEncoder } from '../../src/engine/image/jsquash.ts';

const CLI_ENTRY = join(process.cwd(), 'src', 'cli', 'index.ts');
const SITE_NAME = 'testsite';

/**
 * Pre-warm the jSquash WASM codecs before any test in this file runs.
 *
 * The in-process doctor tests mock `globalThis.fetch` to simulate an
 * unreachable site. jSquash WASM modules use `fetch` to load their binary on
 * first initialization. If the mock is active when the module first loads, the
 * WASM state is permanently broken for the rest of the process — poisoning the
 * `encoder-preflight` tests that run later in the same test suite.
 *
 * Running a no-op preflight here ensures all jSquash WASM modules are fully
 * initialized before any fetch mock is installed.
 */
beforeAll(async () => {
  await preflightJsquashEncoder(['jpeg', 'png', 'webp', 'avif']);
});

/** Spawn the CLI with an ephemeral config dir. No site is seeded by default. */
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

// -----------------------------------------------------------------------------
// Unreachable site — connectivity check throws. Run in-process with a mocked
// `fetch` so the failure is deterministic regardless of the environment's
// network/DNS behavior (see the file-level comment above).
// -----------------------------------------------------------------------------

function buildProgram(): Command {
  const program = new Command();
  program
    .name('localpress')
    .exitOverride()
    .addOption(new Option('--site <name>', 'override the active site for this command'))
    .addOption(new Option('--all-sites', 'show capabilities for every configured site'))
    .addOption(new Option('--json', 'machine-readable JSON output').default(false))
    .addOption(new Option('--quiet', 'errors only; suppress info messages').default(false))
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts();
      setOutputOptions({ json: Boolean(opts.json), quiet: Boolean(opts.quiet) });
    });
  return program;
}

let originalXdgConfigHome: string | undefined;
let originalFetch: typeof fetch;
let originalExitCode: number | string | undefined | null;
let tmpDir: string;

beforeEach(() => {
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  originalFetch = globalThis.fetch;
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  tmpDir = mkdtempSync(join(tmpdir(), 'localpress-doctor-unreachable-test-'));
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exitCode = originalExitCode === null ? undefined : originalExitCode;
  setOutputOptions({ json: false, quiet: false });
  if (originalXdgConfigHome === undefined) {
    // biome-ignore lint/performance/noDelete: env var must be truly absent, not the string "undefined"
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A `fetch` that fails the way an unreachable host does: no HTTP response at all. */
function unreachableFetch(): typeof fetch {
  return (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
}

async function seedSite(url: string): Promise<void> {
  await saveConfig({
    version: 1,
    activeSite: SITE_NAME,
    sites: {
      [SITE_NAME]: {
        name: SITE_NAME,
        url,
        username: 'admin',
        appPassword: 'fake fake fake fake fake fake',
        createdAt: new Date(0).toISOString(),
      },
    },
  });
}

describe('doctor exit codes — unreachable site', () => {
  test('doctor with unreachable site exits 4 (NetworkError)', async () => {
    await seedSite('https://example.test');
    globalThis.fetch = unreachableFetch();

    const program = buildProgram();
    registerDoctorCommand(program);
    await program.parseAsync(['doctor'], { from: 'user' });

    expect(process.exitCode).toBe(4);
  });

  test('doctor --json with unreachable site exits 4 and emits connectionOk:false', async () => {
    await seedSite('https://example.test');
    globalThis.fetch = unreachableFetch();

    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    const program = buildProgram();
    registerDoctorCommand(program);
    try {
      await program.parseAsync(['doctor', '--json'], { from: 'user' });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(process.exitCode).toBe(4);

    const output = chunks.join('');
    const lines = output.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.connectionOk).toBe(false);

    const errorIssues = (parsed.issues as Array<{ severity: string }>).filter(
      (i) => i.severity === 'error',
    );
    expect(errorIssues.length).toBeGreaterThan(0);
  });

  test('doctor --all-sites with unreachable site exits 4', async () => {
    await saveConfig({
      version: 1,
      activeSite: SITE_NAME,
      sites: {
        [SITE_NAME]: {
          name: SITE_NAME,
          url: 'https://example.test',
          username: 'admin',
          appPassword: 'fake fake fake fake fake fake',
          createdAt: new Date(0).toISOString(),
        },
        'second-site': {
          name: 'second-site',
          url: 'https://example2.test',
          username: 'admin',
          appPassword: 'fake fake fake fake fake fake',
          createdAt: new Date(0).toISOString(),
        },
      },
    });
    globalThis.fetch = unreachableFetch();

    const program = buildProgram();
    registerDoctorCommand(program);
    await program.parseAsync(['doctor', '--all-sites'], { from: 'user' });

    expect(process.exitCode).toBe(4);
  });

  test('doctor with a second, independent unreachable site exits 4 (NetworkError)', async () => {
    await seedSite('https://another-example.test');
    globalThis.fetch = unreachableFetch();

    const program = buildProgram();
    registerDoctorCommand(program);
    await program.parseAsync(['doctor'], { from: 'user' });

    expect(process.exitCode).toBe(4);
  });
});
