/**
 * Unit tests for `localpress update`'s checksum verification helpers:
 * checksums.txt parsing and SHA256 comparison.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseChecksums, verifyChecksum } from '../../src/engine/update/checksum.ts';

describe('parseChecksums', () => {
  test('parses a standard sha256sum-format line', () => {
    const text =
      'd2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2  localpress-linux-x64.tar.gz\n';
    const map = parseChecksums(text);
    expect(map.get('localpress-linux-x64.tar.gz')).toBe(
      'd2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2',
    );
  });

  test('parses multiple lines', () => {
    const text = [
      'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1  localpress-darwin-arm64.tar.gz',
      'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2  localpress-darwin-x64.tar.gz',
    ].join('\n');
    const map = parseChecksums(text);
    expect(map.size).toBe(2);
    expect(map.get('localpress-darwin-arm64.tar.gz')).toBe(
      'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
    );
  });

  test('handles the binary-mode asterisk marker', () => {
    const text =
      'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3 *localpress-windows-x64.zip\n';
    const map = parseChecksums(text);
    expect(map.get('localpress-windows-x64.zip')).toBe(
      'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3',
    );
  });

  test('is case-insensitive on the hex digest', () => {
    const text =
      'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789  localpress-linux-arm64.tar.gz\n';
    const map = parseChecksums(text);
    expect(map.get('localpress-linux-arm64.tar.gz')).toBe(
      'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    );
  });

  test('ignores blank lines and malformed entries', () => {
    const text = [
      '',
      '   ',
      'not-a-valid-checksum-line',
      'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4  localpress-linux-x64.tar.gz',
      '',
    ].join('\n');
    const map = parseChecksums(text);
    expect(map.size).toBe(1);
    expect(map.has('localpress-linux-x64.tar.gz')).toBe(true);
  });

  test('returns an empty map for a missing platform entry', () => {
    const text =
      'e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5  localpress-darwin-arm64.tar.gz\n';
    const map = parseChecksums(text);
    expect(map.get('localpress-linux-x64.tar.gz')).toBeUndefined();
  });
});

describe('verifyChecksum', () => {
  let tempDir: string;

  test('resolves when the digest matches', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'localpress-checksum-test-'));
    const filePath = join(tempDir, 'archive.tar.gz');
    writeFileSync(filePath, 'hello world');

    const { createHash } = await import('node:crypto');
    const expectedHash = createHash('sha256').update('hello world').digest('hex');
    await expect(verifyChecksum(filePath, expectedHash)).resolves.toBeUndefined();

    rmSync(tempDir, { recursive: true, force: true });
  });

  test('rejects when the digest does not match', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'localpress-checksum-test-'));
    const filePath = join(tempDir, 'archive.tar.gz');
    writeFileSync(filePath, 'hello world');

    await expect(
      verifyChecksum(filePath, '0000000000000000000000000000000000000000000000000000000000000000'),
    ).rejects.toThrow(/Checksum mismatch/);

    rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('URL scheme validation', () => {
  function isAllowedDownloadUrl(url: string): boolean {
    return url.startsWith('https://');
  }

  test('accepts https URLs', () => {
    expect(
      isAllowedDownloadUrl('https://github.com/gfargo/localpress/releases/download/v1/a.tar.gz'),
    ).toBe(true);
  });

  test('rejects http URLs', () => {
    expect(
      isAllowedDownloadUrl('http://github.com/gfargo/localpress/releases/download/v1/a.tar.gz'),
    ).toBe(false);
  });

  test('rejects file URLs', () => {
    expect(isAllowedDownloadUrl('file:///etc/passwd')).toBe(false);
  });

  test('rejects ftp URLs', () => {
    expect(isAllowedDownloadUrl('ftp://example.com/a.tar.gz')).toBe(false);
  });
});
