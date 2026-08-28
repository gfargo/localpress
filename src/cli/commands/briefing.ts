/**
 * `localpress briefing` — aggregate every check localpress already knows how
 * to run (unoptimized images, missing alt text, broken content references,
 * orphaned media, accessibility issues) into one structured summary plus a
 * short plain-English narrative synthesized by a local Ollama text pass.
 *
 * Read-only: nothing is written to WordPress. Results are cached per-site
 * (via the existing `preferences` key-value table) so repeat calls are fast;
 * pass --fresh to bypass the cache and re-run every check live.
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import { generateText, isOllamaAvailable } from '../../engine/caption/ollama.ts';
import { OPTIMIZE_OPERATIONS, SiteDb } from '../../engine/state/db.ts';
import { ExitCode } from '../../types.ts';
import type { SiteConfig } from '../../types.ts';
import { getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { info, printJson } from '../utils/output.ts';
import { runA11yScan } from './a11y.ts';
import { detectBrokenRefs, fetchAllMedia } from './audit.ts';

const CACHE_KEY = 'briefing';
/** Cap on how many posts/pages the a11y sub-scan checks — keeps the call interactive. */
const A11Y_SCAN_LIMIT = 100;
/**
 * Cap on how many media items get a broken-refs check. Each check does up to
 * 4 full post/page collection scans (see `RestAdapter.findReferences`), so
 * this is O(items × posts) — unbounded, it can take minutes on a library of
 * a few hundred attachments. Bounded the same way a11y bounds its post scan.
 */
const BROKEN_REFS_SCAN_LIMIT = 30;
/** Hard cap on the WP-CLI orphan scan so a slow/hung SSH connection can't block the whole briefing. */
const ORPHANS_TIMEOUT_MS = 5_000;

export interface CategorySummary {
  count: number;
  examples: string[];
  available: boolean;
  unavailableReason?: string;
  /**
   * Present whenever `available === false`. `not-configured` means the check
   * was never expected to run here (e.g. orphans without SSH) — this does
   * NOT count as degradation. `error` means the check should have run but
   * failed (network down, scan threw, etc.) — this DOES count as degradation.
   */
  unavailableKind?: 'not-configured' | 'error';
  /** Informational note when the check ran but only over a bounded subset (not an error). */
  note?: string;
}

export interface BriefingResult {
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
  /** True only when every category either ran successfully or was not-configured (never errored). */
  complete: boolean;
  /** True when at least one category that should have run failed to. */
  degraded: boolean;
  narrative: string | null;
  narrativeUnavailable: boolean;
}

export function registerBriefingCommand(program: Command): void {
  program
    .command('briefing')
    .description(
      "Aggregate every check localpress knows how to run into one plain-English + structured summary — answers 'what does my site need today?'",
    )
    .option('--fresh', 'bypass the cache and re-run every check live')
    .option(
      '--model <name>',
      'Ollama model for the narrative pass (default: config default or moondream)',
    )
    .action(async (options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);

      const db = SiteDb.init(getSiteDbPath(site.name));
      db.ensureSite(site.name, site.url);

      if (!options.fresh) {
        const cached = db.getPref(site.name, CACHE_KEY);
        if (cached) {
          try {
            const parsed = JSON.parse(cached) as BriefingResult;
            if (isCacheEntryUsable(parsed)) {
              db.close();
              const cachedResult = { ...parsed, fresh: false };
              process.exitCode = briefingExitCode(cachedResult);
              printBriefing(parentOpts.json, cachedResult);
              return;
            }
          } catch {
            // Corrupt cache entry — fall through to a live run.
          }
        }
      }

      const model: string = options.model ?? config.defaults?.captionModel ?? 'moondream';
      const result = await runBriefing(site, db, model);
      // Don't memoize a degraded/failed run — a transient network blip
      // shouldn't be cached and served back as the site's health forever.
      // Also skip caching when the narrative couldn't be generated (Ollama down).
      if (result.complete && !result.narrativeUnavailable) {
        db.setPref(site.name, CACHE_KEY, JSON.stringify(result));
      }
      db.close();
      process.exitCode = briefingExitCode(result);
      printBriefing(parentOpts.json, result);
    });
}

/** Extracted so `site_briefing` (MCP) and tests can drive the aggregation directly. */
export async function runBriefing(
  site: SiteConfig,
  db: SiteDb,
  model: string,
): Promise<BriefingResult> {
  const resolver = new AdapterResolver(site);
  const adapter = resolver.resolve('list');

  const [mediaResult, a11yResult, orphansResult] = await Promise.all([
    runMediaChecks(adapter, db, site.name),
    runA11yCheck(site),
    runOrphansCheck(resolver),
  ]);

  const categories = {
    unoptimized: mediaResult.unoptimized,
    missingAlt: mediaResult.missingAlt,
    brokenRefs: mediaResult.brokenRefs,
    orphans: orphansResult,
    a11y: a11yResult,
  };

  const totalIssues = Object.values(categories).reduce((sum, c) => sum + c.count, 0);
  const complete = Object.values(categories).every(
    (c) => c.available || c.unavailableKind === 'not-configured',
  );
  const degraded = !complete;

  const { narrative, narrativeUnavailable } = await synthesizeNarrative(
    site.name,
    categories,
    totalIssues,
    model,
    degraded,
  );

  return {
    site: site.name,
    generatedAt: new Date().toISOString(),
    fresh: true,
    categories,
    totalIssues,
    clean: totalIssues === 0 && complete,
    complete,
    degraded,
    narrative,
    narrativeUnavailable,
  };
}

/**
 * Non-zero only on total failure — every category unavailable and at least
 * one of those was a genuine error (not just "not configured"). A partial
 * degradation (e.g. a11y down, media checks fine) stays exit 0 but is
 * flagged via `degraded: true` in the JSON output.
 */
function briefingExitCode(result: BriefingResult): number {
  const cats = Object.values(result.categories);
  const totalFailure =
    cats.every((c) => !c.available) && cats.some((c) => c.unavailableKind === 'error');
  return totalFailure ? ExitCode.NetworkError : ExitCode.Success;
}

/**
 * A cache entry is usable if it has the expected shape, is not degraded,
 * and hasn't expired. Cache TTL is 1 hour — fresh enough that re-running
 * gives current data, short enough that transient false-cleans don't persist.
 */
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function isCacheEntryUsable(parsed: BriefingResult): boolean {
  if (typeof parsed.complete !== 'boolean' || typeof parsed.degraded !== 'boolean') return false;
  // Reject degraded or narrative-failed entries (defense in depth — the write
  // guard should already prevent these from being cached).
  if (parsed.degraded || parsed.narrativeUnavailable) return false;
  // TTL check.
  if (parsed.generatedAt) {
    const age = Date.now() - new Date(parsed.generatedAt).getTime();
    if (age > CACHE_TTL_MS) return false;
  }
  return true;
}

// -- Category checks -----------------------------------------------------------

export async function runMediaChecks(
  adapter: ReturnType<AdapterResolver['resolve']>,
  db: SiteDb,
  siteName: string,
): Promise<{
  unoptimized: CategorySummary;
  missingAlt: CategorySummary;
  brokenRefs: CategorySummary;
}> {
  let items: Awaited<ReturnType<typeof fetchAllMedia>>;
  try {
    items = await fetchAllMedia(adapter);
  } catch (err) {
    // Nothing below can proceed without the media list — all three
    // categories genuinely depend on this.
    const unavailable: CategorySummary = {
      count: 0,
      examples: [],
      available: false,
      unavailableKind: 'error',
      unavailableReason: err instanceof Error ? err.message : String(err),
    };
    return {
      unoptimized: unavailable,
      missingAlt: { ...unavailable },
      brokenRefs: { ...unavailable },
    };
  }

  // Each of the three checks below is isolated so a failure in one (e.g. a
  // locked local SQLite file) doesn't blank out categories that don't
  // actually depend on it.
  let unoptimized: CategorySummary;
  try {
    const processedIds = db.listProcessedWpIds(siteName, OPTIMIZE_OPERATIONS);
    const unoptimizedItems = items.filter((i) => !processedIds.has(i.id));
    unoptimized = {
      count: unoptimizedItems.length,
      examples: unoptimizedItems.slice(0, 5).map((i) => i.filename),
      available: true,
    };
  } catch (err) {
    unoptimized = {
      count: 0,
      examples: [],
      available: false,
      unavailableKind: 'error',
      unavailableReason: err instanceof Error ? err.message : String(err),
    };
  }

  const missingAltItems = items.filter((i) => !i.altText || i.altText.trim() === '');
  const missingAlt: CategorySummary = {
    count: missingAltItems.length,
    examples: missingAltItems.slice(0, 5).map((i) => i.filename),
    available: true,
  };

  let brokenRefs: CategorySummary;
  try {
    const brokenRefCandidates = items.slice(0, BROKEN_REFS_SCAN_LIMIT);
    const brokenRefFindings = await detectBrokenRefs(brokenRefCandidates, adapter);
    const brokenRefsTruncated = items.length > BROKEN_REFS_SCAN_LIMIT;
    brokenRefs = {
      count: brokenRefFindings.length,
      examples: brokenRefFindings.slice(0, 5).map((f) => f.filename),
      available: true,
      note: brokenRefsTruncated
        ? `Checked ${BROKEN_REFS_SCAN_LIMIT} of ${items.length} attachments (bounded for interactive use) — run \`localpress audit --broken-refs\` for a full scan.`
        : undefined,
    };
  } catch (err) {
    brokenRefs = {
      count: 0,
      examples: [],
      available: false,
      unavailableKind: 'error',
      unavailableReason: err instanceof Error ? err.message : String(err),
    };
  }

  return { unoptimized, missingAlt, brokenRefs };
}

export async function runA11yCheck(site: SiteConfig): Promise<CategorySummary> {
  try {
    const baseUrl = site.url.replace(/\/+$/, '');
    const auth = `Basic ${btoa(`${site.username}:${site.appPassword}`)}`;
    const result = await runA11yScan({
      baseUrl,
      auth,
      types: ['posts', 'pages'],
      status: 'publish',
      limit: A11Y_SCAN_LIMIT,
    });

    if (result.errors.length > 0) {
      return {
        count: 0,
        examples: [],
        available: false,
        unavailableKind: 'error',
        unavailableReason: `${result.errors.length} request(s) failed — could not scan content for accessibility issues.`,
      };
    }

    return {
      count: result.findings.length,
      examples: result.findings.slice(0, 5).map((f) => `"${f.postTitle}": ${f.detail}`),
      available: true,
      note:
        result.truncated.length > 0
          ? `Scan reached the ${A11Y_SCAN_LIMIT}-post limit before finishing: ${result.truncated.join(', ')}.`
          : undefined,
    };
  } catch (err) {
    return {
      count: 0,
      examples: [],
      available: false,
      unavailableKind: 'error',
      unavailableReason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runOrphansCheck(resolver: AdapterResolver): Promise<CategorySummary> {
  const pruneAdapter = resolver.tryResolve('prune-orphans');
  if (!pruneAdapter) {
    return {
      count: 0,
      examples: [],
      available: false,
      unavailableKind: 'not-configured',
      unavailableReason: 'Requires WP-CLI over SSH — configure SSH access for this site to enable.',
    };
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      pruneAdapter.pruneOrphans(),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () =>
            reject(new Error(`WP-CLI orphan scan timed out after ${ORPHANS_TIMEOUT_MS / 1000}s`)),
          ORPHANS_TIMEOUT_MS,
        );
      }),
    ]);
    return {
      count: result.orphanFiles.length,
      examples: result.orphanFiles.slice(0, 5),
      available: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes('timed out');
    return {
      count: 0,
      examples: [],
      available: false,
      // Timeouts are expected in a quick-overview context — don't degrade the briefing.
      unavailableKind: isTimeout ? 'not-configured' : 'error',
      unavailableReason: isTimeout
        ? `Orphan scan skipped (did not complete within ${ORPHANS_TIMEOUT_MS / 1000}s)`
        : message,
    };
  } finally {
    // Without this, a fast orphan scan (finishing well before the timeout)
    // leaves the timer pending and keeps the CLI process alive for up to
    // ORPHANS_TIMEOUT_MS after everything else has already completed.
    clearTimeout(timeoutHandle);
  }
}

// -- Narrative synthesis --------------------------------------------------------

export async function synthesizeNarrative(
  siteName: string,
  categories: BriefingResult['categories'],
  totalIssues: number,
  model: string,
  degraded = false,
): Promise<{ narrative: string | null; narrativeUnavailable: boolean }> {
  // A clean result doesn't need an LLM to say so — but only if every check
  // actually ran. A degraded run with 0 counted issues means the checks that
  // failed contributed nothing, not that they found nothing.
  if (totalIssues === 0) {
    if (degraded) {
      return {
        narrative: `Could not complete the briefing for '${siteName}' — one or more checks failed to run (see the unavailable categories above), so nothing can be concluded about the site's health.`,
        narrativeUnavailable: false,
      };
    }
    return {
      narrative: `Everything checked out clean on '${siteName}' — no unoptimized images, missing alt text, broken references, orphaned files, or accessibility issues found.`,
      narrativeUnavailable: false,
    };
  }

  if (!(await isOllamaAvailable())) {
    return { narrative: null, narrativeUnavailable: true };
  }

  const summaryLines = Object.entries(categories)
    .filter(([, c]) => c.available)
    .map(
      ([name, c]) =>
        `- ${name}: ${c.count} issue(s)${c.examples.length ? ` (e.g. ${c.examples.slice(0, 3).join(', ')})` : ''}`,
    )
    .join('\n');

  const skipped = Object.entries(categories)
    .filter(([, c]) => !c.available)
    .map(([name]) => name);

  const prompt = `You are triaging a WordPress site's health for its owner. Given this structured summary of issues found, write a short plain-English briefing (3-5 sentences) ordered by what matters most. Be direct and specific, no fluff, no markdown headers.\n\nSite: ${siteName}\nTotal issues: ${totalIssues}\n${summaryLines}${skipped.length ? `\n\nNot checked (unavailable): ${skipped.join(', ')}` : ''}`;

  try {
    const result = await generateText(prompt, { model });
    return { narrative: result.text, narrativeUnavailable: false };
  } catch {
    return { narrative: null, narrativeUnavailable: true };
  }
}

// -- Output ----------------------------------------------------------------------

function printBriefing(json: boolean, result: BriefingResult): void {
  if (json) {
    printJson(result);
    return;
  }

  const cacheNote = result.fresh ? '' : ' (cached)';
  info(`Site briefing for '${result.site}'${cacheNote} — generated ${result.generatedAt}\n`);

  const labels: Record<keyof BriefingResult['categories'], string> = {
    unoptimized: 'Unoptimized images',
    missingAlt: 'Missing alt text',
    brokenRefs: 'Broken content references',
    orphans: 'Orphaned media',
    a11y: 'Accessibility issues',
  };

  for (const [key, label] of Object.entries(labels) as Array<
    [keyof BriefingResult['categories'], string]
  >) {
    const c = result.categories[key];
    if (!c.available) {
      info(`  ${label}: unavailable (${c.unavailableReason})`);
      continue;
    }
    info(`  ${label}: ${c.count}`);
    for (const example of c.examples) info(`    ${example}`);
    if (c.note) info(`    (${c.note})`);
  }

  info(`\n  Total issues: ${result.totalIssues}`);

  if (!result.complete) {
    info(
      '\n  ⚠ Briefing incomplete — some checks could not run (see "unavailable" above); the site may not actually be clean.',
    );
  }

  if (result.narrative) {
    info(`\n${result.narrative}`);
  } else if (result.narrativeUnavailable) {
    const completeness = result.complete
      ? 'Structured summary above is complete.'
      : 'Structured summary above is incomplete — see the warning above.';
    info(`\n  (Narrative unavailable — Ollama is not running. ${completeness})`);
  }
}
