/**
 * Unit tests for export/import internal utilities.
 *
 * Tests the ZIP builder (export) and ZIP parser (import) to ensure
 * round-trip integrity — files exported as ZIP can be re-imported.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import {
  type ExportManifest,
  buildManifestIndex,
  collectImageFiles,
  parseZip as parseZipReal,
  resolveManifestItem,
} from '../../src/cli/commands/import.ts';

/**
 * Minimal ZIP builder — extracted from export.ts for testing.
 * Uses STORE method (no compression) for speed.
 */
function buildZipSync(entries: Array<{ path: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const centralDir: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const pathBuf = Buffer.from(entry.path, 'utf-8');
    const data = entry.data;

    const localHeader = Buffer.alloc(30 + pathBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    const crc = crc32(data);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(pathBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    pathBuf.copy(localHeader, 30);

    parts.push(localHeader, data);

    const cdEntry = Buffer.alloc(46 + pathBuf.length);
    cdEntry.writeUInt32LE(0x02014b50, 0);
    cdEntry.writeUInt16LE(20, 4);
    cdEntry.writeUInt16LE(20, 6);
    cdEntry.writeUInt16LE(0, 8);
    cdEntry.writeUInt16LE(0, 10);
    cdEntry.writeUInt16LE(0, 12);
    cdEntry.writeUInt16LE(0, 14);
    cdEntry.writeUInt32LE(crc, 16);
    cdEntry.writeUInt32LE(data.length, 20);
    cdEntry.writeUInt32LE(data.length, 24);
    cdEntry.writeUInt16LE(pathBuf.length, 28);
    cdEntry.writeUInt16LE(0, 30);
    cdEntry.writeUInt16LE(0, 32);
    cdEntry.writeUInt16LE(0, 34);
    cdEntry.writeUInt16LE(0, 36);
    cdEntry.writeUInt32LE(0, 38);
    cdEntry.writeUInt32LE(offset, 42);
    pathBuf.copy(cdEntry, 46);

    centralDir.push(cdEntry);
    offset += localHeader.length + data.length;
  }

  const centralDirBuf = Buffer.concat(centralDir);
  const centralDirOffset = offset;

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirBuf.length, 12);
  endRecord.writeUInt32LE(centralDirOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralDirBuf, endRecord]);
}

/**
 * Minimal ZIP parser — extracted from import.ts for testing.
 */
function parseZip(buffer: Buffer): Array<{ path: string; data: Buffer }> {
  const entries: Array<{ path: string; data: Buffer }> = [];
  let offset = 0;

  while (offset < buffer.length - 4) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;

    const compressedSize = buffer.readUInt32LE(offset + 18);
    const filenameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);

    const filenameStart = offset + 30;
    const filename = buffer.toString('utf-8', filenameStart, filenameStart + filenameLen);
    const dataStart = filenameStart + filenameLen + extraLen;

    if (compressedSize > 0) {
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      entries.push({ path: filename, data: Buffer.from(data) });
    }

    offset = dataStart + compressedSize;
  }

  return entries;
}

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

describe('ZIP round-trip', () => {
  test('single file round-trips correctly', () => {
    const original = Buffer.from('Hello, localpress!');
    const zip = buildZipSync([{ path: 'test.txt', data: original }]);
    const parsed = parseZip(zip);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('test.txt');
    expect(parsed[0].data.toString()).toBe('Hello, localpress!');
  });

  test('multiple files round-trip correctly', () => {
    const entries = [
      { path: '2026/01/hero.jpg', data: Buffer.from('fake-jpeg-data-1') },
      { path: '2026/05/logo.png', data: Buffer.from('fake-png-data-2') },
      { path: 'manifest.json', data: Buffer.from('{"version":1}') },
    ];

    const zip = buildZipSync(entries);
    const parsed = parseZip(zip);

    expect(parsed).toHaveLength(3);
    expect(parsed[0].path).toBe('2026/01/hero.jpg');
    expect(parsed[0].data.toString()).toBe('fake-jpeg-data-1');
    expect(parsed[1].path).toBe('2026/05/logo.png');
    expect(parsed[1].data.toString()).toBe('fake-png-data-2');
    expect(parsed[2].path).toBe('manifest.json');
    expect(parsed[2].data.toString()).toBe('{"version":1}');
  });

  test('binary data round-trips correctly', () => {
    const binaryData = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) binaryData[i] = i;

    const zip = buildZipSync([{ path: 'binary.bin', data: binaryData }]);
    const parsed = parseZip(zip);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].data).toEqual(binaryData);
  });

  test('empty file is handled', () => {
    const zip = buildZipSync([{ path: 'empty.txt', data: Buffer.alloc(0) }]);
    const parsed = parseZip(zip);

    // Empty files have compressedSize=0, so they're skipped by the parser.
    // This is expected behavior — empty files aren't useful for media import.
    expect(parsed).toHaveLength(0);
  });

  test('large file round-trips correctly', () => {
    // 1MB of random-ish data.
    const largeData = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < largeData.length; i++) largeData[i] = i % 256;

    const zip = buildZipSync([{ path: 'large-image.jpg', data: largeData }]);
    const parsed = parseZip(zip);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].data.length).toBe(1024 * 1024);
    expect(parsed[0].data[0]).toBe(0);
    expect(parsed[0].data[255]).toBe(255);
    expect(parsed[0].data[256]).toBe(0);
  });

  test('unicode filenames round-trip correctly', () => {
    const zip = buildZipSync([{ path: '日本語/画像.png', data: Buffer.from('data') }]);
    const parsed = parseZip(zip);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('日本語/画像.png');
  });
});

describe('Zip Slip guard', () => {
  /**
   * Mirrors the containment check in `extractZip` (src/cli/commands/import.ts):
   * every entry is resolved against the temp extraction root, and rejected if
   * it would land outside that root.
   */
  function extractZipGuarded(zipBuffer: Buffer, tempDir: string): string[] {
    const written: string[] = [];
    const tempRoot = resolve(tempDir);

    for (const entry of parseZip(zipBuffer)) {
      const destPath = resolve(tempRoot, entry.path);
      if (destPath !== tempRoot && !destPath.startsWith(tempRoot + sep)) {
        continue;
      }

      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, entry.data);
      written.push(destPath);
    }

    return written;
  }

  test('rejects relative traversal entries', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'localpress-zipslip-'));

    try {
      const zip = buildZipSync([
        { path: '../../../../tmp/localpress-zipslip-poc.txt', data: Buffer.from('pwned') },
        { path: '2026/01/hero.jpg', data: Buffer.from('safe-image-data') },
      ]);

      const written = extractZipGuarded(zip, tempDir);

      expect(written.every((p) => p.startsWith(resolve(tempDir) + sep))).toBe(true);
      expect(written.some((p) => p.endsWith('hero.jpg'))).toBe(true);
      expect(written.some((p) => p.includes('localpress-zipslip-poc.txt'))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects absolute-path entries', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'localpress-zipslip-'));
    const maliciousAbsPath = join(tmpdir(), 'localpress-zipslip-abs-poc.txt');

    try {
      // Confirm path.resolve's documented behavior: an absolute second segment
      // wins outright, which is exactly what the guard must catch.
      expect(resolve(resolve(tempDir), maliciousAbsPath)).toBe(maliciousAbsPath);

      const zip = buildZipSync([
        { path: maliciousAbsPath, data: Buffer.from('pwned') },
        { path: '2026/01/hero.jpg', data: Buffer.from('safe-image-data') },
      ]);

      const written = extractZipGuarded(zip, tempDir);

      expect(written.every((p) => p.startsWith(resolve(tempDir) + sep))).toBe(true);
      expect(written.some((p) => p === maliciousAbsPath)).toBe(false);
      expect(() =>
        readdirSync(dirname(maliciousAbsPath)).includes('localpress-zipslip-abs-poc.txt'),
      ).not.toThrow();
      expect(readdirSync(tmpdir()).includes('localpress-zipslip-abs-poc.txt')).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(maliciousAbsPath, { force: true });
    }
  });

  test('still extracts nested benign paths', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'localpress-zipslip-'));

    try {
      const zip = buildZipSync([
        { path: '2026/01/hero.jpg', data: Buffer.from('safe-image-data') },
      ]);

      const written = extractZipGuarded(zip, tempDir);

      expect(written).toHaveLength(1);
      expect(written[0]).toBe(join(resolve(tempDir), '2026', '01', 'hero.jpg'));
      expect(readFileSync(written[0], 'utf-8')).toBe('safe-image-data');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('CRC-32', () => {
  test('empty buffer produces known CRC', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0x00000000);
  });

  test('known string produces expected CRC', () => {
    // CRC-32 of "123456789" is 0xCBF43926
    const result = crc32(Buffer.from('123456789'));
    expect(result).toBe(0xcbf43926);
  });

  test('different data produces different CRCs', () => {
    const crc1 = crc32(Buffer.from('hello'));
    const crc2 = crc32(Buffer.from('world'));
    expect(crc1).not.toBe(crc2);
  });
});

describe('image file detection', () => {
  const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.svg']);

  function isImageFile(filePath: string): boolean {
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  }

  test('recognizes common image extensions', () => {
    expect(isImageFile('photo.jpg')).toBe(true);
    expect(isImageFile('photo.jpeg')).toBe(true);
    expect(isImageFile('logo.png')).toBe(true);
    expect(isImageFile('hero.webp')).toBe(true);
    expect(isImageFile('banner.avif')).toBe(true);
    expect(isImageFile('animation.gif')).toBe(true);
    expect(isImageFile('icon.svg')).toBe(true);
  });

  test('rejects non-image extensions', () => {
    expect(isImageFile('document.pdf')).toBe(false);
    expect(isImageFile('script.js')).toBe(false);
    expect(isImageFile('style.css')).toBe(false);
    expect(isImageFile('data.json')).toBe(false);
    expect(isImageFile('readme.md')).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(isImageFile('PHOTO.JPG')).toBe(true);
    expect(isImageFile('Logo.PNG')).toBe(true);
    expect(isImageFile('Hero.WebP')).toBe(true);
  });

  test('handles paths with directories', () => {
    expect(isImageFile('/uploads/2026/01/photo.jpg')).toBe(true);
    expect(isImageFile('assets/images/logo.png')).toBe(true);
  });
});

describe('directory scanning', () => {
  test('collectImageFiles finds images recursively', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'localpress-scan-'));

    try {
      // Create a directory structure with mixed files.
      mkdirSync(join(tempDir, 'subdir'), { recursive: true });
      mkdirSync(join(tempDir, '.hidden'), { recursive: true });

      writeFileSync(join(tempDir, 'photo.jpg'), 'fake');
      writeFileSync(join(tempDir, 'logo.png'), 'fake');
      writeFileSync(join(tempDir, 'readme.md'), 'fake');
      writeFileSync(join(tempDir, 'subdir', 'nested.webp'), 'fake');
      writeFileSync(join(tempDir, '.hidden', 'secret.png'), 'fake');

      // Simulate the collectImageFiles logic.
      const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.svg']);
      const files: string[] = [];

      function walk(dir: string): void {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            walk(fullPath);
          } else if (entry.isFile()) {
            const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
            if (IMAGE_EXTENSIONS.has(ext)) files.push(fullPath);
          }
        }
      }

      walk(tempDir);

      expect(files).toHaveLength(3); // photo.jpg, logo.png, subdir/nested.webp
      expect(files.some((f) => f.endsWith('photo.jpg'))).toBe(true);
      expect(files.some((f) => f.endsWith('logo.png'))).toBe(true);
      expect(files.some((f) => f.endsWith('nested.webp'))).toBe(true);
      // Hidden directory should be skipped.
      expect(files.some((f) => f.includes('.hidden'))).toBe(false);
      // Non-image files should be skipped.
      expect(files.some((f) => f.endsWith('.md'))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('export manifest structure', () => {
  test('manifest has required fields', () => {
    const manifest = {
      version: 1,
      site: 'production',
      siteUrl: 'https://example.com',
      exportedAt: new Date().toISOString(),
      items: [
        {
          id: 123,
          filename: 'hero.jpg',
          relativePath: '2026/01/hero.jpg',
          url: 'https://example.com/wp-content/uploads/2026/01/hero.jpg',
          mimeType: 'image/jpeg',
          width: 1920,
          height: 1080,
          sizeBytes: 245760,
          altText: 'Hero banner',
          title: 'Hero Image',
          uploadedAt: '2026-01-15T10:00:00.000Z',
          sha256: 'abc123def456',
        },
      ],
      totalBytes: 245760,
    };

    expect(manifest.version).toBe(1);
    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0].id).toBe(123);
    expect(manifest.items[0].sha256).toBeDefined();
    expect(manifest.totalBytes).toBe(245760);
  });

  test('manifest can be serialized and deserialized', () => {
    const manifest = {
      version: 1,
      site: 'test',
      siteUrl: 'https://test.com',
      exportedAt: '2026-05-10T12:00:00.000Z',
      items: [],
      totalBytes: 0,
    };

    const json = JSON.stringify(manifest);
    const parsed = JSON.parse(json);

    expect(parsed.version).toBe(1);
    expect(parsed.site).toBe('test');
    expect(parsed.items).toEqual([]);
  });
});

describe('collectImageFiles (real, from import.ts)', () => {
  test('returns distinct relativePaths for same-basename files in different subdirectories', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'localpress-collect-'));

    try {
      mkdirSync(join(tempDir, '2026', '01'), { recursive: true });
      mkdirSync(join(tempDir, '2026', '05'), { recursive: true });
      writeFileSync(join(tempDir, '2026', '01', 'photo.jpg'), 'jan');
      writeFileSync(join(tempDir, '2026', '05', 'photo.jpg'), 'may');

      const files = collectImageFiles(tempDir);

      expect(files).toHaveLength(2);
      const relativePaths = files.map((f) => f.relativePath).sort();
      expect(relativePaths).toEqual(['2026/01/photo.jpg', '2026/05/photo.jpg']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function makeManifest(items: ExportManifest['items']): ExportManifest {
  return {
    version: 1,
    site: 'test',
    siteUrl: 'https://test.com',
    exportedAt: '2026-01-01T00:00:00.000Z',
    items,
    totalBytes: 0,
  };
}

describe('manifest metadata matching (real, from import.ts)', () => {
  test('resolves colliding basenames by relativePath instead of the last-indexed item', () => {
    const manifest = makeManifest([
      {
        id: 1,
        filename: 'photo.jpg',
        relativePath: '2026/01/photo.jpg',
        url: 'https://example.com/wp-content/uploads/2026/01/photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
        title: 'January',
        uploadedAt: '2026-01-01T00:00:00.000Z',
        sha256: 'a',
      },
      {
        id: 2,
        filename: 'photo.jpg',
        relativePath: '2026/05/photo.jpg',
        url: 'https://example.com/wp-content/uploads/2026/05/photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
        title: 'May',
        uploadedAt: '2026-05-01T00:00:00.000Z',
        sha256: 'b',
      },
    ]);
    const index = buildManifestIndex(manifest);

    const jan = resolveManifestItem(index, {
      path: '/tmp/x/photo.jpg',
      relativePath: '2026/01/photo.jpg',
    });
    const may = resolveManifestItem(index, {
      path: '/tmp/x/photo.jpg',
      relativePath: '2026/05/photo.jpg',
    });

    expect(jan.item?.id).toBe(1);
    expect(jan.item?.title).toBe('January');
    expect(may.item?.id).toBe(2);
    expect(may.item?.title).toBe('May');
  });

  test('ambiguous basename with no relativePath match returns undefined, not the wrong item', () => {
    const manifest = makeManifest([
      {
        id: 1,
        filename: 'photo.jpg',
        relativePath: '2026/01/photo.jpg',
        url: 'https://example.com/wp-content/uploads/2026/01/photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
        title: 'January',
        uploadedAt: '2026-01-01T00:00:00.000Z',
        sha256: 'a',
      },
      {
        id: 2,
        filename: 'photo.jpg',
        relativePath: '2026/05/photo.jpg',
        url: 'https://example.com/wp-content/uploads/2026/05/photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
        title: 'May',
        uploadedAt: '2026-05-01T00:00:00.000Z',
        sha256: 'b',
      },
    ]);
    const index = buildManifestIndex(manifest);

    const resolution = resolveManifestItem(index, { path: '/tmp/x/photo.jpg', relativePath: null });

    expect(resolution.item).toBeUndefined();
    expect(resolution.ambiguous).toBe(true);
  });

  test('unique basename still resolves when relativePath is unavailable', () => {
    const manifest = makeManifest([
      {
        id: 3,
        filename: 'logo.png',
        relativePath: '2026/02/logo.png',
        url: 'https://example.com/wp-content/uploads/2026/02/logo.png',
        mimeType: 'image/png',
        sizeBytes: 1,
        title: 'Logo',
        uploadedAt: '2026-02-01T00:00:00.000Z',
        sha256: 'c',
      },
    ]);
    const index = buildManifestIndex(manifest);

    const resolution = resolveManifestItem(index, { path: '/tmp/x/logo.png', relativePath: null });

    expect(resolution.item?.id).toBe(3);
    expect(resolution.ambiguous).toBe(false);
  });
});

function buildLocalFileHeaderEntry(
  path: string,
  data: Buffer,
  compression: number,
  flags = 0,
): Buffer {
  const pathBuf = Buffer.from(path, 'utf-8');
  const header = Buffer.alloc(30 + pathBuf.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(compression, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(pathBuf.length, 26);
  header.writeUInt16LE(0, 28);
  pathBuf.copy(header, 30);
  return Buffer.concat([header, data]);
}

describe('parseZip (real, from import.ts)', () => {
  test('STORE entries still round-trip', () => {
    const zip = buildZipSync([{ path: '2026/01/hero.jpg', data: Buffer.from('fake-jpeg-data') }]);
    const parsed = parseZipReal(zip);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('2026/01/hero.jpg');
    expect(parsed[0].data.toString()).toBe('fake-jpeg-data');
  });

  test('DEFLATE-compressed entries decode correctly', () => {
    const original = Buffer.from('Hello from a standard zip tool!');
    const compressed = deflateRawSync(original);
    const zip = buildLocalFileHeaderEntry('photo.txt', compressed, 8);

    const parsed = parseZipReal(zip);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('photo.txt');
    expect(parsed[0].data.toString()).toBe('Hello from a standard zip tool!');
  });

  test('throws an explicit error for an unsupported compression method', () => {
    const zip = buildLocalFileHeaderEntry('file.bin', Buffer.from('data'), 99);

    expect(() => parseZipReal(zip)).toThrow(/unsupported ZIP compression/i);
  });

  test('throws an explicit error for a data-descriptor streamed entry', () => {
    const zip = buildLocalFileHeaderEntry('file.bin', Buffer.from('data'), 8, 0x0008);

    expect(() => parseZipReal(zip)).toThrow(/data descriptor/i);
  });
});
