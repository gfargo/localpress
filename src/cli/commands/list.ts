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
        const { render, useApp, useInput: useInkInput, Text: InkText } = await import('ink');
        const React = await import('react');
        const { useState: useReactState, useEffect: useReactEffect } = React.default;
        const { MediaBrowser } = await import('../components/MediaBrowser.tsx');
        const { spawnSync } = await import('node:child_process');

        // argv[1] is a .ts script in dev mode; the compiled binary repeats argv[0].
        const isDevMode = /\.(ts|mts|js|mjs)$/.test(process.argv[1] ?? '');
        const selfArgs = (cmd: string, id: string, extra: string[] = []) =>
          isDevMode ? [process.argv[1], cmd, id, ...extra] : [cmd, id, ...extra];

        const { spawn: spawnBg } = await import('node:child_process');
        const openInBrowser = (id: number) => {
          const adminUrl = `${site.url.replace(/\/+$/, '')}/wp-admin/post.php?post=${id}&action=edit`;
          if (process.platform === 'win32') {
            spawnBg('cmd', ['/c', 'start', '', adminUrl], {
              detached: true,
              stdio: 'ignore',
            }).unref();
          } else {
            spawnBg(process.platform === 'darwin' ? 'open' : 'xdg-open', [adminUrl], {
              detached: true,
              stdio: 'ignore',
            }).unref();
          }
        };

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

        // Restore last browser position from SQLite (if no explicit --page).
        if (!options.page) {
          try {
            const db = SiteDb.init(getSiteDbPath(site.name));
            const savedPage = db.getPref(site.name, 'browser.page');
            const savedCursor = db.getPref(site.name, 'browser.cursor');
            if (savedPage) interactivePage = Math.max(1, Number.parseInt(savedPage, 10) || 1);
            if (savedCursor) interactiveCursor = Math.max(0, Number.parseInt(savedCursor, 10) || 0);
            db.close();
          } catch {
            // DB may not exist yet — start from defaults.
          }
        }

        /** Persist the current browser position to SQLite. */
        const saveBrowserPosition = (page: number, cursor: number) => {
          try {
            const db = SiteDb.init(getSiteDbPath(site.name));
            db.ensureSite(site.name, site.url);
            db.setPref(site.name, 'browser.page', String(page));
            db.setPref(site.name, 'browser.cursor', String(cursor));
            db.close();
          } catch {
            // Best effort — don't fail the CLI over a preference save.
          }
        };

        // Loop: re-enter the TUI after each subcommand until the user quits.
        while (true) {
          let result: { items: MediaItem[]; total: number; totalPages: number };

          // Show a loading spinner while fetching the page.
          const spinner = render(
            React.default.createElement(InkText, { color: 'cyan' }, '⠋ Loading media library...'),
          );

          try {
            result = await adapter.listMediaPage({ ...filters, page: interactivePage });
          } catch (err) {
            spinner.unmount();
            error(err instanceof Error ? err.message : String(err));
            process.exit(4);
            return;
          }

          spinner.unmount();

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
              onFetchItem: (id: number) => adapter.getMedia(id),
              onOpenInBrowser: openInBrowser,
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
          if (!pendingAction || pendingAction.type === 'quit') {
            // Save position on quit so we resume here next time.
            const quitPage = pendingAction?.type === 'quit' ? pendingAction.page : interactivePage;
            const quitCursor =
              pendingAction?.type === 'quit' ? pendingAction.cursor : interactiveCursor;
            saveBrowserPosition(quitPage, quitCursor);
            break;
          }

          // Clear the TUI before running the subcommand.
          process.stdout.write('\x1b[2J\x1b[H');

          // Browser preview: open image in browser directly (no subprocess).
          if (pendingAction.type === 'browser-preview') {
            const { quickViewInBrowser } = await import('../../engine/preview/quick-view.ts');
            info(`  Opening #${pendingAction.id} in browser...`);
            try {
              const getAdapter = resolver.resolve('get');
              const item = await getAdapter.getMedia(pendingAction.id);
              const response = await fetch(item.url);
              if (response.ok) {
                const imageBytes = Buffer.from(await response.arrayBuffer());
                await quickViewInBrowser({
                  imageBytes,
                  mimeType: item.mimeType,
                  filename: item.filename,
                  width: item.width,
                  height: item.height,
                  sizeBytes: item.sizeBytes,
                  wpId: item.id,
                });
              }
            } catch (err) {
              error(err instanceof Error ? err.message : String(err));
            }

            interactivePage = pendingAction.page;
            interactiveCursor = pendingAction.cursor;
            saveBrowserPosition(interactivePage, interactiveCursor);
            process.stdout.write('\x1b[2J\x1b[H');
            continue;
          }

          let subCmd: string;
          let extraArgs: string[] = [];
          switch (pendingAction.type) {
            case 'optimize':
              subCmd = 'optimize';
              if (pendingAction.quality !== undefined)
                extraArgs.push('--quality', String(pendingAction.quality));
              if (pendingAction.to) extraArgs.push('--to', pendingAction.to);
              if (pendingAction.keepOriginal) extraArgs.push('--keep-original');
              if (pendingAction.preview) extraArgs.push('--preview');
              break;
            case 'remove-bg':
              subCmd = 'remove-bg';
              if (pendingAction.preview) extraArgs.push('--preview');
              break;
            case 'caption':
              subCmd = 'caption';
              break;
            case 'convert':
              subCmd = 'convert';
              extraArgs = ['--to', pendingAction.to];
              if (pendingAction.quality !== undefined)
                extraArgs.push('--quality', String(pendingAction.quality));
              break;
            case 'resize':
              subCmd = 'resize';
              if (pendingAction.maxWidth)
                extraArgs.push('--max-width', String(pendingAction.maxWidth));
              if (pendingAction.maxHeight)
                extraArgs.push('--max-height', String(pendingAction.maxHeight));
              break;
            default:
              subCmd = 'edit';
          }

          spawnSync(process.argv[0], selfArgs(subCmd, String(pendingAction.id), extraArgs), {
            stdio: 'inherit',
          });

          // Use Ink for the "press any key" prompt so stdin is managed correctly.
          // The 80ms ready-delay drains any buffered keystroke (e.g. the 'o'/'e' that
          // triggered the action) before we start listening for a new keypress.
          await new Promise<void>((resolve) => {
            function PressAnyKey() {
              const [ready, setReady] = useReactState(false);
              const { exit } = useApp();
              useReactEffect(() => {
                const t = setTimeout(() => setReady(true), 80);
                return () => clearTimeout(t);
              }, []);
              useInkInput(() => {
                if (ready) {
                  exit();
                  resolve();
                }
              });
              return React.default.createElement(
                InkText,
                { dimColor: true },
                '\n── Press any key to return to the browser ──',
              );
            }
            render(React.default.createElement(PressAnyKey, null));
          });

          // Restore position and refresh processedIds before re-entering the TUI.
          interactivePage = pendingAction.page;
          interactiveCursor = pendingAction.cursor;
          saveBrowserPosition(interactivePage, interactiveCursor);
          const processingTypes = new Set([
            'optimize',
            'resize',
            'convert',
            'remove-bg',
            'caption',
          ]);
          if (processingTypes.has(pendingAction.type)) processedIds = loadProcessedIds();

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
