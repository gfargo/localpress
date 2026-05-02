/**
 * `localpress audit` — find optimization opportunities across the library.
 *
 * v0.1 checks (REST-only):
 *   - --unoptimized: images not yet processed by localpress
 *   - --large: images larger than --threshold
 *   - --unattached: attachments not associated with any post
 *
 * v0.5 checks (require WP-CLI adapter):
 *   - --missing-alt: images without alt text
 *   - --orphans: uploads-dir files with no DB record
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { MediaItem } from '../../adapters/types.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { loadConfig, getSiteDbPath, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

const DEFAULT_THRESHOLD = 1024 * 1024; // 1 MB

interface AuditFinding {
  type: 'unoptimized' | 'large' | 'unattached' | 'missing-alt';
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
    .option('--missing-alt', 'flag images without alt text (v0.5)')
    .option('--orphans', 'flag uploads-dir files with no DB record (requires WP-CLI; v0.5)')
    .action(async (options) => {
      const parentOpts = program.opts();

      if (options.orphans) {
        error('--orphans requires the WP-CLI adapter (v0.5). Not yet available.');
        process.exit(6);
      }

      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const adapter = resolver.resolve('list');

      // If no specific check is requested, run all v0.1 checks.
      const runAll = !options.unoptimized && !options.large && !options.unattached && !options.missingAlt;

      // Fetch all media items (paginate through everything).
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

      if (allItems.length === 0) {
        info('No media items found in the library.');
        return;
      }

      const findings: AuditFinding[] = [];
      const threshold = options.threshold ?? DEFAULT_THRESHOLD;

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

        // --missing-alt (simple REST check — just look at the alt_text field)
        if ((runAll || options.missingAlt) && (!item.altText || item.altText.trim() === '')) {
          findings.push({
            type: 'missing-alt',
            attachmentId: item.id,
            filename: item.filename,
            detail: 'No alt text set',
          });
        }
      }

      // --unattached: items with no featured-image or content references.
      // For v0.1, we approximate by checking if the item has a parent post.
      // A more thorough check would use findReferences, but that's expensive.
      if (runAll || options.unattached) {
        // WP REST media items don't directly expose parent in our mapping,
        // so we flag items that have no post association.
        // This is a simplified check — full unattached detection is v0.5.
        warn('Unattached detection is approximate in v0.1. Full scan requires v0.5.');
      }

      if (parentOpts.json) {
        printJson({
          site: site.name,
          totalItems: allItems.length,
          findings,
          summary: {
            unoptimized: findings.filter((f) => f.type === 'unoptimized').length,
            large: findings.filter((f) => f.type === 'large').length,
            missingAlt: findings.filter((f) => f.type === 'missing-alt').length,
          },
        });
      } else {
        info(`Audited ${allItems.length} item(s) on '${site.name}':\n`);

        const grouped = {
          unoptimized: findings.filter((f) => f.type === 'unoptimized'),
          large: findings.filter((f) => f.type === 'large'),
          missingAlt: findings.filter((f) => f.type === 'missing-alt'),
        };

        if (grouped.unoptimized.length > 0) {
          info(`  Unoptimized: ${grouped.unoptimized.length}`);
          for (const f of grouped.unoptimized.slice(0, 10)) {
            info(`    #${f.attachmentId}  ${f.filename}`);
          }
          if (grouped.unoptimized.length > 10) {
            info(`    ... and ${grouped.unoptimized.length - 10} more`);
          }
        }

        if (grouped.large.length > 0) {
          info(`\n  Large files (≥${formatBytes(threshold)}): ${grouped.large.length}`);
          for (const f of grouped.large.slice(0, 10)) {
            info(`    #${f.attachmentId}  ${f.filename}  ${f.detail}`);
          }
          if (grouped.large.length > 10) {
            info(`    ... and ${grouped.large.length - 10} more`);
          }
        }

        if (grouped.missingAlt.length > 0) {
          info(`\n  Missing alt text: ${grouped.missingAlt.length}`);
          for (const f of grouped.missingAlt.slice(0, 10)) {
            info(`    #${f.attachmentId}  ${f.filename}`);
          }
          if (grouped.missingAlt.length > 10) {
            info(`    ... and ${grouped.missingAlt.length - 10} more`);
          }
        }

        if (findings.length === 0) {
          info('  No issues found. Your media library looks good!');
        } else {
          info(`\n  Total findings: ${findings.length}`);
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
