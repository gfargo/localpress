/**
 * `localpress caption [ids...]` — AI alt-text generation via local Ollama.
 *
 * Downloads each attachment, sends the image to a locally-running Ollama
 * multimodal model, and writes the result back to WordPress as alt_text.
 * No cloud API. No credits.
 *
 * Recommended models (install via `ollama pull <name>`):
 *   moondream   ~1.7 GB  fast, accurate, ideal for bulk alt-text
 *   llava       ~4.7 GB  higher quality, slower
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import {
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  generateCaption,
  isOllamaAvailable,
  listOllamaModels,
} from '../../engine/caption/ollama.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

export function registerCaptionCommand(program: Command): void {
  program
    .command('caption [ids...]')
    .description('Generate alt-text for images using a local Ollama vision model')
    .option(
      '--model <name>',
      `Ollama vision model to use (default: ${DEFAULT_OLLAMA_MODEL})`,
      DEFAULT_OLLAMA_MODEL,
    )
    .option('--prompt <text>', 'custom captioning prompt')
    .option(
      '--ollama-url <url>',
      `Ollama base URL (default: ${DEFAULT_OLLAMA_URL})`,
      DEFAULT_OLLAMA_URL,
    )
    .option('--missing-alt', 'only process attachments that have no alt text set')
    .option('--all', 'process all image attachments (dry-run unless --apply)')
    .option('--overwrite', 'replace existing alt text (default: skip if already set)')
    .option('--language <lang>', 'generate alt text in this language (e.g. "Spanish", "French")')
    .option('--dry-run', 'print generated captions without updating WordPress')
    .option('--list-models', 'list Ollama models available locally and exit')
    .action(async (idStrs: string[], options) => {
      const parentOpts = program.opts();

      // --list-models
      if (options.listModels) {
        if (!(await isOllamaAvailable(options.ollamaUrl))) {
          error(
            `Ollama is not running at ${options.ollamaUrl}.\n\n  Start it:     ollama serve\n  Setup guide:  https://localpress.griffen.codes/docs/ollama-setup`,
          );
          process.exit(2);
        }
        const models = await listOllamaModels(options.ollamaUrl);
        const vision = models.filter((m) =>
          /moondream|llava|bakllava|llama.*vision|qwen.*vl|minicpm|phi.*vision/i.test(m.name),
        );
        if (parentOpts.json) {
          printJson(vision.length ? vision : models);
          return;
        }
        const list = vision.length ? vision : models;
        if (list.length === 0) {
          info('No models found. Pull one with: ollama pull moondream');
          return;
        }
        info('Locally available vision models:\n');
        for (const m of list) {
          info(`  ${m.name.padEnd(30)} ${formatBytes(m.size)}`);
        }
        info('\nPull a model: ollama pull moondream');
        return;
      }

      // Validate Ollama is reachable before doing any work.
      if (!(await isOllamaAvailable(options.ollamaUrl))) {
        error(
          `Ollama is not running at ${options.ollamaUrl}.\n\n  Start it:       ollama serve\n  Pull a model:   ollama pull ${options.model}\n\n  Setup guide:    https://localpress.griffen.codes/docs/ollama-setup`,
        );
        process.exit(2);
      }

      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const listAdapter = resolver.resolve('list');
      const getAdapter = resolver.resolve('get');
      const updateAdapter = resolver.resolve('update-meta');

      // Resolve which attachment IDs to process.
      let ids: number[];

      if (idStrs.length > 0) {
        ids = idStrs.map((s) => Number.parseInt(s, 10));
        if (ids.some(Number.isNaN)) {
          error('All arguments must be valid attachment IDs (integers).');
          process.exit(2);
        }
      } else if (options.missingAlt) {
        info('  Fetching attachments with missing alt text…');
        const allItems = await fetchAllImageAttachments(listAdapter);
        ids = allItems.filter((item) => !item.altText?.trim()).map((item) => item.id);
        if (ids.length === 0) {
          info('All image attachments already have alt text.');
          return;
        }
        info(`  Found ${ids.length} attachment(s) without alt text.\n`);
      } else if (options.all) {
        info('  Fetching all image attachments…');
        const allItems = await fetchAllImageAttachments(listAdapter);
        ids = allItems.map((item) => item.id);
        if (ids.length === 0) {
          info('No image attachments found.');
          return;
        }
        info(`  Found ${ids.length} image attachment(s).\n`);
      } else {
        error(
          'Specify attachment IDs, or use --missing-alt / --all for bulk operations.\n' +
            'Example: localpress caption 123 124\n' +
            '         localpress caption --missing-alt\n' +
            '         localpress caption --all --dry-run',
        );
        process.exit(2);
      }

      // Bulk operations (--all, --missing-alt) are dry-run by default unless --apply is passed.
      const isBulk = !idStrs.length && (options.missingAlt || options.all);
      const isDryRun = options.dryRun || (isBulk && !parentOpts.apply);

      if (isBulk && !parentOpts.apply && !options.dryRun) {
        info('  Dry-run: pass --apply to write captions to WordPress.\n');
      }

      const db = SiteDb.init(getSiteDbPath(site.name));
      db.ensureSite(site.name, site.url);

      const results: Array<{
        id: number;
        filename: string;
        caption: string;
        previousAlt: string | undefined;
        skipped: boolean;
        durationMs: number;
      }> = [];
      let failures = 0;

      for (const id of ids) {
        const startTime = Date.now();
        try {
          const item = await getAdapter.getMedia(id);

          if (!item.mimeType.startsWith('image/')) {
            warn(`  ⚠ #${id} (${item.filename}) is not an image — skipping.`);
            continue;
          }

          // Skip if alt text already set and --overwrite not passed.
          if (item.altText?.trim() && !options.overwrite) {
            info(
              `  — #${id} (${item.filename}) already has alt text — skipping. (use --overwrite to replace)`,
            );
            results.push({
              id,
              filename: item.filename,
              caption: item.altText,
              previousAlt: item.altText,
              skipped: true,
              durationMs: 0,
            });
            continue;
          }

          info(`  Captioning #${id} (${item.filename})…`);

          const response = await fetch(item.url);
          if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);
          const imageBuffer = Buffer.from(await response.arrayBuffer());

          const result = await generateCaption(imageBuffer, {
            model: options.model,
            prompt: options.prompt,
            ollamaUrl: options.ollamaUrl,
            language: options.language,
          });

          info(`    ✓ "${result.caption}" (${result.durationMs}ms)`);

          if (!isDryRun) {
            await updateAdapter.updateMetadata(id, { altText: result.caption });
          }

          db.upsertAttachment({
            siteName: site.name,
            wpId: item.id,
            sourceUrl: item.url,
            sourceHash: null,
            sizeBytes: imageBuffer.length,
            width: item.width ?? null,
            height: item.height ?? null,
            mimeType: item.mimeType,
            lastSeenAt: Date.now(),
          });

          if (!isDryRun) {
            db.recordProcessing({
              siteName: site.name,
              wpId: item.id,
              operation: 'caption',
              paramsJson: JSON.stringify({
                model: result.model,
                overwrite: options.overwrite ?? false,
              }),
              sourceHash: null,
              resultHash: null,
              bytesBefore: null,
              bytesAfter: null,
              resultWpId: null,
              ranAt: Date.now(),
              durationMs: result.durationMs,
              status: 'success',
              errorMessage: null,
            });
          }

          results.push({
            id,
            filename: item.filename,
            caption: result.caption,
            previousAlt: item.altText ?? undefined,
            skipped: false,
            durationMs: result.durationMs,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          error(`    ✗ #${id}: ${message}`);
          failures++;

          db.recordProcessing({
            siteName: site.name,
            wpId: id,
            operation: 'caption',
            paramsJson: JSON.stringify({ model: options.model }),
            sourceHash: null,
            resultHash: null,
            bytesBefore: null,
            bytesAfter: null,
            resultWpId: null,
            ranAt: Date.now(),
            durationMs: Date.now() - startTime,
            status: 'failure',
            errorMessage: message,
          });
        }
      }

      db.close();

      if (parentOpts.json) {
        printJson({
          dryRun: isDryRun,
          processed: results.filter((r) => !r.skipped).length,
          skipped: results.filter((r) => r.skipped).length,
          failures,
          results,
        });
        return;
      }

      const acted = results.filter((r) => !r.skipped);
      if (acted.length > 0 || failures > 0) {
        const dryNote = isDryRun ? ' (dry run — WordPress not updated)' : '';
        info(
          `\n  Done: ${acted.length} captioned, ${results.filter((r) => r.skipped).length} skipped, ${failures} failed${dryNote}.`,
        );
      }

      if (failures > 0) process.exit(1);
    });
}

async function fetchAllImageAttachments(
  adapter: import('../../adapters/types.ts').WpBackend,
): Promise<import('../../adapters/types.ts').MediaItem[]> {
  const all: import('../../adapters/types.ts').MediaItem[] = [];
  let page = 1;
  while (true) {
    const result = await adapter.listMediaPage({ type: 'image/', perPage: 100, page });
    all.push(...result.items);
    if (page >= result.totalPages) break;
    page++;
  }
  return all;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
