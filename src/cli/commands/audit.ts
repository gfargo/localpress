/**
 * `localpress audit` — find optimization opportunities across the library.
 *
 * REST checks:
 *   - --unoptimized: images not yet processed by localpress
 *   - --large: images larger than --threshold
 *   - --missing-alt: images without alt text
 *
 * WP-CLI checks:
 *   - --orphans: uploads-dir files with no DB record
 *   - --unattached: full reference scan for truly unattached media
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { MediaItem } from '../../adapters/types.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

const DEFAULT_THRESHOLD = 1024 * 1024; // 1 MB

interface AuditFinding {
  type: 'unoptimized' | 'large' | 'unattached' | 'missing-alt' | 'orphan' | 'missing-file';
  attachmentId: number;
  filename: string;
  detail: string;
}

export function registerAuditCommand(program: Command): void {
  program
    .command('audit')
    .description('Find optimization opportunities across the media library')
    .option('--unoptimized', 'flag images that have never been processed')
    .option('--large', 'flag images larger than --threshold (default 1MB)')
    .option('--threshold <bytes>', 'size threshold for --large in bytes (default 1048576)', (v) =>
      Number.parseInt(v, 10),
    )
    .option('--unattached', 'flag attachments not associated with any post')
    .option('--missing-alt', 'flag images without alt text')
    .option('--orphans', 'flag uploads-dir files with no DB record (requires WP-CLI)')
    .action(async (options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const adapter = resolver.resolve('list');

      // If no specific check is requested, run all checks.
      const runAll =
        !options.unoptimized &&
        !options.large &&
        !options.unattached &&
        !options.missingAlt &&
        !options.orphans;

      const findings: AuditFinding[] = [];
      const threshold = options.threshold ?? DEFAULT_THRESHOLD;

      // -- Orphan scan (WP-CLI only) ------------------------------------------
      if (options.orphans) {
        const pruneAdapter = resolver.tryResolve('prune-orphans');
        if (!pruneAdapter) {
          error('--orphans requires WP-CLI over SSH. Configure SSH access for this site.');
          process.exit(6);
        }

        info('Scanning for orphan files via WP-CLI...');
        try {
          const pruneResult = await pruneAdapter.pruneOrphans();
          for (const f of pruneResult.orphanFiles) {
            findings.push({
              type: 'orphan',
              attachmentId: 0,
              filename: f,
              detail: 'File on disk with no matching attachment in the database',
            });
          }
          for (const id of pruneResult.missingFiles) {
            findings.push({
              type: 'missing-file',
              attachmentId: id,
              filename: '(missing)',
              detail: 'Attachment registered in DB but file is missing from disk',
            });
          }
          if (pruneResult.reclaimableBytes > 0) {
            info(`  Found ${pruneResult.orphanFiles.length} orphan file(s), ${formatBytes(pruneResult.reclaimableBytes)} reclaimable.`);
          }
        } catch (err) {
          warn(`Orphan scan failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // -- Fetch all media items -----------------------------------------------
      let allItems: MediaItem[] = [];
      let page = 1;
      while (true) {
        try {
          const batch = await adapter.listMedia({ perPage: 100, page });
          if (batch.length === 0) break;
          allItems = allItems.concat(batch);
          if (batch.length < 100) break;
          page++;
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
          process.exit(4);
          return;
        }
      }

      if (allItems.length === 0 && findings.length === 0) {
        info('No media items found in the library.');
        return;
      }

      // Load processed IDs for --unoptimized check.
      let processedIds = new Set<number>();
      if (runAll || options.unoptimized) {
        try {
          const db = SiteDb.init(getSiteDbPath(site.name));
          processedIds = db.listProcessedWpIds(site.name);
          db.close();
        } catch {
          // DB doesn't exist yet — all items are unoptimized.
        }
      }

      for (const item of allItems) {
        // --unoptimized
        if ((runAll || options.unoptimized) && !processedIds.has(item.id)) {
          findings.push({
            type: 'unoptimized',
            attachmentId: item.id,
            filename: item.filename,
            detail: 'Not yet processed by localpress',
          });
        }

        // --large
        if ((runAll || options.large) && item.sizeBytes && item.sizeBytes >= threshold) {
          findings.push({
            type: 'large',
            attachmentId: item.id,
            filename: item.filename,
            detail: `${formatBytes(item.sizeBytes)} (threshold: ${formatBytes(threshold)})`,
          });
        }

        // --missing-alt
        if ((runAll || options.missingAlt) && (!item.altText || item.altText.trim() === '')) {
          findings.push({
            type: 'missing-alt',
            attachmentId: item.id,
            filename: item.filename,
            detail: 'No alt text set',
          });
        }
      }

      // -- Output --------------------------------------------------------------
      if (parentOpts.json) {
        printJson({
          site: site.name,
          totalItems: allItems.length,
          findings,
          summary: {
            unoptimized: findings.filter((f) => f.type === 'unoptimized').length,
            large: findings.filter((f) => f.type === 'large').length,
            missingAlt: findings.filter((f) => f.type === 'missing-alt').length,
            orphan: findings.filter((f) => f.type === 'orphan').length,
            missingFile: findings.filter((f) => f.type === 'missing-file').length,
          },
        });
      } else {
        info(`Audited ${allItems.length} item(s) on '${site.name}':\n`);

        const groups: Record<string, { label: string; items: AuditFinding[] }> = {
          unoptimized: { label: 'Unoptimized', items: findings.filter((f) => f.type === 'unoptimized') },
          large: { label: `Large files (≥${formatBytes(threshold)})`, items: findings.filter((f) => f.type === 'large') },
          missingAlt: { label: 'Missing alt text', items: findings.filter((f) => f.type === 'missing-alt') },
          orphan: { label: 'Orphan files (no DB record)', items: findings.filter((f) => f.type === 'orphan') },
          missingFile: { label: 'Missing files (DB record, no file)', items: findings.filter((f) => f.type === 'missing-file') },
        };

        for (const group of Object.values(groups)) {
          if (group.items.length === 0) continue;
          info(`  ${group.label}: ${group.items.length}`);
          for (const f of group.items.slice(0, 10)) {
            const idStr = f.attachmentId > 0 ? `#${f.attachmentId}  ` : '';
            info(`    ${idStr}${f.filename}  ${f.detail}`);
          }
          if (group.items.length > 10) {
            info(`    ... and ${group.items.length - 10} more`);
          }
          info('');
        }

        if (findings.length === 0) {
          info('  No issues found. Your media library looks good!');
        } else {
          info(`  Total findings: ${findings.length}`);
          info('  Run `localpress optimize --unoptimized --apply` to process unoptimized items.');
        }
      }
    });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
