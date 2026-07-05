/**
 * `localpress export [ids...] [--to <path>]` — export media library items
 * as a ZIP archive or directory, preserving the WP uploads directory structure.
 *
 * Supports filtering (--all, --unoptimized, --type, --since, --larger-than)
 * and includes a manifest.json with metadata for each exported item.
 */

import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { ListFilters, MediaItem } from '../../adapters/types.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { ExitCode } from '../../types.ts';
import { parseIntOption } from '../utils/args.ts';
import { getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { parseAttachmentIds } from '../utils/ids.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

/** ZIP32 (classic ZIP) format limits — 32-bit size/offset fields, 16-bit entry count. */
export const ZIP32_MAX_ENTRIES = 0xffff;
export const ZIP32_MAX_SIZE = 0xffffffff;

/** Thrown when an archive would exceed (or does exceed, mid-stream) ZIP32 limits. */
export class ZipLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipLimitExceededError';
  }
}

function zipLimitMessage(reason: string): string {
  return `Archive would exceed ZIP32 limits (${reason}) — use directory export instead: --to ./backup-dir`;
}

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
        const ids = parseAttachmentIds(idStrs);

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

      // Fail fast, before downloading anything, if the requested ZIP would
      // exceed classic ZIP32 limits (32-bit sizes/offsets, 16-bit entry count).
      if (isZip) {
        const entryCount = estimateEntryCount(items, options);
        if (entryCount > ZIP32_MAX_ENTRIES) {
          error(
            zipLimitMessage(`${entryCount} entries > ${ZIP32_MAX_ENTRIES.toLocaleString('en-US')}`),
          );
          process.exit(ExitCode.InvalidUsage);
        }

        // Best-effort: MediaItem.sizeBytes isn't always populated by WordPress,
        // so this can under-count. The streaming writer below is the hard backstop.
        const totalBytesEstimate = estimateTotalBytes(items, options);
        if (totalBytesEstimate > ZIP32_MAX_SIZE) {
          error(zipLimitMessage(`estimated ${formatBytes(totalBytesEstimate)} > 4 GiB`));
          process.exit(ExitCode.InvalidUsage);
        }
      }

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

      // For ZIP mode, stream entries straight to disk as they download (never
      // buffering the whole archive, or every downloaded file, in memory).
      // For directory mode, write directly (unchanged).
      let zipWriter: ZipStreamWriter | null = null;
      if (isZip) {
        mkdirSync(dirname(destPath), { recursive: true });
        zipWriter = new ZipStreamWriter(destPath);
      } else {
        mkdirSync(destPath, { recursive: true });
      }

      try {
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

            if (zipWriter) {
              await zipWriter.writeEntry(relativePath, bytes);
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

                  if (zipWriter) {
                    await zipWriter.writeEntry(sizeRelPath, sizeBytes);
                  } else {
                    const sizePath = join(destPath, sizeRelPath);
                    mkdirSync(dirname(sizePath), { recursive: true });
                    await Bun.write(sizePath, sizeBytes);
                  }

                  totalBytes += sizeBytes.length;
                  info(`    ↳ ${sizeName}: ${size.filename}  (${formatBytes(sizeBytes.length)})`);
                } catch (err) {
                  if (err instanceof ZipLimitExceededError) throw err;
                  warn(`    ↳ ${sizeName}: failed to download`);
                }
              }
            }
          } catch (err) {
            if (err instanceof ZipLimitExceededError) throw err;
            error(`  ✗ #${item.id}: ${err instanceof Error ? err.message : String(err)}`);
            failures++;
          }
        }
      } catch (err) {
        if (zipWriter && err instanceof ZipLimitExceededError) {
          zipWriter.abort();
          error(err.message);
          process.exit(ExitCode.InvalidUsage);
        }
        throw err;
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

      if (zipWriter) {
        try {
          await zipWriter.writeEntry(
            'manifest.json',
            Buffer.from(JSON.stringify(manifest, null, 2)),
          );
          await zipWriter.finalize();
        } catch (err) {
          zipWriter.abort();
          if (err instanceof ZipLimitExceededError) {
            error(err.message);
            process.exit(ExitCode.InvalidUsage);
          }
          throw err;
        }
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
 * Prospective ZIP entry count for a given export selection — exact, since it
 * doesn't depend on downloads (just item count + requested variants + manifest).
 */
export function estimateEntryCount(
  items: MediaItem[],
  options: { includeSizes?: boolean },
): number {
  let count = items.length;
  if (options.includeSizes) {
    for (const item of items) {
      if (item.sizes) count += Object.keys(item.sizes).length;
    }
  }
  return count + 1; // + manifest.json
}

/**
 * Prospective total archive size in bytes — best-effort, since
 * `MediaItem.sizeBytes` / `MediaSize.sizeBytes` aren't always populated by
 * WordPress. The streaming writer's in-stream check is the hard backstop.
 */
export function estimateTotalBytes(
  items: MediaItem[],
  options: { includeSizes?: boolean },
): number {
  let total = 0;
  for (const item of items) {
    total += item.sizeBytes ?? 0;
    if (options.includeSizes && item.sizes) {
      for (const size of Object.values(item.sizes)) {
        total += size.sizeBytes ?? 0;
      }
    }
  }
  return total;
}

/**
 * Streams a classic ZIP32 archive straight to disk (via a `.tmp` file, renamed
 * on success) instead of buffering entries or the finished archive in memory.
 * Detects 4 GiB per-file / cumulative-offset overflow and the 65,535 entry cap
 * while writing, since per-item sizes aren't always known up front.
 */
export class ZipStreamWriter {
  private readonly tmpPath: string;
  private stream: ReturnType<typeof createWriteStream> | null = null;
  private readonly centralDir: Array<{ path: string; crc: number; size: number; offset: number }> =
    [];
  private offset = 0;

  constructor(private readonly destPath: string) {
    this.tmpPath = `${destPath}.tmp`;
  }

  /**
   * Open the underlying write stream lazily, on the first actual write. This
   * way an entry rejected synchronously (e.g. by a ZIP32 size check) before any
   * bytes are written never creates the `.tmp` file at all, so abort() has
   * nothing to race against.
   */
  private getStream(): ReturnType<typeof createWriteStream> {
    if (!this.stream) {
      this.stream = createWriteStream(this.tmpPath);
      // Surface write/finalize errors through the push()/finalize() promises,
      // not as an uncaught 'error' event.
      this.stream.on('error', () => {});
    }
    return this.stream;
  }

  async writeEntry(path: string, data: Buffer): Promise<void> {
    if (data.length > ZIP32_MAX_SIZE) {
      throw new ZipLimitExceededError(
        zipLimitMessage(
          `entry "${path}" (${formatBytes(data.length)}) exceeds the 4 GiB per-file limit`,
        ),
      );
    }
    if (this.offset + data.length > ZIP32_MAX_SIZE) {
      throw new ZipLimitExceededError(
        zipLimitMessage(`cumulative archive offset would exceed 4 GiB while writing "${path}"`),
      );
    }
    if (this.centralDir.length + 1 > ZIP32_MAX_ENTRIES) {
      throw new ZipLimitExceededError(
        zipLimitMessage(
          `${this.centralDir.length + 1} entries > ${ZIP32_MAX_ENTRIES.toLocaleString('en-US')}`,
        ),
      );
    }

    const pathBuf = Buffer.from(path, 'utf-8');
    const crc = crc32(data);

    // Local file header (store, no compression for speed).
    const localHeader = Buffer.alloc(30 + pathBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // compression (store)
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(crc, 14); // crc-32
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(pathBuf.length, 26); // filename length
    localHeader.writeUInt16LE(0, 28); // extra field length
    pathBuf.copy(localHeader, 30);

    await this.push(localHeader);
    await this.push(data);

    this.centralDir.push({ path, crc, size: data.length, offset: this.offset });
    this.offset += localHeader.length + data.length;
  }

  private push(buf: Buffer): Promise<void> {
    const stream = this.getStream();
    return new Promise((resolve, reject) => {
      stream.write(buf, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Writes the central directory + end-of-central-directory record, then renames `.tmp` → destPath. */
  async finalize(): Promise<void> {
    const centralDirStart = this.offset;

    for (const rec of this.centralDir) {
      const pathBuf = Buffer.from(rec.path, 'utf-8');
      const cdEntry = Buffer.alloc(46 + pathBuf.length);
      cdEntry.writeUInt32LE(0x02014b50, 0); // signature
      cdEntry.writeUInt16LE(20, 4); // version made by
      cdEntry.writeUInt16LE(20, 6); // version needed
      cdEntry.writeUInt16LE(0, 8); // flags
      cdEntry.writeUInt16LE(0, 10); // compression
      cdEntry.writeUInt16LE(0, 12); // mod time
      cdEntry.writeUInt16LE(0, 14); // mod date
      cdEntry.writeUInt32LE(rec.crc, 16); // crc-32
      cdEntry.writeUInt32LE(rec.size, 20); // compressed size
      cdEntry.writeUInt32LE(rec.size, 24); // uncompressed size
      cdEntry.writeUInt16LE(pathBuf.length, 28); // filename length
      cdEntry.writeUInt16LE(0, 30); // extra field length
      cdEntry.writeUInt16LE(0, 32); // comment length
      cdEntry.writeUInt16LE(0, 34); // disk number start
      cdEntry.writeUInt16LE(0, 36); // internal attrs
      cdEntry.writeUInt32LE(0, 38); // external attrs
      cdEntry.writeUInt32LE(rec.offset, 42); // relative offset of local header
      pathBuf.copy(cdEntry, 46);

      await this.push(cdEntry);
      this.offset += cdEntry.length;
    }

    const centralDirSize = this.offset - centralDirStart;

    // End of central directory record.
    const endRecord = Buffer.alloc(22);
    endRecord.writeUInt32LE(0x06054b50, 0); // signature
    endRecord.writeUInt16LE(0, 4); // disk number
    endRecord.writeUInt16LE(0, 6); // disk with central dir
    endRecord.writeUInt16LE(this.centralDir.length, 8); // entries on this disk
    endRecord.writeUInt16LE(this.centralDir.length, 10); // total entries
    endRecord.writeUInt32LE(centralDirSize, 12); // central dir size
    endRecord.writeUInt32LE(centralDirStart, 16); // central dir offset
    endRecord.writeUInt16LE(0, 20); // comment length
    await this.push(endRecord);

    const stream = this.getStream();
    await new Promise<void>((resolve, reject) => {
      stream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });
    renameSync(this.tmpPath, this.destPath);
  }

  /** Cleans up the `.tmp` file after an error — the destination is left untouched. */
  abort(): void {
    // If nothing was ever written, the stream (and file) were never created.
    if (!this.stream) return;
    this.stream.destroy();
    try {
      unlinkSync(this.tmpPath);
    } catch {
      // Nothing to clean up (stream may not have created the file yet).
    }
  }
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
