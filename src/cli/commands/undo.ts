/**
 * `localpress undo [session-or-snapshot]` — restore from a snapshot.
 *
 * Three targeting modes:
 *   undo                       last session (newest with item_count > 0)
 *   undo <session-prefix>      a specific session (8-char prefix accepted)
 *   undo --snapshot <id>       one specific snapshot
 *   undo --attachment <id>     the most recent un-restored snapshot for an attachment
 *
 * Safe-by-default: bulk undos are dry-run unless `--apply` is passed.
 * `undo --snapshot <id>` and `undo --attachment <id>` are single-item and
 * execute immediately (mirrors the explicit-IDs-execute-immediately pattern
 * from optimize/convert/etc.).
 *
 * Restore mechanics:
 *   - 'binary' snapshots: load blob bytes, replace-in-place via the adapter.
 *     Falls back to upload-as-new + warn() if replace-in-place is unavailable.
 *   - 'metadata-only' snapshots: updateMetadata with the before-state fields.
 */

import type { Command } from 'commander';
import type { AdapterResolver } from '../../adapters/resolver.ts';
import { AdapterResolver as AdapterResolverImpl } from '../../adapters/resolver.ts';
import type { ReplaceOptions, WpBackend } from '../../adapters/types.ts';
import { CapabilityUnavailableError } from '../../adapters/types.ts';
import { openSnapshotStore } from '../../engine/history/index.ts';
import type { SnapshotRecord } from '../../engine/history/index.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { parseIntOption } from '../utils/args.ts';
import { getConfigDir, getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

/**
 * Structural subset of AdapterResolver's public surface. AdapterResolver has a
 * private field, so a duck-typed fake (used in unit tests) isn't assignable to
 * the class type directly — Pick over the public methods removes that brand.
 */
export type ResolverLike = Pick<AdapterResolver, 'resolve' | 'tryResolve'>;

/** The exact suffix (e.g. '.jpeg', not a mimeType-derived '.jpg') off a filename. */
function extensionOf(filename: string): string | undefined {
  const match = filename.match(/\.[^./]+$/);
  return match ? match[0] : undefined;
}

interface UndoResult {
  snapshotId: number;
  attachmentId: number;
  operation: string;
  kind: 'binary' | 'metadata-only';
  status: 'restored' | 'failed' | 'skipped';
  reason?: string;
}

export function registerUndoCommand(program: Command): void {
  program
    .command('undo [sessionId]')
    .description('Restore from a snapshot (last session by default). Dry-run unless --apply.')
    .option('--snapshot <id>', 'restore a specific snapshot by ID', parseIntOption('--snapshot'))
    .option(
      '--attachment <id>',
      'restore the most recent un-restored snapshot for an attachment',
      parseIntOption('--attachment'),
    )
    .action(async (sessionIdArg: string | undefined, options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const db = SiteDb.init(getSiteDbPath(site.name));
      const store = openSnapshotStore(db, getConfigDir());
      const resolver = new AdapterResolverImpl(site);

      // Resolve target snapshots based on flags.
      let snapshots: SnapshotRecord[] = [];
      let isBulk = false;
      let sessionLabel: string | null = null;

      if (typeof options.snapshot === 'number') {
        const snap = store.getSnapshot(options.snapshot);
        if (!snap || snap.siteName !== site.name) {
          error(`No snapshot #${options.snapshot} for site '${site.name}'.`);
          db.close();
          process.exit(1);
        }
        snapshots = [snap];
      } else if (typeof options.attachment === 'number') {
        const snap = store.getLastSnapshotForAttachment(site.name, options.attachment);
        if (!snap) {
          error(`No un-restored snapshot for attachment #${options.attachment}.`);
          db.close();
          process.exit(1);
        }
        snapshots = [snap];
      } else {
        // Session-targeted (explicit or default to last).
        let sessionId: string | null = null;
        if (sessionIdArg) {
          const all = store.listSessions(site.name, { limit: 1000 });
          const match = all.find((s) => s.id.startsWith(sessionIdArg));
          if (!match) {
            error(`No session matching '${sessionIdArg}'.`);
            db.close();
            process.exit(1);
          }
          sessionId = match.id;
          sessionLabel = `${match.command} (${new Date(match.startedAt).toLocaleString()})`;
        } else {
          const last = store.getLastSession(site.name);
          if (!last) {
            info('  No history to undo.');
            db.close();
            return;
          }
          sessionId = last.id;
          sessionLabel = `${last.command} (${new Date(last.startedAt).toLocaleString()})`;
        }
        snapshots = store.listSnapshots(site.name, { sessionId, limit: 10_000 });
        // Filter out snapshots that have already been restored.
        snapshots = snapshots.filter((s) => s.restoredAt === null);
        isBulk = true;
      }

      if (snapshots.length === 0) {
        info('  Nothing to restore (all matching snapshots have already been restored).');
        db.close();
        return;
      }

      // Dry-run for bulk targets unless --apply.
      const isDryRun = isBulk && !parentOpts.apply;

      if (isDryRun) {
        info(
          `  Dry-run: would restore ${snapshots.length} snapshot(s) from session ${sessionLabel ?? '(unspecified)'}.`,
        );
        info('  Pass --apply to execute.\n');
        for (const s of snapshots.slice(0, 20)) {
          info(
            `    snapshot #${s.id}  attachment #${s.wpId}  ${s.operation.padEnd(10)}  ${s.beforeMeta.filename}`,
          );
        }
        if (snapshots.length > 20) info(`    ... and ${snapshots.length - 20} more`);
        if (parentOpts.json) {
          printJson({
            dryRun: true,
            count: snapshots.length,
            snapshots: snapshots.map((s) => ({
              id: s.id,
              attachmentId: s.wpId,
              operation: s.operation,
              kind: s.kind,
              filename: s.beforeMeta.filename,
            })),
          });
        }
        db.close();
        return;
      }

      // Execute restores.
      const results: UndoResult[] = [];
      let failures = 0;

      for (const snap of snapshots) {
        info(`  Restoring snapshot #${snap.id} (attachment #${snap.wpId}, ${snap.operation})...`);
        try {
          await restoreSnapshot(snap, resolver, parentOpts.strict);
          store.markRestored(snap.id);
          // The restored bytes no longer match what processing_history recorded
          // as this operation's output, so exclude that row from future stats
          // and let optimize/etc. re-process this attachment.
          db.markProcessingReverted(site.name, snap.wpId, snap.operation);
          results.push({
            snapshotId: snap.id,
            attachmentId: snap.wpId,
            operation: snap.operation,
            kind: snap.kind,
            status: 'restored',
          });
          info('    ✓ restored');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures++;
          results.push({
            snapshotId: snap.id,
            attachmentId: snap.wpId,
            operation: snap.operation,
            kind: snap.kind,
            status: 'failed',
            reason: message,
          });
          error(`    ✗ ${message}`);
        }
      }

      if (parentOpts.json) {
        printJson({ restored: results.length - failures, failures, results });
      } else {
        info(`\n  Done: ${results.length - failures} restored, ${failures} failed.`);
      }

      db.close();
      if (failures > 0) process.exit(1);
    });
}

/** Apply a single snapshot back to WordPress. Throws on failure. */
export async function restoreSnapshot(
  snap: SnapshotRecord,
  resolver: ResolverLike,
  strict: boolean,
): Promise<void> {
  if (snap.kind === 'metadata-only') {
    const metaAdapter: WpBackend = resolver.resolve('update-meta');
    await metaAdapter.updateMetadata(snap.wpId, {
      altText: snap.beforeMeta.altText ?? '',
      title: snap.beforeMeta.title,
      caption: snap.beforeMeta.caption,
      description: snap.beforeMeta.description,
    });
    return;
  }

  // Binary snapshot: load blob bytes and replace-in-place.
  const { SnapshotStore } = await import('../../engine/history/store.ts');
  // We need the underlying store to read the blob. The resolver doesn't own it,
  // but we passed it indirectly via the path on the snapshot record. Reuse via
  // a fresh SnapshotStore is overkill — read the blob directly.
  void SnapshotStore;
  const { readFileSync } = await import('node:fs');
  if (!snap.blobPath) {
    throw new Error('Binary snapshot is missing its blob path');
  }
  const bytes = readFileSync(snap.blobPath);

  const replaceAdapter = resolver.tryResolve('replace-in-place');
  if (replaceAdapter) {
    try {
      // The attachment may currently be in a different format than the
      // snapshot (e.g. optimize converted PNG → WebP). If so, we must pass
      // newExtension/newMimeType so replaceInPlace renames the file back,
      // restores post_mime_type, and regenerates thumbnails — otherwise the
      // original bytes get written under the wrong (new-format) extension.
      const current = await resolver.resolve('get').getMedia(snap.wpId);
      const formatChanged = current.mimeType !== snap.beforeMeta.mimeType;

      let options: ReplaceOptions | undefined;
      if (formatChanged) {
        const newExtension = extensionOf(snap.beforeMeta.filename);
        if (newExtension) {
          options = {
            newExtension,
            newMimeType: snap.beforeMeta.mimeType,
            regenerateThumbnails: true,
          };
        }
      }

      const restored = await replaceAdapter.replaceInPlace(snap.wpId, bytes, options);

      if (options && current.url && restored.url && current.url !== restored.url) {
        warn(
          `    ⚠ Attachment #${snap.wpId} restored, but content may still reference the old URL (${current.url}). Run: localpress references ${snap.wpId} --scope full`,
        );
      }

      // Also restore metadata fields that may have changed.
      const metaAdapter = resolver.tryResolve('update-meta');
      if (metaAdapter) {
        await metaAdapter.updateMetadata(snap.wpId, {
          altText: snap.beforeMeta.altText,
          title: snap.beforeMeta.title,
          caption: snap.beforeMeta.caption,
          description: snap.beforeMeta.description,
        });
      }
      return;
    } catch (err) {
      if (err instanceof CapabilityUnavailableError && !strict) {
        // Fall through to upload-new fallback.
      } else {
        throw err;
      }
    }
  }

  // Replace-in-place unavailable: upload as a new attachment.
  const uploadAdapter = resolver.resolve('upload');
  const uploaded = await uploadAdapter.upload(bytes, {
    filename: snap.beforeMeta.filename,
    title: snap.beforeMeta.title,
    altText: snap.beforeMeta.altText,
    caption: snap.beforeMeta.caption,
    description: snap.beforeMeta.description,
  });
  warn(
    `    ⚠ Original uploaded as new attachment #${uploaded.id} (in-place replacement not available). Update references manually if needed.`,
  );
}
