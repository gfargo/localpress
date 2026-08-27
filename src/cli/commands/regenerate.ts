/**
 * `localpress regenerate` — regenerate WordPress thumbnails.
 *
 * Calls `wp media regenerate` via WP-CLI for one or more attachments.
 * Useful after:
 *   - Bulk optimizing without --regenerate-thumbnails
 *   - Changing themes (new image sizes registered)
 *   - Fixing broken/missing thumbnails
 *
 * Requires WP-CLI (SSH) — the `regenerate-thumbnails` capability.
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { MediaItem } from '../../adapters/types.ts';
import { forEachConcurrent, resolveConcurrency, sortResultsById } from '../utils/concurrency.ts';
import { loadConfig, resolveActiveSite } from '../utils/config.ts';
import { parseAttachmentIds } from '../utils/ids.ts';
import { error, info, printJson, warn } from '../utils/output.ts';
import { dryRunPayload, resolveDryRun } from '../utils/run-mode.ts';

export function registerRegenerateCommand(program: Command): void {
  program
    .command('regenerate')
    .description('Regenerate WordPress thumbnails for attachments (requires WP-CLI)')
    .argument('[ids...]', 'attachment IDs to regenerate')
    .option('--all', 'regenerate thumbnails for all attachments')
    .action(async (idStrs: string[], options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);

      const hasExplicitIds = idStrs.length > 0;
      const isBulk = Boolean(options.all);

      if (!hasExplicitIds && !isBulk) {
        error(
          'Specify attachment IDs, or use --all for bulk regeneration.\n' +
            'Example: localpress regenerate 123 124 125\n' +
            'Example: localpress regenerate --all --apply',
        );
        process.exit(2);
      }

      // Check capability.
      const adapter = resolver.tryResolve('regenerate-thumbnails');
      if (!adapter) {
        error(
          'Thumbnail regeneration requires WP-CLI over SSH.\n' +
            'Configure SSH in your site config to unlock this capability.\n' +
            'Run `localpress doctor` to see your current capabilities.',
        );
        process.exit(6);
      }

      // Resolve IDs.
      let ids: number[];

      if (hasExplicitIds) {
        ids = parseAttachmentIds(idStrs);
      } else {
        // --all: list all attachments (read-only, safe to do before the dry-run gate).
        const listAdapter = resolver.resolve('list');
        let allItems: MediaItem[] = [];
        let page = 1;
        while (true) {
          const batch = await listAdapter.listMedia({ perPage: 100, page });
          if (batch.length === 0) break;
          allItems = allItems.concat(batch);
          if (batch.length < 100) break;
          page++;
        }
        ids = allItems.map((item) => item.id);

        if (ids.length === 0) {
          info('No attachments found.');
          return;
        }
      }

      const isDryRun = resolveDryRun(parentOpts, isBulk);
      if (isDryRun) {
        info(
          `Dry-run: would regenerate thumbnails for ${ids.length} attachment(s). Pass --apply to execute.`,
        );
        if (parentOpts.json) {
          printJson(
            dryRunPayload(
              { operation: 'regenerate', count: ids.length, items: ids.map((id) => ({ id })) },
              { count: ids.length, ids },
            ),
          );
        }
        return;
      }

      // Execute regeneration.
      const { effective: concurrency } = resolveConcurrency(
        parentOpts.concurrency,
        config.defaults?.concurrency,
      );
      const results: Array<{ id: number; status: 'success' | 'failure'; error?: string }> = [];
      let succeeded = 0;
      let failed = 0;

      if (!parentOpts.json) {
        info(`Regenerating thumbnails for ${ids.length} attachment(s)...\n`);
      }

      await forEachConcurrent(ids, concurrency, async (id) => {
        try {
          await adapter.regenerateThumbnails(id);
          succeeded++;
          results.push({ id, status: 'success' });
          if (!parentOpts.json) {
            info(`  ✓ #${id} regenerated`);
          }
        } catch (err) {
          failed++;
          const errMsg = err instanceof Error ? err.message : String(err);
          results.push({ id, status: 'failure', error: errMsg });
          if (!parentOpts.json) {
            warn(`  ✗ #${id} failed: ${errMsg}`);
          }
        }
      });
      sortResultsById(results, ids);

      // Summary.
      if (parentOpts.json) {
        printJson({ succeeded, failed, total: ids.length, results });
      } else {
        info(`\nDone: ${succeeded} succeeded, ${failed} failed (${ids.length} total).`);
      }

      if (failed > 0) {
        process.exit(1);
      }
    });
}
