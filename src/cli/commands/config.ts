/**
 * `localpress config` — read and write localpress configuration.
 *
 * Subcommands:
 *   get <key>                    — print a config value
 *   set <key> <value>            — set a scalar config value
 *   list                         — print the full config (redacts app passwords)
 *   set-profile <name> [options] — create or update a named optimization profile
 *   get-profile <name>           — print a named profile
 *   list-profiles                — list all named profiles
 *   remove-profile <name>        — delete a named profile
 *
 * Supported scalar keys:
 *   active-site          — the default site name
 *   defaults.quality     — default quality for lossy formats (1–100)
 *   defaults.format      — default output format (webp|avif|jpeg|png)
 *   defaults.concurrency — default concurrency for bulk ops
 */

import type { Command } from 'commander';
import type { Config, OptimizationProfile } from '../../types.ts';
import { loadConfig, saveConfig } from '../utils/config.ts';
import { error, info, printJson } from '../utils/output.ts';

export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command('config')
    .description('Read and write localpress configuration');

  // -- config get <key> -------------------------------------------------------
  configCmd
    .command('get <key>')
    .description('Print a config value (e.g. active-site, defaults.quality)')
    .action(async (key: string) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const value = getConfigValue(config, key);

      if (value === undefined) {
        error(`Unknown config key: ${key}`);
        process.exit(2);
      }

      if (parentOpts.json) {
        printJson({ key, value });
      } else {
        info(String(value));
      }
    });

  // -- config set <key> <value> -----------------------------------------------
  configCmd
    .command('set <key> <value>')
    .description('Set a scalar config value')
    .action(async (key: string, value: string) => {
      const parentOpts = program.opts();
      const config = await loadConfig();

      try {
        setConfigValue(config, key, value);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }

      await saveConfig(config);

      if (parentOpts.json) {
        printJson({ key, value: getConfigValue(config, key) });
      } else {
        info(`Set ${key} = ${value}`);
      }
    });

  // -- config list ------------------------------------------------------------
  configCmd
    .command('list')
    .description('Print the full config (app passwords are redacted)')
    .action(async () => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const redacted = redactConfig(config);

      if (parentOpts.json) {
        printJson(redacted);
      } else {
        info(JSON.stringify(redacted, null, 2));
      }
    });

  // -- config set-profile <name> [options] ------------------------------------
  configCmd
    .command('set-profile <name>')
    .description('Create or update a named optimization profile')
    .option('--description <text>', 'human-readable description of this profile')
    .option('--quality <n>', 'target quality for lossy formats (1–100)', (v) =>
      Number.parseInt(v, 10),
    )
    .option('--format <fmt>', 'target output format (webp|avif|jpeg|png)')
    .option('--max-width <px>', 'max width in pixels', (v) => Number.parseInt(v, 10))
    .option('--max-height <px>', 'max height in pixels', (v) => Number.parseInt(v, 10))
    .option('--encoder <enc>', 'encoding backend (sharp|jsquash)')
    .option('--strip-metadata', 'strip all EXIF/ICC metadata')
    .action(async (name: string, options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();

      if (!config.profiles) config.profiles = {};

      const existing = config.profiles[name] ?? {};
      const profile: OptimizationProfile = { ...existing };

      if (options.description !== undefined) profile.description = options.description;
      if (options.quality !== undefined) {
        if (options.quality < 1 || options.quality > 100) {
          error('--quality must be between 1 and 100');
          process.exit(2);
        }
        profile.quality = options.quality;
      }
      if (options.format !== undefined) {
        const validFormats = ['webp', 'avif', 'jpeg', 'png'];
        if (!validFormats.includes(options.format)) {
          error(`--format must be one of: ${validFormats.join(', ')}`);
          process.exit(2);
        }
        profile.format = options.format as OptimizationProfile['format'];
      }
      if (options.maxWidth !== undefined) profile.maxWidth = options.maxWidth;
      if (options.maxHeight !== undefined) profile.maxHeight = options.maxHeight;
      if (options.encoder !== undefined) {
        const validEncoders = ['sharp', 'jsquash'];
        if (!validEncoders.includes(options.encoder)) {
          error(`--encoder must be one of: ${validEncoders.join(', ')}`);
          process.exit(2);
        }
        profile.encoder = options.encoder as OptimizationProfile['encoder'];
      }
      if (options.stripMetadata) profile.stripMetadata = true;

      if (Object.keys(profile).length === 0) {
        error('No profile options provided. Use --quality, --format, --max-width, etc.');
        process.exit(2);
      }

      config.profiles[name] = profile;
      await saveConfig(config);

      if (parentOpts.json) {
        printJson({ name, profile });
      } else {
        const isNew = !existing || Object.keys(existing).length === 0;
        info(`${isNew ? 'Created' : 'Updated'} profile '${name}':`);
        info(JSON.stringify(profile, null, 2));
        info('');
        info(`Use it with: localpress optimize --profile ${name}`);
      }
    });

  // -- config get-profile <name> ----------------------------------------------
  configCmd
    .command('get-profile <name>')
    .description('Print a named optimization profile')
    .action(async (name: string) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const profile = config.profiles?.[name];

      if (!profile) {
        error(
          `Profile '${name}' not found. Run \`localpress config list-profiles\` to see available profiles.`,
        );
        process.exit(2);
      }

      if (parentOpts.json) {
        printJson({ name, profile });
      } else {
        info(`Profile '${name}':`);
        info(JSON.stringify(profile, null, 2));
      }
    });

  // -- config list-profiles ---------------------------------------------------
  configCmd
    .command('list-profiles')
    .description('List all named optimization profiles')
    .action(async () => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const profiles = config.profiles ?? {};
      const names = Object.keys(profiles);

      if (parentOpts.json) {
        printJson({ profiles });
      } else {
        if (names.length === 0) {
          info('No profiles configured. Create one with `localpress config set-profile <name>`.');
          return;
        }
        info(`${names.length} profile(s):\n`);
        for (const name of names) {
          const p = profiles[name];
          const parts: string[] = [];
          if (p.quality !== undefined) parts.push(`quality=${p.quality}`);
          if (p.format) parts.push(`format=${p.format}`);
          if (p.maxWidth) parts.push(`max-width=${p.maxWidth}`);
          if (p.maxHeight) parts.push(`max-height=${p.maxHeight}`);
          if (p.encoder) parts.push(`encoder=${p.encoder}`);
          if (p.stripMetadata) parts.push('strip-metadata');
          info(`  ${name}${p.description ? ` — ${p.description}` : ''}`);
          if (parts.length > 0) info(`    ${parts.join(', ')}`);
        }
      }
    });

  // -- config remove-profile <name> -------------------------------------------
  configCmd
    .command('remove-profile <name>')
    .description('Delete a named optimization profile')
    .action(async (name: string) => {
      const parentOpts = program.opts();
      const config = await loadConfig();

      if (!config.profiles?.[name]) {
        error(`Profile '${name}' not found.`);
        process.exit(2);
      }

      delete config.profiles?.[name];
      await saveConfig(config);

      if (parentOpts.json) {
        printJson({ removed: name });
      } else {
        info(`Removed profile '${name}'.`);
      }
    });
}

// -- Config key helpers -------------------------------------------------------

const SETTABLE_KEYS: Record<
  string,
  {
    get: (c: Config) => unknown;
    set: (c: Config, v: string) => void;
  }
> = {
  'active-site': {
    get: (c) => c.activeSite,
    set: (c, v) => {
      if (!c.sites[v]) {
        throw new Error(
          `Unknown site '${v}'. Known sites: ${Object.keys(c.sites).join(', ') || '(none)'}`,
        );
      }
      c.activeSite = v;
    },
  },
  'defaults.quality': {
    get: (c) => c.defaults?.quality,
    set: (c, v) => {
      const n = Number.parseInt(v, 10);
      if (Number.isNaN(n) || n < 1 || n > 100) throw new Error('quality must be 1–100');
      if (!c.defaults) c.defaults = {};
      c.defaults.quality = n;
    },
  },
  'defaults.format': {
    get: (c) => c.defaults?.format,
    set: (c, v) => {
      const valid = ['webp', 'avif', 'jpeg', 'png'];
      if (!valid.includes(v)) throw new Error(`format must be one of: ${valid.join(', ')}`);
      if (!c.defaults) c.defaults = {};
      c.defaults.format = v as NonNullable<Config['defaults']>['format'];
    },
  },
  'defaults.concurrency': {
    get: (c) => c.defaults?.concurrency,
    set: (c, v) => {
      const n = Number.parseInt(v, 10);
      if (Number.isNaN(n) || n < 1) throw new Error('concurrency must be a positive integer');
      if (!c.defaults) c.defaults = {};
      c.defaults.concurrency = n;
    },
  },
  'defaults.captionModel': {
    get: (c) => c.defaults?.captionModel,
    set: (c, v) => {
      const trimmed = v.trim();
      if (!trimmed) throw new Error('captionModel must be a non-empty Ollama model name');
      if (!c.defaults) c.defaults = {};
      c.defaults.captionModel = trimmed;
    },
  },
  'history.enabled': {
    get: (c) => c.history?.enabled ?? true,
    set: (c, v) => {
      const normalized = v.toLowerCase();
      if (!['true', 'false', '1', '0', 'yes', 'no'].includes(normalized)) {
        throw new Error('history.enabled must be true or false');
      }
      const enabled = normalized === 'true' || normalized === '1' || normalized === 'yes';
      if (!c.history) c.history = {};
      c.history.enabled = enabled;
    },
  },
  'history.maxSizeBytes': {
    get: (c) => c.history?.maxSizeBytes,
    set: (c, v) => {
      const n = Number.parseInt(v, 10);
      if (Number.isNaN(n) || n < 0) {
        throw new Error('history.maxSizeBytes must be a non-negative integer (bytes)');
      }
      if (!c.history) c.history = {};
      c.history.maxSizeBytes = n;
    },
  },
};

function getConfigValue(config: Config, key: string): unknown {
  return SETTABLE_KEYS[key]?.get(config);
}

function setConfigValue(config: Config, key: string, value: string): void {
  const handler = SETTABLE_KEYS[key];
  if (!handler) {
    const valid = Object.keys(SETTABLE_KEYS).join(', ');
    throw new Error(`Unknown config key '${key}'. Settable keys: ${valid}`);
  }
  handler.set(config, value);
}

/** Return a copy of the config with app passwords redacted. */
function redactConfig(config: Config): unknown {
  return {
    ...config,
    sites: Object.fromEntries(
      Object.entries(config.sites).map(([name, site]) => [
        name,
        { ...site, appPassword: '***redacted***' },
      ]),
    ),
  };
}
