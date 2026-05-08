/**
 * Sharp loader with WASM fallback.
 *
 * Tries to load native sharp first (fastest, requires platform binary).
 * Falls back to @img/sharp-wasm32 (bundleable, works in compiled binaries).
 * Throws a helpful error if neither is available.
 *
 * This solves the "Cannot find package 'sharp' from /$bunfs/..." error
 * that occurs in Bun-compiled binaries where native modules can't be bundled.
 */

// biome-ignore lint/suspicious/noExplicitAny: sharp's type export varies between native and wasm
type SharpModule = any;

let cachedSharp: SharpModule | null = null;

/**
 * Load sharp with automatic fallback to WASM.
 *
 * Results are cached — the module resolution only happens once.
 * Subsequent calls return the cached instance immediately.
 */
export async function loadSharp(): Promise<SharpModule> {
  if (cachedSharp) return cachedSharp;

  // Try 1: Native sharp (fast, requires platform-specific binary).
  try {
    const mod = await import('sharp');
    cachedSharp = mod.default;
    return cachedSharp;
  } catch {
    // Native sharp not available — try WASM fallback.
  }

  // Try 2: WASM build (slower but works everywhere, bundleable).
  try {
    const mod = await import('@img/sharp-wasm32');
    cachedSharp = mod.default ?? mod;
    return cachedSharp;
  } catch {
    // WASM also not available.
  }

  // Neither available — throw helpful error.
  throw new Error(
    'sharp is not installed. Image processing requires sharp.\n\n' +
      'Install it with:\n' +
      '  npm install -g sharp\n' +
      '  # or, if using Bun:\n' +
      '  bun install -g sharp\n\n' +
      'If you installed localpress via Homebrew, run:\n' +
      '  brew install vips && npm install -g sharp\n\n' +
      'See: https://sharp.pixelplumbing.com/install',
  );
}
