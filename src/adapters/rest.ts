/**
 * REST API adapter for WordPress.
 *
 * Always-available baseline. Authenticates with Application Passwords and
 * talks to /wp-json/wp/v2/* endpoints.
 *
 * See docs/v1-plan.md §4 "Backend adapters" for the contract.
 */

import type { SiteConfig } from '../types.ts';
import type {
  Capability,
  ListFilters,
  MediaItem,
  MediaSize,
  PruneResult,
  Reference,
  ReferenceScope,
  UpdateMetadata,
  UploadMetadata,
  WpBackend,
} from './types.ts';
import { CapabilityUnavailableError } from './types.ts';

/**
 * Capabilities supported by the REST adapter. Notably absent:
 *   - replace-in-place        (REST cannot replace file bytes of an attachment)
 *   - regenerate-thumbnails   (no REST endpoint for this)
 *   - prune-orphans           (no REST way to scan the filesystem)
 *   - full-references         (post-meta scanning needs REST-exposed meta keys
 *                              we can't assume; full content scans are slow)
 */
const REST_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'list',
  'get',
  'upload',
  'update-meta',
  'delete',
  'fast-references',
]);

export class RestAdapter implements WpBackend {
  readonly name = 'rest' as const;
  readonly capabilities = REST_CAPABILITIES;

  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(site: SiteConfig) {
    // Normalize: strip trailing slash from URL.
    this.baseUrl = site.url.replace(/\/+$/, '');

    // HTTP Basic auth with Application Password.
    const credentials = `${site.username}:${site.appPassword}`;
    this.authHeader = `Basic ${btoa(credentials)}`;
  }

  // -- Internal HTTP helpers --------------------------------------------------

  private apiUrl(path: string, params?: Record<string, string | number>): string {
    const url = new URL(`${this.baseUrl}/wp-json/wp/v2${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    const { data } = await this.requestRaw<T>(url, init);
    return data;
  }

  private async requestRaw<T>(
    url: string,
    init?: RequestInit,
  ): Promise<{ data: T; headers: Headers }> {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        ...init?.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let wpMessage = '';
      try {
        const parsed = JSON.parse(body) as { message?: string; code?: string };
        wpMessage = parsed.message ?? parsed.code ?? '';
      } catch {
        wpMessage = body.slice(0, 200);
      }
      throw new Error(
        `WordPress REST API error: ${response.status} ${response.statusText}${wpMessage ? ` — ${wpMessage}` : ''} (${init?.method ?? 'GET'} ${url})`,
      );
    }

    const text = await response.text();
    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch {
      throw new Error(
        `WordPress REST API: expected JSON but got ${response.status} ${response.headers.get('content-type') ?? 'unknown content-type'} (${init?.method ?? 'GET'} ${response.url})\nBody: ${text.slice(0, 500)}`,
      );
    }
    return { data, headers: response.headers };
  }

  // Discovery -----------------------------------------------------------------

  async listMedia(filters: ListFilters): Promise<MediaItem[]> {
    const params: Record<string, string | number> = {
      per_page: filters.perPage ?? 20,
      page: filters.page ?? 1,
      ...restSortParams(filters),
    };

    applyCommonFilters(params, filters);
    const raw = await this.request<WpMediaResponse[]>(this.apiUrl('/media', params));
    const items = raw.map(mapWpMediaToItem);
    return applySizeSort(items, filters);
  }

  async listMediaPage(filters: ListFilters): Promise<import('./types.ts').PagedResult<MediaItem>> {
    const params: Record<string, string | number> = {
      per_page: Math.min(filters.perPage ?? 50, 100),
      page: filters.page ?? 1,
      ...restSortParams(filters),
    };

    applyCommonFilters(params, filters);
    const { data, headers } = await this.requestRaw<WpMediaResponse[]>(
      this.apiUrl('/media', params),
    );
    const total = Number.parseInt(headers.get('X-WP-Total') ?? '0', 10);
    const totalPages = Number.parseInt(headers.get('X-WP-TotalPages') ?? '1', 10);
    const items = applySizeSort(data.map(mapWpMediaToItem), filters);
    return { items, total, totalPages };
  }

  async getMedia(id: number): Promise<MediaItem> {
    // Request context=edit so title/caption/description come back as `.raw`
    // (unrendered). Read-modify-write flows (tag/vision) must not round-trip
    // through stripped, entity-encoded rendered HTML, which flattens captions.
    const raw = await this.request<WpMediaResponse>(
      this.apiUrl(`/media/${id}`, { context: 'edit' }),
    );
    return mapWpMediaToItem(raw);
  }

  // Mutation ------------------------------------------------------------------

  async upload(file: Buffer, metadata: UploadMetadata): Promise<MediaItem> {
    const formData = new FormData();
    // Strip characters that break the multipart Content-Disposition header
    // (double-quotes are the most common offender in WP filenames).
    const safeFilename = metadata.filename.replace(/"/g, '').replace(/\\/g, '-');
    formData.append('file', new Blob([file]), safeFilename);

    if (metadata.title) formData.append('title', metadata.title);
    if (metadata.altText) formData.append('alt_text', metadata.altText);
    if (metadata.caption) formData.append('caption', metadata.caption);
    if (metadata.description) formData.append('description', metadata.description);
    if (metadata.postId) formData.append('post', String(metadata.postId));

    const raw = await this.request<WpMediaResponse>(this.apiUrl('/media'), {
      method: 'POST',
      body: formData,
    });

    return mapWpMediaToItem(raw);
  }

  async replaceInPlace(
    id: number,
    _file: Buffer,
    _options?: import('./types.ts').ReplaceOptions,
  ): Promise<MediaItem> {
    // The REST API genuinely cannot replace attachment file bytes in place.
    throw new CapabilityUnavailableError(
      'replace-in-place',
      'rest',
      `True in-place replacement of attachment ${id} requires WP-CLI over SSH or the Enable Media Replace plugin. Falling back to new-attachment upload — pass --strict to fail loudly instead.`,
    );
  }

  async updateMetadata(id: number, metadata: UpdateMetadata): Promise<void> {
    const body: Record<string, string> = {};
    if (metadata.title !== undefined) body.title = metadata.title;
    if (metadata.altText !== undefined) body.alt_text = metadata.altText;
    if (metadata.caption !== undefined) body.caption = metadata.caption;
    if (metadata.description !== undefined) body.description = metadata.description;
    if (metadata.slug !== undefined) body.slug = metadata.slug;

    await this.request<WpMediaResponse>(this.apiUrl(`/media/${id}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async delete(id: number, options?: { force?: boolean }): Promise<void> {
    const params: Record<string, string | number> = {};
    if (options?.force) {
      params.force = 'true';
    }
    try {
      await this.request<unknown>(this.apiUrl(`/media/${id}`, params), {
        method: 'DELETE',
      });
    } catch (err) {
      // Stock WordPress can't trash attachments unless MEDIA_TRASH is defined,
      // so a non-force delete returns 501 rest_trash_not_supported. Translate
      // that into actionable guidance instead of an opaque REST error.
      const message = err instanceof Error ? err.message : String(err);
      if (!options?.force && /rest_trash_not_supported|\b501\b/.test(message)) {
        throw new Error(
          `Attachment ${id} cannot be moved to trash: this WordPress site does not have MEDIA_TRASH enabled. Re-run with --force to delete it permanently (localpress captures an undo snapshot first).`,
        );
      }
      throw err;
    }
  }

  // Server-side ops -----------------------------------------------------------

  async regenerateThumbnails(_id: number): Promise<void> {
    throw new CapabilityUnavailableError('regenerate-thumbnails', 'rest');
  }

  async pruneOrphans(): Promise<PruneResult> {
    throw new CapabilityUnavailableError('prune-orphans', 'rest');
  }

  // Reference finding ---------------------------------------------------------

  async findReferences(id: number, scope: ReferenceScope): Promise<Reference[]> {
    if (scope === 'full') {
      throw new CapabilityUnavailableError(
        'full-references',
        'rest',
        'Full reference scanning (content URLs + post meta) requires the WP-CLI adapter. The REST adapter can only do fast scans (featured images + Gutenberg block IDs).',
      );
    }

    const references: Reference[] = [];

    // 1. Featured images: find posts where _thumbnail_id = this attachment.
    //    WP REST doesn't support meta_key/meta_value filtering directly,
    //    so we use the featured_media field instead.
    for (const postType of ['posts', 'pages'] as const) {
      const posts = await this.paginateAll<WpPostResponse>(
        this.apiUrl(`/${postType}`, {
          per_page: 100,
          _fields: 'id,title,type,featured_media',
        }),
      );

      for (const post of posts) {
        if (post.featured_media === id) {
          references.push({
            type: 'featured-image',
            postId: post.id,
            postTitle: renderTitle(post.title),
            postType: post.type,
          });
        }
      }
    }

    // 2. Gutenberg block references: search content for wp:image {"id":N}.
    //    The `wp:image` block marker lives in the RAW block comment, which is
    //    stripped from rendered HTML — so we must request context=edit to get
    //    content.raw. Without it, embedded images are never found.
    for (const postType of ['posts', 'pages'] as const) {
      const posts = await this.paginateAll<WpPostResponse>(
        this.apiUrl(`/${postType}`, {
          per_page: 100,
          context: 'edit',
          _fields: 'id,title,type,content',
        }),
      );

      for (const post of posts) {
        const occurrences = countPostImageReferences(post, id);
        if (occurrences > 0) {
          references.push({
            type: 'gutenberg-block',
            postId: post.id,
            postTitle: renderTitle(post.title),
            postType: post.type,
            occurrences,
          });
        }
      }
    }

    return references;
  }

  /**
   * Paginate through all pages of a WP REST collection endpoint.
   * Follows the X-WP-TotalPages header.
   */
  private async paginateAll<T>(firstPageUrl: string): Promise<T[]> {
    const results: T[] = [];
    const url: string | null = firstPageUrl;
    let page = 1;

    while (url) {
      const pageUrl = new URL(url);
      pageUrl.searchParams.set('page', String(page));

      const response = await fetch(pageUrl.toString(), {
        headers: { Authorization: this.authHeader },
      });

      if (!response.ok) {
        // If we get a 400 on page > 1, we've gone past the last page.
        if (page > 1 && response.status === 400) break;
        const body = await response.text().catch(() => '');
        throw new Error(`WordPress REST API error: ${response.status} — ${body.slice(0, 200)}`);
      }

      const items = (await response.json()) as T[];
      results.push(...items);

      const totalPages = Number(response.headers.get('X-WP-TotalPages') ?? '1');
      if (page >= totalPages) break;
      page++;
    }

    return results;
  }
}

// -- WP REST API response types -----------------------------------------------

interface WpMediaResponse {
  id: number;
  title: { rendered: string; raw?: string };
  source_url: string;
  mime_type: string;
  media_details?: {
    width?: number;
    height?: number;
    file?: string;
    filesize?: number;
    sizes?: Record<
      string,
      {
        width: number;
        height: number;
        source_url: string;
        file: string;
        filesize?: number;
      }
    >;
  };
  alt_text?: string;
  caption?: { rendered: string; raw?: string };
  description?: { rendered: string; raw?: string };
  date: string;
  slug: string;
}

interface WpPostResponse {
  id: number;
  title: { rendered: string; raw?: string };
  type: string;
  featured_media?: number;
  content?: { rendered: string; raw?: string };
}

// -- Sort / filter helpers ----------------------------------------------------

function restSortParams(filters: ListFilters): Record<string, string> {
  const wpOrderby: Record<string, string> = {
    date: 'date',
    name: 'title',
    id: 'id',
    // 'size' has no server-side equivalent — handled client-side
  };
  const sortBy = filters.sortBy ?? 'date';
  return {
    orderby: wpOrderby[sortBy] ?? 'date',
    order: filters.sortOrder ?? 'desc',
  };
}

function applyCommonFilters(params: Record<string, string | number>, filters: ListFilters): void {
  if (filters.type) {
    params.media_type = filters.type.startsWith('image') ? 'image' : filters.type;
  }
  if (filters.postId) {
    params.parent = filters.postId;
  }
  if (filters.since) {
    params.after = filters.since;
  }
  if (filters.search) {
    params.search = filters.search;
  }
}

function applySizeSort(items: MediaItem[], filters: ListFilters): MediaItem[] {
  if (filters.sortBy !== 'size') return items;
  const dir = filters.sortOrder === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => dir * ((a.sizeBytes ?? 0) - (b.sizeBytes ?? 0)));
}

// -- Mapping helpers ----------------------------------------------------------

function mapWpMediaToItem(raw: WpMediaResponse): MediaItem {
  const sizes: Record<string, MediaSize> = {};
  if (raw.media_details?.sizes) {
    for (const [key, s] of Object.entries(raw.media_details.sizes)) {
      sizes[key] = {
        width: s.width,
        height: s.height,
        url: s.source_url,
        filename: s.file,
        sizeBytes: s.filesize,
      };
    }
  }

  return {
    id: raw.id,
    title: raw.title.raw ?? raw.title.rendered,
    filename: raw.media_details?.file ?? raw.slug,
    slug: raw.slug,
    url: raw.source_url,
    mimeType: raw.mime_type,
    width: raw.media_details?.width,
    height: raw.media_details?.height,
    sizeBytes: raw.media_details?.filesize,
    altText: raw.alt_text,
    caption: raw.caption?.raw ?? stripHtml(raw.caption?.rendered),
    description: raw.description?.raw ?? stripHtml(raw.description?.rendered),
    uploadedAt: raw.date,
    sizes: Object.keys(sizes).length > 0 ? sizes : undefined,
  };
}

function renderTitle(title: { rendered: string; raw?: string }): string {
  return title.raw ?? stripHtml(title.rendered) ?? '';
}

/** Minimal HTML tag stripping for rendered WP fields. */
function stripHtml(html: string | undefined): string | undefined {
  if (!html) return undefined;
  return html.replace(/<[^>]*>/g, '').trim() || undefined;
}

/**
 * Count how many times a post references a specific attachment ID via a
 * Gutenberg block.
 *
 * Prefers the raw block content (`content.raw`, available with context=edit),
 * where blocks carry an explicit `"id":N` attribute. Falls back to the rendered
 * HTML's `wp-image-<id>` class when raw content isn't available (e.g. the auth
 * user lacks edit rights), so embeds are still detected.
 */
function countPostImageReferences(post: WpPostResponse, attachmentId: number): number {
  const raw = post.content?.raw;
  if (raw) return countBlockReferences(raw, attachmentId);
  return countRenderedImageReferences(post.content?.rendered ?? '', attachmentId);
}

/**
 * Count occurrences of a Gutenberg block referencing a specific attachment ID
 * in RAW block content. Matches patterns like: wp:image {"id":123 or "id": 123
 */
function countBlockReferences(content: string, attachmentId: number): number {
  // Match wp:image/gallery/cover/media-text blocks that reference this ID.
  const pattern = new RegExp(
    `wp:(?:image|gallery|cover|media-text)[^}]*"id"\\s*:\\s*${attachmentId}\\b`,
    'g',
  );
  const matches = content.match(pattern);
  return matches?.length ?? 0;
}

/**
 * Fallback for rendered HTML: WordPress emits `class="... wp-image-<id> ..."`
 * on `<img>` tags produced from image blocks.
 */
function countRenderedImageReferences(html: string, attachmentId: number): number {
  const pattern = new RegExp(`wp-image-${attachmentId}\\b`, 'g');
  const matches = html.match(pattern);
  return matches?.length ?? 0;
}
