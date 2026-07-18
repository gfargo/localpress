/**
 * Unit tests for matchesBlockId — the ID-boundary-safe Gutenberg block
 * matcher used by WpCliAdapter.findReferences to post-filter the LIKE-based
 * SQL pre-filter (which would otherwise treat id:123 as a match for id:1234).
 *
 * Also covers the SQL escaping helpers added to fix the shell/SQL injection
 * vulnerability in findReferences --scope full (OSS-926 / GH-192).
 */

import { describe, expect, test } from 'bun:test';
import { escapeSqlLike, matchesBlockId, sqlStringLiteral } from '../../src/adapters/wp-cli.ts';
import { shellQuote } from '../../src/adapters/ssh.ts';

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

  test('escapes SQL metacharacters in an attacker-controlled filename', () => {
    // guid containing LIKE wildcards — must not over-match
    const guid = "uploads/2024/photo_100%.jpg";
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
    const maliciousGuid = "example.com/uploads/`id`_100%evil.jpg";
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
});
