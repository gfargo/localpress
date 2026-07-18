/**
 * Editor detection and launching.
 *
 * Detects the system's default application for an image file and opens it.
 * Supports explicit override via --with flag.
 *
 * Platform support:
 *   - macOS: `open` (default app) or `open -a <app>`
 *   - Linux: `xdg-open` (default app) or direct command
 *   - Windows: `start` (default app) or direct command
 */

import { spawn } from 'node:child_process';

export interface OpenResult {
  /** The command that was used to open the file. */
  command: string;
  /** Arguments passed to the command. */
  args: string[];
}

/**
 * Open a file in the system's default application or a specified editor.
 *
 * Returns immediately after launching — does not wait for the editor to close.
 * The caller should use a file watcher to detect when the user saves.
 */
export function openInEditor(
  filePath: string,
  editorApp?: string,
  onError?: (err: Error) => void,
): OpenResult {
  const platform = process.platform;

  let command: string;
  let args: string[];

  if (editorApp) {
    // Explicit editor specified.
    if (platform === 'darwin') {
      command = 'open';
      args = ['-a', editorApp, filePath];
    } else {
      // Linux/Windows: try running the app directly.
      command = editorApp;
      args = [filePath];
    }
  } else {
    // Use system default.
    if (platform === 'darwin') {
      command = 'open';
      args = [filePath];
    } else if (platform === 'win32') {
      command = 'cmd';
      args = ['/c', 'start', '""', filePath];
    } else {
      // Linux and others.
      command = 'xdg-open';
      args = [filePath];
    }
  }

  // Spawn detached so the editor runs independently of our process.
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });

  // Without this, a missing editor binary (e.g. `--with gimp` when gimp
  // isn't on PATH, or no xdg-open on a headless box) surfaces as an
  // unhandled 'error' event and crashes the process mid-round-trip.
  child.on('error', (err) => {
    onError?.(err);
  });

  // Unref so our process can exit if needed (though we'll be watching).
  child.unref();

  return { command, args };
}

/**
 * Get a human-readable description of what editor will be used.
 */
export function describeEditor(editorApp?: string): string {
  if (editorApp) return editorApp;

  const platform = process.platform;
  if (platform === 'darwin') return 'default macOS application (Preview, Photoshop, etc.)';
  if (platform === 'win32') return 'default Windows application';
  return 'default application (xdg-open)';
}
