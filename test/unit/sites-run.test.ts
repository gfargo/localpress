/**
 * Unit tests for `sites run` helpers: tokenizeCommand, aggregateExitCode, resolveSiteNames.
 */

import { describe, expect, test } from 'bun:test';
import {
  aggregateExitCode,
  resolveSiteNames,
  tokenizeCommand,
} from '../../src/cli/commands/sites.ts';
import { ExitCode } from '../../src/types.ts';

// -- tokenizeCommand ----------------------------------------------------------

describe('tokenizeCommand', () => {
  test('splits on spaces', () => {
    expect(tokenizeCommand('audit --json')).toEqual(['audit', '--json']);
  });

  test('preserves double-quoted argument as single token', () => {
    expect(tokenizeCommand('posts create --title "Hello World"')).toEqual([
      'posts',
      'create',
      '--title',
      'Hello World',
    ]);
  });

  test('preserves single-quoted argument as single token', () => {
    expect(tokenizeCommand("metadata 123 --alt 'A nice photo'")).toEqual([
      'metadata',
      '123',
      '--alt',
      'A nice photo',
    ]);
  });

  test('returns empty array for empty string', () => {
    expect(tokenizeCommand('')).toEqual([]);
  });

  test('trims extra spaces between tokens', () => {
    expect(tokenizeCommand('audit  --json')).toEqual(['audit', '--json']);
  });
});

// -- aggregateExitCode --------------------------------------------------------

describe('aggregateExitCode', () => {
  test('returns 0 when all results are ok', () => {
    expect(aggregateExitCode([{ ok: true }, { ok: true }])).toBe(0);
  });

  test('returns 1 when any result is not ok', () => {
    expect(aggregateExitCode([{ ok: true }, { ok: false }])).toBe(1);
  });

  test('returns 0 for empty results', () => {
    expect(aggregateExitCode([])).toBe(0);
  });
});

// -- resolveSiteNames ---------------------------------------------------------

describe('resolveSiteNames', () => {
  const keys = ['production', 'staging', 'dev'];

  test('--all-sites returns all keys', () => {
    const result = resolveSiteNames({ allSites: true }, keys);
    expect(result).toEqual({ names: keys });
  });

  test('--sites filters to requested names', () => {
    const result = resolveSiteNames({ sites: 'production,staging' }, keys);
    expect(result).toEqual({ names: ['production', 'staging'] });
  });

  test('--sites trims whitespace around commas', () => {
    const result = resolveSiteNames({ sites: ' production , dev ' }, keys);
    expect(result).toEqual({ names: ['production', 'dev'] });
  });

  test('unknown site name returns error', () => {
    const result = resolveSiteNames({ sites: 'unknown' }, keys);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.exitCode).toBe(ExitCode.ConfigError);
      expect(result.error).toContain('unknown');
    }
  });

  test('both --all-sites and --sites returns error', () => {
    const result = resolveSiteNames({ allSites: true, sites: 'production' }, keys);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.exitCode).toBe(ExitCode.InvalidUsage);
  });

  test('neither flag returns error', () => {
    const result = resolveSiteNames({}, keys);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.exitCode).toBe(ExitCode.InvalidUsage);
  });

  test('--all-sites with no configured sites returns error', () => {
    const result = resolveSiteNames({ allSites: true }, []);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.exitCode).toBe(ExitCode.ConfigError);
  });
});
