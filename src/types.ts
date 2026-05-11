/**
 * Shared types for localpress.
 *
 * Cross-cutting types that don't belong in any single subsystem.
 * Adapter-specific types live in src/adapters/types.ts.
 * Engine-specific types live in src/engine/{image,state}/types.ts.
 */

/**
 * A configured WordPress site that localpress knows about.
 * Persisted in the user's config file under `sites/<name>`.
 */
export interface SiteConfig {
  /** User-chosen name for this site (e.g. "production", "client-acme"). */
  name: string;
  /** Site URL, normalized to scheme + host (no trailing slash). */
  url: string;
  /** WordPress username (the one the App Password belongs to). */
  username: string;
  /** WordPress Application Password. Stored at rest in the config file. */
  appPassword: string;
  /** Optional SSH config for the WP-CLI adapter. */
  ssh?: SshConfig;
  /** ISO timestamp when this site was added. */
  createdAt: string;
}

export interface SshConfig {
  /** SSH hostname or IP address. */
  host: string;
  /** SSH username on the remote server. */
  user: string;
  /** Optional SSH port (default 22). */
  port?: number;
  /** Absolute path to the WordPress installation directory on the remote host. */
  wpPath: string;
  /** Optional path to the SSH private key (default: use ssh-agent / ~/.ssh/id_rsa). */
  identityFile?: string;
}

/**
 * A named optimization profile — reusable processing presets.
 * Stored in config and applied via `localpress optimize --profile <name>`.
 */
export interface OptimizationProfile {
  /** Human-readable description of what this profile does. */
  description?: string;
  /** Target quality (1–100). */
  quality?: number;
  /** Target output format. */
  format?: 'webp' | 'avif' | 'jpeg' | 'png';
  /** Max width in pixels (preserves aspect ratio). */
  maxWidth?: number;
  /** Max height in pixels (preserves aspect ratio). */
  maxHeight?: number;
  /** Encoding backend to use. */
  encoder?: 'sharp' | 'jsquash';
  /** Strip all metadata (EXIF, ICC, etc.). */
  stripMetadata?: boolean;
}

/**
 * Top-level config file shape.
 * Lives at $XDG_CONFIG_HOME/localpress/config.json (or ~/.config/localpress/config.json).
 */
export interface Config {
  /** Schema version for future migrations. */
  version: 1;
  /** Active site name — the one used when --site isn't passed. */
  activeSite?: string;
  /** All configured sites, keyed by name. */
  sites: Record<string, SiteConfig>;
  /** Named optimization profiles, keyed by profile name. */
  profiles?: Record<string, OptimizationProfile>;
  /** Global defaults applied to all sites unless overridden. */
  defaults?: {
    /** Default quality for lossy formats (1–100). */
    quality?: number;
    /** Default output format. */
    format?: 'webp' | 'avif' | 'jpeg' | 'png';
    /** Default concurrency for bulk ops. */
    concurrency?: number;
  };
  /** Time-machine / undo retention settings. */
  history?: {
    /** Disable snapshotting entirely (default: enabled). */
    enabled?: boolean;
    /** Auto-prune when total snapshot storage exceeds this many bytes. Default: 2 GiB. */
    maxSizeBytes?: number;
  };
}

/**
 * Standard exit codes used throughout the CLI.
 * Keep these stable — they're part of the public interface
 * (scripts and skills depend on them).
 */
export const ExitCode = {
  Success: 0,
  GenericError: 1,
  InvalidUsage: 2,
  ConfigError: 3,
  NetworkError: 4,
  AuthError: 5,
  CapabilityUnavailable: 6,
  NotImplemented: 99,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
