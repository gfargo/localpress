/**
 * Sharp loader with graceful error handling.
 *
 * Sharp is a native module (libvips bindings) that can't be bundled into
 * Bun's compiled single-file binaries. It must be installed separately
 * on the user's machine.
 *
 * This loader:
 *   1. Tries to import sharp (works in dev mode and when globally installed)
 *   2. Throws a clear, actionable error if sharp isn't found
 *
 * The result is cached — module resolution only happens once per process.
 */

// biome-ignore lint/suspicious/noExplicitAny: sharp's type export varies by version
type SharpModule = any;

let cachedSharp: SharpModule | null = null;

/**
 * Load sharp with a helpful error message if it's not installed.
 *
 * Results are cached — subsequent calls return immediately.
 */
export async function loadSharp(): Promise<SharpModule> {
  if (cachedSharp) return cachedSharp;

  try {
    const mod = await import('sharp');
    cachedSharp = mod.default;
    return cachedSharp;
  } catch {
    // sharp not available.
  }

  throw new Error(
    'sharp is not installed. Image processing requires sharp (libvips).\n\n' +
      'Quick fix:\n' +
      '  bun install -g sharp\n\n' +
      'Or with npm:\n' +
      '  npm install -g sharp\n\n' +
      'On macOS with Homebrew:\n' +
      '  brew install vips && bun install -g sharp\n\n' +
      'After installing, run `localpress doctor` to verify.\n' +
      'See: https://sharp.pixelplumbing.com/install',
  );
}
