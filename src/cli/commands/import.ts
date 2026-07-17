/**
 * `localpress import <path> [--optimize] [--to <format>]` — bulk import local
 * files into the WordPress media library.
 *
 * Accepts a directory, a list of files, or a ZIP archive. Optionally runs the
 * optimization pipeline before uploading. Supports --preserve-metadata
 * (formerly --preserve-ids) to reapply metadata (alt/title/caption) from a
 * previous export manifest, matched by each file's path relative to the
 * import root so same-basename files in different `YYYY/MM` directories
 * don't collide. Prints an old→new attachment ID mapping afterward so
 * references can be rewritten with `localpress references --update-to`.
 *
 * This is the counterpart to `localpress export` — together they enable
 * site migrations, bulk content imports, and backup/restore workflows.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { UploadMetadata } from '../../adapters/types.ts';
import { optimizeImage } from '../../engine/image/optimize.ts';
import type { ImageFormat } from '../../engine/image/types.ts';
import { parseIntOption } from '../utils/args.ts';
import { loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';
import { resolveDryRun } from '../utils/run-mode.ts';

/** Image extensions we recognize for import. */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.svg']);

/** Manifest shape from `localpress export`. */
export interface ExportManifest {
  version: 1;
  site: string;
  siteUrl: string;
  exportedAt: string;
  items: Array<{
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
  }>;
  totalBytes: number;
}

type ManifestItem = ExportManifest['items'][number];

/** A file queued for import, with its path relative to the import root (if known). */
export interface ImportFile {
  path: string;
  relativePath: string | null;
}

interface ImportResult {
  file: string;
  attachmentId: number;
  filename: string;
  sizeBytes: number;
  optimized?: boolean;
  originalSize?: number;
  oldId?: number;
}

/** Lookup indexes built from an export manifest for metadata matching. */
export interface ManifestIndex {
  byRelativePath: Map<string, ManifestItem>;
  /** `null` marks a basename that appears more than once (ambiguous, unusable as a fallback). */
  byBasename: Map<string, ManifestItem | null>;
}

export interface ManifestResolution {
  item: ManifestItem | undefined;
  /** True when the file's basename matched more than one manifest entry and no relativePath match was found. */
  ambiguous: boolean;
}

function normalizeRelativePath(p: string): string {
  return p.split(sep).join('/');
}

function isImageFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function mimeFromPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.avif':
      return 'image/avif';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Recursively collect all image files from a directory, along with each
 * file's path relative to `dir` (POSIX-style, to match export manifests).
 */
export function collectImageFiles(dir: string): ImportFile[] {
  const files: ImportFile[] = [];

  function walk(currentDir: string): void {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden directories and common non-content dirs.
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        walk(fullPath);
      } else if (entry.isFile() && isImageFile(entry.name)) {
        files.push({
          path: fullPath,
          relativePath: normalizeRelativePath(relative(dir, fullPath)),
        });
      }
    }
  }

  walk(dir);
  return files;
}

/**
 * Build lookup indexes from an export manifest: an exact index by
 * relative path, and a basename index that's only safe to use when the
 * basename is unique across the manifest (ambiguous basenames map to `null`).
 */
export function buildManifestIndex(manifest: ExportManifest): ManifestIndex {
  const byRelativePath = new Map<string, ManifestItem>();
  const byBasename = new Map<string, ManifestItem | null>();

  for (const item of manifest.items) {
    byRelativePath.set(normalizeRelativePath(item.relativePath), item);

    const base = basename(item.filename);
    if (byBasename.has(base)) {
      byBasename.set(base, null);
    } else {
      byBasename.set(base, item);
    }
  }

  return { byRelativePath, byBasename };
}

/**
 * Resolve a file's manifest metadata: exact relative-path match first,
 * falling back to basename only when it's unambiguous across the manifest.
 */
export function resolveManifestItem(index: ManifestIndex, file: ImportFile): ManifestResolution {
  if (file.relativePath) {
    const match = index.byRelativePath.get(normalizeRelativePath(file.relativePath));
    if (match) return { item: match, ambiguous: false };
  }

  const base = basename(file.path);
  if (index.byBasename.has(base)) {
    const match = index.byBasename.get(base);
    if (match) return { item: match, ambiguous: false };
    return { item: undefined, ambiguous: true };
  }

  return { item: undefined, ambiguous: false };
}

export function registerImportCommand(program: Command): void {
  program
    .command('import <paths...>')
    .description('Import local files or directories into the WordPress media library')
    .option('--optimize', 'run the optimization pipeline before uploading')
    .option('--quality <n>', 'optimization quality (1-100)', parseIntOption('--quality'))
    .option('--to <format>', 'convert to format before uploading (webp, avif, jpeg, png)')
    .option('--max-width <n>', 'max width in pixels', parseIntOption('--max-width'))
    .option('--max-height <n>', 'max height in pixels', parseIntOption('--max-height'))
    .option('--title <title>', 'default title for imported items (overridden by manifest)')
    .option('--alt <text>', 'default alt text for imported items')
    .option('--post <id>', 'attach all imports to this post', parseIntOption('--post'))
    .option(
      '--preserve-metadata',
      'use manifest metadata (alt, title, caption) from a previous export',
    )
    .option('--preserve-ids', '(deprecated, use --preserve-metadata) same as --preserve-metadata')
    .option('--strip-metadata', 'strip EXIF/ICC metadata during optimization')
    .action(async (paths: string[], options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const uploadAdapter = resolver.resolve('upload');

      const concurrency = parentOpts.concurrency ?? Math.max(1, cpus().length - 1);

      if (options.preserveIds && !options.preserveMetadata) {
        warn('--preserve-ids is deprecated; use --preserve-metadata instead.');
      }
      const preserveMetadata = Boolean(options.preserveMetadata || options.preserveIds);

      // Collect all files to import.
      const filesToImport: ImportFile[] = [];
      let manifest: ExportManifest | null = null;

      for (const inputPath of paths) {
        const resolved = resolve(inputPath);

        if (!existsSync(resolved)) {
          error(`Path not found: ${inputPath}`);
          process.exit(2);
        }

        const stat = statSync(resolved);

        if (stat.isDirectory()) {
          // Check for manifest.json (from a previous export).
          const manifestPath = join(resolved, 'manifest.json');
          if (existsSync(manifestPath)) {
            try {
              const manifestText = readFileSync(manifestPath, 'utf-8');
              manifest = JSON.parse(manifestText) as ExportManifest;
              info(`Found export manifest (${manifest.items.length} items from ${manifest.site})`);
            } catch {
              warn('Found manifest.json but could not parse it. Importing without metadata.');
            }
          }

          filesToImport.push(...collectImageFiles(resolved));
        } else if (stat.isFile()) {
          if (resolved.endsWith('.zip')) {
            // Extract ZIP and collect files.
            let extracted: ExtractedZip;
            try {
              extracted = await extractZip(resolved);
            } catch (err) {
              error(err instanceof Error ? err.message : String(err));
              process.exit(2);
            }
            filesToImport.push(...extracted.files);
            if (extracted.manifest) {
              manifest = extracted.manifest;
              info(
                `Found export manifest in ZIP (${manifest.items.length} items from ${manifest.site})`,
              );
            }
          } else if (isImageFile(resolved)) {
            filesToImport.push({ path: resolved, relativePath: null });
          } else {
            warn(`Skipping non-image file: ${inputPath}`);
          }
        }
      }

      if (filesToImport.length === 0) {
        info('No image files found to import.');
        return;
      }

      const manifestIndex = manifest && preserveMetadata ? buildManifestIndex(manifest) : null;

      if (resolveDryRun(parentOpts, false)) {
        info(`Would import ${filesToImport.length} file(s) to ${site.name} (${site.url})`);
        if (options.optimize) info(`  with optimization (quality=${options.quality ?? 'default'})`);
        if (options.to) info(`  converting to: ${options.to}`);
        if (parentOpts.json) {
          printJson({
            action: 'dry-run',
            fileCount: filesToImport.length,
            site: site.name,
            files: filesToImport.map((f) => basename(f.path)),
          });
        }
        return;
      }

      info(`Importing ${filesToImport.length} file(s) to ${site.name} (${site.url})...`);
      if (options.optimize)
        info(`  Optimization: enabled (quality=${options.quality ?? 'default'})`);
      if (options.to) info(`  Convert to: ${options.to}`);
      info('');

      const results: ImportResult[] = [];
      let failures = 0;
      let totalOriginalBytes = 0;
      let totalUploadedBytes = 0;

      // Process files with concurrency control.
      const queue = [...filesToImport];
      const inFlight: Promise<void>[] = [];

      async function processFile(entry: ImportFile): Promise<void> {
        const filePath = entry.path;
        const filename = basename(filePath);

        try {
          const file = Bun.file(filePath);
          let fileBuffer = Buffer.from(await file.arrayBuffer());
          const originalSize = fileBuffer.length;
          totalOriginalBytes += originalSize;

          const mime = mimeFromPath(filePath);
          let optimized = false;

          // Optimize if requested.
          if (options.optimize || options.to) {
            try {
              const optimizeOpts = {
                quality: options.quality,
                toFormat: options.to as ImageFormat | undefined,
                maxWidth: options.maxWidth,
                maxHeight: options.maxHeight,
                stripMetadata: options.stripMetadata,
              };

              const result = await optimizeImage(fileBuffer, mime, optimizeOpts);
              fileBuffer = Buffer.from(result.bytes);
              optimized = true;
            } catch (err) {
              warn(
                `  ⚠ Optimization failed for ${filename}: ${err instanceof Error ? err.message : String(err)}. Uploading original.`,
              );
            }
          }

          totalUploadedBytes += fileBuffer.length;

          // Build upload metadata.
          const meta: UploadMetadata = { filename };
          let oldId: number | undefined;

          if (manifestIndex) {
            const resolution = resolveManifestItem(manifestIndex, entry);
            if (resolution.item) {
              meta.title = resolution.item.title;
              meta.altText = resolution.item.altText ?? undefined;
              meta.caption = resolution.item.caption ?? undefined;
              meta.description = resolution.item.description ?? undefined;
              oldId = resolution.item.id;
            } else {
              if (resolution.ambiguous) {
                warn(
                  `  ⚠ Ambiguous manifest match for ${filename} (multiple exported files share this name); using defaults instead of manifest metadata.`,
                );
              }
              if (options.title) meta.title = options.title;
              if (options.alt) meta.altText = options.alt;
            }
          } else {
            // Apply command-level defaults.
            if (options.title) meta.title = options.title;
            if (options.alt) meta.altText = options.alt;
          }

          if (options.post) meta.postId = options.post;

          // Upload.
          const result = await uploadAdapter.upload(fileBuffer, meta);

          results.push({
            file: filename,
            attachmentId: result.id,
            filename: result.filename,
            sizeBytes: fileBuffer.length,
            optimized,
            originalSize: optimized ? originalSize : undefined,
            oldId,
          });

          const optimizeInfo = optimized
            ? ` (${formatBytes(originalSize)} → ${formatBytes(fileBuffer.length)})`
            : '';
          info(`  ✓ ${filename} → #${result.id}${optimizeInfo}`);
        } catch (err) {
          error(`  ✗ ${filename}: ${err instanceof Error ? err.message : String(err)}`);
          failures++;
        }
      }

      // Process with concurrency limit.
      for (const entry of queue) {
        if (inFlight.length >= concurrency) {
          await Promise.race(inFlight);
        }

        const promise = processFile(entry).then(() => {
          const idx = inFlight.indexOf(promise);
          if (idx >= 0) inFlight.splice(idx, 1);
        });
        inFlight.push(promise);
      }

      // Wait for remaining in-flight operations.
      await Promise.all(inFlight);

      // Summary.
      const imported = results.length;
      const idMappings = results
        .filter((r): r is ImportResult & { oldId: number } => r.oldId !== undefined)
        .map((r) => ({ oldId: r.oldId, newId: r.attachmentId }));

      info(`\n✓ Imported ${imported} file(s), ${failures} failure(s).`);
      info(`  Total uploaded: ${formatBytes(totalUploadedBytes)}`);
      if (options.optimize && totalOriginalBytes > totalUploadedBytes) {
        const saved = totalOriginalBytes - totalUploadedBytes;
        const pct = ((saved / totalOriginalBytes) * 100).toFixed(1);
        info(`  Saved: ${formatBytes(saved)} (-${pct}% from optimization)`);
      }

      if (idMappings.length > 0) {
        info(`\nAttachment ID mappings from the previous export (${idMappings.length}):`);
        for (const m of idMappings) {
          info(
            `  #${m.oldId} → #${m.newId}   (localpress references ${m.oldId} --update-to ${m.newId})`,
          );
        }
      }

      if (parentOpts.json) {
        printJson({
          action: 'imported',
          site: site.name,
          imported,
          failures,
          totalUploadedBytes,
          totalOriginalBytes,
          items: results,
          idMappings,
        });
      }

      if (failures > 0) {
        process.exit(1);
      }
    });
}

// -- ZIP extraction -----------------------------------------------------------

interface ExtractedZip {
  files: ImportFile[];
  manifest: ExportManifest | null;
}

/**
 * Extract a ZIP file to a temporary directory and return the paths of image files.
 * Also extracts manifest.json if present.
 */
async function extractZip(zipPath: string): Promise<ExtractedZip> {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const tempDir = mkdtempSync(join(tmpdir(), 'localpress-import-'));

  const zipBuffer = readFileSync(zipPath);
  const entries = parseZip(zipBuffer);

  const files: ImportFile[] = [];
  let manifest: ExportManifest | null = null;

  const { mkdirSync } = await import('node:fs');
  const { dirname, resolve, sep } = await import('node:path');
  const tempRoot = resolve(tempDir);

  for (const entry of entries) {
    // Zip Slip guard: reject entries that would resolve outside the temp dir
    // (absolute paths or `../` traversal in a malicious archive).
    const destPath = resolve(tempRoot, entry.path);
    if (destPath !== tempRoot && !destPath.startsWith(tempRoot + sep)) {
      warn(`Skipping unsafe archive entry outside extraction dir: ${entry.path}`);
      continue;
    }

    mkdirSync(dirname(destPath), { recursive: true });
    await Bun.write(destPath, entry.data);

    if (entry.path === 'manifest.json') {
      try {
        manifest = JSON.parse(entry.data.toString('utf-8')) as ExportManifest;
      } catch {
        // Ignore malformed manifest.
      }
    } else if (isImageFile(entry.path)) {
      files.push({ path: destPath, relativePath: entry.path });
    }
  }

  return { files, manifest };
}

/**
 * Minimal ZIP parser — reads local file headers and extracts entries using
 * the STORE or DEFLATE compression methods. Archives that stream entries
 * with a data descriptor (bit 3 of the general-purpose flags) or that use
 * another compression method are rejected with an explicit error rather
 * than silently producing no entries.
 */
export function parseZip(buffer: Buffer): Array<{ path: string; data: Buffer }> {
  const entries: Array<{ path: string; data: Buffer }> = [];
  let offset = 0;

  while (offset < buffer.length - 4) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // Not a local file header.

    const flags = buffer.readUInt16LE(offset + 6);
    const compression = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const filenameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);

    const filenameStart = offset + 30;
    const filename = buffer.toString('utf-8', filenameStart, filenameStart + filenameLen);
    const dataStart = filenameStart + filenameLen + extraLen;

    // Directory entries carry no data — skip regardless of compression method.
    if (filename.endsWith('/')) {
      offset = dataStart + compressedSize;
      continue;
    }

    if (flags & 0x0008) {
      throw new Error(
        `Cannot import "${filename}": this ZIP streams entries with a data descriptor, which localpress's importer doesn't support. Extract the archive with a standard tool and import the resulting directory instead.`,
      );
    }

    if (compression === 0) {
      // STORE — data is uncompressed.
      if (compressedSize > 0) {
        const data = buffer.subarray(dataStart, dataStart + compressedSize);
        entries.push({ path: filename, data: Buffer.from(data) });
      }
    } else if (compression === 8) {
      // DEFLATE.
      const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
      const data = inflateRawSync(compressed);
      entries.push({ path: filename, data });
    } else {
      throw new Error(
        `Cannot import "${filename}": unsupported ZIP compression method (${compression}). Only ZIPs produced by \`localpress export\` or using STORE/DEFLATE are supported — extract the archive with a standard tool and import the resulting directory instead.`,
      );
    }

    offset = dataStart + compressedSize;
  }

  return entries;
}

// -- Helpers ------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
