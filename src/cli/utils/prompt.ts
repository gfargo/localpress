/**
 * Interactive prompt helpers.
 *
 * Uses readline so we get proper line-buffered input (Enter required),
 * rather than raw mode which consumes stray buffered keystrokes.
 */

/**
 * Simple y/N prompt. Default answer is "no" — user must explicitly type y/yes.
 * Returns false immediately if stdin isn't a TTY (e.g. piped/scripted).
 */
export async function promptYesNo(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(`${message} `);
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}
