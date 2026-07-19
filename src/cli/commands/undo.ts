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
import { CapabilityUnavailableError, WpApiError } from '../../adapters/types.ts';
import { openSnapshotStore } from '../../engine/history/index.ts';
import type { SnapshotRecord, SnapshotStore } from '../../engine/history/index.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { parseIntOption } from '../utils/args.ts';
import { getConfigDir, getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';
import { resolveDryRun } from '../utils/run-mode.ts';
import { MIN_SESSION_PREFIX_LEN, matchSessionByPrefix } from '../utils/session-match.ts';

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
  status: 'restored' | 'partial' | 'failed' | 'skipped';
  reason?: string;
  /** For 'partial': the new attachment ID created by the upload-as-new fallback. */
  newAttachmentId?: number;
}

/**
 * Result of applying one snapshot.
 *   - 'restored': the live attachment now holds the original bytes/metadata.
 *   - 'partial':  replace-in-place was unavailable, so the original was uploaded
 *     as a NEW attachment. The target attachment is unchanged and references
 *     still point at it — so the snapshot must stay un-restored for a later retry.
 */
export interface RestoreOutcome {
  status: 'restored' | 'partial';
  newAttachmentId?: number;
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
          const result = matchSessionByPrefix(all, sessionIdArg);
          if (result.kind === 'too-short') {
            error(
              `Session prefix '${sessionIdArg}' is too short (minimum ${MIN_SESSION_PREFIX_LEN} characters).`,
            );
            db.close();
            process.exit(1);
          }
          if (result.kind === 'none') {
            error(`No session matching '${sessionIdArg}'.`);
            db.close();
            process.exit(1);
          }
          if (result.kind === 'ambiguous') {
            error(
              `Ambiguous session prefix '${sessionIdArg}' matches ${result.candidates.length} sessions:`,
            );
            for (const c of result.candidates) {
              info(
                `    ${c.id.slice(0, 8)}  ${c.command.padEnd(10)} ${new Date(c.startedAt).toLocaleString()}`,
              );
            }
            info('  Use a longer prefix to disambiguate.');
            db.close();
            process.exit(1);
          }
          sessionId = result.session.id;
          sessionLabel = `${result.session.command} (${new Date(result.session.startedAt).toLocaleString()})`;
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

      // Dry-run for bulk targets unless --apply; single-snapshot targets execute
      // by default but still honor an explicit --dry-run.
      const isDryRun = resolveDryRun(parentOpts, isBulk);

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
          const outcome = await restoreSnapshot(snap, resolver, store, parentOpts.strict);

          if (outcome.status === 'partial') {
            // Upload-as-new fallback (REST-only): the target attachment is
            // unchanged, so DON'T consume the snapshot — leave it un-restored so
            // the user can retry after adding a replace-in-place capability
            // (SSH/WP-CLI). References still point at the original ID.
            results.push({
              snapshotId: snap.id,
              attachmentId: snap.wpId,
              operation: snap.operation,
              kind: snap.kind,
              status: 'partial',
              newAttachmentId: outcome.newAttachmentId,
              reason: `original re-uploaded as new attachment #${outcome.newAttachmentId}; attachment #${snap.wpId} is unchanged and references still point at it. Retry with a replace-in-place backend (SSH/WP-CLI), or rewrite refs: localpress references ${snap.wpId} --update-to ${outcome.newAttachmentId}`,
            });
            info('    ↳ partial (snapshot kept for retry)');
            continue;
          }

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

      const restored = results.filter((r) => r.status === 'restored').length;
      const partial = results.filter((r) => r.status === 'partial').length;

      if (parentOpts.json) {
        printJson({ restored, partial, failures, results });
      } else {
        const partialNote = partial > 0 ? `, ${partial} partial` : '';
        info(`\n  Done: ${restored} restored${partialNote}, ${failures} failed.`);
        if (partial > 0) {
          warn(
            '  ⚠ Partial restores uploaded the original as a new attachment; the ' +
              'snapshot was kept so you can retry with a replace-in-place backend.',
          );
        }
      }

      db.close();
      if (failures > 0) process.exit(1);
    });
}

/**
 * Apply a single snapshot back to WordPress. Throws on failure.
 *
 * Returns `{ status: 'restored' }` when the live attachment was updated in
 * place, or `{ status: 'partial', newAttachmentId }` when replace-in-place was
 * unavailable and the original had to be uploaded as a new attachment (the
 * caller must NOT mark the snapshot restored in that case).
 */
export async function restoreSnapshot(
  snap: SnapshotRecord,
  resolver: ResolverLike,
  store: SnapshotStore,
  strict: boolean,
): Promise<RestoreOutcome> {
  if (snap.kind === 'metadata-only') {
    const metaAdapter: WpBackend = resolver.resolve('update-meta');
    await metaAdapter.updateMetadata(snap.wpId, {
      altText: snap.beforeMeta.altText ?? '',
      title: snap.beforeMeta.title,
      caption: snap.beforeMeta.caption,
      description: snap.beforeMeta.description,
      ...(snap.beforeMeta.slug !== undefined ? { slug: snap.beforeMeta.slug } : {}),
    });
    return { status: 'restored' };
  }

  // Binary snapshot: load blob bytes (existence/size/hash verified by readBlob)
  // and replace-in-place.
  const bytes = store.readBlob(snap);

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
          ...(snap.beforeMeta.slug !== undefined ? { slug: snap.beforeMeta.slug } : {}),
        });
      }
      return { status: 'restored' };
    } catch (err) {
      if (err instanceof CapabilityUnavailableError && !strict) {
        // Fall through to upload-new fallback.
      } else if (err instanceof WpApiError && err.status === 404) {
        // The attachment no longer exists (e.g. it was deleted). Replace-in-place
        // is impossible on any backend once the original is gone, so re-upload
        // it as a new attachment — matches the REST-only path regardless of
        // --strict, since this isn't an avoidable capability gap.
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
  return { status: 'partial', newAttachmentId: uploaded.id };
}
