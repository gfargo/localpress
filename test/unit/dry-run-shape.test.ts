/**
 * Dry-run output SHAPE assertions (OSS-1343 / #278).
 *
 * `dry-run-honesty.test.ts` proves every mutating command routes through
 * `resolveDryRun(`. This file proves the resulting `--json` payload actually
 * looks the same everywhere: a top-level `dryRun: true` discriminator (never
 * `action: 'dry-run'`) plus a normalized `changes` block. It also unit-tests
 * the `dryRunPayload()` helper itself and drives a representative sample of
 * commands end-to-end (reusing the fetch/XDG harness from
 * `dry-run-honesty-behavior.test.ts`) to catch a command that silently
 * reverts to an ad-hoc shape.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command, Option } from 'commander';
import { registerConvertCommand } from '../../src/cli/commands/convert.ts';
import { registerDeleteCommand } from '../../src/cli/commands/delete.ts';
import { registerMetadataCommand } from '../../src/cli/commands/metadata.ts';
import { registerPostsCommand } from '../../src/cli/commands/posts.ts';
import { registerPushCommand } from '../../src/cli/commands/push.ts';
import { registerRemoveBgCommand } from '../../src/cli/commands/remove-bg.ts';
import { registerRenameCommand } from '../../src/cli/commands/rename.ts';
import { registerResizeCommand } from '../../src/cli/commands/resize.ts';
import { saveConfig } from '../../src/cli/utils/config.ts';
import { setOutputOptions } from '../../src/cli/utils/output.ts';
import { type DryRunChanges, dryRunPayload } from '../../src/cli/utils/run-mode.ts';

describe('dryRunPayload()', () => {
  test('always sets dryRun: true and a changes block', () => {
    const payload = dryRunPayload({ operation: 'widget', count: 2 });
    expect(payload.dryRun).toBe(true);
    expect(payload.changes).toEqual({ operation: 'widget', count: 2 });
  });

  test('spreads legacy fields additively', () => {
    const payload = dryRunPayload({ operation: 'widget' }, { count: 5, ids: [1, 2] });
    expect(payload).toMatchObject({ dryRun: true, count: 5, ids: [1, 2] });
    expect(payload.changes).toEqual({ operation: 'widget' });
  });

  test('changes always wins over a same-named legacy field', () => {
    // metadata.ts's pre-existing dry-run shape used a top-level `changes` key
    // for the field diff — the helper's normalized `changes` block must win.
    const changes: DryRunChanges = { operation: 'metadata', fields: { altText: 'new' } };
    const payload = dryRunPayload(changes, { changes: { altText: 'old-shape' } });
    expect(payload.changes).toEqual(changes);
  });
});

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
let stdoutChunks: string[];
let originalStdoutWrite: typeof process.stdout.write;

beforeEach(async () => {
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  originalFetch = globalThis.fetch;
  tmpDir = mkdtempSync(join(tmpdir(), 'localpress-dry-run-shape-test-'));
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

  setOutputOptions({ json: true, quiet: false });
  stdoutChunks = [];
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;

  globalThis.fetch = (async (input: string | URL) => {
    throw new Error(`Unexpected fetch to ${String(input)} — dry-run must not touch the network`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
  setOutputOptions({ json: false, quiet: false });
  globalThis.fetch = originalFetch;
  if (originalXdgConfigHome === undefined) {
    // biome-ignore lint/performance/noDelete: env var must be truly absent, not the string "undefined"
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Parse the last JSON object line written to stdout during the test. */
function lastJson(): Record<string, unknown> {
  const jsonLines = stdoutChunks
    .join('')
    .split('\n')
    .filter((l) => l.trim().startsWith('{'));
  expect(jsonLines.length, 'expected at least one JSON line on stdout').toBeGreaterThan(0);
  return JSON.parse(jsonLines[jsonLines.length - 1]);
}

/** Assert the standard shape: dryRun===true discriminator + a changes block. */
function expectDryRunShape(payload: Record<string, unknown>, operation: string): void {
  expect(payload.dryRun).toBe(true);
  expect(payload).not.toHaveProperty('action', 'dry-run');
  expect(payload.changes).toBeDefined();
  const changes = payload.changes as DryRunChanges;
  expect(changes.operation).toBe(operation);
}

describe('dry-run output shape — representative commands', () => {
  test('convert --dry-run --json', async () => {
    const program = buildProgram();
    registerConvertCommand(program);
    await program.parseAsync(['convert', '42', '--to', 'webp', '--dry-run', '--json'], {
      from: 'user',
    });
    expectDryRunShape(lastJson(), 'convert');
  });

  test('resize --dry-run --json', async () => {
    const program = buildProgram();
    registerResizeCommand(program);
    await program.parseAsync(['resize', '42', '--max-width', '800', '--dry-run', '--json'], {
      from: 'user',
    });
    expectDryRunShape(lastJson(), 'resize');
  });

  test('remove-bg --dry-run --json', async () => {
    const program = buildProgram();
    registerRemoveBgCommand(program);
    await program.parseAsync(['remove-bg', '42', '--dry-run', '--json'], { from: 'user' });
    expectDryRunShape(lastJson(), 'remove-bg');
  });

  test('metadata --dry-run --json', async () => {
    const program = buildProgram();
    registerMetadataCommand(program);
    await program.parseAsync(['metadata', '42', '--alt-text', 'a photo', '--dry-run', '--json'], {
      from: 'user',
    });
    const payload = lastJson();
    expectDryRunShape(payload, 'metadata');
    const changes = payload.changes as DryRunChanges;
    expect(changes.fields).toEqual({ altText: 'a photo' });
    // `changes` used to *be* the raw field diff on `main`; now that `changes`
    // is the normalized block, the raw diff stays reachable at the top level
    // under `fields` so pre-existing consumers aren't left with no equivalent.
    expect(payload.fields).toEqual({ altText: 'a photo' });
  });

  test('delete --dry-run --json', async () => {
    const program = buildProgram();
    registerDeleteCommand(program);
    await program.parseAsync(['delete', '42', '--dry-run', '--json'], { from: 'user' });
    expectDryRunShape(lastJson(), 'delete');
  });

  test('push --dry-run --json', async () => {
    const filePath = join(tmpDir, 'photo.jpg');
    writeFileSync(filePath, 'fake-image-bytes');
    const program = buildProgram();
    registerPushCommand(program);
    await program.parseAsync(['push', filePath, '--dry-run', '--json'], { from: 'user' });
    expectDryRunShape(lastJson(), 'push');
  });

  test('posts create --dry-run --json', async () => {
    const program = buildProgram();
    registerPostsCommand(program);
    await program.parseAsync(
      ['posts', 'create', '--title', 'Dry Run Post', '--status', 'publish', '--dry-run', '--json'],
      { from: 'user' },
    );
    const payload = lastJson();
    expectDryRunShape(payload, 'posts.create');
    const changes = payload.changes as DryRunChanges;
    expect((changes.fields as { title?: string })?.title).toBe('Dry Run Post');
  });

  test('posts update --dry-run --json', async () => {
    const program = buildProgram();
    registerPostsCommand(program);
    await program.parseAsync(
      ['posts', 'update', '45', '--title', 'New Title', '--dry-run', '--json'],
      { from: 'user' },
    );
    const payload = lastJson();
    expectDryRunShape(payload, 'posts.update');
    const changes = payload.changes as DryRunChanges;
    expect(changes.items).toEqual([{ id: 45 }]);
  });

  test('posts delete --dry-run --json', async () => {
    const program = buildProgram();
    registerPostsCommand(program);
    await program.parseAsync(['posts', 'delete', '45', '--dry-run', '--json'], { from: 'user' });
    expectDryRunShape(lastJson(), 'posts.delete');
  });

  test('rename --dry-run --json (fetches nothing, writes nothing)', async () => {
    // rename --smart would call Ollama + fetch the image; --to skips that
    // entirely, so this stays within the "no network" dry-run harness.
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
    expectDryRunShape(lastJson(), 'rename');
  });
});
