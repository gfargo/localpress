/**
 * `localpress posts` — WordPress post and page management.
 *
 * Subcommands: list, show, create, update, delete.
 * Talks directly to the WP REST API (/wp-json/wp/v2/posts and /pages).
 */

import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';
import { resolveDryRun } from '../utils/run-mode.ts';

interface WpPost {
  id: number;
  title: { rendered: string; raw?: string };
  status: string;
  type: string;
  date: string;
  modified: string;
  slug: string;
  link: string;
  excerpt?: { rendered: string; raw?: string };
  content?: { rendered: string; raw?: string };
  author: number;
  featured_media: number;
  categories?: number[];
  tags?: number[];
}

interface PostItem {
  id: number;
  title: string;
  status: string;
  type: string;
  date: string;
  modified: string;
  slug: string;
  link: string;
  excerpt?: string;
  author: number;
  featuredMedia: number;
}

interface PostDetail extends PostItem {
  content: string;
  categories: number[];
  tags: number[];
}

function mapPost(raw: WpPost): PostItem {
  return {
    id: raw.id,
    title: raw.title.raw ?? raw.title.rendered.replace(/<[^>]*>/g, ''),
    status: raw.status,
    type: raw.type,
    date: raw.date,
    modified: raw.modified,
    slug: raw.slug,
    link: raw.link,
    excerpt: raw.excerpt?.raw ?? raw.excerpt?.rendered?.replace(/<[^>]*>/g, '').trim(),
    author: raw.author,
    featuredMedia: raw.featured_media,
  };
}

function mapPostDetail(raw: WpPost): PostDetail {
  return {
    ...mapPost(raw),
    content: raw.content?.raw ?? raw.content?.rendered ?? '',
    categories: raw.categories ?? [],
    tags: raw.tags ?? [],
  };
}

export function registerPostsCommand(program: Command): void {
  const posts = program.command('posts').description('Manage WordPress posts and pages');

  /**
   * Map a post type slug to its REST API endpoint path.
   * WordPress exposes custom post types at /wp-json/wp/v2/<slug> when show_in_rest is true.
   * Built-in types: 'post' → '/posts', 'page' → '/pages'.
   * Custom types: 'portfolio' → '/portfolio', 'event' → '/event', etc.
   */
  function typeEndpoint(type: string): string {
    if (type === 'post') return '/posts';
    if (type === 'page') return '/pages';
    return `/${type}`;
  }

  // -- posts list -------------------------------------------------------------
  posts
    .command('list')
    .description('List posts or pages with filters')
    .option('--status <status>', 'filter by status (publish, draft, pending, private, trash)')
    .option(
      '--type <type>',
      'post type slug: post, page, or any custom post type (e.g. portfolio, event)',
      'post',
    )
    .option('--author <id>', 'filter by author ID', (v) => Number.parseInt(v, 10))
    .option('--search <query>', 'search posts by keyword')
    .option('--category <id>', 'filter by category ID', (v) => Number.parseInt(v, 10))
    .option('--per-page <n>', 'results per page (max 100)', (v) => Number.parseInt(v, 10))
    .option('--page <n>', 'page number', (v) => Number.parseInt(v, 10))
    .option('--orderby <field>', 'sort by: date, title, id, modified, slug', 'date')
    .option('--order <dir>', 'sort direction: asc or desc', 'desc')
    .action(async (options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);

      const endpoint = typeEndpoint(options.type);
      const params = new URLSearchParams();
      params.set('per_page', String(Math.min(options.perPage ?? 20, 100)));
      params.set('page', String(options.page ?? 1));
      params.set('orderby', options.orderby);
      params.set('order', options.order);
      if (options.status) params.set('status', options.status);
      if (options.author) params.set('author', String(options.author));
      if (options.search) params.set('search', options.search);
      if (options.category) params.set('categories', String(options.category));

      const url = `${site.url.replace(/\/+$/, '')}/wp-json/wp/v2${endpoint}?${params}`;
      const auth = `Basic ${btoa(`${site.username}:${site.appPassword}`)}`;

      try {
        const res = await fetch(url, { headers: { Authorization: auth } });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          error(`WordPress API error: ${res.status} — ${body.slice(0, 200)}`);
          process.exit(4);
        }

        const total = Number.parseInt(res.headers.get('X-WP-Total') ?? '0', 10);
        const totalPages = Number.parseInt(res.headers.get('X-WP-TotalPages') ?? '1', 10);
        const raw = (await res.json()) as WpPost[];
        const items = raw.map(mapPost);

        if (parentOpts.json) {
          printJson({ items, total, totalPages, page: options.page ?? 1 });
          return;
        }

        if (items.length === 0) {
          info('No posts found matching the given filters.');
          return;
        }

        info(`Showing ${items.length} of ${total} ${options.type}(s):\n`);
        for (const item of items) {
          const status = item.status === 'publish' ? '' : ` [${item.status}]`;
          info(`  #${item.id}  ${item.title}${status}  (${item.date.split('T')[0]})`);
        }

        if ((options.page ?? 1) < totalPages) {
          info(`\nNext page: localpress posts list --page ${(options.page ?? 1) + 1}`);
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(4);
      }
    });

  // -- posts show <id> --------------------------------------------------------
  posts
    .command('show <id>')
    .description('Show full details for a post or page')
    .option('--type <type>', 'post type: post, page, or custom (e.g. portfolio)', 'post')
    .action(async (idStr: string, options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);

      const id = Number.parseInt(idStr, 10);
      if (Number.isNaN(id)) {
        error('ID must be a valid integer.');
        process.exit(2);
      }

      const endpoint = typeEndpoint(options.type);
      const url = `${site.url.replace(/\/+$/, '')}/wp-json/wp/v2${endpoint}/${id}?context=edit`;
      const auth = `Basic ${btoa(`${site.username}:${site.appPassword}`)}`;

      try {
        const res = await fetch(url, { headers: { Authorization: auth } });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          error(`WordPress API error: ${res.status} — ${body.slice(0, 200)}`);
          process.exit(4);
        }

        const raw = (await res.json()) as WpPost;
        const post = mapPostDetail(raw);

        if (parentOpts.json) {
          printJson(post);
          return;
        }

        info(`Post #${post.id}: ${post.title}`);
        info(`  Status: ${post.status}`);
        info(`  Type: ${post.type}`);
        info(`  Date: ${post.date}`);
        info(`  Modified: ${post.modified}`);
        info(`  Slug: ${post.slug}`);
        info(`  Link: ${post.link}`);
        info(`  Author: ${post.author}`);
        info(`  Featured media: ${post.featuredMedia || '(none)'}`);
        if (post.categories.length) info(`  Categories: ${post.categories.join(', ')}`);
        if (post.tags.length) info(`  Tags: ${post.tags.join(', ')}`);
        if (post.excerpt) info(`  Excerpt: ${post.excerpt.slice(0, 200)}...`);
        info(`  Content length: ${post.content.length} chars`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(4);
      }
    });

  // -- posts create -----------------------------------------------------------
  posts
    .command('create')
    .description('Create a new post or page')
    .requiredOption('--title <title>', 'post title')
    .option('--content <html>', 'post content (HTML or Gutenberg blocks)')
    .option('--content-file <path>', 'read content from a file')
    .option('--status <status>', 'post status: draft (default), publish, pending, private', 'draft')
    .option('--type <type>', 'post type: post, page, or custom (e.g. portfolio)', 'post')
    .option('--slug <slug>', 'URL slug')
    .option('--excerpt <text>', 'post excerpt')
    .option('--featured-image <id>', 'featured image attachment ID', (v) => Number.parseInt(v, 10))
    .option('--category <ids>', 'comma-separated category IDs')
    .option('--tag <ids>', 'comma-separated tag IDs')
    .action(async (options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);

      let content = options.content ?? '';
      if (options.contentFile) {
        try {
          content = readFileSync(options.contentFile, 'utf-8');
        } catch (err) {
          error(`Failed to read content file: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(2);
        }
      }

      const endpoint = typeEndpoint(options.type);
      const url = `${site.url.replace(/\/+$/, '')}/wp-json/wp/v2${endpoint}`;
      const auth = `Basic ${btoa(`${site.username}:${site.appPassword}`)}`;

      const body: Record<string, unknown> = {
        title: options.title,
        content,
        status: options.status,
      };
      if (options.slug) body.slug = options.slug;
      if (options.excerpt) body.excerpt = options.excerpt;
      if (options.featuredImage) body.featured_media = options.featuredImage;
      if (options.category) body.categories = options.category.split(',').map(Number);
      if (options.tag) body.tags = options.tag.split(',').map(Number);

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          error(`WordPress API error: ${res.status} — ${errBody.slice(0, 200)}`);
          process.exit(4);
        }

        const raw = (await res.json()) as WpPost;
        const post = mapPost(raw);

        if (parentOpts.json) {
          printJson({ action: 'created', post });
          return;
        }

        info(`✓ Created ${options.type} #${post.id}: "${post.title}" [${post.status}]`);
        info(`  Link: ${post.link}`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(4);
      }
    });

  // -- posts update <id> ------------------------------------------------------
  posts
    .command('update <id>')
    .description('Update an existing post or page')
    .option('--title <title>', 'new title')
    .option('--content <html>', 'new content')
    .option('--content-file <path>', 'read new content from a file')
    .option('--status <status>', 'new status: publish, draft, pending, private, trash')
    .option('--type <type>', 'post type: post, page, or custom (e.g. portfolio)', 'post')
    .option('--slug <slug>', 'new URL slug')
    .option('--excerpt <text>', 'new excerpt')
    .option('--featured-image <id>', 'featured image attachment ID', (v) => Number.parseInt(v, 10))
    .option('--category <ids>', 'comma-separated category IDs')
    .option('--tag <ids>', 'comma-separated tag IDs')
    .action(async (idStr: string, options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);

      const id = Number.parseInt(idStr, 10);
      if (Number.isNaN(id)) {
        error('ID must be a valid integer.');
        process.exit(2);
      }

      let content = options.content;
      if (options.contentFile) {
        try {
          content = readFileSync(options.contentFile, 'utf-8');
        } catch (err) {
          error(`Failed to read content file: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(2);
        }
      }

      const endpoint = typeEndpoint(options.type);
      const url = `${site.url.replace(/\/+$/, '')}/wp-json/wp/v2${endpoint}/${id}`;
      const auth = `Basic ${btoa(`${site.username}:${site.appPassword}`)}`;

      // Use !== undefined so an explicit empty string (e.g. --excerpt "") can
      // clear a field, rather than being silently dropped by a truthiness check.
      const body: Record<string, unknown> = {};
      if (options.title !== undefined) body.title = options.title;
      if (content !== undefined) body.content = content;
      if (options.status !== undefined) body.status = options.status;
      if (options.slug !== undefined) body.slug = options.slug;
      if (options.excerpt !== undefined) body.excerpt = options.excerpt;
      if (options.featuredImage) body.featured_media = options.featuredImage;
      if (options.category) body.categories = options.category.split(',').map(Number);
      if (options.tag) body.tags = options.tag.split(',').map(Number);

      if (Object.keys(body).length === 0) {
        error('At least one field to update is required (--title, --content, --status, etc.).');
        process.exit(2);
      }

      if (resolveDryRun(parentOpts, false)) {
        warn(`[dry-run] would update ${options.type} #${id}: ${Object.keys(body).join(', ')}`);
        if (parentOpts.json) {
          printJson({ dryRun: true, action: 'update', id, fields: body });
        }
        return;
      }

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          error(`WordPress API error: ${res.status} — ${errBody.slice(0, 200)}`);
          process.exit(4);
        }

        const raw = (await res.json()) as WpPost;
        const post = mapPost(raw);

        if (parentOpts.json) {
          printJson({ action: 'updated', post });
          return;
        }

        info(`✓ Updated ${options.type} #${post.id}: "${post.title}" [${post.status}]`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(4);
      }
    });

  // -- posts delete <id> ------------------------------------------------------
  posts
    .command('delete <id>')
    .description('Trash or permanently delete a post/page')
    .option('--type <type>', 'post type: post, page, or custom (e.g. portfolio)', 'post')
    .option('--force', 'permanently delete (skip trash)')
    .action(async (idStr: string, options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);

      const id = Number.parseInt(idStr, 10);
      if (Number.isNaN(id)) {
        error('ID must be a valid integer.');
        process.exit(2);
      }

      if (resolveDryRun(parentOpts, false)) {
        warn(
          `[dry-run] would ${options.force ? 'permanently delete' : 'trash'} ${options.type} #${id}`,
        );
        if (parentOpts.json) {
          printJson({ dryRun: true, action: options.force ? 'delete' : 'trash', id });
        }
        return;
      }

      const endpoint = typeEndpoint(options.type);
      const params = options.force ? '?force=true' : '';
      const url = `${site.url.replace(/\/+$/, '')}/wp-json/wp/v2${endpoint}/${id}${params}`;
      const auth = `Basic ${btoa(`${site.username}:${site.appPassword}`)}`;

      try {
        const res = await fetch(url, {
          method: 'DELETE',
          headers: { Authorization: auth },
        });

        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          error(`WordPress API error: ${res.status} — ${errBody.slice(0, 200)}`);
          process.exit(4);
        }

        if (parentOpts.json) {
          printJson({ action: options.force ? 'deleted' : 'trashed', id });
          return;
        }

        info(`✓ ${options.force ? 'Permanently deleted' : 'Trashed'} ${options.type} #${id}`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(4);
      }
    });
}
