/**
 * Unit tests for optimization profile resolution.
 *
 * Tests that --profile loads the correct values from config,
 * and that explicit CLI flags override profile values.
 */

import { describe, expect, test } from 'bun:test';

import type { Config } from '../../src/types.ts';

/**
 * Simulates the profile resolution logic from optimize.ts.
 * Extracted here for unit testing without needing a real WP connection.
 */
function resolveProfileOptions(
  config: Config,
  profileName: string | undefined,
  cliOptions: {
    quality?: number;
    to?: string;
    encoder?: string;
  },
): {
  quality?: number;
  toFormat?: string;
  maxWidth?: number;
  maxHeight?: number;
  encoder: 'sharp' | 'jsquash';
  stripMetadata: boolean;
} {
  let profileQuality: number | undefined;
  let profileFormat: string | undefined;
  let profileMaxWidth: number | undefined;
  let profileMaxHeight: number | undefined;
  let profileEncoder: 'sharp' | 'jsquash' | undefined;
  let profileStripMetadata: boolean | undefined;

  if (profileName) {
    const profile = config.profiles?.[profileName];
    if (!profile) {
      throw new Error(
        `Profile '${profileName}' not found. Available profiles: ${Object.keys(config.profiles ?? {}).join(', ') || '(none)'}.`,
      );
    }
    profileQuality = profile.quality;
    profileFormat = profile.format;
    profileMaxWidth = profile.maxWidth;
    profileMaxHeight = profile.maxHeight;
    profileEncoder = profile.encoder;
    profileStripMetadata = profile.stripMetadata;
  }

  return {
    quality: cliOptions.quality ?? profileQuality,
    toFormat: (cliOptions.to as string | undefined) ?? profileFormat,
    maxWidth: profileMaxWidth,
    maxHeight: profileMaxHeight,
    stripMetadata: profileStripMetadata ?? true,
    encoder: cliOptions.encoder === 'jsquash' ? 'jsquash' : (profileEncoder ?? 'sharp'),
  };
}

const configWithProfiles: Config = {
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
  profiles: {
    hero: {
      quality: 75,
      format: 'webp',
      maxWidth: 1920,
      description: 'Hero images — high quality WebP at 1920px max',
    },
    thumbnail: {
      quality: 85,
      format: 'jpeg',
      maxWidth: 400,
      maxHeight: 400,
      stripMetadata: true,
      encoder: 'sharp',
    },
    lossless: {
      format: 'png',
      encoder: 'jsquash',
      stripMetadata: false,
    },
  },
};

const configNoProfiles: Config = {
  version: 1,
  sites: {},
};

describe('profile resolution', () => {
  test('no profile — uses CLI options directly', () => {
    const result = resolveProfileOptions(configWithProfiles, undefined, {
      quality: 80,
      to: 'avif',
    });
    expect(result.quality).toBe(80);
    expect(result.toFormat).toBe('avif');
    expect(result.encoder).toBe('sharp');
    expect(result.stripMetadata).toBe(true);
    expect(result.maxWidth).toBeUndefined();
  });

  test('profile provides defaults when no CLI flags given', () => {
    const result = resolveProfileOptions(configWithProfiles, 'hero', {});
    expect(result.quality).toBe(75);
    expect(result.toFormat).toBe('webp');
    expect(result.maxWidth).toBe(1920);
    expect(result.maxHeight).toBeUndefined();
    expect(result.encoder).toBe('sharp');
    expect(result.stripMetadata).toBe(true);
  });

  test('explicit CLI flags override profile values', () => {
    const result = resolveProfileOptions(configWithProfiles, 'hero', {
      quality: 90,
      to: 'avif',
    });
    expect(result.quality).toBe(90);
    expect(result.toFormat).toBe('avif');
    // maxWidth still comes from profile since there's no CLI override for it
    expect(result.maxWidth).toBe(1920);
  });

  test('thumbnail profile applies all fields', () => {
    const result = resolveProfileOptions(configWithProfiles, 'thumbnail', {});
    expect(result.quality).toBe(85);
    expect(result.toFormat).toBe('jpeg');
    expect(result.maxWidth).toBe(400);
    expect(result.maxHeight).toBe(400);
    expect(result.stripMetadata).toBe(true);
    expect(result.encoder).toBe('sharp');
  });

  test('lossless profile uses jsquash encoder', () => {
    const result = resolveProfileOptions(configWithProfiles, 'lossless', {});
    expect(result.toFormat).toBe('png');
    expect(result.encoder).toBe('jsquash');
    expect(result.stripMetadata).toBe(false);
  });

  test('CLI encoder=jsquash overrides profile encoder', () => {
    const result = resolveProfileOptions(configWithProfiles, 'thumbnail', {
      encoder: 'jsquash',
    });
    expect(result.encoder).toBe('jsquash');
  });

  test('throws when profile does not exist', () => {
    expect(() => resolveProfileOptions(configWithProfiles, 'nonexistent', {})).toThrow(
      "Profile 'nonexistent' not found",
    );
  });

  test('throws when no profiles are configured', () => {
    expect(() => resolveProfileOptions(configNoProfiles, 'hero', {})).toThrow(
      "Profile 'hero' not found",
    );
  });

  test('error message lists available profiles', () => {
    try {
      resolveProfileOptions(configWithProfiles, 'missing', {});
    } catch (err) {
      expect((err as Error).message).toContain('hero');
      expect((err as Error).message).toContain('thumbnail');
      expect((err as Error).message).toContain('lossless');
    }
  });

  test('partial profile — only quality set', () => {
    const config: Config = {
      version: 1,
      sites: {},
      profiles: {
        minimal: { quality: 60 },
      },
    };
    const result = resolveProfileOptions(config, 'minimal', {});
    expect(result.quality).toBe(60);
    expect(result.toFormat).toBeUndefined();
    expect(result.maxWidth).toBeUndefined();
    expect(result.encoder).toBe('sharp');
  });
});

describe('optimize command --profile registration', () => {
  test('optimize command accepts --profile flag', async () => {
    const { Command } = await import('commander');
    const { registerOptimizeCommand } = await import('../../src/cli/commands/optimize.ts');

    const program = new Command();
    program.exitOverride();
    registerOptimizeCommand(program);

    const optimizeCmd = program.commands.find((c) => c.name() === 'optimize');
    expect(optimizeCmd).toBeDefined();

    const profileOption = optimizeCmd?.options.find((o) => o.long === '--profile');
    expect(profileOption).toBeDefined();
    expect(profileOption?.optional).toBe(false); // <name> means value is mandatory when flag is used
  });
});

describe('export command registration', () => {
  test('export command is registered with expected options', async () => {
    const { Command } = await import('commander');
    const { registerExportCommand } = await import('../../src/cli/commands/export.ts');

    const program = new Command();
    program.exitOverride();
    registerExportCommand(program);

    const cmd = program.commands.find((c) => c.name() === 'export');
    expect(cmd).toBeDefined();

    const optionNames = cmd?.options.map((o) => o.long) ?? [];
    expect(optionNames).toContain('--to');
    expect(optionNames).toContain('--all');
    expect(optionNames).toContain('--unoptimized');
    expect(optionNames).toContain('--type');
    expect(optionNames).toContain('--since');
    expect(optionNames).toContain('--larger-than');
    expect(optionNames).toContain('--include-sizes');
    expect(optionNames).toContain('--flat');
  });
});

describe('import command registration', () => {
  test('import command is registered with expected options', async () => {
    const { Command } = await import('commander');
    const { registerImportCommand } = await import('../../src/cli/commands/import.ts');

    const program = new Command();
    program.exitOverride();
    registerImportCommand(program);

    const cmd = program.commands.find((c) => c.name() === 'import');
    expect(cmd).toBeDefined();

    const optionNames = cmd?.options.map((o) => o.long) ?? [];
    expect(optionNames).toContain('--optimize');
    expect(optionNames).toContain('--quality');
    expect(optionNames).toContain('--to');
    expect(optionNames).toContain('--max-width');
    expect(optionNames).toContain('--max-height');
    expect(optionNames).toContain('--title');
    expect(optionNames).toContain('--alt');
    expect(optionNames).toContain('--post');
    expect(optionNames).toContain('--preserve-metadata');
    expect(optionNames).toContain('--preserve-ids');
    expect(optionNames).toContain('--strip-metadata');
  });
});
