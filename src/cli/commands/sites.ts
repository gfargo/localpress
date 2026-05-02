/**
 * `localpress sites ...` — manage configured sites.
 *
 * Subcommands:
 *   sites              list all configured sites (default action)
 *   sites add <url>    add a site (non-interactive variant of `init`)
 *   sites use <name>   switch the active site
 *   sites remove <name> remove a site (and its SQLite db)
 */

import type { Command } from 'commander';
import { notImplemented } from '../utils/output.ts';

export function registerSitesCommand(program: Command): void {
  const sites = program
    .command('sites')
    .description('Manage configured WordPress sites')
    .action(async () => {
      // Default action: list sites
      notImplemented('sites (list)');
    });

  sites
    .command('add <url>')
    .description('Add a new site')
    .option('--name <name>', 'site name (defaults to hostname)')
    .option('--username <user>', 'WordPress username')
    .option('--app-password <password>', 'WordPress Application Password (will prompt if omitted)')
    .action(async (_url, _options) => {
      notImplemented('sites add');
    });

  sites
    .command('use <name>')
    .description('Switch the active site')
    .action(async (_name) => {
      notImplemented('sites use');
    });

  sites
    .command('remove <name>')
    .description('Remove a site (and its local SQLite database)')
    .option('--keep-db', 'preserve the SQLite database file')
    .action(async (_name, _options) => {
      notImplemented('sites remove');
    });
}
