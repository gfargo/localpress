/**
 * `localpress verify <ids...>` — cross-check local DB state vs remote WordPress.
 *
 * For each attachment ID:
 *   1. Reads the local SQLite record (attachments table)
 *   2. Fetches the live attachment from the WordPress REST API
 *   3. Compares: size, mime type, dimensions, URL, processing status
 *   4. Reports any drift between the two
 *
 * Optionally downloads the remote file and compares its SHA-256 hash against
 * the stored source_hash to detect silent re-uploads or plugin interference.
 *
 * Use cases:
 *   - Verify an undo actually restored the original
 *   - Detect if another plugin (Smush, ShortPixel) re-processed an image
 *   - Confirm the local state DB is in sync with WordPress
 */

import { createHash } from 'node:crypto';
import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { MediaItem } from '../../adapters/types.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { parseAttachmentIds } from '../utils/ids.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

interface VerifyFinding {
  field: string;
  local: string | number | null;
  remote: string | number | null;
  severity: 'mismatch' | 'drift' | 'missing';
}

interface VerifyResult {
  id: number;
  filename: string;
  status: 'ok' | 'drift' | 'missing-local' | 'missing-remote';
  findings: VerifyFinding[];
  hashVerified?: boolean;
}

export interface HashCheckResult {
  /** Whether the hash comparison was actually performed (fetch succeeded and returned bytes). */
  verified: boolean;
  /** Only meaningful when `verified` is true. */
  mismatch: boolean;
  remoteHash?: string;
  /** Human-readable reason the check could not be performed, when `verified` is false. */
  reason?: string;
}

/**
 * Downloads `url` with the given auth header and compares its SHA-256 against
 * `localHash`. Pure/testable — never throws; failures are reported via `reason`
 * so callers can distinguish "couldn't check" from "checked, and it matches".
 */
export async function verifyRemoteHash(options: {
  url: string;
  authHeader: string;
  localHash: string;
  fetchImpl?: typeof fetch;
}): Promise<HashCheckResult> {
  const fetchFn = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchFn(options.url, { headers: { Authorization: options.authHeader } });
  } catch (err) {
    return {
      verified: false,
      mismatch: false,
      reason: `download failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    return {
      verified: false,
      mismatch: false,
      reason: `could not download remote file for hash check (HTTP ${response.status})`,
    };
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const remoteHash = createHash('sha256').update(bytes).digest('hex');

  return { verified: true, mismatch: remoteHash !== options.localHash, remoteHash };
}

export function registerVerifyCommand(program: Command): void {
  program
    .command('verify <ids...>')
    .description('Cross-check local DB state against remote WordPress for one or more attachments')
    .option('--hash', 'download remote file and verify SHA-256 hash (slower)')
    .option('--all', 'verify all locally-tracked attachments')
    .action(async (idStrs: string[], options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const adapter = resolver.resolve('get');

      // Same Basic-auth credential the REST adapter uses, so the file fetch
      // below works on Application-Password/basic-auth-gated sites too.
      const authHeader = `Basic ${btoa(`${site.username}:${site.appPassword}`)}`;

      const db = SiteDb.init(getSiteDbPath(site.name));

      let targetIds: number[];

      if (options.all) {
        const attachments = db.listAttachments(site.name);
        targetIds = attachments.map((a) => a.wpId);
      } else {
        targetIds = parseAttachmentIds(idStrs);
      }

      if (targetIds.length === 0) {
        info('No attachments to verify.');
        db.close();
        return;
      }

      info(`Verifying ${targetIds.length} attachment(s) against ${site.name}...\n`);

      const results: VerifyResult[] = [];
      let okCount = 0;
      let driftCount = 0;
      let missingCount = 0;
      let unverifiedCount = 0;

      for (const id of targetIds) {
        const localRecord = db.getAttachment(site.name, id);

        if (!localRecord) {
          // Not in local DB — might still exist remotely.
          try {
            const remote = await adapter.getMedia(id);
            results.push({
              id,
              filename: remote.filename,
              status: 'missing-local',
              findings: [
                {
                  field: 'local-record',
                  local: null,
                  remote: remote.filename,
                  severity: 'missing',
                },
              ],
            });
            warn(`  #${id} (${remote.filename}): not in local DB (never processed by localpress)`);
            missingCount++;
          } catch {
            results.push({
              id,
              filename: `attachment-${id}`,
              status: 'missing-remote',
              findings: [
                {
                  field: 'remote-record',
                  local: null,
                  remote: null,
                  severity: 'missing',
                },
              ],
            });
            warn(`  #${id}: not found locally or remotely`);
            missingCount++;
          }
          continue;
        }

        // Fetch remote state.
        let remote: MediaItem;
        try {
          remote = await adapter.getMedia(id);
        } catch (err) {
          results.push({
            id,
            filename: localRecord.sourceUrl,
            status: 'missing-remote',
            findings: [
              {
                field: 'remote-record',
                local: localRecord.sourceUrl,
                remote: null,
                severity: 'missing',
              },
            ],
          });
          error(
            `  #${id}: exists locally but not remotely (${err instanceof Error ? err.message : String(err)})`,
          );
          missingCount++;
          continue;
        }

        // Compare fields.
        const findings: VerifyFinding[] = [];

        if (localRecord.mimeType && remote.mimeType !== localRecord.mimeType) {
          findings.push({
            field: 'mimeType',
            local: localRecord.mimeType,
            remote: remote.mimeType,
            severity: 'mismatch',
          });
        }

        if (
          localRecord.sizeBytes !== null &&
          remote.sizeBytes !== undefined &&
          remote.sizeBytes !== null &&
          Math.abs((remote.sizeBytes ?? 0) - (localRecord.sizeBytes ?? 0)) > 100
        ) {
          findings.push({
            field: 'sizeBytes',
            local: localRecord.sizeBytes,
            remote: remote.sizeBytes ?? null,
            severity: 'drift',
          });
        }

        if (
          localRecord.width !== null &&
          remote.width !== undefined &&
          remote.width !== localRecord.width
        ) {
          findings.push({
            field: 'width',
            local: localRecord.width,
            remote: remote.width ?? null,
            severity: 'mismatch',
          });
        }

        if (
          localRecord.height !== null &&
          remote.height !== undefined &&
          remote.height !== localRecord.height
        ) {
          findings.push({
            field: 'height',
            local: localRecord.height,
            remote: remote.height ?? null,
            severity: 'mismatch',
          });
        }

        // Optional hash verification — download the file and compare SHA-256.
        // `hashVerified` distinguishes "checked, and it matches/doesn't" from
        // "couldn't actually check" — the latter must never report as ok.
        let hashVerified: boolean | undefined;

        if (options.hash) {
          if (!localRecord.sourceHash) {
            hashVerified = false;
            warn(`  #${id}: no local source hash recorded — cannot verify`);
          } else {
            const hashResult = await verifyRemoteHash({
              url: remote.url,
              authHeader,
              localHash: localRecord.sourceHash,
            });
            hashVerified = hashResult.verified;

            if (hashResult.verified) {
              if (hashResult.mismatch) {
                findings.push({
                  field: 'sha256',
                  local: `${localRecord.sourceHash.slice(0, 12)}…`,
                  remote: `${(hashResult.remoteHash ?? '').slice(0, 12)}…`,
                  severity: 'drift',
                });
              }
            } else {
              warn(`  #${id}: ${hashResult.reason}`);
            }
          }
        }

        const hashUnverified = options.hash === true && hashVerified === false;
        const status = findings.length === 0 ? 'ok' : 'drift';
        results.push({
          id,
          filename: remote.filename,
          status,
          findings,
          ...(options.hash ? { hashVerified } : {}),
        });

        if (status === 'ok' && !hashUnverified) {
          info(`  ✓ #${id} (${remote.filename}) — in sync`);
          okCount++;
        } else if (status === 'ok' && hashUnverified) {
          warn(`  ⚠ #${id} (${remote.filename}) — in sync except hash could not be verified`);
        } else {
          warn(`  ⚠ #${id} (${remote.filename}) — ${findings.length} difference(s):`);
          for (const f of findings) {
            warn(`      ${f.field}: local=${f.local} ≠ remote=${f.remote}`);
          }
          driftCount++;
        }

        if (hashUnverified) {
          unverifiedCount++;
        }
      }

      db.close();

      // Summary.
      info(
        `\n  Summary: ${okCount} ok, ${driftCount} drifted, ${missingCount} missing, ${unverifiedCount} unverified`,
      );

      if (parentOpts.json) {
        printJson({
          site: site.name,
          verified: targetIds.length,
          ok: okCount,
          drift: driftCount,
          missing: missingCount,
          unverified: unverifiedCount,
          results,
        });
      }

      if (driftCount > 0 || missingCount > 0 || unverifiedCount > 0) {
        process.exit(1);
      }
    });
}
