/**
 * `localpress watch <directory>` — continuously watch a local directory for
 * new or changed image files and automatically push them to WordPress.
 *
 * Behavior:
 *   - New files → `push` to WordPress as new attachments
 *   - Changed files → `push --replace <id>` if we can map the file to an
 *     existing attachment (via SQLite watch_mappings table)
 *   - Deleted files → log a warning (don't delete from WP without --delete flag)
 *   - --optimize flag to run the optimization pipeline before uploading
 *   - --to <format> to convert on upload
 *   - Ctrl+C to stop gracefully
 *
 * File→attachment mappings are persisted in the site's SQLite database so
 * re-running watch after a restart picks up where it left off.
 */

import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { watch } from 'chokidar';
import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { CapabilityUnavailableError } from '../../adapters/types.ts';
import {
  AnimatedImageError,
  UnsupportedFormatError,
  optimizeImage,
} from '../../engine/image/optimize.ts';
import type { ImageFormat } from '../../engine/image/types.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { parseIntOption } from '../utils/args.ts';
import { getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

/** Image extensions we watch for. */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.svg']);

/** Debounce interval for file changes (ms). */
const DEBOUNCE_MS = 800;

function isImageFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function fileHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function mimeFromPath(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.avif':
      return 'image/avif';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

export function registerWatchCommand(program: Command): void {
  program
    .command('watch <directory>')
    .description('Watch a local directory and auto-push new/changed images to WordPress')
    .option('--optimize', 'run the optimization pipeline before uploading')
    .option('--quality <n>', 'optimization quality (1-100)', parseIntOption('--quality'))
    .option('--to <format>', 'convert to format before uploading (webp, avif, jpeg, png)')
    .option('--max-width <n>', 'max width in pixels', parseIntOption('--max-width'))
    .option('--max-height <n>', 'max height in pixels', parseIntOption('--max-height'))
    .option('--delete', 'delete from WordPress when local file is removed')
    .option(
      '--debounce <ms>',
      'debounce interval in ms (default: 800)',
      parseIntOption('--debounce'),
    )
    .action(async (directory: string, options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);

      // Resolve and validate the watch directory.
      const watchDir = resolve(directory);
      if (!existsSync(watchDir) || !statSync(watchDir).isDirectory()) {
        error(`Not a directory: ${watchDir}`);
        process.exit(2);
      }

      // Open the site database for file→attachment mapping persistence.
      const dbPath = getSiteDbPath(site.name);
      const db = SiteDb.init(dbPath);
      db.ensureSite(site.name, site.url);

      const debounceMs = options.debounce ?? DEBOUNCE_MS;

      // Track in-flight operations to avoid duplicate processing.
      const processing = new Set<string>();

      // Debounce timers per file.
      const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

      info(`Watching ${watchDir} for changes...`);
      info(`Site: ${site.name} (${site.url})`);
      if (options.optimize) info(`Optimization: enabled (quality=${options.quality ?? 'default'})`);
      if (options.to) info(`Convert to: ${options.to}`);
      info('Press Ctrl+C to stop.\n');

      /**
       * Process a file: optimize (if requested), then upload to WordPress.
       */
      async function processFile(filePath: string, isNew: boolean): Promise<void> {
        const relPath = relative(watchDir, filePath);

        if (processing.has(filePath)) return;
        processing.add(filePath);

        try {
          const file = Bun.file(filePath);
          if (!(await file.exists())) {
            processing.delete(filePath);
            return;
          }

          let fileBuffer = Buffer.from(await file.arrayBuffer());
          const originalSize = fileBuffer.length;
          const hash = fileHash(fileBuffer);

          // Check if we already uploaded this exact file (same hash).
          const existingMapping = db.getWatchMapping(site.name, watchDir, relPath);
          if (existingMapping && existingMapping.fileHash === hash) {
            // File hasn't actually changed (editor may have touched mtime).
            processing.delete(filePath);
            return;
          }

          const filename = basename(filePath);
          const mime = mimeFromPath(filePath);

          // Optimize if requested.
          let optimizeInfo = '';
          if (options.optimize || options.to) {
            const optimizeOpts = {
              quality: options.quality,
              toFormat: options.to as ImageFormat | undefined,
              maxWidth: options.maxWidth,
              maxHeight: options.maxHeight,
            };

            const result = await optimizeImage(fileBuffer, mime, optimizeOpts);
            const savedPct = (result.savedRatio * 100).toFixed(1);
            optimizeInfo = ` (${formatBytes(originalSize)} → ${formatBytes(result.after.sizeBytes)}, -${savedPct}%)`;
            fileBuffer = Buffer.from(result.bytes);
          }

          // Determine if this is a replace or a new upload.
          if (!isNew && existingMapping?.wpId) {
            // Try replace-in-place.
            const replaceAdapter = resolver.tryResolve('replace-in-place');

            if (replaceAdapter) {
              try {
                const result = await replaceAdapter.replaceInPlace(
                  existingMapping.wpId,
                  fileBuffer,
                );
                db.upsertWatchMapping(site.name, watchDir, relPath, hash, result.id);

                if (parentOpts.json) {
                  printJson({
                    event: 'replaced',
                    file: relPath,
                    attachmentId: result.id,
                    sizeBytes: fileBuffer.length,
                  });
                } else {
                  info(`↻ ${relPath} → replaced #${result.id}${optimizeInfo}`);
                }
                processing.delete(filePath);
                return;
              } catch (err) {
                if ((err as CapabilityUnavailableError).name !== 'CapabilityUnavailableError') {
                  throw err;
                }
                // Fall through to upload-as-new.
              }
            }

            // Fallback: upload as new, update mapping.
            if (parentOpts.strict) {
              warn(
                `Cannot replace #${existingMapping.wpId} in place (no WP-CLI). Skipping ${relPath} (--strict mode).`,
              );
              processing.delete(filePath);
              return;
            }

            // Upload as new attachment.
            const uploadAdapter = resolver.resolve('upload');
            const result = await uploadAdapter.upload(fileBuffer, { filename });
            db.upsertWatchMapping(site.name, watchDir, relPath, hash, result.id);

            if (parentOpts.json) {
              printJson({
                event: 'uploaded-as-new',
                file: relPath,
                attachmentId: result.id,
                previousId: existingMapping.wpId,
                sizeBytes: fileBuffer.length,
              });
            } else {
              warn(
                `↻ ${relPath} → uploaded as new #${result.id} (replace unavailable, was #${existingMapping.wpId})${optimizeInfo}`,
              );
            }
          } else {
            // New file — upload.
            const uploadAdapter = resolver.resolve('upload');
            const result = await uploadAdapter.upload(fileBuffer, { filename });
            db.upsertWatchMapping(site.name, watchDir, relPath, hash, result.id);

            if (parentOpts.json) {
              printJson({
                event: 'uploaded',
                file: relPath,
                attachmentId: result.id,
                sizeBytes: fileBuffer.length,
              });
            } else {
              info(`+ ${relPath} → #${result.id}${optimizeInfo}`);
            }
          }
        } catch (err) {
          // Animated-source and unsupported-format cases are deliberate skips,
          // not failures — never flatten an animation or rasterize a vector.
          if (err instanceof AnimatedImageError || err instanceof UnsupportedFormatError) {
            if (parentOpts.json) {
              printJson({ event: 'skipped', file: relPath, reason: err.message });
            } else {
              warn(`↳ Skipped ${relPath}: ${err.message}`);
            }
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          if (parentOpts.json) {
            printJson({ event: 'error', file: relPath, error: msg });
          } else {
            error(`✗ ${relPath}: ${msg}`);
          }
        } finally {
          processing.delete(filePath);
        }
      }

      /**
       * Handle file deletion.
       */
      async function handleDelete(filePath: string): Promise<void> {
        const relPath = relative(watchDir, filePath);
        const mapping = db.getWatchMapping(site.name, watchDir, relPath);

        if (!mapping) return;

        if (options.delete) {
          try {
            const deleteAdapter = resolver.resolve('delete');
            await deleteAdapter.delete(mapping.wpId);
            db.removeWatchMapping(site.name, watchDir, relPath);

            if (parentOpts.json) {
              printJson({ event: 'deleted', file: relPath, attachmentId: mapping.wpId });
            } else {
              info(`- ${relPath} → deleted #${mapping.wpId} from WordPress`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            error(`✗ Could not delete #${mapping.wpId}: ${msg}`);
          }
        } else {
          if (parentOpts.json) {
            printJson({
              event: 'file-removed',
              file: relPath,
              attachmentId: mapping.wpId,
              note: 'WordPress attachment not deleted (pass --delete to enable)',
            });
          } else {
            warn(
              `${relPath} removed locally. Attachment #${mapping.wpId} still exists in WordPress. Pass --delete to auto-remove.`,
            );
          }
          // Remove the mapping so we don't try to replace a stale ID later.
          db.removeWatchMapping(site.name, watchDir, relPath);
        }
      }

      /**
       * Debounced file event handler.
       */
      function scheduleProcess(filePath: string, isNew: boolean): void {
        if (!isImageFile(filePath)) return;

        const existing = debounceTimers.get(filePath);
        if (existing) clearTimeout(existing);

        debounceTimers.set(
          filePath,
          setTimeout(() => {
            debounceTimers.delete(filePath);
            void processFile(filePath, isNew);
          }, debounceMs),
        );
      }

      // Start watching.
      const watcher = watch(watchDir, {
        ignoreInitial: true,
        persistent: true,
        usePolling: false,
        awaitWriteFinish: {
          stabilityThreshold: debounceMs,
          pollInterval: 100,
        },
        ignored: [
          /(^|[/\\])\../, // dotfiles
          '**/node_modules/**',
          '**/.git/**',
        ],
      });

      watcher.on('add', (filePath) => scheduleProcess(filePath, true));
      watcher.on('change', (filePath) => scheduleProcess(filePath, false));
      watcher.on('unlink', (filePath) => {
        if (!isImageFile(filePath)) return;
        void handleDelete(filePath);
      });
      watcher.on('error', (err) => {
        error(`Watcher error: ${err.message}`);
      });

      // Graceful shutdown on Ctrl+C.
      const shutdown = async () => {
        info('\nStopping watcher...');
        for (const timer of debounceTimers.values()) {
          clearTimeout(timer);
        }
        await watcher.close();
        db.close();
        process.exit(0);
      };

      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());

      // Keep the process alive.
      await new Promise(() => {});
    });
}

// -- Helpers ------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
