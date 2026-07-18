/**
 * SSH command execution helper for the WP-CLI adapter.
 *
 * Shells out to the system `ssh` and `scp` binaries rather than using a
 * Node SSH library. This avoids native module dependencies and works with
 * the user's existing SSH agent, config, and key management.
 */

import { spawn } from 'node:child_process';
import type { SshConfig } from '../types.ts';

export interface SshExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * POSIX shell-quote a value for safe interpolation into a remote command.
 *
 * Wraps in single quotes and escapes embedded single quotes via the `'\''`
 * idiom, so filenames/paths/metadata containing spaces, quotes, `$`, backticks,
 * or `;` can't break the command or inject shell execution.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Sanitize a value for safe use as a path *component* (e.g. a filename)
 * embedded in an scp remote destination string.
 *
 * `scp` remote paths are NOT argv-quoted by this module — under the legacy
 * scp protocol the remote path is interpreted by the remote shell, and no
 * single quoting scheme is correct under both the legacy and SFTP-based scp
 * protocols (see `scpUpload`/`scpDownload`). Callers that build a remote path
 * from user- or filesystem-provided input (e.g. an uploaded filename) MUST
 * pass that component through this function first, so the resulting path
 * contains no whitespace or shell metacharacters and can never be
 * interpreted by a remote shell regardless of protocol.
 *
 * Replaces every character outside `[A-Za-z0-9._-]` with `-`, collapses
 * repeats, trims leading/trailing `-`/`.`, and falls back to `file` if
 * nothing safe remains. The final extension (if any) is preserved.
 */
export function slugifyPathComponent(value: string): string {
  const slugged = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');

  return slugged || 'file';
}

/**
 * Guard against remote paths that could be misinterpreted by a remote shell
 * under the legacy scp protocol. Every current caller builds `remotePath`
 * from a sanitized component (see `slugifyPathComponent`); this only exists
 * to catch a future caller re-introducing an unsafe path, since the
 * destination is interpolated into `user@host:<remotePath>` unquoted (see
 * the module doc on `slugifyPathComponent` for why it can't simply be
 * shell-quoted instead).
 */
function assertSafeRemotePath(remotePath: string): void {
  if (/\s|[$`;&|<>(){}!*?[\]\\'"~]/.test(remotePath)) {
    throw new Error(
      `Unsafe scp remote path (contains whitespace or shell metacharacters): ${remotePath}`,
    );
  }
}

/**
 * Execute a command on a remote host via SSH.
 */
export async function sshExec(ssh: SshConfig, command: string): Promise<SshExecResult> {
  const args = buildSshArgs(ssh);
  args.push(command);

  return execProcess('ssh', args);
}

/**
 * Copy a local file to a remote host via SCP.
 */
export async function scpUpload(
  ssh: SshConfig,
  localPath: string,
  remotePath: string,
): Promise<SshExecResult> {
  assertSafeRemotePath(remotePath);

  const args: string[] = [];

  if (ssh.port && ssh.port !== 22) {
    args.push('-P', String(ssh.port));
  }
  if (ssh.identityFile) {
    args.push('-i', ssh.identityFile);
    args.push('-o', 'IdentitiesOnly=yes');
  }

  // Disable strict host key checking for non-interactive use.
  args.push('-o', 'StrictHostKeyChecking=accept-new');
  args.push('-o', 'BatchMode=yes');

  args.push(localPath);
  args.push(`${sshDestination(ssh)}:${remotePath}`);

  return execProcess('scp', args);
}

/**
 * Copy a remote file to a local path via SCP.
 */
export async function scpDownload(
  ssh: SshConfig,
  remotePath: string,
  localPath: string,
): Promise<SshExecResult> {
  assertSafeRemotePath(remotePath);

  const args: string[] = [];

  if (ssh.port && ssh.port !== 22) {
    args.push('-P', String(ssh.port));
  }
  if (ssh.identityFile) {
    args.push('-i', ssh.identityFile);
    args.push('-o', 'IdentitiesOnly=yes');
  }

  args.push('-o', 'StrictHostKeyChecking=accept-new');
  args.push('-o', 'BatchMode=yes');

  args.push(`${sshDestination(ssh)}:${remotePath}`);
  args.push(localPath);

  return execProcess('scp', args);
}

// -- Internal helpers (exported for testing) ----------------------------------

/**
 * Build the user@host destination string from config fields.
 * Supports legacy configs where user@ is already embedded in host.
 */
export function sshDestination(ssh: SshConfig): string {
  if (ssh.user && !ssh.host.includes('@')) {
    return `${ssh.user}@${ssh.host}`;
  }
  return ssh.host;
}

export function buildSshArgs(ssh: SshConfig): string[] {
  const args: string[] = [];

  if (ssh.port && ssh.port !== 22) {
    args.push('-p', String(ssh.port));
  }
  if (ssh.identityFile) {
    args.push('-i', ssh.identityFile);
    // Only use the specified key — don't let the agent offer all its keys first,
    // which causes "Too many authentication failures" on servers with low MaxAuthTries.
    args.push('-o', 'IdentitiesOnly=yes');
  }

  // Disable strict host key checking for non-interactive use.
  args.push('-o', 'StrictHostKeyChecking=accept-new');
  args.push('-o', 'BatchMode=yes');

  args.push(sshDestination(ssh));

  return args;
}

function execProcess(command: string, args: string[]): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to execute ${command}: ${err.message}`));
    });

    proc.on('close', (code) => {
      resolve({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: code ?? 1,
      });
    });
  });
}
