/**
 * Shared harness for spawning `localpress` as a real CLI subprocess against
 * the Docker WordPress instance, in an isolated config directory.
 *
 * Mirrors the subprocess pattern used by test/unit/mcp.test.ts, but drives
 * the plain CLI (not the MCP server) so integration tests exercise the
 * actual command wiring (option parsing, JSON output shape) end-to-end.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CliHarness {
  /** Run a `localpress` subcommand; resolves with stdout/stderr/exit code. */
  run: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Run a subcommand and parse its --json stdout output. */
  runJson: <T = unknown>(args: string[]) => Promise<T>;
  /** Remove the isolated config directory. */
  cleanup: () => void;
  configHome: string;
  siteName: string;
}

/**
 * Create an isolated XDG_CONFIG_HOME with a single site pointed at the given
 * WordPress credentials, and return a harness for spawning CLI subcommands
 * against it.
 */
export async function createCliHarness(site: {
  url: string;
  username: string;
  appPassword: string;
}): Promise<CliHarness> {
  const configHome = mkdtempSync(join(tmpdir(), 'localpress-cli-test-'));
  const siteName = 'integration-test';

  const cliEntry = join(import.meta.dir, '..', '..', '..', 'src', 'cli', 'index.ts');

  const env = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
  };

  async function run(
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn([process.execPath, 'run', cliEntry, ...args], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  async function runJson<T = unknown>(args: string[]): Promise<T> {
    const { stdout, stderr, exitCode } = await run([...args, '--json']);
    if (exitCode !== 0 && exitCode !== 1) {
      throw new Error(`CLI exited ${exitCode} for [${args.join(' ')}]\nstderr: ${stderr}`);
    }
    try {
      return JSON.parse(stdout) as T;
    } catch (err) {
      throw new Error(
        `Failed to parse JSON stdout for [${args.join(' ')}]: ${err instanceof Error ? err.message : String(err)}\nstdout: ${stdout}\nstderr: ${stderr}`,
      );
    }
  }

  // Bootstrap the site via `sites add` so the CLI's own config-writing path
  // (mode 0600, schema shape) is exercised rather than hand-writing JSON.
  // The first site added becomes active automatically.
  const addResult = await run([
    'sites',
    'add',
    site.url,
    '--name',
    siteName,
    '--username',
    site.username,
    '--app-password',
    site.appPassword,
  ]);
  if (addResult.exitCode !== 0) {
    throw new Error(`Failed to bootstrap test site: ${addResult.stderr}`);
  }

  return {
    run,
    runJson,
    cleanup: () => rmSync(configHome, { recursive: true, force: true }),
    configHome,
    siteName,
  };
}
