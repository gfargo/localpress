/**
 * `localpress rename <ids> [--smart | --to <name>]` — rename attachment slugs.
 *
 * Two modes:
 *   --smart    Generate a name via the Ollama vision model (uses the `title`
 *              kind), then slugify it. Most useful for cleaning up
 *              auto-generated WP slugs like "screenshot-2026-05-06-at-5-20-18-pm".
 *   --to NAME  Use the supplied name explicitly. Skips the vision call.
 *
 * Currently updates the WordPress slug (`post_name`) — the permalink. Does
 * NOT rename the underlying file on disk; that requires WP-CLI + filesystem
 * ops (or the Enable Media Replace plugin) and is not yet supported.
 *
 * Time-machine: a metadata-only snapshot is captured before the rename so
 * `localpress undo` can restore the previous slug.
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import {
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  generateCaption,
} from '../../engine/caption/ollama.ts';
import { preflightOllama } from '../../engine/caption/run-bulk.ts';
import {
  captureSnapshot,
  closeHistorySession,
  openHistorySession,
  openSnapshotStore,
  resolveHistoryConfig,
} from '../../engine/history/index.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { getConfigDir, getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { parseAttachmentIds } from '../utils/ids.ts';
import { error, info, printJson } from '../utils/output.ts';
import { resolveDryRun } from '../utils/run-mode.ts';

interface RenameResult {
  id: number;
  filename: string;
  from: string;
  to: string;
  source: 'smart' | 'explicit';
  skipped: boolean;
}

export function registerRenameCommand(program: Command): void {
  program
    .command('rename <ids...>')
    .description(
      'Rename attachment slug (permalink). With --smart, generate the name via vision; with --to, pass it explicitly. Does NOT rename the underlying file.',
    )
    .option('--smart', 'AI-generate the new name via the Ollama vision model')
    .option('--to <name>', 'explicit name (will be slugified). Skips the vision call.')
    .option(
      '--model <name>',
      `Ollama model when --smart. Resolution: --model > config.defaults.captionModel > ${DEFAULT_OLLAMA_MODEL}`,
    )
    .option(
      '--ollama-url <url>',
      `Ollama base URL (default: ${DEFAULT_OLLAMA_URL})`,
      DEFAULT_OLLAMA_URL,
    )
    .action(async (idStrs: string[], options) => {
      const parentOpts = program.opts();
      const dryRun = resolveDryRun(parentOpts, false);
      const ids = parseAttachmentIds(idStrs);

      if (!options.smart && !options.to) {
        error(
          'Provide one of:\n  --smart                    (AI-generate the new name)\n  --to <name>                (explicit name; will be slugified)',
        );
        process.exit(2);
      }
      if (options.smart && options.to) {
        error('--smart and --to are mutually exclusive.');
        process.exit(2);
      }

      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const getAdapter = resolver.resolve('get');
      const metaAdapter = resolver.resolve('update-meta');

      const effectiveModel: string =
        options.model ?? config.defaults?.captionModel ?? DEFAULT_OLLAMA_MODEL;

      if (options.smart) {
        const preflightError = await preflightOllama(effectiveModel, options.ollamaUrl);
        if (preflightError) {
          error(preflightError);
          process.exit(2);
        }
      }

      const db = SiteDb.init(getSiteDbPath(site.name));
      db.ensureSite(site.name, site.url);

      const historyConfig = resolveHistoryConfig(config.history);
      const snapshotStore = openSnapshotStore(db, getConfigDir());
      const session =
        historyConfig.enabled && !dryRun
          ? openHistorySession(snapshotStore, site.name, 'rename', {
              mode: options.smart ? 'smart' : 'explicit',
              to: options.to ?? null,
            })
          : null;

      const results: RenameResult[] = [];
      let failures = 0;

      for (const id of ids) {
        try {
          const item = await getAdapter.getMedia(id);
          info(`  Renaming #${id} (${item.filename})…`);

          // Determine the new name.
          let proposed: string;
          let source: 'smart' | 'explicit';
          if (options.to) {
            proposed = options.to;
            source = 'explicit';
          } else {
            // --smart: download + generate a title via vision.
            const response = await fetch(item.url);
            if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
            const buf = Buffer.from(await response.arrayBuffer());
            const result = await generateCaption(buf, {
              kind: 'title',
              model: effectiveModel,
              ollamaUrl: options.ollamaUrl,
            });
            proposed = result.caption;
            source = 'smart';
          }

          const newSlug = slugify(proposed);
          if (!newSlug) {
            throw new Error(`Could not derive a usable slug from "${proposed}"`);
          }

          // Idempotent: skip if the slug already matches (e.g. user re-runs).
          const previousSlug = extractSlug(item.url, item.filename);
          if (previousSlug === newSlug) {
            info(`    — already named '${newSlug}' — skipping`);
            results.push({
              id,
              filename: item.filename,
              from: previousSlug,
              to: newSlug,
              source,
              skipped: true,
            });
            continue;
          }

          if (!dryRun) {
            // Upsert first (FK safety for processing_history).
            db.upsertAttachment({
              siteName: site.name,
              wpId: item.id,
              sourceUrl: item.url,
              sourceHash: null,
              sizeBytes: item.sizeBytes ?? null,
              width: item.width ?? null,
              height: item.height ?? null,
              mimeType: item.mimeType,
              lastSeenAt: Date.now(),
            });

            if (session) {
              captureSnapshot(snapshotStore, {
                siteName: site.name,
                sessionId: session.id,
                attachmentId: item.id,
                operation: 'rename',
                sourceBytes: null,
                beforeMeta: {
                  filename: item.filename,
                  mimeType: item.mimeType,
                  altText: item.altText,
                  title: item.title,
                  caption: item.caption,
                  description: item.description,
                  slug: item.slug ?? previousSlug,
                },
              });
            }
            await metaAdapter.updateMetadata(id, { slug: newSlug });
          }

          info(`    ✓ slug: ${previousSlug} → ${newSlug}${dryRun ? ' (dry-run)' : ''}`);

          results.push({
            id,
            filename: item.filename,
            from: previousSlug,
            to: newSlug,
            source,
            skipped: false,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          error(`    ✗ #${id}: ${message}`);
          failures++;
        }
      }

      if (session) {
        closeHistorySession(snapshotStore, session, {
          maxSizeBytes: historyConfig.maxSizeBytes,
        });
      }

      db.close();

      if (parentOpts.json) {
        printJson({
          dryRun,
          renamed: results.filter((r) => !r.skipped).length,
          skipped: results.filter((r) => r.skipped).length,
          failures,
          results,
        });
      } else {
        info('');
        info(
          `  Done: ${results.filter((r) => !r.skipped).length} renamed, ${results.filter((r) => r.skipped).length} skipped, ${failures} failed.`,
        );
        if (!dryRun && results.some((r) => !r.skipped)) {
          info(
            '  Note: slug changes affect permalinks only — the underlying file URL is unchanged.',
          );
        }
      }

      if (failures > 0) process.exit(1);
    });
}

/** Slug-ify a free-text string into a WordPress-compatible slug. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-') // spaces/underscores → hyphen FIRST so we keep word boundaries
    .replace(/[^a-z0-9-]/g, '') // strip everything but lowercase, digits, hyphen
    .replace(/-+/g, '-') // collapse runs of hyphens
    .replace(/^-+|-+$/g, '') // trim leading/trailing hyphens
    .slice(0, 100); // WP slugs are typically capped
}

/** Best-effort extraction of the current slug from a filename. */
function extractSlug(_url: string, filename: string): string {
  const base = filename.replace(/\.[^./\\]+$/, '');
  return slugify(base);
}
