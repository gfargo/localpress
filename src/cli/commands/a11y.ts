/**
 * `localpress a11y` — accessibility audit for WordPress content.
 *
 * Fetches posts/pages and analyzes HTML content for common WCAG issues:
 *   - Heading hierarchy (skipped levels, multiple h1s)
 *   - Generic link text ("click here", "read more")
 *   - Missing alt on inline images
 *   - Empty links (no text content)
 */

import type { Command } from 'commander';
import { ExitCode } from '../../types.ts';
import { parseIntOption } from '../utils/args.ts';
import { loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson } from '../utils/output.ts';

const GENERIC_LINK_TEXTS = new Set([
  'click here',
  'here',
  'read more',
  'learn more',
  'more',
  'link',
  'this',
  'this link',
  'go',
  'see more',
  'details',
  'info',
  'continue',
  'continue reading',
]);

interface A11yFinding {
  type: 'heading-skip' | 'multiple-h1' | 'generic-link-text' | 'missing-img-alt' | 'empty-link';
  postId: number;
  postTitle: string;
  detail: string;
  element?: string;
}

interface A11yError {
  postType: string;
  url: string;
  status?: number;
  message?: string;
}

export interface A11yScanOptions {
  baseUrl: string;
  auth: string;
  types: string[];
  id?: number;
  status: string;
  limit: number;
}

export interface A11yScanResult {
  postsChecked: number;
  findings: A11yFinding[];
  errors: A11yError[];
  truncated: string[];
  complete: boolean;
}

/**
 * Fetch and analyze posts/pages for a site. Extracted from the command
 * action so it can be exercised directly in tests with a mocked fetch.
 */
export async function runA11yScan(scanOptions: A11yScanOptions): Promise<A11yScanResult> {
  const { baseUrl, auth, types, id, status, limit } = scanOptions;

  const findings: A11yFinding[] = [];
  const errors: A11yError[] = [];
  const idModeResults: Record<string, boolean> = {};
  const truncatedTypes: string[] = [];
  let postsChecked = 0;

  for (const postType of types) {
    if (id) {
      // Single post mode.
      const url = `${baseUrl}/wp-json/wp/v2/${postType}/${id}?context=edit`;
      try {
        const res = await fetch(url, { headers: { Authorization: auth } });
        if (!res.ok) {
          // Might just be the wrong post type for this ID — only report
          // as an error if no post type succeeds for this ID.
          errors.push({ postType, url, status: res.status });
          idModeResults[postType] = false;
          continue;
        }
        idModeResults[postType] = true;
        const post = (await res.json()) as {
          id: number;
          title: { rendered: string };
          content: { rendered: string };
        };
        postsChecked++;
        analyzePost(
          post.id,
          post.title.rendered.replace(/<[^>]*>/g, ''),
          post.content.rendered,
          findings,
        );
      } catch (err) {
        errors.push({
          postType,
          url,
          message: err instanceof Error ? err.message : String(err),
        });
        idModeResults[postType] = false;
      }
      continue;
    }

    // Paginate through posts.
    let page = 1;
    let limitReached = false;
    while (postsChecked < limit) {
      const perPage = Math.min(20, limit - postsChecked);
      const params = new URLSearchParams({
        per_page: String(perPage),
        page: String(page),
        status,
        _fields: 'id,title,content',
      });

      const url = `${baseUrl}/wp-json/wp/v2/${postType}?${params}`;
      try {
        const res = await fetch(url, { headers: { Authorization: auth } });
        if (!res.ok) {
          errors.push({ postType, url, status: res.status });
          break;
        }

        const posts = (await res.json()) as Array<{
          id: number;
          title: { rendered: string };
          content: { rendered: string };
        }>;
        if (posts.length === 0) break;

        for (const post of posts) {
          postsChecked++;
          const title = post.title.rendered.replace(/<[^>]*>/g, '');
          analyzePost(post.id, title, post.content.rendered, findings);
        }

        const totalPages = Number.parseInt(res.headers.get('X-WP-TotalPages') ?? '1', 10);
        if (page >= totalPages) break;
        if (postsChecked >= limit) {
          limitReached = true;
          break;
        }
        page++;
      } catch (err) {
        errors.push({
          postType,
          url,
          message: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }

    if (limitReached) truncatedTypes.push(postType);
  }

  // In --id mode, a 404/error for one post type isn't a real error if
  // another post type successfully found the post.
  const filteredErrors = id
    ? errors.filter(() => !Object.values(idModeResults).some(Boolean))
    : errors;

  const complete = filteredErrors.length === 0 && truncatedTypes.length === 0;

  return {
    postsChecked,
    findings,
    errors: filteredErrors,
    truncated: truncatedTypes,
    complete,
  };
}

export function registerA11yCommand(program: Command): void {
  program
    .command('a11y')
    .description('Accessibility audit — check posts/pages for WCAG issues')
    .option('--type <type>', 'post type to check: post, page, or both (default: both)')
    .option('--status <status>', 'post status to check (default: publish)', 'publish')
    .option('--id <id>', 'check a specific post/page only', parseIntOption('--id'))
    .option('--limit <n>', 'max posts to check (default: 100)', parseIntOption('--limit'))
    .action(async (options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);

      const baseUrl = site.url.replace(/\/+$/, '');
      const auth = `Basic ${btoa(`${site.username}:${site.appPassword}`)}`;

      // Determine which post types to check.
      const types: string[] =
        options.type === 'post'
          ? ['posts']
          : options.type === 'page'
            ? ['pages']
            : ['posts', 'pages'];

      const limit = options.limit ?? 100;

      const {
        postsChecked,
        findings,
        errors: filteredErrors,
        truncated: truncatedTypes,
        complete,
      } = await runA11yScan({
        baseUrl,
        auth,
        types,
        id: options.id,
        status: options.status,
        limit,
      });

      // Build summary.
      const summary = {
        headingSkip: findings.filter((f) => f.type === 'heading-skip').length,
        multipleH1: findings.filter((f) => f.type === 'multiple-h1').length,
        genericLinkText: findings.filter((f) => f.type === 'generic-link-text').length,
        missingImgAlt: findings.filter((f) => f.type === 'missing-img-alt').length,
        emptyLink: findings.filter((f) => f.type === 'empty-link').length,
      };

      if (parentOpts.json) {
        printJson({
          site: site.name,
          postsChecked,
          findings,
          summary,
          errors: filteredErrors,
          truncated: truncatedTypes,
          complete,
        });
        if (filteredErrors.length > 0) process.exitCode = ExitCode.NetworkError;
        return;
      }

      info(`Accessibility audit — ${postsChecked} post(s) checked on '${site.name}':\n`);

      if (filteredErrors.length > 0) {
        error(`Scan encountered ${filteredErrors.length} error(s):`);
        for (const e of filteredErrors) {
          const reason = e.status ? `HTTP ${e.status}` : (e.message ?? 'unknown error');
          error(`  [${e.postType}] ${e.url} — ${reason}`);
        }
        info('');

        if (postsChecked === 0) {
          info('  0 post(s) checked — all requests failed. See errors above.');
        }

        process.exitCode = ExitCode.NetworkError;
        return;
      }

      if (findings.length === 0) {
        if (truncatedTypes.length > 0) {
          info(
            `  No issues found in the posts checked (scan incomplete — reached --limit before all pages were checked for: ${truncatedTypes.join(', ')}).`,
          );
        } else {
          info('  No accessibility issues found. Nice work!');
        }
        return;
      }

      const groups: Record<string, { label: string; items: A11yFinding[] }> = {
        headingSkip: {
          label: 'Heading hierarchy issues',
          items: findings.filter((f) => f.type === 'heading-skip'),
        },
        multipleH1: {
          label: 'Multiple h1 elements',
          items: findings.filter((f) => f.type === 'multiple-h1'),
        },
        genericLinkText: {
          label: 'Generic link text',
          items: findings.filter((f) => f.type === 'generic-link-text'),
        },
        missingImgAlt: {
          label: 'Images missing alt in content',
          items: findings.filter((f) => f.type === 'missing-img-alt'),
        },
        emptyLink: {
          label: 'Empty links',
          items: findings.filter((f) => f.type === 'empty-link'),
        },
      };

      for (const group of Object.values(groups)) {
        if (group.items.length === 0) continue;
        info(`  ${group.label}: ${group.items.length}`);
        for (const f of group.items.slice(0, 5)) {
          info(`    #${f.postId} "${f.postTitle}" — ${f.detail}`);
        }
        if (group.items.length > 5) info(`    ... and ${group.items.length - 5} more`);
        info('');
      }

      info(`  Total findings: ${findings.length}`);
      info('  Fix generic link text by making links descriptive of their destination.');
      info('  Fix heading hierarchy by ensuring no levels are skipped (h1 → h2 → h3).');

      if (truncatedTypes.length > 0) {
        info(
          `\n  Scan incomplete — reached --limit before all pages were checked for: ${truncatedTypes.join(', ')}.`,
        );
      }
    });
}

// -- Analysis helpers ---------------------------------------------------------

function analyzePost(
  postId: number,
  postTitle: string,
  html: string,
  findings: A11yFinding[],
): void {
  if (!html) return;

  // 1. Heading hierarchy check.
  const headingRegex = /<h([1-6])[^>]*>/gi;
  const headings: number[] = [];
  for (let match = headingRegex.exec(html); match !== null; match = headingRegex.exec(html)) {
    headings.push(Number.parseInt(match[1], 10));
  }

  // Check for multiple h1s.
  const h1Count = headings.filter((h) => h === 1).length;
  if (h1Count > 1) {
    findings.push({
      type: 'multiple-h1',
      postId,
      postTitle,
      detail: `Page has ${h1Count} h1 elements (should have at most 1)`,
    });
  }

  // Check for skipped levels.
  for (let i = 1; i < headings.length; i++) {
    if (headings[i] > headings[i - 1] + 1) {
      findings.push({
        type: 'heading-skip',
        postId,
        postTitle,
        detail: `Skips from h${headings[i - 1]} to h${headings[i]} (missing h${headings[i - 1] + 1})`,
      });
    }
  }

  // 2. Link text quality.
  const linkRegex = /<a\s[^>]*>(.*?)<\/a>/gi;
  for (let match = linkRegex.exec(html); match !== null; match = linkRegex.exec(html)) {
    const fullTag = match[0];
    const linkText = match[1]
      .replace(/<[^>]*>/g, '')
      .trim()
      .toLowerCase();

    if (!linkText) {
      // Check if it has an aria-label or contains an image.
      if (!fullTag.includes('aria-label') && !fullTag.includes('<img')) {
        findings.push({
          type: 'empty-link',
          postId,
          postTitle,
          detail: 'Link has no text content and no aria-label',
          element: fullTag.slice(0, 100),
        });
      }
    } else if (GENERIC_LINK_TEXTS.has(linkText)) {
      findings.push({
        type: 'generic-link-text',
        postId,
        postTitle,
        detail: `Link text "${linkText}" is not descriptive of its destination`,
        element: fullTag.slice(0, 100),
      });
    }
  }

  // 3. Missing alt on inline images.
  const imgRegex = /<img\s[^>]*>/gi;
  for (let match = imgRegex.exec(html); match !== null; match = imgRegex.exec(html)) {
    const imgTag = match[0];
    // Check if alt attribute exists (even empty alt="" is intentional for decorative images).
    if (!imgTag.includes('alt=')) {
      findings.push({
        type: 'missing-img-alt',
        postId,
        postTitle,
        detail: 'Image in content has no alt attribute',
        element: imgTag.slice(0, 100),
      });
    }
  }
}
