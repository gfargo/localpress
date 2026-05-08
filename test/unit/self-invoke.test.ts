/**
 * Unit tests for the self-invoke utility.
 *
 * Verifies correct binary path and argument construction for:
 *  - Dev mode (bun src/cli/index.ts)
 *  - Tarball distribution (wrapper script sets LOCALPRESS_BIN)
 *  - Fallback (localpress on PATH)
 */

import { describe, expect, test } from 'bun:test';

import { buildSelfArgs, getSelfBin, isDevMode } from '../../src/cli/utils/self-invoke.ts';

const EMPTY_ENV: NodeJS.ProcessEnv = {};

// -- isDevMode ----------------------------------------------------------------

describe('isDevMode', () => {
  test('returns true when argv[1] is a .ts file and execPath is bun', () => {
    const argv = ['/usr/local/bin/bun', 'src/cli/index.ts', 'list', '-i'];
    expect(isDevMode(argv, '/usr/local/bin/bun', EMPTY_ENV)).toBe(true);
  });

  test('returns true when argv[1] is a .mts file', () => {
    const argv = ['/usr/local/bin/bun', 'src/cli/index.mts', 'list'];
    expect(isDevMode(argv, '/usr/local/bin/bun', EMPTY_ENV)).toBe(true);
  });

  test('returns true when argv[1] is a .js file', () => {
    const argv = ['/usr/local/bin/node', 'dist/index.js', 'list'];
    expect(isDevMode(argv, '/usr/local/bin/node', EMPTY_ENV)).toBe(true);
  });

  test('returns false when LOCALPRESS_BIN is set (tarball distribution)', () => {
    const argv = ['/usr/local/bin/bun', '/opt/homebrew/libexec/localpress/bundle.js', 'list'];
    const env = { LOCALPRESS_BIN: '/opt/homebrew/bin/localpress' };
    expect(isDevMode(argv, '/usr/local/bin/bun', env)).toBe(false);
  });

  test('returns false when execPath contains localpress', () => {
    const argv = ['/usr/local/bin/localpress', 'list', '-i'];
    expect(isDevMode(argv, '/usr/local/bin/localpress', EMPTY_ENV)).toBe(false);
  });

  test('returns false when argv[1] is a subcommand (not a script file)', () => {
    const argv = ['/usr/local/bin/localpress', 'list', '-i'];
    expect(isDevMode(argv, '/usr/local/bin/localpress', EMPTY_ENV)).toBe(false);
  });

  test('returns false when argv is empty', () => {
    expect(isDevMode([], '/usr/local/bin/bun', EMPTY_ENV)).toBe(false);
  });

  test('returns false when argv has only one element', () => {
    expect(isDevMode(['/usr/local/bin/localpress'], '/usr/local/bin/localpress', EMPTY_ENV)).toBe(
      false,
    );
  });
});

// -- getSelfBin ---------------------------------------------------------------

describe('getSelfBin', () => {
  test('returns argv[0] in dev mode (bun)', () => {
    const argv = ['/usr/local/bin/bun', 'src/cli/index.ts', 'list'];
    expect(getSelfBin(argv, '/usr/local/bin/bun', EMPTY_ENV)).toBe('/usr/local/bin/bun');
  });

  test('returns LOCALPRESS_BIN when set (tarball distribution)', () => {
    const argv = ['/usr/local/bin/bun', '/opt/homebrew/libexec/localpress/bundle.js', 'list'];
    const env = { LOCALPRESS_BIN: '/opt/homebrew/bin/localpress' };
    expect(getSelfBin(argv, '/usr/local/bin/bun', env)).toBe('/opt/homebrew/bin/localpress');
  });

  test('LOCALPRESS_BIN takes precedence even in dev-mode-looking args', () => {
    const argv = ['/usr/local/bin/bun', 'src/cli/index.ts', 'list'];
    const env = { LOCALPRESS_BIN: '/usr/local/bin/localpress' };
    expect(getSelfBin(argv, '/usr/local/bin/bun', env)).toBe('/usr/local/bin/localpress');
  });

  test('returns execPath when it contains localpress (fallback)', () => {
    const argv = ['/usr/local/bin/localpress', 'list', '-i'];
    expect(getSelfBin(argv, '/usr/local/bin/localpress', EMPTY_ENV)).toBe(
      '/usr/local/bin/localpress',
    );
  });

  test('falls back to localpress on PATH when execPath is bun without LOCALPRESS_BIN', () => {
    // Non-script argv[1] means not dev mode, execPath doesn't contain localpress
    const argv = ['/usr/local/bin/bun', 'some-arg'];
    expect(getSelfBin(argv, '/usr/local/bin/bun', EMPTY_ENV)).toBe('localpress');
  });
});

// -- buildSelfArgs ------------------------------------------------------------

describe('buildSelfArgs', () => {
  test('dev mode: includes script path before command', () => {
    const argv = ['/usr/local/bin/bun', 'src/cli/index.ts', 'list', '-i'];
    const args = buildSelfArgs(argv, '/usr/local/bin/bun', 'optimize', '123', [], EMPTY_ENV);
    expect(args).toEqual(['src/cli/index.ts', 'optimize', '123']);
  });

  test('dev mode: includes extra args', () => {
    const argv = ['/usr/local/bin/bun', 'src/cli/index.ts', 'list', '-i'];
    const args = buildSelfArgs(
      argv,
      '/usr/local/bin/bun',
      'optimize',
      '123',
      ['--quality', '85', '--preview'],
      EMPTY_ENV,
    );
    expect(args).toEqual(['src/cli/index.ts', 'optimize', '123', '--quality', '85', '--preview']);
  });

  test('tarball distribution: just cmd + args (wrapper handles bundle path)', () => {
    const argv = ['/usr/local/bin/bun', '/opt/homebrew/libexec/localpress/bundle.js', 'list'];
    const env = { LOCALPRESS_BIN: '/opt/homebrew/bin/localpress' };
    const args = buildSelfArgs(argv, '/usr/local/bin/bun', 'optimize', '123', [], env);
    expect(args).toEqual(['optimize', '123']);
  });

  test('wrapper install: command is first arg (no script path)', () => {
    const argv = ['/usr/local/bin/localpress', 'list', '-i'];
    const args = buildSelfArgs(argv, '/usr/local/bin/localpress', 'optimize', '123', [], EMPTY_ENV);
    expect(args).toEqual(['optimize', '123']);
  });

  test('wrapper install: includes extra args', () => {
    const argv = ['/usr/local/bin/localpress', 'list', '-i'];
    const args = buildSelfArgs(
      argv,
      '/usr/local/bin/localpress',
      'remove-bg',
      '456',
      ['--model', 'birefnet-lite'],
      EMPTY_ENV,
    );
    expect(args).toEqual(['remove-bg', '456', '--model', 'birefnet-lite']);
  });
});
