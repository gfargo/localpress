/**
 * REST API adapter for WordPress.
 *
 * Always-available baseline. Authenticates with Application Passwords and
 * talks to /wp-json/wp/v2/* endpoints.
 *
 * Stub implementation — to be filled in during v0.1 implementation.
 * See docs/v1-plan.md §4 "Backend adapters" for the contract.
 */

import type { SiteConfig } from '../types.ts';
import type {
  Capability,
  ListFilters,
  MediaItem,
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

  constructor(private readonly site: SiteConfig) {
    // Stub-phase noop reference. Real usage (auth, request signing) lands in v0.1.
    void this.site;
  }

  // Discovery -----------------------------------------------------------------

  async listMedia(_filters: ListFilters): Promise<MediaItem[]> {
    // TODO(v0.1): GET /wp-json/wp/v2/media with filter mapping.
    //   - WP REST uses ?per_page, ?page, ?after, ?media_type
    //   - Filter `unoptimized` is a localpress concept; cross-reference with
    //     our SQLite state.
    throw new Error('RestAdapter.listMedia not yet implemented');
  }

  async getMedia(_id: number): Promise<MediaItem> {
    // TODO(v0.1): GET /wp-json/wp/v2/media/<id>
    throw new Error('RestAdapter.getMedia not yet implemented');
  }

  // Mutation ------------------------------------------------------------------

  async upload(_file: Buffer, _metadata: UploadMetadata): Promise<MediaItem> {
    // TODO(v0.1): POST /wp-json/wp/v2/media (multipart) with Content-Disposition.
    throw new Error('RestAdapter.upload not yet implemented');
  }

  async replaceInPlace(id: number, _file: Buffer): Promise<MediaItem> {
    // The REST API genuinely cannot replace attachment file bytes in place.
    // Callers should catch CapabilityUnavailableError and fall back to either
    // (a) the WpCliAdapter or (b) upload-as-new-attachment with reference rewriting.
    throw new CapabilityUnavailableError(
      'replace-in-place',
      'rest',
      `True in-place replacement of attachment ${id} requires WP-CLI over SSH or the Enable Media Replace plugin. Falling back to new-attachment upload — pass --strict to fail loudly instead.`,
    );
  }

  async updateMetadata(_id: number, _metadata: UpdateMetadata): Promise<void> {
    // TODO(v0.1): POST /wp-json/wp/v2/media/<id> with title, alt_text, caption, description.
    throw new Error('RestAdapter.updateMetadata not yet implemented');
  }

  async delete(_id: number, _options?: { force?: boolean }): Promise<void> {
    // TODO(v0.1): DELETE /wp-json/wp/v2/media/<id> (?force=true to skip trash)
    throw new Error('RestAdapter.delete not yet implemented');
  }

  // Server-side ops -----------------------------------------------------------

  async regenerateThumbnails(_id: number): Promise<void> {
    throw new CapabilityUnavailableError('regenerate-thumbnails', 'rest');
  }

  async pruneOrphans(): Promise<PruneResult> {
    throw new CapabilityUnavailableError('prune-orphans', 'rest');
  }

  // Reference finding ---------------------------------------------------------

  async findReferences(_id: number, scope: ReferenceScope): Promise<Reference[]> {
    if (scope === 'full') {
      throw new CapabilityUnavailableError(
        'full-references',
        'rest',
        'Full reference scanning (content URLs + post meta) requires the WP-CLI adapter. The REST adapter can only do fast scans (featured images + Gutenberg block IDs).',
      );
    }
    // TODO(v0.1): Fast scan implementation.
    //   1. GET /wp-json/wp/v2/posts?meta_key=_thumbnail_id&meta_value=<id>
    //      → featured-image references
    //   2. Paginate /wp-json/wp/v2/posts and grep .content.raw for
    //      `wp:image {"id":<id>}` → gutenberg-block references
    //   3. Same for /wp-json/wp/v2/pages
    throw new Error('RestAdapter.findReferences (fast) not yet implemented');
  }
}
