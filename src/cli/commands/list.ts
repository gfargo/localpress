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
    .option('--limit <n>', 'items per page (max 100)', (v) => Number.parseInt(v, 10))
    .option('--page <n>', 'page number (default 1)', (v) => Number.parseInt(v, 10))
    .option('-i, --interactive', 'browse with keyboard navigation')
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
        perPage: Math.min(options.limit ?? 50, 100),
        page: options.page ?? 1,
      };

      // Interactive TUI mode.
      if (options.interactive) {
        const { render } = await import('ink');
        const React = await import('react');
        const { MediaBrowser } = await import('../components/MediaBrowser.tsx');

        let result: { items: MediaItem[]; total: number; totalPages: number };
        try {
          result = await adapter.listMediaPage(filters);
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
          process.exit(4);
          return;
        }

        if (result.items.length === 0) {
          info('No media items found.');
          return;
        }

        // Client-side unoptimized filter.
        let processedIds = new Set<number>();
        if (options.unoptimized) {
          try {
            const db = SiteDb.init(getSiteDbPath(site.name));
            processedIds = db.listProcessedWpIds(site.name);
            db.close();
          } catch { /* DB doesn't exist yet — all items unoptimized */ }
          result.items = result.items.filter((item) => !processedIds.has(item.id));
        }

        let pendingAction: { type: string; id?: number; item?: MediaItem } | null = null;

        const { waitUntilExit } = render(
          React.default.createElement(MediaBrowser, {
            initialItems: result.items,
            total: result.total,
            totalPages: result.totalPages,
            currentPage: filters.page ?? 1,
            processedIds,
            onAction: (action) => { pendingAction = action; },
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

        // Handle action taken inside the TUI.
        if (pendingAction) {
          const action = pendingAction as { type: string; id?: number; item?: MediaItem };
          if (action.type === 'preview' && action.item) {
            await showImagePreview(action.item);
          } else if (action.type === 'optimize' && action.id !== undefined) {
            info(`\nRun: localpress optimize ${action.id}`);
          } else if (action.type === 'edit' && action.id !== undefined) {
            info(`\nRun: localpress edit ${action.id}`);
          } else if (action.type === 'show' && action.id !== undefined) {
            info(`\nRun: localpress show ${action.id}`);
          }
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
        } catch { /* If the DB doesn't exist yet, all items are unoptimized. */ }
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
      info(`Showing ${from}–${to} of ${total} item(s)${pageInfo}:\n`);

      for (const item of items) {
        const size = item.sizeBytes ? formatBytes(item.sizeBytes) : '?';
        const dims = item.width && item.height ? `${item.width}×${item.height}` : '';
        info(`  #${item.id}  ${item.filename}  ${item.mimeType}  ${size}  ${dims}`);
      }

      if (pageNum < totalPages) {
        info(`\nNext page: localpress list --page ${pageNum + 1}`);
      }
    });
}

async function showImagePreview(item: MediaItem): Promise<void> {
  const supportsIterm2 =
    process.env.TERM_PROGRAM === 'iTerm.app' ||
    process.env.TERM_PROGRAM === 'WarpTerminal' ||
    process.env.TERM_PROGRAM === 'WezTerm' ||
    process.env.KITTY_WINDOW_ID !== undefined;

  info(`\n  ${item.filename}  ·  #${item.id}  ·  ${item.mimeType}`);
  if (item.width) info(`  ${item.width}×${item.height}px`);
  if (item.sizeBytes) info(`  ${formatBytes(item.sizeBytes)}`);
  info(`  ${item.url}`);

  if (supportsIterm2 && item.url && item.mimeType.startsWith('image/')) {
    try {
      const response = await fetch(item.url);
      const buffer = Buffer.from(await response.arrayBuffer());
      const b64 = buffer.toString('base64');
      const nameB64 = Buffer.from(item.filename).toString('base64');
      // iTerm2 inline image protocol
      process.stdout.write(
        `\n\x1b]1337;File=name=${nameB64};size=${buffer.byteLength};inline=1;width=60;preserveAspectRatio=1:${b64}\x07\n`,
      );
    } catch {
      info(`\n  (Preview unavailable — open in browser: ${item.url})`);
    }
  } else if (!supportsIterm2) {
    info('\n  (Inline preview requires iTerm2, Warp, or WezTerm)');
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
