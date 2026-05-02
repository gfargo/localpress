/**
 * Config file loading and persistence.
 *
 * Lives at $XDG_CONFIG_HOME/localpress/config.json (or ~/.config/localpress/config.json).
 * Permissions are 0600 — Application Passwords are full WP credentials and
 * deserve filesystem-level protection.
 *
 * Stub implementation for v0.1.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config, SiteConfig } from '../../types.ts';

/**
 * Resolve the localpress config directory, respecting XDG on Linux/macOS
 * and falling back sensibly on Windows.
 */
export function getConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return join(appData, 'localpress');
    return join(homedir(), 'AppData', 'Roaming', 'localpress');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, 'localpress');
  return join(homedir(), '.config', 'localpress');
}

export function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

export function getSitesDir(): string {
  return join(getConfigDir(), 'sites');
}

export function getSiteDbPath(siteName: string): string {
  return join(getSitesDir(), `${siteName}.db`);
}

/** Load the config file, creating a fresh empty config if it doesn't exist. */
export async function loadConfig(): Promise<Config> {
  // TODO(v0.1):
  //   1. Read getConfigPath() with Bun.file()
  //   2. If not found, return { version: 1, sites: {} }
  //   3. Validate shape, throw a friendly error if corrupt
  throw new Error('loadConfig not yet implemented');
}

/** Persist the config file with mode 0600. */
export async function saveConfig(_config: Config): Promise<void> {
  // TODO(v0.1):
  //   1. Ensure getConfigDir() exists (mkdir recursive)
  //   2. Write JSON with 2-space indent
  //   3. chmod 0600 on POSIX (skip on Windows)
  throw new Error('saveConfig not yet implemented');
}

/** Resolve which site to act on, given an optional --site override. */
export function resolveActiveSite(config: Config, override?: string): SiteConfig {
  const name = override ?? config.activeSite;
  if (!name) {
    throw new Error(
      'No active site configured. Run `localpress init` to add one, or pass --site <name>.',
    );
  }
  const site = config.sites[name];
  if (!site) {
    const known = Object.keys(config.sites);
    const hint = known.length
      ? `Known sites: ${known.join(', ')}`
      : 'No sites are configured. Run `localpress init` first.';
    throw new Error(`Unknown site '${name}'. ${hint}`);
  }
  return site;
}
