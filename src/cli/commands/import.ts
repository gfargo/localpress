/**
 * `localpress import <path> [--optimize] [--to <format>]` — bulk import local
 * files into the WordPress media library.
 *
 * Accepts a directory, a list of files, or a ZIP archive. Optionally runs the
 * optimization pipeline before uploading. Supports --preserve-ids to maintain
 * attachment IDs from a previous export manifest.
 *
 * This is the counterpart to `localpress export` — together they enable
 * site migrations, bulk content imports, and backup/restore workflows.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { UploadMetadata } from '../../adapters/types.ts';
import { optimizeImage } from '../../engine/image/optimize.ts';
import type { ImageFormat } from '../../engine/image/types.ts';
import { loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

/** Image extensions we recognize for import. */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.svg']);

/** Manifest shape from `localpress export`. */
interface ExportManifest {
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

interface ImportResult {
  file: string;
  attachmentId: number;
  filename: string;
  sizeBytes: number;
  optimized?: boolean;
  originalSize?: number;
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
 * Recursively collect all image files from a directory.
 */
function collectImageFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(currentDir: string): void {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden directories and common non-content dirs.
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        walk(fullPath);
      } else if (entry.isFile() && isImageFile(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

export function registerImportCommand(program: Command): void {
  program
    .command('import <paths...>')
    .description('Import local files or directories into the WordPress media library')
    .option('--optimize', 'run the optimization pipeline before uploading')
    .option('--quality <n>', 'optimization quality (1-100)', (v) => Number.parseInt(v, 10))
    .option('--to <format>', 'convert to format before uploading (webp, avif, jpeg, png)')
    .option('--max-width <n>', 'max width in pixels', (v) => Number.parseInt(v, 10))
    .option('--max-height <n>', 'max height in pixels', (v) => Number.parseInt(v, 10))
    .option('--title <title>', 'default title for imported items (overridden by manifest)')
    .option('--alt <text>', 'default alt text for imported items')
    .option('--post <id>', 'attach all imports to this post', (v) => Number.parseInt(v, 10))
    .option('--preserve-ids', 'use manifest metadata (alt, title, caption) from a previous export')
    .option('--strip-metadata', 'strip EXIF/ICC metadata during optimization')
    .action(async (paths: string[], options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const uploadAdapter = resolver.resolve('upload');

      const concurrency = parentOpts.concurrency ?? Math.max(1, cpus().length - 1);

      // Collect all files to import.
      const filesToImport: string[] = [];
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

          const dirFiles = collectImageFiles(resolved);
          filesToImport.push(...dirFiles);
        } else if (stat.isFile()) {
          if (resolved.endsWith('.zip')) {
            // Extract ZIP and collect files.
            const extracted = await extractZip(resolved);
            filesToImport.push(...extracted.files);
            if (extracted.manifest) {
              manifest = extracted.manifest;
              info(
                `Found export manifest in ZIP (${manifest.items.length} items from ${manifest.site})`,
              );
            }
          } else if (isImageFile(resolved)) {
            filesToImport.push(resolved);
          } else {
            warn(`Skipping non-image file: ${inputPath}`);
          }
        }
      }

      if (filesToImport.length === 0) {
        info('No image files found to import.');
        return;
      }

      // Build a lookup from filename → manifest metadata.
      const manifestLookup = new Map<string, ExportManifest['items'][number]>();
      if (manifest && options.preserveIds) {
        for (const item of manifest.items) {
          manifestLookup.set(item.filename, item);
          // Also index by relative path for more precise matching.
          manifestLookup.set(item.relativePath, item);
        }
      }

      if (parentOpts.dryRun) {
        info(`Would import ${filesToImport.length} file(s) to ${site.name} (${site.url})`);
        if (options.optimize) info(`  with optimization (quality=${options.quality ?? 'default'})`);
        if (options.to) info(`  converting to: ${options.to}`);
        if (parentOpts.json) {
          printJson({
            action: 'dry-run',
            fileCount: filesToImport.length,
            site: site.name,
            files: filesToImport.map((f) => basename(f)),
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

      async function processFile(filePath: string): Promise<void> {
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

          // Apply manifest metadata if --preserve-ids.
          const manifestItem = manifestLookup.get(filename) ?? manifestLookup.get(filePath);
          if (manifestItem) {
            meta.title = manifestItem.title;
            meta.altText = manifestItem.altText ?? undefined;
            meta.caption = manifestItem.caption ?? undefined;
            meta.description = manifestItem.description ?? undefined;
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
      for (const filePath of queue) {
        if (inFlight.length >= concurrency) {
          await Promise.race(inFlight);
        }

        const promise = processFile(filePath).then(() => {
          const idx = inFlight.indexOf(promise);
          if (idx >= 0) inFlight.splice(idx, 1);
        });
        inFlight.push(promise);
      }

      // Wait for remaining in-flight operations.
      await Promise.all(inFlight);

      // Summary.
      const imported = results.length;
      info(`\n✓ Imported ${imported} file(s), ${failures} failure(s).`);
      info(`  Total uploaded: ${formatBytes(totalUploadedBytes)}`);
      if (options.optimize && totalOriginalBytes > totalUploadedBytes) {
        const saved = totalOriginalBytes - totalUploadedBytes;
        const pct = ((saved / totalOriginalBytes) * 100).toFixed(1);
        info(`  Saved: ${formatBytes(saved)} (-${pct}% from optimization)`);
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
        });
      }

      if (failures > 0) {
        process.exit(1);
      }
    });
}

// -- ZIP extraction -----------------------------------------------------------

interface ExtractedZip {
  files: string[];
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

  const files: string[] = [];
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
      files.push(destPath);
    }
  }

  return { files, manifest };
}

/**
 * Minimal ZIP parser — reads local file headers and extracts stored entries.
 * Supports only the STORE compression method (which is what our export produces).
 */
function parseZip(buffer: Buffer): Array<{ path: string; data: Buffer }> {
  const entries: Array<{ path: string; data: Buffer }> = [];
  let offset = 0;

  while (offset < buffer.length - 4) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // Not a local file header.

    const compression = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const filenameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);

    const filenameStart = offset + 30;
    const filename = buffer.toString('utf-8', filenameStart, filenameStart + filenameLen);
    const dataStart = filenameStart + filenameLen + extraLen;

    if (compression === 0 && compressedSize > 0) {
      // STORE method — data is uncompressed.
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      entries.push({ path: filename, data: Buffer.from(data) });
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
