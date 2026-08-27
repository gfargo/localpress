/**
 * `localpress resize <ids> --max-width N` — resize attachments.
 *
 * Resizes images while preserving aspect ratio. If WP-CLI is available,
 * also regenerates WordPress thumbnail sizes after replacement.
 */

import { createHash } from 'node:crypto';
import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import { CapabilityUnavailableError } from '../../adapters/types.ts';
import {
  captureSnapshot,
  closeHistorySession,
  openHistorySession,
  openSnapshotStore,
  resolveHistoryConfig,
} from '../../engine/history/index.ts';
import { formatToMime } from '../../engine/image/mime.ts';
import {
  AnimatedImageError,
  UnsupportedFormatError,
  optimizeImage,
} from '../../engine/image/optimize.ts';
import { downloadToBuffer, isImageContentType } from '../../engine/network/download.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { parseIntOption, parsePositiveIntOption } from '../utils/args.ts';
import { forEachConcurrent, resolveConcurrency, sortResultsById } from '../utils/concurrency.ts';
import { getConfigDir, getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { parseAttachmentIds } from '../utils/ids.ts';
import { error, info, printJson, warn } from '../utils/output.ts';
import { dryRunPayload, resolveDryRun } from '../utils/run-mode.ts';

export function registerResizeCommand(program: Command): void {
  program
    .command('resize <ids...>')
    .description('Resize attachments, preserving aspect ratio')
    .option('--max-width <n>', 'maximum width in pixels', parsePositiveIntOption('--max-width'))
    .option('--max-height <n>', 'maximum height in pixels', parsePositiveIntOption('--max-height'))
    .option('--quality <n>', 'quality value 0-100', parseIntOption('--quality'))
    .option('--keep-original', 'upload as a new attachment instead of replacing')
    .action(async (idStrs: string[], options) => {
      const parentOpts = program.opts();

      if (!options.maxWidth && !options.maxHeight) {
        error('At least one of --max-width or --max-height is required.');
        process.exit(2);
      }

      const ids = parseAttachmentIds(idStrs);

      const isDryRun = resolveDryRun(parentOpts, false);
      if (isDryRun) {
        info(`Dry-run: would resize ${ids.length} attachment(s). Omit --dry-run to execute.`);
        if (parentOpts.json) {
          printJson(
            dryRunPayload(
              { operation: 'resize', count: ids.length, items: ids.map((id) => ({ id })) },
              { count: ids.length, ids },
            ),
          );
        }
        return;
      }

      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const getAdapter = resolver.resolve('get');
      const replaceAdapter = options.keepOriginal ? null : resolver.tryResolve('replace-in-place');
      const { effective: concurrency } = resolveConcurrency(
        parentOpts.concurrency,
        config.defaults?.concurrency,
      );

      // Preload sharp (with auto-install prompt if missing).
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

      const db = SiteDb.init(getSiteDbPath(site.name));
      db.ensureSite(site.name, site.url);

      // An explicit --keep-original run needs no undo snapshot. Automatic
      // REST fallback still records one so `undo` can offer partial recovery.
      const historyConfig = resolveHistoryConfig(config.history);
      const snapshotStore = openSnapshotStore(db, getConfigDir());
      const historySession =
        historyConfig.enabled && !options.keepOriginal
          ? openHistorySession(snapshotStore, site.name, 'resize', {
              maxWidth: options.maxWidth,
              maxHeight: options.maxHeight,
              quality: options.quality,
              keepOriginal: options.keepOriginal ?? false,
            })
          : null;

      const results: Array<{
        id: number;
        filename: string;
        fromDims: string;
        toDims: string;
        savedBytes: number;
      }> = [];
      let failures = 0;
      let skipped = 0;

      await forEachConcurrent(ids, concurrency, async (id) => {
        const startTime = Date.now();
        try {
          const item = await getAdapter.getMedia(id);
          const dims = item.width && item.height ? `${item.width}×${item.height}` : 'unknown';
          info(`  Resizing #${id} (${item.filename}, ${dims})...`);

          // Download source.
          const { bytes: sourceBytes, sha256: sourceHash } = await downloadToBuffer(item.url, {
            expectedContentType: isImageContentType,
          });

          // Resize.
          const result = await optimizeImage(sourceBytes, item.mimeType, {
            maxWidth: options.maxWidth,
            maxHeight: options.maxHeight,
            quality: options.quality,
            stripMetadata: true,
          });

          const resultHash = createHash('sha256').update(result.bytes).digest('hex');
          const durationMs = Date.now() - startTime;
          const newDims = `${result.after.width}×${result.after.height}`;

          // Capture pre-write snapshot for undo.
          if (historySession) {
            captureSnapshot(snapshotStore, {
              siteName: site.name,
              sessionId: historySession.id,
              attachmentId: item.id,
              operation: 'resize',
              sourceBytes,
              beforeHash: sourceHash,
              beforeMeta: {
                filename: item.filename,
                mimeType: item.mimeType,
                altText: item.altText,
                title: item.title,
                caption: item.caption,
                description: item.description,
                width: item.width,
                height: item.height,
                sizeBytes: sourceBytes.length,
              },
            });
          }

          // Upload.
          let resultWpId: number | null = null;

          if (replaceAdapter) {
            try {
              await replaceAdapter.replaceInPlace(id, result.bytes);
              resultWpId = id;

              // Regenerate thumbnails if WP-CLI is available.
              const regenAdapter = resolver.tryResolve('regenerate-thumbnails');
              if (regenAdapter) {
                try {
                  await regenAdapter.regenerateThumbnails(id);
                  info('      ↳ Thumbnails regenerated.');
                } catch {
                  warn('      ↳ Could not regenerate thumbnails.');
                }
              }
            } catch (err) {
              if (err instanceof CapabilityUnavailableError && !parentOpts.strict) {
                // Fall through.
              } else {
                throw err;
              }
            }
          }

          if (resultWpId === null) {
            const uploadAdapter = resolver.resolve('upload');
            const newFilename = item.filename.replace(
              /\.[^.]+$/,
              `-resized.${result.after.format}`,
            );
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

          const saved = sourceBytes.length - result.bytes.length;
          info(
            `    ✓ ${dims} → ${newDims}  ${formatBytes(sourceBytes.length)} → ${formatBytes(result.bytes.length)} (${durationMs}ms)`,
          );

          // Record in SQLite. `resultWpId === item.id` means the original
          // attachment was replaced in place — the live file now IS the
          // resized result, so the attachments table (which `verify`
          // compares against) must reflect the post-resize dimensions/size,
          // not the pre-resize state.
          const wasReplacedInPlace = resultWpId === item.id;
          db.upsertAttachment({
            siteName: site.name,
            wpId: item.id,
            sourceUrl: item.url,
            sourceHash: wasReplacedInPlace ? resultHash : sourceHash,
            sizeBytes: wasReplacedInPlace ? result.bytes.length : sourceBytes.length,
            width: wasReplacedInPlace ? result.after.width : (item.width ?? null),
            height: wasReplacedInPlace ? result.after.height : (item.height ?? null),
            mimeType: wasReplacedInPlace ? formatToMime(result.after.format) : item.mimeType,
            lastSeenAt: Date.now(),
          });
          db.recordProcessing({
            siteName: site.name,
            wpId: item.id,
            operation: 'resize',
            paramsJson: JSON.stringify({
              maxWidth: options.maxWidth,
              maxHeight: options.maxHeight,
              quality: options.quality,
            }),
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
            fromDims: dims,
            toDims: newDims,
            savedBytes: saved,
          });
        } catch (err) {
          // Animated-source and unsupported-format cases are deliberate skips,
          // not failures — never flatten an animation or rasterize a vector.
          if (err instanceof AnimatedImageError || err instanceof UnsupportedFormatError) {
            warn(`    ↳ Skipped #${id}: ${err.message}`);
            skipped++;
            return;
          }
          error(`    ✗ #${id}: ${err instanceof Error ? err.message : String(err)}`);
          failures++;
        }
      });
      sortResultsById(results, ids);

      if (historySession) {
        closeHistorySession(snapshotStore, historySession, {
          maxSizeBytes: historyConfig.maxSizeBytes,
        });
      }

      db.close();

      if (parentOpts.json) {
        printJson({ resized: results.length, failures, skipped, results });
      } else if (results.length > 0) {
        info(`\n  Done: ${results.length} resized, ${failures} failed, ${skipped} skipped.`);
      }

      if (failures > 0) process.exit(1);
    });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
