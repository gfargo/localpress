/**
 * `localpress update` — self-update command.
 *
 * Checks GitHub Releases for a newer version and offers to download and
 * extract the tarball to replace the current installation.
 *
 * Behavior:
 *   - `localpress update`         — check for updates, prompt to install
 *   - `localpress update --check` — just check (exit 1 if update available)
 *   - `localpress update --yes`   — auto-install without prompting
 *
 * For Homebrew users, suggests `brew upgrade localpress` instead of
 * downloading directly.
 */

import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, cp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Command } from 'commander';

import packageJson from '../../../package.json' with { type: 'json' };
import { parseChecksums, verifyChecksum } from '../../engine/update/checksum.ts';
import { performAtomicSwap } from '../../engine/update/swap.ts';
import { error, info, printJson, warn } from '../utils/output.ts';
import { promptYesNo } from '../utils/prompt.ts';

const GITHUB_REPO = 'gfargo/localpress';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
    size: number;
  }>;
}

interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  downloadUrl: string | null;
  checksumsUrl: string | null;
  releaseUrl: string;
  assetName: string | null;
  assetSize: number | null;
}

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('Check for updates and optionally self-update localpress')
    .option('--check', 'just check for updates without installing (exit 1 if update available)')
    .action(async (options) => {
      const parentOpts = program.opts();
      const isJson = Boolean(parentOpts.json);
      const autoYes = Boolean(parentOpts.yes);
      const checkOnly = Boolean(options.check);

      const result = await checkForUpdate();

      if (isJson) {
        printJson(result);
        if (checkOnly && result.updateAvailable) process.exit(1);
        if (checkOnly || !result.updateAvailable) return;
      } else {
        info(`Current version: ${result.currentVersion}`);
        info(`Latest version:  ${result.latestVersion}`);
        info('');

        if (!result.updateAvailable) {
          info('✓ You are already on the latest version.');
          return;
        }

        info(`⬆ Update available: v${result.currentVersion} → v${result.latestVersion}`);
        info(`  Release: ${result.releaseUrl}`);
        info('');

        if (checkOnly) process.exit(1);
      }

      // Detect if running via Homebrew.
      const installDir = detectInstallDir();
      const isHomebrew = installDir.includes('/Cellar/') || installDir.includes('/homebrew/');

      if (isHomebrew) {
        if (isJson) {
          printJson({ ...result, method: 'homebrew', command: 'brew upgrade localpress' });
        } else {
          info('Detected Homebrew installation. Update with:');
          info('');
          info('  brew upgrade localpress');
          info('');
        }
        return;
      }

      if (!result.downloadUrl || !result.assetName) {
        error(
          `No release available for your platform (${process.platform}-${process.arch}). ` +
            `Download manually from: ${result.releaseUrl}`,
        );
        process.exit(1);
      }

      // Prompt for confirmation unless --yes.
      if (!autoYes) {
        const sizeStr = result.assetSize ? ` (${formatBytes(result.assetSize)})` : '';
        info(`Archive: ${result.assetName}${sizeStr}`);
        info(`Install: ${installDir}`);
        info('');

        const confirmed = await promptYesNo('Install update? [y/N]');
        if (!confirmed) {
          info('Update cancelled.');
          return;
        }
      }

      await downloadAndReplace(
        result.downloadUrl,
        result.checksumsUrl,
        result.assetName,
        installDir,
        isJson,
      );
    });
}

// -- Core logic ---------------------------------------------------------------

/**
 * Detect the install directory (where bundle.js lives).
 * In tarball distribution, this is the directory containing bundle.js.
 */
function detectInstallDir(): string {
  // process.argv[1] is the bundle.js path when run via wrapper script.
  // For compiled-binary fallback, use process.execPath.
  const scriptPath = process.argv[1] ?? process.execPath;
  return dirname(resolve(scriptPath));
}

async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = packageJson.version;

  let release: GitHubRelease;
  try {
    const response = await fetch(RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `localpress/${currentVersion}`,
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`);
    }

    release = (await response.json()) as GitHubRelease;
  } catch (err) {
    error(`Failed to check for updates: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(4); // NetworkError
  }

  const latestVersion = release.tag_name.replace(/^v/, '');
  const updateAvailable = isNewerVersion(latestVersion, currentVersion);

  // Only trust https:// asset URLs — GitHub always serves these, but don't
  // blindly follow whatever the API response contains.
  const httpsAssets = release.assets.filter((a) => a.browser_download_url.startsWith('https://'));

  const assetName = getAssetName();
  const asset = httpsAssets.find((a) => a.name === assetName);
  const checksumsAsset = httpsAssets.find((a) => a.name === 'checksums.txt');

  return {
    currentVersion,
    latestVersion,
    updateAvailable,
    downloadUrl: asset?.browser_download_url ?? null,
    checksumsUrl: checksumsAsset?.browser_download_url ?? null,
    releaseUrl: release.html_url,
    assetName: asset?.name ?? assetName,
    assetSize: asset?.size ?? null,
  };
}

/**
 * Download and parse a `checksums.txt` release asset into a
 * `filename → sha256hex` map.
 */
async function downloadChecksums(url: string): Promise<Map<string, string>> {
  const response = await fetch(url, {
    headers: { 'User-Agent': `localpress/${packageJson.version}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to download checksums.txt: ${response.status} ${response.statusText}`);
  }

  return parseChecksums(await response.text());
}

async function downloadAndReplace(
  downloadUrl: string,
  checksumsUrl: string | null,
  assetName: string | null,
  installDir: string,
  isJson: boolean,
): Promise<void> {
  if (!downloadUrl.startsWith('https://')) {
    error(`Refusing to download from a non-HTTPS URL: ${downloadUrl}`);
    process.exit(1);
  }
  if (checksumsUrl && !checksumsUrl.startsWith('https://')) {
    error(`Refusing to download checksums from a non-HTTPS URL: ${checksumsUrl}`);
    process.exit(1);
  }

  const tmpArchive = join(tmpdir(), `localpress-update-${Date.now()}.tar.gz`);
  const tmpExtract = join(tmpdir(), `localpress-update-${Date.now()}-extracted`);
  let stagingDir: string | null = null;

  const onSignalDuringSwap = () => {
    warn('Update in progress — waiting for the current step to finish before exiting...');
  };

  try {
    // Download the tarball.
    if (!isJson) info('Downloading...');

    const response = await fetch(downloadUrl, {
      headers: { 'User-Agent': `localpress/${packageJson.version}` },
    });

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('Download failed: empty response body');
    }

    const nodeStream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
    const fileStream = createWriteStream(tmpArchive);
    await pipeline(nodeStream, fileStream);

    // Verify checksum before touching anything on disk beyond the temp archive.
    if (!checksumsUrl) {
      throw new Error(
        'No checksums.txt found in the release — refusing to install an unverified update.',
      );
    }
    if (!assetName) {
      throw new Error('Could not determine the expected asset name for checksum lookup.');
    }

    if (!isJson) info('Verifying checksum...');
    const checksums = await downloadChecksums(checksumsUrl);
    const expectedHash = checksums.get(assetName);
    if (!expectedHash) {
      throw new Error(`No checksum entry found for ${assetName} in checksums.txt`);
    }
    await verifyChecksum(tmpArchive, expectedHash);

    // Extract.
    if (!isJson) info('Extracting...');
    await mkdir(tmpExtract, { recursive: true });
    const isZip = downloadUrl.endsWith('.zip');
    const extractResult = isZip
      ? spawnSync('unzip', ['-q', tmpArchive, '-d', tmpExtract])
      : spawnSync('tar', ['xzf', tmpArchive, '-C', tmpExtract]);
    if (extractResult.status !== 0) {
      throw new Error('Extraction failed');
    }

    // Find the extracted dir (localpress-<platform>/)
    const { readdirSync } = await import('node:fs');
    const extractedSubdirs = readdirSync(tmpExtract).filter((n) => n.startsWith('localpress-'));
    if (extractedSubdirs.length === 0) {
      throw new Error('Extracted archive has unexpected structure');
    }
    const extractedDir = join(tmpExtract, extractedSubdirs[0]);

    // installDir might be `.../libexec/bin` — we want to replace the parent libexec
    // Find the directory that contains bundle.js
    let targetDir = installDir;
    if (!existsSync(join(targetDir, 'bundle.js'))) {
      // Maybe we're in bin/, try parent
      targetDir = dirname(installDir);
      if (!existsSync(join(targetDir, 'bundle.js'))) {
        throw new Error(
          `Could not find bundle.js — install location unexpected. Current dir: ${installDir}`,
        );
      }
    }

    // Copy the extracted tree into a staging dir that's a sibling of
    // targetDir (same filesystem), so the final swap can use atomic renames.
    if (!isJson) info('Installing...');
    stagingDir = `${targetDir}-staging-${Date.now()}`;
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    await cp(extractedDir, stagingDir, { recursive: true });

    // Ensure wrapper script is executable before it goes live.
    const wrapperPath = join(stagingDir, 'bin', 'localpress');
    if (existsSync(wrapperPath)) {
      await chmod(wrapperPath, 0o755);
    }

    // The swap itself is just two renames — near-instantaneous — but catch
    // signals during the window so we don't exit mid-rename.
    process.once('SIGINT', onSignalDuringSwap);
    process.once('SIGTERM', onSignalDuringSwap);
    try {
      await performAtomicSwap(targetDir, stagingDir);
    } finally {
      process.off('SIGINT', onSignalDuringSwap);
      process.off('SIGTERM', onSignalDuringSwap);
    }
    stagingDir = null;

    if (isJson) {
      printJson({ success: true, path: targetDir });
    } else {
      info('');
      info('✓ Update installed successfully!');
      info(`  Install dir: ${targetDir}`);
      info('  Run `localpress --version` to confirm.');
    }
  } catch (err) {
    error(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    // Clean up temp files.
    await rm(tmpArchive, { force: true }).catch(() => {});
    await rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
    if (stagingDir) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// -- Helpers ------------------------------------------------------------------

/**
 * Compare two semver strings. Returns true if `latest` is newer than `current`.
 */
function isNewerVersion(latest: string, current: string): boolean {
  const latestParts = latest.split('.').map(Number);
  const currentParts = current.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const l = latestParts[i] ?? 0;
    const c = currentParts[i] ?? 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

/**
 * Get the expected tarball asset name for the current platform.
 */
function getAssetName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') return 'localpress-windows-x64.zip';

  const platformName = platform === 'darwin' ? 'darwin' : 'linux';
  const archName = arch === 'arm64' ? 'arm64' : 'x64';

  return `localpress-${platformName}-${archName}.tar.gz`;
}

/**
 * Format bytes into a human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
