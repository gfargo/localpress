/**
 * `localpress export [ids...] [--to <path>]` — export media library items
 * as a ZIP archive or directory, preserving the WP uploads directory structure.
 *
 * Supports filtering (--all, --unoptimized, --type, --since, --larger-than)
 * and includes a manifest.json with metadata for each exported item.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { ListFilters, MediaItem } from '../../adapters/types.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { parseIntOption } from '../utils/args.ts';
import { getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

/** Metadata written alongside exported files for re-import. */
interface ExportManifest {
  version: 1;
  site: string;
  siteUrl: string;
  exportedAt: string;
  items: ExportManifestItem[];
  totalBytes: number;
}

interface ExportManifestItem {
  id: number;
  filename: string;
  relativePath: string;
  url: string;
  mimeType: string;
  width?: number;
  height?: number;
  sizeBytes: number;
  altText?: string;
  caption?: string;
  description?: string;
  title: string;
  uploadedAt: string;
  sha256: string;
}

export function registerExportCommand(program: Command): void {
  program
    .command('export [ids...]')
    .description('Export media library items as a ZIP or directory')
    .option('--to <path>', 'destination path (directory or .zip file)')
    .option('--all', 'export all media items')
    .option('--unoptimized', "only items localpress hasn't processed yet")
    .option('--type <mime>', 'MIME type filter (e.g. image/jpeg)')
    .option('--since <date>', 'only items uploaded since this ISO date')
    .option('--larger-than <bytes>', 'minimum size in bytes', parseIntOption('--larger-than'))
    .option('--include-sizes', 'also export generated thumbnail/medium/large variants')
    .option('--flat', 'export all files into a single flat directory (no subdirectories)')
    .action(async (idStrs: string[], options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);

      // Determine which items to export.
      let items: MediaItem[] = [];

      if (idStrs.length > 0) {
        // Explicit IDs provided.
        const ids = idStrs.map((s) => Number.parseInt(s, 10));
        if (ids.some(Number.isNaN)) {
          error('All arguments must be valid attachment IDs (integers).');
          process.exit(2);
        }

        const adapter = resolver.resolve('get');
        for (const id of ids) {
          try {
            const item = await adapter.getMedia(id);
            items.push(item);
          } catch (err) {
            error(`  ✗ #${id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } else if (
        options.all ||
        options.unoptimized ||
        options.type ||
        options.since ||
        options.largerThan
      ) {
        // Filter-based export — fetch all matching items.
        const adapter = resolver.resolve('list');
        const filters: ListFilters = {
          type: options.type,
          since: options.since,
          largerThan: options.largerThan,
          perPage: 100,
          page: 1,
        };

        // Paginate through all results.
        let page = 1;
        while (true) {
          const result = await adapter.listMediaPage({ ...filters, page });
          items.push(...result.items);
          if (page >= result.totalPages) break;
          page++;
        }

        // Client-side filter: --unoptimized.
        if (options.unoptimized) {
          try {
            const db = SiteDb.init(getSiteDbPath(site.name));
            const processed = db.listProcessedWpIds(site.name);
            items = items.filter((item) => !processed.has(item.id));
            db.close();
          } catch {
            // If the DB doesn't exist yet, all items are unoptimized.
          }
        }
      } else {
        error(
          'Specify attachment IDs or use --all / --unoptimized / --type / --since / --larger-than to select items.',
        );
        process.exit(2);
      }

      if (items.length === 0) {
        info('No media items found matching the given criteria.');
        return;
      }

      // Determine output destination.
      const destPath = options.to ?? `localpress-export-${Date.now()}`;
      const isZip = destPath.endsWith('.zip');

      if (parentOpts.dryRun) {
        info(`Would export ${items.length} item(s) to ${destPath}`);
        if (parentOpts.json) {
          printJson({
            action: 'dry-run',
            itemCount: items.length,
            destination: destPath,
            items: items.map((i) => ({ id: i.id, filename: i.filename })),
          });
        }
        return;
      }

      info(`Exporting ${items.length} item(s) to ${destPath}...`);

      // Download all items.
      const manifestItems: ExportManifestItem[] = [];
      let totalBytes = 0;
      let failures = 0;

      // For ZIP mode, collect file entries; for directory mode, write directly.
      const zipEntries: Array<{ path: string; data: Buffer }> = [];

      // Create output directory if not ZIP.
      if (!isZip) {
        mkdirSync(destPath, { recursive: true });
      }

      for (const item of items) {
        try {
          // Download the source file.
          const response = await fetch(item.url);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} downloading ${item.url}`);
          }
          const bytes = Buffer.from(await response.arrayBuffer());
          const hash = createHash('sha256').update(bytes).digest('hex');

          // Determine relative path — try to preserve WP uploads structure.
          const relativePath = options.flat
            ? item.filename
            : deriveRelativePath(item.url, item.filename);

          if (isZip) {
            zipEntries.push({ path: relativePath, data: bytes });
          } else {
            const fullPath = join(destPath, relativePath);
            mkdirSync(dirname(fullPath), { recursive: true });
            await Bun.write(fullPath, bytes);
          }

          manifestItems.push({
            id: item.id,
            filename: item.filename,
            relativePath,
            url: item.url,
            mimeType: item.mimeType,
            width: item.width,
            height: item.height,
            sizeBytes: bytes.length,
            altText: item.altText,
            caption: item.caption,
            description: item.description,
            title: item.title,
            uploadedAt: item.uploadedAt,
            sha256: hash,
          });

          totalBytes += bytes.length;
          info(`  ✓ #${item.id}  ${item.filename}  (${formatBytes(bytes.length)})`);

          // Download variant sizes if requested.
          if (options.includeSizes && item.sizes) {
            for (const [sizeName, size] of Object.entries(item.sizes)) {
              try {
                const sizeResponse = await fetch(size.url);
                if (!sizeResponse.ok) continue;
                const sizeBytes = Buffer.from(await sizeResponse.arrayBuffer());
                const sizeRelPath = options.flat
                  ? size.filename
                  : deriveRelativePath(size.url, size.filename);

                if (isZip) {
                  zipEntries.push({ path: sizeRelPath, data: sizeBytes });
                } else {
                  const sizePath = join(destPath, sizeRelPath);
                  mkdirSync(dirname(sizePath), { recursive: true });
                  await Bun.write(sizePath, sizeBytes);
                }

                totalBytes += sizeBytes.length;
                info(`    ↳ ${sizeName}: ${size.filename}  (${formatBytes(sizeBytes.length)})`);
              } catch {
                warn(`    ↳ ${sizeName}: failed to download`);
              }
            }
          }
        } catch (err) {
          error(`  ✗ #${item.id}: ${err instanceof Error ? err.message : String(err)}`);
          failures++;
        }
      }

      // Write manifest.
      const manifest: ExportManifest = {
        version: 1,
        site: site.name,
        siteUrl: site.url,
        exportedAt: new Date().toISOString(),
        items: manifestItems,
        totalBytes,
      };

      if (isZip) {
        // Build ZIP using Bun's built-in zip support (via JSZip-like approach).
        // We use a simple ZIP implementation with the 'archiver' pattern.
        const zipBuffer = await buildZip(zipEntries, manifest);
        mkdirSync(dirname(destPath), { recursive: true });
        await Bun.write(destPath, zipBuffer);
      } else {
        const manifestPath = join(destPath, 'manifest.json');
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      }

      // Summary.
      const exported = manifestItems.length;
      info(`\n✓ Exported ${exported} item(s), ${formatBytes(totalBytes)} total → ${destPath}`);
      if (failures > 0) {
        warn(`${failures} item(s) failed to download.`);
      }

      if (parentOpts.json) {
        printJson({
          action: 'exported',
          destination: destPath,
          format: isZip ? 'zip' : 'directory',
          exported,
          failures,
          totalBytes,
          items: manifestItems.map((i) => ({
            id: i.id,
            filename: i.filename,
            relativePath: i.relativePath,
            sizeBytes: i.sizeBytes,
          })),
        });
      }

      if (failures > 0) {
        process.exit(1);
      }
    });
}

// -- Helpers ------------------------------------------------------------------

/**
 * Derive a relative path from the WP URL, preserving the uploads directory
 * structure (e.g. "2026/05/photo.jpg").
 */
function deriveRelativePath(url: string, fallbackFilename: string): string {
  try {
    const urlPath = new URL(url).pathname;
    // WordPress uploads typically live at /wp-content/uploads/YYYY/MM/filename.ext
    const uploadsMatch = urlPath.match(/\/wp-content\/uploads\/(.+)$/);
    if (uploadsMatch) {
      return uploadsMatch[1];
    }
    // Fallback: just use the filename from the URL path.
    return basename(urlPath);
  } catch {
    return fallbackFilename;
  }
}

/**
 * Build a ZIP file from entries using Bun's native capabilities.
 * Uses the deflate compression available in Bun's zlib.
 */
async function buildZip(
  entries: Array<{ path: string; data: Buffer }>,
  manifest: ExportManifest,
): Promise<Buffer> {
  // Add manifest to entries.
  const allEntries = [
    ...entries,
    { path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
  ];

  // Use a simple ZIP builder (store method for simplicity and speed).
  // ZIP format: local file headers + data + central directory + end record.
  const parts: Buffer[] = [];
  const centralDir: Buffer[] = [];
  let offset = 0;

  for (const entry of allEntries) {
    const pathBuf = Buffer.from(entry.path, 'utf-8');
    const data = entry.data;

    // Local file header (store, no compression for speed).
    const localHeader = Buffer.alloc(30 + pathBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // compression (store)
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    const crc = crc32(data);
    localHeader.writeUInt32LE(crc, 14); // crc-32
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(pathBuf.length, 26); // filename length
    localHeader.writeUInt16LE(0, 28); // extra field length
    pathBuf.copy(localHeader, 30);

    parts.push(localHeader, data);

    // Central directory entry.
    const cdEntry = Buffer.alloc(46 + pathBuf.length);
    cdEntry.writeUInt32LE(0x02014b50, 0); // signature
    cdEntry.writeUInt16LE(20, 4); // version made by
    cdEntry.writeUInt16LE(20, 6); // version needed
    cdEntry.writeUInt16LE(0, 8); // flags
    cdEntry.writeUInt16LE(0, 10); // compression
    cdEntry.writeUInt16LE(0, 12); // mod time
    cdEntry.writeUInt16LE(0, 14); // mod date
    cdEntry.writeUInt32LE(crc, 16); // crc-32
    cdEntry.writeUInt32LE(data.length, 20); // compressed size
    cdEntry.writeUInt32LE(data.length, 24); // uncompressed size
    cdEntry.writeUInt16LE(pathBuf.length, 28); // filename length
    cdEntry.writeUInt16LE(0, 30); // extra field length
    cdEntry.writeUInt16LE(0, 32); // comment length
    cdEntry.writeUInt16LE(0, 34); // disk number start
    cdEntry.writeUInt16LE(0, 36); // internal attrs
    cdEntry.writeUInt32LE(0, 38); // external attrs
    cdEntry.writeUInt32LE(offset, 42); // relative offset of local header
    pathBuf.copy(cdEntry, 46);

    centralDir.push(cdEntry);
    offset += localHeader.length + data.length;
  }

  const centralDirBuf = Buffer.concat(centralDir);
  const centralDirOffset = offset;

  // End of central directory record.
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0); // signature
  endRecord.writeUInt16LE(0, 4); // disk number
  endRecord.writeUInt16LE(0, 6); // disk with central dir
  endRecord.writeUInt16LE(allEntries.length, 8); // entries on this disk
  endRecord.writeUInt16LE(allEntries.length, 10); // total entries
  endRecord.writeUInt32LE(centralDirBuf.length, 12); // central dir size
  endRecord.writeUInt32LE(centralDirOffset, 16); // central dir offset
  endRecord.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...parts, centralDirBuf, endRecord]);
}

/** CRC-32 computation for ZIP file entries. */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
