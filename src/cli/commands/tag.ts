/**
 * `localpress tag [ids...]` — AI-generated tags for attachments.
 *
 * Writes a comma-separated list of 3-6 short tags to the attachment's
 * `caption` field as `[tags: tag1, tag2, …]` markers. The caption field is
 * universally available via WP REST without requiring taxonomies to be
 * registered for the `attachment` post type — which keeps this working on
 * any WordPress install.
 *
 * Existing caption content is preserved: tags are appended (or replaced if
 * a `[tags: …]` block already exists) without clobbering user-written
 * captions.
 *
 * Future iterations could write to actual WP taxonomies when available,
 * detected via `doctor --plugins` (e.g. via WP-CLI or a plugin that
 * registers tags on attachments).
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { WpBackend } from '../../adapters/types.ts';
import {
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  cleanTagsArray,
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
import { error, info, printJson, warn } from '../utils/output.ts';
import { resolveDryRun } from '../utils/run-mode.ts';

interface TagResult {
  id: number;
  filename: string;
  tags: string[];
  skipped: boolean;
  durationMs: number;
}

/** Match an existing `[tags: a, b, c]` block in caption text. */
const TAG_BLOCK_RE = /\[tags:\s*([^\]]*)\]/i;

export function registerTagCommand(program: Command): void {
  program
    .command('tag [ids...]')
    .description(
      'AI-generated tags (3-6 short labels) written to the attachment caption as a `[tags: …]` block.',
    )
    .option(
      '--model <name>',
      `Ollama vision model. Resolution: --model > config.defaults.captionModel > ${DEFAULT_OLLAMA_MODEL}`,
    )
    .option(
      '--ollama-url <url>',
      `Ollama base URL (default: ${DEFAULT_OLLAMA_URL})`,
      DEFAULT_OLLAMA_URL,
    )
    .option('--all', 'tag all image attachments (dry-run unless --apply)')
    .option('--missing-tags', 'only items without an existing [tags: …] block')
    .option(
      '--overwrite',
      'replace existing [tags: …] block; default appends if absent, keeps otherwise',
    )
    .action(async (idStrs: string[], options) => {
      const parentOpts = program.opts();

      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const listAdapter = resolver.resolve('list');
      const getAdapter = resolver.resolve('get');
      const metaAdapter = resolver.resolve('update-meta');

      const effectiveModel: string =
        options.model ?? config.defaults?.captionModel ?? DEFAULT_OLLAMA_MODEL;

      const preflightError = await preflightOllama(effectiveModel, options.ollamaUrl);
      if (preflightError) {
        error(preflightError);
        process.exit(2);
      }

      const isBulk = !idStrs.length && (options.missingTags || options.all);
      const isDryRun = resolveDryRun(parentOpts, isBulk);

      if (!idStrs.length && !isBulk) {
        error(
          'Specify attachment IDs, --missing-tags, or --all.\n' +
            '  localpress tag 123 124\n' +
            '  localpress tag --missing-tags --apply',
        );
        process.exit(2);
      }

      let ids: number[];
      if (idStrs.length > 0) {
        ids = parseAttachmentIds(idStrs);
      } else {
        info('  Fetching image attachments…');
        const all = await fetchAllImages(listAdapter);
        ids = options.missingTags
          ? all.filter((m) => !TAG_BLOCK_RE.test(m.caption ?? '')).map((m) => m.id)
          : all.map((m) => m.id);
        info(`  Found ${ids.length} target attachment(s).`);
      }

      if (ids.length === 0) {
        info('  Nothing to do.');
        return;
      }

      if (isBulk && isDryRun) {
        info('  Dry-run: pass --apply to write tags to WordPress.\n');
      }

      const db = SiteDb.init(getSiteDbPath(site.name));
      db.ensureSite(site.name, site.url);

      const historyConfig = resolveHistoryConfig(config.history);
      const snapshotStore = openSnapshotStore(db, getConfigDir());
      const session =
        historyConfig.enabled && !isDryRun
          ? openHistorySession(snapshotStore, site.name, 'tag', { model: effectiveModel })
          : null;

      const results: TagResult[] = [];
      let failures = 0;

      for (const id of ids) {
        try {
          const item = await getAdapter.getMedia(id);

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

          if (!item.mimeType.startsWith('image/')) {
            info(`  — #${id} (${item.filename}) — not an image, skipping`);
            continue;
          }

          // Idempotent: caption already has tags and not --overwrite.
          const currentCaption = item.caption ?? '';
          const hadBlock = TAG_BLOCK_RE.test(currentCaption);
          if (hadBlock && !options.overwrite) {
            const existing = currentCaption.match(TAG_BLOCK_RE)?.[1]?.trim() ?? '';
            info(
              `  — #${id} (${item.filename}) — already tagged [${existing}], skipping (pass --overwrite to replace)`,
            );
            results.push({
              id,
              filename: item.filename,
              tags: cleanTagsArray(existing),
              skipped: true,
              durationMs: 0,
            });
            continue;
          }

          info(`  Tagging #${id} (${item.filename})…`);

          const response = await fetch(item.url);
          if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
          const buf = Buffer.from(await response.arrayBuffer());

          const result = await generateCaption(buf, {
            kind: 'tags',
            model: effectiveModel,
            ollamaUrl: options.ollamaUrl,
          });

          const tags = cleanTagsArray(result.caption);
          if (tags.length === 0) {
            throw new Error('Vision model returned no usable tags');
          }

          const newBlock = `[tags: ${tags.join(', ')}]`;
          const newCaption = hadBlock
            ? currentCaption.replace(TAG_BLOCK_RE, newBlock).trim()
            : currentCaption
              ? `${currentCaption.trim()} ${newBlock}`
              : newBlock;

          if (!isDryRun) {
            if (session) {
              captureSnapshot(snapshotStore, {
                siteName: site.name,
                sessionId: session.id,
                attachmentId: item.id,
                operation: 'tag',
                sourceBytes: null,
                beforeMeta: {
                  filename: item.filename,
                  mimeType: item.mimeType,
                  altText: item.altText,
                  title: item.title,
                  caption: item.caption,
                  description: item.description,
                },
              });
            }
            await metaAdapter.updateMetadata(item.id, { caption: newCaption });
          }

          info(`    ✓ [${tags.join(', ')}] (${result.durationMs}ms)`);

          results.push({
            id,
            filename: item.filename,
            tags,
            skipped: false,
            durationMs: result.durationMs,
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

      const processed = results.filter((r) => !r.skipped).length;
      const skipped = results.filter((r) => r.skipped).length;

      if (parentOpts.json) {
        printJson({ dryRun: isDryRun, processed, skipped, failures, results });
      } else if (processed + skipped > 0 || failures > 0) {
        const dryNote = isDryRun ? ' (dry run — WordPress not updated)' : '';
        info(`\n  Done: ${processed} tagged, ${skipped} skipped, ${failures} failed${dryNote}.`);
      }

      if (failures > 0) process.exit(1);
    });
}

async function fetchAllImages(
  adapter: WpBackend,
): Promise<Array<{ id: number; caption: string | undefined }>> {
  const out: Array<{ id: number; caption: string | undefined }> = [];
  let page = 1;
  while (true) {
    try {
      const result = await adapter.listMediaPage({ type: 'image/', perPage: 100, page });
      out.push(...result.items.map((i) => ({ id: i.id, caption: i.caption })));
      if (page >= result.totalPages) break;
      page++;
    } catch (err) {
      warn(`  Pagination stopped: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }
  return out;
}
