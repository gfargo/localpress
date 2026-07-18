# Site Briefing - Design

## Overview

`site_briefing` is a new read-only aggregation tool: one CLI command
(`localpress briefing`) plus one matching MCP tool (`site_briefing`). It
reuses logic already shipped in `audit` and `a11y` rather than
reimplementing any detection, adds a lightweight per-site cache so repeat
calls are fast, and adds one new capability — a local Ollama text pass that
turns the structured summary into a short plain-English narrative.

## Architecture

```
localpress briefing [--fresh] [--model <name>]
        │
        ▼
  cache check (SiteDb preferences table, key "briefing")
        │
   hit? ─┴─ no (or --fresh) ──► run categories in parallel:
   │                              - fetchAllMedia() + inline unoptimized/
   │                                missing-alt filters (mirrors audit.ts)
   │                              - detectBrokenRefs() (extracted from
   │                                audit.ts, now exported)
   │                              - resolver.tryResolve('prune-orphans')
   │                                → pruneOrphans() if available, else
   │                                skip with an "unavailable" note
   │                              - runA11yScan() (a11y.ts, already
   │                                exported)
   │                                        │
   │                                        ▼
   │                              structured summary (counts + top 5
   │                              examples per category)
   │                                        │
   │                                        ▼
   │                              Ollama narrative pass (generateText(),
   │                              new text-only wrapper in ollama.ts) —
   │                              skipped with a note if Ollama unreachable
   │                                        │
   │                                        ▼
   │                              write result + timestamp to cache
   └──────────────────────────────────────► return { summary, narrative,
                                               cachedAt, fresh }
```

Categories aggregated ("always available" — ship regardless of what else
lands this session):

| Category | Source | Capability required |
|---|---|---|
| Unoptimized images | same check as `audit --unoptimized` | REST (always) |
| Missing alt text | same check as `audit --missing-alt` | REST (always) |
| Broken content references | same check as `audit --broken-refs` | REST (always) |
| Orphaned media | same check as `audit --orphans` | WP-CLI (optional) |
| Accessibility issues | `runA11yScan` from `a11y.ts` | REST (always) |

Categories explicitly **not** aggregated: `--duplicates` and
`--quality`/`--ocr-text` from `audit` (all three fetch full image bytes per
item — too slow for an interactive Kiro round-trip). SEO audit /
duplicate-content detection are "available if built this session" — the
aggregator checks for their presence and includes them only if present.

## Components and Interfaces

- `src/cli/commands/briefing.ts` — `registerBriefingCommand(program)`,
  registered in `src/cli/index.ts` alongside `a11y`/`audit`. Exports
  `runBriefing`, `runMediaChecks`, `runA11yCheck`, `runOrphansCheck`,
  `synthesizeNarrative` individually so both the MCP tool and unit tests can
  drive the aggregation directly without shelling out.
- `src/cli/mcp/tools.ts` — `site_briefing` tool, modeled on the existing
  `health_check` composite tool in the same file, but deeper: `health_check`
  runs three raw CLI calls and returns them un-synthesized (no narrative, no
  caching); `site_briefing` adds caching and the Ollama synthesis pass. Just
  builds `['briefing']` argv with `--fresh`/`--model` and calls the existing
  generic `runCli()` helper — no changes needed to `invoke.ts`.
- `src/cli/commands/audit.ts` — `detectBrokenRefs` and `fetchAllMedia`
  exported (were module-private) so `briefing.ts` can reuse them.
- `src/engine/caption/ollama.ts` — new `generateText(prompt, options)`
  sibling of `generateCaption`, same `/api/generate` endpoint and
  timeout/error handling, no image payload.
- `src/engine/state/db.ts` — no schema change. The existing `preferences`
  key-value table (site-scoped, schema v2) fits: `setPref(site, 'briefing',
  JSON.stringify(result))` / `getPref(site, 'briefing')`. The cached value
  embeds its own `generatedAt` timestamp.

## Data Models

```typescript
interface CategorySummary {
  count: number;
  examples: string[];
  available: boolean;
  unavailableReason?: string;
  /** Informational note when the check ran but only over a bounded subset (not an error). */
  note?: string;
}

interface BriefingResult {
  site: string;
  generatedAt: string;
  fresh: boolean;
  categories: {
    unoptimized: CategorySummary;
    missingAlt: CategorySummary;
    brokenRefs: CategorySummary;
    orphans: CategorySummary;
    a11y: CategorySummary;
  };
  totalIssues: number;
  clean: boolean;
  narrative: string | null;
  narrativeUnavailable: boolean;
}
```

## Error Handling

- **Per-category isolation**: each category check (`runMediaChecks`,
  `runA11yCheck`, `runOrphansCheck`) catches its own errors and reports
  `available: false` with `unavailableReason` rather than letting one
  category's failure abort the whole call.
- **Broken-refs is bounded, not unbounded (Requirement 2.2)**: `detectBrokenRefs`
  does up to 4 full post/page collection scans per attachment
  (`RestAdapter.findReferences`), which is O(items × posts). Discovered via
  live-testing against a 412-attachment site that this took minutes
  unbounded. Capped to the first 30 attachments (`BROKEN_REFS_SCAN_LIMIT`),
  with a `note` on the category when truncated pointing to
  `localpress audit --broken-refs` for a full scan.
- **Orphan scan is time-boxed, not unbounded (Requirement 2.1, 2.2)**: WP-CLI
  over SSH can hang or run long on a slow connection or large uploads
  directory. Wrapped in a 20-second `Promise.race` timeout
  (`ORPHANS_TIMEOUT_MS`); on timeout the category reports
  `available: false` with a clear reason instead of blocking the rest of
  the briefing.
- **Ollama unreachable**: `isOllamaAvailable()` checked before attempting
  the narrative pass. If unreachable, `narrative: null` and
  `narrativeUnavailable: true` — the structured summary is still returned
  in full.
- **Corrupt cache entry**: a `JSON.parse` failure on the cached value falls
  through to a live run rather than throwing.

## Testing Strategy

`test/unit/briefing.test.ts`, exercising the exported sub-functions directly
against fake adapters / mocked `fetch` (no live network):

- `runMediaChecks` — counts unoptimized/missing-alt correctly against a fake
  `WpBackend`; marks all three media categories unavailable (not throwing)
  on an adapter failure.
- `runOrphansCheck` — reports `available: false` with a WP-CLI-specific
  reason on a REST-only site (no SSH configured).
- `runA11yCheck` — zero findings on a clean mocked scan; surfaces real
  findings from a mocked scan.
- `synthesizeNarrative` — returns the canned clean message without needing
  Ollama when `totalIssues` is 0; marks the narrative unavailable (not an
  error) when Ollama is unreachable.

Manual smoke test against a real WordPress site (`wp.griffen.codes`, 412
attachments / 43 posts) is documented in tasks.md item 8 — this is what
surfaced the broken-refs/orphan-scan performance issues that the Error
Handling section above addresses. Mocked-fetch unit tests alone didn't catch
this real-world scale problem.
