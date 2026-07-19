/**
 * Unit tests for matchesBlockId — the ID-boundary-safe Gutenberg block
 * matcher used by WpCliAdapter.findReferences to post-filter the LIKE-based
 * SQL pre-filter (which would otherwise treat id:123 as a match for id:1234).
 *
 * Also covers WpCliAdapter.findReferences()'s dedupe scoping: a post that is
 * both the featured-image and a Gutenberg-block reference for the same
 * attachment must surface both reference types (parity with RestAdapter),
 * while a repeated gutenberg-block match for the same post is still deduped.
 *
 * Also covers the SQL escaping helpers added to fix the shell/SQL injection
 * vulnerability in findReferences --scope full (OSS-926 / GH-192).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { shellQuote } from '../../src/adapters/ssh.ts';
import { escapeSqlLike, matchesBlockId, sqlStringLiteral } from '../../src/adapters/wp-cli.ts';

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
      if (command.includes('db prefix')) {
        return result('wp_');
      }
      if (command.includes('_thumbnail_id')) {
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
      if (command.includes('db prefix')) {
        return result('wp_');
      }
      if (command.includes('_thumbnail_id')) {
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

describe('WpCliAdapter table-prefix resolution (OSS-916)', () => {
  beforeEach(() => {
    sshExecMock.mockReset();
  });

  test('threads a custom table prefix into findUnattached and findReferences SQL', async () => {
    const attachmentId = 42;
    const capturedCommands: string[] = [];

    sshExecMock.mockImplementation(async (_ssh: unknown, command: string) => {
      capturedCommands.push(command);
      if (command.includes('db prefix')) {
        return result('custom_');
      }
      if (command.includes('SELECT ID FROM') && command.includes("post_type='attachment'")) {
        return result(`${attachmentId}`);
      }
      // Everything else (post get, remaining dbQuery calls made while resolving
      // references for the candidate) is irrelevant to this test — just avoid
      // throwing so the SQL-construction assertions below aren't obscured.
      return result('');
    });

    const adapter = new WpCliAdapter(site);
    await adapter.findUnattached();

    expect(capturedCommands.some((c) => c.includes('custom_posts'))).toBe(true);
    expect(capturedCommands.some((c) => c.includes('custom_postmeta'))).toBe(true);
    expect(capturedCommands.some((c) => c.includes('wp_posts') || c.includes('wp_postmeta'))).toBe(
      false,
    );
  });

  test('caches the resolved prefix across multiple calls (one db prefix round-trip)', async () => {
    const attachmentId = 42;
    let dbPrefixCalls = 0;

    sshExecMock.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes('db prefix')) {
        dbPrefixCalls += 1;
        return result('custom_');
      }
      return result('');
    });

    const adapter = new WpCliAdapter(site);
    await adapter.findReferences(attachmentId, 'fast');
    await adapter.findReferences(attachmentId, 'fast');

    expect(dbPrefixCalls).toBe(1);
  });

  test('falls back to wp_ when db prefix returns empty output', async () => {
    const attachmentId = 42;
    const capturedCommands: string[] = [];

    sshExecMock.mockImplementation(async (_ssh: unknown, command: string) => {
      capturedCommands.push(command);
      if (command.includes('db prefix')) {
        return result('');
      }
      return result('');
    });

    const adapter = new WpCliAdapter(site);
    await adapter.findReferences(attachmentId, 'fast');

    expect(capturedCommands.some((c) => c.includes('wp_postmeta'))).toBe(true);
    expect(capturedCommands.some((c) => c.includes('wp_posts'))).toBe(true);
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

// ---------------------------------------------------------------------------
// Reuse the POSIX single-quote parser from ssh.test.ts to verify that
// shellQuote(sql) round-trips the SQL back unchanged — i.e. the shell layer
// cannot interpret anything in the SQL string.
// ---------------------------------------------------------------------------
function parseSingleQuotedWord(word: string): string {
  let result = '';
  let i = 0;
  while (i < word.length) {
    if (word[i] === "'") {
      const end = word.indexOf("'", i + 1);
      result += word.slice(i + 1, end);
      i = end + 1;
    } else if (word.startsWith("\\'", i)) {
      result += "'";
      i += 2;
    } else {
      result += word[i];
      i += 1;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// escapeSqlLike
// ---------------------------------------------------------------------------

describe('escapeSqlLike', () => {
  test('leaves plain filenames untouched', () => {
    expect(escapeSqlLike('example.com/wp-content/uploads/2024/01/photo.jpg')).toBe(
      'example.com/wp-content/uploads/2024/01/photo.jpg',
    );
  });

  test('escapes % wildcard', () => {
    expect(escapeSqlLike('100%cotton')).toBe('100\\%cotton');
  });

  test('escapes _ wildcard', () => {
    expect(escapeSqlLike('my_photo')).toBe('my\\_photo');
  });

  test('escapes backslash first to avoid double-escaping', () => {
    expect(escapeSqlLike('back\\slash')).toBe('back\\\\slash');
  });

  test('escapes combined: backslash, percent, underscore', () => {
    expect(escapeSqlLike('a\\_b%c')).toBe('a\\\\\\_b\\%c');
  });

  test('escapes single quote to prevent SQL string-literal breakout', () => {
    expect(escapeSqlLike("it's.jpg")).toBe("it''s.jpg");
  });

  test('escapes combined: single quote, percent, underscore, and backslash', () => {
    // Simulate a malicious guid: x' OR '1'='1 / 100%_data\file.jpg
    const guid = "x' OR '1'='1";
    const escaped = escapeSqlLike(guid);
    // No bare single quotes (every ' is doubled)
    expect(escaped).not.toMatch(/(?<!')'(?!')/);
    expect(escaped).toBe("x'' OR ''1''=''1");
  });

  test('escapes SQL metacharacters in an attacker-controlled filename', () => {
    // guid containing LIKE wildcards — must not over-match
    const guid = 'uploads/2024/photo_100%.jpg';
    const escaped = escapeSqlLike(guid);
    expect(escaped).toBe('uploads/2024/photo\\_100\\%.jpg');
    // Confirm no bare % or _ remain (they are all prefixed with \)
    // Iterate to verify every % and _ is preceded by an odd number of backslashes
    for (let i = 0; i < escaped.length; i++) {
      if (escaped[i] === '%' || escaped[i] === '_') {
        expect(escaped[i - 1]).toBe('\\');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// sqlStringLiteral
// ---------------------------------------------------------------------------

describe('sqlStringLiteral', () => {
  test('leaves plain strings untouched', () => {
    expect(sqlStringLiteral('simple string')).toBe('simple string');
  });

  test("escapes single quote with '' idiom", () => {
    expect(sqlStringLiteral("it's alive")).toBe("it''s alive");
  });

  test('escapes backslash', () => {
    expect(sqlStringLiteral('back\\slash')).toBe('back\\\\slash');
  });

  test('neutralises classic SQL injection payload', () => {
    const payload = "x' OR '1'='1";
    const escaped = sqlStringLiteral(payload);
    // Must not contain a bare ' (every ' is doubled)
    expect(escaped).not.toMatch(/(?<!')'(?!')/);
    expect(escaped).toBe("x'' OR ''1''=''1");
  });

  test('handles a guid with both backslash and quote', () => {
    const guid = "photo\\'trick.jpg";
    const escaped = sqlStringLiteral(guid);
    // No bare single quotes remain
    expect(escaped).not.toMatch(/(?<!')'(?!')/);
  });
});

// ---------------------------------------------------------------------------
// Shell-safety: shellQuote(sql) must neutralise all shell metacharacters
// that could appear in a URL-derived SQL string.
// ---------------------------------------------------------------------------

describe('shell-safety of SQL strings built from escapeSqlLike + shellQuote', () => {
  test('backtick in guid does not produce a subshell command after shell-quoting', () => {
    const maliciousGuid = 'example.com/uploads/photo`id`.jpg';
    const likePattern = escapeSqlLike(maliciousGuid.replace(/https?:\/\//, ''));
    const sql = `SELECT ID FROM wp_posts WHERE post_content LIKE '%${likePattern}%'`;
    const quoted = shellQuote(sql);
    // The round-tripped SQL must exactly equal the SQL we built — no interpretation
    expect(parseSingleQuotedWord(quoted)).toBe(sql);
    // Confirm the backtick is still there (not stripped) but neutralised by quoting
    expect(sql).toContain('`');
  });

  test('"double-quote in guid does not break shell quoting', () => {
    const maliciousGuid = 'example.com/uploads/photo"evil.jpg';
    const likePattern = escapeSqlLike(maliciousGuid.replace(/https?:\/\//, ''));
    const sql = `SELECT ID FROM wp_posts WHERE post_content LIKE '%${likePattern}%'`;
    const quoted = shellQuote(sql);
    expect(parseSingleQuotedWord(quoted)).toBe(sql);
  });

  test('$(…) in guid does not execute command substitution after shell-quoting', () => {
    const maliciousGuid = 'example.com/uploads/$(rm -rf /)image.jpg';
    const likePattern = escapeSqlLike(maliciousGuid.replace(/https?:\/\//, ''));
    const sql = `SELECT ID FROM wp_posts WHERE post_content LIKE '%${likePattern}%'`;
    const quoted = shellQuote(sql);
    expect(parseSingleQuotedWord(quoted)).toBe(sql);
  });

  test('combined backtick + single-quote + percent in guid round-trips correctly', () => {
    const maliciousGuid = 'example.com/uploads/`id`_100%evil.jpg';
    const strippedUrl = maliciousGuid.replace(/https?:\/\//, '');
    const likePattern = escapeSqlLike(strippedUrl);
    const sql = `SELECT ID FROM wp_posts WHERE post_content LIKE '%${likePattern}%'`;
    const quoted = shellQuote(sql);
    // Shell layer: round-trip must be identity
    expect(parseSingleQuotedWord(quoted)).toBe(sql);
    // SQL layer: % and _ from the guid must be LIKE-escaped
    expect(likePattern).toContain('\\%');
    expect(likePattern).toContain('\\_');
    // Backtick must still be present in the escaped pattern (not stripped)
    expect(likePattern).toContain('`');
  });

  test('single-quote in guid does not break SQL string literal after escapeSqlLike + shellQuote', () => {
    const maliciousGuid = "example.com/uploads/it's-a-photo.jpg";
    const strippedUrl = maliciousGuid.replace(/https?:\/\//, '');
    const likePattern = escapeSqlLike(strippedUrl);
    // ' must be doubled in the LIKE pattern so the SQL string literal stays intact
    expect(likePattern).not.toMatch(/(?<!')'(?!')/);
    const sql = `SELECT ID FROM wp_posts WHERE post_content LIKE '%${likePattern}%'`;
    const quoted = shellQuote(sql);
    // Shell round-trip must be identity
    expect(parseSingleQuotedWord(quoted)).toBe(sql);
  });
});
