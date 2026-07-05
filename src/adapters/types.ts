/**
 * Backend adapter types.
 *
 * The CLI talks to WordPress through a WpBackend. Three implementations exist:
 *
 *   - RestAdapter   — always available; uses WP REST API + Application Passwords.
 *   - WpCliAdapter  — opt-in via SSH config; shells out to `wp` on the remote.
 *   - McpAdapter    — opt-in for users with a WP MCP server connected. Deferred to v1.x.
 *
 * Capability resolution: each adapter declares which capabilities it supports.
 * The CLI's resolver picks the best adapter per operation. See docs/v1-plan.md
 * §4 "Backend adapters" for the resolution rules.
 */

/**
 * The set of operations a WpBackend may support. Each adapter declares its own
 * subset; the resolver matches operation requirements against available capabilities.
 */
export type Capability =
  | 'list'
  | 'get'
  | 'upload'
  | 'update-meta'
  | 'delete'
  | 'replace-in-place'
  | 'regenerate-thumbnails'
  | 'prune-orphans'
  | 'fast-references' // featured images + Gutenberg block IDs (REST-cheap)
  | 'full-references' // content URL parsing + post meta scanning (WP-CLI-fast)
  | 'find-unattached'; // post_parent=0 attachments with zero references anywhere (WP-CLI only)

/**
 * A media library item, normalized across backends.
 * Maps roughly to WordPress's attachment post type.
 */
export interface MediaItem {
  id: number;
  title: string;
  filename: string;
  url: string;
  mimeType: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  altText?: string;
  caption?: string;
  description?: string;
  uploadedAt: string;
  /** WordPress's auto-generated thumbnail/medium/large variants. */
  sizes?: Record<string, MediaSize>;
}

export interface MediaSize {
  width: number;
  height: number;
  url: string;
  filename: string;
  sizeBytes?: number;
}

export type SortField = 'date' | 'name' | 'size' | 'id';
export type SortOrder = 'asc' | 'desc';

export interface ListFilters {
  /** Only items not yet processed by localpress. */
  unoptimized?: boolean;
  /** MIME type prefix filter ("image/", "image/jpeg", etc.). */
  type?: string;
  /** Filter to attachments associated with a specific post. */
  postId?: number;
  /** ISO date — only items uploaded since this date. */
  since?: string;
  /** Bytes — only items larger than this. */
  largerThan?: number;
  /** Free-text search across filename and title. Maps to WP REST `?search=` natively. */
  search?: string;
  /** Sort field. 'size' is applied client-side; others pass to the REST API. */
  sortBy?: SortField;
  /** Sort direction. */
  sortOrder?: SortOrder;
  /** Pagination. */
  page?: number;
  perPage?: number;
}

export interface UploadMetadata {
  filename: string;
  title?: string;
  altText?: string;
  caption?: string;
  description?: string;
  /** Optional post to attach the upload to. */
  postId?: number;
}

export interface UpdateMetadata {
  title?: string;
  altText?: string;
  caption?: string;
  description?: string;
  /** WP slug / post_name — affects the attachment permalink. Does NOT rename the underlying file. */
  slug?: string;
}

/** Options for replace-in-place operations. */
export interface ReplaceOptions {
  /** Regenerate WordPress thumbnails after replacing. Default: false. */
  regenerateThumbnails?: boolean;
  /** New MIME type if the format changed (e.g. image/png → image/webp). */
  newMimeType?: string;
  /** New filename extension if the format changed (e.g. '.webp'). */
  newExtension?: string;
}

/** Result of a `pruneOrphans` operation. */
export interface PruneResult {
  /** Files in the uploads dir not registered as attachments. */
  orphanFiles: string[];
  /** Attachments registered in the DB whose underlying file is missing. */
  missingFiles: number[];
  /** Bytes that would be freed if orphans were deleted. */
  reclaimableBytes: number;
}

/** A reference to an attachment found somewhere in WP content. */
export interface Reference {
  /** Where the reference was found. */
  type: 'featured-image' | 'gutenberg-block' | 'content-url' | 'content-srcset' | 'post-meta';
  /** Post or page ID containing the reference. */
  postId: number;
  /** Post title for display. */
  postTitle: string;
  /** Post type ("post", "page", custom). */
  postType: string;
  /** Number of occurrences if applicable. */
  occurrences?: number;
  /** For meta references, the meta key. */
  metaKey?: string;
}

export type ReferenceScope = 'fast' | 'full';

export interface PagedResult<T> {
  items: T[];
  total: number;
  totalPages: number;
}

/**
 * Backend interface. All adapters implement this; not all methods are supported
 * by every adapter — those that aren't throw `CapabilityUnavailableError`.
 */
export interface WpBackend {
  readonly name: 'rest' | 'wp-cli' | 'mcp';
  readonly capabilities: ReadonlySet<Capability>;

  // Discovery
  listMedia(filters: ListFilters): Promise<MediaItem[]>;
  listMediaPage(filters: ListFilters): Promise<PagedResult<MediaItem>>;
  getMedia(id: number): Promise<MediaItem>;

  // Mutation
  upload(file: Buffer, metadata: UploadMetadata): Promise<MediaItem>;
  /** Replace the file bytes of an existing attachment, preserving its ID. */
  replaceInPlace(id: number, file: Buffer, options?: ReplaceOptions): Promise<MediaItem>;
  updateMetadata(id: number, metadata: UpdateMetadata): Promise<void>;
  delete(id: number, options?: { force?: boolean }): Promise<void>;

  // Server-side ops (WP-CLI typically)
  regenerateThumbnails(id: number): Promise<void>;
  pruneOrphans(): Promise<PruneResult>;

  // Reference finding
  findReferences(id: number, scope: ReferenceScope): Promise<Reference[]>;
  /** Attachments with post_parent=0 and zero references anywhere (WP-CLI only). */
  findUnattached(): Promise<number[]>;
}

/**
 * Thrown when an adapter is asked to do something it doesn't support.
 * Code paths that require `replace-in-place` should catch this and either
 * fall back gracefully or surface a clear error to the user.
 */
export class CapabilityUnavailableError extends Error {
  constructor(
    public readonly capability: Capability,
    public readonly adapter: WpBackend['name'],
    message?: string,
  ) {
    super(message ?? `Capability '${capability}' is not available on the ${adapter} adapter`);
    this.name = 'CapabilityUnavailableError';
  }
}
