/**
 * Unit tests for the self-invoke utility.
 *
 * Verifies correct binary path and argument construction for both
 * dev mode (bun src/cli/index.ts) and compiled binary mode (localpress).
 */

import { describe, expect, test } from 'bun:test';

import { buildSelfArgs, getSelfBin, isDevMode } from '../../src/cli/utils/self-invoke.ts';

// -- isDevMode ----------------------------------------------------------------

describe('isDevMode', () => {
  test('returns true when argv[1] is a .ts file and execPath is bun', () => {
    const argv = ['/usr/local/bin/bun', 'src/cli/index.ts', 'list', '-i'];
    expect(isDevMode(argv, '/usr/local/bin/bun')).toBe(true);
  });

  test('returns true when argv[1] is a .mts file', () => {
    const argv = ['/usr/local/bin/bun', 'src/cli/index.mts', 'list'];
    expect(isDevMode(argv, '/usr/local/bin/bun')).toBe(true);
  });

  test('returns true when argv[1] is a .js file', () => {
    const argv = ['/usr/local/bin/node', 'dist/index.js', 'list'];
    expect(isDevMode(argv, '/usr/local/bin/node')).toBe(true);
  });

  test('returns false when execPath contains localpress (compiled binary)', () => {
    // Compiled Bun binaries may still have .ts in argv[1] (embedded source path)
    const argv = ['/usr/local/bin/localpress', 'src/cli/index.ts', 'list', '-i'];
    expect(isDevMode(argv, '/usr/local/bin/localpress')).toBe(false);
  });

  test('returns false when execPath is a Homebrew localpress path', () => {
    const argv = ['/opt/homebrew/Cellar/localpress/1.8.1/bin/localpress', 'list', '-i'];
    expect(isDevMode(argv, '/opt/homebrew/Cellar/localpress/1.8.1/bin/localpress')).toBe(false);
  });

  test('returns false when argv[1] is a subcommand (not a script file)', () => {
    const argv = ['/usr/local/bin/localpress', 'list', '-i'];
    expect(isDevMode(argv, '/usr/local/bin/localpress')).toBe(false);
  });

  test('returns false when argv is empty', () => {
    expect(isDevMode([], '/usr/local/bin/bun')).toBe(false);
  });

  test('returns false when argv has only one element', () => {
    expect(isDevMode(['/usr/local/bin/localpress'], '/usr/local/bin/localpress')).toBe(false);
  });
});

// -- getSelfBin ---------------------------------------------------------------

describe('getSelfBin', () => {
  test('returns argv[0] in dev mode (bun)', () => {
    const argv = ['/usr/local/bin/bun', 'src/cli/index.ts', 'list'];
    expect(getSelfBin(argv, '/usr/local/bin/bun')).toBe('/usr/local/bin/bun');
  });

  test('returns execPath in compiled mode', () => {
    const argv = ['/usr/local/bin/localpress', 'list', '-i'];
    expect(getSelfBin(argv, '/usr/local/bin/localpress')).toBe('/usr/local/bin/localpress');
  });

  test('returns execPath when Homebrew-installed', () => {
    const execPath = '/opt/homebrew/Cellar/localpress/1.8.1/bin/localpress';
    const argv = [execPath, 'list'];
    expect(getSelfBin(argv, execPath)).toBe(execPath);
  });

  test('returns execPath even if argv[1] looks like a script (compiled binary)', () => {
    // Bun compiled binaries can embed the source path in argv
    const argv = ['/usr/local/bin/localpress', 'src/cli/index.ts', 'list'];
    expect(getSelfBin(argv, '/usr/local/bin/localpress')).toBe('/usr/local/bin/localpress');
  });
});

// -- buildSelfArgs ------------------------------------------------------------

describe('buildSelfArgs', () => {
  test('dev mode: includes script path before command', () => {
    const argv = ['/usr/local/bin/bun', 'src/cli/index.ts', 'list', '-i'];
    const args = buildSelfArgs(argv, '/usr/local/bin/bun', 'optimize', '123');
    expect(args).toEqual(['src/cli/index.ts', 'optimize', '123']);
  });

  test('dev mode: includes extra args', () => {
    const argv = ['/usr/local/bin/bun', 'src/cli/index.ts', 'list', '-i'];
    const args = buildSelfArgs(argv, '/usr/local/bin/bun', 'optimize', '123', [
      '--quality',
      '85',
      '--preview',
    ]);
    expect(args).toEqual(['src/cli/index.ts', 'optimize', '123', '--quality', '85', '--preview']);
  });

  test('compiled mode: command is first arg (no script path)', () => {
    const argv = ['/usr/local/bin/localpress', 'list', '-i'];
    const args = buildSelfArgs(argv, '/usr/local/bin/localpress', 'optimize', '123');
    expect(args).toEqual(['optimize', '123']);
  });

  test('compiled mode: includes extra args', () => {
    const argv = ['/usr/local/bin/localpress', 'list', '-i'];
    const args = buildSelfArgs(argv, '/usr/local/bin/localpress', 'remove-bg', '456', [
      '--model',
      'birefnet-lite',
    ]);
    expect(args).toEqual(['remove-bg', '456', '--model', 'birefnet-lite']);
  });

  test('compiled mode: works with Homebrew path', () => {
    const execPath = '/opt/homebrew/Cellar/localpress/1.8.1/bin/localpress';
    const argv = [execPath, 'list', '-i'];
    const args = buildSelfArgs(argv, execPath, 'edit', '789');
    expect(args).toEqual(['edit', '789']);
  });
});
