/**
 * Screenshot recipe catalog.
 *
 * Each recipe describes one scene to capture. The driver reads this list,
 * builds a VHS tape from each, runs it, and optimizes the output.
 *
 * Naming convention:
 *   - `ui-*`   → still PNG (feature shots, docs)
 *   - `demo-*` → motion GIF (workflows in action, marketing)
 */

export type Action =
  | { kind: 'type'; text: string; noEnter?: boolean }
  | { kind: 'key'; key: string; count?: number }
  | { kind: 'sleep'; ms: number };

export type Recipe = {
  /** Unique name — becomes the output filename (without extension). */
  name: string;
  /** Human description (shown by --list). */
  description: string;
  /** The localpress command to run (first command typed). */
  command: string;
  /** Keystrokes/sleeps after the command launches. */
  actions?: Action[];
  /** Font size in px (default 20). Controls capture scale. */
  fontSize?: number;
  /** Canvas width in px (default 1200). */
  width?: number;
  /** Canvas height in px (default 600). Use 800+ for tall TUI apps. */
  height?: number;
  /** Typing speed in ms between chars (default 30). Lower = faster. */
  typingSpeed?: number;
  /** VHS theme name (default "Catppuccin Mocha"). */
  theme?: string;
  /** true → motion GIF; false/absent → still PNG. */
  emitGif?: boolean;
  /** GIF: total settle before first action (ms). Still: settle before Screenshot (ms). */
  settleMs?: number;
  /** Extra env vars to set in the VHS shell. */
  env?: Record<string, string>;
  /** If true, the command is typed inside Hide — recording starts with the app already running. */
  hideCommand?: boolean;
};

// ═══════════════════════════════════════════════════════════════════════════════
// STILLS — Feature shots for README, docs, marketing site
// ═══════════════════════════════════════════════════════════════════════════════

const STILLS: Recipe[] = [
  // ─── Real command output (visually rich) ──────────────────────────────────

  {
    name: 'ui-doctor',
    description: 'Doctor output showing capability matrix with all green checkmarks',
    command: 'localpress doctor',
    settleMs: 6000,
  },

  {
    name: 'ui-stats',
    description: 'Stats dashboard showing savings, format breakdown, and recent ops',
    command: 'localpress stats',
    settleMs: 4000,
  },

  {
    name: 'ui-list',
    description: 'Media library listing with file details (real site data)',
    command: 'localpress list --limit 15',
    settleMs: 4000,
  },

  {
    name: 'ui-history',
    description: 'Time-machine history showing undo sessions',
    command: 'localpress history',
    settleMs: 6000,
  },

  // ─── Interactive browser (the TUI app) ────────────────────────────────────

  {
    name: 'ui-browser-list',
    description: 'Interactive media browser — main list view with sidebar',
    command: 'localpress list -i',
    settleMs: 6000,
    width: 1600,
    height: 800,
    // Navigate down a few items to show the cursor + selection UI
    actions: [
      { kind: 'key', key: 'Down', count: 3 },
      { kind: 'sleep', ms: 2000 },
    ],
  },

  {
    name: 'ui-browser-details',
    description: 'Interactive browser — detail overlay showing full metadata',
    command: 'localpress list -i',
    settleMs: 6000,
    width: 1600,
    height: 800,
    actions: [
      { kind: 'key', key: 'Down', count: 2 },
      { kind: 'sleep', ms: 1000 },
      { kind: 'key', key: 'Enter' }, // Open detail view
      { kind: 'sleep', ms: 6000 }, // Extra time: API call + render
    ],
  },

  {
    name: 'ui-browser-optimize',
    description: 'Interactive browser — optimize settings overlay (quality/format/keep)',
    command: 'localpress list -i',
    settleMs: 6000,
    width: 1600,
    height: 800,
    actions: [
      { kind: 'key', key: 'Down', count: 4 },
      { kind: 'sleep', ms: 2000 },
      { kind: 'type', text: 'o', noEnter: true }, // Open optimize overlay
      { kind: 'sleep', ms: 4000 }, // Extra time for overlay to fully render
    ],
  },

  {
    name: 'ui-browser-convert',
    description: 'Interactive browser — convert format picker overlay',
    command: 'localpress list -i',
    settleMs: 6000,
    width: 1600,
    height: 800,
    actions: [
      { kind: 'key', key: 'Down', count: 3 },
      { kind: 'sleep', ms: 2000 },
      { kind: 'type', text: 'c', noEnter: true }, // Open convert overlay
      { kind: 'sleep', ms: 4000 },
    ],
  },

  {
    name: 'ui-browser-resize',
    description: 'Interactive browser — resize dimension input overlay',
    command: 'localpress list -i',
    settleMs: 6000,
    width: 1600,
    height: 800,
    actions: [
      { kind: 'key', key: 'Down', count: 2 },
      { kind: 'sleep', ms: 2000 },
      { kind: 'type', text: 's', noEnter: true }, // Open resize overlay
      { kind: 'sleep', ms: 2000 },
      { kind: 'type', text: '1024', noEnter: true }, // Type a width value
      { kind: 'sleep', ms: 2000 },
    ],
  },

  {
    name: 'ui-browser-search',
    description: 'Interactive browser — search/filter mode narrowing results',
    command: 'localpress list -i',
    settleMs: 6000,
    width: 1600,
    height: 800,
    actions: [
      { kind: 'type', text: '/', noEnter: true }, // Open search
      { kind: 'sleep', ms: 500 },
      { kind: 'type', text: 'featured', noEnter: true }, // Type search query
      { kind: 'sleep', ms: 2000 },
    ],
  },

  {
    name: 'ui-browser-multiselect',
    description: 'Interactive browser — multi-select mode with items checked',
    command: 'localpress list -i',
    settleMs: 6000,
    width: 1600,
    height: 800,
    actions: [
      { kind: 'key', key: 'Down' },
      { kind: 'key', key: 'Space' }, // Select item 1
      { kind: 'key', key: 'Space' }, // Select item 2
      { kind: 'key', key: 'Space' }, // Select item 3
      { kind: 'key', key: 'Down', count: 2 },
      { kind: 'key', key: 'Space' }, // Select item 6
      { kind: 'sleep', ms: 2000 },
    ],
  },

  // ─── Help screens (reference/docs) ────────────────────────────────────────

  {
    name: 'ui-help',
    description: 'Main help screen — all 38+ commands at a glance',
    command: 'localpress --help',
    settleMs: 3000,
    fontSize: 16, // Smaller font to fit more commands on screen
  },

  {
    name: 'ui-optimize-flags',
    description: 'Optimize command flags — shows the depth of control available',
    command: 'localpress optimize --help',
    settleMs: 3000,
  },

  {
    name: 'ui-audit-flags',
    description: 'Audit checks overview — shows 10 different audit types',
    command: 'localpress audit --help',
    settleMs: 3000,
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// MOTION GIFs — Workflows in action for hero sections and feature showcases
// ═══════════════════════════════════════════════════════════════════════════════

const GIFS: Recipe[] = [
  // ─── Interactive browser workflows (the star of the show) ─────────────────

  {
    name: 'demo-browser-readme',
    description: 'README GIF: full TUI with sidebar, quick browse (compact)',
    command: 'localpress list -i',
    emitGif: true,
    hideCommand: true,
    settleMs: 3000,
    width: 1300,
    height: 650,
    fontSize: 17,
    actions: [
      { kind: 'key', key: 'Down', count: 4 },
      { kind: 'sleep', ms: 1000 },
      { kind: 'key', key: 'Down', count: 3 },
      { kind: 'sleep', ms: 1000 },
      { kind: 'key', key: 'Up', count: 5 },
      { kind: 'sleep', ms: 1200 },
    ],
  },

  {
    name: 'demo-browser-hero',
    description: 'Compact hero GIF: browse → details → optimize overlay (no sidebar, fast)',
    command: 'localpress list -i',
    emitGif: true,
    hideCommand: true,
    settleMs: 3000,
    fontSize: 18,
    // Narrow width = no sidebar = single pane = smaller file
    width: 1000,
    height: 750,
    actions: [
      { kind: 'key', key: 'Down', count: 3 },
      { kind: 'sleep', ms: 1200 },
      { kind: 'key', key: 'Down', count: 2 },
      { kind: 'sleep', ms: 1000 },
      { kind: 'key', key: 'Enter' }, // Details
      { kind: 'sleep', ms: 3500 },
      { kind: 'type', text: ' ', noEnter: true }, // Close
      { kind: 'sleep', ms: 1000 },
      { kind: 'type', text: 'o', noEnter: true }, // Optimize overlay
      { kind: 'sleep', ms: 3000 },
      { kind: 'key', key: 'Escape' },
      { kind: 'sleep', ms: 1000 },
    ],
  },

  {
    name: 'demo-browser-navigate',
    description: 'Interactive browser: browse items, sidebar updates live',
    command: 'localpress list -i',
    emitGif: true,
    settleMs: 3000,
    width: 1600,
    height: 800,
    actions: [
      { kind: 'sleep', ms: 1000 },
      { kind: 'key', key: 'Down', count: 4 },
      { kind: 'sleep', ms: 1200 },
      { kind: 'key', key: 'Down', count: 3 },
      { kind: 'sleep', ms: 1200 },
      { kind: 'key', key: 'Up', count: 5 },
      { kind: 'sleep', ms: 1500 },
    ],
  },

  {
    name: 'demo-browser-actions-tour',
    description: 'Interactive browser: open optimize settings overlay',
    command: 'localpress list -i',
    emitGif: true,
    hideCommand: true,
    settleMs: 3000,
    width: 1600,
    height: 800,
    actions: [
      { kind: 'key', key: 'Down', count: 3 },
      { kind: 'sleep', ms: 600 },
      { kind: 'type', text: 'o', noEnter: true }, // Open optimize overlay
      { kind: 'sleep', ms: 2500 },
      { kind: 'key', key: 'Tab' }, // Move to quality
      { kind: 'sleep', ms: 400 },
      { kind: 'type', text: '75', noEnter: true },
      { kind: 'sleep', ms: 800 },
      { kind: 'key', key: 'Tab' }, // Move to format
      { kind: 'sleep', ms: 400 },
      { kind: 'key', key: 'Space' }, // Cycle to webp
      { kind: 'sleep', ms: 1500 },
      { kind: 'key', key: 'Escape' },
      { kind: 'sleep', ms: 800 },
    ],
  },

  {
    name: 'demo-browser-details',
    description: 'Interactive browser: select item → open detail view → close',
    command: 'localpress list -i',
    emitGif: true,
    settleMs: 4000,
    width: 1600,
    height: 800,
    actions: [
      { kind: 'sleep', ms: 2000 },
      { kind: 'key', key: 'Down', count: 2 },
      { kind: 'sleep', ms: 1000 },
      { kind: 'key', key: 'Enter' }, // Open detail overlay
      { kind: 'sleep', ms: 5000 }, // Hold on detail view (load + read time)
      { kind: 'type', text: ' ', noEnter: true }, // Close detail (any key)
      { kind: 'sleep', ms: 2000 },
    ],
  },

  {
    name: 'demo-browser-optimize-flow',
    description: 'Interactive browser: select image → open optimize overlay → configure',
    command: 'localpress list -i',
    emitGif: true,
    settleMs: 4000,
    width: 1600,
    height: 800,
    actions: [
      { kind: 'sleep', ms: 2000 },
      { kind: 'key', key: 'Down', count: 3 },
      { kind: 'sleep', ms: 1000 },
      { kind: 'type', text: 'o', noEnter: true }, // Open optimize settings
      { kind: 'sleep', ms: 3000 },
      { kind: 'key', key: 'Tab' }, // Move to quality field
      { kind: 'sleep', ms: 800 },
      { kind: 'type', text: '80', noEnter: true }, // Type quality
      { kind: 'sleep', ms: 1500 },
      { kind: 'key', key: 'Tab' }, // Move to format field
      { kind: 'sleep', ms: 800 },
      { kind: 'key', key: 'Space' }, // Cycle to webp
      { kind: 'sleep', ms: 2500 },
      { kind: 'key', key: 'Escape' }, // Cancel (don't actually run)
      { kind: 'sleep', ms: 1500 },
    ],
  },

  {
    name: 'demo-browser-search',
    description: 'Interactive browser: open search, filter by name, browse results',
    command: 'localpress list -i',
    emitGif: true,
    settleMs: 4000,
    width: 1600,
    height: 800,
    actions: [
      { kind: 'sleep', ms: 2000 },
      { kind: 'type', text: '/', noEnter: true }, // Open search
      { kind: 'sleep', ms: 800 },
      { kind: 'type', text: 'screenshot', noEnter: true }, // Type search
      { kind: 'sleep', ms: 2500 },
      { kind: 'key', key: 'Down', count: 2 }, // Browse filtered results
      { kind: 'sleep', ms: 2000 },
      { kind: 'key', key: 'Escape' }, // Clear search
      { kind: 'sleep', ms: 2000 },
    ],
  },

  {
    name: 'demo-browser-multiselect',
    description: 'Interactive browser: multi-select items for bulk operations',
    command: 'localpress list -i',
    emitGif: true,
    settleMs: 4000,
    width: 1600,
    height: 800,
    actions: [
      { kind: 'sleep', ms: 2000 },
      { kind: 'key', key: 'Down' },
      { kind: 'key', key: 'Space' }, // Select 1
      { kind: 'sleep', ms: 600 },
      { kind: 'key', key: 'Space' }, // Select 2
      { kind: 'sleep', ms: 600 },
      { kind: 'key', key: 'Space' }, // Select 3
      { kind: 'sleep', ms: 600 },
      { kind: 'key', key: 'Down', count: 2 },
      { kind: 'key', key: 'Space' }, // Select another
      { kind: 'sleep', ms: 2500 },
      { kind: 'key', key: 'Escape' }, // Clear selection
      { kind: 'sleep', ms: 1500 },
    ],
  },

  {
    name: 'demo-browser-convert',
    description: 'Interactive browser: open convert format picker → choose WebP',
    command: 'localpress list -i',
    emitGif: true,
    settleMs: 4000,
    width: 1600,
    height: 800,
    actions: [
      { kind: 'sleep', ms: 2000 },
      { kind: 'key', key: 'Down', count: 4 },
      { kind: 'sleep', ms: 1000 },
      { kind: 'type', text: 'c', noEnter: true }, // Open convert
      { kind: 'sleep', ms: 3000 }, // Show format picker
      { kind: 'type', text: 'w', noEnter: true }, // Choose WebP
      { kind: 'sleep', ms: 3000 }, // Show quality input
      { kind: 'key', key: 'Escape' }, // Back out
      { kind: 'sleep', ms: 1000 },
      { kind: 'key', key: 'Escape' }, // Close overlay
      { kind: 'sleep', ms: 1500 },
    ],
  },

  // ─── CLI workflow demos ───────────────────────────────────────────────────

  {
    name: 'demo-mcp-agent',
    description: 'Simulated MCP agent session: find unoptimized images → optimize to WebP',
    command: './bin/screenshot/mcp-demo.sh',
    emitGif: true,
    hideCommand: true,
    settleMs: 500,
    width: 1000,
    height: 600,
    fontSize: 18,
    actions: [
      { kind: 'sleep', ms: 18000 }, // Let the script run its full course
    ],
  },

  {
    name: 'demo-doctor-to-list',
    description: 'Run doctor → healthy site → then list media (shows the workflow)',
    command: 'localpress doctor',
    emitGif: true,
    settleMs: 1500,
    actions: [
      { kind: 'sleep', ms: 4000 }, // let doctor output fully render
      { kind: 'type', text: 'localpress list --limit 10' },
      { kind: 'sleep', ms: 4000 }, // let list render
    ],
  },

  {
    name: 'demo-stats-overview',
    description: 'Stats command rendering the full dashboard with savings',
    command: 'localpress stats',
    emitGif: true,
    settleMs: 1500,
    height: 750,
    actions: [
      { kind: 'sleep', ms: 5000 }, // hold on the full dashboard
    ],
  },

  {
    name: 'demo-optimize-dry-run',
    description: 'Optimize --all --dry-run showing what localpress would do',
    command: 'localpress optimize --all --dry-run',
    emitGif: true,
    settleMs: 1500,
    actions: [{ kind: 'sleep', ms: 6000 }],
  },

  {
    name: 'demo-history-undo',
    description: 'History list → shows time-machine sessions available for undo',
    command: 'localpress history',
    emitGif: true,
    settleMs: 1500,
    actions: [
      { kind: 'sleep', ms: 4000 }, // hold on history list
      { kind: 'type', text: 'localpress undo --help' },
      { kind: 'sleep', ms: 3000 }, // show undo options
    ],
  },

  {
    name: 'demo-full-workflow',
    description: 'Hero GIF: doctor → list → stats (the full localpress experience)',
    command: 'localpress doctor',
    emitGif: true,
    settleMs: 1500,
    fontSize: 18,
    height: 700,
    actions: [
      { kind: 'sleep', ms: 3500 }, // let doctor output render
      { kind: 'type', text: 'clear && localpress list --limit 5' },
      { kind: 'sleep', ms: 4000 }, // let list render
      { kind: 'type', text: 'clear && localpress stats' },
      { kind: 'sleep', ms: 4000 }, // hold on stats
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Export all recipes
// ═══════════════════════════════════════════════════════════════════════════════

export const RECIPES: Recipe[] = [...STILLS, ...GIFS];
