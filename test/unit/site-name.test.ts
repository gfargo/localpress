/**
 * Unit test for site-name validation — names become filesystem path components
 * (<name>.db, snapshot blob dirs), so traversal/separators must be rejected (#118).
 */

import { describe, expect, test } from 'bun:test';
import { isValidSiteName } from '../../src/cli/utils/config.ts';

describe('isValidSiteName', () => {
  test('accepts ordinary names', () => {
    for (const ok of ['production', 'staging', 'my-site', 'site_1', 'example.com']) {
      expect(isValidSiteName(ok)).toBe(true);
    }
  });

  test('rejects traversal and path separators', () => {
    for (const bad of ['../evil', '..', '.', 'a/b', 'a\\b', 'foo/../bar', '', 'has space']) {
      expect(isValidSiteName(bad)).toBe(false);
    }
  });
});
