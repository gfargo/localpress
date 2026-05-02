/**
 * `localpress sites ...` — manage configured sites.
 *
 * Subcommands:
 *   sites              list all configured sites (default action)
 *   sites add <url>    add a site (non-interactive variant of `init`)
 *   sites use <name>   switch the active site
 *   sites remove <name> remove a site (and its SQLite db)
 */

import { rmSync } from 'node:fs';
import type { Command } from 'commander';
import { getSiteDbPath, loadConfig, saveConfig } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

export function registerSitesCommand(program: Command): void {
  const sites = program
    .command('sites')
    .description('Manage configured WordPress sites')
    .action(async () => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const names = Object.keys(config.sites);

      if (names.length === 0) {
        info('No sites configured. Run `localpress init` to add one.');
        return;
      }

      if (parentOpts.json) {
        printJson(
          names.map((name) => ({
            name,
            url: config.sites[name].url,
            active: name === config.activeSite,
          })),
        );
      } else {
        for (const name of names) {
          const site = config.sites[name];
          const marker = name === config.activeSite ? ' (active)' : '';
          info(`  ${name}${marker}  ${site.url}`);
        }
      }
    });

  sites
    .command('add <url>')
    .description('Add a new site')
    .option('--name <name>', 'site name (defaults to hostname)')
    .option('--username <user>', 'WordPress username')
    .option('--app-password <password>', 'WordPress Application Password (will prompt if omitted)')
    .action(async (url: string, options) => {
      const config = await loadConfig();

      // Normalize URL.
      let normalizedUrl = url;
      if (!normalizedUrl.startsWith('http')) {
        normalizedUrl = `https://${normalizedUrl}`;
      }
      normalizedUrl = normalizedUrl.replace(/\/+$/, '');

      const siteName = options.name ?? new URL(normalizedUrl).hostname;

      if (!options.username || !options.appPassword) {
        error(
          'Non-interactive mode requires --username and --app-password.\n' +
            'Use `localpress init` for the interactive wizard.',
        );
        process.exit(2);
      }

      if (config.sites[siteName]) {
        error(`Site '${siteName}' already exists. Remove it first or choose a different --name.`);
        process.exit(3);
      }

      config.sites[siteName] = {
        name: siteName,
        url: normalizedUrl,
        username: options.username,
        appPassword: options.appPassword,
        createdAt: new Date().toISOString(),
      };

      // Set as active if it's the first site.
      if (!config.activeSite) {
        config.activeSite = siteName;
      }

      await saveConfig(config);
      info(`Added site '${siteName}' (${normalizedUrl}).`);
      if (config.activeSite === siteName) {
        info('Set as active site.');
      }
    });

  sites
    .command('use <name>')
    .description('Switch the active site')
    .action(async (name: string) => {
      const config = await loadConfig();

      if (!config.sites[name]) {
        const known = Object.keys(config.sites);
        error(
          `Unknown site '${name}'.` +
            (known.length ? ` Known sites: ${known.join(', ')}` : ' No sites configured.'),
        );
        process.exit(3);
      }

      config.activeSite = name;
      await saveConfig(config);
      info(`Active site switched to '${name}'.`);
    });

  sites
    .command('remove <name>')
    .description('Remove a site (and its local SQLite database)')
    .option('--keep-db', 'preserve the SQLite database file')
    .action(async (name: string, options) => {
      const config = await loadConfig();

      if (!config.sites[name]) {
        error(`Unknown site '${name}'.`);
        process.exit(3);
      }

      delete config.sites[name];

      // Clear activeSite if it was the removed site.
      if (config.activeSite === name) {
        const remaining = Object.keys(config.sites);
        config.activeSite = remaining[0]; // undefined if no sites left
      }

      await saveConfig(config);
      info(`Removed site '${name}'.`);

      if (!options.keepDb) {
        const dbPath = getSiteDbPath(name);
        try {
          rmSync(dbPath, { force: true });
          // Also remove WAL/SHM files if present.
          rmSync(`${dbPath}-wal`, { force: true });
          rmSync(`${dbPath}-shm`, { force: true });
        } catch {
          warn(`Could not delete database at ${dbPath}. You may want to remove it manually.`);
        }
      }
    });
}
