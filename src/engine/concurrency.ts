/** Run an async worker over a collection with a fixed upper bound. */
export async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Concurrency must be a positive integer; received ${concurrency}.`);
  }

  let cursor = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });

  await Promise.all(workers);
}

/** Restore deterministic input order after concurrent workers finish. */
export function sortResultsById<T extends { id: number }>(results: T[], inputIds: number[]): void {
  const order = new Map(inputIds.map((id, index) => [id, index]));
  results.sort(
    (a, b) =>
      (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}
