/**
 * Shared dry-run / apply resolution for mutating commands.
 *
 * The global `--dry-run` and `--apply` flags live on the root program, so every
 * command reads them via `program.opts()`. Bulk commands (optimize --all, …)
 * default to dry-run and require `--apply`; explicit destructive commands
 * (delete, posts delete/update, metadata) execute by default but must honor a
 * `--dry-run` the user passed to preview.
 *
 * Centralizing this here keeps the safety semantics identical across commands —
 * a `--dry-run` must NEVER reach a mutation.
 */

/** The subset of global options that affect run mode. */
export interface RunModeOpts {
  dryRun?: boolean;
  apply?: boolean;
}

/**
 * Resolve whether a command should run in dry-run (preview) mode.
 *
 * - `--apply` always forces execution (opts out of any dry-run default).
 * - Otherwise an explicit `--dry-run` forces preview.
 * - Otherwise fall back to the command's default posture.
 *
 * @param parentOpts result of `program.opts()`
 * @param defaultDryRun the command's default when neither flag is passed
 *   (true for bulk `--all` ops, false for explicit-ID destructive ops)
 */
export function resolveDryRun(parentOpts: RunModeOpts, defaultDryRun: boolean): boolean {
  if (parentOpts.apply) return false;
  if (parentOpts.dryRun) return true;
  return defaultDryRun;
}

/**
 * Normalized description of what a dry-run would have changed. Every
 * mutating command's `--json` dry-run output carries one of these under
 * `changes`, so an agent can inspect the shape of a pending mutation without
 * learning a per-command schema.
 */
export interface DryRunChanges {
  /** Command/subcommand identifier, e.g. 'optimize', 'posts.update'. */
  operation: string;
  /** Number of affected items, for bulk/list operations. */
  count?: number;
  /** Affected entities (attachments, posts, files, …), for bulk/list operations. */
  items?: Array<Record<string, unknown>>;
  /** Field-level diff, for single-record operations. */
  fields?: object;
  [k: string]: unknown;
}

/**
 * One dry-run contract, exposed everywhere: every mutating command's
 * dry-run `--json` payload uses `dryRun: true` as its discriminator (never
 * `action: 'dry-run'`) and carries a normalized `changes` block. `legacy`
 * fields are spread in additively so existing consumers of a command's
 * pre-existing dry-run shape (skill, MCP, scripts) keep working.
 */
export interface DryRunPayload {
  dryRun: true;
  changes: DryRunChanges;
  [k: string]: unknown;
}

export function dryRunPayload(changes: DryRunChanges, legacy: object = {}): DryRunPayload {
  return { ...legacy, dryRun: true, changes };
}

/**
 * Reduce a bulk-run results array (caption/title/describe/tag/rename/…) down
 * to the `{ id, filename }` pairs of items that were actually acted on (not
 * skipped), for use in a dry-run `changes.items` block.
 */
export function dryRunItemsFromResults<
  T extends { id: number; filename: string; skipped: boolean },
>(results: T[]): Array<{ id: number; filename: string }> {
  return results.filter((r) => !r.skipped).map((r) => ({ id: r.id, filename: r.filename }));
}
