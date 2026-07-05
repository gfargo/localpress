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
import { ExitCode } from '../../types.ts';
import { invokeCli } from '../mcp/invoke.ts';
import { getSiteDbPath, isValidSiteName, loadConfig, saveConfig } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

/**
 * Tokenize a command string into an argv array, respecting single and double
 * quoted segments. Escaped quotes within the same quote style are not supported.
 */
export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuote: '"' | "'" | null = null;
  // Track whether the current token contained a quote, so an explicitly empty
  // quoted argument (e.g. `--alt-text ""`) is preserved as an empty token
  // instead of being dropped — which would make the next flag be consumed as
  // its value.
  let sawQuote = false;

  const flush = () => {
    if (current.length || sawQuote) {
      tokens.push(current);
      current = '';
      sawQuote = false;
    }
  };

  for (const ch of input) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      sawQuote = true;
    } else if (ch === ' ') {
      flush();
    } else {
      current += ch;
    }
  }
  flush();
  return tokens;
}

/** Returns 0 if all results are ok, 1 otherwise. */
export function aggregateExitCode(results: { ok: boolean }[]): 0 | 1 {
  return results.every((r) => r.ok) ? 0 : 1;
}

/** Validate and resolve the target site names from command options. */
export function resolveSiteNames(
  options: { allSites?: boolean; sites?: string },
  configSiteKeys: string[],
): { names: string[] } | { error: string; exitCode: number } {
  if (options.allSites && options.sites) {
    return {
      error: 'Use either --all-sites or --sites, not both.',
      exitCode: ExitCode.InvalidUsage,
    };
  }
  if (!options.allSites && !options.sites) {
    return { error: 'Specify --all-sites or --sites <list>.', exitCode: ExitCode.InvalidUsage };
  }
  if (options.allSites) {
    if (configSiteKeys.length === 0) {
      return {
        error: 'No sites configured. Run `localpress init` to add one.',
        exitCode: ExitCode.ConfigError,
      };
    }
    return { names: configSiteKeys };
  }
  const requested = (options.sites as string)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = requested.filter((n) => !configSiteKeys.includes(n));
  if (unknown.length) {
    return {
      error: `Unknown site(s): ${unknown.join(', ')}. Known sites: ${configSiteKeys.join(', ')}`,
      exitCode: ExitCode.ConfigError,
    };
  }
  if (requested.length === 0) {
    return { error: '--sites list is empty.', exitCode: ExitCode.InvalidUsage };
  }
  return { names: requested };
}

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

      if (!isValidSiteName(siteName)) {
        error(
          `Invalid site name '${siteName}'. Use only letters, numbers, '.', '_' and '-' (pass --name to override the hostname-derived default).`,
        );
        process.exit(2);
      }

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
          `Unknown site '${name}'.${known.length ? ` Known sites: ${known.join(', ')}` : ' No sites configured.'}`,
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

  sites
    .command('run <command>')
    .description('Run a localpress command across multiple sites')
    .option('--all-sites', 'run against every configured site')
    .option('--sites <list>', 'comma-separated list of site names')
    .option(
      '--timeout <seconds>',
      'per-site timeout in seconds (0 = no limit; default 3600)',
      (v) => Number.parseInt(v, 10),
    )
    .action(async (commandStr: string, options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();

      const resolution = resolveSiteNames(options, Object.keys(config.sites));
      if ('error' in resolution) {
        error(resolution.error);
        process.exit(resolution.exitCode);
      }
      const { names } = resolution;

      const args = tokenizeCommand(commandStr);
      if (args.length === 0) {
        error('Command string is empty.');
        process.exit(ExitCode.InvalidUsage);
      }
      if (args[0] === 'sites') {
        error('Cannot nest `sites run` inside itself.');
        process.exit(ExitCode.InvalidUsage);
      }

      // Forward the run-mode the user set on the parent so per-site children
      // don't silently fall back to dry-run (which would report success while
      // writing nothing). These are top-level global flags.
      const passthroughFlags: string[] = [];
      if (parentOpts.apply) passthroughFlags.push('--apply');
      if (parentOpts.dryRun) passthroughFlags.push('--dry-run');
      if (parentOpts.strict) passthroughFlags.push('--strict');
      if (parentOpts.yes) passthroughFlags.push('--yes');

      // Bulk cross-site runs routinely exceed the 5-minute MCP default; use a
      // generous default (1h) and let --timeout override (0 disables).
      const timeoutMs =
        typeof options.timeout === 'number' ? options.timeout * 1000 : 60 * 60 * 1000;

      const results: {
        site: string;
        exitCode: number;
        ok: boolean;
        stdout: unknown;
        stderr: string;
      }[] = [];

      for (const site of names) {
        if (!parentOpts.json) info(`\n── ${site} ──`);
        const result = await invokeCli({
          site,
          concurrency: parentOpts.concurrency,
          args,
          passthroughFlags,
          timeoutMs,
        });
        results.push({
          site,
          exitCode: result.exitCode,
          ok: result.ok,
          stdout: result.stdout,
          stderr: result.stderr,
        });
        if (!parentOpts.json) {
          if (result.stdout) {
            info(
              typeof result.stdout === 'string'
                ? result.stdout
                : JSON.stringify(result.stdout, null, 2),
            );
          }
          if (!result.ok && result.stderr) warn(result.stderr);
        }
      }

      const failed = results.filter((r) => !r.ok);
      if (parentOpts.json) {
        printJson({
          command: args.join(' '),
          total: results.length,
          succeeded: results.length - failed.length,
          failed: failed.length,
          results,
        });
      } else {
        const ok = results.length - failed.length;
        const summary = `\n${ok}/${results.length} sites succeeded${failed.length ? `, ${failed.length} failed: ${failed.map((r) => r.site).join(', ')}` : ''}`;
        if (failed.length) warn(summary);
        else info(summary);
      }

      process.exit(aggregateExitCode(results));
    });
}
