/**
 * Grace-window scheduler for file-watch delete handlers.
 *
 * `unlink` events fire immediately even for editors that save atomically
 * (delete the old file, then recreate it). Scheduling the delete behind a
 * short grace window — and cancelling it if the same path reappears — lets
 * `watch.ts` tell an atomic save apart from a real removal without acting on
 * the delete too early.
 */

export function createDeleteScheduler(opts: {
  graceMs: number;
  onDelete: (key: string) => void | Promise<void>;
}): {
  scheduleDelete(key: string): void;
  cancelDelete(key: string): boolean;
  clearAll(): void;
} {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleDelete(key: string): void {
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);

    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void opts.onDelete(key);
      }, opts.graceMs),
    );
  }

  function cancelDelete(key: string): boolean {
    const existing = timers.get(key);
    if (!existing) return false;
    clearTimeout(existing);
    timers.delete(key);
    return true;
  }

  function clearAll(): void {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  }

  return { scheduleDelete, cancelDelete, clearAll };
}
