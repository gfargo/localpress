/**
 * Capability resolver.
 *
 * Given a site and a required capability, picks the best available adapter.
 * The hierarchy: WP-CLI (when SSH is configured) > REST (always-available baseline).
 * MCP adapter is deferred to v1.x.
 *
 * The resolver also exposes a "doctor" view that reports which adapters and
 * capabilities are available for a site — used by the `localpress doctor`
 * command and by the init wizard.
 */

import type { SiteConfig } from '../types.ts';
import { RestAdapter } from './rest.ts';
import type { Capability, WpBackend } from './types.ts';
import { WpCliAdapter, isWpCliAvailableForSite } from './wp-cli.ts';

export interface AdapterAvailability {
  rest: boolean;
  wpCli: boolean;
  mcp: boolean;
}

export interface CapabilityReport {
  capability: Capability;
  /** The adapter that would handle this capability if requested now, if any. */
  preferredAdapter: WpBackend['name'] | null;
  /** All adapters that can handle this capability. */
  availableOn: WpBackend['name'][];
}

/** Preference order for adapters when multiple support a capability. */
const ADAPTER_PRIORITY: WpBackend['name'][] = ['wp-cli', 'rest'];

/**
 * Capabilities where REST is preferred over WP-CLI even when both are available.
 * REST is a single HTTP request; WP-CLI over SSH has per-item round-trip overhead
 * that makes read-heavy operations painfully slow.
 */
const REST_PREFERRED: ReadonlySet<Capability> = new Set<Capability>([
  'list',
  'get',
  'upload',
  'update-meta',
  'delete',
  'fast-references',
]);

const ALL_CAPABILITIES: Capability[] = [
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
];

export class AdapterResolver {
  private readonly adapters: WpBackend[];

  constructor(site: SiteConfig) {
    this.adapters = [];

    if (isWpCliAvailableForSite(site)) {
      this.adapters.push(new WpCliAdapter(site));
    }

    // REST adapter is always available — App Password auth is universal.
    this.adapters.push(new RestAdapter(site));
  }

  /**
   * Pick the highest-priority adapter that supports the given capability.
   * Throws if no adapter supports it.
   */
  resolve(capability: Capability): WpBackend {
    const priority = REST_PREFERRED.has(capability)
      ? (['rest', 'wp-cli'] as const)
      : ADAPTER_PRIORITY;

    for (const name of priority) {
      const adapter = this.adapters.find((a) => a.name === name);
      if (adapter?.capabilities.has(capability)) {
        return adapter;
      }
    }
    throw new Error(`No adapter available for capability '${capability}' on this site.`);
  }

  /** Same as resolve(), but returns null instead of throwing. */
  tryResolve(capability: Capability): WpBackend | null {
    const priority = REST_PREFERRED.has(capability)
      ? (['rest', 'wp-cli'] as const)
      : ADAPTER_PRIORITY;

    for (const name of priority) {
      const adapter = this.adapters.find((a) => a.name === name);
      if (adapter?.capabilities.has(capability)) {
        return adapter;
      }
    }
    return null;
  }

  /** Get a specific adapter by name (for direct use, bypassing resolution). */
  getAdapter(name: WpBackend['name']): WpBackend | null {
    return this.adapters.find((a) => a.name === name) ?? null;
  }

  /** Snapshot of which adapters are configured for this site. */
  availability(): AdapterAvailability {
    return {
      rest: this.adapters.some((a) => a.name === 'rest'),
      wpCli: this.adapters.some((a) => a.name === 'wp-cli'),
      mcp: this.adapters.some((a) => a.name === 'mcp'),
    };
  }

  /** Per-capability report for `localpress doctor`. */
  capabilityReport(): CapabilityReport[] {
    return ALL_CAPABILITIES.map((capability) => {
      const availableOn = this.adapters
        .filter((a) => a.capabilities.has(capability))
        .map((a) => a.name);
      const preferredAdapter = this.tryResolve(capability)?.name ?? null;
      return { capability, preferredAdapter, availableOn };
    });
  }
}
