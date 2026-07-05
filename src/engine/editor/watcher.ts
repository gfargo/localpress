/**
 * File watcher for the edit round-trip workflow.
 *
 * Watches a file for changes and calls a callback when the file is saved.
 * Uses chokidar for cross-platform file watching with debouncing to handle
 * editors that write files in multiple steps (temp file → rename).
 */

import { watch } from 'chokidar';
import { createRerunGuard } from '../../cli/utils/rerun-guard.ts';

export interface WatcherOptions {
  /** Debounce interval in milliseconds. Default: 500ms. */
  debounceMs?: number;
  /** Called when the file is modified. */
  onSave: (filePath: string) => void | Promise<void>;
  /** Called when the watcher encounters an error. */
  onError?: (error: Error) => void;
  /** Called when the watcher is ready. */
  onReady?: () => void;
}

export interface FileWatcher {
  /** Stop watching and clean up. */
  close(): Promise<void>;
}

/**
 * Watch a file for changes. Calls `onSave` when the file is modified.
 *
 * The watcher debounces rapid changes (common with editors that do
 * atomic writes via temp file + rename) to avoid triggering multiple
 * uploads for a single save.
 */
export function watchFile(filePath: string, options: WatcherOptions): FileWatcher {
  const debounceMs = options.debounceMs ?? 500;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const trigger = createRerunGuard(async () => {
    try {
      await options.onSave(filePath);
    } catch (err) {
      options.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  });

  const scheduleRun = () => {
    // Debounce: reset the timer on each change/add event.
    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void trigger();
    }, debounceMs);
  };

  const watcher = watch(filePath, {
    // Don't fire on the initial add — we only care about changes.
    ignoreInitial: true,
    // Use polling as a fallback for network filesystems and some editors.
    usePolling: false,
    // Stabilize events — wait for the file to stop changing.
    awaitWriteFinish: {
      stabilityThreshold: debounceMs,
      pollInterval: 100,
    },
  });

  // Some editors save via delete+recreate (atomic save) rather than an
  // in-place write, which chokidar reports as `add`, not `change`.
  watcher.on('change', scheduleRun);
  watcher.on('add', scheduleRun);

  watcher.on('error', (err) => {
    options.onError?.(err);
  });

  watcher.on('ready', () => {
    options.onReady?.();
  });

  return {
    close: async () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      await watcher.close();
    },
  };
}
