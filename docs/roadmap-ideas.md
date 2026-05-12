# localpress — Roadmap & Feature Brainstorm

A living, kitchen-sink document of ideas for extending localpress. The goal is to cast a wide net: everything we might build, organized by theme, with effort estimates and strategic notes. Nothing here is committed — it's a menu.

**Current state (v1.16.0):** 30 CLI commands, 32 MCP tools. Foundation: REST adapter, WP-CLI over SSH, SQLite state, MCP server, Ollama integration, time-machine undo. The platform now supports expansion well beyond media optimization.

---

## Table of contents

1. [Already shipped](#already-shipped)
2. [MCP & agent experience](#1-mcp--agent-experience)
3. [Content management](#2-content-management)
4. [SEO & performance](#3-seo--performance)
5. [Theme & plugin management](#4-theme--plugin-management)
6. [Database & maintenance](#5-database--maintenance)
7. [Users & security](#6-users--security)
8. [Deployment & sync](#7-deployment--sync)
9. [Multi-site & agency](#8-multi-site--agency)
10. [AI & smart features](#9-ai--smart-features)
11. [Media processing enhancements](#10-media-processing-enhancements)
12. [Monitoring & reporting](#11-monitoring--reporting)
13. [Distribution & ecosystem](#12-distribution--ecosystem)
14. [E-commerce (WooCommerce)](#13-e-commerce-woocommerce)
15. [Developer experience](#14-developer-experience)
16. [Comments & engagement](#15-comments--engagement)
17. [Analytics & insights](#16-analytics--insights)
18. [Block editor (Gutenberg)](#17-block-editor-gutenberg)
19. [Page builder compatibility](#18-page-builder-compatibility)
20. [Internationalization](#19-internationalization)
21. [Accessibility](#20-accessibility-beyond-alt-text)
22. [Custom post types & fields](#21-custom-post-types--fields)
23. [Forms & submissions](#22-forms--submissions)
24. [Compliance & legal](#23-compliance--legal)
25. [Remote access & mobile](#24-remote-access--mobile)
26. [Notifications & collaboration](#25-notifications--collaboration)
27. [Workflow automation](#26-workflow-automation)
28. [Image intelligence](#27-image-intelligence)
29. [History expansion](#28-history--time-travel)
30. [Bulk operations at scale](#29-bulk-operations-at-scale)
31. [External service integrations](#30-external-service-integrations)
32. [Industry-specific flavors](#31-industry-specific-flavors)
33. [Advanced AI workflows](#32-advanced-ai-workflows)
34. [Platform & developer tools](#33-platform--developer-tools)
35. [Quality of life](#34-quality-of-life)
36. [Meta / self-referential](#35-meta--self-referential)
37. [Longer-shot ideas](#36-longer-shot-ideas)
38. [Priority framework](#priority-framework)

---

## Already shipped

These ideas from earlier brainstorms are now implemented:

- ~~`audit --display-size`~~ → v1.2
- ~~`audit --duplicates`~~ → v1.2
- ~~`audit --broken-refs`~~ → v1.2
- ~~`optimize --profile`~~ → v1.13
- ~~`caption` (AI alt-text)~~ → v1.4 (Ollama-based, multilingual in v1.13.1)
- ~~`watch` command~~ → v1.11
- ~~`export`/`import`~~ → v1.13
- ~~`config` command~~ → v1.2
- ~~Shell completions~~ → v1.8
- ~~`stats` command~~ → v1.4
- ~~Homebrew tap~~ → v1.2
- ~~`localpress update`~~ → v1.8
- ~~`doctor --fix` + plugin detection~~ → v1.2
- ~~`metadata` command~~ → v1.16
- ~~`delete` command~~ → v1.16
- ~~`list --search`~~ → v1.16
- ~~MCP server (32 tools)~~ → v1.14–v1.16
- ~~Time-machine undo~~ → v1.15

---

## 1. MCP & agent experience

### 1a. `search_by_url` — reverse URL lookup

Given a full image URL, resolve to attachment ID. Eliminates paginating through `list`.

**Effort:** Low

### 1b. `bulk_metadata` — batch metadata updates

Accept `[{id, altText?, title?, caption?, description?}, …]` in one call. Reduces 300+ sequential invocations to 1.

**Effort:** Low

### 1c. `health_check` — combined status

Single tool returning doctor + stats + audit summary. One round-trip for "what's the state?"

**Effort:** Low

### 1d. `diff` — show what changed

Compare current state vs last snapshot: format, dimensions, metadata, bytes. All in one response.

**Effort:** Low

### 1e. `batch_optimize` — per-item settings

`[{id: 123, quality: 75, format: "webp"}, {id: 456, profile: "thumbnail"}]` — different settings per item in one call.

**Effort:** Medium

### 1f. `cost_estimate` — predict operation time/savings

"If I optimize these 45 images, how long and how much space?" Based on historical averages.

**Effort:** Low

### 1g. Expanded MCP resources

- `localpress://library-summary` — counts, size, format breakdown (no network)
- `localpress://profiles` — all named profiles
- `localpress://recent-operations` — last N operations for agent context
- `localpress://capabilities-live` — real-time capability probe

**Effort:** Low

### 1h. `mcp_subscribe` — streaming progress updates

Instead of waiting for bulk op to finish, stream progress events over MCP. Agents can display real-time progress to users.

**Effort:** Medium

### 1i. `prompts` — reusable agent prompts

Expose named prompt templates as MCP prompts (the protocol supports this): "optimize-my-library", "fix-all-alt-text", "clean-up-for-migration". Agents compose them into workflows.

**Effort:** Low

---

## 2. Content management

### 2a. `posts list/show/create/update`

CRUD for posts and pages via REST API. Filter by status, category, author, date.

**Effort:** Medium | **Strategic value:** Very high

### 2b. `posts publish/draft/trash`

Lifecycle management. Bulk schedule, bulk unpublish, bulk trash old drafts.

### 2c. `posts search`

Full-text search: find posts mentioning a keyword, containing a shortcode, linking to a URL.

### 2d. `posts export` — markdown export

Posts as markdown with YAML frontmatter. Mirror of media export for content.

### 2e. `posts import` — markdown/HTML import

Bulk content migration from Ghost, Hugo, Jekyll, static sites.

### 2f. `content audit`

Broken internal links, orphan pages, thin content, posts with no featured image, missing categories/tags, stale drafts.

### 2g. `revisions list/diff/restore`

Browse post revisions, diff between versions, restore a specific revision.

### 2h. `menus list/edit`

Manage WordPress menus via REST API. Add/remove items, reorder, set menu locations.

### 2i. `categories/tags manage`

Taxonomy management. Bulk create, merge duplicates, find unused terms.

### 2j. `posts duplicate`

Clone a post with all metadata, custom fields, featured image. Useful for templates.

---

## 3. SEO & performance

### 3a. `seo audit`

Yoast/RankMath meta fields: missing meta, duplicate titles, length issues, missing canonicals, missing OG images.

### 3b. `seo bulk-meta` — AI-generated SEO metadata

Ollama-powered meta title and description generation for posts missing them.

### 3c. `lighthouse` — performance tracking

Lighthouse/PageSpeed against URLs. Track scores over time. Alert on regression.

**Effort:** High

### 3d. `cache warm`

Hit every public URL to prime caches after a deploy. Crawl the sitemap.

### 3e. `sitemap validate`

Fetch XML sitemap, validate URLs, find 404s, missing images in image sitemap.

### 3f. `schema audit`

Parse JSON-LD/microdata on pages. Find missing schema, invalid markup, schema that doesn't match page content.

### 3g. `core-web-vitals`

Pull CWV data from Google Search Console API. Correlate with localpress optimization history.

### 3h. `redirect manage`

Manage redirects via Yoast Premium / Redirection plugin REST APIs or WP-CLI. Find redirect chains, loops, broken targets.

### 3i. `robots.txt manage`

Read/write robots.txt. Validate against common issues.

---

## 4. Theme & plugin management

### 4a. `plugins list/activate/deactivate/update`

Plugin management via WP-CLI over SSH.

### 4b. `themes list/activate`

Switch themes, check active theme info.

### 4c. `plugins audit`

Outdated plugins, known vulnerabilities (WPScan API), inactive plugins, stale plugins (not updated in 2+ years).

### 4d. `scaffold`

Generate child themes, plugin boilerplate locally, push via SSH.

### 4e. `theme customize`

Manage theme customizer settings (colors, typography, layouts) via the Customizer REST API.

### 4f. `widgets manage`

Manage widget areas via REST API. Add/remove/configure widgets.

### 4g. `plugin-vulnerability-scan`

Scan installed plugins against WPScan vulnerability database. Flag critical CVEs that require immediate action.

---

## 5. Database & maintenance

### 5a. `db export/import`

WP database dump/restore via WP-CLI.

### 5b. `db search-replace`

Domain migrations (staging→production, http→https).

### 5c. `cleanup`

Remove old revisions, auto-drafts, trashed posts, spam comments, expired transients.

### 5d. `options get/set`

Read/write WordPress options.

### 5e. `cron list/run`

View and trigger WP cron jobs.

### 5f. `db optimize`

Run `wp db optimize` for table optimization, index rebuild.

### 5g. `db backup scheduled`

Scheduled incremental backups. Diff-based to avoid full dumps every time.

### 5h. `db health`

Table size analysis, slow query log parsing (if available), index usage stats.

### 5i. `cleanup orphans`

Beyond media orphans: post meta orphans, comment meta orphans, term relationships pointing to deleted posts.

---

## 6. Users & security

### 6a. `users list/create/update/delete`

User management via REST API.

### 6b. `users audit`

Weak-password admins (WP-CLI), dormant users, users with excessive capabilities, orphan users.

### 6c. `app-passwords rotate`

Generate new App Password, update config atomically.

### 6d. `security audit`

File permissions, wp-config.php exposure, debug mode in prod, directory listing, XML-RPC status.

### 6e. `2fa audit`

If WP 2FA plugin installed: find admins without 2FA enabled.

### 6f. `failed-logins`

Pull failed login attempts (if security plugin exposes via REST). Find brute-force patterns, block IPs.

### 6g. `capabilities check`

Verify user capabilities are set correctly. Find mis-configured roles.

---

## 7. Deployment & sync

### 7a. `sync` — bidirectional site sync

Two-way sync between sites. Media, posts, or both. Conflict detection via timestamps and hashes.

**Effort:** High | **Strategic value:** Very high

### 7b. `deploy`

Push theme/plugin files via SSH/SCP. Atomic with rollback.

### 7c. `backup full`

Combined db + media backup. Optional S3/R2 upload.

### 7d. `restore`

Reverse of backup.

### 7e. `diff sites`

Compare two configured sites: posts/media/plugins differences.

### 7f. `staging refresh`

Reset staging from production snapshot: sanitize emails, reset passwords, clear orders (for WooCommerce).

### 7g. `feature-branch`

Spin up a new WordPress instance from a production backup, apply changes, publish back when approved.

### 7h. `canary deploy`

Route X% of traffic to a canary site, monitor for errors, roll forward or back.

---

## 8. Multi-site & agency

### 8a. `sites run <command>` — cross-site execution

Run any command against all sites or a subset.

### 8b. `sites compare`

Cross-site library diff.

### 8c. `sites migrate <from> <to>`

Copy attachments/posts between sites. Handle URL rewriting.

### 8d. Per-site defaults

Site-specific default quality, format, concurrency in config.

### 8e. `sites dashboard`

Aggregated dashboard showing health of all configured sites: last audit, open issues, optimization coverage, traffic trends.

### 8f. `sites billing`

Per-site usage tracking for agency client billing. Hours/operations per site exportable as invoices.

### 8g. `sites onboard`

New client onboarding wizard: detect WP version, install recommended plugins, run baseline audit, create client-facing report.

---

## 9. AI & smart features

### 9a. `tag` — AI keyword tagging

Vision model generates descriptive tags. Writes to WP attachment taxonomy.

### 9b. `upscale` — AI super-resolution

Real-ESRGAN ONNX model. For legacy low-res content.

**Effort:** High

### 9c. `describe` — detailed image analysis

Objects, colors, OCR text, scene type. Richer than caption.

### 9d. `generate post` — AI content drafting

Ollama drafts a blog post from a prompt/outline.

### 9e. `summarize` — auto-excerpts

For posts missing an excerpt.

### 9f. `translate`

Translate posts/pages to another language. Create translations as drafts.

### 9g. `remove-bg --subject <type>`

Subject hints route to best model.

### 9h. `smart-crop`

Attention-based cropping for social cards.

### 9i. `rewrite` — AI content refinement

"Rewrite this for brevity" / "make this more formal" / "simplify for a 5th-grade reading level." Bulk-apply to posts.

### 9j. `headline-ab-test`

Generate multiple headline variants for a post. Track which drives most engagement.

### 9k. `internal-linking`

AI suggests internal links between posts based on semantic similarity.

### 9l. `content-gap`

Analyze the site's topic coverage. Suggest new post ideas to fill gaps.

### 9m. `voice-write`

Speak-to-post: dictate via microphone, Whisper transcribes, Ollama formats as a WordPress draft.

### 9n. `podcast-transcribe`

For podcast sites: auto-transcribe audio attachments, generate show notes.

---

## 10. Media processing enhancements

### 10a. `optimize --target-size <bytes>`

Binary-search quality to hit a target file size.

### 10b. `optimize --watermark <file>`

Composite a watermark onto attachments.

### 10c. `convert --to jxl` — JPEG XL

When browser support matures.

### 10d. `resize --crop <gravity>`

Smart cropping modes: center, attention, entropy.

### 10e. `remove-bg --feather <px>`

Gaussian blur on edge mask for natural look.

### 10f. `audit --exif` — privacy audit

GPS coords, device serials, author names without stripping.

### 10g. `audit --format-opportunities`

Rank JPEG/PNG by WebP/AVIF conversion savings.

### 10h. `optimize --strip-metadata` granular

`--keep-copyright`, `--keep-icc-profile`, `--strip-gps`.

### 10i. `blur` — privacy blur

Detect and blur faces/license plates in photos. Useful for press sites publishing public photos.

### 10j. `animate` — GIF optimization

Special pipeline for animated GIFs. Convert to animated WebP/AVIF for better compression.

### 10k. `video-thumbnail`

Extract frames from video attachments as thumbnails.

### 10l. `hdr-tonemap`

Tonemap HDR images to SDR for older browsers.

### 10m. `progressive-jpeg`

Convert JPEGs to progressive encoding for perceived performance.

### 10n. `lqip-generate`

Generate Low-Quality Image Placeholders for lazy loading. Store as base64 in post meta.

### 10o. `blurhash`

Generate BlurHash strings for smooth image loading UX.

### 10p. `dominant-color`

Extract dominant color for solid-color placeholders.

### 10q. `srcset-audit`

Verify every image's srcset is present and correctly sized. Find images that should have more thumbnail sizes.

---

## 11. Monitoring & reporting

### 11a. `report` — client reports

PDF/markdown: library health, SEO scores, performance, security.

### 11b. `--webhook <url>` — post-op notifications

Slack, Discord, email after bulk operations.

### 11c. `uptime check`

Ping site, log response times, alert on downtime.

### 11d. `changelog generate`

Auto-generated "what changed this week?" summary.

### 11e. `dashboard` — terminal dashboard

Live dashboard (Ink) showing all sites' health in real-time.

### 11f. `notify --on <event>`

Event-driven notifications: "notify me when stats.bytesSaved exceeds 10GB," "notify on any broken-ref audit finding."

### 11g. `slo` — service-level tracking

Track SLOs: 99.9% uptime, <200ms TTFB, CWV scores > 80. Report on compliance.

### 11h. `alerting`

Threshold-based alerts with escalation policies.

---

## 12. Distribution & ecosystem

### 12a. Scoop manifest (Windows)

Windows package manager parity.

### 12b. McpAdapter — third backend

Talk to a connected WP MCP server directly.

### 12c. VS Code extension

Media library panel, drag-drop optimize.

### 12d. Raycast extension

Quick actions from macOS Raycast.

### 12e. GitHub Action

`gfargo/localpress-action` for CI/CD pipelines.

### 12f. Skill marketplace

Claude skill marketplace, Cursor extension registry distribution.

### 12g. Alfred workflow

macOS Alfred workflow for power users.

### 12h. Chrome extension

Right-click any image on the web → "Upload to [site]" via localpress.

### 12i. Mac menu bar app

Status bar indicator with quick actions, notifications.

### 12j. Linux AppImage/Snap

Additional Linux distribution channels.

### 12k. Docker image

`localpress/localpress` Docker image for CI/CD and air-gapped environments.

---

## 13. E-commerce (WooCommerce)

### 13a. `products list/show/update`

WooCommerce product CRUD.

### 13b. `products bulk-image`

Assign and optimize product gallery images.

### 13c. `orders export`

Orders as CSV/JSON for accounting.

### 13d. `inventory audit`

Missing images, descriptions, SEO, stock issues.

### 13e. `products import`

Bulk product import from CSV/JSON, with image optimization.

### 13f. `variations manage`

Product variation management. Bulk price/stock updates.

### 13g. `customers export`

Customer data for CRM sync.

### 13h. `coupons manage`

Bulk coupon creation/expiration management.

### 13i. `woocommerce reports`

Sales reports, top products, low stock alerts.

### 13j. `shipping zones audit`

Verify shipping zones cover all target markets.

---

## 14. Developer experience

### 14a. `doctor --offline`

Offline-capable checks. Report what works without network.

### 14b. `test-site`

Spin up disposable WP via Docker with pre-configured App Password and sample media.

### 14c. `record` / `replay`

Record command sequences, replay for reproducible bug reports.

### 14d. `profile <command>`

Performance profiling. Where is time spent?

### 14e. `debug` mode

Verbose logging bundle for support tickets.

### 14f. `verify`

Re-fetch and cryptographically verify after uploads.

### 14g. `dev` — local WordPress hot-reload

Watch local theme/plugin files, auto-deploy to staging on save.

### 14h. `snapshot` — full-site state capture

Capture entire site state (db + files + config) for debugging reproduction.

### 14i. `mock`

Generate realistic fake data for development sites: posts, users, comments, orders.

### 14j. `visual-regression`

Screenshot key pages before/after changes, diff visually, report differences.

---

## 15. Comments & engagement

### 15a. `comments list/show/update/trash`

Comment management via REST.

### 15b. `comments moderate`

AI-powered spam detection with Ollama.

### 15c. `comments audit`

Banned domains, excessive links, spam patterns, orphans.

### 15d. `comments export`

Bulk export for GDPR compliance.

### 15e. `comments reply`

Quick reply to pending comments from CLI.

### 15f. `guestbook` — curated comments

Promote exceptional comments to featured display.

---

## 16. Analytics & insights

### 16a. `analytics`

Pull GA/Plausible/Matomo stats. Cross-reference with media library.

### 16b. `popular`

Top 20 images by traffic on posts they appear in.

### 16c. `gaps`

High-traffic pages with poor CWV scores.

### 16d. `trend`

Historical metric tracking: library size, optimization ratio, alt-text coverage.

### 16e. `heatmap`

If a heatmap plugin is configured, surface data: where users click on images.

### 16f. `conversion`

Track which image variants correlate with highest conversion on product pages.

### 16g. `cohort`

User cohort analysis from WooCommerce or membership plugins.

---

## 17. Block editor (Gutenberg)

### 17a. `blocks audit`

Deprecated blocks, missing required attributes, broken image blocks, old embed URLs.

### 17b. `blocks convert`

Classic editor → Gutenberg migration.

### 17c. `blocks inline-images`

Find external image URLs in blocks, import to library.

### 17d. `patterns export/import`

Block patterns as JSON. Share across sites.

### 17e. `block-usage`

Find every post using a specific block type. Plan block deprecation.

### 17f. `block-validate`

Validate saved block content matches block schema. Find broken blocks.

### 17g. `reusable-blocks cleanup`

Find unused reusable blocks, merge duplicates.

### 17h. `theme-json manage`

Edit theme.json for Full Site Editing themes. Bulk update tokens.

---

## 18. Page builder compatibility

### 18a. `elementor export/import`

Elementor templates as JSON with cross-site media translation.

### 18b. Bidirectional conversion

Gutenberg ↔ Elementor ↔ Divi conversion.

### 18c. `divi scan`

Find broken image references in Divi shortcodes.

### 18d. `beaver-builder` / `bricks` / `oxygen`

Similar scan/export/import for other page builders.

### 18e. `page-builder migration`

Cross-page-builder migration (Elementor → Gutenberg for sites moving off paid page builders).

---

## 19. Internationalization

### 19a. `i18n audit`

WPML/Polylang/TranslatePress: untranslated content.

### 19b. `i18n bulk-translate`

Ollama-powered translation with WPML/Polylang linking.

### 19c. `media localize`

Per-language media variants.

### 19d. `i18n terminology`

Consistency checks: is "color" translated the same way across all posts?

### 19e. `rtl audit`

Right-to-left layout audit for Arabic, Hebrew, Persian content.

### 19f. `locale-dates`

Verify dates are formatted per locale, not just strings.

---

## 20. Accessibility (beyond alt text)

### 20a. `a11y audit`

Heading hierarchy, color contrast, link text, form labels.

### 20b. `a11y fix`

Auto-fix: lang attribute, skip-to-content, empty link text.

### 20c. `a11y report`

WCAG compliance summary per page.

### 20d. `caption --detailed`

Extended descriptions for complex diagrams.

### 20e. `video-captions`

Auto-generate VTT caption files for video attachments via Whisper.

### 20f. `reading-level`

Flesch-Kincaid / SMOG scores per post. Flag content too complex for target audience.

### 20g. `aria audit`

Validate ARIA attributes on theme components, find common mistakes.

### 20h. `focus-order`

Tab order validation on key pages.

---

## 21. Custom post types & fields

### 21a. `cpt list/show`

Custom post types discovery.

### 21b. `acf audit`

Advanced Custom Fields: empty fields, broken image references, missing required.

### 21c. `meta search`

Find posts by custom meta key/value.

### 21d. `meta bulk-set`

Bulk custom field updates.

### 21e. `acf export/import`

ACF field groups as JSON. Share across sites.

### 21f. `pods` / `meta-box` / `toolset`

Similar integration for other field systems.

---

## 22. Forms & submissions

### 22a. `forms list`

List Gravity Forms / WPForms / Ninja Forms.

### 22b. `forms export`

Submissions as CSV.

### 22c. `forms cleanup`

GDPR-compliant retention policy enforcement.

### 22d. `forms audit`

Find forms with no entries, broken integrations, stale automations.

### 22e. `forms anonymize`

Hash/anonymize PII in old submissions while preserving statistics.

---

## 23. Compliance & legal

### 23a. `gdpr export <user>`

GDPR data export automation.

### 23b. `gdpr forget <user>`

Right-to-be-forgotten implementation.

### 23c. `cookies audit`

Cookie inventory for ePrivacy compliance.

### 23d. `copyright audit`

Reverse-image-search or EXIF copyright checks.

### 23e. `license tracker`

Track license info for third-party images. Flag expired licenses.

### 23f. `terms audit`

Detect when terms of service / privacy policy pages haven't been updated in 12+ months.

### 23g. `dmca-prepare`

Prepare DMCA takedown data from user uploads.

---

## 24. Remote access & mobile

### 24a. `share`

Temporary share links for local previews via cloudflared/ngrok.

### 24b. `qr <id>`

QR code to open attachment in WP admin on mobile.

### 24c. `daemon`

Long-running process with HTTP API.

### 24d. `tunnel`

Expose any local service via secure tunnel for remote review.

### 24e. `mobile-app-api`

HTTP API subset optimized for a potential companion mobile app.

---

## 25. Notifications & collaboration

### 25a. `notifications config`

Slack/Discord/Teams/email/Pushover setup.

### 25b. `approve`

Multi-user approval queue for operations.

### 25c. `comment`

Attach internal comments to attachments (SQLite, not WP).

### 25d. `mention`

Tag team members on items needing review.

### 25e. `todo`

Task list associated with specific attachments or posts.

### 25f. `handoff`

Transfer ownership of in-progress work between team members.

---

## 26. Workflow automation

### 26a. `recipe`

Multi-step YAML recipes for recurring workflows.

### 26b. `pipeline`

Unix-pipe semantics for command chaining.

### 26c. `triggers`

File-watcher triggers beyond `watch`.

### 26d. `stash`

Temporary work shelving.

### 26e. `workflow` — visual designer

Drag-drop workflow builder (eventually; CLI-first).

### 26f. `conditional`

Conditional execution: "if audit finds >10 issues, run cleanup."

### 26g. `retry policy`

Configurable retry strategies for network-dependent ops.

### 26h. `dependency-graph`

Model operations as a DAG. Parallelize independent work.

---

## 27. Image intelligence

### 27a. `ocr`

Extract text from images via Tesseract or vision model.

### 27b. `faces count`

Face detection for consent verification.

### 27c. `screenshot-detect`

Auto-detect screenshots for better compression routing.

### 27d. `color-palette`

Extract dominant colors as CSS variables.

### 27e. `content-classify`

Classify by type: product, screenshot, illustration, logo, diagram.

### 27f. `aesthetic-score`

ML-based "how good does this photo look?" scoring. Flag low-quality images.

### 27g. `similarity-cluster`

Cluster visually similar images beyond exact duplicates.

### 27h. `nsfw-detect`

NSFW content detection for moderation.

### 27i. `deepfake-detect`

Flag potentially AI-generated images (useful for news sites).

### 27j. `watermark-detect`

Find images that appear to have watermarks (other people's or stock photos).

### 27k. `stock-photo-detect`

Identify likely stock photos (via reverse search).

---

## 28. History & time-travel

### 28a. `timeline`

Visual timeline of all changes to an attachment.

### 28b. `blame`

"Who last touched this, when, why?"

### 28c. `rollback --date`

Time-travel restore to a specific date.

### 28d. `diff-versions`

Visual side-by-side diff between snapshots.

### 28e. `audit-log`

Complete activity log: every operation, every user, every target.

### 28f. `compliance-export`

Export history for compliance reports (who did what when).

---

## 29. Bulk operations at scale

### 29a. `queue`

Background queue with rate limiting.

### 29b. `rate-limit`

Per-site rate limits respecting host quotas.

### 29c. `batch`

Pre-compute plan, execute later.

### 29d. `distributed`

Distribute work across multiple machines for large libraries (10,000+ items).

### 29e. `resume`

Resume interrupted bulk operations from exact point of failure.

### 29f. `checkpoint`

Periodic state saves during long operations for crash recovery.

---

## 30. External service integrations

### 30a. `cdn invalidate`

Cloudflare/BunnyCDN/KeyCDN cache purge.

### 30b. `s3 mirror`

Mirror optimized media to S3-compatible storage.

### 30c. `figma import`

Pull images from Figma files.

### 30d. `canva sync`

Sync Canva-created images.

### 30e. `airtable sync`

Airtable ↔ WordPress media sync.

### 30f. `dropbox` / `google-drive` / `onedrive`

Cloud storage sync.

### 30g. `notion import`

Migrate from Notion databases to WordPress.

### 30h. `zapier trigger`

Trigger Zapier workflows from localpress events.

### 30i. `n8n webhook`

Bi-directional n8n integration.

### 30j. `ifttt`

IFTTT triggers for power users.

### 30k. `instagram import`

Auto-import Instagram posts as WordPress posts (for creators cross-posting).

### 30l. `unsplash fetch`

Pull images from Unsplash with attribution.

### 30m. `pexels fetch`

Same for Pexels.

### 30n. `cloudinary migrate`

Migrate from Cloudinary to local hosting. Preserve URLs via redirects.

### 30o. `imgix migrate`

Similar for Imgix.

---

## 31. Industry-specific flavors

### 31a. `news`

Reuters-style caption voice, auto photo credits from EXIF, sensitive content detection.

### 31b. `ecommerce`

White-bg removal, consistent crops, variation image generation.

### 31c. `portfolio`

Auto-watermark, grid layouts, lazy-load optimization.

### 31d. `blog`

Article-tuned: featured images for OG cards, inline images at content width.

### 31e. `real-estate`

HDR tonemap for listing photos, consistent aspect ratios, MLS-compliant watermarks.

### 31f. `wedding-photography`

Client gallery generation, bulk watermark with couple names, album PDF export.

### 31g. `nonprofit`

Donation CTA optimization, event image standards, testimonial media management.

### 31h. `restaurant`

Menu item image standards, food-specific color enhancement, social-ready crops.

### 31i. `podcast`

Episode artwork generation, transcript image export.

### 31j. `church`

Sermon media management, livestream archive optimization.

### 31k. `education`

Classroom-safe content filtering, consistent badge/certificate generation.

### 31l. `medical`

HIPAA-aware image handling, PII detection in patient content.

### 31m. `legal`

Redaction workflows, bates-numbered image exports.

---

## 32. Advanced AI workflows

### 32a. `improve`

Multi-step AI pipeline: enhance + caption + classify + tag in one call.

### 32b. `moderate`

NSFW/violence/weapons detection.

### 32c. `style-transfer`

Apply artistic style for brand consistency.

### 32d. `avatar-generate`

Consistent avatar generation for user profiles.

### 32e. `brand-consistency`

Verify uploaded images match brand guidelines (colors, style).

### 32f. `a-b-imagery`

Generate multiple variations of hero images, A/B test which converts.

### 32g. `seasonal-swap`

Bulk swap seasonal imagery (winter → spring) via AI variations.

### 32h. `character-consistency`

Generate character images (for fiction sites) with consistent appearance.

### 32i. `diagram-generate`

Generate technical diagrams from text descriptions via Mermaid/Graphviz/AI.

### 32j. `illustration-generate`

Text-to-image via Stable Diffusion (local) for blog illustrations.

---

## 33. Platform & developer tools

### 33a. `mcp-gateway`

Proxy multiple localpress instances as unified MCP endpoint.

### 33b. `plugin-generator`

Scaffold companion WP plugin for operations needing custom REST endpoints.

### 33c. `sdk <language>`

Generate SDKs: Python, Ruby, PHP, Go, Rust.

### 33d. `graphql`

GraphQL API server alternative to CLI/MCP.

### 33e. `webhooks receiver`

Listen for WP webhooks, trigger localpress operations.

### 33f. `event-bus`

Publish internal events to Kafka/NATS/RabbitMQ for enterprise integrations.

### 33g. `prometheus-metrics`

Expose metrics endpoint for Prometheus/Grafana monitoring.

### 33h. `opentelemetry`

Distributed tracing for enterprise debugging.

### 33i. `audit-log-siem`

Stream audit logs to SIEM systems (Splunk, Datadog).

### 33j. `policy-engine`

Define policies as code: "no images over 500KB can be uploaded to production."

### 33k. `terraform-provider`

Terraform provider for infrastructure-as-code WordPress management.

### 33l. `k8s-operator`

Kubernetes operator for orchestrating many WordPress instances.

### 33m. `cli-as-library`

Consume localpress as a library from other Bun/Node projects.

---

## 34. Quality of life

### 34a. `favorite <id>`

Star items for quick reference.

### 34b. `notes <id>`

Freeform notes (SQLite).

### 34c. `clipboard`

Upload clipboard image directly.

### 34d. `drop`

Desktop drag-drop zone.

### 34e. `history clear-failed`

Prune failed history only.

### 34f. `themes` — color theme for CLI

Customize Ink UI colors. Catppuccin, Dracula, Solarized presets.

### 34g. `emoji-off`

Minimal output mode for power users who hate emojis.

### 34h. `silent-success`

Only log failures, not successes, for massive bulk ops.

### 34i. `undo-confirm`

Interactive confirmation prompt for potentially destructive undos.

### 34j. `favorites-sync`

Sync favorites/notes across machines via git.

---

## 35. Meta / self-referential

### 35a. `skill-build`

Auto-generate `skill/SKILL.md` from current CLI state.

### 35b. `docs-build`

Regenerate wiki from --help output.

### 35c. `release-notes`

Auto-generate release notes from commits.

### 35d. `self-test`

Canonical e2e test suite.

### 35e. `feedback`

Submit feedback/bug reports directly from CLI.

### 35f. `analytics-opt-in`

Opt-in anonymous usage analytics to guide development.

### 35g. `survey`

Prompt users with occasional product surveys (rare, easy to disable).

### 35h. `releases subscribe`

Email/webhook on new localpress releases.

---

## 36. Longer-shot ideas

### 36a. **localpress Cloud** — managed service

Hosted version for users who don't want to run the CLI locally. Same capabilities, browser UI, pay-per-use compute.

### 36b. **localpress Hub** — multi-site SaaS dashboard

Central dashboard for agencies managing many sites. Aggregated health, cross-site operations.

### 36c. **localpress Mobile app**

iOS/Android companion for quick approval workflows, library browsing, remote triggering.

### 36d. **localpress Marketplace** — recipe/profile sharing

Community-shared optimization profiles, audit recipes, AI prompts. "Install the Pulitzer-winning news site's alt-text profile."

### 36e. **localpress CDN**

Opinionated CDN for media served through localpress. Auto-invalidation, smart caching, localization.

### 36f. **localpress Enterprise**

On-prem offering with SSO, audit compliance, policy engine, RBAC.

### 36g. **localpress Agents**

Pre-built specialized AI agents: "SEO Agent," "Accessibility Agent," "Performance Agent." Each does deep domain-specific work.

### 36h. **localpress Academy**

Educational content: video courses, certifications, case studies.

### 36i. **localpress Consulting**

Professional services: WordPress performance/accessibility audits powered by localpress.

### 36j. **localpress → WordPress competitor**

Eventually: a fork or rewrite of WordPress itself using the lessons from localpress. Reverse the polarity — the CLI is the platform, WP is the UI layer.

### 36k. **headless CMS**

Strip the WordPress dependency. Run localpress as a standalone media CMS with its own API.

### 36l. **localpress for other platforms**

Generalize: Drupal, Ghost, Strapi, Payload, Sanity adapters. "Local-compute CMS media optimization."

### 36m. **Non-media extensions**

Code → the same infrastructure could manage: static site assets, video platforms (Vimeo/YouTube APIs), documentation (GitBook/Notion).

### 36n. **Desktop-native GUI**

Tauri/Electron app wrapping the CLI with a rich visual interface. Progressive disclosure from drag-drop simplicity to full power-user mode.

### 36o. **Embedded mode**

Embed localpress's engine inside WordPress itself (as a plugin) for users who want local processing but can't install a CLI. Flips the model: WP calls the engine via wp-cron.

### 36p. **Training mode**

Use your own library to fine-tune custom models: optimization profiles tuned to your specific image style, caption voice matching your brand, classification tuned to your taxonomy.

---

## Priority framework

### Decision factors

1. **Leverages existing infrastructure** — REST adapter, WP-CLI, SQLite, MCP, Ollama
2. **Serves the primary audience** — solo devs and small agencies
3. **Differentiates from competitors** — local-first, AI-powered, agent-composable
4. **Compounds with existing features** — multiplies value, not just adds
5. **Protects the core narrative** — "Your laptop, your library"

### Suggested milestones

| Milestone | Theme | Key features |
| --------- | ----- | ------------ |
| v1.17 | MCP polish | search_by_url, bulk_metadata, health_check, cost_estimate |
| v1.18 | Media++ | --target-size, --watermark, resize --crop, audit --exif |
| v2.0 | Content | posts CRUD, content audit, posts export/import |
| v2.1 | SEO | seo audit, seo bulk-meta, sitemap validate, redirect manage |
| v2.2 | Multi-site | sites run, sites compare, sites migrate |
| v2.3 | Maintenance | db export/import, cleanup, plugins list/audit |
| v2.4 | Security | users audit, app-password rotate, security audit |
| v2.5 | A11y | a11y audit, a11y fix, video-captions |
| v3.0 | Full platform | sync, deploy, backup/restore, WooCommerce |
| v3.x | Integrations | cdn invalidate, figma/canva/airtable/notion sync |
| v4.0 | AI++ | upscale, translate, generate post, voice-write |
| v5.0 | Enterprise | policy-engine, audit-log-siem, k8s-operator |

### Design principles for expansion

- **CLI first, MCP second** — every feature ships as a CLI command, then gets a thin MCP tool wrapper
- **Local-first** — processing happens on the user's machine; remote site is a sync target
- **Safe by default** — bulk operations dry-run; destructive ops snapshot for undo
- **Composable** — each command does one thing well; agents chain them
- **No new runtime deps without justification** — Bun + sharp + ONNX + Ollama is the stack
- **JSON contract is public API** — `--json` shapes are stable; agents and scripts depend on them
- **Escape hatches always** — even opinionated commands accept overrides for edge cases
- **Teachable to agents** — every new capability should be obvious to an AI from schema alone

### Anti-patterns to avoid

- **Feature creep into identity theft** — don't become a CMS, don't replace WordPress
- **Cloud dependency** — no feature should require a SaaS backend unless explicitly opt-in
- **Lock-in** — everything should be exportable, migratable, reversible
- **UX soup** — don't expose every knob; use profiles and sensible defaults
- **Platform-specific branches** — keep cross-platform parity (macOS, Linux, Windows)
- **Breaking changes without majors** — respect semver religiously
