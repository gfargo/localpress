# Accessibility Audit

Backfilled spec documenting already-shipped functionality.

## Overview

The `a11y` command (shipped in v2.0.0) audits a WordPress site's post and page content for common WCAG accessibility issues. It fetches rendered post/page content over the REST API, runs a set of regex-based HTML checks against it, and reports structured findings — without requiring a WordPress plugin, a headless browser, or a cloud service. It exists so that content editors and AI agents can catch accessibility regressions (bad link text, missing image alt text, broken heading hierarchy) as part of routine content maintenance, using the same site connection (Application Password over REST) that the rest of localpress already relies on. It is exposed identically to human CLI users and to MCP-speaking agents via the `a11y_audit` MCP tool.

## Requirements

### Requirement 1: Scan published content for accessibility issues by default

**User Story:** As a site editor, I want to run a single command that checks my published posts and pages for accessibility problems, so that I can find and fix issues without manually reviewing every page's HTML.

**Acceptance Criteria:**
- WHEN `localpress a11y` is run with no options THE SYSTEM SHALL check both posts and pages with `status=publish`, up to a default limit of 100 posts.
- WHEN the scan completes with no findings and no errors THE SYSTEM SHALL report "No accessibility issues found" (or the JSON equivalent) rather than an empty/ambiguous result.
- WHEN findings exist THE SYSTEM SHALL group and count them by finding type (heading-skip, multiple-h1, generic-link-text, missing-img-alt, empty-link) in both human-readable and `--json` output.

### Requirement 2: Detect heading hierarchy problems

**User Story:** As a site editor, I want the audit to flag broken heading structure, so that screen reader users can navigate content by heading level without confusion.

**Acceptance Criteria:**
- WHEN a post/page's rendered content contains more than one `<h1>` element THE SYSTEM SHALL emit a `multiple-h1` finding naming the count found.
- WHEN heading levels in document order skip more than one level (e.g. `<h2>` directly followed by `<h4>`) THE SYSTEM SHALL emit a `heading-skip` finding identifying the skipped level.
- WHEN heading levels increase by exactly one, stay the same, or decrease THE SYSTEM SHALL NOT emit a heading-skip finding for that transition.

### Requirement 3: Detect non-descriptive and empty link text

**User Story:** As a site editor, I want the audit to flag links whose text doesn't describe their destination, so that users relying on assistive technology (which often lists links out of context) can understand where each link goes.

**Acceptance Criteria:**
- WHEN an `<a>` element's visible text (after stripping nested tags and normalizing case/whitespace) matches a known generic phrase (e.g. "click here", "read more", "learn more", "here", "more", "link", "this", "this link", "go", "see more", "details", "info", "continue", "continue reading") THE SYSTEM SHALL emit a `generic-link-text` finding including the matched text and a truncated snippet of the source tag.
- WHEN an `<a>` element has no visible text content AND has no `aria-label` attribute AND does not contain an `<img>` element THE SYSTEM SHALL emit an `empty-link` finding.
- IF an otherwise-empty `<a>` element contains an `<img>` element or carries an `aria-label` THEN THE SYSTEM SHALL NOT emit an `empty-link` finding for it (image links and aria-labeled links are treated as having accessible names).

### Requirement 4: Detect images missing alt attributes

**User Story:** As a site editor, I want the audit to flag inline content images that have no `alt` attribute at all, so that I can add descriptive (or intentionally empty, for decorative images) alt text.

**Acceptance Criteria:**
- WHEN an `<img>` tag in post/page content has no `alt=` attribute present at all THE SYSTEM SHALL emit a `missing-img-alt` finding.
- IF an `<img>` tag has `alt=""` (empty but present) THEN THE SYSTEM SHALL NOT flag it, treating an explicit empty alt as an intentional decorative-image marker per WCAG guidance.

### Requirement 5: Scope the scan by post type, status, single ID, and limit

**User Story:** As a site editor or agent, I want to narrow an accessibility scan to a specific post type, status, single item, or bounded number of items, so that I can target a specific piece of content or keep large-site scans fast and predictable.

**Acceptance Criteria:**
- WHEN `--type post` is passed THE SYSTEM SHALL check only the `posts` collection; WHEN `--type page` is passed THE SYSTEM SHALL check only the `pages` collection; WHEN `--type` is omitted THE SYSTEM SHALL check both.
- WHEN `--status <status>` is passed THE SYSTEM SHALL request that post status from the REST API instead of the default `publish`.
- WHEN `--id <id>` is passed THE SYSTEM SHALL check only that single post/page (probing each requested post type collection for the ID) instead of paginating through a collection.
- WHEN `--limit <n>` is passed THE SYSTEM SHALL stop checking further posts once `n` posts have been checked, across all requested post types combined, and shall report the scan as incomplete/truncated for any post type where the limit was hit before all pages were retrieved.

### Requirement 6: Surface scan errors and partial results honestly

**User Story:** As a site editor or agent, I want to know when the audit could not fully scan the site (network failure, auth failure, HTTP error), so that I don't mistake an incomplete scan for a clean bill of health.

**Acceptance Criteria:**
- WHEN a REST request for a post-type page fails (non-2xx response or thrown fetch error) THE SYSTEM SHALL record the failure (URL, post type, and status code or error message) and stop paginating that post type, without discarding findings already collected for other posts.
- WHEN one post type's request fails but another succeeds THE SYSTEM SHALL still report findings and post counts for the post type that succeeded.
- IF `--id` is set and a lookup 404s for one post type but succeeds for another type THEN THE SYSTEM SHALL NOT report the 404 as an error, since the ID search simply tried multiple collections to locate the post.
- IF `--id` is set and the lookup fails or 404s for every requested post type THEN THE SYSTEM SHALL report an error.
- WHEN the scan has any unfiltered errors THE SYSTEM SHALL set the CLI process exit code to the network-error exit code and mark the JSON result's `complete` field `false`.
- WHEN `--limit` truncates a post type's scan before all pages were retrieved THE SYSTEM SHALL list that post type in a `truncated` array and mark `complete` as `false`, even if zero errors occurred.

### Requirement 7: Provide stable, agent-consumable JSON output

**User Story:** As an AI agent (via the skill or the MCP server), I want `a11y --json` to return a stable, structured shape, so that I can programmatically parse findings, counts, and completeness without scraping human-readable text.

**Acceptance Criteria:**
- WHEN `--json` is passed THE SYSTEM SHALL emit a single JSON object containing `site`, `postsChecked`, `findings` (array of `{type, postId, postTitle, detail, element?}`), `summary` (counts per finding type), `errors`, `truncated`, and `complete`.
- WHEN `--json` is passed and errors occurred THE SYSTEM SHALL still emit the full JSON object (not just an error message) so agents can inspect partial results alongside the errors.

### Requirement 8: Expose the audit to MCP-speaking agents

**User Story:** As an AI agent connected via MCP rather than shelling out to the CLI, I want an `a11y_audit` tool with the same scoping options as the CLI command, so that I can run accessibility audits as part of an automated workflow.

**Acceptance Criteria:**
- WHEN the MCP server registers its tools THE SYSTEM SHALL expose an `a11y_audit` tool accepting `site`, `type` (enum: post/page/both), `status`, `id`, and `limit` parameters mirroring the CLI flags.
- WHEN the `a11y_audit` tool is invoked THE SYSTEM SHALL translate its arguments into the equivalent `localpress a11y` CLI invocation (forcing `--json` and `--quiet`) and return the parsed JSON result (or a structured error) to the calling agent.
