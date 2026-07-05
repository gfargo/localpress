/**
 * Spawn the localpress CLI from inside the MCP server and capture its --json output.
 *
 * Every MCP tool is a thin wrapper around the existing CLI: we build the argv,
 * spawn the same binary recursively, parse stdout as JSON, and return a
 * structured result. This reuses the CLI's stable JSON contract (which the
 * skill already depends on) and means every CLI feature appears in the MCP
 * server for free.
 *
 * Long-running ops can't stream progress this way — we get the final JSON
 * blob only. That's acceptable for v1.14; hot paths can move to in-process
 * dispatch later without changing the tool schemas.
 */

import { spawn } from 'node:child_process';
import { getSelfBin, isDevMode } from '../utils/self-invoke.ts';

export interface CliResult {
  /** Exit code from the child process. */
  exitCode: number;
  /** Parsed JSON output from stdout, or the raw text if parsing failed. */
  stdout: unknown;
  /** Raw stderr text — collected for error reporting. */
  stderr: string;
  /** True if exitCode === 0. */
  ok: boolean;
}

export interface InvokeOptions {
  /** Override site for this call. Maps to `--site <name>`. */
  site?: string;
  /** Parallel workers for bulk ops. Maps to `--concurrency <n>` at the top level. */
  concurrency?: number;
  /** Subcommand and its args, e.g. `['list', '--unoptimized']`. */
  args: string[];
  /** Working directory for the child process. */
  cwd?: string;
  /**
   * Timeout in ms; child is killed if exceeded. Default: 5 minutes. Pass 0 to
   * disable the timeout entirely (bulk cross-site runs can exceed any bound).
   */
  timeoutMs?: number;
  /**
   * Extra top-level flags to forward before the subcommand (e.g. `--apply`,
   * `--dry-run`, `--strict`). Used by `sites run` so per-site children honor the
   * run mode the user set on the parent.
   */
  passthroughFlags?: string[];
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function invokeCli(opts: InvokeOptions): Promise<CliResult> {
  const bin = getSelfBin(process.argv, process.execPath);
  const baseArgs = [...opts.args];

  // Always force JSON output for MCP tools.
  if (!baseArgs.includes('--json')) baseArgs.push('--json');
  // Suppress info-level chatter; we only want the JSON record.
  if (!baseArgs.includes('--quiet')) baseArgs.push('--quiet');

  // Inject top-level flags (--site, --concurrency) — these go BEFORE the
  // subcommand in commander, not as subcommand options.
  const topLevelFlags: string[] = [];
  if (opts.site) topLevelFlags.push('--site', opts.site);
  if (typeof opts.concurrency === 'number') {
    topLevelFlags.push('--concurrency', String(opts.concurrency));
  }
  for (const flag of opts.passthroughFlags ?? []) {
    if (!baseArgs.includes(flag)) topLevelFlags.push(flag);
  }
  const argsWithSite = [...topLevelFlags, ...baseArgs];

  // In dev mode (`bun src/cli/index.ts mcp`), we need to re-invoke with the
  // script path as the first arg so bun knows what to run. In prod (compiled
  // binary or wrapper), the binary is the entrypoint and args go directly.
  const childArgs = isDevMode(process.argv, process.execPath)
    ? [process.argv[1], ...argsWithSite]
    : argsWithSite;

  return await new Promise<CliResult>((resolve) => {
    const child = spawn(bin, childArgs, {
      cwd: opts.cwd ?? process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;

    const effectiveTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    // effectiveTimeout === 0 disables the timeout (unbounded bulk runs).
    const timer =
      effectiveTimeout > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            // Escalate to SIGKILL if the child ignores SIGTERM, so a stuck
            // child can never hang the parent forever.
            killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
          }, effectiveTimeout)
        : null;
    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimers();
      resolve({
        exitCode: -1,
        stdout: null,
        stderr: `${stderrBuf}${err.message}`,
        ok: false,
      });
    });

    child.on('close', (code) => {
      clearTimers();
      const exitCode = code ?? -1;
      let parsed: unknown = stdoutBuf;

      const trimmed = stdoutBuf.trim();
      if (trimmed.length > 0) {
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          // Some commands emit NDJSON (one record per line). Try line-by-line.
          const lines = trimmed.split('\n').filter(Boolean);
          if (lines.length > 1) {
            try {
              parsed = lines.map((l) => JSON.parse(l));
            } catch {
              // Fall back to raw text.
              parsed = trimmed;
            }
          } else {
            parsed = trimmed;
          }
        }
      }

      resolve({
        exitCode,
        stdout: parsed,
        stderr: timedOut ? `${stderrBuf}\n[timed out after ${effectiveTimeout}ms]` : stderrBuf,
        ok: exitCode === 0,
      });
    });
  });
}
