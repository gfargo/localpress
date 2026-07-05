/**
 * Unit tests for pull's destination-path resolution: collision uniquification
 * and pre-existing file protection.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveDestPath } from '../../src/cli/commands/pull.ts';

let destDir: string;

beforeEach(() => {
  destDir = mkdtempSync(join(tmpdir(), 'localpress-pull-test-'));
});

afterEach(() => {
  rmSync(destDir, { recursive: true, force: true });
});

describe('resolveDestPath', () => {
  test('same basename from two different attachments resolves to distinct paths', () => {
    const usedNames = new Set<string>();

    const first = resolveDestPath(destDir, '2024/01/image.jpg', 101, usedNames, false);
    const second = resolveDestPath(destDir, '2024/06/image.jpg', 202, usedNames, false);

    expect(first.path).not.toBe(second.path);
    expect(first.skipped).toBe(false);
    expect(second.skipped).toBe(false);
    expect(second.name).toBe('image-202.jpg');
  });

  test('--include-sizes variants that collide are uniquified, not overwritten', () => {
    const usedNames = new Set<string>();

    const mainFile = resolveDestPath(destDir, 'image-150x150.jpg', 101, usedNames, false);
    const sizeVariant = resolveDestPath(destDir, 'image-150x150.jpg', 202, usedNames, false);

    expect(mainFile.path).not.toBe(sizeVariant.path);
    expect(sizeVariant.name).toBe('image-150x150-202.jpg');
  });

  test('falls back to a numeric suffix if the id-based name is also taken', () => {
    const usedNames = new Set<string>(['image.jpg', 'image-101.jpg']);

    const result = resolveDestPath(destDir, 'image.jpg', 101, usedNames, false);

    expect(result.name).toBe('image-2.jpg');
  });

  test('skips a pre-existing file on disk without --force', () => {
    const existingPath = join(destDir, 'image.jpg');
    writeFileSync(existingPath, 'old-content');

    const result = resolveDestPath(destDir, 'image.jpg', 101, new Set(), false);

    expect(result.skipped).toBe(true);
    expect(result.path).toBe(existingPath);
  });

  test('overwrites a pre-existing file on disk with --force', () => {
    const existingPath = join(destDir, 'image.jpg');
    writeFileSync(existingPath, 'old-content');

    const result = resolveDestPath(destDir, 'image.jpg', 101, new Set(), true);

    expect(result.skipped).toBe(false);
    expect(result.path).toBe(existingPath);
  });

  test('unaffected single-attachment pull keeps the plain basename path', () => {
    const result = resolveDestPath(destDir, '2024/01/photo.png', 101, new Set(), false);

    expect(result.name).toBe('photo.png');
    expect(result.path).toBe(join(destDir, 'photo.png'));
    expect(result.skipped).toBe(false);
  });
});
