/**
 * Ignore-path matcher for `watch`'s chokidar instance.
 *
 * chokidar matches an `ignored` array (regex/glob entries) against the
 * *full* path of every event, so a watch root that itself contains a
 * dot-prefixed component (e.g. `~/.local/share/photos`, `<repo>/.tmp/watched`)
 * trips the dotfile rule for every single file underneath it — the watcher
 * silently ignores the whole tree. Anchoring the check to the path *relative
 * to the watch root* fixes that: only dot-prefixed segments (or
 * `node_modules`) that appear *inside* the watched tree are ignored.
 */

import { relative, resolve } from 'node:path';

export function createWatchIgnoreMatcher(watchRoot: string): (targetPath: string) => boolean {
  const root = resolve(watchRoot);

  return (targetPath: string): boolean => {
    const rel = relative(root, resolve(targetPath));

    // The root itself.
    if (rel === '') return false;

    // Outside the watched tree — don't filter paths we don't own.
    if (rel.startsWith('..')) return false;

    return rel
      .split(/[/\\]/)
      .some((segment) => segment.startsWith('.') || segment === 'node_modules');
  };
}
