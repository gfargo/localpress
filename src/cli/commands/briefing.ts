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
import { SiteDb } from '../../engine/state/db.ts';
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
const ORPHANS_TIMEOUT_MS = 20_000;

export interface CategorySummary {
  count: number;
  examples: string[];
  available: boolean;
  unavailableReason?: string;
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
            db.close();
            printBriefing(parentOpts.json, { ...parsed, fresh: false });
            return;
          } catch {
            // Corrupt cache entry — fall through to a live run.
          }
        }
      }

      const model: string = options.model ?? config.defaults?.captionModel ?? 'moondream';
      const result = await runBriefing(site, db, model);
      db.setPref(site.name, CACHE_KEY, JSON.stringify(result));
      db.close();
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

  const { narrative, narrativeUnavailable } = await synthesizeNarrative(
    site.name,
    categories,
    totalIssues,
    model,
  );

  return {
    site: site.name,
    generatedAt: new Date().toISOString(),
    fresh: true,
    categories,
    totalIssues,
    clean: totalIssues === 0,
    narrative,
    narrativeUnavailable,
  };
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
  try {
    const items = await fetchAllMedia(adapter);
    const processedIds = db.listProcessedWpIds(siteName);

    const unoptimizedItems = items.filter((i) => !processedIds.has(i.id));
    const missingAltItems = items.filter((i) => !i.altText || i.altText.trim() === '');

    const brokenRefCandidates = items.slice(0, BROKEN_REFS_SCAN_LIMIT);
    const brokenRefFindings = await detectBrokenRefs(brokenRefCandidates, adapter);
    const brokenRefsTruncated = items.length > BROKEN_REFS_SCAN_LIMIT;

    return {
      unoptimized: {
        count: unoptimizedItems.length,
        examples: unoptimizedItems.slice(0, 5).map((i) => i.filename),
        available: true,
      },
      missingAlt: {
        count: missingAltItems.length,
        examples: missingAltItems.slice(0, 5).map((i) => i.filename),
        available: true,
      },
      brokenRefs: {
        count: brokenRefFindings.length,
        examples: brokenRefFindings.slice(0, 5).map((f) => f.filename),
        available: true,
        note: brokenRefsTruncated
          ? `Checked ${BROKEN_REFS_SCAN_LIMIT} of ${items.length} attachments (bounded for interactive use) — run \`localpress audit --broken-refs\` for a full scan.`
          : undefined,
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const unavailable: CategorySummary = {
      count: 0,
      examples: [],
      available: false,
      unavailableReason: reason,
    };
    return {
      unoptimized: unavailable,
      missingAlt: { ...unavailable },
      brokenRefs: { ...unavailable },
    };
  }
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
    return {
      count: result.findings.length,
      examples: result.findings.slice(0, 5).map((f) => `"${f.postTitle}": ${f.detail}`),
      available: true,
    };
  } catch (err) {
    return {
      count: 0,
      examples: [],
      available: false,
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
      unavailableReason: 'Requires WP-CLI over SSH — configure SSH access for this site to enable.',
    };
  }
  try {
    const result = await Promise.race([
      pruneAdapter.pruneOrphans(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error(`WP-CLI orphan scan timed out after ${ORPHANS_TIMEOUT_MS / 1000}s`)),
          ORPHANS_TIMEOUT_MS,
        ),
      ),
    ]);
    return {
      count: result.orphanFiles.length,
      examples: result.orphanFiles.slice(0, 5),
      available: true,
    };
  } catch (err) {
    return {
      count: 0,
      examples: [],
      available: false,
      unavailableReason: err instanceof Error ? err.message : String(err),
    };
  }
}

// -- Narrative synthesis --------------------------------------------------------

export async function synthesizeNarrative(
  siteName: string,
  categories: BriefingResult['categories'],
  totalIssues: number,
  model: string,
): Promise<{ narrative: string | null; narrativeUnavailable: boolean }> {
  // A clean result doesn't need an LLM to say so.
  if (totalIssues === 0) {
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

  if (result.narrative) {
    info(`\n${result.narrative}`);
  } else if (result.narrativeUnavailable) {
    info(
      '\n  (Narrative unavailable — Ollama is not running. Structured summary above is complete.)',
    );
  }
}
