/**
 * Behavioral dry-run tests — actually run the command action and assert no
 * live mutation happens, rather than just grepping source for a pattern.
 *
 * Complements dry-run-honesty.test.ts (static `resolveDryRun(` check) by
 * pinning down the two explicit-ID mutation gaps from OSS-928/#190:
 *   - `posts create --dry-run` must not issue a network POST.
 *   - `rename --dry-run` must not write a local SQLite attachments row.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command, Option } from 'commander';
import { registerPostsCommand } from '../../src/cli/commands/posts.ts';
import { registerRenameCommand } from '../../src/cli/commands/rename.ts';
import { getSiteDbPath, saveConfig } from '../../src/cli/utils/config.ts';
import { SiteDb } from '../../src/engine/state/db.ts';

const SITE_NAME = 'testsite';

function buildProgram(): Command {
  const program = new Command();
  program
    .name('localpress')
    .exitOverride()
    .addOption(new Option('--site <name>', 'override the active site for this command'))
    .addOption(new Option('--json', 'machine-readable JSON output').default(false))
    .addOption(new Option('--quiet', 'errors only; suppress info messages').default(false))
    .addOption(new Option('--dry-run', 'show what would happen without executing').default(false))
    .addOption(new Option('--apply', 'opt out of dry-run for bulk ops').default(false))
    .addOption(new Option('--yes', 'skip confirmation prompts').default(false))
    .addOption(
      new Option('--strict', 'fail loudly when capability fallbacks would activate').default(false),
    );
  return program;
}

let originalXdgConfigHome: string | undefined;
let originalFetch: typeof fetch;
let tmpDir: string;

beforeEach(async () => {
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  originalFetch = globalThis.fetch;
  tmpDir = mkdtempSync(join(tmpdir(), 'localpress-dry-run-test-'));
  process.env.XDG_CONFIG_HOME = tmpDir;

  await saveConfig({
    version: 1,
    activeSite: SITE_NAME,
    sites: {
      [SITE_NAME]: {
        name: SITE_NAME,
        url: 'https://example.test',
        username: 'admin',
        appPassword: 'app-password',
        createdAt: new Date(0).toISOString(),
      },
    },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalXdgConfigHome === undefined) {
    // biome-ignore lint/performance/noDelete: env var must be truly absent, not the string "undefined"
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('posts create --dry-run issues no network mutation', () => {
  test('does not call fetch', async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error('fetch should not be called during a dry-run');
    }) as unknown as typeof fetch;

    const program = buildProgram();
    registerPostsCommand(program);

    await program.parseAsync(
      ['posts', 'create', '--title', 'Dry Run Post', '--status', 'publish', '--dry-run', '--json'],
      { from: 'user' },
    );

    expect(fetchCalled).toBe(false);
  });
});

describe('rename --dry-run writes no local attachment row', () => {
  test('does not upsert into SQLite', async () => {
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/wp-json/wp/v2/media/')) {
        return Response.json({
          id: 42,
          source_url: 'https://example.test/wp-content/uploads/photo.jpg',
          media_details: { file: 'photo.jpg' },
          title: { rendered: 'Photo' },
          alt_text: '',
          caption: { rendered: '' },
          description: { rendered: '' },
          mime_type: 'image/jpeg',
          slug: 'photo',
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    }) as typeof fetch;

    const program = buildProgram();
    registerRenameCommand(program);

    await program.parseAsync(['rename', '42', '--to', 'new-name', '--dry-run', '--json'], {
      from: 'user',
    });

    const db = SiteDb.init(getSiteDbPath(SITE_NAME));
    const row = db.getAttachment(SITE_NAME, 42);
    db.close();
    expect(row).toBeNull();
  });
});
