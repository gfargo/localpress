/**
 * Coalescing rerun guard for file-watch handlers.
 *
 * A save event that arrives while a previous run is still in flight is
 * queued (not dropped). When the in-flight run finishes, the most recent
 * queued call fires automatically — collapsing any number of overlapping
 * calls into a single rerun with the latest argument (last-write-wins).
 */

export function createRerunGuard<T = void>(
  run: (arg: T) => Promise<void>,
): (arg: T) => Promise<void> {
  let processing = false;
  let pending: { arg: T } | undefined;

  const trigger = async (arg: T): Promise<void> => {
    if (processing) {
      pending = { arg };
      return;
    }
    processing = true;
    try {
      await run(arg);
    } finally {
      processing = false;
      if (pending) {
        const next = pending.arg;
        pending = undefined;
        await trigger(next);
      }
    }
  };

  return trigger;
}
