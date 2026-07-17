/**
 * Unit tests for WpCliAdapter.replaceInPlace()'s format-change handling.
 *
 * Covers:
 * - buildUploadUrl / parseSearchReplaceCount pure helpers
 * - Sequencing: `_wp_attached_file` is updated (and the reference rewrite is
 *   issued) BEFORE the old file bytes are deleted, so a mid-sequence failure
 *   never leaves the attachment pointing at a deleted file.
 * - Size-variant URL rewriting only fires for size keys present in both the
 *   pre-mutation and post-regenerate `_wp_attachment_metadata`.
 * - A failed reference rewrite is non-fatal: the file replacement still
 *   succeeds and a warning is surfaced instead.
 *
 * `sshExec`/`scpUpload` are stubbed via `mock.module` — there's no SSH-enabled
 * WordPress in the test environment, so this proves the exact command
 * sequence/ordering rather than a real end-to-end round trip.
 */

import { afterAll, describe, expect, mock, test } from 'bun:test';
import type { SiteConfig } from '../../src/types.ts';

// bun:test's mock.module() replaces the module for the whole test process
// (there is no per-file un-mock), so other files importing '../../src/adapters/ssh.ts'
// after this one — e.g. ssh.test.ts, which asserts on the real sshDestination/
// buildSshArgs — would otherwise see these fakes too. Restore the real module
// once this file's tests finish.
const actualSsh = await import('../../src/adapters/ssh.ts');

afterAll(() => {
  mock.module('../../src/adapters/ssh.ts', () => actualSsh);
});

// -- Fake SSH backend ---------------------------------------------------------

const UPLOADS_BASEDIR = '/var/www/html/wp-content/uploads';
const UPLOADS_BASEURL = 'https://example.test/wp-content/uploads';

const OLD_META = {
  file: '2024/01/photo.png',
  filesize: 1000,
  sizes: {
    thumbnail: { file: 'photo-150x150.png', width: 150, height: 150 },
    // 'large' only exists in the old metadata — simulates a registered size
    // that's gone by the time `media regenerate` repopulates sizes.
    large: { file: 'photo-1024x768.png', width: 1024, height: 768 },
  },
};

const NEW_META = {
  file: '2024/01/photo.webp',
  filesize: 900,
  sizes: {
    thumbnail: { file: 'photo-150x150.webp', width: 150, height: 150 },
    medium: { file: 'photo-300x225.webp', width: 300, height: 225 },
  },
};

function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 };
}
function fail(stderr: string) {
  return { stdout: '', stderr, exitCode: 1 };
}

interface FakeState {
  calls: string[];
  regenerated: boolean;
  searchReplaceShouldFail: ((command: string) => boolean) | null;
}

const state: FakeState = { calls: [], regenerated: false, searchReplaceShouldFail: null };

function resetState(): void {
  state.calls = [];
  state.regenerated = false;
  state.searchReplaceShouldFail = null;
}

// Delegate the pure helpers to the real implementations rather than
// reimplementing them — if this mock ever leaks into another file (e.g. via
// a mock.module ordering race), a diverging fake here would corrupt that
// file's assertions on the real sshDestination/buildSshArgs/shellQuote
// behavior. Only sshExec/scpUpload (the actual I/O) are faked.
const { shellQuote, sshDestination, buildSshArgs } = actualSsh;

mock.module('../../src/adapters/ssh.ts', () => ({
  shellQuote,
  sshDestination,
  buildSshArgs,
  scpUpload: mock(async () => ok('')),
  sshExec: mock(async (_ssh: unknown, command: string) => {
    state.calls.push(command);

    if (command.includes('eval') && command.includes('wp_upload_dir')) {
      return ok(JSON.stringify({ basedir: UPLOADS_BASEDIR, baseurl: UPLOADS_BASEURL }));
    }
    if (command.includes('post meta get') && command.includes('_wp_attached_file')) {
      return ok('2024/01/photo.png');
    }
    if (command.includes('post meta update') && command.includes('_wp_attached_file')) {
      return ok('');
    }
    if (
      command.includes('_wp_attachment_metadata') &&
      command.includes('post meta get') &&
      command.includes('2>/dev/null')
    ) {
      // getMedia()'s final re-fetch, always after regenerate.
      return ok(JSON.stringify(NEW_META));
    }
    if (command.includes('_wp_attachment_metadata') && command.includes('post meta get')) {
      return ok(JSON.stringify(state.regenerated ? NEW_META : OLD_META));
    }
    if (command.includes('post meta update') && command.includes('_wp_attachment_metadata')) {
      return ok('');
    }
    if (command.includes('_require_file_renaming')) {
      return ok('');
    }
    if (command.includes('--post_mime_type=')) {
      return ok('');
    }
    if (command.includes('search-replace')) {
      if (state.searchReplaceShouldFail?.(command)) {
        return fail('ssh: connection reset by peer');
      }
      const count = command.includes('150x150') ? 1 : 2;
      return ok(`Success: Made ${count} replacements.`);
    }
    if (command.includes('media regenerate')) {
      state.regenerated = true;
      return ok('');
    }
    if (command.includes('rm -f')) {
      return ok('');
    }
    if (command.includes('mkdir -p')) {
      return ok('');
    }
    if (command.includes('mv ') && command.includes('chmod')) {
      return ok('');
    }
    if (command.includes('post get') && command.includes('--fields=ID,post_title')) {
      return ok(
        JSON.stringify({
          ID: 42,
          post_title: 'Photo',
          post_name: 'photo',
          post_mime_type: 'image/webp',
          post_date: '2024-01-01 00:00:00',
          guid: `${UPLOADS_BASEURL}/2024/01/photo.webp`,
        }),
      );
    }
    if (command.includes('post meta list') && command.includes('_wp_attachment_metadata')) {
      return ok(JSON.stringify([{ meta_value: state.regenerated ? NEW_META : OLD_META }]));
    }
    if (command.includes('post meta list') && command.includes('_wp_attachment_image_alt')) {
      return ok('[]');
    }
    if (command.includes('_wp_attachment_image_alt')) {
      return ok('');
    }

    throw new Error(`Unhandled fake SSH command: ${command}`);
  }),
}));

const { WpCliAdapter, buildUploadUrl, parseSearchReplaceCount } = await import(
  '../../src/adapters/wp-cli.ts'
);

const site: SiteConfig = {
  name: 'test-site',
  url: 'https://example.test',
  username: 'admin',
  appPassword: 'aaaa bbbb cccc dddd eeee ffff',
  createdAt: new Date('2026-01-01').toISOString(),
  ssh: { host: 'example.test', user: 'deploy', wpPath: '/var/www/html' },
};

// -- Pure helpers --------------------------------------------------------------

describe('buildUploadUrl', () => {
  test('joins base URL and relative path with exactly one slash', () => {
    expect(buildUploadUrl('https://example.test/wp-content/uploads', '2024/01/photo.webp')).toBe(
      'https://example.test/wp-content/uploads/2024/01/photo.webp',
    );
  });

  test('tolerates a trailing slash on the base URL', () => {
    expect(buildUploadUrl('https://example.test/wp-content/uploads/', '2024/01/photo.webp')).toBe(
      'https://example.test/wp-content/uploads/2024/01/photo.webp',
    );
  });

  test('tolerates a leading slash on the relative path', () => {
    expect(buildUploadUrl('https://example.test/wp-content/uploads', '/2024/01/photo.webp')).toBe(
      'https://example.test/wp-content/uploads/2024/01/photo.webp',
    );
  });
});

describe('parseSearchReplaceCount', () => {
  test('extracts the replacement count from wp search-replace output', () => {
    expect(parseSearchReplaceCount('Success: Made 3 replacements.')).toBe(3);
  });

  test('handles the singular form', () => {
    expect(parseSearchReplaceCount('Success: Made 1 replacement.')).toBe(1);
  });

  test('returns null for unrecognized output rather than throwing', () => {
    expect(parseSearchReplaceCount('')).toBeNull();
    expect(parseSearchReplaceCount('some unrelated wp-cli output')).toBeNull();
  });
});

// -- replaceInPlace: format-change sequencing ----------------------------------

describe('WpCliAdapter.replaceInPlace — format change', () => {
  test('updates _wp_attached_file and rewrites the main URL before deleting the old file', async () => {
    resetState();
    const adapter = new WpCliAdapter(site);

    const item = await adapter.replaceInPlace(42, Buffer.from('fake-webp-bytes'), {
      newExtension: '.webp',
      newMimeType: 'image/webp',
    });

    const attachedFileIdx = state.calls.findIndex(
      (c) => c.includes('post meta update') && c.includes('_wp_attached_file'),
    );
    const mainRewriteIdx = state.calls.findIndex(
      (c) => c.includes('search-replace') && !c.includes('150x150'),
    );
    const rmOldFileIdx = state.calls.findIndex(
      (c) => c.includes('rm -f') && c.includes('2024/01/photo.png'),
    );

    expect(attachedFileIdx).toBeGreaterThanOrEqual(0);
    expect(mainRewriteIdx).toBeGreaterThanOrEqual(0);
    expect(rmOldFileIdx).toBeGreaterThanOrEqual(0);

    // The attachment record and the content rewrite both happen before the
    // old bytes are deleted — a failure at any earlier step leaves the old
    // file (still referenced or not) on disk instead of a dangling attachment.
    expect(attachedFileIdx).toBeLessThan(rmOldFileIdx);
    expect(mainRewriteIdx).toBeLessThan(rmOldFileIdx);

    // Main URL rewrite (2) + thumbnail size-variant rewrite (1); 'large' is
    // skipped because it has no counterpart in the post-regenerate metadata.
    expect(item.formatChangeRewrite?.rewrittenUrls).toBe(3);
    expect(item.formatChangeRewrite?.warning).toBeUndefined();
  });

  test('only rewrites size-variant URLs for keys present in both old and new metadata', async () => {
    resetState();
    const adapter = new WpCliAdapter(site);

    await adapter.replaceInPlace(42, Buffer.from('fake-webp-bytes'), {
      newExtension: '.webp',
      newMimeType: 'image/webp',
    });

    const sizeRewrites = state.calls.filter((c) => c.includes('search-replace') && c.includes('x'));
    // Only 'thumbnail' (150x150) is rewritten; 'large' (1024x768) has no
    // counterpart in NEW_META and must not produce a search-replace call.
    expect(sizeRewrites.some((c) => c.includes('150x150'))).toBe(true);
    expect(sizeRewrites.some((c) => c.includes('1024x768'))).toBe(false);
  });

  test('a failed reference rewrite is non-fatal and surfaces a warning', async () => {
    resetState();
    state.searchReplaceShouldFail = (command) => !command.includes('150x150');
    const adapter = new WpCliAdapter(site);

    const item = await adapter.replaceInPlace(42, Buffer.from('fake-webp-bytes'), {
      newExtension: '.webp',
      newMimeType: 'image/webp',
    });

    // The file replacement itself still succeeded.
    expect(item.id).toBe(42);
    expect(item.formatChangeRewrite?.warning).toBeDefined();
    expect(item.formatChangeRewrite?.warning).toContain('localpress references');

    // Old file deletion still happened — a rewrite failure must not roll
    // back or block the (already-successful) file replacement.
    const rmOldFileIdx = state.calls.findIndex(
      (c) => c.includes('rm -f') && c.includes('2024/01/photo.png'),
    );
    expect(rmOldFileIdx).toBeGreaterThanOrEqual(0);
  });

  test('no format change: no rewrite is attempted and formatChangeRewrite is absent', async () => {
    resetState();
    const adapter = new WpCliAdapter(site);

    const item = await adapter.replaceInPlace(42, Buffer.from('fake-bytes'));

    expect(item.formatChangeRewrite).toBeUndefined();
    expect(state.calls.some((c) => c.includes('search-replace'))).toBe(false);
  });
});
