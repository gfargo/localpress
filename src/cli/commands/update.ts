/**
 * `localpress update` — self-update command.
 *
 * Checks GitHub Releases for a newer version and offers to download and
 * replace the current binary.
 *
 * Behavior:
 *   - `localpress update`         — check for updates, prompt to install
 *   - `localpress update --check` — just check, don't install (exit 0 if up-to-date, exit 1 if update available)
 *   - `localpress update --yes`   — auto-install without prompting
 *
 * For Homebrew users, suggests `brew upgrade localpress` instead of
 * downloading directly.
 */

import { createWriteStream, existsSync } from 'node:fs';
import { chmod, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Command } from 'commander';

import packageJson from '../../../package.json' with { type: 'json' };
import { error, info, printJson } from '../utils/output.ts';

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
    .description('Check for updates and optionally self-update the localpress binary')
    .option('--check', 'just check for updates without installing (exit 1 if update available)')
    .action(async (options) => {
      const parentOpts = program.opts();
      const isJson = Boolean(parentOpts.json);
      const autoYes = Boolean(parentOpts.yes);
      const checkOnly = Boolean(options.check);

      const result = await checkForUpdate();

      if (isJson) {
        printJson(result);
        if (checkOnly && result.updateAvailable) {
          process.exit(1);
        }
        if (checkOnly || !result.updateAvailable) {
          return;
        }
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

        if (checkOnly) {
          process.exit(1);
        }
      }

      // Detect if running via Homebrew.
      const binaryPath = process.execPath;
      const isHomebrew = binaryPath.includes('/Cellar/') || binaryPath.includes('/homebrew/');

      if (isHomebrew) {
        if (isJson) {
          printJson({
            ...result,
            method: 'homebrew',
            command: 'brew upgrade localpress',
          });
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
          `No binary available for your platform (${process.platform}-${process.arch}). ` +
            `Download manually from: ${result.releaseUrl}`,
        );
        process.exit(1);
      }

      // Prompt for confirmation unless --yes.
      if (!autoYes) {
        const sizeStr = result.assetSize ? ` (${formatBytes(result.assetSize)})` : '';
        info(`Binary: ${result.assetName}${sizeStr}`);
        info(`Target: ${binaryPath}`);
        info('');

        const confirmed = await promptConfirm('Install update?');
        if (!confirmed) {
          info('Update cancelled.');
          return;
        }
      }

      // Download and replace.
      await downloadAndReplace(result.downloadUrl, binaryPath, isJson);
    });
}

// -- Core logic ---------------------------------------------------------------

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

  // Find the correct binary for this platform.
  const assetName = getBinaryAssetName();
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
  binaryPath: string,
  isJson: boolean,
): Promise<void> {
  const tmpPath = join(tmpdir(), `localpress-update-${Date.now()}`);

  try {
    // Download to temp file.
    if (!isJson) {
      info('Downloading...');
    }

    const response = await fetch(downloadUrl, {
      headers: { 'User-Agent': `localpress/${packageJson.version}` },
    });

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('Download failed: empty response body');
    }

    // Stream the response body to a temp file.
    const nodeStream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
    const fileStream = createWriteStream(tmpPath);
    await pipeline(nodeStream, fileStream);

    // Make executable.
    await chmod(tmpPath, 0o755);

    // Replace the current binary.
    // Try atomic rename first; fall back to copy if cross-device.
    const backupPath = `${binaryPath}.bak`;
    try {
      // Back up current binary.
      if (existsSync(binaryPath)) {
        await rename(binaryPath, backupPath);
      }
      await rename(tmpPath, binaryPath);
      // Clean up backup.
      if (existsSync(backupPath)) {
        await unlink(backupPath).catch(() => {});
      }
    } catch (renameErr) {
      // Cross-device link — fall back to copy.
      const content = await Bun.file(tmpPath).arrayBuffer();
      await Bun.write(binaryPath, content);
      await chmod(binaryPath, 0o755);
      // Restore backup if rename of new file failed.
      if (existsSync(backupPath) && !existsSync(binaryPath)) {
        await rename(backupPath, binaryPath);
      }
    }

    if (isJson) {
      printJson({ success: true, installedVersion: 'latest', path: binaryPath });
    } else {
      info('');
      info('✓ Update installed successfully!');
      info(`  Binary: ${binaryPath}`);
      info('  Run `localpress --version` to confirm.');
    }
  } catch (err) {
    // Clean up temp file on failure.
    if (existsSync(tmpPath)) {
      await unlink(tmpPath).catch(() => {});
    }
    error(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
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
 * Get the expected binary asset name for the current platform.
 */
function getBinaryAssetName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') {
    return 'localpress-windows-x64.exe';
  }

  const platformName = platform === 'darwin' ? 'darwin' : 'linux';
  const archName = arch === 'arm64' ? 'arm64' : 'x64';

  return `localpress-${platformName}-${archName}`;
}

/**
 * Format bytes into a human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Simple y/N confirmation prompt using stdin.
 */
async function promptConfirm(message: string): Promise<boolean> {
  process.stdout.write(`${message} [y/N] `);

  return new Promise((resolve) => {
    const onData = (data: Buffer) => {
      const input = data.toString().trim().toLowerCase();
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      resolve(input === 'y' || input === 'yes');
    };

    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.once('data', onData);
  });
}
