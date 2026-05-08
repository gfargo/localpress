/**
 * Helpers for re-invoking the localpress executable from within the interactive TUI.
 *
 * When the interactive browser dispatches a subcommand (optimize, edit, etc.),
 * it needs to spawn a child process that runs `localpress <cmd> <id>`. Three modes:
 *
 * 1. Dev mode: running via `bun src/cli/index.ts` — spawn `bun` + script path
 * 2. Tarball distribution: wrapper script sets LOCALPRESS_BIN env var — spawn that
 * 3. Fallback: use the `localpress` binary on PATH
 */

/**
 * Detect whether we're running in dev mode (bun src/cli/index.ts or similar)
 * vs a distributed install.
 */
export function isDevMode(
  argv: string[],
  execPath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // If LOCALPRESS_BIN is set (tarball wrapper), we're NOT in dev mode.
  if (env.LOCALPRESS_BIN) return false;

  // In dev mode, argv[1] is a .ts/.js script file and execPath is bun/node.
  const hasScriptArg = /\.(ts|mts|js|mjs)$/.test(argv[1] ?? '');
  const isWrapperInstall = execPath.includes('localpress');
  return hasScriptArg && !isWrapperInstall;
}

/**
 * Get the executable path to use when spawning subcommands.
 *
 * - Dev mode: argv[0] (typically `bun`)
 * - Tarball distribution: LOCALPRESS_BIN env var (the wrapper script path)
 * - Fallback: `localpress` on PATH
 */
export function getSelfBin(
  argv: string[],
  execPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.LOCALPRESS_BIN) return env.LOCALPRESS_BIN;
  if (isDevMode(argv, execPath, env)) return argv[0];
  return execPath.includes('localpress') ? execPath : 'localpress';
}

/**
 * Build the argument array for spawning a subcommand.
 *
 * - Dev mode: [scriptPath, cmd, id, ...extra]
 * - Tarball / wrapper: [cmd, id, ...extra]  (wrapper handles the bundle path)
 * - Fallback: [cmd, id, ...extra]
 */
export function buildSelfArgs(
  argv: string[],
  execPath: string,
  cmd: string,
  id: string,
  extra: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (isDevMode(argv, execPath, env)) {
    return [argv[1], cmd, id, ...extra];
  }
  return [cmd, id, ...extra];
}
