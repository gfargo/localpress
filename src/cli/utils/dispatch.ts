/**
 * Pure translation from a `MediaBrowserAction` (interactive TUI dispatch)
 * into the CLI subcommand + args that `list.ts` spawns as a subprocess.
 */

import type { MediaBrowserAction } from '../components/MediaBrowser.tsx';

export interface DispatchArgs {
  subCmd: string;
  targetIds: string[];
  extraArgs: string[];
}

export function buildDispatchArgs(action: MediaBrowserAction): DispatchArgs {
  let subCmd: string;
  let extraArgs: string[] = [];
  let targetIds: string[] = [];

  switch (action.type) {
    case 'optimize':
      subCmd = 'optimize';
      targetIds = [String(action.id)];
      if (action.quality !== undefined) extraArgs.push('--quality', String(action.quality));
      if (action.to) extraArgs.push('--to', action.to);
      if (action.keepOriginal) extraArgs.push('--keep-original');
      if (action.preview) extraArgs.push('--preview');
      break;
    case 'bulk-optimize':
      subCmd = 'optimize';
      targetIds = action.ids.map(String);
      if (action.quality !== undefined) extraArgs.push('--quality', String(action.quality));
      if (action.to) extraArgs.push('--to', action.to);
      extraArgs.push('--apply');
      break;
    case 'remove-bg':
      subCmd = 'remove-bg';
      targetIds = [String(action.id)];
      if (action.preview) extraArgs.push('--preview');
      break;
    case 'bulk-remove-bg':
      subCmd = 'remove-bg';
      targetIds = action.ids.map(String);
      extraArgs.push('--apply');
      break;
    case 'caption':
      subCmd = 'caption';
      targetIds = [String(action.id)];
      break;
    case 'convert':
      subCmd = 'convert';
      targetIds = [String(action.id)];
      extraArgs = ['--to', action.to];
      if (action.quality !== undefined) extraArgs.push('--quality', String(action.quality));
      break;
    case 'bulk-convert':
      subCmd = 'convert';
      targetIds = action.ids.map(String);
      extraArgs = ['--to', action.to];
      extraArgs.push('--apply');
      break;
    case 'resize':
      subCmd = 'resize';
      targetIds = [String(action.id)];
      if (action.maxWidth) extraArgs.push('--max-width', String(action.maxWidth));
      if (action.maxHeight) extraArgs.push('--max-height', String(action.maxHeight));
      break;
    case 'bulk-pull':
      subCmd = 'pull';
      targetIds = action.ids.map(String);
      break;
    default:
      subCmd = 'edit';
      targetIds = ['id' in action ? String(action.id) : '0'];
  }

  return { subCmd, targetIds, extraArgs };
}
