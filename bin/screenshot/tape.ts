/**
 * Tape builder — transforms a Recipe into a VHS .tape string.
 *
 * All determinism controls live here so individual recipes stay declarative.
 */

import type { Recipe } from './recipes.ts';

const DEFAULT_FONT_SIZE = 20;
const DEFAULT_THEME = 'Catppuccin Mocha';
const DEFAULT_SETTLE_MS = 3000;
const DEFAULT_TYPING_SPEED = 30;

/**
 * Build a VHS tape string from a recipe.
 *
 * @param recipe - The scene to capture
 * @param opts.localPressBin - Path to the localpress binary/entrypoint
 */
export function buildTape(
  recipe: Recipe,
  opts: { localPressBin: string; projectRoot: string },
): string {
  const lines: string[] = [];
  const fontSize = recipe.fontSize ?? DEFAULT_FONT_SIZE;
  const theme = recipe.theme ?? DEFAULT_THEME;
  const settleMs = recipe.settleMs ?? DEFAULT_SETTLE_MS;
  const typingSpeed = recipe.typingSpeed ?? DEFAULT_TYPING_SPEED;
  const isGif = recipe.emitGif === true;

  // --- Output declaration ---
  if (isGif) {
    lines.push(`Output "${recipe.name}.gif"`);
  }
  lines.push('');

  // --- Settings block ---
  lines.push('# --- Settings ---');
  lines.push('Set Shell "bash"');
  lines.push(`Set FontSize ${fontSize}`);
  if (recipe.width) {
    lines.push(`Set Width ${recipe.width}`);
  }
  if (recipe.height) {
    lines.push(`Set Height ${recipe.height}`);
  }
  lines.push('Set Padding 24');
  lines.push(`Set Theme "${theme}"`);
  lines.push('Set CursorBlink false');
  lines.push(`Set TypingSpeed ${typingSpeed}ms`);
  lines.push('');

  // --- Hidden setup ---
  lines.push('# --- Hidden setup (not recorded) ---');
  lines.push('Hide');

  // Forward PATH so localpress is available
  lines.push(`Type "export PATH=${opts.localPressBin}:$PATH" Enter`);

  // Extra env vars from the recipe
  if (recipe.env) {
    for (const [key, value] of Object.entries(recipe.env)) {
      lines.push(`Type "export ${key}=${value}" Enter`);
    }
  }

  // cd to project root so relative paths in commands work
  lines.push(`Type "cd ${opts.projectRoot}" Enter`);

  lines.push('Type "clear" Enter');
  lines.push('Sleep 500ms');

  // If hideCommand, launch the app inside the hidden block so recording starts with it loaded
  if (recipe.hideCommand) {
    lines.push(`Type "${escapeForTape(recipe.command)}" Enter`);
    lines.push(`Sleep ${settleMs}ms`);
  }

  lines.push('Show');
  lines.push('');

  // --- The scene ---
  lines.push('# --- Scene ---');
  if (!recipe.hideCommand) {
    lines.push(`Type "${escapeForTape(recipe.command)}" Enter`);
    lines.push(`Sleep ${settleMs}ms`);
  }

  // Actions (keystrokes, typing, sleeps)
  if (recipe.actions) {
    for (const action of recipe.actions) {
      switch (action.kind) {
        case 'type':
          if (action.noEnter) {
            lines.push(`Type "${escapeForTape(action.text)}"`);
          } else {
            lines.push(`Type "${escapeForTape(action.text)}" Enter`);
          }
          break;
        case 'key':
          if (action.count && action.count > 1) {
            lines.push(`${action.key} ${action.count}`);
          } else {
            lines.push(action.key);
          }
          break;
        case 'sleep':
          lines.push(`Sleep ${action.ms}ms`);
          break;
      }
    }
  }

  // --- Capture ---
  if (!isGif) {
    lines.push('');
    lines.push(`Screenshot ${recipe.name}.png`);
  }
  // GIFs: no trailing quit — end on the last meaningful frame

  lines.push('');
  return lines.join('\n');
}

/** Escape double quotes for VHS Type commands. */
function escapeForTape(text: string): string {
  return text.replace(/"/g, '\\"');
}
