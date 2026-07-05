/**
 * `localpress delete <ids> [--force]` — remove attachments from WordPress.
 *
 * Explicit IDs only (no `--all` / `--unoptimized` filters). The blast radius
 * is high enough that we want callers to pre-enumerate IDs (e.g. from
 * `audit --duplicates --json`).
 *
 * Without `--force`, WP REST moves the attachment to trash (recoverable in
 * the WordPress admin). With `--force`, the attachment + file are removed
 * permanently.
 *
 * Time-machine: a binary snapshot is captured before delete so
 * `localpress undo` can re-upload the file. Because WordPress assigns a new
 * attachment ID on re-upload, undo for a deleted attachment goes through the
 * upload-as-new path (with a warning about reference rewriting).
 */

import { createHash } from 'node:crypto';
import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
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

interface DeleteResultRecord {
  id: number;
  filename: string;
  status: 'deleted' | 'failed';
  force: boolean;
  reason?: string;
}

export function registerDeleteCommand(program: Command): void {
  program
    .command('delete <ids...>')
    .description(
      'Delete attachment(s) from WordPress. Without --force, moves to trash (recoverable). Captures undo snapshots first.',
    )
    .option(
      '--force',
      'permanently delete (skip trash). Default behavior moves to trash via WP REST.',
    )
    .action(async (idStrs: string[], options) => {
      const parentOpts = program.opts();

      const ids = parseAttachmentIds(idStrs);

      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const getAdapter = resolver.resolve('get');

      // Deletion is destructive; honor an explicit --dry-run by previewing only.
      const dryRun = resolveDryRun(parentOpts, false);
      if (dryRun) {
        warn(
          `[dry-run] would delete ${ids.length} attachment(s); pass without --dry-run to execute:`,
        );
        for (const id of ids) {
          info(`  would delete #${id}${options.force ? ' (permanent)' : ' (to trash)'}`);
        }
        if (parentOpts.json) {
          printJson({ dryRun: true, force: Boolean(options.force), ids });
        }
        return;
      }

      const deleteAdapter = resolver.resolve('delete');

      const db = SiteDb.init(getSiteDbPath(site.name));
      db.ensureSite(site.name, site.url);

      // Time-machine: one session for this delete run.
      const historyConfig = resolveHistoryConfig(config.history);
      const snapshotStore = openSnapshotStore(db, getConfigDir());
      const historySession = historyConfig.enabled
        ? openHistorySession(snapshotStore, site.name, 'delete', {
            force: Boolean(options.force),
          })
        : null;

      const results: DeleteResultRecord[] = [];
      let failures = 0;

      for (const id of ids) {
        const startTime = Date.now();
        try {
          info(`  Deleting #${id}${options.force ? ' (force)' : ' (to trash)'}...`);
          const item = await getAdapter.getMedia(id);

          // Capture binary snapshot of the file bytes before delete so undo
          // can re-upload. Best-effort: if the URL fails (already gone, 401,
          // etc.), we still proceed with delete — but log a warning.
          if (historySession) {
            try {
              const response = await fetch(item.url);
              if (response.ok) {
                const sourceBytes = Buffer.from(await response.arrayBuffer());
                const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
                captureSnapshot(snapshotStore, {
                  siteName: site.name,
                  sessionId: historySession.id,
                  attachmentId: item.id,
                  operation: 'delete',
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
              } else {
                info(
                  `    ⚠ Couldn't capture file bytes (HTTP ${response.status}); undo will not restore the file.`,
                );
              }
            } catch (snapshotErr) {
              info(
                `    ⚠ Couldn't capture file bytes (${snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr)}); undo will not restore the file.`,
              );
            }
          }

          await deleteAdapter.delete(id, { force: Boolean(options.force) });
          info(`    ✓ ${options.force ? 'Permanently deleted' : 'Moved to trash'}`);

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
            operation: 'delete',
            paramsJson: JSON.stringify({ force: Boolean(options.force) }),
            sourceHash: null,
            resultHash: null,
            bytesBefore: item.sizeBytes ?? null,
            bytesAfter: null,
            resultWpId: null,
            ranAt: Date.now(),
            durationMs: Date.now() - startTime,
            status: 'success',
            errorMessage: null,
          });

          results.push({
            id,
            filename: item.filename,
            status: 'deleted',
            force: Boolean(options.force),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          error(`    ✗ #${id}: ${message}`);
          failures++;
          results.push({
            id,
            filename: '(unknown)',
            status: 'failed',
            force: Boolean(options.force),
            reason: message,
          });
        }
      }

      if (historySession) {
        closeHistorySession(snapshotStore, historySession, {
          maxSizeBytes: historyConfig.maxSizeBytes,
        });
      }

      db.close();

      const deleted = results.filter((r) => r.status === 'deleted').length;

      if (parentOpts.json) {
        printJson({ deleted, failures, force: Boolean(options.force), results });
      } else if (deleted + failures > 0) {
        info(`\n  Done: ${deleted} deleted, ${failures} failed.`);
        if (deleted > 0 && !options.force) {
          info('  Tip: deleted items are in WP trash and can be restored from the admin.');
          info('       For local restore via the time-machine, run: localpress undo --apply');
        }
      }

      if (failures > 0) process.exit(1);
    });
}
