/**
 * `localpress stats` — cumulative savings and processing history dashboard.
 *
 * Reads entirely from the local SQLite database — no network calls.
 * Falls back gracefully when no history exists yet.
 */

import type { Command } from 'commander';
import { SiteDb } from '../../engine/state/db.ts';
import { loadConfig, getSiteDbPath, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson } from '../utils/output.ts';

export function registerStatsCommand(program: Command): void {
  program
    .command('stats')
    .description('Show cumulative processing stats for the active site')
    .option('--all-sites', 'show stats for every configured site')
    .action(async (options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();

      const sites = options.allSites
        ? Object.values(config.sites)
        : [resolveActiveSite(config, parentOpts.site)];

      const results = [];

      for (const site of sites) {
        const dbPath = getSiteDbPath(site.name);
        let db: SiteDb;
        try {
          db = SiteDb.init(dbPath);
        } catch {
          if (parentOpts.json) {
            results.push({ site: site.name, error: 'database unavailable' });
          } else {
            error(`No stats database for site "${site.name}" — run some operations first.`);
          }
          continue;
        }

        const stats = db.getStats(site.name);
        db.close();
        results.push({ site: site.name, stats });
      }

      if (parentOpts.json) {
        printJson(results.length === 1 ? results[0] : results);
        return;
      }

      for (const { site, stats, error: err } of results as Array<{
        site: string;
        stats?: import('../../engine/state/db.ts').SiteStats;
        error?: string;
      }>) {
        if (err || !stats) {
          error(`${site}: ${err ?? 'no data'}`);
          continue;
        }

        if (results.length > 1) {
          info(`\n── ${site} ──────────────────────────────`);
        }

        if (stats.totalOps === 0) {
          info(`No processing history yet for "${site}". Run localpress optimize, convert, resize, or remove-bg to start.`);
          continue;
        }

        const saved = formatBytes(stats.bytesSaved);
        const pct = stats.bytesIn > 0
          ? ` (${((stats.bytesSaved / stats.bytesIn) * 100).toFixed(1)}% reduction)`
          : '';
        const lastRan = stats.lastRanAt
          ? new Date(stats.lastRanAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          : '—';

        info(`\n  Site            ${site}`);
        info(`  Files touched   ${stats.filesTouched.toLocaleString()}`);
        info(`  Operations      ${stats.succeeded.toLocaleString()} succeeded  /  ${(stats.totalOps - stats.succeeded).toLocaleString()} failed`);
        info(`  Bytes saved     ${saved}${pct}`);
        info(`  Last run        ${lastRan}`);

        if (stats.byOperation.length > 0) {
          info('\n  Breakdown by operation:\n');
          const colW = Math.max(...stats.byOperation.map((o) => o.operation.length)) + 2;
          for (const op of stats.byOperation) {
            const name = op.operation.padEnd(colW);
            const count = String(op.succeeded).padStart(5);
            const opSaved = op.bytesSaved > 0 ? `  saved ${formatBytes(op.bytesSaved)}` : '';
            const avg = op.avgDurationMs ? `  avg ${op.avgDurationMs}ms` : '';
            info(`    ${name}${count} ops${opSaved}${avg}`);
          }
        }

        info('');
      }
    });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
