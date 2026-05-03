/**
 * `localpress show <id>` — show metadata, dimensions, and processing history
 * for a single attachment.
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson } from '../utils/output.ts';

export function registerShowCommand(program: Command): void {
  program
    .command('show <id>')
    .description('Show metadata and optimization history for an attachment')
    .action(async (idStr: string) => {
      const parentOpts = program.opts();
      const id = Number.parseInt(idStr, 10);
      if (Number.isNaN(id)) {
        error(`Invalid attachment ID: ${idStr}`);
        process.exit(2);
      }

      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const adapter = resolver.resolve('get');

      let item: import('../../adapters/types.ts').MediaItem;
      try {
        item = await adapter.getMedia(id);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(4);
        return;
      }

      // Try to load processing history from SQLite.
      let lastProcessing = null;
      try {
        const db = SiteDb.init(getSiteDbPath(site.name));
        lastProcessing = db.getLastProcessing(site.name, id);
        db.close();
      } catch {
        // DB may not exist yet — that's fine.
      }

      if (parentOpts.json) {
        printJson({ ...item, lastProcessing });
      } else {
        info(`Attachment #${item.id}`);
        info(`  Title:       ${item.title}`);
        info(`  Filename:    ${item.filename}`);
        info(`  URL:         ${item.url}`);
        info(`  MIME type:   ${item.mimeType}`);
        if (item.width && item.height) {
          info(`  Dimensions:  ${item.width}×${item.height}`);
        }
        if (item.sizeBytes) {
          info(`  Size:        ${formatBytes(item.sizeBytes)}`);
        }
        if (item.altText) {
          info(`  Alt text:    ${item.altText}`);
        }
        info(`  Uploaded:    ${item.uploadedAt}`);

        if (item.sizes && Object.keys(item.sizes).length > 0) {
          info('  Sizes:');
          for (const [name, size] of Object.entries(item.sizes)) {
            const sizeStr = size.sizeBytes ? ` (${formatBytes(size.sizeBytes)})` : '';
            info(`    ${name}: ${size.width}×${size.height}${sizeStr}`);
          }
        }

        if (lastProcessing) {
          info('');
          info('  Last processing:');
          info(`    Operation:  ${lastProcessing.operation}`);
          info(`    Status:     ${lastProcessing.status}`);
          if (lastProcessing.bytesBefore && lastProcessing.bytesAfter) {
            const saved = lastProcessing.bytesBefore - lastProcessing.bytesAfter;
            const pct = ((saved / lastProcessing.bytesBefore) * 100).toFixed(1);
            info(
              `    Size:       ${formatBytes(lastProcessing.bytesBefore)} → ${formatBytes(lastProcessing.bytesAfter)} (${pct}% reduction)`,
            );
          }
          if (lastProcessing.durationMs) {
            info(`    Duration:   ${lastProcessing.durationMs}ms`);
          }
          info(`    Ran at:     ${new Date(lastProcessing.ranAt).toISOString()}`);
        } else {
          info('');
          info('  Not yet processed by localpress.');
        }
      }
    });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
