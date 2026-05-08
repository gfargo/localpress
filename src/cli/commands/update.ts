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
import { error, info, printJson } from '../utils/output.ts';
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

      await downloadAndReplace(result.downloadUrl, installDir, isJson);
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

  const assetName = getAssetName();
  const asset = release.assets.find((a) => a.name === assetName);

  return {
    currentVersion,
    latestVersion,
    updateAvailable,
    downloadUrl: asset?.browser_download_url ?? null,
    releaseUrl: release.html_url,
    assetName: asset?.name ?? assetName,
    assetSize: asset?.size ?? null,
  };
}

async function downloadAndReplace(
  downloadUrl: string,
  installDir: string,
  isJson: boolean,
): Promise<void> {
  const tmpArchive = join(tmpdir(), `localpress-update-${Date.now()}.tar.gz`);
  const tmpExtract = join(tmpdir(), `localpress-update-${Date.now()}-extracted`);

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

    // Back up current install, move new in place.
    if (!isJson) info('Installing...');
    const backupDir = `${installDir}.bak-${Date.now()}`;

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

    // Rename existing → backup, copy new → target
    if (existsSync(targetDir)) {
      await rm(backupDir, { recursive: true, force: true }).catch(() => {});
      await cp(targetDir, backupDir, { recursive: true });
    }

    try {
      // Remove old contents, copy new
      const entries = readdirSync(targetDir);
      for (const entry of entries) {
        await rm(join(targetDir, entry), { recursive: true, force: true });
      }
      await cp(extractedDir, targetDir, { recursive: true });

      // Ensure wrapper script is executable
      const wrapperPath = join(targetDir, 'bin', 'localpress');
      if (existsSync(wrapperPath)) {
        await chmod(wrapperPath, 0o755);
      }

      // Clean up backup
      await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    } catch (err) {
      // Restore backup on failure
      if (existsSync(backupDir)) {
        await rm(targetDir, { recursive: true, force: true }).catch(() => {});
        await cp(backupDir, targetDir, { recursive: true });
        await rm(backupDir, { recursive: true, force: true }).catch(() => {});
      }
      throw err;
    }

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
