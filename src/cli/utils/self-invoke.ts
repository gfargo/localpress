/**
 * Helpers for re-invoking the localpress binary from within the interactive TUI.
 *
 * When the interactive browser dispatches a subcommand (optimize, edit, etc.),
 * it needs to spawn a child process that runs `localpress <cmd> <id>`. The
 * challenge: in dev mode we're running via `bun src/cli/index.ts`, but in
 * compiled mode `process.argv[0]` may point to `bun` rather than the binary.
 *
 * These helpers detect the execution mode and return the correct binary path
 * and argument array for spawning subcommands.
 */

/**
 * Detect whether we're running in dev mode (bun src/cli/index.ts) vs
 * a compiled binary (localpress).
 */
export function isDevMode(argv: string[], execPath: string): boolean {
  // In dev mode, argv[1] is a .ts/.js script file.
  // In compiled mode, Bun may embed the source path in argv[1], but
  // execPath will contain 'localpress' (the compiled binary name).
  const hasScriptArg = /\.(ts|mts|js|mjs)$/.test(argv[1] ?? '');
  const isCompiledBinary = execPath.includes('localpress');
  return hasScriptArg && !isCompiledBinary;
}

/**
 * Get the binary path to use when spawning subcommands.
 *
 * - Dev mode: use argv[0] (typically `bun`)
 * - Compiled mode: use execPath (the actual binary)
 */
export function getSelfBin(argv: string[], execPath: string): string {
  return isDevMode(argv, execPath) ? argv[0] : execPath;
}

/**
 * Build the argument array for spawning a subcommand.
 *
 * - Dev mode: [scriptPath, cmd, id, ...extra]
 * - Compiled mode: [cmd, id, ...extra]
 */
export function buildSelfArgs(
  argv: string[],
  execPath: string,
  cmd: string,
  id: string,
  extra: string[] = [],
): string[] {
  if (isDevMode(argv, execPath)) {
    return [argv[1], cmd, id, ...extra];
  }
  return [cmd, id, ...extra];
}
