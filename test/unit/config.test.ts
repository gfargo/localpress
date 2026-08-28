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

describe('validateProfileObject', () => {
  // Import once — it is a pure function and doesn't depend on env or config dir.
  async function getValidate() {
    const { validateProfileObject } = await import('../../src/cli/commands/config.ts');
    return validateProfileObject;
  }

  test('accepts a profile with all 7 fields', async () => {
    const validate = await getValidate();
    const input: import('../../src/types.ts').OptimizationProfile = {
      description: 'Hero banner preset',
      quality: 80,
      format: 'webp',
      maxWidth: 1920,
      maxHeight: 1080,
      encoder: 'sharp',
      stripMetadata: true,
    };
    const result = validate(input);
    expect(result).toEqual(input);
  });

  test('accepts a profile with only some fields', async () => {
    const validate = await getValidate();
    const result = validate({ quality: 75, format: 'avif' });
    expect(result.quality).toBe(75);
    expect(result.format).toBe('avif');
    expect(result.description).toBeUndefined();
  });

  test('rejects a non-object (null)', async () => {
    const validate = await getValidate();
    expect(() => validate(null)).toThrow('Profile must be a JSON object');
  });

  test('rejects a non-object (string)', async () => {
    const validate = await getValidate();
    expect(() => validate('hero')).toThrow('Profile must be a JSON object');
  });

  test('rejects a non-object (array)', async () => {
    const validate = await getValidate();
    expect(() => validate([])).toThrow('Profile must be a JSON object');
  });

  test('rejects an empty object', async () => {
    const validate = await getValidate();
    expect(() => validate({})).toThrow('Profile object is empty');
  });

  test('rejects an unknown field', async () => {
    const validate = await getValidate();
    expect(() => validate({ quality: 80, bogus: 1 })).toThrow("Unknown field 'bogus'");
  });

  test('rejects multiple unknown fields — reports first one', async () => {
    const validate = await getValidate();
    expect(() => validate({ foo: 1, bar: 2 })).toThrow("Unknown field '");
  });

  test('rejects quality below 1', async () => {
    const validate = await getValidate();
    expect(() => validate({ quality: 0 })).toThrow("'quality' must be between 1 and 100");
  });

  test('rejects quality above 100', async () => {
    const validate = await getValidate();
    expect(() => validate({ quality: 101 })).toThrow("'quality' must be between 1 and 100");
  });

  test('rejects quality as a float', async () => {
    const validate = await getValidate();
    expect(() => validate({ quality: 80.5 })).toThrow("'quality' must be an integer");
  });

  test('rejects quality as a string', async () => {
    const validate = await getValidate();
    expect(() => validate({ quality: '80' })).toThrow("'quality' must be an integer");
  });

  test('rejects an invalid format', async () => {
    const validate = await getValidate();
    expect(() => validate({ format: 'gif' })).toThrow("'format' must be one of");
  });

  test('rejects an invalid encoder', async () => {
    const validate = await getValidate();
    expect(() => validate({ encoder: 'imagemagick' })).toThrow("'encoder' must be one of");
  });

  test('rejects maxWidth <= 0', async () => {
    const validate = await getValidate();
    expect(() => validate({ maxWidth: 0 })).toThrow("'maxWidth' must be a positive integer");
  });

  test('rejects maxHeight as a float', async () => {
    const validate = await getValidate();
    expect(() => validate({ maxHeight: 1080.5 })).toThrow("'maxHeight' must be a positive integer");
  });

  test('rejects stripMetadata as a non-boolean', async () => {
    const validate = await getValidate();
    expect(() => validate({ stripMetadata: 1 })).toThrow("'stripMetadata' must be a boolean");
  });

  test('preserves all 7 fields on a round-trip through JSON serialization', async () => {
    const validate = await getValidate();
    const original: import('../../src/types.ts').OptimizationProfile = {
      description: 'Round-trip test',
      quality: 85,
      format: 'jpeg',
      maxWidth: 2000,
      maxHeight: 1500,
      encoder: 'jsquash',
      stripMetadata: false,
    };
    // Simulate JSON round-trip (as export → import does via the file)
    const parsed = JSON.parse(JSON.stringify(original));
    const result = validate(parsed);
    expect(result).toEqual(original);
  });
});

describe('export-profile / import-profile filesystem round-trip', () => {
  test('exports and re-imports a profile preserving all fields', async () => {
    const { loadConfig, saveConfig } = await getConfigModule();
    const { validateProfileObject } = await import('../../src/cli/commands/config.ts');
    const { join: pathJoin } = await import('node:path');

    // Set up a config with a profile.
    const profileIn = {
      description: 'export-import test',
      quality: 72,
      format: 'webp' as const,
      maxWidth: 1280,
      maxHeight: 720,
      encoder: 'sharp' as const,
      stripMetadata: true,
    };
    const config = await loadConfig();
    if (!config.profiles) config.profiles = {};
    config.profiles.myprofile = profileIn;
    await saveConfig(config);

    // Simulate export: write profile to a temp file.
    const exportPath = pathJoin(tempDir, 'myprofile.json');
    await Bun.write(exportPath, `${JSON.stringify(config.profiles.myprofile, null, 2)}\n`);

    // Simulate import: read file, validate, save under a new name.
    const rawText = await Bun.file(exportPath).text();
    const parsed = JSON.parse(rawText);
    const imported = validateProfileObject(parsed);

    const config2 = await loadConfig();
    if (!config2.profiles) config2.profiles = {};
    config2.profiles['imported-profile'] = imported;
    await saveConfig(config2);

    const reloaded = await loadConfig();
    expect(reloaded.profiles?.['imported-profile']).toEqual(profileIn);
  });

  test('export file contains valid JSON that passes validateProfileObject', async () => {
    const { loadConfig, saveConfig } = await getConfigModule();
    const { validateProfileObject } = await import('../../src/cli/commands/config.ts');
    const { join: pathJoin } = await import('node:path');

    const profile = { quality: 60, format: 'avif' as const };
    const config = await loadConfig();
    if (!config.profiles) config.profiles = {};
    config.profiles.mini = profile;
    await saveConfig(config);

    const exportPath = pathJoin(tempDir, 'mini.json');
    await Bun.write(exportPath, `${JSON.stringify(profile, null, 2)}\n`);

    const text = await Bun.file(exportPath).text();
    // Should parse and validate without throwing
    expect(() => validateProfileObject(JSON.parse(text))).not.toThrow();
  });

  test('importing malformed JSON surfaces a clear error (does not panic)', async () => {
    const { join: pathJoin } = await import('node:path');
    const badPath = pathJoin(tempDir, 'bad.json');
    await Bun.write(badPath, 'not valid json {{{');

    const text = await Bun.file(badPath).text();
    expect(() => JSON.parse(text)).toThrow();
  });

  test('--as rename: imported profile lands under the overridden name', async () => {
    const { loadConfig, saveConfig } = await getConfigModule();
    const { validateProfileObject } = await import('../../src/cli/commands/config.ts');
    const { join: pathJoin } = await import('node:path');

    const profile = { quality: 90, encoder: 'jsquash' as const };
    const exportPath = pathJoin(tempDir, 'original-name.json');
    await Bun.write(exportPath, `${JSON.stringify(profile, null, 2)}\n`);

    // Re-import under a custom name (simulating --as override).
    const asName = 'custom-name';
    const config = await loadConfig();
    if (!config.profiles) config.profiles = {};
    config.profiles[asName] = validateProfileObject(JSON.parse(await Bun.file(exportPath).text()));
    await saveConfig(config);

    const reloaded = await loadConfig();
    expect(reloaded.profiles?.[asName]).toEqual(profile);
    // Original name key should not exist.
    expect(reloaded.profiles?.['original-name']).toBeUndefined();
  });
});
