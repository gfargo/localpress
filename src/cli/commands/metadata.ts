/**
 * `localpress metadata <ids> [flags]` — directly set/edit attachment metadata.
 *
 * Unlike `caption` (which generates alt text via AI), this command writes
 * specific values supplied by the caller. Useful for agents that have already
 * generated, validated, or had user-supplied metadata.
 *
 * Fields: --alt-text, --title, --caption, --description.
 * At least one must be provided.
 *
 * Idempotent: if every incoming field already matches the current value, the
 * item is skipped (no snapshot, no WP call).
 *
 * Time-machine: a metadata-only snapshot is captured before each write so
 * `localpress undo` can restore the previous values.
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { UpdateMetadata } from '../../adapters/types.ts';
import {
  captureSnapshot,
  closeHistorySession,
  openHistorySession,
  openSnapshotStore,
  resolveHistoryConfig,
} from '../../engine/history/index.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { getConfigDir, getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson } from '../utils/output.ts';

interface MetadataResultRecord {
  id: number;
  filename: string;
  updated: boolean;
  skipped: boolean;
  changes: Partial<UpdateMetadata>;
  previous: Partial<UpdateMetadata>;
}

export function registerMetadataCommand(program: Command): void {
  program
    .command('metadata <ids...>')
    .description(
      'Directly set alt-text, title, caption, or description on attachment(s). At least one field flag is required.',
    )
    .option('--alt-text <text>', 'set the alt text')
    .option('--title <text>', 'set the title')
    .option('--caption <text>', 'set the caption')
    .option('--description <text>', 'set the description')
    .action(async (idStrs: string[], options) => {
      const parentOpts = program.opts();

      const incoming: UpdateMetadata = {};
      if (typeof options.altText === 'string') incoming.altText = options.altText;
      if (typeof options.title === 'string') incoming.title = options.title;
      if (typeof options.caption === 'string') incoming.caption = options.caption;
      if (typeof options.description === 'string') incoming.description = options.description;

      if (Object.keys(incoming).length === 0) {
        error(
          'At least one of --alt-text, --title, --caption, --description is required.\n' +
            'Example: localpress metadata 123 --alt-text "Screenshot of the dashboard"',
        );
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
      const metaAdapter = resolver.resolve('update-meta');

      const db = SiteDb.init(getSiteDbPath(site.name));
      db.ensureSite(site.name, site.url);

      // Time-machine: open a session for this metadata run.
      const historyConfig = resolveHistoryConfig(config.history);
      const snapshotStore = openSnapshotStore(db, getConfigDir());
      const historySession = historyConfig.enabled
        ? openHistorySession(snapshotStore, site.name, 'metadata', incoming)
        : null;

      const results: MetadataResultRecord[] = [];
      let failures = 0;

      for (const id of ids) {
        const startTime = Date.now();
        try {
          info(`  Updating metadata for #${id}...`);
          const item = await getAdapter.getMedia(id);

          // Determine which fields actually change.
          const changes: Partial<UpdateMetadata> = {};
          const previous: Partial<UpdateMetadata> = {};
          if (incoming.altText !== undefined && incoming.altText !== (item.altText ?? '')) {
            changes.altText = incoming.altText;
            previous.altText = item.altText ?? '';
          }
          if (incoming.title !== undefined && incoming.title !== (item.title ?? '')) {
            changes.title = incoming.title;
            previous.title = item.title ?? '';
          }
          if (incoming.caption !== undefined && incoming.caption !== (item.caption ?? '')) {
            changes.caption = incoming.caption;
            previous.caption = item.caption ?? '';
          }
          if (
            incoming.description !== undefined &&
            incoming.description !== (item.description ?? '')
          ) {
            changes.description = incoming.description;
            previous.description = item.description ?? '';
          }

          if (Object.keys(changes).length === 0) {
            info('    ↳ Skipped (no fields changed).');
            results.push({
              id,
              filename: item.filename,
              updated: false,
              skipped: true,
              changes: {},
              previous: {},
            });
            continue;
          }

          // Capture metadata-only snapshot.
          if (historySession) {
            captureSnapshot(snapshotStore, {
              siteName: site.name,
              sessionId: historySession.id,
              attachmentId: item.id,
              operation: 'metadata',
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

          await metaAdapter.updateMetadata(id, changes);
          info(`    ✓ Updated ${Object.keys(changes).join(', ')}`);

          // Record in processing_history for stats/audit.
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
            operation: 'metadata',
            paramsJson: JSON.stringify({ changed: Object.keys(changes) }),
            sourceHash: null,
            resultHash: null,
            bytesBefore: null,
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
            updated: true,
            skipped: false,
            changes,
            previous,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          error(`    ✗ #${id}: ${message}`);
          failures++;
        }
      }

      if (historySession) {
        closeHistorySession(snapshotStore, historySession, {
          maxSizeBytes: historyConfig.maxSizeBytes,
        });
      }

      db.close();

      const updated = results.filter((r) => r.updated).length;
      const skipped = results.filter((r) => r.skipped).length;

      if (parentOpts.json) {
        printJson({ updated, skipped, failures, results });
      } else if (updated + skipped > 0 || failures > 0) {
        info(`\n  Done: ${updated} updated, ${skipped} skipped, ${failures} failed.`);
      }

      if (failures > 0) process.exit(1);
    });
}
