import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch } from 'chokidar';
import { createWatchIgnoreMatcher } from '../../src/cli/utils/watch-ignore.ts';

const WAIT_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 25;

async function waitFor(predicate: () => boolean, timeoutMs = WAIT_TIMEOUT_MS): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

describe('createWatchIgnoreMatcher', () => {
  test('does not ignore files under a dot-prefixed watch root', () => {
    const matcher = createWatchIgnoreMatcher('/home/u/.local/share/photos');

    expect(matcher('/home/u/.local/share/photos/a.png')).toBe(false);
    expect(matcher('/home/u/.local/share/photos/sub/b.jpg')).toBe(false);
    expect(matcher('/home/u/.local/share/photos')).toBe(false);
  });

  test('still ignores dot-prefixed paths and node_modules relative to the root', () => {
    const matcher = createWatchIgnoreMatcher('/home/u/.local/share/photos');

    expect(matcher('/home/u/.local/share/photos/.DS_Store')).toBe(true);
    expect(matcher('/home/u/.local/share/photos/.git/config')).toBe(true);
    expect(matcher('/home/u/.local/share/photos/sub/.hidden.png')).toBe(true);
    expect(matcher('/home/u/.local/share/photos/node_modules/pkg/x.png')).toBe(true);
  });

  test('normalizes a trailing-slash root', () => {
    const matcher = createWatchIgnoreMatcher('/home/u/.local/share/photos/');

    expect(matcher('/home/u/.local/share/photos/a.png')).toBe(false);
    expect(matcher('/home/u/.local/share/photos/.DS_Store')).toBe(true);
  });

  test('does not ignore paths outside the watch root', () => {
    const matcher = createWatchIgnoreMatcher('/home/u/.local/share/photos');

    expect(matcher('/home/u/other/a.png')).toBe(false);
  });
});

describe('createWatchIgnoreMatcher wired into chokidar', () => {
  let baseDir: string;
  let root: string;
  let watcher: ReturnType<typeof watch> | undefined;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'localpress-watch-ignore-'));
    root = join(baseDir, '.tmp', 'watched');
    mkdirSync(root, { recursive: true });
  });

  afterEach(async () => {
    await watcher?.close();
    rmSync(baseDir, { recursive: true, force: true });
  });

  test('emits add for visible files but not for dotfiles, under a dotted root', async () => {
    let ready = false;
    const added = new Set<string>();

    watcher = watch(root, {
      ignoreInitial: true,
      ignored: createWatchIgnoreMatcher(root),
    });
    watcher.on('ready', () => {
      ready = true;
    });
    watcher.on('add', (filePath) => {
      added.add(filePath);
    });

    await waitFor(() => ready);

    writeFileSync(join(root, 'photo.jpg'), 'visible');
    writeFileSync(join(root, '.hidden.jpg'), 'hidden');

    await waitFor(() => added.has(join(root, 'photo.jpg')));

    expect(added.has(join(root, 'photo.jpg'))).toBe(true);
    expect(added.has(join(root, '.hidden.jpg'))).toBe(false);
  });
});
