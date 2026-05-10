/**
 * `localpress remove-bg <ids>` — AI background removal using local compute.
 *
 * Uses ONNX Runtime + U2-Net to detect and remove backgrounds from images.
 * The model is downloaded on first use (~176MB for u2net, ~4.7MB for u2netp)
 * and cached locally.
 *
 * Output is always PNG (to preserve the alpha channel). The original
 * attachment is replaced in place if WP-CLI is available, otherwise
 * uploaded as a new attachment with the standard fallback chain.
 */

import { createHash } from 'node:crypto';
import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import { CapabilityUnavailableError } from '../../adapters/types.ts';
import type { ApplyResult, ProcessResult } from '../../engine/preview/server.ts';
import type { ModelName } from '../../engine/rembg/models.ts';
import { DEFAULT_MODEL, isModelCached, listAvailableModels } from '../../engine/rembg/models.ts';
import { removeBackground } from '../../engine/rembg/remove-bg.ts';
import {
  isSystemRembgAvailable,
  removeBackgroundWithSystemRembg,
} from '../../engine/rembg/system-rembg.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

export function registerRemoveBgCommand(program: Command): void {
  program
    .command('remove-bg [ids...]')
    .description('Remove backgrounds from images using local AI (U2-Net)')
    .option(
      '--model <name>',
      `model to use: ${listAvailableModels()
        .map((m) => m.name)
        .join(', ')} (default: ${DEFAULT_MODEL})`,
      DEFAULT_MODEL,
    )
    .option('--bg <color>', 'background color instead of transparency (hex, e.g. #ffffff)')
    .option('--trim', 'trim transparent borders from the output')
    .option('--keep-original', 'upload as a new attachment instead of replacing')
    .option('--list-models', 'show available models and exit')
    .option('--rembg', 'use system Python rembg instead of built-in ONNX pipeline')
    .option('--rembg-model <name>', 'model name for system rembg (e.g. isnet-general-use)')
    .option('--preview', 'open a browser preview to adjust settings before applying')
    .option('--preview-port <port>', 'port for the preview server (default: auto)', (v) =>
      Number.parseInt(v, 10),
    )
    .action(async (idStrs: string[], options) => {
      const parentOpts = program.opts();

      // --list-models: show available models and exit.
      if (options.listModels) {
        const models = listAvailableModels();
        if (parentOpts.json) {
          printJson(
            models.map((m) => ({
              ...m,
              cached: isModelCached(m.name),
            })),
          );
        } else {
          info('Available background removal models:\n');
          for (const m of models) {
            const cached = isModelCached(m.name) ? ' (cached)' : '';
            info(`  ${m.name}  ${m.sizeApprox}  ${m.license}${cached}`);
          }
          info(`\nDefault: ${DEFAULT_MODEL}`);
        }
        return;
      }

      // Preload sharp (with auto-install prompt if missing).
      // Skip for --rembg mode since that uses system Python, not sharp.
      if (!options.rembg) {
        try {
          const { loadSharpWithPrompt } = await import('../../engine/image/sharp-loader.ts');
          await loadSharpWithPrompt({
            autoYes: Boolean(parentOpts.yes),
            noPrompt: Boolean(parentOpts.json) || Boolean(parentOpts.quiet),
          });
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      }

      // --preview: open a browser-based preview for a single attachment.
      if (options.preview) {
        const ids = idStrs.map((s) => Number.parseInt(s, 10));
        if (ids.length !== 1) {
          error(
            '--preview requires exactly one attachment ID.\nExample: localpress remove-bg 123 --preview',
          );
          process.exit(2);
        }
        const [id] = ids;
        if (Number.isNaN(id)) {
          error('Invalid attachment ID.');
          process.exit(2);
        }

        const config = await loadConfig();
        const site = resolveActiveSite(config, parentOpts.site);
        const resolver = new AdapterResolver(site);
        const getAdapter = resolver.resolve('get');

        info(`  Fetching attachment #${id}...`);
        const item = await getAdapter.getMedia(id);

        // Download source image.
        const response = await fetch(item.url);
        if (!response.ok) {
          error(`Failed to download image: ${response.status}`);
          process.exit(4);
        }
        const sourceBytes = Buffer.from(await response.arrayBuffer());

        // Lazy-load preview server and UI.
        const { startPreviewServer } = await import('../../engine/preview/server.ts');
        const { buildRemoveBgHtml } = await import('../../engine/preview/ui-remove-bg.ts');

        info(`  Starting preview for #${id} (${item.filename})...`);

        const { applied, result } = await startPreviewServer({
          port: options.previewPort ?? 0,
          sourceBytes,
          filename: item.filename,
          mimeType: item.mimeType,
          width: item.width,
          height: item.height,
          wpId: id,
          mode: 'remove-bg',
          html: buildRemoveBgHtml(),
          onProcess: async (params): Promise<ProcessResult> => {
            const model = (params.model as ModelName) ?? 'u2net';
            const alphaThreshold =
              typeof params.alphaThreshold === 'number' ? params.alphaThreshold : 10;
            const trim = params.trim === true;
            const backgroundColor =
              typeof params.backgroundColor === 'string' ? params.backgroundColor : undefined;

            const bgResult = await removeBackground(sourceBytes, {
              model,
              trim,
              backgroundColor,
              alphaThreshold,
              onProgress: (msg) => info(`    ${msg}`),
            });

            return {
              bytes: bgResult.bytes,
              mimeType: 'image/png',
              stats: {
                model: bgResult.model,
                inferenceMs: bgResult.inferenceMs,
                totalMs: bgResult.totalMs,
                width: bgResult.width,
                height: bgResult.height,
              },
            };
          },
          onApply: async (resultBytes, _resultMimeType): Promise<ApplyResult> => {
            const db = SiteDb.init(getSiteDbPath(site.name));
            db.ensureSite(site.name, site.url);

            const sourceHash = (await import('node:crypto'))
              .createHash('sha256')
              .update(sourceBytes)
              .digest('hex');
            const resultHash = (await import('node:crypto'))
              .createHash('sha256')
              .update(resultBytes)
              .digest('hex');

            // Ensure attachment row exists.
            db.upsertAttachment({
              siteName: site.name,
              wpId: item.id,
              sourceUrl: item.url,
              sourceHash,
              sizeBytes: sourceBytes.length,
              width: item.width ?? null,
              height: item.height ?? null,
              mimeType: item.mimeType,
              lastSeenAt: Date.now(),
            });

            let resultWpId: number | null = null;

            if (!options.keepOriginal) {
              const replaceAdapter = resolver.tryResolve('replace-in-place');
              if (replaceAdapter) {
                try {
                  await replaceAdapter.replaceInPlace(id, resultBytes);
                  resultWpId = id;
                } catch (err) {
                  if (!(err instanceof CapabilityUnavailableError) || parentOpts.strict) {
                    throw err;
                  }
                }
              }
            }

            if (resultWpId === null) {
              const uploadAdapter = resolver.resolve('upload');
              const newFilename = item.filename.replace(/\.[^.]+$/, '-nobg.png');
              const uploaded = await uploadAdapter.upload(resultBytes, {
                filename: newFilename,
                title: `${item.title} (background removed)`,
                altText: item.altText,
              });
              resultWpId = uploaded.id;
            }

            // Record in SQLite.
            db.recordProcessing({
              siteName: site.name,
              wpId: item.id,
              operation: 'remove-bg',
              paramsJson: JSON.stringify({ model: 'u2net', preview: true }),
              sourceHash,
              resultHash,
              bytesBefore: sourceBytes.length,
              bytesAfter: resultBytes.length,
              resultWpId: resultWpId !== item.id ? resultWpId : null,
              ranAt: Date.now(),
              durationMs: 0,
              status: 'success',
              errorMessage: null,
            });

            db.close();
            return { wpId: resultWpId, message: `Uploaded as #${resultWpId}` };
          },
        });

        if (applied && result) {
          info(`  ✓ Applied: uploaded to WordPress as #${result.wpId}`);
        } else {
          info('  Preview cancelled.');
        }
        return;
      }

      const ids = idStrs.map((s) => Number.parseInt(s, 10));
      if (ids.length === 0) {
        error('Specify one or more attachment IDs.\nExample: localpress remove-bg 123 124 125');
        process.exit(2);
      }
      if (ids.some(Number.isNaN)) {
        error('All arguments must be valid attachment IDs (integers).');
        process.exit(2);
      }

      const modelName = options.model as ModelName;
      const validModels = listAvailableModels().map((m) => m.name);
      if (!validModels.includes(modelName)) {
        error(`Unknown model '${modelName}'. Available: ${validModels.join(', ')}`);
        process.exit(2);
      }

      // Check --rembg flag.
      const useSystemRembg = options.rembg === true;
      if (useSystemRembg) {
        const available = await isSystemRembgAvailable();
        if (!available) {
          error(
            'System rembg is not installed or not in PATH.\n' +
              'Install it with: pip install rembg[cli]\n' +
              'Or omit --rembg to use the built-in ONNX pipeline.',
          );
          process.exit(2);
        }
        info('  Using system Python rembg.');
      }

      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const getAdapter = resolver.resolve('get');

      const db = SiteDb.init(getSiteDbPath(site.name));
      db.ensureSite(site.name, site.url);

      const results: Array<{
        id: number;
        filename: string;
        model: string;
        inferenceMs: number;
        totalMs: number;
        resultWpId: number | null;
      }> = [];
      let failures = 0;

      for (const id of ids) {
        const startTime = Date.now();
        try {
          const item = await getAdapter.getMedia(id);
          info(`  Processing #${id} (${item.filename})...`);

          // Ensure the attachment row exists before any recordProcessing call
          // (processing_history has a FK on attachments). This runs unconditionally
          // so failures during model download / inference don't hit a FK violation.
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

          // Download source image.
          const response = await fetch(item.url);
          if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
          const sourceBytes = Buffer.from(await response.arrayBuffer());
          const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');

          // Run background removal.
          let resultBytes: Buffer;
          let inferenceMs: number;
          let totalMs: number;

          if (useSystemRembg) {
            const sysResult = await removeBackgroundWithSystemRembg(sourceBytes, {
              model: options.rembgModel,
            });
            resultBytes = sysResult.bytes;
            inferenceMs = sysResult.durationMs;
            totalMs = sysResult.durationMs;
          } else {
            const result = await removeBackground(sourceBytes, {
              model: modelName,
              trim: options.trim,
              backgroundColor: options.bg,
              onProgress: (msg) => info(`    ${msg}`),
            });
            resultBytes = result.bytes;
            inferenceMs = result.inferenceMs;
            totalMs = result.totalMs;
          }

          const resultHash = createHash('sha256').update(resultBytes).digest('hex');

          info(
            `    ✓ Background removed (${inferenceMs}ms${useSystemRembg ? ' via system rembg' : ''})`,
          );

          // Upload the result.
          let resultWpId: number | null = null;

          if (!options.keepOriginal) {
            const replaceAdapter = resolver.tryResolve('replace-in-place');
            if (replaceAdapter) {
              try {
                await replaceAdapter.replaceInPlace(id, resultBytes);
                resultWpId = id;
              } catch (err) {
                if (err instanceof CapabilityUnavailableError && !parentOpts.strict) {
                  // Fall through.
                } else if (err instanceof CapabilityUnavailableError) {
                  throw err;
                } else {
                  throw err;
                }
              }
            }
          }

          if (resultWpId === null) {
            const uploadAdapter = resolver.resolve('upload');
            const newFilename = item.filename.replace(/\.[^.]+$/, '-nobg.png');
            const uploaded = await uploadAdapter.upload(resultBytes, {
              filename: newFilename,
              title: `${item.title} (background removed)`,
              altText: item.altText,
            });
            resultWpId = uploaded.id;
            if (!options.keepOriginal) {
              warn(
                `    ⚠ Uploaded as new attachment #${resultWpId} (in-place replacement not available).`,
              );
            }
          }

          // Record in SQLite.
          db.upsertAttachment({
            siteName: site.name,
            wpId: item.id,
            sourceUrl: item.url,
            sourceHash,
            sizeBytes: sourceBytes.length,
            width: item.width ?? null,
            height: item.height ?? null,
            mimeType: item.mimeType,
            lastSeenAt: Date.now(),
          });
          db.recordProcessing({
            siteName: site.name,
            wpId: item.id,
            operation: 'remove-bg',
            paramsJson: JSON.stringify({
              model: modelName,
              trim: options.trim ?? false,
              backgroundColor: options.bg ?? null,
            }),
            sourceHash,
            resultHash,
            bytesBefore: sourceBytes.length,
            bytesAfter: resultBytes.length,
            resultWpId: resultWpId !== item.id ? resultWpId : null,
            ranAt: Date.now(),
            durationMs: totalMs,
            status: 'success',
            errorMessage: null,
          });

          results.push({
            id: item.id,
            filename: item.filename,
            model: useSystemRembg ? `rembg:${options.rembgModel ?? 'default'}` : modelName,
            inferenceMs,
            totalMs,
            resultWpId,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          error(`    ✗ #${id}: ${message}`);
          failures++;

          db.recordProcessing({
            siteName: site.name,
            wpId: id,
            operation: 'remove-bg',
            paramsJson: JSON.stringify({ model: modelName }),
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
        printJson({ processed: results.length, failures, results });
      } else if (results.length > 0) {
        info(`\n  Done: ${results.length} processed, ${failures} failed.`);
      }

      if (failures > 0) process.exit(1);
    });
}
