/**
 * Atomic directory swap for `localpress update`.
 *
 * Replaces `targetDir` with the contents of `stagingDir` using two
 * `rename()` calls instead of delete-then-copy, so a crash mid-swap
 * can't leave a gutted install. `stagingDir` must be a sibling of
 * `targetDir` (same filesystem) or the renames will fail with EXDEV.
 */

import { existsSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';

export async function performAtomicSwap(targetDir: string, stagingDir: string): Promise<void> {
  const backupDir = `${targetDir}.bak-${Date.now()}`;
  const hadExisting = existsSync(targetDir);

  if (hadExisting) {
    await rename(targetDir, backupDir);
  }

  try {
    await rename(stagingDir, targetDir);
  } catch (err) {
    if (hadExisting) {
      try {
        await rename(backupDir, targetDir);
      } catch (restoreErr) {
        const originalMessage = err instanceof Error ? err.message : String(err);
        const restoreMessage =
          restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
        throw new Error(
          `Update failed AND automatic restore failed — your install may be broken. Manually run: mv "${backupDir}" "${targetDir}". Original error: ${originalMessage}. Restore error: ${restoreMessage}`,
        );
      }
    }
    throw err;
  }

  if (hadExisting) {
    await rm(backupDir, { recursive: true, force: true }).catch(() => {});
  }
}
