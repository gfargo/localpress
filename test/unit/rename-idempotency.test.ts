import { describe, expect, test } from 'bun:test';
import { resolvePreviousSlug } from '../../src/cli/commands/rename.ts';

describe('resolvePreviousSlug', () => {
  test('prefers the real slug over a filename-derived slug when they differ', () => {
    // Real-world case: a prior rename set slug to "my-photo-2" but the
    // filename base is still "my-photo" — the real slug must win so a
    // re-run with target "my-photo" is NOT skipped.
    const slug = resolvePreviousSlug({
      slug: 'my-photo-2',
      filename: 'my-photo.jpg',
      url: 'https://example.com/wp-content/uploads/my-photo.jpg',
    });
    expect(slug).toBe('my-photo-2');
  });

  test('matches the real slug so an already-correct rename is skipped', () => {
    const slug = resolvePreviousSlug({
      slug: 'red-coffee-mug',
      filename: 'IMG_1234.jpg',
      url: 'https://example.com/wp-content/uploads/IMG_1234.jpg',
    });
    expect(slug).toBe('red-coffee-mug');
  });

  test('falls back to the filename-derived slug when slug is absent', () => {
    const slug = resolvePreviousSlug({
      slug: undefined,
      filename: 'my-photo.jpg',
      url: 'https://example.com/wp-content/uploads/my-photo.jpg',
    });
    expect(slug).toBe('my-photo');
  });

  test('falls back to the filename-derived slug when slug is blank', () => {
    const slug = resolvePreviousSlug({
      slug: '   ',
      filename: 'my-photo.jpg',
      url: 'https://example.com/wp-content/uploads/my-photo.jpg',
    });
    expect(slug).toBe('my-photo');
  });
});
