/**
 * `localpress edit <id> [--with <app>]` — round-trip editing workflow.
 *
 * Downloads an attachment, opens it in the user's editor, watches for saves,
 * and uploads the changed file back to WordPress. The killer feature that
 * no incumbent offers.
 *
 * Flow:
 *   1. Download attachment to a temp directory
 *   2. Open in default editor (or --with <app>)
 *   3. Watch the file for changes
 *   4. On each save: upload as replacement (with fallback chain)
 *   5. User presses Enter or Ctrl+C to stop watching
 *   6. Clean up temp file
 */

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as readline from 'node:readline';
import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import { CapabilityUnavailableError } from '../../adapters/types.ts';
import { describeEditor, openInEditor } from '../../engine/editor/detect.ts';
import { watchFile } from '../../engine/editor/watcher.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

export function registerEditCommand(program: Command): void {
  program
    .command('edit <id>')
    .description('Open an attachment in your editor, watch for saves, sync back to WP')
    .option('--with <app>', 'editor application to use (default: system default)')
    .option('--no-watch', 'open the file but do not watch for changes')
    .option('--keep-file', 'do not delete the temp file after editing')
    .option('--to <dir>', 'download to this directory instead of a temp dir')
    .action(async (idStr: string, options) => {
      const parentOpts = program.opts();
      const id = Number.parseInt(idStr, 10);
      if (Number.isNaN(id)) {
        error(`Invalid attachment ID: ${idStr}`);
        process.exit(2);
      }

      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const getAdapter = resolver.resolve('get');

      // 1. Fetch attachment metadata.
      let item: import('../../adapters/types.ts').MediaItem;
      try {
        item = await getAdapter.getMedia(id);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(4);
        return;
      }

      // 2. Download the file.
      info(`Downloading #${id} (${item.filename})...`);
      const response = await fetch(item.url);
      if (!response.ok) {
        error(`Failed to download ${item.url}: ${response.status}`);
        process.exit(4);
      }
      const sourceBytes = Buffer.from(await response.arrayBuffer());

      const destDir = options.to ?? join(tmpdir(), `localpress-edit-${id}-${Date.now()}`);
      mkdirSync(destDir, { recursive: true });
      const localPath = join(destDir, basename(item.filename));
      await Bun.write(localPath, sourceBytes);

      info(`  Saved to ${localPath}`);

      // 3. Open in editor.
      const editorDesc = describeEditor(options.with);
      info(`  Opening in ${editorDesc}...`);

      try {
        openInEditor(localPath, options.with);
      } catch (err) {
        error(`Failed to open editor: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      // If --no-watch, we're done.
      if (options.watch === false) {
        info('');
        info(`  File saved at: ${localPath}`);
        info('  Edit the file, then upload manually with:');
        info(`    localpress push "${localPath}" --replace ${id}`);
        return;
      }

      // 4. Watch for changes.
      let uploadCount = 0;
      const db = SiteDb.init(getSiteDbPath(site.name));
      db.ensureSite(site.name, site.url);

      info('');
      info('  Watching for changes. Save the file in your editor to sync.');
      info('  Press Enter to stop watching.\n');

      const watcher = watchFile(localPath, {
        debounceMs: 800,
        onReady: () => {
          // Watcher is ready.
        },
        onSave: async (filePath) => {
          uploadCount++;
          const startTime = Date.now();

          try {
            info(`  Change detected (#${uploadCount}). Uploading...`);

            const changedBytes = Buffer.from(await Bun.file(filePath).arrayBuffer());
            const changedHash = createHash('sha256').update(changedBytes).digest('hex');

            // Try replace-in-place.
            let resultWpId: number | null = null;
            const replaceAdapter = resolver.tryResolve('replace-in-place');
            if (replaceAdapter) {
              try {
                await replaceAdapter.replaceInPlace(id, changedBytes);
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

            if (resultWpId === null) {
              // Upload as new attachment.
              const uploadAdapter = resolver.resolve('upload');
              const uploaded = await uploadAdapter.upload(changedBytes, {
                filename: basename(filePath),
                title: item.title,
                altText: item.altText,
              });
              resultWpId = uploaded.id;
              warn(
                `    ⚠ Uploaded as new attachment #${resultWpId} (in-place replacement not available).`,
              );
            }

            const durationMs = Date.now() - startTime;
            info(`    ✓ Synced (${formatBytes(changedBytes.length)}, ${durationMs}ms)`);

            // Record in SQLite.
            db.upsertAttachment({
              siteName: site.name,
              wpId: item.id,
              sourceUrl: item.url,
              sourceHash: changedHash,
              sizeBytes: changedBytes.length,
              width: item.width ?? null,
              height: item.height ?? null,
              mimeType: item.mimeType,
              lastSeenAt: Date.now(),
            });
            db.recordProcessing({
              siteName: site.name,
              wpId: item.id,
              operation: 'edit',
              paramsJson: JSON.stringify({ editor: options.with ?? 'default' }),
              sourceHash: changedHash,
              resultHash: changedHash,
              bytesBefore: sourceBytes.length,
              bytesAfter: changedBytes.length,
              resultWpId: resultWpId !== item.id ? resultWpId : null,
              ranAt: Date.now(),
              durationMs,
              status: 'success',
              errorMessage: null,
            });

            if (parentOpts.json) {
              printJson({
                event: 'synced',
                attachmentId: id,
                resultWpId,
                sizeBytes: changedBytes.length,
                durationMs,
                uploadNumber: uploadCount,
              });
            }
          } catch (err) {
            error(`    ✗ Upload failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
        onError: (err) => {
          warn(`  Watcher error: ${err.message}`);
        },
      });

      // 5. Wait for user to press Enter to stop.
      await new Promise<void>((resolve) => {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        rl.on('line', () => {
          rl.close();
          resolve();
        });

        // Also handle Ctrl+C gracefully.
        rl.on('SIGINT', () => {
          rl.close();
          resolve();
        });

        // Non-interactive stdin (e.g. `edit 5 < /dev/null`) never emits
        // 'line' — only 'close' fires once stdin hits EOF.
        rl.on('close', () => {
          resolve();
        });
      });

      // 6. Clean up.
      await watcher.close();
      db.close();

      if (!options.keepFile && !options.to) {
        try {
          rmSync(destDir, { recursive: true, force: true });
        } catch {
          // Best effort.
        }
      }

      info('');
      info(`  Done. ${uploadCount} change(s) synced.`);
      if (options.keepFile || options.to) {
        info(`  File kept at: ${localPath}`);
      }

      if (parentOpts.json) {
        printJson({
          event: 'complete',
          attachmentId: id,
          totalSyncs: uploadCount,
          filePath: options.keepFile || options.to ? localPath : null,
        });
      }
    });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
