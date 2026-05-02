/**
 * `localpress pull <ids> [--to <dir>]` — download attachments without processing.
 *
 * Useful for offline backups, manual review, or piping into other tools.
 */

import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import { loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

export function registerPullCommand(program: Command): void {
  program
    .command('pull <ids...>')
    .description('Download attachments to a local directory without processing')
    .option('--to <dir>', 'destination directory (default: current working dir)')
    .option('--include-sizes', 'also download all generated thumbnail/medium/large variants')
    .action(async (idStrs: string[], options) => {
      const parentOpts = program.opts();
      const ids = idStrs.map((s) => Number.parseInt(s, 10));
      if (ids.some(Number.isNaN)) {
        error('All arguments must be valid attachment IDs (integers).');
        process.exit(2);
      }

      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const adapter = resolver.resolve('get');

      const destDir = options.to ?? process.cwd();
      mkdirSync(destDir, { recursive: true });

      const results: Array<{ id: number; filename: string; path: string; sizeBytes: number }> = [];
      let failures = 0;

      for (const id of ids) {
        try {
          const item = await adapter.getMedia(id);

          // Download the source file.
          const response = await fetch(item.url);
          if (!response.ok) {
            throw new Error(`Failed to download ${item.url}: ${response.status}`);
          }
          const bytes = await response.arrayBuffer();
          const filename = basename(item.filename);
          const destPath = join(destDir, filename);

          await Bun.write(destPath, bytes);

          results.push({
            id: item.id,
            filename,
            path: destPath,
            sizeBytes: bytes.byteLength,
          });

          info(`  ✓ #${item.id}  ${filename}  (${formatBytes(bytes.byteLength)})`);

          // Download variant sizes if requested.
          if (options.includeSizes && item.sizes) {
            for (const [sizeName, size] of Object.entries(item.sizes)) {
              try {
                const sizeResponse = await fetch(size.url);
                if (!sizeResponse.ok) continue;
                const sizeBytes = await sizeResponse.arrayBuffer();
                const sizeFilename = basename(size.filename);
                const sizePath = join(destDir, sizeFilename);
                await Bun.write(sizePath, sizeBytes);
                info(`    ↳ ${sizeName}: ${sizeFilename}  (${formatBytes(sizeBytes.byteLength)})`);
              } catch {
                warn(`    ↳ ${sizeName}: failed to download`);
              }
            }
          }
        } catch (err) {
          error(`  ✗ #${id}: ${err instanceof Error ? err.message : String(err)}`);
          failures++;
        }
      }

      if (parentOpts.json) {
        printJson({ downloaded: results, failures });
      }

      if (failures > 0) {
        process.exit(1);
      }
    });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
