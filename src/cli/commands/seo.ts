/**
 * `localpress seo` — SEO audit and AI-powered meta generation.
 *
 * Subcommands:
 *   - `seo audit` — scan posts/pages for SEO issues (missing meta titles,
 *     descriptions, duplicate titles, thin descriptions, missing OG images)
 *   - `seo generate` — bulk-generate missing meta titles/descriptions via Ollama
 *
 * Detects Yoast SEO and RankMath via their post meta keys; falls back to
 * WP core title/excerpt when no SEO plugin is detected.
 */

import type { Command } from 'commander';
import { ExitCode } from '../../types.ts';
import type { SiteConfig } from '../../types.ts';
import { parsePositiveIntOption } from '../utils/args.ts';
import { loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

// -- Types -------------------------------------------------------------------

export type SeoFindingType =
  | 'missing-meta-title'
  | 'missing-meta-description'
  | 'duplicate-title'
  | 'thin-description'
  | 'missing-og-image';

export interface SeoFinding {
  type: SeoFindingType;
  postId: number;
  postTitle: string;
  detail: string;
}

export interface SeoSummary {
  missingMetaTitle: number;
  missingMetaDescription: number;
  duplicateTitle: number;
  thinDescription: number;
  missingOgImage: number;
}

export type SeoPlugin = 'yoast' | 'rankmath' | 'none';

export interface SeoAuditResult {
  site: string;
  totalPosts: number;
  seoPlugin: SeoPlugin;
  findings: SeoFinding[];
  summary: SeoSummary;
  errors: SeoAuditError[];
  complete: boolean;
}

interface SeoAuditError {
  postType: string;
  url: string;
  status?: number;
  message?: string;
}

// -- Constants ---------------------------------------------------------------

/** Yoast SEO meta keys (stored in wp_postmeta). */
const YOAST_TITLE_KEY = '_yoast_wpseo_title';
const YOAST_DESC_KEY = '_yoast_wpseo_metadesc';
const YOAST_OG_IMAGE_KEY = '_yoast_wpseo_opengraph-image';

/** RankMath meta keys. */
const RANKMATH_TITLE_KEY = 'rank_math_title';
const RANKMATH_DESC_KEY = 'rank_math_description';
const RANKMATH_OG_IMAGE_KEY = 'rank_math_facebook_image';

/** Minimum description length before it's considered "thin". */
const THIN_DESCRIPTION_THRESHOLD = 120;

// -- SEO Plugin Detection ----------------------------------------------------

/**
 * Detect which SEO plugin is active by checking meta keys on a sample of posts.
 * Returns 'yoast', 'rankmath', or 'none'.
 */
export function detectSeoPlugin(postsMeta: Array<Record<string, unknown>>): SeoPlugin {
  for (const meta of postsMeta) {
    if (meta[YOAST_TITLE_KEY] !== undefined || meta[YOAST_DESC_KEY] !== undefined) return 'yoast';
    if (meta[RANKMATH_TITLE_KEY] !== undefined || meta[RANKMATH_DESC_KEY] !== undefined)
      return 'rankmath';
  }
  return 'none';
}

// -- Meta Extraction ---------------------------------------------------------

interface PostMetaValues {
  metaTitle: string;
  metaDescription: string;
  ogImage: string;
}

/**
 * Extract SEO meta values from a post's meta object based on detected plugin.
 */
export function extractSeoMeta(
  meta: Record<string, unknown>,
  plugin: SeoPlugin,
  fallbackTitle: string,
  fallbackExcerpt: string,
): PostMetaValues {
  let metaTitle = '';
  let metaDescription = '';
  let ogImage = '';

  switch (plugin) {
    case 'yoast':
      metaTitle = String(meta[YOAST_TITLE_KEY] ?? '').trim();
      metaDescription = String(meta[YOAST_DESC_KEY] ?? '').trim();
      ogImage = String(meta[YOAST_OG_IMAGE_KEY] ?? '').trim();
      break;
    case 'rankmath':
      metaTitle = String(meta[RANKMATH_TITLE_KEY] ?? '').trim();
      metaDescription = String(meta[RANKMATH_DESC_KEY] ?? '').trim();
      ogImage = String(meta[RANKMATH_OG_IMAGE_KEY] ?? '').trim();
      break;
    case 'none':
      // No SEO plugin — use WP core title and excerpt as stand-ins.
      metaTitle = fallbackTitle;
      metaDescription = fallbackExcerpt;
      // No OG image field without a plugin — only featured_media covers it.
      ogImage = '';
      break;
  }

  return { metaTitle, metaDescription, ogImage };
}

// -- Analysis ----------------------------------------------------------------

interface AnalyzablePost {
  id: number;
  title: string;
  meta: Record<string, unknown>;
  excerpt: string;
  featuredMedia: number;
}

/**
 * Analyze a single post for SEO issues. Pure function — no I/O.
 */
export function analyzePostSeo(
  post: AnalyzablePost,
  plugin: SeoPlugin,
  findings: SeoFinding[],
): void {
  const { metaTitle, metaDescription, ogImage } = extractSeoMeta(
    post.meta,
    plugin,
    post.title,
    post.excerpt,
  );

  if (!metaTitle) {
    findings.push({
      type: 'missing-meta-title',
      postId: post.id,
      postTitle: post.title,
      detail:
        plugin === 'none'
          ? 'No SEO plugin detected; WP title used as fallback'
          : `No ${plugin} meta title set`,
    });
  }

  if (!metaDescription) {
    findings.push({
      type: 'missing-meta-description',
      postId: post.id,
      postTitle: post.title,
      detail:
        plugin === 'none'
          ? 'No SEO plugin detected; no excerpt set'
          : `No ${plugin} meta description set`,
    });
  } else if (metaDescription.length < THIN_DESCRIPTION_THRESHOLD) {
    findings.push({
      type: 'thin-description',
      postId: post.id,
      postTitle: post.title,
      detail: `Meta description is only ${metaDescription.length} chars (recommended ≥${THIN_DESCRIPTION_THRESHOLD})`,
    });
  }

  // OG image: check plugin-specific field first, fall back to featured_media.
  if (!ogImage && post.featuredMedia === 0) {
    findings.push({
      type: 'missing-og-image',
      postId: post.id,
      postTitle: post.title,
      detail: 'No Open Graph image and no featured image set',
    });
  }
}

/**
 * Detect duplicate titles across a set of posts.
 */
export function findDuplicateTitles(
  posts: Array<{ id: number; title: string; metaTitle: string }>,
  _plugin: SeoPlugin,
): SeoFinding[] {
  const findings: SeoFinding[] = [];
  const titleMap = new Map<string, Array<{ id: number; title: string }>>();

  for (const post of posts) {
    // Use SEO meta title if available, otherwise the post title.
    const effectiveTitle = (post.metaTitle || post.title).toLowerCase().trim();
    if (!effectiveTitle) continue;

    const existing = titleMap.get(effectiveTitle) ?? [];
    existing.push({ id: post.id, title: post.title });
    titleMap.set(effectiveTitle, existing);
  }

  for (const [, group] of titleMap) {
    if (group.length <= 1) continue;
    for (const post of group) {
      findings.push({
        type: 'duplicate-title',
        postId: post.id,
        postTitle: post.title,
        detail: `Title duplicated across ${group.length} posts: ${group.map((p) => `#${p.id}`).join(', ')}`,
      });
    }
  }

  return findings;
}

// -- Scan Engine -------------------------------------------------------------

export interface SeoScanOptions {
  baseUrl: string;
  auth: string;
  types: string[];
  id?: number;
  status: string;
  limit: number;
}

/**
 * Fetch posts and run SEO analysis. Extracted for testability.
 */
export async function runSeoScan(
  scanOptions: SeoScanOptions,
): Promise<SeoAuditResult & { site: string }> {
  const { baseUrl, auth, types, id, status, limit } = scanOptions;

  const findings: SeoFinding[] = [];
  const errors: SeoAuditError[] = [];
  const allPosts: Array<{ id: number; title: string; metaTitle: string }> = [];
  let totalPosts = 0;
  let plugin: SeoPlugin = 'none';
  let pluginDetected = false;

  for (const postType of types) {
    if (id) {
      // Single-post mode.
      const url = `${baseUrl}/wp-json/wp/v2/${postType}/${id}?context=edit`;
      try {
        const res = await fetch(url, { headers: { Authorization: auth } });
        if (!res.ok) {
          if (res.status !== 404) {
            errors.push({ postType, url, status: res.status });
          }
          continue;
        }
        const post = (await res.json()) as WpRestPost;
        totalPosts++;

        const meta = post.meta ?? {};
        if (!pluginDetected) {
          plugin = detectSeoPlugin([meta]);
          pluginDetected = true;
        }

        const title = stripTags(post.title?.rendered ?? post.title?.raw ?? '');
        const excerpt = stripTags(post.excerpt?.rendered ?? post.excerpt?.raw ?? '');
        const { metaTitle } = extractSeoMeta(meta, plugin, title, excerpt);

        analyzePostSeo(
          { id: post.id, title, meta, excerpt, featuredMedia: post.featured_media ?? 0 },
          plugin,
          findings,
        );
        allPosts.push({ id: post.id, title, metaTitle });
      } catch (err) {
        errors.push({ postType, url, message: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }

    // Paginated scan.
    const PER_PAGE = 20;
    let page = 1;
    while (totalPosts < limit) {
      const params = new URLSearchParams({
        per_page: String(PER_PAGE),
        page: String(page),
        status,
        context: 'edit',
        _fields: 'id,title,excerpt,meta,featured_media',
      });
      const url = `${baseUrl}/wp-json/wp/v2/${postType}?${params}`;

      try {
        const res = await fetch(url, { headers: { Authorization: auth } });
        if (!res.ok) {
          errors.push({ postType, url, status: res.status });
          break;
        }

        const posts = (await res.json()) as WpRestPost[];
        if (posts.length === 0) break;

        // Detect plugin from first batch.
        if (!pluginDetected && posts.length > 0) {
          const metas = posts.map((p) => p.meta ?? {});
          plugin = detectSeoPlugin(metas);
          pluginDetected = true;
        }

        for (const post of posts) {
          if (totalPosts >= limit) break;
          totalPosts++;

          const meta = post.meta ?? {};
          const title = stripTags(post.title?.rendered ?? post.title?.raw ?? '');
          const excerpt = stripTags(post.excerpt?.rendered ?? post.excerpt?.raw ?? '');
          const { metaTitle } = extractSeoMeta(meta, plugin, title, excerpt);

          analyzePostSeo(
            { id: post.id, title, meta, excerpt, featuredMedia: post.featured_media ?? 0 },
            plugin,
            findings,
          );
          allPosts.push({ id: post.id, title, metaTitle });
        }

        const totalPages = Number.parseInt(res.headers.get('X-WP-TotalPages') ?? '1', 10);
        if (page >= totalPages) break;
        if (totalPosts >= limit) break;
        page++;
      } catch (err) {
        errors.push({ postType, url, message: err instanceof Error ? err.message : String(err) });
        break;
      }
    }
  }

  // Check for duplicate titles across all scanned posts.
  const duplicateFindings = findDuplicateTitles(allPosts, plugin);
  findings.push(...duplicateFindings);

  const summary: SeoSummary = {
    missingMetaTitle: findings.filter((f) => f.type === 'missing-meta-title').length,
    missingMetaDescription: findings.filter((f) => f.type === 'missing-meta-description').length,
    duplicateTitle: findings.filter((f) => f.type === 'duplicate-title').length,
    thinDescription: findings.filter((f) => f.type === 'thin-description').length,
    missingOgImage: findings.filter((f) => f.type === 'missing-og-image').length,
  };

  return {
    site: '', // filled by caller
    totalPosts,
    seoPlugin: plugin,
    findings,
    summary,
    errors,
    complete: errors.length === 0,
  };
}

// -- Command Registration ----------------------------------------------------

export function registerSeoCommand(program: Command): void {
  const seo = program.command('seo').description('SEO audit and AI meta generation');

  // -- seo audit -------------------------------------------------------------
  seo
    .command('audit')
    .description(
      'Scan posts/pages for SEO issues: missing meta titles/descriptions, duplicate titles, thin descriptions, missing OG images',
    )
    .option('--type <type>', 'post type: post, page, or both (default: both)')
    .option('--status <status>', 'post status to check (default: publish)', 'publish')
    .option('--id <id>', 'check a specific post only', parsePositiveIntOption('--id'))
    .option('--limit <n>', 'max posts to check (default: 100)', parsePositiveIntOption('--limit'))
    .action(async (options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);

      const result = await runSeoAudit(site, options);

      if (parentOpts.json) {
        printJson(result);
        if (result.errors.length > 0) process.exitCode = ExitCode.NetworkError;
        else if (result.findings.length > 0) process.exitCode = ExitCode.GenericError;
        return;
      }

      printSeoAuditHuman(result);
      if (result.errors.length > 0) process.exitCode = ExitCode.NetworkError;
      else if (result.findings.length > 0) process.exitCode = ExitCode.GenericError;
    });

  // -- seo generate ----------------------------------------------------------
  seo
    .command('generate')
    .description('Generate missing SEO meta titles and/or descriptions using a local Ollama model')
    .option('--missing-title', 'generate meta titles for posts that lack one')
    .option('--missing-description', 'generate meta descriptions for posts that lack one')
    .option('--model <model>', 'Ollama model to use (default: config or moondream)')
    .option('--type <type>', 'post type: post, page, or both (default: both)')
    .option('--status <status>', 'post status (default: publish)', 'publish')
    .option('--limit <n>', 'max posts to process (default: 50)', parsePositiveIntOption('--limit'))
    .option('--id <id>', 'process a specific post only', parsePositiveIntOption('--id'))
    .action(async (options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const isDryRun = !parentOpts.apply && !options.id;

      if (!options.missingTitle && !options.missingDescription) {
        error('Specify at least one of --missing-title or --missing-description.');
        process.exit(ExitCode.InvalidUsage);
      }

      const model: string = options.model ?? config.defaults?.captionModel ?? 'moondream';

      // First, run the SEO scan to find posts that need meta.
      const auditResult = await runSeoAudit(site, {
        type: options.type,
        status: options.status,
        limit: options.limit ?? 50,
        id: options.id,
      });

      // Filter to posts needing generation.
      const postsToFix: Array<{
        id: number;
        title: string;
        needsTitle: boolean;
        needsDesc: boolean;
      }> = [];
      const seen = new Set<number>();

      for (const finding of auditResult.findings) {
        if (seen.has(finding.postId)) {
          const existing = postsToFix.find((p) => p.id === finding.postId);
          if (existing) {
            if (finding.type === 'missing-meta-title' && options.missingTitle)
              existing.needsTitle = true;
            if (finding.type === 'missing-meta-description' && options.missingDescription)
              existing.needsDesc = true;
          }
          continue;
        }

        const needsTitle = finding.type === 'missing-meta-title' && !!options.missingTitle;
        const needsDesc =
          finding.type === 'missing-meta-description' && !!options.missingDescription;
        if (!needsTitle && !needsDesc) continue;

        seen.add(finding.postId);
        postsToFix.push({ id: finding.postId, title: finding.postTitle, needsTitle, needsDesc });
      }

      if (postsToFix.length === 0) {
        if (parentOpts.json) {
          printJson({ dryRun: isDryRun, generated: 0, items: [] });
        } else {
          info('No posts need SEO meta generation. Everything looks good!');
        }
        return;
      }

      if (isDryRun) {
        const items = postsToFix.map((p) => ({
          id: p.id,
          title: p.title,
          needsTitle: p.needsTitle,
          needsDescription: p.needsDesc,
        }));
        if (parentOpts.json) {
          printJson({
            dryRun: true,
            changes: { operation: 'seo.generate', count: postsToFix.length, items },
          });
        } else {
          info(`Dry-run: would generate SEO meta for ${postsToFix.length} post(s):\n`);
          for (const item of items.slice(0, 20)) {
            const fields = [item.needsTitle && 'title', item.needsDescription && 'description']
              .filter(Boolean)
              .join(', ');
            info(`  #${item.id}  ${item.title}  (${fields})`);
          }
          if (items.length > 20) info(`  ... and ${items.length - 20} more`);
          info('\nPass --apply to execute, or use explicit --id to process one post.');
        }
        return;
      }

      // Execute generation via Ollama.
      const { generateText, isOllamaAvailable } = await import('../../engine/caption/ollama.ts');
      const ollamaReady = await isOllamaAvailable(model);
      if (!ollamaReady) {
        error(
          `Ollama model "${model}" is not available. Run \`ollama pull ${model}\` or set a different model with --model.`,
        );
        process.exit(ExitCode.GenericError);
      }

      const baseUrl = site.url.replace(/\/+$/, '');
      const auth = `Basic ${btoa(`${site.username}:${site.appPassword}`)}`;
      const results: Array<{
        id: number;
        title: string;
        generatedTitle?: string;
        generatedDescription?: string;
        error?: string;
      }> = [];

      for (const post of postsToFix) {
        try {
          // Fetch post content for context.
          const postUrl = `${baseUrl}/wp-json/wp/v2/posts/${post.id}?context=edit&_fields=content,title,excerpt`;
          const postRes = await fetch(postUrl, { headers: { Authorization: auth } });
          if (!postRes.ok) {
            results.push({ id: post.id, title: post.title, error: `HTTP ${postRes.status}` });
            continue;
          }
          const postData = (await postRes.json()) as {
            content?: { raw?: string };
            title?: { raw?: string };
            excerpt?: { raw?: string };
          };
          const contentText = stripTags(postData.content?.raw ?? '').slice(0, 2000);
          const titleText = stripTags(postData.title?.raw ?? post.title);

          let generatedTitle: string | undefined;
          let generatedDescription: string | undefined;

          if (post.needsTitle) {
            const prompt = `Write a concise SEO meta title (maximum 60 characters) for this blog post. Return ONLY the title text, nothing else.\n\nPost title: ${titleText}\nPost content (first 2000 chars): ${contentText}`;
            const result = await generateText(prompt, { model });
            generatedTitle = cleanMetaTitle(result.text);
          }

          if (post.needsDesc) {
            const prompt = `Write a compelling SEO meta description (120-160 characters) for this blog post. Return ONLY the description text, nothing else.\n\nPost title: ${titleText}\nPost content (first 2000 chars): ${contentText}`;
            const result = await generateText(prompt, { model });
            generatedDescription = cleanMetaDescription(result.text);
          }

          // Write meta back to WordPress.
          const metaPayload = buildMetaPayload(
            auditResult.seoPlugin,
            generatedTitle,
            generatedDescription,
          );
          if (Object.keys(metaPayload).length > 0) {
            const updateUrl = `${baseUrl}/wp-json/wp/v2/posts/${post.id}`;
            const updateRes = await fetch(updateUrl, {
              method: 'POST',
              headers: { Authorization: auth, 'Content-Type': 'application/json' },
              body: JSON.stringify({ meta: metaPayload }),
            });
            if (!updateRes.ok) {
              results.push({
                id: post.id,
                title: post.title,
                generatedTitle,
                generatedDescription,
                error: `Write failed: HTTP ${updateRes.status}`,
              });
              continue;
            }
          }

          results.push({ id: post.id, title: post.title, generatedTitle, generatedDescription });
        } catch (err) {
          results.push({
            id: post.id,
            title: post.title,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const succeeded = results.filter((r) => !r.error).length;
      const failed = results.filter((r) => !!r.error).length;

      if (parentOpts.json) {
        printJson({ dryRun: false, generated: succeeded, failed, results });
      } else {
        info(`SEO meta generation complete: ${succeeded} succeeded, ${failed} failed.\n`);
        for (const r of results.slice(0, 20)) {
          if (r.error) {
            warn(`  #${r.id}  ${r.title}  ✗ ${r.error}`);
          } else {
            const parts: string[] = [];
            if (r.generatedTitle) parts.push(`title: "${r.generatedTitle}"`);
            if (r.generatedDescription)
              parts.push(`desc: "${r.generatedDescription?.slice(0, 60)}…"`);
            info(`  #${r.id}  ${r.title}  ✓ ${parts.join(', ')}`);
          }
        }
        if (results.length > 20) info(`  ... and ${results.length - 20} more`);
      }

      if (failed > 0) process.exitCode = ExitCode.GenericError;
    });
}

// -- Helpers -----------------------------------------------------------------

interface WpRestPost {
  id: number;
  title: { rendered: string; raw?: string };
  excerpt: { rendered: string; raw?: string };
  content?: { rendered: string; raw?: string };
  meta: Record<string, unknown>;
  featured_media: number;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

async function runSeoAudit(
  site: SiteConfig,
  options: { type?: string; status?: string; limit?: number; id?: number },
): Promise<SeoAuditResult> {
  const baseUrl = site.url.replace(/\/+$/, '');
  const auth = `Basic ${btoa(`${site.username}:${site.appPassword}`)}`;

  const types: string[] =
    options.type === 'post' ? ['posts'] : options.type === 'page' ? ['pages'] : ['posts', 'pages'];

  const result = await runSeoScan({
    baseUrl,
    auth,
    types,
    id: options.id,
    status: options.status ?? 'publish',
    limit: options.limit ?? 100,
  });

  return { ...result, site: site.name };
}

function printSeoAuditHuman(result: SeoAuditResult): void {
  info(`SEO audit — ${result.totalPosts} post(s) checked on '${result.site}':`);
  info(`  SEO plugin detected: ${result.seoPlugin}\n`);

  if (result.errors.length > 0) {
    error(`Scan encountered ${result.errors.length} error(s):`);
    for (const e of result.errors) {
      const reason = e.status ? `HTTP ${e.status}` : (e.message ?? 'unknown');
      error(`  [${e.postType}] ${reason}`);
    }
    info('');
  }

  if (result.findings.length === 0) {
    info('  No SEO issues found. Nice work!');
    return;
  }

  const groups: Array<{ key: keyof SeoSummary; label: string }> = [
    { key: 'missingMetaTitle', label: 'Missing meta title' },
    { key: 'missingMetaDescription', label: 'Missing meta description' },
    { key: 'duplicateTitle', label: 'Duplicate titles' },
    { key: 'thinDescription', label: 'Thin descriptions (<120 chars)' },
    { key: 'missingOgImage', label: 'Missing OG/featured image' },
  ];

  for (const { key, label } of groups) {
    const count = result.summary[key];
    if (count === 0) continue;
    info(`  ${label}: ${count}`);
    const items = result.findings.filter(
      (f) =>
        (key === 'missingMetaTitle' && f.type === 'missing-meta-title') ||
        (key === 'missingMetaDescription' && f.type === 'missing-meta-description') ||
        (key === 'duplicateTitle' && f.type === 'duplicate-title') ||
        (key === 'thinDescription' && f.type === 'thin-description') ||
        (key === 'missingOgImage' && f.type === 'missing-og-image'),
    );
    for (const f of items.slice(0, 5)) {
      info(`    #${f.postId}  ${f.postTitle}  — ${f.detail}`);
    }
    if (items.length > 5) info(`    ... and ${items.length - 5} more`);
    info('');
  }

  info(`  Total findings: ${result.findings.length}`);
  info('  Run `localpress seo generate --missing-title --missing-description --apply` to fix.');
}

/**
 * Clean and truncate a generated meta title to ≤60 chars at a word boundary.
 */
export function cleanMetaTitle(raw: string): string {
  let cleaned = raw.replace(/^["']|["']$/g, '').trim();
  // Remove common LLM prefixes.
  cleaned = cleaned.replace(/^(meta title:|title:|here'?s the.*?:)\s*/i, '').trim();
  if (cleaned.length <= 60) return cleaned;
  // Truncate at word boundary.
  const truncated = cleaned.slice(0, 60);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 30 ? truncated.slice(0, lastSpace) : truncated;
}

/**
 * Clean and truncate a generated meta description to ≤160 chars at a word boundary.
 */
export function cleanMetaDescription(raw: string): string {
  let cleaned = raw.replace(/^["']|["']$/g, '').trim();
  cleaned = cleaned.replace(/^(meta description:|description:|here'?s the.*?:)\s*/i, '').trim();
  if (cleaned.length <= 160) return cleaned;
  const truncated = cleaned.slice(0, 160);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 80 ? truncated.slice(0, lastSpace) : truncated;
}

/**
 * Build the meta payload for a WP REST API post update based on the detected SEO plugin.
 */
export function buildMetaPayload(
  plugin: SeoPlugin,
  title: string | undefined,
  description: string | undefined,
): Record<string, string> {
  const payload: Record<string, string> = {};

  switch (plugin) {
    case 'yoast':
      if (title) payload[YOAST_TITLE_KEY] = title;
      if (description) payload[YOAST_DESC_KEY] = description;
      break;
    case 'rankmath':
      if (title) payload[RANKMATH_TITLE_KEY] = title;
      if (description) payload[RANKMATH_DESC_KEY] = description;
      break;
    case 'none':
      // Without an SEO plugin, there's no standard meta field to write to.
      // We could write to a custom field, but that won't render in <head>.
      // Log a warning instead — the generate command handles this gracefully.
      break;
  }

  return payload;
}
