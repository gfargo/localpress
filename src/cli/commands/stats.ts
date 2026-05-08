/**
 * `localpress stats` — cumulative savings and library health dashboard.
 *
 * Reads entirely from the local SQLite database — no network calls.
 * Falls back gracefully when no history exists yet.
 *
 * Shows:
 *   - Library overview (total attachments, size, optimized %)
 *   - Cumulative savings (bytes saved, average compression)
 *   - Format breakdown (JPEG, PNG, WebP, AVIF counts)
 *   - Operation breakdown (optimize, convert, resize, remove-bg)
 *   - Recent operations (grouped by date)
 */

import type { Command } from 'commander';
import type {
  FormatCount,
  LibraryOverview,
  RecentOperation,
  SiteStats,
} from '../../engine/state/db.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson } from '../utils/output.ts';

export function registerStatsCommand(program: Command): void {
  program
    .command('stats')
    .description('Show cumulative processing stats and library health for the active site')
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
        const overview = db.getLibraryOverview(site.name);
        const formats = db.getFormatBreakdown(site.name);
        const recent = db.getRecentOperations(site.name, 10);
        db.close();

        results.push({ site: site.name, url: site.url, stats, overview, formats, recent });
      }

      if (parentOpts.json) {
        printJson(results.length === 1 ? results[0] : results);
        return;
      }

      for (const result of results as Array<{
        site: string;
        url?: string;
        stats?: SiteStats;
        overview?: LibraryOverview;
        formats?: FormatCount[];
        recent?: RecentOperation[];
        error?: string;
      }>) {
        if (result.error || !result.stats) {
          error(`${result.site}: ${result.error ?? 'no data'}`);
          continue;
        }

        const { stats, overview, formats, recent } = result;

        if (results.length > 1) {
          info(`\n── ${result.site} ──────────────────────────────`);
        }

        // Header
        info(`\nSite: ${result.site} (${result.url ?? ''})`);
        info('');

        // Library overview
        if (overview && overview.totalAttachments > 0) {
          const optimizedPct =
            overview.totalAttachments > 0
              ? ((overview.optimized / overview.totalAttachments) * 100).toFixed(1)
              : '0.0';

          info('  Library:');
          info(`    Total attachments:   ${overview.totalAttachments.toLocaleString()}`);
          info(`    Total size:          ${formatBytes(overview.totalSizeBytes)}`);
          info(
            `    Optimized:           ${overview.optimized.toLocaleString()} (${optimizedPct}%)`,
          );
          info(`    Unoptimized:         ${overview.unoptimized.toLocaleString()}`);
          info('');
        }

        // Cumulative savings
        if (stats.totalOps > 0) {
          const saved = formatBytes(stats.bytesSaved);
          const avgPct =
            stats.bytesIn > 0 ? ((stats.bytesSaved / stats.bytesIn) * 100).toFixed(1) : '0.0';
          const lastRan = stats.lastRanAt
            ? new Date(stats.lastRanAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })
            : '—';

          info('  Processing:');
          info(
            `    Cumulative savings:  ${saved} across ${stats.filesTouched.toLocaleString()} attachments`,
          );
          info(`    Average compression: ${avgPct}%`);
          info(
            `    Operations:          ${stats.succeeded.toLocaleString()} succeeded / ${(stats.totalOps - stats.succeeded).toLocaleString()} failed`,
          );
          info(`    Last run:            ${lastRan}`);
          info('');
        } else {
          info(
            '  No processing history yet. Run localpress optimize, convert, resize, or remove-bg to start.',
          );
          info('');
        }

        // Format breakdown
        if (formats && formats.length > 0) {
          const total = formats.reduce((sum, f) => sum + f.count, 0);
          info('  Format breakdown:');
          for (const f of formats) {
            const pct = ((f.count / total) * 100).toFixed(1);
            const label = formatMimeType(f.mimeType).padEnd(8);
            info(`    ${label} ${f.count.toLocaleString().padStart(6)}  (${pct}%)`);
          }
          info('');
        }

        // Operation breakdown
        if (stats.byOperation.length > 0) {
          info('  By operation:');
          const colW = Math.max(...stats.byOperation.map((o) => o.operation.length)) + 2;
          for (const op of stats.byOperation) {
            const name = op.operation.padEnd(colW);
            const count = String(op.succeeded).padStart(5);
            const opSaved = op.bytesSaved > 0 ? `  saved ${formatBytes(op.bytesSaved)}` : '';
            const avg = op.avgDurationMs ? `  avg ${op.avgDurationMs}ms` : '';
            info(`    ${name}${count} ops${opSaved}${avg}`);
          }
          info('');
        }

        // Recent operations
        if (recent && recent.length > 0) {
          info('  Recent operations:');
          for (const r of recent) {
            const savedStr = r.bytesSaved > 0 ? `  saved ${formatBytes(r.bytesSaved)}` : '';
            info(
              `    ${r.date}  ${r.operation.padEnd(12)} ${String(r.itemCount).padStart(4)} items${savedStr}`,
            );
          }
          info('');
        }
      }
    });
}

// -- Helpers ------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatMimeType(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'JPEG',
    'image/png': 'PNG',
    'image/webp': 'WebP',
    'image/avif': 'AVIF',
    'image/gif': 'GIF',
    'image/svg+xml': 'SVG',
    'application/pdf': 'PDF',
    'video/mp4': 'MP4',
  };
  return map[mime] ?? mime.replace('image/', '').replace('application/', '').toUpperCase();
}
