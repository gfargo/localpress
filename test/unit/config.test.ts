/**
 * Unit tests for config loading and persistence.
 * Uses a temp directory to avoid touching the real config.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Config } from '../../src/types.ts';

// We need to override the config dir for testing. The simplest approach
// is to set XDG_CONFIG_HOME before importing the config module.
let tempDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'localpress-test-'));
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tempDir;
});

afterEach(() => {
  if (originalXdg === undefined) {
    process.env.XDG_CONFIG_HOME = undefined;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdg;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

// Dynamic import to pick up the env var each time.
async function getConfigModule() {
  // Re-import to get fresh getConfigDir() resolution.
  // Bun caches modules, but getConfigDir() reads env at call time, so this works.
  const mod = await import('../../src/cli/utils/config.ts');
  return mod;
}

describe('loadConfig', () => {
  test('returns default config when no file exists', async () => {
    const { loadConfig } = await getConfigModule();
    const config = await loadConfig();
    expect(config.version).toBe(1);
    expect(config.sites).toEqual({});
    expect(config.activeSite).toBeUndefined();
  });

  test('loads a saved config', async () => {
    const { loadConfig, saveConfig } = await getConfigModule();

    const config: Config = {
      version: 1,
      activeSite: 'prod',
      sites: {
        prod: {
          name: 'prod',
          url: 'https://example.com',
          username: 'admin',
          appPassword: 'aaaa bbbb cccc dddd eeee ffff',
          createdAt: new Date().toISOString(),
        },
      },
    };

    await saveConfig(config);
    const loaded = await loadConfig();

    expect(loaded.version).toBe(1);
    expect(loaded.activeSite).toBe('prod');
    expect(loaded.sites.prod.url).toBe('https://example.com');
    expect(loaded.sites.prod.appPassword).toBe('aaaa bbbb cccc dddd eeee ffff');
  });

  test('throws a friendly error on corrupt JSON', async () => {
    const { loadConfig, getConfigPath } = await getConfigModule();
    const configPath = getConfigPath();

    // Write garbage to the config file.
    const { mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(configPath), { recursive: true });
    await Bun.write(configPath, 'not valid json {{{');

    await expect(loadConfig()).rejects.toThrow('Failed to read config');
  });
});

describe('saveConfig', () => {
  test('creates the config directory if it does not exist', async () => {
    const { saveConfig, getConfigPath } = await getConfigModule();

    await saveConfig({ version: 1, sites: {} });

    const file = Bun.file(getConfigPath());
    expect(await file.exists()).toBe(true);
  });

  test('creates the sites subdirectory', async () => {
    const { saveConfig, getSitesDir } = await getConfigModule();
    const { existsSync } = await import('node:fs');

    await saveConfig({ version: 1, sites: {} });

    expect(existsSync(getSitesDir())).toBe(true);
  });
});

describe('resolveActiveSite', () => {
  test('returns the active site when no override is given', async () => {
    const { resolveActiveSite } = await getConfigModule();

    const config: Config = {
      version: 1,
      activeSite: 'prod',
      sites: {
        prod: {
          name: 'prod',
          url: 'https://example.com',
          username: 'admin',
          appPassword: 'xxxx',
          createdAt: new Date().toISOString(),
        },
      },
    };

    const site = resolveActiveSite(config);
    expect(site.name).toBe('prod');
  });

  test('override takes precedence over activeSite', async () => {
    const { resolveActiveSite } = await getConfigModule();

    const config: Config = {
      version: 1,
      activeSite: 'prod',
      sites: {
        prod: {
          name: 'prod',
          url: 'https://prod.example.com',
          username: 'admin',
          appPassword: 'xxxx',
          createdAt: new Date().toISOString(),
        },
        staging: {
          name: 'staging',
          url: 'https://staging.example.com',
          username: 'admin',
          appPassword: 'yyyy',
          createdAt: new Date().toISOString(),
        },
      },
    };

    const site = resolveActiveSite(config, 'staging');
    expect(site.name).toBe('staging');
  });

  test('throws when no active site and no override', async () => {
    const { resolveActiveSite } = await getConfigModule();
    const config: Config = { version: 1, sites: {} };

    expect(() => resolveActiveSite(config)).toThrow('No active site configured');
  });

  test('throws when site name is unknown', async () => {
    const { resolveActiveSite } = await getConfigModule();
    const config: Config = {
      version: 1,
      activeSite: 'nonexistent',
      sites: {},
    };

    expect(() => resolveActiveSite(config)).toThrow("Unknown site 'nonexistent'");
  });
});

describe('mergeSiteConfig', () => {
  test('preserves ssh and original createdAt when updating an existing site', async () => {
    const { mergeSiteConfig } = await getConfigModule();

    const existing = {
      name: 'prod',
      url: 'https://old.example.com',
      username: 'old-admin',
      appPassword: 'old-password',
      ssh: {
        host: 'prod.example.com',
        user: 'deploy',
        wpPath: '/var/www/html',
      },
      createdAt: '2024-01-01T00:00:00.000Z',
    };

    const merged = mergeSiteConfig(existing, {
      name: 'prod',
      url: 'https://new.example.com',
      username: 'new-admin',
      appPassword: 'new-password',
    });

    expect(merged.url).toBe('https://new.example.com');
    expect(merged.username).toBe('new-admin');
    expect(merged.appPassword).toBe('new-password');
    expect(merged.ssh).toEqual(existing.ssh);
    expect(merged.createdAt).toBe('2024-01-01T00:00:00.000Z');
  });

  test('creates a fresh config with no ssh when there is no existing site', async () => {
    const { mergeSiteConfig } = await getConfigModule();

    const merged = mergeSiteConfig(undefined, {
      name: 'new-site',
      url: 'https://new-site.example.com',
      username: 'admin',
      appPassword: 'password',
    });

    expect(merged.ssh).toBeUndefined();
    expect(merged.createdAt).toBeTruthy();
    expect(merged.url).toBe('https://new-site.example.com');
  });
});
