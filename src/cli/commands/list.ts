/**
 * `localpress list [filters]` — list media in the active site's library.
 *
 * Filter flags compose. All filters apply to attachments in the WP media
 * library; the local SQLite cache is consulted to resolve `--unoptimized`
 * (which is a localpress concept, not a WP one).
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { ListFilters, MediaItem } from '../../adapters/types.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { loadConfig, getSiteDbPath, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson } from '../utils/output.ts';

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
    .action(async (options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const adapter = resolver.resolve('list');

      const filters: ListFilters = {
        type: options.type,
        postId: options.post,
        since: options.since,
        largerThan: options.largerThan,
        perPage: options.limit ?? 50,
        page: 1,
      };

      let items: MediaItem[];
      try {
        items = await adapter.listMedia(filters);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(4);
        return;
      }

      // Client-side filter: --larger-than (WP REST doesn't support this natively).
      if (options.largerThan) {
        items = items.filter((item) => (item.sizeBytes ?? 0) >= options.largerThan);
      }

      // Client-side filter: --unoptimized (cross-reference with SQLite).
      if (options.unoptimized) {
        try {
          const db = SiteDb.init(getSiteDbPath(site.name));
          const processed = db.listProcessedWpIds(site.name);
          items = items.filter((item) => !processed.has(item.id));
          db.close();
        } catch {
          // If the DB doesn't exist yet, all items are unoptimized.
        }
      }

      if (parentOpts.json) {
        printJson(items);
      } else {
        if (items.length === 0) {
          info('No media items found matching the given filters.');
          return;
        }

        info(`Found ${items.length} item(s):\n`);
        for (const item of items) {
          const size = item.sizeBytes ? formatBytes(item.sizeBytes) : '?';
          const dims =
            item.width && item.height ? `${item.width}×${item.height}` : '';
          info(`  #${item.id}  ${item.filename}  ${item.mimeType}  ${size}  ${dims}`);
        }
      }
    });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
