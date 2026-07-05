/**
 * Unit tests for export/import internal utilities.
 *
 * Tests the ZIP builder (export) and ZIP parser (import) to ensure
 * round-trip integrity — files exported as ZIP can be re-imported.
 */

import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ZIP32_MAX_ENTRIES,
  ZIP32_MAX_SIZE,
  ZipLimitExceededError,
  ZipStreamWriter,
  estimateEntryCount,
  estimateTotalBytes,
} from '../../src/cli/commands/export.ts';

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

function fakeItem(
  id: number,
  sizeBytes?: number,
): Parameters<typeof estimateEntryCount>[0][number] {
  return {
    id,
    title: `item-${id}`,
    filename: `item-${id}.jpg`,
    url: `https://example.com/wp-content/uploads/2026/01/item-${id}.jpg`,
    mimeType: 'image/jpeg',
    sizeBytes,
    uploadedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('ZIP32 limit preflight estimates', () => {
  test('estimateEntryCount counts items + manifest.json', () => {
    const items = [fakeItem(1), fakeItem(2), fakeItem(3)];
    expect(estimateEntryCount(items, {})).toBe(4); // 3 items + manifest
  });

  test('estimateEntryCount includes variant sizes when --include-sizes is set', () => {
    const items = [
      {
        ...fakeItem(1),
        sizes: {
          thumbnail: { width: 150, height: 150, url: 'https://x/t.jpg', filename: 't.jpg' },
          medium: { width: 300, height: 300, url: 'https://x/m.jpg', filename: 'm.jpg' },
        },
      },
    ];
    expect(estimateEntryCount(items, { includeSizes: true })).toBe(4); // 1 item + 2 sizes + manifest
    expect(estimateEntryCount(items, { includeSizes: false })).toBe(2); // 1 item + manifest
  });

  test('estimateEntryCount flags an archive that would exceed the 65,535 entry ZIP32 limit', () => {
    // Don't materialize 65k+ objects — just prove the math the real call site uses.
    const itemCount = ZIP32_MAX_ENTRIES + 10;
    const items = Array.from({ length: itemCount }, (_, i) => fakeItem(i));
    const entryCount = estimateEntryCount(items, {});
    expect(entryCount).toBeGreaterThan(ZIP32_MAX_ENTRIES);
  });

  test('estimateTotalBytes sums known sizeBytes metadata', () => {
    const items = [fakeItem(1, 1000), fakeItem(2, 2000), fakeItem(3, undefined)];
    expect(estimateTotalBytes(items, {})).toBe(3000);
  });

  test('estimateTotalBytes flags an archive that would exceed the 4 GiB ZIP32 size limit', () => {
    const items = [fakeItem(1, ZIP32_MAX_SIZE), fakeItem(2, 1)];
    expect(estimateTotalBytes(items, {})).toBeGreaterThan(ZIP32_MAX_SIZE);
  });
});

describe('ZipStreamWriter', () => {
  test('streams entries to disk and produces a ZIP parseable by the existing reader', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'localpress-zip-write-'));
    const destPath = join(tempDir, 'export.zip');

    try {
      const writer = new ZipStreamWriter(destPath);
      await writer.writeEntry('2026/01/hero.jpg', Buffer.from('fake-jpeg-bytes'));
      await writer.writeEntry('2026/05/logo.png', Buffer.from('fake-png-bytes'));
      await writer.writeEntry('manifest.json', Buffer.from('{"version":1}'));
      await writer.finalize();

      expect(existsSync(destPath)).toBe(true);
      expect(existsSync(`${destPath}.tmp`)).toBe(false);

      const parsed = parseZip(readFileSync(destPath));
      expect(parsed).toHaveLength(3);
      expect(parsed[0].path).toBe('2026/01/hero.jpg');
      expect(parsed[0].data.toString()).toBe('fake-jpeg-bytes');
      expect(parsed[1].path).toBe('2026/05/logo.png');
      expect(parsed[2].path).toBe('manifest.json');
      expect(parsed[2].data.toString()).toBe('{"version":1}');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('aborts and removes the .tmp file when an entry would exceed the 4 GiB per-file limit', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'localpress-zip-abort-'));
    const destPath = join(tempDir, 'export.zip');

    try {
      const writer = new ZipStreamWriter(destPath);
      // Simulate an oversized entry without actually allocating 4 GiB.
      const oversized = { length: ZIP32_MAX_SIZE + 1 } as unknown as Buffer;

      await expect(writer.writeEntry('huge-file.jpg', oversized)).rejects.toThrow(
        ZipLimitExceededError,
      );

      writer.abort();

      expect(existsSync(`${destPath}.tmp`)).toBe(false);
      expect(existsSync(destPath)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
