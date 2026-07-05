/**
 * Config file loading and persistence.
 *
 * Lives at $XDG_CONFIG_HOME/localpress/config.json (or ~/.config/localpress/config.json).
 * Permissions are 0600 — Application Passwords are full WP credentials and
 * deserve filesystem-level protection.
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config, SiteConfig } from '../../types.ts';
import { warn } from './output.ts';

/**
 * Site names become filesystem path components (`<name>.db`, snapshot blob
 * dirs), so they must not contain path separators or traversal sequences.
 */
export function isValidSiteName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}

export function assertValidSiteName(name: string): void {
  if (!isValidSiteName(name)) {
    throw new Error(`Invalid site name '${name}'. Use only letters, numbers, '.', '_' and '-'.`);
  }
}

/** Thrown for config-resolution failures (missing/corrupt config, no/unknown active site). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

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

/** Default empty config for first-run. */
function defaultConfig(): Config {
  return { version: 1, sites: {} };
}

/** Load the config file, creating a fresh empty config if it doesn't exist. */
export async function loadConfig(): Promise<Config> {
  const configPath = getConfigPath();
  const file = Bun.file(configPath);

  if (!(await file.exists())) {
    return defaultConfig();
  }

  try {
    const text = await file.text();
    const parsed = JSON.parse(text) as Config;

    // Basic shape validation.
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Config file is not a JSON object.');
    }
    if (typeof parsed.version !== 'number') {
      throw new Error('Config file is missing a "version" field.');
    }
    if (typeof parsed.sites !== 'object' || parsed.sites === null) {
      throw new Error('Config file is missing a "sites" object.');
    }

    return parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError(
      `Failed to read config at ${configPath}: ${message}\nIf the file is corrupt, you can delete it and run \`localpress init\` again.`,
    );
  }
}

/** Persist the config file with mode 0600. */
export async function saveConfig(config: Config): Promise<void> {
  const configPath = getConfigPath();

  // Ensure the config directory and sites subdirectory exist.
  mkdirSync(dirname(configPath), { recursive: true });
  mkdirSync(getSitesDir(), { recursive: true });

  // Write JSON with 2-space indent, creating the file 0600 from the outset so
  // Application Passwords are never briefly world-readable between write and
  // chmod. `mode` only applies on creation, so re-chmod existing files below.
  const data = `${JSON.stringify(config, null, 2)}\n`;
  if (process.platform === 'win32') {
    writeFileSync(configPath, data);
    return;
  }

  writeFileSync(configPath, data, { mode: 0o600 });
  try {
    // Enforce 0600 even when the file already existed (mode is ignored then).
    chmodSync(configPath, 0o600);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`Could not set 0600 permissions on ${configPath}: ${message}`);
  }
}

/** Resolve which site to act on, given an optional --site override. */
export function resolveActiveSite(config: Config, override?: string): SiteConfig {
  const name = override ?? config.activeSite;
  if (!name) {
    throw new ConfigError(
      'No active site configured. Run `localpress init` to add one, or pass --site <name>.',
    );
  }
  const site = config.sites[name];
  if (!site) {
    const known = Object.keys(config.sites);
    const hint = known.length
      ? `Known sites: ${known.join(', ')}`
      : 'No sites are configured. Run `localpress init` first.';
    throw new ConfigError(`Unknown site '${name}'. ${hint}`);
  }
  return site;
}
