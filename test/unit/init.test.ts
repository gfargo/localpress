/**
 * Unit test for `init --non-interactive` site-name validation (#118).
 * Invokes the CLI as a subprocess since the non-interactive branch of
 * init.ts's action() isn't exported for direct unit testing.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('init --non-interactive', () => {
  test('rejects a path-traversal site name before writing config', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'localpress-init-test-'));

    try {
      const result = spawnSync(
        'bun',
        [
          'run',
          join(process.cwd(), 'src/cli/index.ts'),
          'init',
          '--non-interactive',
          '--name',
          '../evil',
          '--url',
          'https://example.com',
          '--username',
          'x',
          '--app-password',
          'y',
        ],
        {
          env: { ...process.env, XDG_CONFIG_HOME: tempDir },
          encoding: 'utf8',
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Invalid site name');
      expect(existsSync(join(tempDir, 'localpress', 'config.json'))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
