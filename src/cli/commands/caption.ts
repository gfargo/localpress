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
import {
  captureSnapshot,
  closeHistorySession,
  openHistorySession,
  openSnapshotStore,
  resolveHistoryConfig,
} from '../../engine/history/index.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { getConfigDir, getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

export function registerCaptionCommand(program: Command): void {
  program
    .command('caption [ids...]')
    .description('Generate alt-text for images using a local Ollama vision model')
    .option(
      '--model <name>',
      `Ollama vision model to use. Resolution order: --model > config.defaults.captionModel > built-in default (${DEFAULT_OLLAMA_MODEL})`,
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

      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const listAdapter = resolver.resolve('list');
      const getAdapter = resolver.resolve('get');
      const updateAdapter = resolver.resolve('update-meta');

      // Resolve the effective Ollama model:
      //   --model flag > config.defaults.captionModel > built-in default
      const effectiveModel: string =
        options.model ?? config.defaults?.captionModel ?? DEFAULT_OLLAMA_MODEL;

      // Validate Ollama is reachable before doing any work.
      if (!(await isOllamaAvailable(options.ollamaUrl))) {
        error(
          `Ollama is not running at ${options.ollamaUrl}.\n\n  Start it:       ollama serve\n  Pull a model:   ollama pull ${effectiveModel}\n\n  Setup guide:    https://localpress.griffen.codes/docs/ollama-setup`,
        );
        process.exit(2);
      }

      // Pre-flight: verify the resolved model is actually installed locally.
      // Catches typos and "default model not pulled" cases BEFORE a 300-item
      // bulk run fails the same way on every item.
      try {
        const installed = await listOllamaModels(options.ollamaUrl);
        const installedNames = installed.map((m) => m.name);
        const hasMatch = installedNames.some(
          (n) =>
            n === effectiveModel ||
            n === `${effectiveModel}:latest` ||
            n.startsWith(`${effectiveModel}:`),
        );

        if (!hasMatch) {
          const visionModels = installedNames.filter((n) =>
            /moondream|llava|bakllava|llama.*vision|qwen.*vl|minicpm|phi.*vision/i.test(n),
          );

          const visionList =
            visionModels.length > 0
              ? `\n\n  Your locally-available vision models:\n    ${visionModels.join('\n    ')}`
              : '\n\n  No vision models installed locally.';

          const remediation =
            visionModels.length > 0
              ? `  Or use one you already have:\n    localpress caption --model ${visionModels[0]} ...\n\n  Or set it as the project default:\n    localpress config set defaults.captionModel ${visionModels[0]}\n`
              : '  Recommended starter model:\n    ollama pull moondream\n';

          error(
            `Ollama model '${effectiveModel}' is not available on ${options.ollamaUrl}.${visionList}\n\n  Pull the requested model:\n    ollama pull ${effectiveModel}\n\n${remediation}`,
          );
          process.exit(2);
        }
      } catch (preflightErr) {
        // If the pre-flight check itself fails (e.g. network blip after the
        // isOllamaAvailable probe), don't block the run — fall through to the
        // bulk loop and let per-item failures handle it.
        const m = preflightErr instanceof Error ? preflightErr.message : String(preflightErr);
        warn(`Could not pre-flight check Ollama models (${m}); continuing anyway.`);
      }

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

      // Time-machine: caption snapshots are metadata-only (just the previous
      // alt text), so they're nearly free. Skip the session entirely in dry-run.
      const historyConfig = resolveHistoryConfig(config.history);
      const snapshotStore = openSnapshotStore(db, getConfigDir());
      const historySession =
        historyConfig.enabled && !isDryRun
          ? openHistorySession(snapshotStore, site.name, 'caption', {
              model: effectiveModel,
              language: options.language,
              overwrite: options.overwrite ?? false,
            })
          : null;

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

          // Ensure the attachment row exists before any recordProcessing call
          // (processing_history has a FK on attachments). This runs
          // unconditionally so failures during download / Ollama don't hit a
          // FK violation in the catch block. Mirrors the pattern in remove-bg.
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
            model: effectiveModel,
            prompt: options.prompt,
            ollamaUrl: options.ollamaUrl,
            language: options.language,
          });

          info(`    ✓ "${result.caption}" (${result.durationMs}ms)`);

          if (!isDryRun) {
            // Capture metadata-only snapshot (alt-text before-state) for undo.
            if (historySession) {
              captureSnapshot(snapshotStore, {
                siteName: site.name,
                sessionId: historySession.id,
                attachmentId: item.id,
                operation: 'caption',
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

          // Wrap in try/catch — if the failure happened before the
          // unconditional upsertAttachment (e.g. getMedia itself threw), the
          // FK on processing_history would otherwise crash the whole loop.
          // We'd rather lose the failure breadcrumb than abort the bulk run.
          try {
            db.recordProcessing({
              siteName: site.name,
              wpId: id,
              operation: 'caption',
              paramsJson: JSON.stringify({ model: effectiveModel }),
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
          } catch {
            // Best-effort breadcrumb; don't let it abort the loop.
          }
        }
      }

      if (historySession) {
        closeHistorySession(snapshotStore, historySession, {
          maxSizeBytes: historyConfig.maxSizeBytes,
        });
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
