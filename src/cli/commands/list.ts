/**
 * `localpress list [filters]` — list media in the active site's library.
 *
 * Filter flags compose. All filters apply to attachments in the WP media
 * library; the local SQLite cache is consulted to resolve `--unoptimized`
 * (which is a localpress concept, not a WP one).
 */

import type { Command } from 'commander';
import { notImplemented } from '../utils/output.ts';

export function registerListCommand(program: Command): void {
  program
    .command('list')
    .description("List media in the active site's library")
    .option('--unoptimized', "only items localpress hasn't processed yet")
    .option('--type <mime>', 'MIME type filter (e.g. image/jpeg)')
    .option('--post <id>', 'attachments associated with a specific post', (v) =>
      Number.parseInt(v, 10),
    )
    .option('--since <date>', 'only items uploaded since this ISO date')
    .option('--larger-than <bytes>', 'minimum size in bytes', (v) => Number.parseInt(v, 10))
    .option('--limit <n>', 'maximum results to return', (v) => Number.parseInt(v, 10))
    .action(async (_options) => {
      notImplemented('list');
    });
}
