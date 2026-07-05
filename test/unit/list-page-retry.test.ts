/**
 * Unit tests for the `list -i` persisted-page fallback logic.
 *
 * A persisted `browser.page` pref can point past the current last page if
 * the library shrank or filters changed since it was saved. The fetch
 * should fall back to page 1 exactly once instead of failing forever.
 */

import { describe, expect, test } from 'bun:test';
import { fetchPageWithFallback } from '../../src/cli/commands/list.ts';

describe('fetchPageWithFallback', () => {
  test('returns the requested page on success without falling back', async () => {
    const fetchPage = async (page: number) => ({ page, items: ['a'] });
    const { result, page } = await fetchPageWithFallback(fetchPage, 3);
    expect(page).toBe(3);
    expect(result).toEqual({ page: 3, items: ['a'] });
  });

  test('falls back to page 1 when a page > 1 fails', async () => {
    const fetchPage = async (page: number) => {
      if (page > 1) throw new Error('400 Bad Request: rest_post_invalid_page_number');
      return { page, items: ['a'] };
    };
    const { result, page } = await fetchPageWithFallback(fetchPage, 5);
    expect(page).toBe(1);
    expect(result).toEqual({ page: 1, items: ['a'] });
  });

  test('rethrows when page 1 itself fails (real error, not a stale page)', async () => {
    const fetchPage = async () => {
      throw new Error('401 Unauthorized');
    };
    await expect(fetchPageWithFallback(fetchPage, 1)).rejects.toThrow('401 Unauthorized');
  });

  test('rethrows original error semantics — does not swallow a failing retry', async () => {
    const fetchPage = async (page: number) => {
      throw new Error(page > 1 ? 'stale page error' : 'network error');
    };
    await expect(fetchPageWithFallback(fetchPage, 2)).rejects.toThrow('network error');
  });
});
