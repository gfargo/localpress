/**
 * Unit tests for `localpress seo` — SEO audit analysis logic.
 */

import { describe, expect, test } from 'bun:test';
import {
  type SeoFinding,
  analyzePostSeo,
  buildMetaPayload,
  cleanMetaDescription,
  cleanMetaTitle,
  detectSeoPlugin,
  extractSeoMeta,
  findDuplicateTitles,
} from '../../src/cli/commands/seo.ts';

// -- Plugin detection ---------------------------------------------------------

describe('detectSeoPlugin', () => {
  test('detects Yoast from _yoast_wpseo_title', () => {
    const metas = [{ _yoast_wpseo_title: 'My Title' }];
    expect(detectSeoPlugin(metas)).toBe('yoast');
  });

  test('detects Yoast from _yoast_wpseo_metadesc', () => {
    const metas = [{ _yoast_wpseo_metadesc: 'My description' }];
    expect(detectSeoPlugin(metas)).toBe('yoast');
  });

  test('detects RankMath from rank_math_title', () => {
    const metas = [{ rank_math_title: 'My Title' }];
    expect(detectSeoPlugin(metas)).toBe('rankmath');
  });

  test('detects RankMath from rank_math_description', () => {
    const metas = [{ rank_math_description: 'My desc' }];
    expect(detectSeoPlugin(metas)).toBe('rankmath');
  });

  test('returns none when no SEO plugin meta found', () => {
    const metas = [{ some_other_key: 'value' }];
    expect(detectSeoPlugin(metas)).toBe('none');
  });

  test('returns none for empty array', () => {
    expect(detectSeoPlugin([])).toBe('none');
  });

  test('Yoast takes priority over RankMath when both present', () => {
    const metas = [{ _yoast_wpseo_title: 'Yoast', rank_math_title: 'RM' }];
    expect(detectSeoPlugin(metas)).toBe('yoast');
  });
});

// -- Meta extraction ----------------------------------------------------------

describe('extractSeoMeta', () => {
  test('extracts Yoast meta values', () => {
    const meta = {
      _yoast_wpseo_title: 'SEO Title',
      _yoast_wpseo_metadesc: 'SEO Description',
      '_yoast_wpseo_opengraph-image': 'https://example.com/og.jpg',
    };
    const result = extractSeoMeta(meta, 'yoast', 'Fallback', 'Fallback desc');
    expect(result.metaTitle).toBe('SEO Title');
    expect(result.metaDescription).toBe('SEO Description');
    expect(result.ogImage).toBe('https://example.com/og.jpg');
  });

  test('extracts RankMath meta values', () => {
    const meta = {
      rank_math_title: 'RM Title',
      rank_math_description: 'RM Desc',
      rank_math_facebook_image: 'https://example.com/rm-og.jpg',
    };
    const result = extractSeoMeta(meta, 'rankmath', 'Fallback', 'Fallback desc');
    expect(result.metaTitle).toBe('RM Title');
    expect(result.metaDescription).toBe('RM Desc');
    expect(result.ogImage).toBe('https://example.com/rm-og.jpg');
  });

  test('falls back to title/excerpt when no plugin', () => {
    const result = extractSeoMeta({}, 'none', 'Post Title', 'Post excerpt text');
    expect(result.metaTitle).toBe('Post Title');
    expect(result.metaDescription).toBe('Post excerpt text');
    expect(result.ogImage).toBe('');
  });

  test('handles missing keys gracefully', () => {
    const result = extractSeoMeta({}, 'yoast', 'Fallback', 'Fallback');
    expect(result.metaTitle).toBe('');
    expect(result.metaDescription).toBe('');
    expect(result.ogImage).toBe('');
  });
});

// -- Post analysis ------------------------------------------------------------

describe('analyzePostSeo', () => {
  test('reports missing meta title with Yoast', () => {
    const findings: SeoFinding[] = [];
    analyzePostSeo(
      { id: 1, title: 'Test Post', meta: {}, excerpt: '', featuredMedia: 0 },
      'yoast',
      findings,
    );
    expect(findings.some((f) => f.type === 'missing-meta-title')).toBe(true);
  });

  test('reports missing meta description with RankMath', () => {
    const findings: SeoFinding[] = [];
    analyzePostSeo(
      { id: 1, title: 'Test Post', meta: {}, excerpt: '', featuredMedia: 0 },
      'rankmath',
      findings,
    );
    expect(findings.some((f) => f.type === 'missing-meta-description')).toBe(true);
  });

  test('reports thin description', () => {
    const findings: SeoFinding[] = [];
    analyzePostSeo(
      {
        id: 1,
        title: 'Test',
        meta: { _yoast_wpseo_title: 'OK', _yoast_wpseo_metadesc: 'Short' },
        excerpt: '',
        featuredMedia: 1,
      },
      'yoast',
      findings,
    );
    expect(findings.some((f) => f.type === 'thin-description')).toBe(true);
  });

  test('does not report thin description when ≥120 chars', () => {
    const findings: SeoFinding[] = [];
    const longDesc = 'A'.repeat(120);
    analyzePostSeo(
      {
        id: 1,
        title: 'Test',
        meta: { _yoast_wpseo_title: 'OK', _yoast_wpseo_metadesc: longDesc },
        excerpt: '',
        featuredMedia: 1,
      },
      'yoast',
      findings,
    );
    expect(findings.some((f) => f.type === 'thin-description')).toBe(false);
  });

  test('reports missing OG image when no plugin image and no featured media', () => {
    const findings: SeoFinding[] = [];
    analyzePostSeo(
      {
        id: 1,
        title: 'Test',
        meta: { _yoast_wpseo_title: 'OK', _yoast_wpseo_metadesc: 'A'.repeat(150) },
        excerpt: '',
        featuredMedia: 0,
      },
      'yoast',
      findings,
    );
    expect(findings.some((f) => f.type === 'missing-og-image')).toBe(true);
  });

  test('does not report missing OG image when featured media is set', () => {
    const findings: SeoFinding[] = [];
    analyzePostSeo(
      {
        id: 1,
        title: 'Test',
        meta: { _yoast_wpseo_title: 'OK', _yoast_wpseo_metadesc: 'A'.repeat(150) },
        excerpt: '',
        featuredMedia: 42,
      },
      'yoast',
      findings,
    );
    expect(findings.some((f) => f.type === 'missing-og-image')).toBe(false);
  });

  test('does not report missing OG image when plugin OG field is set', () => {
    const findings: SeoFinding[] = [];
    analyzePostSeo(
      {
        id: 1,
        title: 'Test',
        meta: {
          _yoast_wpseo_title: 'OK',
          _yoast_wpseo_metadesc: 'A'.repeat(150),
          '_yoast_wpseo_opengraph-image': 'https://img.jpg',
        },
        excerpt: '',
        featuredMedia: 0,
      },
      'yoast',
      findings,
    );
    expect(findings.some((f) => f.type === 'missing-og-image')).toBe(false);
  });

  test('no-plugin mode uses title/excerpt as fallback', () => {
    const findings: SeoFinding[] = [];
    analyzePostSeo(
      {
        id: 1,
        title: 'Has a title',
        meta: {},
        excerpt:
          'Has an excerpt that is long enough to clear the threshold of one hundred and twenty characters easily if we just keep writing',
        featuredMedia: 1,
      },
      'none',
      findings,
    );
    // Should not report missing title or description since fallbacks are used.
    expect(findings.some((f) => f.type === 'missing-meta-title')).toBe(false);
    expect(findings.some((f) => f.type === 'missing-meta-description')).toBe(false);
  });
});

// -- Duplicate title detection ------------------------------------------------

describe('findDuplicateTitles', () => {
  test('finds duplicate titles', () => {
    const posts = [
      { id: 1, title: 'Hello World', metaTitle: '' },
      { id: 2, title: 'Hello World', metaTitle: '' },
      { id: 3, title: 'Unique Title', metaTitle: '' },
    ];
    const findings = findDuplicateTitles(posts, 'none');
    expect(findings.length).toBe(2); // Both duplicates reported.
    expect(findings.every((f) => f.type === 'duplicate-title')).toBe(true);
  });

  test('uses metaTitle over post title for comparison', () => {
    const posts = [
      { id: 1, title: 'Post One', metaTitle: 'Same SEO Title' },
      { id: 2, title: 'Post Two', metaTitle: 'Same SEO Title' },
    ];
    const findings = findDuplicateTitles(posts, 'yoast');
    expect(findings.length).toBe(2);
  });

  test('is case-insensitive', () => {
    const posts = [
      { id: 1, title: 'Hello', metaTitle: '' },
      { id: 2, title: 'hello', metaTitle: '' },
    ];
    const findings = findDuplicateTitles(posts, 'none');
    expect(findings.length).toBe(2);
  });

  test('returns empty for unique titles', () => {
    const posts = [
      { id: 1, title: 'One', metaTitle: '' },
      { id: 2, title: 'Two', metaTitle: '' },
    ];
    const findings = findDuplicateTitles(posts, 'none');
    expect(findings.length).toBe(0);
  });

  test('skips empty titles', () => {
    const posts = [
      { id: 1, title: '', metaTitle: '' },
      { id: 2, title: '', metaTitle: '' },
    ];
    const findings = findDuplicateTitles(posts, 'none');
    expect(findings.length).toBe(0);
  });
});

// -- Meta cleaning ------------------------------------------------------------

describe('cleanMetaTitle', () => {
  test('passes through short titles unchanged', () => {
    expect(cleanMetaTitle('Great Article About Testing')).toBe('Great Article About Testing');
  });

  test('strips surrounding quotes', () => {
    expect(cleanMetaTitle('"My Great Title"')).toBe('My Great Title');
  });

  test('removes LLM prefix patterns', () => {
    expect(cleanMetaTitle('Meta Title: The Best Guide')).toBe('The Best Guide');
    expect(cleanMetaTitle("Here's the title: Cool Post")).toBe('Cool Post');
  });

  test('truncates at word boundary for >60 chars', () => {
    const long =
      'This is a very long title that definitely exceeds the sixty character limit for SEO meta titles';
    const result = cleanMetaTitle(long);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result.endsWith(' ')).toBe(false);
  });
});

describe('cleanMetaDescription', () => {
  test('passes through normal descriptions unchanged', () => {
    const desc = 'A good description that is within the 160 character limit.';
    expect(cleanMetaDescription(desc)).toBe(desc);
  });

  test('strips surrounding quotes', () => {
    expect(cleanMetaDescription("'My description'")).toBe('My description');
  });

  test('removes LLM prefix patterns', () => {
    expect(cleanMetaDescription('Meta description: The real content here')).toBe(
      'The real content here',
    );
  });

  test('truncates at word boundary for >160 chars', () => {
    const long = `${'A'.repeat(50)} ${'B'.repeat(50)} ${'C'.repeat(50)} ${'D'.repeat(50)}`;
    const result = cleanMetaDescription(long);
    expect(result.length).toBeLessThanOrEqual(160);
  });
});

// -- Meta payload building ----------------------------------------------------

describe('buildMetaPayload', () => {
  test('builds Yoast payload', () => {
    const payload = buildMetaPayload('yoast', 'Title', 'Desc');
    expect(payload._yoast_wpseo_title).toBe('Title');
    expect(payload._yoast_wpseo_metadesc).toBe('Desc');
  });

  test('builds RankMath payload', () => {
    const payload = buildMetaPayload('rankmath', 'Title', 'Desc');
    expect(payload.rank_math_title).toBe('Title');
    expect(payload.rank_math_description).toBe('Desc');
  });

  test('returns empty payload for no plugin', () => {
    const payload = buildMetaPayload('none', 'Title', 'Desc');
    expect(Object.keys(payload).length).toBe(0);
  });

  test('omits undefined fields', () => {
    const payload = buildMetaPayload('yoast', undefined, 'Only desc');
    expect(payload._yoast_wpseo_title).toBeUndefined();
    expect(payload._yoast_wpseo_metadesc).toBe('Only desc');
  });
});
