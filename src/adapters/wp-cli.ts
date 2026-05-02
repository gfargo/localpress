/**
 * WP-CLI adapter for WordPress.
 *
 * Opt-in via SSH config per site. Shells out to `wp` on the remote host for
 * operations that REST can't perform: true in-place file replacement,
 * thumbnail regeneration, orphan pruning, full content scans.
 *
 * Lands in v0.5. Stubbed in v0.1 so the resolver can be written and tested
 * against the real interface.
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

const WP_CLI_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'list',
  'get',
  'upload',
  'update-meta',
  'delete',
  'replace-in-place',
  'regenerate-thumbnails',
  'prune-orphans',
  'fast-references',
  'full-references',
]);

export class WpCliAdapter implements WpBackend {
  readonly name = 'wp-cli' as const;
  readonly capabilities = WP_CLI_CAPABILITIES;

  constructor(private readonly site: SiteConfig) {
    if (!site.ssh) {
      throw new Error(`WpCliAdapter requires SSH config for site '${site.name}'`);
    }
    // Stub-phase noop reference. Real usage (SSH command construction) lands in v0.5.
    void this.site;
  }

  async listMedia(_filters: ListFilters): Promise<MediaItem[]> {
    throw new Error('WpCliAdapter.listMedia not yet implemented (v0.5)');
  }

  async getMedia(_id: number): Promise<MediaItem> {
    throw new Error('WpCliAdapter.getMedia not yet implemented (v0.5)');
  }

  async upload(_file: Buffer, _metadata: UploadMetadata): Promise<MediaItem> {
    throw new Error('WpCliAdapter.upload not yet implemented (v0.5)');
  }

  async replaceInPlace(_id: number, _file: Buffer): Promise<MediaItem> {
    // TODO(v0.5): scp the new file to a temp location on the remote, then
    //   ssh user@host "cd /path/to/wp && wp media replace <id> /tmp/<file> --skip-delete"
    throw new Error('WpCliAdapter.replaceInPlace not yet implemented (v0.5)');
  }

  async updateMetadata(_id: number, _metadata: UpdateMetadata): Promise<void> {
    throw new Error('WpCliAdapter.updateMetadata not yet implemented (v0.5)');
  }

  async delete(_id: number, _options?: { force?: boolean }): Promise<void> {
    throw new Error('WpCliAdapter.delete not yet implemented (v0.5)');
  }

  async regenerateThumbnails(_id: number): Promise<void> {
    // TODO(v0.5): wp media regenerate <id> --yes
    throw new Error('WpCliAdapter.regenerateThumbnails not yet implemented (v0.5)');
  }

  async pruneOrphans(): Promise<PruneResult> {
    // TODO(v0.5): wp media prune (or custom comparison of uploads dir vs DB)
    throw new Error('WpCliAdapter.pruneOrphans not yet implemented (v0.5)');
  }

  async findReferences(_id: number, _scope: ReferenceScope): Promise<Reference[]> {
    // TODO(v0.5): Use wp post list + wp search-replace --dry-run for full scan.
    throw new Error('WpCliAdapter.findReferences not yet implemented (v0.5)');
  }
}

// Helper for callers that want to suppress the "not implemented" noise during v0.1.
export function isWpCliAvailableForSite(site: SiteConfig): boolean {
  return Boolean(site.ssh?.host && site.ssh?.wpPath);
}

// Re-export the error class so resolver code only needs one import.
export { CapabilityUnavailableError };
