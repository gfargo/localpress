#!/usr/bin/env bun
/**
 * Screenshot driver — generates VHS tapes, runs them, optimizes output.
 *
 * Usage:
 *   bun run bin/screenshot/screenshot.ts              # all recipes
 *   bun run bin/screenshot/screenshot.ts --list       # list recipes
 *   bun run bin/screenshot/screenshot.ts --recipe X   # single recipe
 *   bun run bin/screenshot/screenshot.ts --stills     # only PNGs
 *   bun run bin/screenshot/screenshot.ts --gifs       # only GIFs
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { RECIPES, type Recipe } from './recipes.ts';
import { buildTape } from './tape.ts';

// ─── Paths ──────────────────────────────────────────────────────────────────

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = resolve(SCRIPT_DIR, '../..');
const OUT_DIR = resolve(SCRIPT_DIR, 'out');
const TAPES_DIR = resolve(SCRIPT_DIR, 'tapes');
const DEST_DIR = resolve(PROJECT_ROOT, '.www/public/screenshots');

// The localpress entrypoint directory (so VHS shell can find the binary)
const LOCALPRESS_BIN_DIR = resolve(PROJECT_ROOT, 'node_modules/.bin');

// ─── CLI args ───────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    list: { type: 'boolean', default: false },
    recipe: { type: 'string' },
    stills: { type: 'boolean', default: false },
    gifs: { type: 'boolean', default: false },
    'skip-optimize': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
  strict: true,
});

// ─── List mode ──────────────────────────────────────────────────────────────

if (values.list) {
  console.log('\nAvailable recipes:\n');
  const maxName = Math.max(...RECIPES.map((r) => r.name.length));
  for (const r of RECIPES) {
    const type = r.emitGif ? '🎬 GIF' : '📸 PNG';
    console.log(`  ${r.name.padEnd(maxName)}  ${type}  ${r.description}`);
  }
  console.log(`\n  Total: ${RECIPES.length} recipes\n`);
  process.exit(0);
}

// ─── Filter recipes ─────────────────────────────────────────────────────────

let recipes: Recipe[] = RECIPES;

if (values.recipe) {
  const found = RECIPES.find((r) => r.name === values.recipe);
  if (!found) {
    console.error(`❌ Unknown recipe: "${values.recipe}"`);
    console.error(`   Available: ${RECIPES.map((r) => r.name).join(', ')}`);
    process.exit(1);
  }
  recipes = [found];
} else if (values.stills) {
  recipes = RECIPES.filter((r) => !r.emitGif);
} else if (values.gifs) {
  recipes = RECIPES.filter((r) => r.emitGif === true);
}

// ─── Ensure directories ─────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(TAPES_DIR, { recursive: true });
mkdirSync(DEST_DIR, { recursive: true });

// ─── Check dependencies ─────────────────────────────────────────────────────

async function which(cmd: string): Promise<boolean> {
  const proc = Bun.spawn(['which', cmd], { stdout: 'pipe', stderr: 'pipe' });
  await proc.exited;
  return proc.exitCode === 0;
}

async function checkDeps(): Promise<void> {
  if (!(await which('vhs'))) {
    console.error('❌ VHS not found. Install: brew install vhs');
    process.exit(1);
  }
  if (!(await which('gifsicle'))) {
    console.warn('⚠️  gifsicle not found — GIFs will not be optimized.');
    console.warn('   Install: brew install gifsicle');
  }
}

// ─── Run a single recipe ────────────────────────────────────────────────────

async function runRecipe(recipe: Recipe): Promise<void> {
  const isGif = recipe.emitGif === true;
  const ext = isGif ? 'gif' : 'png';
  const outputFile = `${recipe.name}.${ext}`;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${isGif ? '🎬' : '📸'} ${recipe.name} — ${recipe.description}`);
  console.log(`${'─'.repeat(60)}`);

  // 1. Build the tape
  const tape = buildTape(recipe, { localPressBin: LOCALPRESS_BIN_DIR, projectRoot: PROJECT_ROOT });
  const tapeFile = resolve(TAPES_DIR, `${recipe.name}.tape`);
  await Bun.write(tapeFile, tape);

  if (values['dry-run']) {
    console.log(`  📄 Tape written: ${tapeFile}`);
    console.log('  (dry-run — skipping VHS render)');
    return;
  }

  // 2. Run VHS
  console.log('  ▶ Running VHS...');
  const vhsProc = Bun.spawn(['vhs', tapeFile], {
    cwd: OUT_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await vhsProc.exited;
  const stderr = await new Response(vhsProc.stderr).text();
  if (exitCode !== 0) {
    console.error(`  ❌ VHS failed (exit ${exitCode}):`);
    console.error(`     ${stderr.trim()}`);
    return;
  }
  if (stderr.trim()) {
    // VHS always prints "File: ..." to stderr — only show other warnings
    const meaningful = stderr
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('File:'))
      .join('\n');
    if (meaningful) {
      console.log(`  ⚠️  VHS: ${meaningful.trim().split('\n')[0]}`);
    }
  }

  const rawOutput = resolve(OUT_DIR, outputFile);

  // VHS may flush the file slightly after process exit — wait briefly if needed
  let found = existsSync(rawOutput);
  if (!found) {
    for (let i = 0; i < 5; i++) {
      await Bun.sleep(500);
      found = existsSync(rawOutput);
      if (found) break;
    }
  }

  if (!found) {
    // Retry once — VHS occasionally fails to write Screenshot output
    console.log('  ⟳ Retrying VHS (output not found on first attempt)...');
    const retryProc = Bun.spawn(['vhs', tapeFile], {
      cwd: OUT_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await retryProc.exited;
    // Wait for filesystem
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(500);
      found = existsSync(rawOutput);
      if (found) break;
    }
  }

  if (!found) {
    console.error(`  ❌ Expected output not found: ${rawOutput}`);
    return;
  }

  // 3. Optimize GIFs losslessly
  if (isGif && !values['skip-optimize']) {
    await optimizeGif(rawOutput);
  }

  // 4. Copy to destination
  const destFile = resolve(DEST_DIR, outputFile);
  const file = Bun.file(rawOutput);
  await Bun.write(destFile, file);

  const sizeKb = ((await file.arrayBuffer()).byteLength / 1024).toFixed(1);
  console.log(`  ✅ ${outputFile} (${sizeKb} KB) → ${destFile}`);
}

// ─── GIF optimization ───────────────────────────────────────────────────────

async function optimizeGif(filePath: string): Promise<void> {
  if (!(await which('gifsicle'))) {
    console.log('  ⚠️  Skipping GIF optimization (gifsicle not installed)');
    return;
  }

  const before = Bun.file(filePath);
  const beforeSize = (await before.arrayBuffer()).byteLength;

  // Lossless pass first
  console.log('  🗜️  Optimizing with gifsicle -O3...');
  const proc = Bun.spawn(['gifsicle', '-O3', '--batch', filePath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await proc.exited;

  let after = Bun.file(filePath);
  let afterSize = (await after.arrayBuffer()).byteLength;

  // If still over 600 KB, apply mild lossy compression
  if (afterSize > 600 * 1024) {
    console.log('     Still large — applying lossy compression...');
    const lossyProc = Bun.spawn(['gifsicle', '-O3', '--lossy=100', '--batch', filePath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await lossyProc.exited;
    after = Bun.file(filePath);
    afterSize = (await after.arrayBuffer()).byteLength;
  }

  const ratio = ((1 - afterSize / beforeSize) * 100).toFixed(1);
  console.log(
    `     ${(beforeSize / 1024).toFixed(0)} KB → ${(afterSize / 1024).toFixed(0)} KB (${ratio}% reduction)`,
  );
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🎥 localpress screenshot pipeline');
  console.log(`   Recipes: ${recipes.length} | Output: ${OUT_DIR}`);

  await checkDeps();

  const startTime = Date.now();

  for (const recipe of recipes) {
    await runRecipe(recipe);
    // Small cooldown between recipes to avoid VHS process contention
    await Bun.sleep(1000);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✨ Done! ${recipes.length} capture(s) in ${elapsed}s`);
  console.log(`   Output: ${DEST_DIR}\n`);

  // Cleanup generated tapes (keep out/ for debugging)
  if (!values['dry-run']) {
    rmSync(TAPES_DIR, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
