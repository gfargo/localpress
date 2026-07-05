/**
 * WP-CLI adapter for WordPress.
 *
 * Opt-in via SSH config per site. Shells out to `wp` on the remote host for
 * operations that REST can't perform: true in-place file replacement,
 * thumbnail regeneration, orphan pruning, full content scans.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SiteConfig, SshConfig } from '../types.ts';
import { scpUpload, shellQuote, sshExec } from './ssh.ts';
import type {
  Capability,
  FormatChangeRewrite,
  ListFilters,
  MediaItem,
  PruneResult,
  Reference,
  ReferenceScope,
  UpdateMetadata,
  UploadMetadata,
  WpBackend,
} from './types.ts';

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

  private readonly ssh: SshConfig;
  private readonly wpPath: string;

  constructor(site: SiteConfig) {
    if (!site.ssh) {
      throw new Error(`WpCliAdapter requires SSH config for site '${site.name}'`);
    }
    this.ssh = site.ssh;
    this.wpPath = site.ssh.wpPath;
  }

  // -- Internal WP-CLI execution ----------------------------------------------

  private async wp(command: string): Promise<string> {
    const fullCommand = `cd ${this.wpPath} && wp ${command} --allow-root`;
    const result = await sshExec(this.ssh, fullCommand);

    if (result.exitCode !== 0) {
      throw new Error(`WP-CLI error (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
    }

    return result.stdout;
  }

  private async wpJson<T>(command: string): Promise<T> {
    const output = await this.wp(`${command} --format=json`);
    try {
      return JSON.parse(output) as T;
    } catch {
      throw new Error(`Failed to parse WP-CLI JSON output: ${output.slice(0, 200)}`);
    }
  }

  /**
   * Get the WordPress uploads base directory + base URL, cached after first
   * retrieval. Saves an SSH round-trip on subsequent replace-in-place operations.
   */
  private cachedUploadsDir: string | null = null;
  private cachedUploadsBaseUrl: string | null = null;

  private async getUploadsPaths(): Promise<{ basedir: string; baseurl: string }> {
    if (this.cachedUploadsDir !== null && this.cachedUploadsBaseUrl !== null) {
      return { basedir: this.cachedUploadsDir, baseurl: this.cachedUploadsBaseUrl };
    }

    // Try wp eval first; fall back to a conventional path (and empty base URL,
    // which callers must treat as "unknown") if it fails.
    let basedir: string;
    let baseurl: string;
    try {
      const output = await this.wp(`eval 'echo json_encode(wp_upload_dir());'`);
      const parsed = JSON.parse(output) as { basedir?: string; baseurl?: string };
      basedir = parsed.basedir?.trim() || `${this.wpPath}/wp-content/uploads`;
      baseurl = parsed.baseurl?.trim() ?? '';
    } catch {
      basedir = `${this.wpPath}/wp-content/uploads`;
      baseurl = '';
    }

    this.cachedUploadsDir = basedir;
    this.cachedUploadsBaseUrl = baseurl;
    return { basedir, baseurl };
  }

  // Discovery -----------------------------------------------------------------

  async listMedia(filters: ListFilters): Promise<MediaItem[]> {
    const args = ['post list', '--post_type=attachment', '--post_status=inherit'];

    if (filters.type) {
      args.push(`--post_mime_type=${filters.type}`);
    }
    if (filters.postId) {
      args.push(`--post_parent=${filters.postId}`);
    }
    if (filters.search) {
      // WP-CLI passes --s through to WP_Query, which searches post_title +
      // post_content. Shell-escape since this goes through an SSH command.
      args.push(`--s=${JSON.stringify(filters.search)}`);
    }
    if (filters.perPage) {
      args.push(`--posts_per_page=${filters.perPage}`);
    }
    if (filters.page) {
      args.push(`--paged=${filters.page}`);
    }

    args.push('--fields=ID,post_title,post_name,post_mime_type,post_date');

    const posts = await this.wpJson<WpCliPost[]>(args.join(' '));

    // Enrich with attachment metadata.
    const items: MediaItem[] = [];
    for (const post of posts) {
      try {
        const item = await this.getMedia(post.ID);
        items.push(item);
      } catch {
        // If we can't get metadata for one item, skip it.
        items.push({
          id: post.ID,
          title: post.post_title,
          filename: post.post_name,
          url: '',
          mimeType: post.post_mime_type,
          uploadedAt: post.post_date,
        });
      }
    }

    return items;
  }

  async listMediaPage(filters: ListFilters): Promise<import('./types.ts').PagedResult<MediaItem>> {
    const items = await this.listMedia(filters);
    return { items, total: items.length, totalPages: 1 };
  }

  async getMedia(id: number): Promise<MediaItem> {
    const output = await this.wp(
      `post meta get ${id} _wp_attachment_metadata --format=json 2>/dev/null || echo "null"`,
    );

    const postOutput = await this.wp(
      `post get ${id} --fields=ID,post_title,post_name,post_mime_type,post_date,guid --format=json`,
    );
    const post = JSON.parse(postOutput) as WpCliPostDetail;

    let metadata: WpCliAttachmentMeta | null = null;
    try {
      metadata = JSON.parse(output) as WpCliAttachmentMeta;
    } catch {
      // No metadata available.
    }

    const altText = await this.wp(
      `post meta get ${id} _wp_attachment_image_alt 2>/dev/null || echo ""`,
    );

    return {
      id: post.ID,
      title: post.post_title,
      filename: metadata?.file ?? post.post_name,
      url: post.guid,
      mimeType: post.post_mime_type,
      width: metadata?.width,
      height: metadata?.height,
      sizeBytes: metadata?.filesize,
      altText: altText.trim() || undefined,
      uploadedAt: post.post_date,
    };
  }

  // Mutation ------------------------------------------------------------------

  async upload(file: Buffer, metadata: UploadMetadata): Promise<MediaItem> {
    // Write the file to a local temp path, then SCP to remote.
    const localTmp = join(tmpdir(), `localpress-upload-${Date.now()}-${metadata.filename}`);
    await Bun.write(localTmp, file);

    const remoteTmp = `/tmp/localpress-upload-${Date.now()}-${metadata.filename}`;
    const scpResult = await scpUpload(this.ssh, localTmp, remoteTmp);
    if (scpResult.exitCode !== 0) {
      throw new Error(
        `SCP upload failed (exit ${scpResult.exitCode}): ${scpResult.stderr || 'unknown error'}`,
      );
    }

    // Import via WP-CLI.
    const args = [`media import "${remoteTmp}"`, '--porcelain'];
    if (metadata.title) args.push(`--title="${metadata.title}"`);
    if (metadata.altText) args.push(`--alt="${metadata.altText}"`);
    if (metadata.caption) args.push(`--caption="${metadata.caption}"`);
    if (metadata.description) args.push(`--description="${metadata.description}"`);
    if (metadata.postId) args.push(`--post_id=${metadata.postId}`);

    const output = await this.wp(args.join(' '));
    const newId = Number.parseInt(output.trim(), 10);

    if (Number.isNaN(newId)) {
      throw new Error(`WP-CLI media import did not return a valid ID: ${output}`);
    }

    // Clean up remote temp file.
    await sshExec(this.ssh, `rm -f "${remoteTmp}"`).catch(() => {});

    // Clean up local temp file.
    try {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(localTmp);
    } catch {
      // Best effort.
    }

    return this.getMedia(newId);
  }

  async replaceInPlace(
    id: number,
    file: Buffer,
    options?: import('./types.ts').ReplaceOptions,
  ): Promise<MediaItem> {
    // Get the current attachment's file path on the server.
    const currentFile = await this.wp(`post meta get ${id} _wp_attached_file`);
    const oldFilePath = currentFile.trim();
    const { basedir: uploadsDir, baseurl: uploadsBaseUrl } = await this.getUploadsPaths();

    let remotePath = `${uploadsDir}/${oldFilePath}`;

    // If the format changed, we need to rename the file and update WP metadata.
    let newFilePath = oldFilePath;
    if (options?.newExtension) {
      // Change the extension: 2024/12/image.png → 2024/12/image.webp
      newFilePath = oldFilePath.replace(/\.[^.]+$/, options.newExtension);
      remotePath = `${uploadsDir}/${newFilePath}`;
    }
    const isFormatChange = Boolean(options?.newExtension) && newFilePath !== oldFilePath;

    // Write to local temp, SCP to remote, place at the (possibly new) path.
    const localTmp = join(tmpdir(), `localpress-replace-${Date.now()}`);
    await Bun.write(localTmp, file);

    const remoteTmp = `/tmp/localpress-replace-${Date.now()}`;
    const scpResult = await scpUpload(this.ssh, localTmp, remoteTmp);
    if (scpResult.exitCode !== 0) {
      throw new Error(
        `SCP upload failed (exit ${scpResult.exitCode}): ${scpResult.stderr || 'unknown error'}`,
      );
    }

    // Ensure the target directory exists, then move the file into place.
    const targetDir = remotePath.substring(0, remotePath.lastIndexOf('/'));
    const mkdirResult = await sshExec(this.ssh, `mkdir -p "${targetDir}"`);
    if (mkdirResult.exitCode !== 0) {
      throw new Error(
        `Failed to create target directory "${targetDir}": ${mkdirResult.stderr || 'unknown error'}`,
      );
    }

    const mvResult = await sshExec(
      this.ssh,
      `mv "${remoteTmp}" "${remotePath}" && chmod 644 "${remotePath}"`,
    );
    if (mvResult.exitCode !== 0) {
      throw new Error(
        `Failed to place file at "${remotePath}": ${mvResult.stderr || 'unknown error'}`,
      );
    }

    let formatChangeRewrite: FormatChangeRewrite | undefined;

    if (isFormatChange) {
      const oldRemotePath = `${uploadsDir}/${oldFilePath}`;

      // Capture pre-mutation metadata before anything is changed — we need the
      // old `sizes` map both to know which thumbnail files to delete and to
      // diff against the post-regenerate sizes for URL rewriting below.
      let oldMeta: WpCliAttachmentMeta | null = null;
      try {
        const metaJson = await this.wp(`post meta get ${id} _wp_attachment_metadata --format=json`);
        oldMeta = JSON.parse(metaJson) as WpCliAttachmentMeta;
      } catch {
        // No prior metadata available.
      }

      // Update WordPress's record of the file BEFORE deleting the old bytes,
      // so a failure partway through this sequence leaves the attachment
      // pointing at a file that still exists rather than a dangling reference.
      await this.wp(`post meta update ${id} _wp_attached_file "${newFilePath}"`);

      // Update the post MIME type via wp post update (handles quoting correctly).
      if (options?.newMimeType) {
        await sshExec(
          this.ssh,
          `cd ${this.wpPath} && wp post update ${id} --post_mime_type="${options.newMimeType}" --allow-root`,
        );
      }

      // Update attachment metadata: file field, filesize, and clear stale sizes.
      try {
        if (oldMeta?.file) {
          oldMeta.file = newFilePath;
          oldMeta.filesize = file.length;
          // Clear the sizes array — old format thumbnails are now invalid.
          // WordPress will repopulate this on regenerate.
          const updatedMeta = JSON.stringify({ ...oldMeta, sizes: {} }).replace(/'/g, "\\'");
          await this.wp(
            `post meta update ${id} _wp_attachment_metadata '${updatedMeta}' --format=json`,
          );
        }
      } catch {
        // Best effort — metadata update is non-critical.
      }

      // Remove _require_file_renaming flag that WP may have set during the transition.
      await this.wp(`post meta delete ${id} _require_file_renaming`).catch(() => {});

      // Rewrite post-content references to the renamed file so existing embeds
      // don't 404 the moment the extension changes. Best-effort: the file
      // replacement above already succeeded, so a rewrite failure here must
      // not fail the whole operation — only the reference rewrite is at risk.
      let rewrittenUrls = 0;
      let warning: string | undefined;
      if (uploadsBaseUrl) {
        const oldUrl = buildUploadUrl(uploadsBaseUrl, oldFilePath);
        const newUrl = buildUploadUrl(uploadsBaseUrl, newFilePath);
        try {
          const out = await this.wp(
            `search-replace ${shellQuote(oldUrl)} ${shellQuote(newUrl)} --precise`,
          );
          rewrittenUrls += parseSearchReplaceCount(out) ?? 0;
        } catch (err) {
          warning =
            `Reference rewrite failed: ${err instanceof Error ? err.message : String(err)}. ` +
            `Run 'localpress references ${id} --scope full' to check for broken embeds, or ` +
            `manually: wp search-replace ${oldUrl} ${newUrl} --precise`;
        }
      } else {
        warning = `Could not determine the site's uploads base URL — post content referencing the old filename was not rewritten. Run 'localpress references ${id} --scope full' to check for broken embeds.`;
      }

      // Only now delete the old file bytes: WordPress metadata (and, best
      // effort, post content) already point at the new file.
      await sshExec(this.ssh, `rm -f "${oldRemotePath}"`).catch(() => {});
      if (oldMeta?.sizes && typeof oldMeta.sizes === 'object') {
        const dirPath = newFilePath.includes('/')
          ? `${uploadsDir}/${newFilePath.substring(0, newFilePath.lastIndexOf('/'))}`
          : uploadsDir;
        const oldThumbFiles = Object.values(oldMeta.sizes)
          .map((s) => (s as { file?: string })?.file)
          .filter(Boolean) as string[];
        for (const thumbFile of oldThumbFiles) {
          await sshExec(this.ssh, `rm -f "${dirPath}/${thumbFile}"`).catch(() => {});
        }
      }

      // Regenerate thumbnails now — old-format thumbnails are invalid, and we
      // need the fresh `sizes` map below to rewrite size-variant URLs.
      await this.wp(`media regenerate ${id} --yes`);

      if (uploadsBaseUrl && oldMeta?.sizes) {
        try {
          const newMetaJson = await this.wp(
            `post meta get ${id} _wp_attachment_metadata --format=json`,
          );
          const newMeta = JSON.parse(newMetaJson) as WpCliAttachmentMeta;
          const newDir = newFilePath.includes('/')
            ? newFilePath.substring(0, newFilePath.lastIndexOf('/'))
            : '';
          // Only keys present in both old and new metadata: a size that no
          // longer exists post-regenerate (e.g. a theme dropped that
          // registered size) has nothing to rewrite to, so it's skipped —
          // that's an expected "this size is gone" case, not a bug.
          for (const key of Object.keys(oldMeta.sizes)) {
            const newSize = newMeta.sizes?.[key];
            const oldSize = oldMeta.sizes[key];
            if (!newSize?.file || !oldSize?.file) continue;

            const oldSizeUrl = buildUploadUrl(
              uploadsBaseUrl,
              newDir ? `${newDir}/${oldSize.file}` : oldSize.file,
            );
            const newSizeUrl = buildUploadUrl(
              uploadsBaseUrl,
              newDir ? `${newDir}/${newSize.file}` : newSize.file,
            );
            if (oldSizeUrl === newSizeUrl) continue;

            try {
              const out = await this.wp(
                `search-replace ${shellQuote(oldSizeUrl)} ${shellQuote(newSizeUrl)} --precise`,
              );
              rewrittenUrls += parseSearchReplaceCount(out) ?? 0;
            } catch (err) {
              warning =
                warning ??
                `Size-variant reference rewrite failed for '${key}': ${err instanceof Error ? err.message : String(err)}.`;
            }
          }
        } catch {
          // Best effort — size-variant rewriting is a bonus, not required.
        }
      }

      formatChangeRewrite = { rewrittenUrls, warning };
    } else if (options?.regenerateThumbnails) {
      await this.wp(`media regenerate ${id} --yes`);
    }

    // Clean up local temp.
    try {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(localTmp);
    } catch {
      // Best effort.
    }

    const item = await this.getMedia(id);
    return formatChangeRewrite ? { ...item, formatChangeRewrite } : item;
  }

  async updateMetadata(id: number, metadata: UpdateMetadata): Promise<void> {
    if (metadata.title !== undefined) {
      await this.wp(`post update ${id} --post_title="${metadata.title}"`);
    }
    if (metadata.altText !== undefined) {
      await this.wp(`post meta update ${id} _wp_attachment_image_alt "${metadata.altText}"`);
    }
    if (metadata.caption !== undefined) {
      await this.wp(`post update ${id} --post_excerpt="${metadata.caption}"`);
    }
    if (metadata.description !== undefined) {
      await this.wp(`post update ${id} --post_content="${metadata.description}"`);
    }
  }

  async delete(id: number, options?: { force?: boolean }): Promise<void> {
    const forceFlag = options?.force ? '--force' : '';
    await this.wp(`post delete ${id} ${forceFlag}`);
  }

  // Server-side ops -----------------------------------------------------------

  async regenerateThumbnails(id: number): Promise<void> {
    await this.wp(`media regenerate ${id} --yes`);
  }

  async pruneOrphans(): Promise<PruneResult> {
    // Get the uploads directory.
    const uploadsDir = await this.wp(`eval 'echo wp_upload_dir()["basedir"];'`);

    // List all files in uploads.
    const filesOutput = await sshExec(
      this.ssh,
      `find "${uploadsDir.trim()}" -type f -name "*.jpg" -o -name "*.jpeg" -o -name "*.png" -o -name "*.gif" -o -name "*.webp" -o -name "*.avif" | sort`,
    );
    const allFiles = filesOutput.stdout.split('\n').filter(Boolean);

    // List all registered attachment files.
    const attachedOutput = await this.wp(
      `db query "SELECT meta_value FROM wp_postmeta WHERE meta_key='_wp_attached_file'" --skip-column-names`,
    );
    const attachedFiles = new Set(
      attachedOutput
        .split('\n')
        .filter(Boolean)
        .map((f) => `${uploadsDir.trim()}/${f}`),
    );

    // Also include generated sizes (thumbnails, medium, large).
    const sizesOutput = await this.wp(
      `db query "SELECT meta_value FROM wp_postmeta WHERE meta_key='_wp_attachment_metadata'" --skip-column-names`,
    );

    const registeredFiles = new Set(attachedFiles);
    for (const row of sizesOutput.split('\n').filter(Boolean)) {
      try {
        const meta = JSON.parse(row) as WpCliAttachmentMeta;
        if (meta.sizes) {
          const dir = meta.file ? meta.file.replace(/[^/]+$/, '') : '';
          for (const size of Object.values(meta.sizes)) {
            if (size.file) {
              registeredFiles.add(`${uploadsDir.trim()}/${dir}${size.file}`);
            }
          }
        }
      } catch {
        // Skip unparseable metadata.
      }
    }

    // Find orphans: files on disk not in the DB.
    const orphanFiles: string[] = [];
    let reclaimableBytes = 0;
    for (const file of allFiles) {
      if (!registeredFiles.has(file)) {
        orphanFiles.push(file);
        // Get file size.
        const sizeResult = await sshExec(this.ssh, `stat -c%s "${file}" 2>/dev/null || echo "0"`);
        reclaimableBytes += Number.parseInt(sizeResult.stdout.trim(), 10) || 0;
      }
    }

    // Find missing: attachments in DB whose file is gone.
    const missingFiles: number[] = [];
    const attachmentsOutput = await this.wp(
      'post list --post_type=attachment --post_status=inherit --fields=ID --format=json',
    );
    const attachments = JSON.parse(attachmentsOutput) as Array<{ ID: number }>;

    for (const att of attachments) {
      try {
        const filePath = await this.wp(`post meta get ${att.ID} _wp_attached_file`);
        const fullPath = `${uploadsDir.trim()}/${filePath.trim()}`;
        const existsResult = await sshExec(
          this.ssh,
          `test -f "${fullPath}" && echo "yes" || echo "no"`,
        );
        if (existsResult.stdout.trim() === 'no') {
          missingFiles.push(att.ID);
        }
      } catch {
        missingFiles.push(att.ID);
      }
    }

    return { orphanFiles, missingFiles, reclaimableBytes };
  }

  // Reference finding ---------------------------------------------------------

  // The block/content queries below intentionally scope to post_status='publish',
  // matching the REST adapter: WP's REST /posts and /pages endpoints default to
  // `status=publish` even for authenticated requests, so this is parity, not an
  // arbitrary restriction. Widen it only if unpublished references need to be
  // surfaced too — that's a user-visible behavior change, not a bug fix.
  async findReferences(id: number, scope: ReferenceScope): Promise<Reference[]> {
    const references: Reference[] = [];

    // Featured images — same as REST fast scan but via WP-CLI.
    const featuredOutput = await this.wp(
      `db query "SELECT post_id FROM wp_postmeta WHERE meta_key='_thumbnail_id' AND meta_value='${id}'" --skip-column-names`,
    );
    for (const postIdStr of featuredOutput.split('\n').filter(Boolean)) {
      const postId = Number.parseInt(postIdStr.trim(), 10);
      if (Number.isNaN(postId)) continue;
      try {
        const postJson = await this.wp(
          `post get ${postId} --fields=ID,post_title,post_type --format=json`,
        );
        const post = JSON.parse(postJson) as { ID: number; post_title: string; post_type: string };
        references.push({
          type: 'featured-image',
          postId: post.ID,
          postTitle: post.post_title,
          postType: post.post_type,
        });
      } catch {
        references.push({
          type: 'featured-image',
          postId,
          postTitle: '(unknown)',
          postType: 'unknown',
        });
      }
    }

    // Gutenberg block references. The LIKE clause is a cheap pre-filter only
    // (it would match id:123 inside id:1234 too) — the real match is the
    // anchored regex applied to post_content below, same as REST's
    // countBlockReferences() in rest.ts.
    const blockPattern = `"id":${id}`;
    const blockOutput = await this.wp(
      `db query "SELECT ID, post_title, post_type, post_content FROM wp_posts WHERE post_status='publish' AND post_content LIKE '%${blockPattern}%'" --skip-column-names`,
    );
    for (const line of blockOutput.split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      if (parts.length >= 4) {
        const postId = Number.parseInt(parts[0], 10);
        const content = parts.slice(3).join('\t');
        if (!matchesBlockId(content, id)) continue;
        // Avoid duplicating featured-image refs.
        if (!references.some((r) => r.postId === postId && r.type === 'featured-image')) {
          references.push({
            type: 'gutenberg-block',
            postId,
            postTitle: parts[1],
            postType: parts[2],
          });
        }
      }
    }

    // Full scan: content URLs and post meta (only if scope is 'full').
    if (scope === 'full') {
      // Get the attachment URL to search for in content.
      const attachmentUrl = await this.wp(`post get ${id} --field=guid`);
      const url = attachmentUrl.trim();

      if (url) {
        // Search post content for the URL.
        const urlPattern = url.replace(/https?:\/\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const contentOutput = await this.wp(
          `db query "SELECT ID, post_title, post_type FROM wp_posts WHERE post_status='publish' AND post_content LIKE '%${urlPattern}%'" --skip-column-names`,
        );
        for (const line of contentOutput.split('\n').filter(Boolean)) {
          const parts = line.split('\t');
          if (parts.length >= 3) {
            const postId = Number.parseInt(parts[0], 10);
            if (!references.some((r) => r.postId === postId)) {
              references.push({
                type: 'content-url',
                postId,
                postTitle: parts[1],
                postType: parts[2],
              });
            }
          }
        }
      }

      // Search post meta for the attachment ID.
      const metaOutput = await this.wp(
        `db query "SELECT post_id, meta_key FROM wp_postmeta WHERE meta_value='${id}' AND meta_key NOT LIKE '\\_%'" --skip-column-names`,
      );
      for (const line of metaOutput.split('\n').filter(Boolean)) {
        const parts = line.split('\t');
        if (parts.length >= 2) {
          const postId = Number.parseInt(parts[0], 10);
          if (!references.some((r) => r.postId === postId && r.type === 'post-meta')) {
            try {
              const postJson = await this.wp(
                `post get ${postId} --fields=post_title,post_type --format=json`,
              );
              const post = JSON.parse(postJson) as { post_title: string; post_type: string };
              references.push({
                type: 'post-meta',
                postId,
                postTitle: post.post_title,
                postType: post.post_type,
                metaKey: parts[1],
              });
            } catch {
              references.push({
                type: 'post-meta',
                postId,
                postTitle: '(unknown)',
                postType: 'unknown',
                metaKey: parts[1],
              });
            }
          }
        }
      }
    }

    return references;
  }
}

/**
 * Returns true if `content` contains a Gutenberg block reference to
 * `attachmentId` that is ID-boundary safe (so id:123 does not match id:1234).
 * Mirrors countBlockReferences() in rest.ts.
 */
export function matchesBlockId(content: string, attachmentId: number): boolean {
  const pattern = new RegExp(
    `wp:(?:image|gallery|cover|media-text)[^}]*"id"\\s*:\\s*${attachmentId}\\b`,
  );
  return pattern.test(content);
}

// -- WP-CLI response types ----------------------------------------------------

interface WpCliPost {
  ID: number;
  post_title: string;
  post_name: string;
  post_mime_type: string;
  post_date: string;
}

interface WpCliPostDetail {
  ID: number;
  post_title: string;
  post_name: string;
  post_mime_type: string;
  post_date: string;
  guid: string;
}

interface WpCliAttachmentMeta {
  width?: number;
  height?: number;
  file?: string;
  filesize?: number;
  sizes?: Record<string, { file: string; width: number; height: number }>;
}

// Helper for callers that want to check availability.
export function isWpCliAvailableForSite(site: SiteConfig): boolean {
  return Boolean(site.ssh?.host && site.ssh?.user && site.ssh?.wpPath);
}

/** Join a WordPress uploads base URL with a relative file path, avoiding double slashes. */
export function buildUploadUrl(baseUrl: string, relativePath: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${relativePath.replace(/^\/+/, '')}`;
}

/**
 * Best-effort parse of `wp search-replace`'s human-readable summary line
 * (e.g. "Success: Made 3 replacements."). Returns null rather than throwing
 * if the output format doesn't match — callers must degrade gracefully.
 */
export function parseSearchReplaceCount(output: string): number | null {
  const match = output.match(/Made (\d+) replacements?/i);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

export { CapabilityUnavailableError } from './types.ts';
