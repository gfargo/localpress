/**
 * Unit tests for `localpress update`'s atomic install-swap logic.
 * Exercises `performAtomicSwap` against real temp directories on disk,
 * including a simulated failure between the two renames.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { performAtomicSwap } from '../../src/engine/update/swap.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'localpress-swap-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('performAtomicSwap', () => {
  test('replaces targetDir contents with stagingDir and removes the backup', async () => {
    const targetDir = join(tempDir, 'install');
    const stagingDir = join(tempDir, 'install-staging-1');

    await mkdir(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'bundle.js'), 'old version');

    await mkdir(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, 'bundle.js'), 'new version');

    await performAtomicSwap(targetDir, stagingDir);

    expect(existsSync(targetDir)).toBe(true);
    expect(readFileSync(join(targetDir, 'bundle.js'), 'utf8')).toBe('new version');
    expect(existsSync(stagingDir)).toBe(false);

    // No leftover backup dir.
    const { readdirSync } = await import('node:fs');
    const leftovers = readdirSync(tempDir).filter((n) => n.includes('.bak-'));
    expect(leftovers).toHaveLength(0);
  });

  test('restores the original install if stagingDir goes missing mid-swap', async () => {
    const targetDir = join(tempDir, 'install');
    const stagingDir = join(tempDir, 'install-staging-missing');

    await mkdir(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'bundle.js'), 'original version');

    // stagingDir is never created, so the second rename() fails with ENOENT
    // after the first rename (targetDir -> backup) has already happened —
    // exercising the rename-back restore path, not just an early guard.
    await expect(performAtomicSwap(targetDir, stagingDir)).rejects.toThrow();

    // targetDir must be restored to its original contents afterward.
    expect(existsSync(targetDir)).toBe(true);
    expect(readFileSync(join(targetDir, 'bundle.js'), 'utf8')).toBe('original version');

    const { readdirSync } = await import('node:fs');
    const leftovers = readdirSync(tempDir).filter((n) => n.includes('.bak-'));
    expect(leftovers).toHaveLength(0);
  });

  test('creates a fresh install when targetDir does not exist yet', async () => {
    const targetDir = join(tempDir, 'install');
    const stagingDir = join(tempDir, 'install-staging-2');

    await mkdir(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, 'bundle.js'), 'first install');

    await performAtomicSwap(targetDir, stagingDir);

    expect(existsSync(targetDir)).toBe(true);
    expect(readFileSync(join(targetDir, 'bundle.js'), 'utf8')).toBe('first install');
    expect(existsSync(stagingDir)).toBe(false);
  });
});
