/**
 * `localpress config` — read and write localpress configuration.
 *
 * Subcommands:
 *   get <key>                      — print a config value
 *   set <key> <value>              — set a scalar config value
 *   list                           — print the full config (redacts app passwords)
 *   set-profile <name> [options]   — create or update a named optimization profile
 *   get-profile <name>             — print a named profile
 *   list-profiles                  — list all named profiles
 *   remove-profile <name>          — delete a named profile
 *   export-profile <name> --to <f> — serialize a named profile to a JSON file
 *   import-profile <file> [--as n] — read a profile JSON file into config
 *
 * Supported scalar keys:
 *   active-site          — the default site name
 *   defaults.quality     — default quality for lossy formats (1–100)
 *   defaults.format      — default output format (webp|avif|jpeg|png)
 *   defaults.concurrency — default concurrency for bulk ops
 */

import { basename, extname } from 'node:path';
import type { Command } from 'commander';
import type { Config, OptimizationProfile } from '../../types.ts';
import { parseIntOption, parsePositiveIntOption } from '../utils/args.ts';
import { loadConfig, saveConfig } from '../utils/config.ts';
import { error, info, printJson } from '../utils/output.ts';

/**
 * Validate and parse an unknown value as an OptimizationProfile.
 *
 * Rejects:
 *  - non-objects and null
 *  - any key not in the 7-field allow-list
 *  - invalid field types or out-of-range values
 *  - an empty object (no fields at all)
 *
 * Returns a clean typed OptimizationProfile on success; throws with a
 * descriptive message on failure.
 */
export function validateProfileObject(input: unknown): OptimizationProfile {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Profile must be a JSON object');
  }

  const ALLOWED_KEYS = new Set([
    'description',
    'quality',
    'format',
    'maxWidth',
    'maxHeight',
    'encoder',
    'stripMetadata',
  ]);

  const raw = input as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(
        `Unknown field '${key}' in profile. Allowed fields: ${[...ALLOWED_KEYS].join(', ')}`,
      );
    }
  }

  if (Object.keys(raw).length === 0) {
    throw new Error('Profile object is empty. Provide at least one field.');
  }

  const profile: OptimizationProfile = {};

  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string') {
      throw new Error("Field 'description' must be a string");
    }
    profile.description = raw.description;
  }

  if (raw.quality !== undefined) {
    if (typeof raw.quality !== 'number' || !Number.isInteger(raw.quality)) {
      throw new Error("Field 'quality' must be an integer");
    }
    if (raw.quality < 1 || raw.quality > 100) {
      throw new Error("Field 'quality' must be between 1 and 100");
    }
    profile.quality = raw.quality;
  }

  if (raw.format !== undefined) {
    const validFormats = ['webp', 'avif', 'jpeg', 'png'];
    if (typeof raw.format !== 'string' || !validFormats.includes(raw.format)) {
      throw new Error(`Field 'format' must be one of: ${validFormats.join(', ')}`);
    }
    profile.format = raw.format as OptimizationProfile['format'];
  }

  if (raw.maxWidth !== undefined) {
    if (typeof raw.maxWidth !== 'number' || !Number.isInteger(raw.maxWidth) || raw.maxWidth < 1) {
      throw new Error("Field 'maxWidth' must be a positive integer");
    }
    profile.maxWidth = raw.maxWidth;
  }

  if (raw.maxHeight !== undefined) {
    if (
      typeof raw.maxHeight !== 'number' ||
      !Number.isInteger(raw.maxHeight) ||
      raw.maxHeight < 1
    ) {
      throw new Error("Field 'maxHeight' must be a positive integer");
    }
    profile.maxHeight = raw.maxHeight;
  }

  if (raw.encoder !== undefined) {
    const validEncoders = ['sharp', 'jsquash'];
    if (typeof raw.encoder !== 'string' || !validEncoders.includes(raw.encoder)) {
      throw new Error(`Field 'encoder' must be one of: ${validEncoders.join(', ')}`);
    }
    profile.encoder = raw.encoder as OptimizationProfile['encoder'];
  }

  if (raw.stripMetadata !== undefined) {
    if (typeof raw.stripMetadata !== 'boolean') {
      throw new Error("Field 'stripMetadata' must be a boolean");
    }
    profile.stripMetadata = raw.stripMetadata;
  }

  return profile;
}

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
    .option(
      '--quality <n>',
      'target quality for lossy formats (1–100)',
      parseIntOption('--quality'),
    )
    .option('--format <fmt>', 'target output format (webp|avif|jpeg|png)')
    .option('--max-width <px>', 'max width in pixels', parsePositiveIntOption('--max-width'))
    .option('--max-height <px>', 'max height in pixels', parsePositiveIntOption('--max-height'))
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

  // -- config export-profile <name> --to <file> --------------------------------
  configCmd
    .command('export-profile <name>')
    .description('Serialize a named optimization profile to a JSON file')
    .requiredOption('--to <file>', 'destination file path')
    .action(async (name: string, options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const profile = config.profiles?.[name];

      if (!profile) {
        error(
          `Profile '${name}' not found. Run \`localpress config list-profiles\` to see available profiles.`,
        );
        process.exit(2);
      }

      try {
        await Bun.write(options.to, `${JSON.stringify(profile, null, 2)}\n`);
      } catch (err) {
        error(
          `Failed to write profile file '${options.to}': ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(2);
      }

      if (parentOpts.json) {
        printJson({ name, file: options.to, profile });
      } else {
        info(`Exported profile '${name}' to ${options.to}`);
      }
    });

  // -- config import-profile <file> [--as <name>] ------------------------------
  configCmd
    .command('import-profile <file>')
    .description('Read a profile JSON file and save it into config')
    .option('--as <name>', 'store the profile under this name (default: file basename)')
    .action(async (file: string, options) => {
      const parentOpts = program.opts();

      // Read file
      let raw: string;
      try {
        raw = await Bun.file(file).text();
      } catch (err) {
        error(
          `Failed to read profile file '${file}': ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(2);
      }

      // Parse JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        error(
          `Malformed JSON in profile file '${file}'. The file must contain a valid JSON object.`,
        );
        process.exit(2);
      }

      // Validate
      let profile: OptimizationProfile;
      try {
        profile = validateProfileObject(parsed);
      } catch (err) {
        error(`Invalid profile in '${file}': ${err instanceof Error ? err.message : String(err)}`);
        process.exit(2);
      }

      // Resolve target name: --as > file basename without extension
      const targetName: string = options.as ?? basename(file, extname(file));

      const config = await loadConfig();
      if (!config.profiles) config.profiles = {};
      const isNew = !config.profiles[targetName];
      config.profiles[targetName] = profile;
      await saveConfig(config);

      if (parentOpts.json) {
        printJson({ name: targetName, file, profile });
      } else {
        info(`${isNew ? 'Imported' : 'Updated'} profile '${targetName}' from ${file}`);
        info(JSON.stringify(profile, null, 2));
        info('');
        info(`Use it with: localpress optimize --profile ${targetName}`);
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
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('quality must be 1–100');
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
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error('concurrency must be a positive integer');
      }
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
  'defaults.captionFallbackModel': {
    get: (c) => c.defaults?.captionFallbackModel,
    set: (c, v) => {
      const trimmed = v.trim();
      if (!trimmed) throw new Error('captionFallbackModel must be a non-empty Ollama model name');
      if (!c.defaults) c.defaults = {};
      c.defaults.captionFallbackModel = trimmed;
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
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) {
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
