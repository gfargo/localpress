/**
 * Sharp loader with smart path discovery and auto-install.
 *
 * Sharp is a native module (libvips bindings) that can't be bundled into
 * Bun's compiled single-file binaries. This loader finds sharp in three ways:
 *
 *   1. Standard module resolution (works in dev mode / local node_modules)
 *   2. Well-known global paths (Bun, npm, Homebrew, yarn globals)
 *   3. Auto-install prompt (offers to run `bun install -g sharp` on first use)
 *
 * Results are cached — the module resolution only happens once per process.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { info } from '../../cli/utils/output.ts';

// biome-ignore lint/suspicious/noExplicitAny: sharp's type export varies by version
type SharpModule = any;

let cachedSharp: SharpModule | null = null;

/**
 * Well-known global paths where sharp might be installed.
 * Ordered by likelihood of containing sharp.
 */
function globalNodeModulesPaths(): string[] {
  const home = homedir();
  return [
    // Bun globals (most likely for our users)
    join(home, '.bun', 'install', 'global', 'node_modules'),
    // npm globals (Homebrew and system npm)
    '/opt/homebrew/lib/node_modules',
    '/usr/local/lib/node_modules',
    join(home, '.npm-global', 'lib', 'node_modules'),
    // Yarn globals
    join(home, '.config', 'yarn', 'global', 'node_modules'),
    // Windows paths
    join(process.env.APPDATA ?? '', 'npm', 'node_modules'),
    join(home, 'AppData', 'Roaming', 'npm', 'node_modules'),
  ].filter((p) => p && p !== '/node_modules');
}

/**
 * Try to find sharp in one of the well-known global paths.
 * Returns the absolute path to the sharp package directory, or null.
 */
function findSharpInGlobals(): string | null {
  for (const basePath of globalNodeModulesPaths()) {
    const sharpPath = join(basePath, 'sharp');
    if (existsSync(join(sharpPath, 'package.json'))) {
      return sharpPath;
    }
  }
  return null;
}

/**
 * Load sharp, trying standard resolution first, then well-known global paths.
 * Does NOT prompt for install — use loadSharpWithPrompt() for that.
 */
export async function loadSharp(): Promise<SharpModule> {
  if (cachedSharp) return cachedSharp;

  // Try 1: Standard module resolution (dev mode, local node_modules).
  try {
    const mod = await import('sharp');
    cachedSharp = mod.default;
    return cachedSharp;
  } catch {
    // Not in local node_modules — try global paths.
  }

  // Try 2: Well-known global paths.
  const globalPath = findSharpInGlobals();
  if (globalPath) {
    try {
      const mod = await import(globalPath);
      cachedSharp = mod.default;
      return cachedSharp;
    } catch {
      // Path exists but import failed — fall through to error.
    }
  }

  throw new SharpNotInstalledError();
}

/**
 * Check if sharp is available without throwing.
 */
export async function isSharpAvailable(): Promise<boolean> {
  try {
    await loadSharp();
    return true;
  } catch {
    return false;
  }
}

/**
 * Custom error class that commands can detect and offer auto-install.
 */
export class SharpNotInstalledError extends Error {
  constructor() {
    super(
      'sharp is not installed. Image processing requires sharp (libvips).\n\n' +
        'Quick fix:\n' +
        '  bun install -g sharp\n\n' +
        'Or with npm:\n' +
        '  npm install -g sharp\n\n' +
        'On macOS with Homebrew:\n' +
        '  brew install vips && bun install -g sharp\n\n' +
        'Or run `localpress doctor --fix` to install automatically.\n' +
        'See: https://sharp.pixelplumbing.com/install',
    );
    this.name = 'SharpNotInstalledError';
  }
}

/**
 * Install sharp globally via bun or npm.
 * Returns true on success, false on failure.
 */
export async function installSharpGlobally(): Promise<boolean> {
  const { spawn } = await import('node:child_process');

  // Prefer bun if available, fall back to npm.
  const installer = await detectPackageManager();
  if (!installer) return false;

  return new Promise((resolve) => {
    const args = installer === 'bun' ? ['install', '-g', 'sharp'] : ['install', '-g', 'sharp'];

    const proc = spawn(installer, args, { stdio: 'inherit' });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => {
      if (code === 0) {
        // Invalidate cache so next loadSharp() re-discovers it.
        cachedSharp = null;
      }
      resolve(code === 0);
    });
  });
}

async function detectPackageManager(): Promise<'bun' | 'npm' | null> {
  const { spawnSync } = await import('node:child_process');

  // Check bun first (our preferred runtime).
  try {
    const result = spawnSync('bun', ['--version'], { stdio: 'ignore' });
    if (result.status === 0) return 'bun';
  } catch {
    // Not installed.
  }

  // Fall back to npm.
  try {
    const result = spawnSync('npm', ['--version'], { stdio: 'ignore' });
    if (result.status === 0) return 'npm';
  } catch {
    // Not installed.
  }

  return null;
}

/**
 * Load sharp, and if not installed, prompt the user to auto-install it.
 * Respects --yes and --quiet global flags.
 *
 * Returns the loaded sharp module, or throws if installation was declined/failed.
 */
export async function loadSharpWithPrompt(opts: {
  /** Skip the prompt and auto-install (e.g. from --yes flag). */
  autoYes?: boolean;
  /** Suppress prompts entirely — just throw if not found (e.g. from --json or --quiet). */
  noPrompt?: boolean;
}): Promise<SharpModule> {
  try {
    return await loadSharp();
  } catch (err) {
    if (!(err instanceof SharpNotInstalledError)) throw err;

    // --yes wins even when --json/--quiet also set noPrompt.
    let shouldInstall = opts.autoYes ?? false;
    if (!shouldInstall) {
      if (opts.noPrompt) throw err;
      shouldInstall = await promptYesNo(
        '\nsharp is not installed. Image processing requires it.\nInstall now? [y/N]',
      );
    }

    if (!shouldInstall) {
      throw err;
    }

    info('\nInstalling sharp (this may take a minute)...\n');
    const success = await installSharpGlobally();

    if (!success) {
      throw new Error(
        'Failed to install sharp automatically.\n' +
          'Please install manually: bun install -g sharp',
      );
    }

    info('\nSharp installed. Retrying operation...\n');
    return await loadSharp();
  }
}

/**
 * y/N prompt — delegates to the shared prompt util which uses readline.
 */
async function promptYesNo(message: string): Promise<boolean> {
  const { promptYesNo: sharedPrompt } = await import('../../cli/utils/prompt.ts');
  return sharedPrompt(message);
}
