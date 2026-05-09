#!/usr/bin/env bun
/**
 * Build the localpress distribution tarball.
 *
 * Creates a self-contained directory structure:
 *   localpress-<platform>/
 *     bundle.js        — compiled JS from Bun's bundler
 *     package.json     — minimal manifest with production deps
 *     node_modules/    — installed prod dependencies (includes sharp)
 *     bin/localpress   — shell wrapper that execs `bun bundle.js "$@"`
 *     README.txt       — install instructions
 *
 * Then tars and gzips it to ./dist/localpress-<platform>.tar.gz
 *
 * Usage:
 *   bun run scripts/build-tarball.ts [--platform darwin-arm64|darwin-x64|linux-arm64|linux-x64|windows-x64]
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface BuildOptions {
  platform: string;
  archiveFormat: 'tar.gz' | 'zip';
}

const DIST = './dist';
const PROJECT_ROOT = process.cwd();

async function main() {
  const args = process.argv.slice(2);
  const platformArg = args.find((a) => a.startsWith('--platform='))?.split('=')[1];
  const platform = platformArg ?? detectPlatform();

  // Windows gets a .zip, everything else gets .tar.gz
  const archiveFormat: 'tar.gz' | 'zip' = platform.startsWith('windows') ? 'zip' : 'tar.gz';

  console.log(`Building localpress distribution for ${platform}...`);

  await buildTarball({ platform, archiveFormat });

  console.log(`\n✓ Built dist/localpress-${platform}.${archiveFormat}`);
}

async function buildTarball(opts: BuildOptions): Promise<void> {
  const { platform, archiveFormat } = opts;
  const stagingDir = join(DIST, `localpress-${platform}`);
  const archivePath = join(DIST, `localpress-${platform}.${archiveFormat}`);

  // 1. Clean previous build
  if (existsSync(stagingDir)) {
    await rm(stagingDir, { recursive: true, force: true });
  }
  if (existsSync(archivePath)) {
    await rm(archivePath);
  }
  await mkdir(stagingDir, { recursive: true });

  // 2. Bundle the CLI with Bun (no --compile, just a JS bundle)
  console.log('  Bundling JS...');
  const bundleResult = spawnSync(
    'bun',
    [
      'build',
      './src/cli/index.ts',
      '--target=bun',
      '--format=esm',
      '--external=sharp',
      '--external=onnxruntime-node',
      '--external=@jsquash/*',
      `--outdir=${stagingDir}`,
      '--entry-naming=bundle.js',
    ],
    { stdio: 'inherit' },
  );
  if (bundleResult.status !== 0) {
    throw new Error('Bun bundle failed');
  }

  // 3. Write a minimal package.json for production deps
  console.log('  Writing production package.json...');
  const fullPkg = JSON.parse(
    await readFile(join(PROJECT_ROOT, 'package.json'), 'utf-8'),
  ) as PackageJson;
  const prodPkg = {
    name: fullPkg.name,
    version: fullPkg.version,
    description: fullPkg.description,
    license: fullPkg.license,
    type: 'module',
    dependencies: fullPkg.dependencies,
  };
  await writeFile(join(stagingDir, 'package.json'), JSON.stringify(prodPkg, null, 2));

  // 4. Install production dependencies
  console.log('  Installing production dependencies (this may take a minute)...');
  const [os, arch] = parsePlatform(platform);
  const installEnv = {
    ...process.env,
    // Force bun/npm to install the right platform-specific packages for sharp
  };

  // Use npm with explicit --os and --cpu flags so cross-platform builds install the right sharp binaries
  const installResult = spawnSync(
    'npm',
    [
      'install',
      '--production',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
      `--os=${os}`,
      `--cpu=${arch}`,
    ],
    { cwd: stagingDir, stdio: 'inherit', env: installEnv },
  );
  if (installResult.status !== 0) {
    throw new Error('npm install failed');
  }

  // 5. Write the wrapper script
  console.log('  Writing wrapper script...');
  if (platform.startsWith('windows')) {
    // Windows batch file
    const batWrapper = `@echo off
setlocal
set "DIR=%~dp0.."
bun "%DIR%\\bundle.js" %*
`;
    await mkdir(join(stagingDir, 'bin'), { recursive: true });
    await writeFile(join(stagingDir, 'bin', 'localpress.cmd'), batWrapper);
  } else {
    // Unix shell wrapper
    const shWrapper = `#!/usr/bin/env bash
# localpress wrapper — invokes the CLI bundle via Bun.
set -e
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"

# Auto-install bun if not found
if ! command -v bun >/dev/null 2>&1; then
  echo "" >&2
  echo "localpress requires Bun (JavaScript runtime)." >&2
  echo "" >&2

  # Try to auto-install
  if [ -t 0 ]; then
    printf "Install Bun now? [Y/n] " >&2
    read -r answer
    case "\$answer" in
      [nN]*) 
        echo "Install manually: curl -fsSL https://bun.sh/install | bash" >&2
        exit 127
        ;;
    esac
  fi

  echo "Installing Bun..." >&2
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="\$HOME/.bun"
  export PATH="\$BUN_INSTALL/bin:\$PATH"

  if ! command -v bun >/dev/null 2>&1; then
    echo "Bun installation failed. Install manually:" >&2
    echo "  curl -fsSL https://bun.sh/install | bash" >&2
    exit 127
  fi
  echo "✓ Bun installed." >&2
  echo "" >&2
fi

# Export the path to this wrapper so the CLI can re-invoke itself
# (used by 'list -i' to spawn subcommands)
export LOCALPRESS_BIN="\${BASH_SOURCE[0]}"

exec bun "$DIR/bundle.js" "$@"
`;
    await mkdir(join(stagingDir, 'bin'), { recursive: true });
    const wrapperPath = join(stagingDir, 'bin', 'localpress');
    await writeFile(wrapperPath, shWrapper);
    await chmod(wrapperPath, 0o755);
  }

  // 6. Write a README
  const readme = `localpress — Local-compute WordPress media optimization
========================================================

Installation:
  1. Install Bun (if not already):
     brew install oven-sh/bun/bun
     # or:
     curl -fsSL https://bun.sh/install | bash

  2. Extract this archive somewhere permanent, e.g. ~/.local/localpress/

  3. Symlink or add to PATH:
     ln -s $(pwd)/bin/localpress /usr/local/bin/localpress

  4. Verify:
     localpress --version
     localpress doctor

For updates:
  localpress update

Homepage: https://localpress.griffen.codes
Issues:   https://github.com/gfargo/localpress/issues
`;
  await writeFile(join(stagingDir, 'README.txt'), readme);

  // 7. Create the archive
  console.log(`  Creating ${archiveFormat}...`);
  if (archiveFormat === 'tar.gz') {
    const tarResult = spawnSync('tar', ['czf', archivePath, '-C', DIST, `localpress-${platform}`], {
      stdio: 'inherit',
    });
    if (tarResult.status !== 0) {
      throw new Error('tar failed');
    }
  } else {
    // zip for Windows — run from DIST so paths are relative
    const archiveFilename = `localpress-${platform}.${archiveFormat}`;
    const zipResult = spawnSync('zip', ['-rq', archiveFilename, `localpress-${platform}`], {
      cwd: DIST,
      stdio: 'inherit',
    });
    if (zipResult.status !== 0) {
      throw new Error('zip failed');
    }
  }

  // 8. Print size
  const { statSync } = await import('node:fs');
  const stats = statSync(archivePath);
  console.log(`  Archive size: ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
}

/**
 * Parse a platform string like "darwin-arm64" into os + arch.
 * Used for npm's --os and --cpu flags.
 */
function parsePlatform(platform: string): [os: string, arch: string] {
  const [osPart, ...archParts] = platform.split('-');
  const arch = archParts.join('-');

  // npm --os values: darwin, linux, win32
  // npm --cpu values: arm64, x64
  const osMap: Record<string, string> = {
    darwin: 'darwin',
    linux: 'linux',
    windows: 'win32',
  };

  return [osMap[osPart] ?? osPart, arch];
}

function detectPlatform(): string {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin') return `darwin-${arch === 'arm64' ? 'arm64' : 'x64'}`;
  if (platform === 'linux') return `linux-${arch === 'arm64' ? 'arm64' : 'x64'}`;
  if (platform === 'win32') return 'windows-x64';
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

interface PackageJson {
  name: string;
  version: string;
  description: string;
  license: string;
  dependencies: Record<string, string>;
}

await main();
