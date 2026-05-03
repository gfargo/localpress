/**
 * `localpress list [filters]` — list media in the active site's library.
 *
 * Filter flags compose. All filters apply to attachments in the WP media
 * library; the local SQLite cache is consulted to resolve `--unoptimized`
 * (which is a localpress concept, not a WP one).
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { ListFilters, MediaItem, SortField, SortOrder } from '../../adapters/types.ts';
import { SiteDb } from '../../engine/state/db.ts';
import type { MediaBrowserAction } from '../components/MediaBrowser.tsx';
import { getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
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
    .option('--limit <n>', 'items per page (max 100)', (v) => Number.parseInt(v, 10))
    .option('--page <n>', 'page number (default 1)', (v) => Number.parseInt(v, 10))
    .option('--sort <field>', 'sort by: date (default), name, size, id')
    .option('--order <dir>', 'sort direction: desc (default) or asc')
    .option('-i, --interactive', 'browse with keyboard navigation')
    .action(async (options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const adapter = resolver.resolve('list');

      const VALID_SORT_FIELDS: SortField[] = ['date', 'name', 'size', 'id'];
      const VALID_SORT_ORDERS: SortOrder[] = ['asc', 'desc'];

      const filters: ListFilters = {
        type: options.type,
        postId: options.post,
        since: options.since,
        largerThan: options.largerThan,
        perPage: Math.min(options.limit ?? 50, 100),
        page: options.page ?? 1,
        sortBy: VALID_SORT_FIELDS.includes(options.sort) ? (options.sort as SortField) : undefined,
        sortOrder: VALID_SORT_ORDERS.includes(options.order)
          ? (options.order as SortOrder)
          : undefined,
      };

      // Interactive TUI mode.
      if (options.interactive) {
        const { render } = await import('ink');
        const React = await import('react');
        const { MediaBrowser } = await import('../components/MediaBrowser.tsx');
        const { spawnSync } = await import('node:child_process');

        // argv[1] is a .ts script in dev mode; the compiled binary repeats argv[0].
        const isDevMode = /\.(ts|mts|js|mjs)$/.test(process.argv[1] ?? '');
        const selfArgs = (cmd: string, id: string) =>
          isDevMode ? [process.argv[1], cmd, id] : [cmd, id];

        // Reload processedIds from SQLite (called on first launch and after optimize).
        const loadProcessedIds = () => {
          if (!options.unoptimized) return new Set<number>();
          try {
            const db = SiteDb.init(getSiteDbPath(site.name));
            const ids = db.listProcessedWpIds(site.name);
            db.close();
            return ids;
          } catch {
            return new Set<number>();
          }
        };

        let processedIds = loadProcessedIds();
        let interactivePage = filters.page ?? 1;
        let interactiveCursor = 0;

        // Loop: re-enter the TUI after each subcommand until the user quits.
        while (true) {
          let result: { items: MediaItem[]; total: number; totalPages: number };
          try {
            result = await adapter.listMediaPage({ ...filters, page: interactivePage });
          } catch (err) {
            error(err instanceof Error ? err.message : String(err));
            process.exit(4);
            return;
          }

          if (result.items.length === 0 && interactivePage === 1) {
            info('No media items found.');
            return;
          }

          if (options.unoptimized) {
            result.items = result.items.filter((item) => !processedIds.has(item.id));
          }

          const pending: { action: MediaBrowserAction | null } = { action: null };

          const { waitUntilExit } = render(
            React.default.createElement(MediaBrowser, {
              initialItems: result.items,
              total: result.total,
              totalPages: result.totalPages,
              currentPage: interactivePage,
              initialCursor: interactiveCursor,
              processedIds,
              sortBy: filters.sortBy,
              sortOrder: filters.sortOrder,
              onAction: (action) => {
                pending.action = action;
              },
              onPageChange: async (page: number) => {
                const r = await adapter.listMediaPage({ ...filters, page });
                if (options.unoptimized) {
                  r.items = r.items.filter((item) => !processedIds.has(item.id));
                }
                return r;
              },
            }),
          );

          await waitUntilExit();

          const pendingAction = pending.action;
          if (!pendingAction || pendingAction.type === 'quit') break;

          // Clear the TUI before running the subcommand.
          process.stdout.write('\x1b[2J\x1b[H');

          const subCmd =
            pendingAction.type === 'optimize'
              ? 'optimize'
              : pendingAction.type === 'edit'
                ? 'edit'
                : 'show';

          spawnSync(process.argv[0], selfArgs(subCmd, String(pendingAction.id)), {
            stdio: 'inherit',
          });

          // Let the user read the output before the TUI repaints.
          process.stdout.write('\n\x1b[2m── Press any key to return to the browser ──\x1b[0m');
          await new Promise<void>((resolve) => {
            if (process.stdin.isTTY) {
              process.stdin.setRawMode(true);
              process.stdin.resume();
              process.stdin.once('data', () => {
                process.stdin.setRawMode(false);
                process.stdin.pause();
                resolve();
              });
            } else {
              resolve();
            }
          });

          // Restore position and refresh processedIds before re-entering the TUI.
          interactivePage = pendingAction.page;
          interactiveCursor = pendingAction.cursor;
          if (pendingAction.type === 'optimize') processedIds = loadProcessedIds();

          process.stdout.write('\x1b[2J\x1b[H');
        }

        return;
      }

      // Plain / JSON mode.
      let items: MediaItem[];
      let total = 0;
      let totalPages = 1;

      try {
        const result = await adapter.listMediaPage(filters);
        items = result.items;
        total = result.total;
        totalPages = result.totalPages;
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(4);
        return;
      }

      // Client-side filters.
      if (options.largerThan) {
        items = items.filter((item) => (item.sizeBytes ?? 0) >= options.largerThan);
      }

      if (options.unoptimized) {
        try {
          const db = SiteDb.init(getSiteDbPath(site.name));
          const processed = db.listProcessedWpIds(site.name);
          items = items.filter((item) => !processed.has(item.id));
          db.close();
        } catch {
          /* If the DB doesn't exist yet, all items are unoptimized. */
        }
      }

      if (parentOpts.json) {
        printJson({ items, total, totalPages, page: filters.page ?? 1 });
        return;
      }

      if (items.length === 0) {
        info('No media items found matching the given filters.');
        return;
      }

      const pageNum = filters.page ?? 1;
      const perPage = filters.perPage ?? 50;
      const from = (pageNum - 1) * perPage + 1;
      const to = Math.min(from + items.length - 1, total);
      const pageInfo = totalPages > 1 ? `  (page ${pageNum}/${totalPages})` : '';
      const sortInfo =
        filters.sortBy && filters.sortBy !== 'date'
          ? `  sorted by ${filters.sortBy} ${filters.sortOrder ?? 'desc'}`
          : '';
      info(`Showing ${from}–${to} of ${total} item(s)${pageInfo}${sortInfo}:\n`);

      for (const item of items) {
        const size = item.sizeBytes ? formatBytes(item.sizeBytes) : '?';
        const dims = item.width && item.height ? `${item.width}×${item.height}` : '';
        info(`  #${item.id}  ${item.filename}  ${item.mimeType}  ${size}  ${dims}`);
      }

      if (pageNum < totalPages) {
        const sortFlags = filters.sortBy
          ? ` --sort ${filters.sortBy}${filters.sortOrder ? ` --order ${filters.sortOrder}` : ''}`
          : '';
        info(`\nNext page: localpress list --page ${pageNum + 1}${sortFlags}`);
      }
    });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
