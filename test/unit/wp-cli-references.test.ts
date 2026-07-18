/**
 * Unit tests for matchesBlockId — the ID-boundary-safe Gutenberg block
 * matcher used by WpCliAdapter.findReferences to post-filter the LIKE-based
 * SQL pre-filter (which would otherwise treat id:123 as a match for id:1234).
 *
 * Also covers WpCliAdapter.findReferences()'s dedupe scoping: a post that is
 * both the featured-image and a Gutenberg-block reference for the same
 * attachment must surface both reference types (parity with RestAdapter),
 * while a repeated gutenberg-block match for the same post is still deduped.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { matchesBlockId } from '../../src/adapters/wp-cli.ts';

import * as actualSsh from '../../src/adapters/ssh.ts';
import type { SshExecResult } from '../../src/adapters/ssh.ts';

const sshExecMock = mock<(ssh: unknown, command: string) => Promise<SshExecResult>>();

mock.module('../../src/adapters/ssh.ts', () => ({
  ...actualSsh,
  sshExec: sshExecMock,
}));

afterAll(() => {
  mock.module('../../src/adapters/ssh.ts', () => actualSsh);
});

const { WpCliAdapter } = await import('../../src/adapters/wp-cli.ts');
import type { SiteConfig } from '../../src/types.ts';

const site: SiteConfig = {
  name: 'test-wp-cli',
  url: 'https://example.test',
  username: 'admin',
  appPassword: 'aaaa bbbb cccc dddd eeee ffff',
  createdAt: new Date('2026-01-01').toISOString(),
  ssh: {
    host: 'example.test',
    user: 'deploy',
    wpPath: '/var/www/html',
  },
};

function result(stdout: string, exitCode = 0, stderr = ''): SshExecResult {
  return { stdout, stderr, exitCode };
}

describe('WpCliAdapter.findReferences() dedupe scoping', () => {
  beforeEach(() => {
    sshExecMock.mockReset();
  });

  test('reports both a featured-image and a gutenberg-block reference for the same post', async () => {
    const attachmentId = 42;
    const postId = 7;
    const blockContent = `<!-- wp:image {"id":${attachmentId}} --><p></p>`;

    sshExecMock.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("meta_key='_thumbnail_id'")) {
        return result(`${postId}`);
      }
      if (command.includes('post_content LIKE')) {
        return result(`${postId}\tMy Post\tpost\t${blockContent}`);
      }
      if (command.includes('post get')) {
        return result(JSON.stringify({ ID: postId, post_title: 'My Post', post_type: 'post' }));
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const adapter = new WpCliAdapter(site);
    const references = await adapter.findReferences(attachmentId, 'fast');

    expect(references).toContainEqual({
      type: 'featured-image',
      postId,
      postTitle: 'My Post',
      postType: 'post',
    });
    expect(references).toContainEqual({
      type: 'gutenberg-block',
      postId,
      postTitle: 'My Post',
      postType: 'post',
    });
    expect(references).toHaveLength(2);
  });

  test('does not duplicate a gutenberg-block reference when the same post/block matches twice', async () => {
    const attachmentId = 42;
    const postId = 7;
    const blockContent = `<!-- wp:image {"id":${attachmentId}} --><p></p>`;

    sshExecMock.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("meta_key='_thumbnail_id'")) {
        return result('');
      }
      if (command.includes('post_content LIKE')) {
        // Two rows for the same post — e.g. a duplicated pre-filter match.
        return result(
          [
            `${postId}\tMy Post\tpost\t${blockContent}`,
            `${postId}\tMy Post\tpost\t${blockContent}`,
          ].join('\n'),
        );
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const adapter = new WpCliAdapter(site);
    const references = await adapter.findReferences(attachmentId, 'fast');

    const blockRefs = references.filter((r) => r.type === 'gutenberg-block');
    expect(blockRefs).toHaveLength(1);
  });
});

describe('matchesBlockId', () => {
  test('matches an exact block id reference', () => {
    expect(matchesBlockId('<!-- wp:image {"id":123,"sizeSlug":"large"} -->', 123)).toBe(true);
  });

  test('does not match when the id is a prefix of a longer id', () => {
    expect(matchesBlockId('<!-- wp:image {"id":1234,"sizeSlug":"large"} -->', 123)).toBe(false);
  });

  test('does not match when the id is a suffix of a longer id', () => {
    expect(matchesBlockId('<!-- wp:image {"id":9123,"sizeSlug":"large"} -->', 123)).toBe(false);
  });

  test('matches gallery/cover/media-text blocks too', () => {
    expect(matchesBlockId('<!-- wp:gallery {"ids":[1,2],"id":123} -->', 123)).toBe(true);
    expect(matchesBlockId('<!-- wp:cover {"id":123,"url":"x"} -->', 123)).toBe(true);
    expect(matchesBlockId('<!-- wp:media-text {"mediaId":123,"id":123} -->', 123)).toBe(true);
  });

  test('returns false when there is no reference at all', () => {
    expect(matchesBlockId('<!-- wp:paragraph --><p>hello</p>', 123)).toBe(false);
  });
});
