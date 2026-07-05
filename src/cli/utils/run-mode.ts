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
