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
