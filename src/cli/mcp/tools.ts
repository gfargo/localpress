/**
 * MCP tool definitions for localpress.
 *
 * Each tool maps to one CLI command. The schema describes the JSON shape the
 * agent sends; we translate that into CLI argv and invoke the same binary
 * recursively (see `invoke.ts`).
 *
 * Schema philosophy: keep input args close to the CLI flag names so the
 * skill/docs remain a single source of truth. Camel-case in the JSON,
 * kebab-case on the wire.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { invokeCli } from './invoke.ts';

/**
 * Common args every tool accepts.
 * `site` is optional — when omitted, the CLI uses the active site from config.
 */
const commonSiteArg = {
  site: z
    .string()
    .optional()
    .describe(
      'Override the active site for this call. When omitted, uses the active site from config.',
    ),
};

type ArgMap = Record<string, unknown>;

/** Push a boolean flag onto argv if truthy. */
function flag(argv: string[], name: string, value: unknown): void {
  if (value === true) argv.push(name);
}

/** Push `--name <value>` onto argv if value is defined. */
function opt(argv: string[], name: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  argv.push(name, String(value));
}

/** Push positional IDs onto argv. */
function ids(argv: string[], value: unknown): void {
  if (Array.isArray(value)) {
    for (const id of value) argv.push(String(id));
  } else if (typeof value === 'number' || typeof value === 'string') {
    argv.push(String(value));
  }
}

/** Run a CLI command and shape the response for MCP. */
async function runCli(args: string[], site?: string, concurrency?: number) {
  const result = await invokeCli({ args, site, concurrency });
  if (!result.ok) {
    return {
      isError: true as const,
      content: [
        {
          type: 'text' as const,
          text:
            typeof result.stdout === 'string'
              ? `${result.stderr || result.stdout || 'CLI exited with error'} (exit ${result.exitCode})`
              : `${result.stderr || 'CLI exited with error'} (exit ${result.exitCode})\n\n${JSON.stringify(result.stdout, null, 2)}`,
        },
      ],
    };
  }

  // Build text content — include stderr warnings/errors if present.
  const textContent =
    typeof result.stdout === 'string' ? result.stdout : JSON.stringify(result.stdout, null, 2);
  const fullText = result.stderr
    ? `${textContent}\n\n--- stderr ---\n${result.stderr}`
    : textContent;

  // structuredContent must be a record (object), not an array.
  // Wrap arrays in { items: [...] } to satisfy the MCP protocol.
  let structured: Record<string, unknown> | undefined;
  if (typeof result.stdout === 'object' && result.stdout !== null) {
    if (Array.isArray(result.stdout)) {
      structured = { items: result.stdout };
    } else {
      structured = result.stdout as Record<string, unknown>;
    }
  }

  return {
    content: [{ type: 'text' as const, text: fullText }],
    structuredContent: structured,
  };
}

export function registerTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // Setup & configuration
  // ---------------------------------------------------------------------------

  server.registerTool(
    'sites_list',
    {
      title: 'List configured sites',
      description:
        'List all WordPress sites configured for localpress, with the active one marked.',
      inputSchema: {},
    },
    async () => runCli(['sites']),
  );

  server.registerTool(
    'sites_use',
    {
      title: 'Switch active site',
      description: 'Make the named site the active one for subsequent operations.',
      inputSchema: {
        name: z.string().describe('Name of the site to activate. Must match one from sites_list.'),
      },
    },
    async ({ name }) => runCli(['sites', 'use', name as string]),
  );

  server.registerTool(
    'sites_add',
    {
      title: 'Add a WordPress site',
      description:
        'Register a new WordPress site non-interactively. Requires an Application Password.',
      inputSchema: {
        url: z.string().describe('Site URL (https://example.com)'),
        username: z.string().describe('WordPress username'),
        appPassword: z.string().describe('WordPress Application Password'),
        name: z.string().optional().describe('Site name (defaults to hostname)'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['sites', 'add', a.url as string];
      opt(argv, '--username', a.username);
      opt(argv, '--app-password', a.appPassword);
      opt(argv, '--name', a.name);
      return runCli(argv);
    },
  );

  server.registerTool(
    'sites_remove',
    {
      title: 'Remove a site',
      description:
        'Remove a configured site and its local SQLite database. Does not touch WordPress.',
      inputSchema: {
        name: z.string().describe('Site name to remove'),
      },
    },
    async ({ name }) => runCli(['sites', 'remove', name as string]),
  );

  server.registerTool(
    'doctor',
    {
      title: 'Show backend capabilities',
      description:
        'Report which adapters (REST, WP-CLI) are available, which capabilities each provides, and any detected issues.',
      inputSchema: {
        ...commonSiteArg,
        allSites: z.boolean().optional().describe('Show capabilities for every configured site'),
        plugins: z.boolean().optional().describe('Probe for relevant WordPress plugins'),
        fix: z.boolean().optional().describe('Attempt auto-remediation of detected issues'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['doctor'];
      flag(argv, '--all-sites', a.allSites);
      flag(argv, '--plugins', a.plugins);
      flag(argv, '--fix', a.fix);
      return runCli(argv, a.site as string | undefined);
    },
  );

  server.registerTool(
    'config_get',
    {
      title: 'Read a config value',
      description: 'Read a single config value by dotted key (e.g. `defaults.quality`).',
      inputSchema: {
        key: z.string().describe('Dotted config key, e.g. `defaults.quality` or `activeSite`'),
      },
    },
    async ({ key }) => runCli(['config', 'get', key as string]),
  );

  server.registerTool(
    'config_set',
    {
      title: 'Write a config value',
      description:
        'Set a config value by dotted key. Use sparingly — credentials should be added via sites_add.',
      inputSchema: {
        key: z.string().describe('Dotted config key'),
        value: z.string().describe('New value (will be parsed as JSON when possible)'),
      },
    },
    async ({ key, value }) => runCli(['config', 'set', key as string, value as string]),
  );

  server.registerTool(
    'config_list_profiles',
    {
      title: 'List optimization profiles',
      description: 'List all named optimization profiles defined in config.',
      inputSchema: {},
    },
    async () => runCli(['config', 'list-profiles']),
  );

  server.registerTool(
    'config_get_profile',
    {
      title: 'Get a named profile',
      description: 'Read the settings for a single named optimization profile.',
      inputSchema: {
        name: z.string().describe('Profile name'),
      },
    },
    async ({ name }) => runCli(['config', 'get-profile', name as string]),
  );

  server.registerTool(
    'config_set_profile',
    {
      title: 'Create or update a profile',
      description: 'Create or update a reusable optimization profile.',
      inputSchema: {
        name: z.string().describe('Profile name'),
        quality: z.number().int().min(1).max(100).optional(),
        format: z.enum(['webp', 'avif', 'jpeg', 'png']).optional(),
        maxWidth: z.number().int().positive().optional(),
        maxHeight: z.number().int().positive().optional(),
        encoder: z.enum(['sharp', 'jsquash']).optional(),
        stripMetadata: z.boolean().optional(),
        description: z.string().optional(),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['config', 'set-profile', a.name as string];
      opt(argv, '--quality', a.quality);
      opt(argv, '--format', a.format);
      opt(argv, '--max-width', a.maxWidth);
      opt(argv, '--max-height', a.maxHeight);
      opt(argv, '--encoder', a.encoder);
      flag(argv, '--strip-metadata', a.stripMetadata);
      opt(argv, '--description', a.description);
      return runCli(argv);
    },
  );

  // ---------------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------------

  server.registerTool(
    'list',
    {
      title: 'List media items',
      description:
        "List media in the active site's library. Filters compose: unoptimized, type, size, post association, date range, free-text search.",
      inputSchema: {
        ...commonSiteArg,
        unoptimized: z.boolean().optional().describe("Only items localpress hasn't processed yet"),
        type: z.string().optional().describe('MIME type filter (e.g. image/jpeg)'),
        post: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Attachments associated with a specific post'),
        since: z.string().optional().describe('ISO date — only items uploaded since this date'),
        largerThan: z.number().int().positive().optional().describe('Minimum size in bytes'),
        search: z
          .string()
          .optional()
          .describe('Free-text search across filename and title (WP REST native `?search=`)'),
        limit: z.number().int().positive().max(100).optional().describe('Items per page'),
        page: z.number().int().positive().optional().describe('Page number'),
        sort: z.enum(['date', 'name', 'size', 'id']).optional(),
        order: z.enum(['asc', 'desc']).optional(),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['list'];
      flag(argv, '--unoptimized', a.unoptimized);
      opt(argv, '--type', a.type);
      opt(argv, '--post', a.post);
      opt(argv, '--since', a.since);
      opt(argv, '--larger-than', a.largerThan);
      opt(argv, '--search', a.search);
      opt(argv, '--limit', a.limit);
      opt(argv, '--page', a.page);
      opt(argv, '--sort', a.sort);
      opt(argv, '--order', a.order);
      return runCli(argv, a.site as string | undefined);
    },
  );

  server.registerTool(
    'show',
    {
      title: 'Show attachment details',
      description:
        'Fetch full details for a specific attachment, including registered sizes and processing history.',
      inputSchema: {
        ...commonSiteArg,
        id: z.number().int().positive().describe('Attachment ID'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      return runCli(['show', String(a.id)], a.site as string | undefined);
    },
  );

  server.registerTool(
    'stats',
    {
      title: 'Cumulative processing stats',
      description:
        'Library health dashboard: total bytes saved, optimized %, format breakdown, recent operations.',
      inputSchema: {
        ...commonSiteArg,
        allSites: z.boolean().optional().describe('Show stats for every configured site'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['stats'];
      flag(argv, '--all-sites', a.allSites);
      return runCli(argv, a.site as string | undefined);
    },
  );

  server.registerTool(
    'audit',
    {
      title: 'Audit the media library',
      description:
        'Find issues: unoptimized, oversized, missing alt text, oversized for display, duplicates, broken references, orphans. Optional Ollama vision checks: quality (blurry/low-contrast) and ocrText (substring search inside images).',
      inputSchema: {
        ...commonSiteArg,
        unoptimized: z.boolean().optional(),
        large: z.boolean().optional(),
        missingAlt: z.boolean().optional(),
        displaySize: z.boolean().optional(),
        duplicates: z.boolean().optional(),
        brokenRefs: z.boolean().optional(),
        orphans: z.boolean().optional(),
        quality: z
          .boolean()
          .optional()
          .describe(
            'Vision-based quality check (blurry/low-contrast); requires Ollama; slow (~10s/image)',
          ),
        ocrText: z
          .string()
          .optional()
          .describe('Find images that visually contain this text (Ollama vision; slow)'),
        threshold: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Size threshold in bytes for --large'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['audit'];
      flag(argv, '--unoptimized', a.unoptimized);
      flag(argv, '--large', a.large);
      flag(argv, '--missing-alt', a.missingAlt);
      flag(argv, '--display-size', a.displaySize);
      flag(argv, '--duplicates', a.duplicates);
      flag(argv, '--broken-refs', a.brokenRefs);
      flag(argv, '--orphans', a.orphans);
      flag(argv, '--quality', a.quality);
      opt(argv, '--ocr-text', a.ocrText);
      opt(argv, '--threshold', a.threshold);
      return runCli(argv, a.site as string | undefined);
    },
  );

  server.registerTool(
    'references',
    {
      title: 'Find references to an attachment',
      description: 'Find every post, page, or custom-post where a given attachment is referenced.',
      inputSchema: {
        ...commonSiteArg,
        id: z.number().int().positive(),
        scope: z
          .enum(['fast', 'full'])
          .optional()
          .describe('fast (REST) or full (WP-CLI required)'),
        updateTo: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Rewrite references to point to a different attachment ID'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['references', String(a.id)];
      opt(argv, '--scope', a.scope);
      opt(argv, '--update-to', a.updateTo);
      return runCli(argv, a.site as string | undefined);
    },
  );

  // ---------------------------------------------------------------------------
  // Processing
  // ---------------------------------------------------------------------------

  server.registerTool(
    'optimize',
    {
      title: 'Optimize images',
      description:
        'Compress images using the local image engine. Bulk modes (--unoptimized, --all) are dry-run by default; pass apply=true to execute.',
      inputSchema: {
        ...commonSiteArg,
        ids: z.array(z.number().int().positive()).optional().describe('Specific attachment IDs'),
        unoptimized: z.boolean().optional().describe('Process all unoptimized items'),
        all: z.boolean().optional().describe('Process every attachment'),
        quality: z.number().int().min(1).max(100).optional(),
        to: z
          .enum(['webp', 'avif', 'jpeg', 'png'])
          .optional()
          .describe(
            'Convert during optimization: webp, avif, jpeg, or png. Defaults to the source format when omitted.',
          ),
        maxWidth: z.number().int().positive().optional(),
        maxHeight: z.number().int().positive().optional(),
        encoder: z.enum(['sharp', 'jsquash']).optional(),
        profile: z.string().optional().describe('Use a named profile from config'),
        stripMetadata: z.boolean().optional(),
        apply: z.boolean().optional().describe('Opt out of dry-run for bulk ops'),
        concurrency: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Parallel workers for bulk ops (default: CPU count - 1)'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['optimize'];
      ids(argv, a.ids);
      flag(argv, '--unoptimized', a.unoptimized);
      flag(argv, '--all', a.all);
      opt(argv, '--quality', a.quality);
      opt(argv, '--to', a.to);
      opt(argv, '--max-width', a.maxWidth);
      opt(argv, '--max-height', a.maxHeight);
      opt(argv, '--encoder', a.encoder);
      opt(argv, '--profile', a.profile);
      if (a.stripMetadata === true) argv.push('--strip-metadata');
      else if (a.stripMetadata === false) argv.push('--no-strip-metadata');
      flag(argv, '--apply', a.apply);
      return runCli(argv, a.site as string | undefined, a.concurrency as number | undefined);
    },
  );

  server.registerTool(
    'convert',
    {
      title: 'Convert image format',
      description: 'Convert attachments to a different format (webp, avif, jpeg, png).',
      inputSchema: {
        ...commonSiteArg,
        ids: z.array(z.number().int().positive()).optional(),
        to: z.enum(['webp', 'avif', 'jpeg', 'png']).describe('Target format'),
        quality: z.number().int().min(1).max(100).optional(),
        apply: z.boolean().optional(),
        concurrency: z.number().int().positive().optional().describe('Parallel workers'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['convert'];
      ids(argv, a.ids);
      opt(argv, '--to', a.to);
      opt(argv, '--quality', a.quality);
      flag(argv, '--apply', a.apply);
      return runCli(argv, a.site as string | undefined, a.concurrency as number | undefined);
    },
  );

  server.registerTool(
    'resize',
    {
      title: 'Resize images',
      description:
        'Resize attachments with a max-width or max-height constraint (aspect-preserving).',
      inputSchema: {
        ...commonSiteArg,
        ids: z.array(z.number().int().positive()).optional(),
        maxWidth: z.number().int().positive().optional(),
        maxHeight: z.number().int().positive().optional(),
        apply: z.boolean().optional(),
        concurrency: z.number().int().positive().optional().describe('Parallel workers'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['resize'];
      ids(argv, a.ids);
      opt(argv, '--max-width', a.maxWidth);
      opt(argv, '--max-height', a.maxHeight);
      flag(argv, '--apply', a.apply);
      return runCli(argv, a.site as string | undefined, a.concurrency as number | undefined);
    },
  );

  server.registerTool(
    'remove_bg',
    {
      title: 'Remove image background',
      description:
        'Remove background using a local AI model. Available models: birefnet-lite (best, ~224MB), isnet-general-use, u2net (default), silueta, u2netp (fast).',
      inputSchema: {
        ...commonSiteArg,
        ids: z.array(z.number().int().positive()),
        model: z
          .enum(['birefnet-lite', 'isnet-general-use', 'u2net', 'silueta', 'u2netp'])
          .optional(),
        bg: z
          .string()
          .optional()
          .describe('Background fill color (e.g. "#ffffff") instead of transparency'),
        rembg: z.boolean().optional().describe('Use system Python rembg instead of built-in ONNX'),
        rembgModel: z.string().optional().describe('Model name when using --rembg'),
        apply: z.boolean().optional(),
        concurrency: z.number().int().positive().optional().describe('Parallel workers'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['remove-bg'];
      ids(argv, a.ids);
      opt(argv, '--model', a.model);
      opt(argv, '--bg', a.bg);
      flag(argv, '--rembg', a.rembg);
      opt(argv, '--rembg-model', a.rembgModel);
      flag(argv, '--apply', a.apply);
      return runCli(argv, a.site as string | undefined, a.concurrency as number | undefined);
    },
  );

  server.registerTool(
    'caption',
    {
      title: 'Generate alt text (AI)',
      description:
        'Generate alt text using a local Ollama vision model. Requires Ollama running at http://localhost:11434 with a vision model pulled (e.g. `ollama pull moondream` or `ollama pull llava-llama3`). Default model is moondream — pass model param to use a different one.',
      inputSchema: {
        ...commonSiteArg,
        ids: z.array(z.number().int().positive()).optional(),
        missingAlt: z
          .boolean()
          .optional()
          .describe('Caption everything currently missing alt text'),
        all: z.boolean().optional(),
        model: z.string().optional().describe('Ollama model name (default: moondream)'),
        language: z.string().optional().describe('Output language (e.g. "Spanish")'),
        overwrite: z.boolean().optional(),
        listModels: z.boolean().optional().describe('List locally available vision models'),
        apply: z.boolean().optional(),
        concurrency: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Parallel workers for bulk captioning'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['caption'];
      ids(argv, a.ids);
      flag(argv, '--missing-alt', a.missingAlt);
      flag(argv, '--all', a.all);
      opt(argv, '--model', a.model);
      opt(argv, '--language', a.language);
      flag(argv, '--overwrite', a.overwrite);
      flag(argv, '--list-models', a.listModels);
      flag(argv, '--apply', a.apply);
      return runCli(argv, a.site as string | undefined, a.concurrency as number | undefined);
    },
  );

  server.registerTool(
    'generate_title',
    {
      title: 'Generate WP title (AI)',
      description:
        'Generate a short 3-7 word noun-phrase title for one or more attachments and write it to the WP post_title field. Companion to caption (alt text) and describe (long description). Bulk via --missing-title (auto-detects machine-generated names like Screenshot-…, IMG_…, DSC-…) or --all. Dry-run unless apply=true.',
      inputSchema: {
        ...commonSiteArg,
        ids: z.array(z.number().int().positive()).optional(),
        missingTitle: z
          .boolean()
          .optional()
          .describe('Only items whose title looks auto-generated (Screenshot-…, IMG_…, etc.)'),
        all: z.boolean().optional(),
        model: z.string().optional(),
        language: z.string().optional(),
        overwrite: z.boolean().optional(),
        apply: z.boolean().optional(),
        concurrency: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['title'];
      ids(argv, a.ids);
      flag(argv, '--missing-title', a.missingTitle);
      flag(argv, '--all', a.all);
      opt(argv, '--model', a.model);
      opt(argv, '--language', a.language);
      flag(argv, '--overwrite', a.overwrite);
      flag(argv, '--apply', a.apply);
      return runCli(argv, a.site as string | undefined, a.concurrency as number | undefined);
    },
  );

  server.registerTool(
    'generate_description',
    {
      title: 'Generate WP description (AI)',
      description:
        'Generate a 2-3 sentence description for one or more attachments and write it to the WP description field. Useful for gallery captions and attachment-page SEO. Bulk via --missing-description or --all. Dry-run unless apply=true.',
      inputSchema: {
        ...commonSiteArg,
        ids: z.array(z.number().int().positive()).optional(),
        missingDescription: z
          .boolean()
          .optional()
          .describe('Only items currently lacking a description'),
        all: z.boolean().optional(),
        model: z.string().optional(),
        language: z.string().optional(),
        overwrite: z.boolean().optional(),
        apply: z.boolean().optional(),
        concurrency: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['describe'];
      ids(argv, a.ids);
      flag(argv, '--missing-description', a.missingDescription);
      flag(argv, '--all', a.all);
      opt(argv, '--model', a.model);
      opt(argv, '--language', a.language);
      flag(argv, '--overwrite', a.overwrite);
      flag(argv, '--apply', a.apply);
      return runCli(argv, a.site as string | undefined, a.concurrency as number | undefined);
    },
  );

  server.registerTool(
    'vision',
    {
      title: 'Generate all AI metadata fields (unified)',
      description:
        "Single-call unified workflow: generate alt, title, description, tags, and classification for one or more attachments in one pass. Print-only by default — pass apply=true to write the generated fields back to WordPress. Use `fields` to subset (e.g. 'alt,title'). Idempotent unless `overwrite: true` — won't clobber existing values.",
      inputSchema: {
        ...commonSiteArg,
        ids: z.array(z.number().int().positive()),
        fields: z
          .string()
          .optional()
          .describe(
            'Comma-separated subset of: alt, title, description, tags, classify. Defaults to all five.',
          ),
        model: z.string().optional(),
        language: z.string().optional(),
        overwrite: z.boolean().optional(),
        apply: z.boolean().optional().describe('Write the generated values to WordPress'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['vision'];
      ids(argv, a.ids);
      opt(argv, '--fields', a.fields);
      opt(argv, '--model', a.model);
      opt(argv, '--language', a.language);
      flag(argv, '--overwrite', a.overwrite);
      flag(argv, '--apply', a.apply);
      return runCli(argv, a.site as string | undefined);
    },
  );

  server.registerTool(
    'tag',
    {
      title: 'Generate tags (AI)',
      description:
        "Generate 3-6 short tags via the Ollama vision model and append them to the attachment's caption as a `[tags: tag1, tag2, …]` block. Universal — doesn't require WP attachment taxonomies to be registered. Existing caption text is preserved; an existing `[tags: …]` block is left alone unless `overwrite: true`.",
      inputSchema: {
        ...commonSiteArg,
        ids: z.array(z.number().int().positive()).optional(),
        missingTags: z
          .boolean()
          .optional()
          .describe('Only items without an existing [tags: …] block in their caption'),
        all: z.boolean().optional(),
        model: z.string().optional(),
        overwrite: z.boolean().optional(),
        apply: z.boolean().optional(),
        concurrency: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['tag'];
      ids(argv, a.ids);
      flag(argv, '--missing-tags', a.missingTags);
      flag(argv, '--all', a.all);
      opt(argv, '--model', a.model);
      flag(argv, '--overwrite', a.overwrite);
      flag(argv, '--apply', a.apply);
      return runCli(argv, a.site as string | undefined, a.concurrency as number | undefined);
    },
  );

  server.registerTool(
    'classify',
    {
      title: 'Classify image type (AI)',
      description:
        'Detect whether an image is a screenshot, photo, illustration, or diagram via the Ollama vision model. Result is cached locally so `optimize` (when no explicit --to is given) picks smarter format defaults: screenshots/diagrams → PNG, photos/illustrations → WebP.',
      inputSchema: {
        ...commonSiteArg,
        ids: z.array(z.number().int().positive()),
        model: z.string().optional(),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['classify'];
      ids(argv, a.ids);
      opt(argv, '--model', a.model);
      return runCli(argv, a.site as string | undefined);
    },
  );

  server.registerTool(
    'rename',
    {
      title: 'Rename attachment slug',
      description:
        "Rename one or more attachment slugs (permalinks). With `smart: true`, generate the new name via the Ollama vision model; with `to: '<name>'`, use the supplied string. Does NOT rename the underlying file on disk (slug only). Captures an undo snapshot before each change.",
      inputSchema: {
        ...commonSiteArg,
        ids: z.array(z.number().int().positive()),
        smart: z
          .boolean()
          .optional()
          .describe('Generate the new name via the vision model. Mutually exclusive with `to`.'),
        to: z
          .string()
          .optional()
          .describe('Explicit new name (will be slugified). Mutually exclusive with `smart`.'),
        model: z.string().optional().describe('Ollama model (smart mode only)'),
        dryRun: z.boolean().optional(),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['rename'];
      ids(argv, a.ids);
      flag(argv, '--smart', a.smart);
      opt(argv, '--to', a.to);
      opt(argv, '--model', a.model);
      flag(argv, '--dry-run', a.dryRun);
      return runCli(argv, a.site as string | undefined);
    },
  );

  server.registerTool(
    'delete',
    {
      title: 'Delete attachments',
      description:
        'Delete one or more attachments. Without `force: true`, WordPress moves them to trash (recoverable from the admin). With `force: true`, attachments + files are permanently removed — also requires `confirm: true`. Pre-captures a binary snapshot for each attachment so `undo` can re-upload the file (as a new attachment ID; references will need rewriting).',
      inputSchema: {
        ...commonSiteArg,
        ids: z.array(z.number().int().positive()).describe('Attachment IDs to delete'),
        force: z
          .boolean()
          .optional()
          .describe('Permanently delete (skip trash). Default: move to trash.'),
        confirm: z
          .boolean()
          .optional()
          .describe('Required alongside `force: true` to acknowledge permanent deletion.'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      if (a.force === true && a.confirm !== true) {
        return {
          isError: true as const,
          content: [
            {
              type: 'text' as const,
              text: 'Refusing to permanently delete: pass `confirm: true` alongside `force: true` to acknowledge this is irreversible.',
            },
          ],
        };
      }
      const argv = ['delete'];
      ids(argv, a.ids);
      flag(argv, '--force', a.force);
      return runCli(argv, a.site as string | undefined);
    },
  );

  server.registerTool(
    'update_metadata',
    {
      title: 'Set attachment metadata',
      description:
        'Directly set alt text, title, caption, or description on attachment(s). For AI-generated alt text, use `caption` instead. At least one field must be provided. Idempotent: skips items where all incoming fields already match.',
      inputSchema: {
        ...commonSiteArg,
        id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Single attachment ID. Use `ids` for bulk.'),
        ids: z
          .array(z.number().int().positive())
          .optional()
          .describe('Multiple attachment IDs (same metadata applied to each)'),
        altText: z.string().optional(),
        title: z.string().optional(),
        caption: z.string().optional(),
        description: z.string().optional(),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['metadata'];
      // Accept either `id` (single) or `ids` (array). At least one must be set.
      if (typeof a.id === 'number') argv.push(String(a.id));
      if (Array.isArray(a.ids)) for (const x of a.ids) argv.push(String(x));
      opt(argv, '--alt-text', a.altText);
      opt(argv, '--title', a.title);
      opt(argv, '--caption', a.caption);
      opt(argv, '--description', a.description);
      return runCli(argv, a.site as string | undefined);
    },
  );

  // ---------------------------------------------------------------------------
  // Round-trip & low-level
  // ---------------------------------------------------------------------------

  server.registerTool(
    'pull',
    {
      title: 'Download attachments',
      description: 'Download attachment files to a local directory.',
      inputSchema: {
        ...commonSiteArg,
        ids: z.array(z.number().int().positive()),
        to: z.string().optional().describe('Destination directory (default: current dir)'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['pull'];
      ids(argv, a.ids);
      opt(argv, '--to', a.to);
      return runCli(argv, a.site as string | undefined);
    },
  );

  server.registerTool(
    'push',
    {
      title: 'Upload a local file to WordPress',
      description:
        'Upload a local file as a new attachment, or as a replacement for an existing one.',
      inputSchema: {
        ...commonSiteArg,
        file: z.string().describe('Path to the local file to upload'),
        replace: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Replace an existing attachment ID'),
        title: z.string().optional(),
        altText: z.string().optional(),
        caption: z.string().optional(),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['push', a.file as string];
      opt(argv, '--replace', a.replace);
      opt(argv, '--title', a.title);
      opt(argv, '--alt', a.altText);
      opt(argv, '--caption', a.caption);
      return runCli(argv, a.site as string | undefined);
    },
  );

  server.registerTool(
    'regenerate',
    {
      title: 'Regenerate thumbnails',
      description:
        'Regenerate WordPress thumbnail sizes for one or more attachments (requires WP-CLI).',
      inputSchema: {
        ...commonSiteArg,
        ids: z.array(z.number().int().positive()).optional(),
        all: z.boolean().optional(),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['regenerate'];
      ids(argv, a.ids);
      flag(argv, '--all', a.all);
      return runCli(argv, a.site as string | undefined);
    },
  );

  server.registerTool(
    'export',
    {
      title: 'Export media library',
      description: 'Export attachments to a local directory or ZIP archive.',
      inputSchema: {
        ...commonSiteArg,
        ids: z.array(z.number().int().positive()).optional(),
        all: z.boolean().optional(),
        unoptimized: z.boolean().optional(),
        to: z.string().describe('Destination file (.zip) or directory'),
        type: z.string().optional(),
        since: z.string().optional(),
        largerThan: z.number().int().positive().optional().describe('Minimum size in bytes'),
        includeSizes: z
          .boolean()
          .optional()
          .describe('Also export generated thumbnail/medium/large variants'),
        flat: z
          .boolean()
          .optional()
          .describe('Export all files into a single flat directory (no subdirectories)'),
        concurrency: z.number().int().positive().optional().describe('Parallel workers'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['export'];
      ids(argv, a.ids);
      flag(argv, '--all', a.all);
      flag(argv, '--unoptimized', a.unoptimized);
      opt(argv, '--to', a.to);
      opt(argv, '--type', a.type);
      opt(argv, '--since', a.since);
      opt(argv, '--larger-than', a.largerThan);
      flag(argv, '--include-sizes', a.includeSizes);
      flag(argv, '--flat', a.flat);
      return runCli(argv, a.site as string | undefined, a.concurrency as number | undefined);
    },
  );

  server.registerTool(
    'import',
    {
      title: 'Import local files into WordPress',
      description: 'Bulk import a directory of local files, optionally optimizing on the way in.',
      inputSchema: {
        ...commonSiteArg,
        source: z.string().describe('Path to a directory of files, or to a previous export .zip'),
        optimize: z.boolean().optional(),
        to: z
          .enum(['webp', 'avif', 'jpeg', 'png'])
          .optional()
          .describe('Target format if --optimize'),
        quality: z.number().int().min(1).max(100).optional().describe('Optimization quality 1-100'),
        maxWidth: z.number().int().positive().optional(),
        maxHeight: z.number().int().positive().optional(),
        stripMetadata: z
          .boolean()
          .optional()
          .describe('Strip EXIF/ICC metadata during optimization'),
        title: z
          .string()
          .optional()
          .describe('Default title for imported items (overridden by manifest)'),
        altText: z.string().optional().describe('Default alt text for imported items'),
        post: z.number().int().positive().optional().describe('Attach all imports to this post'),
        preserveMetadata: z
          .boolean()
          .optional()
          .describe('Reapply alt/title/caption from a previous export manifest'),
        preserveIds: z.boolean().optional().describe('Deprecated alias for preserveMetadata'),
        dryRun: z.boolean().optional(),
        concurrency: z.number().int().positive().optional().describe('Parallel uploads'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['import', a.source as string];
      flag(argv, '--optimize', a.optimize);
      opt(argv, '--to', a.to);
      opt(argv, '--quality', a.quality);
      opt(argv, '--max-width', a.maxWidth);
      opt(argv, '--max-height', a.maxHeight);
      flag(argv, '--strip-metadata', a.stripMetadata);
      opt(argv, '--title', a.title);
      opt(argv, '--alt', a.altText);
      opt(argv, '--post', a.post);
      flag(argv, '--preserve-metadata', a.preserveMetadata);
      flag(argv, '--preserve-ids', a.preserveIds);
      flag(argv, '--dry-run', a.dryRun);
      return runCli(argv, a.site as string | undefined, a.concurrency as number | undefined);
    },
  );

  // ---------------------------------------------------------------------------
  // Time-machine / undo
  // ---------------------------------------------------------------------------

  server.registerTool(
    'history_list',
    {
      title: 'List recent sessions and snapshots',
      description:
        'Browse the local time-machine archive. Each destructive op creates a session containing per-attachment snapshots that can be restored.',
      inputSchema: {
        ...commonSiteArg,
        session: z.string().optional().describe('Filter to a specific session ID'),
        attachment: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Filter to a specific attachment ID'),
        operation: z
          .enum(['optimize', 'convert', 'resize', 'remove-bg', 'caption'])
          .optional()
          .describe('Filter by operation'),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['history'];
      opt(argv, '--session', a.session);
      opt(argv, '--attachment', a.attachment);
      opt(argv, '--operation', a.operation);
      opt(argv, '--limit', a.limit);
      return runCli(argv, a.site as string | undefined);
    },
  );

  server.registerTool(
    'history_show',
    {
      title: 'Show session or snapshot details',
      description: 'Show details for a session ID (8-char prefix) or a snapshot ID (integer).',
      inputSchema: {
        ...commonSiteArg,
        id: z
          .string()
          .describe('Session ID prefix (e.g. "a1b2c3d4") or snapshot ID as a string (e.g. "42")'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      return runCli(['history', 'show', a.id as string], a.site as string | undefined);
    },
  );

  server.registerTool(
    'undo',
    {
      title: 'Restore from a snapshot',
      description:
        'Restore from snapshot(s) — the time-machine reverse of optimize/convert/resize/remove-bg/caption. Defaults to the last session. Bulk undos dry-run unless apply=true; --snapshot and --attachment execute immediately.',
      inputSchema: {
        ...commonSiteArg,
        sessionId: z
          .string()
          .optional()
          .describe('Session ID (or 8-char prefix). Omit to undo the last session.'),
        snapshot: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Restore one specific snapshot by ID'),
        attachment: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Restore the most recent un-restored snapshot for this attachment'),
        apply: z.boolean().optional().describe('Required for bulk (session-targeted) undos'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['undo'];
      if (typeof a.sessionId === 'string') argv.push(a.sessionId);
      opt(argv, '--snapshot', a.snapshot);
      opt(argv, '--attachment', a.attachment);
      flag(argv, '--apply', a.apply);
      return runCli(argv, a.site as string | undefined);
    },
  );

  server.registerTool(
    'history_prune',
    {
      title: 'Apply retention policy',
      description:
        'Drop oldest snapshots per the active retention policy. Default policy reads from config (history.maxSizeBytes); pass overrides as args.',
      inputSchema: {
        ...commonSiteArg,
        maxSize: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Override: total snapshot bytes cap'),
        olderThan: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Drop snapshots older than this many days'),
        maxSessions: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Keep only the N most recent sessions'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['history', 'prune'];
      opt(argv, '--max-size', a.maxSize);
      opt(argv, '--older-than', a.olderThan);
      opt(argv, '--max-sessions', a.maxSessions);
      return runCli(argv, a.site as string | undefined);
    },
  );

  // ---------------------------------------------------------------------------
  // Watch automation (read-only status; start/stop intentionally not exposed)
  // ---------------------------------------------------------------------------

  server.registerTool(
    'watch_status',
    {
      title: 'Watch automation status',
      description:
        "Report which directories have been watched on the active site (file→attachment mappings) and last activity timestamps. NOTE: does not currently detect a live watcher process — only historical mapping data. Useful for agents to check 'is automation already wired up here?' before starting their own ops.",
      inputSchema: {
        ...commonSiteArg,
      },
    },
    async (args) => {
      const a = args as ArgMap;
      return runCli(['watch-status'], a.site as string | undefined);
    },
  );

  // ---------------------------------------------------------------------------
  // Content management (posts/pages)
  // ---------------------------------------------------------------------------

  server.registerTool(
    'a11y_audit',
    {
      title: 'Accessibility audit',
      description:
        'Check posts/pages for WCAG accessibility issues: heading hierarchy, generic link text, missing img alt, empty links.',
      inputSchema: {
        ...commonSiteArg,
        type: z
          .enum(['post', 'page', 'both'])
          .optional()
          .describe('Post type to check (default: both)'),
        status: z.string().optional().describe('Post status (default: publish)'),
        id: z.number().int().positive().optional().describe('Check a specific post only'),
        limit: z.number().int().positive().optional().describe('Max posts to check (default: 100)'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['a11y'];
      opt(argv, '--type', a.type);
      opt(argv, '--status', a.status);
      opt(argv, '--id', a.id);
      opt(argv, '--limit', a.limit);
      return runCli(argv, a.site as string | undefined);
    },
  );

  server.registerTool(
    'posts_list',
    {
      title: 'List posts or pages',
      description: 'List WordPress posts or pages with filters. Returns paginated results.',
      inputSchema: {
        ...commonSiteArg,
        status: z
          .enum(['publish', 'draft', 'pending', 'private', 'trash', 'any'])
          .optional()
          .describe('Filter by post status'),
        type: z
          .string()
          .optional()
          .describe('Post type slug: post, page, or any custom post type (default: post)'),
        author: z.number().int().positive().optional().describe('Filter by author ID'),
        search: z.string().optional().describe('Search posts by keyword'),
        category: z.number().int().positive().optional().describe('Filter by category ID'),
        perPage: z.number().int().positive().max(100).optional().describe('Results per page'),
        page: z.number().int().positive().optional().describe('Page number'),
        orderby: z.enum(['date', 'title', 'id', 'modified', 'slug']).optional(),
        order: z.enum(['asc', 'desc']).optional(),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['posts', 'list'];
      opt(argv, '--status', a.status);
      opt(argv, '--type', a.type);
      opt(argv, '--author', a.author);
      opt(argv, '--search', a.search);
      opt(argv, '--category', a.category);
      opt(argv, '--per-page', a.perPage);
      opt(argv, '--page', a.page);
      opt(argv, '--orderby', a.orderby);
      opt(argv, '--order', a.order);
      return runCli(argv, a.site as string | undefined);
    },
  );

  server.registerTool(
    'posts_show',
    {
      title: 'Show post details',
      description: 'Fetch full details for a specific post or page, including content.',
      inputSchema: {
        ...commonSiteArg,
        id: z.number().int().positive().describe('Post or page ID'),
        type: z
          .string()
          .optional()
          .describe('Post type slug: post, page, or any custom post type (default: post)'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['posts', 'show', String(a.id)];
      opt(argv, '--type', a.type);
      return runCli(argv, a.site as string | undefined);
    },
  );

  server.registerTool(
    'posts_create',
    {
      title: 'Create a post or page',
      description: 'Create a new WordPress post or page. Returns as draft by default.',
      inputSchema: {
        ...commonSiteArg,
        title: z.string().describe('Post title'),
        content: z.string().optional().describe('Post content (HTML or Gutenberg blocks)'),
        status: z.enum(['draft', 'publish', 'pending', 'private']).optional(),
        type: z
          .string()
          .optional()
          .describe('Post type slug: post, page, or any custom post type (default: post)'),
        slug: z.string().optional().describe('URL slug'),
        excerpt: z.string().optional().describe('Post excerpt'),
        featuredImage: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Featured image attachment ID'),
        categories: z.string().optional().describe('Comma-separated category IDs'),
        tags: z.string().optional().describe('Comma-separated tag IDs'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['posts', 'create'];
      opt(argv, '--title', a.title);
      opt(argv, '--content', a.content);
      opt(argv, '--status', a.status);
      opt(argv, '--type', a.type);
      opt(argv, '--slug', a.slug);
      opt(argv, '--excerpt', a.excerpt);
      opt(argv, '--featured-image', a.featuredImage);
      opt(argv, '--category', a.categories);
      opt(argv, '--tag', a.tags);
      return runCli(argv, a.site as string | undefined);
    },
  );

  server.registerTool(
    'posts_update',
    {
      title: 'Update a post or page',
      description: 'Update an existing WordPress post or page. Only provided fields are changed.',
      inputSchema: {
        ...commonSiteArg,
        id: z.number().int().positive().describe('Post or page ID to update'),
        title: z.string().optional().describe('New title'),
        content: z.string().optional().describe('New content (HTML or Gutenberg blocks)'),
        status: z.enum(['publish', 'draft', 'pending', 'private', 'trash']).optional(),
        type: z
          .string()
          .optional()
          .describe('Post type slug: post, page, or any custom post type (default: post)'),
        slug: z.string().optional().describe('New URL slug'),
        excerpt: z.string().optional().describe('New excerpt'),
        featuredImage: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Featured image attachment ID'),
        categories: z.string().optional().describe('Comma-separated category IDs'),
        tags: z.string().optional().describe('Comma-separated tag IDs'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const argv = ['posts', 'update', String(a.id)];
      opt(argv, '--title', a.title);
      opt(argv, '--content', a.content);
      opt(argv, '--status', a.status);
      opt(argv, '--type', a.type);
      opt(argv, '--slug', a.slug);
      opt(argv, '--excerpt', a.excerpt);
      opt(argv, '--featured-image', a.featuredImage);
      opt(argv, '--category', a.categories);
      opt(argv, '--tag', a.tags);
      return runCli(argv, a.site as string | undefined);
    },
  );

  server.registerTool(
    'posts_delete',
    {
      title: 'Delete a post or page',
      description:
        'Move a post/page to trash, or permanently delete with force=true (also requires confirm=true).',
      inputSchema: {
        ...commonSiteArg,
        id: z.number().int().positive().describe('Post or page ID'),
        type: z
          .string()
          .optional()
          .describe('Post type slug: post, page, or any custom post type (default: post)'),
        force: z.boolean().optional().describe('Permanently delete (skip trash)'),
        confirm: z
          .boolean()
          .optional()
          .describe('Required alongside `force: true` to acknowledge permanent deletion.'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      if (a.force === true && a.confirm !== true) {
        return {
          isError: true as const,
          content: [
            {
              type: 'text' as const,
              text: 'Refusing to permanently delete: pass `confirm: true` alongside `force: true` to acknowledge this is irreversible.',
            },
          ],
        };
      }
      const argv = ['posts', 'delete', String(a.id)];
      opt(argv, '--type', a.type);
      flag(argv, '--force', a.force);
      return runCli(argv, a.site as string | undefined);
    },
  );

  // ---------------------------------------------------------------------------
  // Composite / agent-convenience tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    'search_by_url',
    {
      title: 'Find attachment by URL',
      description:
        'Given a WordPress media URL (e.g. from post content), resolve it to the full attachment details. Extracts the filename from the URL and searches the library.',
      inputSchema: {
        ...commonSiteArg,
        url: z.string().describe('The full WordPress media URL to look up'),
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const url = a.url as string;
      // Extract filename from URL path (last segment, without query params)
      let filename: string;
      try {
        const parsed = new URL(url);
        const segments = parsed.pathname.split('/').filter(Boolean);
        filename = segments[segments.length - 1] ?? '';
        // Remove file extension for broader matching
        filename = filename.replace(/\.[^.]+$/, '');
      } catch {
        filename =
          url
            .split('/')
            .pop()
            ?.replace(/\.[^.]+$/, '') ?? url;
      }
      if (!filename) {
        return {
          isError: true as const,
          content: [{ type: 'text' as const, text: 'Could not extract filename from URL' }],
        };
      }
      return runCli(['list', '--search', filename, '--limit', '5'], a.site as string | undefined);
    },
  );

  server.registerTool(
    'health_check',
    {
      title: 'Library health check (combined)',
      description:
        'Combined health status: connection check (doctor), processing stats, and missing-alt-text count — all in one call. Useful for agents that want a quick overview without multiple round-trips.',
      inputSchema: {
        ...commonSiteArg,
      },
    },
    async (args) => {
      const a = args as ArgMap;
      const site = a.site as string | undefined;

      // Run all three in parallel for speed.
      const [doctorResult, statsResult, auditResult] = await Promise.all([
        invokeCli({ args: ['doctor'], site }),
        invokeCli({ args: ['stats'], site }),
        invokeCli({ args: ['audit', '--missing-alt'], site }),
      ]);

      const combined = {
        doctor: doctorResult.ok ? doctorResult.stdout : { error: doctorResult.stderr },
        stats: statsResult.ok ? statsResult.stdout : { error: statsResult.stderr },
        audit: auditResult.ok ? auditResult.stdout : { error: auditResult.stderr },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(combined, null, 2) }],
        structuredContent: combined as Record<string, unknown>,
      };
    },
  );
}
