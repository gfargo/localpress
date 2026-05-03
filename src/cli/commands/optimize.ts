/**
 * `localpress optimize <ids|--all|--unoptimized>` — the marquee v0.1 command.
 *
 * Behavior decisions (locked in conversation):
 *   - Bulk operations (--all, --unoptimized) are SAFE BY DEFAULT (dry-run).
 *     User must pass --apply to execute.
 *   - Explicit IDs (e.g. `optimize 123 124 125`) execute immediately —
 *     the user said which IDs, so they meant it.
 *   - Replace-in-place is the DEFAULT. Falls back to new-attachment +
 *     references report if WP-CLI / Enable Media Replace plugin aren't
 *     available, unless --strict is set.
 */

import { createHash } from 'node:crypto';
import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { MediaItem } from '../../adapters/types.ts';
import { CapabilityUnavailableError } from '../../adapters/types.ts';
import { optimizeImage } from '../../engine/image/optimize.ts';
import type { ImageFormat, OptimizeOptions } from '../../engine/image/types.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

interface OptimizeResultRecord {
  id: number;
  filename: string;
  bytesBefore: number;
  bytesAfter: number;
  savedBytes: number;
  savedRatio: number;
  resultWpId: number | null;
  durationMs: number;
  appliedSteps: string[];
}

export function registerOptimizeCommand(program: Command): void {
  program
    .command('optimize [ids...]')
    .description('Compress (and optionally convert) media. Use IDs, --all, or --unoptimized.')
    .option('--all', 'process every attachment in the library (dry-run unless --apply)')
    .option(
      '--unoptimized',
      "process only attachments localpress hasn't seen yet (dry-run unless --apply)",
    )
    .option('--larger-than <bytes>', 'only attachments larger than this (works with --all)', (v) =>
      Number.parseInt(v, 10),
    )
    .option(
      '--to <format>',
      'convert during optimization: webp, avif, or jpeg (defaults to source format)',
    )
    .option(
      '--mode <mode>',
      'compression mode: lossy or lossless (default: lossy for jpeg/webp/avif, lossless for png)',
    )
    .option('--quality <n>', '0-100 quality value (codec-specific)', (v) => Number.parseInt(v, 10))
    .option(
      '--no-replace-in-place',
      'always upload as a new attachment, never attempt true replacement',
    )
    .option('--keep-original', 'do not replace; save the optimized copy as a separate attachment')
    .option(
      '--encoder <backend>',
      'encoder: sharp (default) or jsquash (WASM codecs, better PNG via OxiPNG)',
      'sharp',
    )
    .option('--preview', 'open a browser preview to adjust settings before applying')
    .option('--preview-port <port>', 'port for the preview server (default: auto)', (v) =>
      Number.parseInt(v, 10),
    )
    .action(async (idStrs: string[], options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const adapter = resolver.resolve('list');

      const hasExplicitIds = idStrs.length > 0;
      const isBulk = options.all || options.unoptimized;

      if (!hasExplicitIds && !isBulk) {
        error(
          'Specify attachment IDs, or use --all / --unoptimized for bulk operations.\n' +
            'Example: localpress optimize 123 124 125\n' +
            'Example: localpress optimize --unoptimized --apply',
        );
        process.exit(2);
      }

      // --preview: open a browser-based preview for a single attachment.
      if (options.preview) {
        if (!hasExplicitIds || idStrs.length !== 1) {
          error(
            '--preview requires exactly one attachment ID.\nExample: localpress optimize 123 --preview',
          );
          process.exit(2);
        }
        const id = Number.parseInt(idStrs[0], 10);
        if (Number.isNaN(id)) {
          error('Invalid attachment ID.');
          process.exit(2);
        }

        const getAdapter = resolver.resolve('get');
        info(`  Fetching attachment #${id}...`);
        const item = await getAdapter.getMedia(id);

        const response = await fetch(item.url);
        if (!response.ok) {
          error(`Failed to download image: ${response.status}`);
          process.exit(4);
        }
        const sourceBytes = Buffer.from(await response.arrayBuffer());

        const { startPreviewServer } = await import('../../engine/preview/server.ts');
        const { buildOptimizeHtml } = await import('../../engine/preview/ui-optimize.ts');
        type ProcessResult = import('../../engine/preview/server.ts').ProcessResult;
        type ApplyResult = import('../../engine/preview/server.ts').ApplyResult;

        info(`  Starting preview for #${id} (${item.filename})...`);

        const { applied, result } = await startPreviewServer({
          port: options.previewPort ?? 0,
          sourceBytes,
          filename: item.filename,
          mimeType: item.mimeType,
          width: item.width,
          height: item.height,
          wpId: id,
          mode: 'optimize',
          html: buildOptimizeHtml(),
          onProcess: async (params): Promise<ProcessResult> => {
            const opts: OptimizeOptions = {
              toFormat:
                typeof params.toFormat === 'string' ? (params.toFormat as ImageFormat) : undefined,
              quality: typeof params.quality === 'number' ? params.quality : undefined,
              maxWidth: typeof params.maxWidth === 'number' ? params.maxWidth : undefined,
              maxHeight: typeof params.maxHeight === 'number' ? params.maxHeight : undefined,
              encoder: params.encoder === 'jsquash' ? 'jsquash' : 'sharp',
              stripMetadata: true,
            };
            const optResult = await optimizeImage(sourceBytes, item.mimeType, opts);
            const mimeType =
              optResult.after.format === 'webp'
                ? 'image/webp'
                : optResult.after.format === 'avif'
                  ? 'image/avif'
                  : optResult.after.format === 'png'
                    ? 'image/png'
                    : 'image/jpeg';
            return {
              bytes: optResult.bytes,
              mimeType,
              stats: {
                before: optResult.before,
                after: optResult.after,
                savedBytes: optResult.savedBytes,
                savedRatio: optResult.savedRatio,
                appliedSteps: optResult.appliedSteps,
              },
            };
          },
          onApply: async (resultBytes): Promise<ApplyResult> => {
            const db = SiteDb.init(getSiteDbPath(site.name));
            db.ensureSite(site.name, site.url);

            const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
            const resultHash = createHash('sha256').update(resultBytes).digest('hex');

            let resultWpId: number | null = null;

            if (!options.keepOriginal && options.replaceInPlace !== false) {
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
              const newFilename = item.filename.replace(/\.[^.]+$/, '-optimized.webp');
              const uploaded = await uploadAdapter.upload(resultBytes, {
                filename: newFilename,
                title: item.title,
                altText: item.altText,
              });
              resultWpId = uploaded.id;
            }

            recordSuccess(db, site.name, item, sourceHash, resultHash, {}, 0, {
              bytesBefore: sourceBytes.length,
              bytesAfter: resultBytes.length,
              resultWpId: resultWpId !== item.id ? resultWpId : null,
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

      // Determine if this is a dry-run.
      const isDryRun = isBulk && !parentOpts.apply;

      // Resolve target items.
      let items: MediaItem[] = [];

      if (hasExplicitIds) {
        const ids = idStrs.map((s) => Number.parseInt(s, 10));
        if (ids.some(Number.isNaN)) {
          error('All arguments must be valid attachment IDs (integers).');
          process.exit(2);
        }
        const getAdapter = resolver.resolve('get');
        for (const id of ids) {
          try {
            items.push(await getAdapter.getMedia(id));
          } catch (err) {
            error(
              `Failed to fetch attachment #${id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } else {
        // Bulk: fetch all media.
        let page = 1;
        while (true) {
          try {
            const batch = await adapter.listMedia({ perPage: 100, page });
            if (batch.length === 0) break;
            items = items.concat(batch);
            if (batch.length < 100) break;
            page++;
          } catch (err) {
            error(err instanceof Error ? err.message : String(err));
            process.exit(4);
            return;
          }
        }

        // Apply --larger-than filter.
        if (options.largerThan) {
          items = items.filter((item) => (item.sizeBytes ?? 0) >= options.largerThan);
        }

        // Apply --unoptimized filter.
        if (options.unoptimized) {
          try {
            const db = SiteDb.init(getSiteDbPath(site.name));
            const processed = db.listProcessedWpIds(site.name);
            items = items.filter((item) => !processed.has(item.id));
            db.close();
          } catch {
            // DB doesn't exist yet — all items are unoptimized.
          }
        }

        // Only process images.
        items = items.filter((item) => item.mimeType?.startsWith('image/'));
      }

      if (items.length === 0) {
        info('No items to optimize.');
        return;
      }

      // Dry-run mode: just report what would happen.
      if (isDryRun) {
        info(`Dry-run: would optimize ${items.length} item(s). Pass --apply to execute.\n`);
        for (const item of items.slice(0, 20)) {
          const size = item.sizeBytes ? formatBytes(item.sizeBytes) : '?';
          info(`  #${item.id}  ${item.filename}  ${size}`);
        }
        if (items.length > 20) {
          info(`  ... and ${items.length - 20} more`);
        }
        if (parentOpts.json) {
          printJson({
            dryRun: true,
            count: items.length,
            items: items.map((i) => ({ id: i.id, filename: i.filename, sizeBytes: i.sizeBytes })),
          });
        }
        return;
      }

      // Build optimization options.
      const optimizeOpts: OptimizeOptions = {
        toFormat: options.to as ImageFormat | undefined,
        mode: options.mode,
        quality: options.quality,
        stripMetadata: true,
        encoder: options.encoder === 'jsquash' ? 'jsquash' : 'sharp',
      };

      // Open the site DB for recording processing history.
      const db = SiteDb.init(getSiteDbPath(site.name));
      db.ensureSite(site.name, site.url);

      const results: OptimizeResultRecord[] = [];
      let failures = 0;

      for (const item of items) {
        const startTime = Date.now();
        try {
          info(`  Processing #${item.id} (${item.filename})...`);

          // 1. Download the source image.
          const response = await fetch(item.url);
          if (!response.ok) {
            throw new Error(`Failed to download ${item.url}: ${response.status}`);
          }
          const sourceBytes = Buffer.from(await response.arrayBuffer());
          const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');

          // Check idempotency: skip if source hasn't changed since last processing.
          const lastProcessing = db.getLastProcessing(site.name, item.id, 'optimize');
          if (lastProcessing?.sourceHash === sourceHash && lastProcessing.status === 'success') {
            info('    ↳ Skipped (source unchanged since last optimization).');
            continue;
          }

          // 2. Process through the image engine.
          const result = await optimizeImage(sourceBytes, item.mimeType, optimizeOpts);
          const resultHash = createHash('sha256').update(result.bytes).digest('hex');
          const durationMs = Date.now() - startTime;

          // Skip if the result is larger than the source (unless format conversion was requested).
          if (result.bytes.length >= sourceBytes.length && !options.to) {
            info(
              `    ↳ Skipped (optimized size ${formatBytes(result.bytes.length)} ≥ original ${formatBytes(sourceBytes.length)}).`,
            );

            // Record as success so we don't re-process.
            recordSuccess(db, site.name, item, sourceHash, sourceHash, optimizeOpts, durationMs, {
              bytesBefore: sourceBytes.length,
              bytesAfter: sourceBytes.length,
              resultWpId: null,
            });
            continue;
          }

          // 3. Upload the result.
          let resultWpId: number | null = null;

          if (!options.keepOriginal && options.replaceInPlace !== false) {
            // Try replace-in-place.
            const replaceAdapter = resolver.tryResolve('replace-in-place');
            if (replaceAdapter) {
              try {
                await replaceAdapter.replaceInPlace(item.id, result.bytes);
                resultWpId = item.id;
              } catch (err) {
                if (err instanceof CapabilityUnavailableError) {
                  if (parentOpts.strict) throw err;
                  // Fall through to new-attachment upload.
                } else {
                  throw err;
                }
              }
            }
          }

          if (resultWpId === null) {
            // Upload as new attachment (fallback or --keep-original).
            const uploadAdapter = resolver.resolve('upload');
            const ext = result.after.format ? `.${result.after.format}` : '';
            const newFilename = `${item.filename.replace(/\.[^.]+$/, '')}-optimized${ext}`;
            const uploaded = await uploadAdapter.upload(result.bytes, {
              filename: newFilename,
              title: item.title,
              altText: item.altText,
            });
            resultWpId = uploaded.id;

            if (!options.keepOriginal) {
              warn(
                `    ⚠ Uploaded as new attachment #${resultWpId} (in-place replacement not available).`,
              );
            }
          }

          info(
            `    ✓ ${formatBytes(result.before.sizeBytes)} → ${formatBytes(result.after.sizeBytes)} ` +
              `(${(result.savedRatio * 100).toFixed(1)}% reduction, ${durationMs}ms)`,
          );
          if (result.appliedSteps.length > 0) {
            info(`      Steps: ${result.appliedSteps.join(' → ')}`);
          }

          // 4. Record in SQLite.
          recordSuccess(db, site.name, item, sourceHash, resultHash, optimizeOpts, durationMs, {
            bytesBefore: sourceBytes.length,
            bytesAfter: result.bytes.length,
            resultWpId: resultWpId !== item.id ? resultWpId : null,
          });

          // 5. Mirror to WP post meta (best-effort).
          try {
            const metaAdapter = resolver.tryResolve('update-meta');
            if (metaAdapter) {
              await metaAdapter.updateMetadata(item.id, {
                // WP REST API doesn't support arbitrary meta keys directly,
                // but we can store optimization info in the description field
                // as a structured comment. Full post-meta mirror is v0.5.
              });
            }
          } catch {
            // Best-effort; don't fail the operation over a meta update.
          }

          results.push({
            id: item.id,
            filename: item.filename,
            bytesBefore: result.before.sizeBytes,
            bytesAfter: result.after.sizeBytes,
            savedBytes: result.savedBytes,
            savedRatio: result.savedRatio,
            resultWpId,
            durationMs,
            appliedSteps: result.appliedSteps,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          error(`    ✗ #${item.id}: ${message}`);
          failures++;

          // Record failure.
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
          db.recordProcessing({
            siteName: site.name,
            wpId: item.id,
            operation: 'optimize',
            paramsJson: JSON.stringify(optimizeOpts),
            sourceHash: null,
            resultHash: null,
            bytesBefore: item.sizeBytes ?? null,
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

      // Summary.
      if (parentOpts.json) {
        const totalSaved = results.reduce((sum, r) => sum + r.savedBytes, 0);
        printJson({
          processed: results.length,
          failures,
          totalSavedBytes: totalSaved,
          results,
        });
      } else if (results.length > 0) {
        const totalSaved = results.reduce((sum, r) => sum + r.savedBytes, 0);
        info(`\n  Done: ${results.length} optimized, ${failures} failed.`);
        info(`  Total saved: ${formatBytes(totalSaved)}`);
      }

      if (failures > 0) {
        process.exit(1);
      }
    });
}

// -- Helpers ------------------------------------------------------------------

function recordSuccess(
  db: SiteDb,
  siteName: string,
  item: MediaItem,
  sourceHash: string,
  resultHash: string,
  opts: OptimizeOptions,
  durationMs: number,
  sizes: { bytesBefore: number; bytesAfter: number; resultWpId: number | null },
): void {
  db.upsertAttachment({
    siteName,
    wpId: item.id,
    sourceUrl: item.url,
    sourceHash,
    sizeBytes: sizes.bytesBefore,
    width: item.width ?? null,
    height: item.height ?? null,
    mimeType: item.mimeType,
    lastSeenAt: Date.now(),
  });
  db.recordProcessing({
    siteName,
    wpId: item.id,
    operation: 'optimize',
    paramsJson: JSON.stringify(opts),
    sourceHash,
    resultHash,
    bytesBefore: sizes.bytesBefore,
    bytesAfter: sizes.bytesAfter,
    resultWpId: sizes.resultWpId,
    ranAt: Date.now(),
    durationMs,
    status: 'success',
    errorMessage: null,
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
