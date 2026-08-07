/**
 * CLI-level test for `stats --all-sites --json` shape stability.
 *
 * Regression for #276: `--all-sites --json` used to flip between a bare
 * object (1 configured site) and a bare array (2+ sites), and a third shape
 * once wrapped by the MCP bridge (`{ items: [...] }`). The shape must now be
 * a stable `{ sites: [...] }` object regardless of site count, matching the
 * `audit --all-sites` precedent.
 */

import { describe, expect, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI_ENTRY = join(process.cwd(), 'src', 'cli', 'index.ts');

function run(
  args: string[],
  configDir: string,
): { stdout: string; stderr: string; exitCode: number } {
  const result = childProcess.spawnSync('bun', ['run', CLI_ENTRY, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, XDG_CONFIG_HOME: configDir },
    timeout: 30_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

function addSite(configDir: string, name: string): void {
  const { exitCode } = run(
    [
      'sites',
      'add',
      `https://${name}.example.com`,
      '--name',
      name,
      '--username',
      'admin',
      '--app-password',
      'abcd 1234 abcd 1234 abcd 1234',
    ],
    configDir,
  );
  expect(exitCode).toBe(0);
}

describe('stats --all-sites --json shape stability', () => {
  test('one configured site: --all-sites yields { sites: [...] }, not a bare object', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'localpress-stats-json-test-'));
    try {
      addSite(configDir, 'site-one');
      const { stdout, exitCode } = run(['stats', '--all-sites', '--json', '--quiet'], configDir);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(Array.isArray(parsed.sites)).toBe(true);
      expect(parsed.sites.length).toBe(1);
      expect(Array.isArray(parsed)).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('two configured sites: same top-level shape, not a bare array', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'localpress-stats-json-test-'));
    try {
      addSite(configDir, 'site-one');
      addSite(configDir, 'site-two');
      const { stdout, exitCode } = run(['stats', '--all-sites', '--json', '--quiet'], configDir);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(Array.isArray(parsed)).toBe(false);
      expect(Array.isArray(parsed.sites)).toBe(true);
      expect(parsed.sites.length).toBe(2);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('zero configured sites: --all-sites yields { sites: [] }', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'localpress-stats-json-test-'));
    try {
      const { stdout, exitCode } = run(['stats', '--all-sites', '--json', '--quiet'], configDir);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed).toEqual({ sites: [] });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('default stats --json (no --all-sites) still emits a bare object', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'localpress-stats-json-test-'));
    try {
      addSite(configDir, 'site-one');
      const { stdout, exitCode } = run(['stats', '--json', '--quiet'], configDir);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.sites).toBeUndefined();
      expect(parsed.site).toBe('site-one');
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
