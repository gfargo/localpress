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
import type { ModelName } from '../../engine/rembg/models.ts';
import { DEFAULT_MODEL, isModelCached, listAvailableModels } from '../../engine/rembg/models.ts';
import { removeBackground } from '../../engine/rembg/remove-bg.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

export function registerRemoveBgCommand(program: Command): void {
  program
    .command('remove-bg [ids...]')
    .description('Remove backgrounds from images using local AI (U2-Net)')
    .option(
      '--model <name>',
      `model to use: ${listAvailableModels().map((m) => m.name).join(', ')} (default: ${DEFAULT_MODEL})`,
      DEFAULT_MODEL,
    )
    .option('--bg <color>', 'background color instead of transparency (hex, e.g. #ffffff)')
    .option('--trim', 'trim transparent borders from the output')
    .option('--keep-original', 'upload as a new attachment instead of replacing')
    .option('--list-models', 'show available models and exit')
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

          // Download source image.
          const response = await fetch(item.url);
          if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
          const sourceBytes = Buffer.from(await response.arrayBuffer());
          const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');

          // Run background removal.
          const result = await removeBackground(sourceBytes, {
            model: modelName,
            trim: options.trim,
            backgroundColor: options.bg,
            onProgress: (msg) => info(`    ${msg}`),
          });

          const resultHash = createHash('sha256').update(result.bytes).digest('hex');

          info(
            `    ✓ Background removed (${result.inferenceMs}ms inference, ${result.totalMs}ms total)`,
          );

          // Upload the result.
          let resultWpId: number | null = null;

          if (!options.keepOriginal) {
            const replaceAdapter = resolver.tryResolve('replace-in-place');
            if (replaceAdapter) {
              try {
                await replaceAdapter.replaceInPlace(id, result.bytes);
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
            const uploaded = await uploadAdapter.upload(result.bytes, {
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
            bytesAfter: result.bytes.length,
            resultWpId: resultWpId !== item.id ? resultWpId : null,
            ranAt: Date.now(),
            durationMs: result.totalMs,
            status: 'success',
            errorMessage: null,
          });

          results.push({
            id: item.id,
            filename: item.filename,
            model: modelName,
            inferenceMs: result.inferenceMs,
            totalMs: result.totalMs,
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
