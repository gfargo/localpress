/**
 * `localpress history [sub]` — browse and manage the time-machine archive.
 *
 *   history                  list recent sessions (default action)
 *   history list             same as above (filters supported)
 *   history show <id>        details for a single snapshot or session
 *   history prune            apply retention policy
 *   history clear            wipe all snapshots for the active site
 *   history -i               interactive TUI browser (mirrors `list -i`)
 *
 * No network calls. Reads entirely from the local SQLite db + blob storage.
 */

import type { Command } from 'commander';
import {
  DEFAULT_MAX_SIZE_BYTES,
  openSnapshotStore,
  resolveHistoryConfig,
} from '../../engine/history/index.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { parseIntOption } from '../utils/args.ts';
import { getConfigDir, getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';
import { MIN_SESSION_PREFIX_LEN, matchSessionByPrefix } from '../utils/session-match.ts';

export function registerHistoryCommand(program: Command): void {
  const history = program
    .command('history')
    .description('Browse the time-machine: sessions, snapshots, retention')
    .option('--session <id>', 'filter to a specific session')
    .option(
      '--attachment <id>',
      'filter to a specific attachment ID',
      parseIntOption('--attachment'),
    )
    .option(
      '--operation <op>',
      'filter by operation (optimize, convert, resize, remove-bg, caption, classify, rename, delete, title, tag, metadata, edit, vision, describe)',
    )
    .option('--limit <n>', 'max sessions/snapshots to show (default 50)', parseIntOption('--limit'))
    .option('-i, --interactive', 'browse with keyboard navigation')
    .action(async (options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const db = SiteDb.init(getSiteDbPath(site.name));
      const store = openSnapshotStore(db, getConfigDir());
      const limit = options.limit ?? 50;

      // Single-attachment or single-session view: list snapshots, not sessions.
      if (options.session || typeof options.attachment === 'number' || options.operation) {
        const snapshots = store.listSnapshots(site.name, {
          sessionId: options.session,
          attachmentId: options.attachment,
          operation: options.operation,
          limit,
        });

        if (parentOpts.json) {
          printJson({ site: site.name, snapshots });
          db.close();
          return;
        }

        if (snapshots.length === 0) {
          info('No matching snapshots.');
          db.close();
          return;
        }

        info(`  ${snapshots.length} snapshot(s):\n`);
        for (const s of snapshots) {
          const when = new Date(s.createdAt).toLocaleString();
          const size = s.blobSize > 0 ? formatBytes(s.blobSize) : 'meta-only';
          const status = s.restoredAt ? ' [restored]' : '';
          info(
            `  #${s.id}  ${s.operation.padEnd(10)} attachment #${s.wpId}  ${size.padEnd(10)}  ${when}${status}`,
          );
          info(`         session: ${s.sessionId.slice(0, 8)}...`);
        }
        db.close();
        return;
      }

      // Interactive TUI browser.
      if (options.interactive) {
        const { render } = await import('ink');
        const React = await import('react');
        const { HistoryBrowser } = await import('../components/HistoryBrowser.tsx');
        const sessions = store.listSessions(site.name, { limit });

        if (sessions.length === 0) {
          info('No history yet. Run an op like `optimize`, `convert`, or `caption` first.');
          db.close();
          return;
        }

        await new Promise<void>((resolve) => {
          const { unmount } = render(
            React.createElement(HistoryBrowser, {
              sessions,
              store,
              siteName: site.name,
              onExit: () => {
                unmount();
                resolve();
              },
            }),
          );
        });

        db.close();
        return;
      }

      // Default: list sessions.
      const sessions = store.listSessions(site.name, { limit });
      const stats = store.getStats(site.name);

      if (parentOpts.json) {
        printJson({
          site: site.name,
          sessions,
          stats: {
            ...stats,
            maxSizeBytes:
              resolveHistoryConfig(config.history).maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES,
          },
        });
        db.close();
        return;
      }

      if (sessions.length === 0) {
        info('No history yet. Run an op like `optimize`, `convert`, or `caption` first.');
        db.close();
        return;
      }

      info(`  History for ${site.name}:`);
      info(
        `    ${stats.snapshotCount} snapshots across ${stats.sessionCount} sessions, ${formatBytes(stats.totalBytes)} on disk`,
      );
      info('');
      for (const s of sessions) {
        const when = new Date(s.startedAt).toLocaleString();
        info(`  ${s.id.slice(0, 8)}  ${s.command.padEnd(10)} ${s.itemCount} items  ${when}`);
      }
      info('');
      info('  Show a session:    localpress history --session <id>');
      info('  Undo last session: localpress undo');
      info('  Interactive view:  localpress history -i');

      db.close();
    });

  history
    .command('show <id>')
    .description('Show details for a session ID (8-char prefix) or snapshot ID (integer)')
    .action(async (id: string) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const db = SiteDb.init(getSiteDbPath(site.name));
      const store = openSnapshotStore(db, getConfigDir());

      // Numeric → snapshot ID; otherwise session prefix.
      const asInt = Number.parseInt(id, 10);
      if (!Number.isNaN(asInt) && String(asInt) === id) {
        const snap = store.getSnapshot(asInt);
        if (!snap) {
          error(`No snapshot #${asInt}.`);
          db.close();
          process.exit(1);
        }
        if (parentOpts.json) {
          printJson(snap);
        } else {
          info(
            `  Snapshot #${snap.id}\n` +
              `    Session:     ${snap.sessionId}\n` +
              `    Attachment:  #${snap.wpId} (${snap.beforeMeta.filename})\n` +
              `    Operation:   ${snap.operation}\n` +
              `    Kind:        ${snap.kind}\n` +
              `    Size:        ${snap.blobSize > 0 ? formatBytes(snap.blobSize) : '(metadata only)'}\n` +
              `    Created:     ${new Date(snap.createdAt).toLocaleString()}\n` +
              `    Restored:    ${snap.restoredAt ? new Date(snap.restoredAt).toLocaleString() : '(no)'}`,
          );
        }
        db.close();
        return;
      }

      // Session prefix match.
      const sessions = store.listSessions(site.name, { limit: 1000 });
      const result = matchSessionByPrefix(sessions, id);
      if (result.kind === 'too-short') {
        error(
          `Session prefix '${id}' is too short (minimum ${MIN_SESSION_PREFIX_LEN} characters).`,
        );
        db.close();
        process.exit(1);
      }
      if (result.kind === 'none') {
        error(`No session matching '${id}'.`);
        db.close();
        process.exit(1);
      }
      if (result.kind === 'ambiguous') {
        error(`Ambiguous session prefix '${id}' matches ${result.candidates.length} sessions:`);
        for (const c of result.candidates) {
          info(
            `    ${c.id.slice(0, 8)}  ${c.command.padEnd(10)} ${new Date(c.startedAt).toLocaleString()}`,
          );
        }
        info('  Use a longer prefix to disambiguate.');
        db.close();
        process.exit(1);
      }
      const session = result.session;
      const snapshots = store.listSnapshots(site.name, { sessionId: session.id });

      if (parentOpts.json) {
        printJson({ session, snapshots });
        db.close();
        return;
      }

      info(
        `  Session ${session.id}\n` +
          `    Command:  ${session.command}\n` +
          `    Started:  ${new Date(session.startedAt).toLocaleString()}\n` +
          `    Items:    ${session.itemCount}\n` +
          `    Params:   ${session.paramsJson ?? '(none)'}\n`,
      );
      info('  Snapshots:');
      for (const s of snapshots) {
        const size = s.blobSize > 0 ? formatBytes(s.blobSize) : 'meta-only';
        const status = s.restoredAt ? ' [restored]' : '';
        info(`    #${s.id}  ${s.operation.padEnd(10)} attachment #${s.wpId}  ${size}${status}`);
      }

      db.close();
    });

  history
    .command('prune')
    .description('Apply retention policy: drop oldest snapshots until limits are met')
    .option(
      '--max-size <bytes>',
      'override config: drop until total size ≤ this many bytes',
      parseIntOption('--max-size'),
    )
    .option(
      '--older-than <days>',
      'drop snapshots older than N days',
      parseIntOption('--older-than'),
    )
    .option(
      '--max-sessions <n>',
      'keep only the N most recent sessions',
      parseIntOption('--max-sessions'),
    )
    .action(async (options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const db = SiteDb.init(getSiteDbPath(site.name));
      const store = openSnapshotStore(db, getConfigDir());
      const resolved = resolveHistoryConfig(config.history);

      const policy = {
        maxSizeBytes: options.maxSize ?? resolved.maxSizeBytes,
        olderThan: options.olderThan
          ? Date.now() - options.olderThan * 24 * 60 * 60 * 1000
          : undefined,
        maxSessions: options.maxSessions,
      };

      const result = store.prune(site.name, policy);

      if (parentOpts.json) {
        printJson(result);
      } else {
        info(
          `  Pruned ${result.droppedSnapshots} snapshot(s) across ${result.droppedSessions} session(s), freed ${formatBytes(result.freedBytes)}.`,
        );
      }
      db.close();
    });

  history
    .command('clear')
    .description('Wipe ALL snapshots for the active site (destructive)')
    .option('--yes', 'skip confirmation prompt')
    .action(async (options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const db = SiteDb.init(getSiteDbPath(site.name));
      const store = openSnapshotStore(db, getConfigDir());
      const stats = store.getStats(site.name);

      if (stats.snapshotCount === 0) {
        info('  No history to clear.');
        db.close();
        return;
      }

      if (!options.yes && !parentOpts.yes) {
        warn(
          `  This will delete ${stats.snapshotCount} snapshot(s) (${formatBytes(stats.totalBytes)}) for site '${site.name}'. Re-run with --yes to confirm.`,
        );
        db.close();
        process.exit(2);
      }

      const result = store.clear(site.name);
      if (parentOpts.json) {
        printJson(result);
      } else {
        info(
          `  Cleared ${result.droppedSnapshots} snapshot(s), freed ${formatBytes(result.freedBytes)}.`,
        );
      }
      db.close();
    });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
