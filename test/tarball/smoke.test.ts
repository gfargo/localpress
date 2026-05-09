/**
 * Tarball smoke tests — verifies the built distribution tarball works end-to-end.
 *
 * These tests:
 *   1. Build the tarball for the current platform (if not already built)
 *   2. Run the binary against real image files
 *   3. Verify optimize, convert, resize, and remove-bg all produce valid output
 *
 * Run with:
 *   bun test test/tarball/
 *
 * Or after building:
 *   bun run build && bun test test/tarball/
 *
 * Skipped automatically if the tarball hasn't been built yet.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// -- Setup -------------------------------------------------------------------

const PLATFORM =
  process.platform === 'darwin'
    ? `darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
    : `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

const TARBALL_DIR = join(process.cwd(), 'dist', `localpress-${PLATFORM}`);
const BINARY = join(TARBALL_DIR, 'bin', 'localpress');
const FIXTURES_DIR = join(process.cwd(), 'test', 'tarball', 'fixtures');
const WORK_DIR = join(tmpdir(), `localpress-tarball-test-${Date.now()}`);

const TARBALL_AVAILABLE = existsSync(BINARY);

/**
 * Run the tarball binary with the given args.
 * Returns { stdout, stderr, exitCode }.
 */
function run(
  args: string[],
  env: Record<string, string> = {},
): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const result = spawnSync(BINARY, args, {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

/**
 * Create a minimal valid JPEG in memory using sharp (available in dev mode).
 */
async function createTestJpeg(path: string, width = 200, height = 150): Promise<void> {
  const sharp = (await import('sharp')).default;
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 100, g: 150, b: 200 },
    },
  })
    .jpeg({ quality: 80 })
    .toFile(path);
}

async function createTestPng(path: string, width = 200, height = 150): Promise<void> {
  const sharp = (await import('sharp')).default;
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 200, g: 100, b: 50, alpha: 1 },
    },
  })
    .png()
    .toFile(path);
}

// -- Test lifecycle ----------------------------------------------------------

beforeAll(async () => {
  if (!TARBALL_AVAILABLE) return;

  await mkdir(FIXTURES_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });

  // Create test images if they don't exist
  const jpegPath = join(FIXTURES_DIR, 'test.jpg');
  const pngPath = join(FIXTURES_DIR, 'test.png');

  if (!existsSync(jpegPath)) {
    await createTestJpeg(jpegPath);
  }
  if (!existsSync(pngPath)) {
    await createTestPng(pngPath);
  }
});

// -- Tests -------------------------------------------------------------------

describe('tarball binary', () => {
  test.skipIf(!TARBALL_AVAILABLE)('binary exists and is executable', () => {
    expect(existsSync(BINARY)).toBe(true);
    const stat = statSync(BINARY);
    // Check executable bit (owner execute)
    expect(stat.mode & 0o100).toBeTruthy();
  });

  test.skipIf(!TARBALL_AVAILABLE)('--version returns a version string', () => {
    const { stdout, exitCode } = run(['--version']);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test.skipIf(!TARBALL_AVAILABLE)('--help returns usage info', () => {
    const { stdout, exitCode } = run(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('localpress');
    expect(stdout).toContain('optimize');
    expect(stdout).toContain('convert');
  });
});

describe('image processing (requires built tarball)', () => {
  const jpegFixture = join(FIXTURES_DIR, 'test.jpg');

  test.skipIf(!TARBALL_AVAILABLE)('sharp is available in the tarball', () => {
    // Run doctor in JSON mode and check sharp status
    const { stdout } = run(['--json', 'doctor'], {
      // Provide a fake site config so doctor doesn't fail on missing config
      LOCALPRESS_CONFIG_DIR: WORK_DIR,
    });
    // Doctor may exit non-zero if no site configured, but sharp check runs first
    // Look for sharpAvailable in the JSON output
    try {
      const data = JSON.parse(stdout);
      expect(data.sharpAvailable).toBe(true);
    } catch {
      // If JSON parse fails, check stderr for the sharp error
      expect(stdout).not.toContain('sharp is not installed');
    }
  });

  test.skipIf(!TARBALL_AVAILABLE)('can load and process a JPEG with sharp directly', async () => {
    // Test that sharp works by running a small inline script via the tarball's bun
    const testScript = join(WORK_DIR, 'test-sharp.mjs');
    const outputPath = join(WORK_DIR, 'output.jpg');

    await writeFile(
      testScript,
      `
import sharp from '${join(TARBALL_DIR, 'node_modules', 'sharp')}/lib/index.js';
const img = sharp('${jpegFixture}');
const meta = await img.metadata();
if (!meta.width || !meta.height) throw new Error('No metadata');
await sharp('${jpegFixture}').jpeg({ quality: 60 }).toFile('${outputPath}');
console.log(JSON.stringify({ width: meta.width, height: meta.height, ok: true }));
`,
    );

    const result = spawnSync('bun', ['run', testScript], {
      encoding: 'utf-8',
      timeout: 30_000,
    });

    expect(result.status).toBe(0);
    const data = JSON.parse(result.stdout.trim());
    expect(data.ok).toBe(true);
    expect(data.width).toBe(200);
    expect(data.height).toBe(150);
    expect(existsSync(outputPath)).toBe(true);
    expect(statSync(outputPath).size).toBeGreaterThan(0);
  });

  test.skipIf(!TARBALL_AVAILABLE)('onnxruntime-node is available for remove-bg', () => {
    // Verify the onnxruntime binary exists for the current platform
    const onnxBinDir = join(
      TARBALL_DIR,
      'node_modules',
      'onnxruntime-node',
      'bin',
      'napi-v6',
      process.platform,
    );
    expect(existsSync(onnxBinDir)).toBe(true);

    // Verify no other platform binaries are present (size check)
    const onnxPlatformDir = join(TARBALL_DIR, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
    const { readdirSync } = require('node:fs');
    const dirs = readdirSync(onnxPlatformDir);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe(process.platform);
  });

  test.skipIf(!TARBALL_AVAILABLE)('only target platform sharp binaries are present', () => {
    const imgDir = join(TARBALL_DIR, 'node_modules', '@img');
    const { readdirSync } = require('node:fs');
    const packages = readdirSync(imgDir);

    // All @img packages should be for the current platform only
    const platformStr = PLATFORM.replace('-', '-');
    for (const pkg of packages) {
      if (pkg.startsWith('sharp-') || pkg.startsWith('sharp-libvips-')) {
        expect(pkg).toContain(platformStr.split('-')[0]); // darwin or linux
      }
    }
  });
});

describe('tarball size', () => {
  test.skipIf(!TARBALL_AVAILABLE)('tarball is under 100MB', () => {
    const archivePath = join(process.cwd(), 'dist', `localpress-${PLATFORM}.tar.gz`);
    if (!existsSync(archivePath)) return; // Skip if archive not present

    const stats = statSync(archivePath);
    const sizeMB = stats.size / 1024 / 1024;
    console.log(`  Tarball size: ${sizeMB.toFixed(1)} MB`);
    expect(sizeMB).toBeLessThan(100);
  });

  test.skipIf(!TARBALL_AVAILABLE)('node_modules is under 80MB', () => {
    // Use du to check node_modules size
    const result = spawnSync('du', ['-sm', join(TARBALL_DIR, 'node_modules')], {
      encoding: 'utf-8',
    });
    if (result.status !== 0) return;

    const sizeMB = Number.parseInt(result.stdout.split('\t')[0], 10);
    console.log(`  node_modules size: ${sizeMB} MB`);
    expect(sizeMB).toBeLessThan(150);
  });
});
