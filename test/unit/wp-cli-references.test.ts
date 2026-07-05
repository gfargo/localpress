/**
 * Unit tests for matchesBlockId — the ID-boundary-safe Gutenberg block
 * matcher used by WpCliAdapter.findReferences to post-filter the LIKE-based
 * SQL pre-filter (which would otherwise treat id:123 as a match for id:1234).
 */

import { describe, expect, test } from 'bun:test';
import { matchesBlockId } from '../../src/adapters/wp-cli.ts';

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
