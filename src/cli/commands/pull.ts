/**
 * `localpress pull <ids> [--to <dir>]` — download attachments without processing.
 *
 * Useful for offline backups, manual review, or piping into other tools.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { MediaItem } from '../../adapters/types.ts';
import { downloadToBuffer } from '../../engine/network/download.ts';
import { forEachConcurrent, resolveConcurrency, sortResultsById } from '../utils/concurrency.ts';
import { loadConfig, resolveActiveSite } from '../utils/config.ts';
import { parseAttachmentIds } from '../utils/ids.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

export function registerPullCommand(program: Command): void {
  program
    .command('pull <ids...>')
    .description('Download attachments to a local directory without processing')
    .option('--to <dir>', 'destination directory (default: current working dir)')
    .option('--include-sizes', 'also download all generated thumbnail/medium/large variants')
    .option('--force', 'overwrite local files that already exist')
    .action(async (idStrs: string[], options) => {
      const parentOpts = program.opts();
      const ids = parseAttachmentIds(idStrs);

      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const adapter = resolver.resolve('get');
      const { effective: concurrency } = resolveConcurrency(
        parentOpts.concurrency,
        config.defaults?.concurrency,
      );

      const destDir = options.to ?? process.cwd();
      mkdirSync(destDir, { recursive: true });

      const force = Boolean(options.force);
      const usedNames = new Set<string>();
      const results: Array<{
        id: number;
        filename: string;
        path: string;
        sizeBytes: number;
        skipped: boolean;
      }> = [];
      let failures = 0;

      const items: MediaItem[] = [];
      await forEachConcurrent(ids, concurrency, async (id) => {
        try {
          items.push(await adapter.getMedia(id));
        } catch (err) {
          error(`  ✗ #${id}: ${err instanceof Error ? err.message : String(err)}`);
          failures++;
        }
      });

      // Reserve every destination path before parallel downloads begin. This
      // keeps duplicate-name handling deterministic regardless of network order.
      sortResultsById(items, ids);
      const plans = items.map((item) => ({
        item,
        destination: resolveDestPath(destDir, item.filename, item.id, usedNames, force),
        variants:
          options.includeSizes && item.sizes
            ? Object.entries(item.sizes).map(([sizeName, size]) => ({
                sizeName,
                size,
                destination: resolveDestPath(destDir, size.filename, item.id, usedNames, force),
              }))
            : [],
      }));

      await forEachConcurrent(plans, concurrency, async ({ item, destination, variants }) => {
        try {
          // Download the source file.
          const { bytes } = await downloadToBuffer(item.url);
          const { path: destPath, name, skipped } = destination;

          if (skipped) {
            warn(
              `  ⊘ #${item.id}  ${name}  already exists locally — skipping (use --force to overwrite)`,
            );
          } else {
            await Bun.write(destPath, bytes);
            info(`  ✓ #${item.id}  ${name}  (${formatBytes(bytes.byteLength)})`);
          }

          results.push({
            id: item.id,
            filename: name,
            path: destPath,
            sizeBytes: bytes.byteLength,
            skipped,
          });

          // Download variant sizes if requested.
          if (variants.length > 0) {
            for (const { sizeName, size, destination: sizeDestination } of variants) {
              try {
                const { bytes: sizeBytes } = await downloadToBuffer(size.url);
                const {
                  path: sizePath,
                  name: sizeFilename,
                  skipped: sizeSkipped,
                } = sizeDestination;

                if (sizeSkipped) {
                  warn(`    ↳ ${sizeName}: ${sizeFilename}  already exists locally — skipping`);
                  continue;
                }

                await Bun.write(sizePath, sizeBytes);
                info(`    ↳ ${sizeName}: ${sizeFilename}  (${formatBytes(sizeBytes.byteLength)})`);
              } catch {
                warn(`    ↳ ${sizeName}: failed to download`);
              }
            }
          }
        } catch (err) {
          error(`  ✗ #${item.id}: ${err instanceof Error ? err.message : String(err)}`);
          failures++;
        }
      });

      sortResultsById(results, ids);

      if (parentOpts.json) {
        printJson({ downloaded: results, failures });
      }

      if (failures > 0) {
        process.exit(1);
      }
    });
}

/**
 * Picks a destination path for a downloaded file, uniquifying against names
 * already claimed in this run and refusing to clobber pre-existing files
 * unless `force` is set.
 */
export function resolveDestPath(
  destDir: string,
  filename: string,
  id: number,
  usedNames: Set<string>,
  force: boolean,
): { path: string; name: string; skipped: boolean } {
  const original = basename(filename);
  let name = original;

  if (usedNames.has(name)) {
    name = uniquify(original, `-${id}`);
    let suffix = 2;
    while (usedNames.has(name)) {
      name = uniquify(original, `-${suffix}`);
      suffix++;
    }
  }

  const path = join(destDir, name);
  const skipped = !force && existsSync(path);

  usedNames.add(name);

  return { path, name, skipped };
}

function uniquify(filename: string, suffix: string): string {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0) return `${filename}${suffix}`;
  return `${filename.slice(0, dotIndex)}${suffix}${filename.slice(dotIndex)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
