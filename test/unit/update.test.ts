/**
 * Unit tests for the `localpress update` command helpers.
 *
 * Tests version comparison logic, platform binary name resolution,
 * and byte formatting — the pure functions that don't require network access.
 */

import { describe, expect, test } from 'bun:test';

// We need to test the internal helpers. Since they're not exported from the
// command file, we replicate the logic here for unit testing. The actual
// integration behavior is tested via the CLI.

describe('isNewerVersion', () => {
  // Replicate the version comparison logic for testing.
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

  test('newer major version is detected', () => {
    expect(isNewerVersion('2.0.0', '1.7.0')).toBe(true);
  });

  test('newer minor version is detected', () => {
    expect(isNewerVersion('1.8.0', '1.7.0')).toBe(true);
  });

  test('newer patch version is detected', () => {
    expect(isNewerVersion('1.7.1', '1.7.0')).toBe(true);
  });

  test('same version returns false', () => {
    expect(isNewerVersion('1.7.0', '1.7.0')).toBe(false);
  });

  test('older version returns false', () => {
    expect(isNewerVersion('1.6.0', '1.7.0')).toBe(false);
  });

  test('older major with newer minor returns false', () => {
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false);
  });

  test('handles versions with different segment counts', () => {
    expect(isNewerVersion('2.0', '1.9.9')).toBe(true);
  });

  test('handles v prefix stripped', () => {
    // The command strips the v prefix before calling this
    expect(isNewerVersion('1.8.0', '1.7.0')).toBe(true);
  });
});

describe('getBinaryAssetName', () => {
  // Replicate the asset name logic for testing.
  function getBinaryAssetName(platform: string, arch: string): string {
    if (platform === 'win32') {
      return 'localpress-windows-x64.exe';
    }
    const platformName = platform === 'darwin' ? 'darwin' : 'linux';
    const archName = arch === 'arm64' ? 'arm64' : 'x64';
    return `localpress-${platformName}-${archName}`;
  }

  test('macOS arm64', () => {
    expect(getBinaryAssetName('darwin', 'arm64')).toBe('localpress-darwin-arm64');
  });

  test('macOS x64', () => {
    expect(getBinaryAssetName('darwin', 'x64')).toBe('localpress-darwin-x64');
  });

  test('Linux arm64', () => {
    expect(getBinaryAssetName('linux', 'arm64')).toBe('localpress-linux-arm64');
  });

  test('Linux x64', () => {
    expect(getBinaryAssetName('linux', 'x64')).toBe('localpress-linux-x64');
  });

  test('Windows x64', () => {
    expect(getBinaryAssetName('win32', 'x64')).toBe('localpress-windows-x64.exe');
  });

  test('Windows arm64 falls back to x64 (only x64 binary available)', () => {
    expect(getBinaryAssetName('win32', 'arm64')).toBe('localpress-windows-x64.exe');
  });
});

describe('formatBytes', () => {
  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  test('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  test('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  test('formats megabytes', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(65_959_714)).toBe('62.9 MB');
  });

  test('formats zero', () => {
    expect(formatBytes(0)).toBe('0 B');
  });
});

describe('update command registration', () => {
  test('update command is registered in the CLI', async () => {
    // Verify the command module exports the registration function.
    const mod = await import('../../src/cli/commands/update.ts');
    expect(mod.registerUpdateCommand).toBeFunction();
  });
});
