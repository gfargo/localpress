/**
 * `localpress doctor` — show backend availability and capability matrix.
 *
 * Output sketch (human mode):
 *
 *   Site: griffen.example.com
 *     ✓ REST API           (Application Password authenticated)
 *     ✓ WP-CLI             (SSH configured: griffen@host)
 *     ✗ MCP                (no WP MCP server configured)
 *
 *   Capabilities:
 *     ✓ list, get, upload, update-meta, delete
 *     ✓ replace-in-place   (via WP-CLI)
 *     ✓ regenerate-thumbnails (via WP-CLI)
 *     ✓ prune-orphans      (via WP-CLI)
 *
 *   Local environment:
 *     ✓ rembg (Python sidecar)            v2.0.75
 *     ✓ sharp                             bundled
 *     ✓ @jsquash/avif                     bundled
 *
 * In --json mode, emits a structured capability report — exactly what the
 * skill consumes to decide which operations the agent can attempt.
 */

import type { Command } from 'commander';
import { notImplemented } from '../utils/output.ts';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Show backend availability and capability matrix for a site')
    .option('--all-sites', 'show capabilities for every configured site (not just the active one)')
    .action(async (_options) => {
      notImplemented('doctor');
    });
}
