/**
 * `localpress convert <ids> --to <format>` — convert image format.
 *
 * Converts attachments to webp, avif, jpeg, or png. Uses the same
 * replace-in-place fallback chain as optimize.
 */

import { createHash } from 'node:crypto';
import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import { CapabilityUnavailableError } from '../../adapters/types.ts';
import { optimizeImage } from '../../engine/image/optimize.ts';
import type { ImageFormat } from '../../engine/image/types.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

const VALID_FORMATS = new Set(['webp', 'avif', 'jpeg', 'png']);

export function registerConvertCommand(program: Command): void {
  program
    .command('convert <ids...>')
    .description('Convert attachments to a different format (webp, avif, jpeg, png)')
    .requiredOption('--to <format>', 'target format: webp, avif, jpeg, or png')
    .option('--quality <n>', 'quality value 0-100 (codec-specific)', (v) =>
      Number.parseInt(v, 10),
    )
    .option('--keep-original', 'upload as a new attachment instead of replacing')
    .action(async (idStrs: string[], options) => {
      const parentOpts = program.opts();
      const targetFormat = options.to as string;

      if (!VALID_FORMATS.has(targetFormat)) {
        error(`Invalid format '${targetFormat}'. Valid formats: ${[...VALID_FORMATS].join(', ')}`);
        process.exit(2);
      }

      const ids = idStrs.map((s) => Number.parseInt(s, 10));
      if (ids.some(Number.isNaN)) {
        error('All arguments must be valid attachment IDs (integers).');
        process.exit(2);
      }

      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const getAdapter = resolver.resolve('get');

      const db = SiteDb.init(getSiteDbPath(site.name));
      db.ensureSite(site.name, site.url);

      const results: Array<{ id: number; filename: string; from: string; to: string; savedBytes: number }> = [];
      let failures = 0;

      for (const id of ids) {
        const startTime = Date.now();
        try {
          const item = await getAdapter.getMedia(id);
          info(`  Converting #${id} (${item.filename}) → ${targetFormat}...`);

          // Download source.
          const response = await fetch(item.url);
          if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
          const sourceBytes = Buffer.from(await response.arrayBuffer());
          const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');

          // Convert.
          const result = await optimizeImage(sourceBytes, item.mimeType, {
            toFormat: targetFormat as ImageFormat,
            quality: options.quality,
            stripMetadata: true,
          });

          const resultHash = createHash('sha256').update(result.bytes).digest('hex');
          const durationMs = Date.now() - startTime;

          // Upload.
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
            const newFilename = item.filename.replace(/\.[^.]+$/, `.${targetFormat}`);
            const uploaded = await uploadAdapter.upload(result.bytes, {
              filename: newFilename,
              title: item.title,
              altText: item.altText,
            });
            resultWpId = uploaded.id;
            if (!options.keepOriginal) {
              warn(`    ⚠ Uploaded as new attachment #${resultWpId} (in-place replacement not available).`);
            }
          }

          const saved = sourceBytes.length - result.bytes.length;
          info(
            `    ✓ ${item.mimeType} → image/${targetFormat}  ` +
              `${formatBytes(sourceBytes.length)} → ${formatBytes(result.bytes.length)} (${durationMs}ms)`,
          );

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
            operation: 'convert',
            paramsJson: JSON.stringify({ toFormat: targetFormat, quality: options.quality }),
            sourceHash,
            resultHash,
            bytesBefore: sourceBytes.length,
            bytesAfter: result.bytes.length,
            resultWpId: resultWpId !== item.id ? resultWpId : null,
            ranAt: Date.now(),
            durationMs,
            status: 'success',
            errorMessage: null,
          });

          results.push({
            id: item.id,
            filename: item.filename,
            from: item.mimeType,
            to: `image/${targetFormat}`,
            savedBytes: saved,
          });
        } catch (err) {
          error(`    ✗ #${id}: ${err instanceof Error ? err.message : String(err)}`);
          failures++;
        }
      }

      db.close();

      if (parentOpts.json) {
        printJson({ converted: results.length, failures, results });
      } else if (results.length > 0) {
        const totalSaved = results.reduce((sum, r) => sum + r.savedBytes, 0);
        info(`\n  Done: ${results.length} converted, ${failures} failed. Saved ${formatBytes(totalSaved)}.`);
      }

      if (failures > 0) process.exit(1);
    });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
