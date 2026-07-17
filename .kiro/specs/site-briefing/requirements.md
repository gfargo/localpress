# Site Briefing - Requirements

## Introduction

localpress already ships individual checks for media (`audit`) and content
(`a11y`) health, but an agent (or a human working through Kiro) that wants to
know "what does my WordPress site need today" has to run several of them
separately and stitch the raw findings together itself. Site Briefing is a
new read-only MCP tool (and matching CLI command) that aggregates every check
localpress already knows how to run into one structured summary, plus a short
plain-English narrative synthesized by a local Ollama text pass — no cloud
API. Priority: P0, flagship for the Kiro Birthday Week Day 5 (Custom MCP
Integration) challenge.

## Requirements

### Requirement 1: Aggregated health summary

**User Story:** As an agent connected to a WordPress site via MCP, I want to
ask "what does my site need today" and get one synthesized answer, so that I
don't have to run several audits myself and stitch the results together.

#### Acceptance Criteria

1. WHEN `site_briefing` is called with no arguments THEN the system SHALL
   aggregate results from every check it has access to on the active site:
   unoptimized images, missing alt text, orphaned media, broken content
   references, and accessibility (a11y) issues.
2. WHEN the aggregation completes THEN the system SHALL produce a structured
   JSON summary containing a count and up to 5 example items per category.
3. WHEN every category comes back clean THEN the system SHALL report that
   plainly rather than returning an empty-looking summary the caller has to
   interpret themselves.

### Requirement 2: Graceful degradation when a capability is unavailable

**User Story:** As a site owner whose site is REST-only (no WP-CLI/SSH), I
want the briefing to still succeed on the checks it can run, so that missing
one capability doesn't block the whole report.

#### Acceptance Criteria

1. IF a check requires a capability that isn't available for the site (e.g.
   WP-CLI for orphan scanning) THEN the system SHALL mark that category as
   unavailable with a human-readable reason instead of failing the call.
2. IF a check would take longer than is reasonable for an interactive call
   (e.g. a broken-references scan across a large media library, or a WP-CLI
   orphan scan over a slow SSH connection) THEN the system SHALL bound or
   time-box that check and note the bound/timeout rather than blocking
   indefinitely.

### Requirement 3: Plain-English narrative synthesis

**User Story:** As the human behind the agent, I want a short narrative
alongside the raw numbers, so that I can understand priority at a glance
instead of parsing a JSON blob.

#### Acceptance Criteria

1. WHEN the structured summary is non-empty AND a local Ollama instance is
   reachable THEN the system SHALL synthesize a short (3-5 sentence)
   plain-English narrative from that summary, ordered by what matters most.
2. IF Ollama is not reachable THEN the system SHALL still return the full
   structured summary, with the narrative field explicitly marked
   unavailable — the call SHALL NOT fail just because the narrative
   couldn't be generated.
3. WHEN every category is clean (zero total issues) THEN the system SHALL
   return a canned "all clear" narrative without requiring an Ollama call.

### Requirement 4: Fast repeat calls via caching

**User Story:** As an agent making repeated briefing calls in one session, I
want a cached result to come back quickly, so that the tool stays usable in
an interactive back-and-forth instead of re-scanning the whole site every
time.

#### Acceptance Criteria

1. WHEN `site_briefing` is called without `--fresh` AND a cached briefing
   exists for the site THEN the system SHALL return the cached result
   together with its original generation timestamp, without re-running any
   checks.
2. WHEN `site_briefing` is called with `--fresh` THEN the system SHALL
   re-run every available check live and overwrite the cache with the new
   result.

### Requirement 5: Read-only safety

**User Story:** As a site owner, I want to be certain a health-check tool
can't accidentally modify my content, so that I can let an agent call it
freely without review.

#### Acceptance Criteria

1. THE SYSTEM SHALL NOT write anything to WordPress under any input — `site_briefing` is a read-only aggregation and analysis tool only.

## Out of Scope

- Duplicate-content and SEO-audit categories (aggregated only if those tools
  are also built this session — see design.md for how the aggregator
  degrades gracefully without them).
- Scheduled/proactive briefings (push notifications).
- Trend-over-time analysis across multiple briefings.
