/**
 * Interactive media browser TUI (`localpress list --interactive`).
 *
 * Layout (wide terminal ≥ 110 cols):
 *   ┌ header: title + page/total ──────────────────────────────┐
 *   │ [← prev page]   Page N/M   [next page →]                 │
 *   │ / search bar (shown when active)                          │
 *   │ list (scrollable)             │ sidebar: metadata only    │
 *   └ footer: keybindings ─────────────────────────────────────┘
 *
 * Press [/] to open the search bar. Typing filters the list
 * client-side (no extra network call). [Esc] clears and closes.
 * [Enter] or arrow keys keep the filter but exit typing mode.
 *
 * Press [p] on any image to open a full-screen preview overlay.
 * The inline image is rendered only in preview mode to avoid the
 * iTerm2 escape sequence displacing the list layout.
 */

import { Box, Text, useApp, useInput } from 'ink';
import { useCallback, useEffect, useState } from 'react';
import type { MediaItem, PagedResult, SortField, SortOrder } from '../../adapters/types.ts';

export type MediaBrowserAction =
  | { type: 'quit'; page: number; cursor: number }
  | {
      type: 'optimize';
      id: number;
      page: number;
      cursor: number;
      quality?: number;
      to?: string;
      keepOriginal?: boolean;
      preview?: boolean;
    }
  | { type: 'edit'; id: number; page: number; cursor: number }
  | { type: 'show'; id: number; page: number; cursor: number }
  | { type: 'remove-bg'; id: number; page: number; cursor: number; preview?: boolean }
  | { type: 'caption'; id: number; page: number; cursor: number }
  | { type: 'convert'; id: number; page: number; cursor: number; to: string; quality?: number }
  | {
      type: 'resize';
      id: number;
      page: number;
      cursor: number;
      maxWidth?: number;
      maxHeight?: number;
    }
  | { type: 'browser-preview'; id: number; page: number; cursor: number }
  | {
      type: 'bulk-optimize';
      ids: number[];
      page: number;
      cursor: number;
      quality?: number;
      to?: string;
    }
  | { type: 'bulk-remove-bg'; ids: number[]; page: number; cursor: number }
  | { type: 'bulk-convert'; ids: number[]; page: number; cursor: number; to: string }
  | { type: 'bulk-pull'; ids: number[]; page: number; cursor: number };

interface Props {
  initialItems: MediaItem[];
  total: number;
  totalPages: number;
  currentPage: number;
  initialCursor?: number;
  processedIds: Set<number>;
  sortBy?: SortField;
  sortOrder?: SortOrder;
  /** Active site name — shown in the header so the user knows which WP site they're browsing. */
  siteName?: string;
  onAction: (action: MediaBrowserAction) => void;
  onPageChange: (page: number) => Promise<PagedResult<MediaItem>>;
  onFetchItem?: (id: number) => Promise<MediaItem>;
  onOpenInBrowser?: (id: number) => void;
  /** Available optimization profiles from config. */
  profiles?: Array<{
    name: string;
    quality?: number;
    format?: string;
    maxWidth?: number;
    maxHeight?: number;
  }>;
}

const SIDEBAR_WIDTH = 38;
const MIN_SIDEBAR_TERMINAL_WIDTH = 110;
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const OPTIMIZE_FORMATS = ['keep', 'webp', 'avif', 'jpeg', 'png'] as const;
type OptimizeFormat = (typeof OPTIMIZE_FORMATS)[number];

function supportsInlineImages(): boolean {
  const tp = process.env.TERM_PROGRAM ?? '';
  return (
    tp === 'iTerm.app' ||
    tp === 'WarpTerminal' ||
    tp === 'WezTerm' ||
    process.env.KITTY_WINDOW_ID !== undefined
  );
}

function buildItermSequence(
  b64: string,
  bytes: number,
  name: string,
  cols: number,
  rows: number,
): string {
  const nameB64 = Buffer.from(name).toString('base64');
  return (
    `\x1b]1337;File=name=${nameB64};size=${bytes};` +
    `inline=1;width=${cols};height=${rows};preserveAspectRatio=1:${b64}\x07`
  );
}

function filterItems(items: MediaItem[], query: string): MediaItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return items;
  return items.filter(
    (item) => item.filename.toLowerCase().includes(q) || item.title.toLowerCase().includes(q),
  );
}

export function MediaBrowser({
  initialItems,
  total,
  totalPages: initialTotalPages,
  currentPage: initialPage,
  initialCursor,
  processedIds,
  sortBy,
  sortOrder,
  siteName,
  onAction,
  onPageChange,
  onFetchItem,
  onOpenInBrowser,
  profiles,
}: Props) {
  const { exit } = useApp();

  const [items, setItems] = useState(initialItems);
  const [page, setPage] = useState(initialPage);
  const [totalPages, setTotalPages] = useState(initialTotalPages);
  const [cursor, setCursor] = useState(() =>
    Math.min(initialCursor ?? 0, Math.max(0, initialItems.length - 1)),
  );
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [spinFrame, setSpinFrame] = useState(0);

  // Search state.
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // On-demand preview state (only populated when user presses [p]).
  const [previewMode, setPreviewMode] = useState(false);
  const [previewB64, setPreviewB64] = useState<string | null>(null);
  const [previewBytes, setPreviewBytes] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewSpinFrame, setPreviewSpinFrame] = useState(0);

  // Inline details overlay state (populated when user presses [↵]).
  const [detailsMode, setDetailsMode] = useState(false);
  const [detailsItem, setDetailsItem] = useState<MediaItem | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  // Optimize settings overlay ([o] / [O] for preview).
  const [optimizeMode, setOptimizeMode] = useState(false);
  const [optimizePreview, setOptimizePreview] = useState(false);
  const [optimizeQuality, setOptimizeQuality] = useState('');
  const [optimizeFormat, setOptimizeFormat] = useState<OptimizeFormat>('keep');
  const [optimizeKeepOriginal, setOptimizeKeepOriginal] = useState(false);
  const [optimizeActiveField, setOptimizeActiveField] = useState<
    'profile' | 'quality' | 'format' | 'keep'
  >('profile');
  const [optimizeProfile, setOptimizeProfile] = useState('');

  // Convert format picker overlay ([c]) — two-step: format then quality.
  const [convertMode, setConvertMode] = useState(false);
  const [convertStep, setConvertStep] = useState<'format' | 'quality'>('format');
  const [convertFormat, setConvertFormat] = useState('');
  const [convertQuality, setConvertQuality] = useState('');

  // Resize dimension input overlay ([s]).
  const [resizeMode, setResizeMode] = useState(false);
  const [resizeWidth, setResizeWidth] = useState('');
  const [resizeHeight, setResizeHeight] = useState('');
  const [resizeActiveField, setResizeActiveField] = useState<'width' | 'height'>('width');

  // Multi-select state.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const termWidth = process.stdout.columns ?? 100;
  const termHeight = process.stdout.rows ?? 24;
  const showSidebar = termWidth >= MIN_SIDEBAR_TERMINAL_WIDTH;
  const listWidth = showSidebar ? termWidth - SIDEBAR_WIDTH - 1 : termWidth;
  const canImages = supportsInlineImages();

  // Derive filtered list from current page items + search query.
  const filteredItems = filterItems(items, searchQuery);

  // 5 reserved rows: header + page bar + divider + divider + footer.
  // +1 extra when the search bar is visible.
  const reservedRows = 5 + (searchMode || searchQuery ? 1 : 0);
  const listHeight = Math.max(4, termHeight - reservedRows);

  // Reset cursor to top when the query changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on query change
  useEffect(() => {
    setCursor(0);
  }, [searchQuery]);

  // Spinner animation while a page is loading (nav-bar indicator only).
  useEffect(() => {
    if (!loading) return;
    const id = setInterval(() => setSpinFrame((f) => (f + 1) % SPIN_FRAMES.length), 150);
    return () => clearInterval(id);
  }, [loading]);

  // Spinner animation while a preview image is loading.
  useEffect(() => {
    if (!previewLoading) return;
    const id = setInterval(() => setPreviewSpinFrame((f) => (f + 1) % SPIN_FRAMES.length), 80);
    return () => clearInterval(id);
  }, [previewLoading]);

  // Clear cached preview whenever the selected item changes (cursor move or query change).
  const selectedItemId = filteredItems[cursor]?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on selected item id intentionally
  useEffect(() => {
    setPreviewMode(false);
    setPreviewB64(null);
    setPreviewBytes(0);
  }, [selectedItemId]);

  const doExit = useCallback(
    (action: MediaBrowserAction) => {
      onAction(action);
      exit();
    },
    [onAction, exit],
  );

  const loadPage = useCallback(
    async (p: number) => {
      if (p < 1 || p > totalPages || loading) return;
      setLoading(true);
      setLoadError('');
      setSearchQuery('');
      setSearchMode(false);
      setPreviewMode(false);
      setPreviewB64(null);
      try {
        const result = await onPageChange(p);
        setItems(result.items);
        setPage(p);
        setTotalPages(result.totalPages);
        setCursor(0);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [totalPages, loading, onPageChange],
  );

  const openPreview = useCallback(() => {
    const item = filteredItems[cursor];
    if (!item || !canImages || !item.mimeType.startsWith('image/')) return;

    // Already cached — just show it.
    if (previewB64) {
      setPreviewMode(true);
      return;
    }

    setPreviewLoading(true);
    fetch(item.url)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        setPreviewB64(Buffer.from(buf).toString('base64'));
        setPreviewBytes(buf.byteLength);
        setPreviewLoading(false);
        setPreviewMode(true);
      })
      .catch(() => setPreviewLoading(false));
  }, [filteredItems, cursor, canImages, previewB64]);

  useInput((input, key) => {
    // Details overlay: any key closes it.
    if (detailsMode || detailsLoading) {
      if (detailsLoading) return;
      setDetailsMode(false);
      setDetailsItem(null);
      return;
    }

    // Preview overlay: any key closes it.
    if (previewMode) {
      if (key.escape || input === 'p' || input === 'q') setPreviewMode(false);
      return;
    }

    // Optimize settings overlay.
    if (optimizeMode) {
      const item = filteredItems[cursor];
      if (key.escape) {
        setOptimizeMode(false);
        setOptimizePreview(false);
        setOptimizeQuality('');
        setOptimizeFormat('keep');
        setOptimizeKeepOriginal(false);
        setOptimizeActiveField('profile');
        setOptimizeProfile('');
        return;
      }
      if (key.tab) {
        setOptimizeActiveField((f) => {
          if (f === 'profile') return 'quality';
          if (f === 'quality') return 'format';
          if (f === 'format') return 'keep';
          return 'profile';
        });
        return;
      }
      if (optimizeActiveField === 'profile') {
        if (profiles && profiles.length > 0) {
          const profileNames = ['', ...profiles.map((p) => p.name)];
          const idx = profileNames.indexOf(optimizeProfile);
          if (key.rightArrow || input === ' ') {
            const next = profileNames[(idx + 1) % profileNames.length];
            setOptimizeProfile(next);
            // Apply profile values as defaults.
            if (next) {
              const p = profiles.find((pr) => pr.name === next);
              if (p) {
                if (p.quality) setOptimizeQuality(String(p.quality));
                if (p.format && OPTIMIZE_FORMATS.includes(p.format as OptimizeFormat)) {
                  setOptimizeFormat(p.format as OptimizeFormat);
                }
              }
            }
            return;
          }
          if (key.leftArrow) {
            const next = profileNames[(idx - 1 + profileNames.length) % profileNames.length];
            setOptimizeProfile(next);
            if (next) {
              const p = profiles.find((pr) => pr.name === next);
              if (p) {
                if (p.quality) setOptimizeQuality(String(p.quality));
                if (p.format && OPTIMIZE_FORMATS.includes(p.format as OptimizeFormat)) {
                  setOptimizeFormat(p.format as OptimizeFormat);
                }
              }
            }
            return;
          }
        }
        if (key.return) {
          setOptimizeActiveField('quality');
          return;
        }
      }
      if (optimizeActiveField === 'quality') {
        if (key.backspace || key.delete) {
          setOptimizeQuality((v) => v.slice(0, -1));
          return;
        }
        if (input && /^\d$/.test(input)) {
          setOptimizeQuality((v) => v + input);
          return;
        }
      }
      if (optimizeActiveField === 'format') {
        const idx = OPTIMIZE_FORMATS.indexOf(optimizeFormat);
        if (key.rightArrow || input === ' ') {
          setOptimizeFormat(OPTIMIZE_FORMATS[(idx + 1) % OPTIMIZE_FORMATS.length]);
          return;
        }
        if (key.leftArrow) {
          setOptimizeFormat(
            OPTIMIZE_FORMATS[(idx - 1 + OPTIMIZE_FORMATS.length) % OPTIMIZE_FORMATS.length],
          );
          return;
        }
      }
      if (optimizeActiveField === 'keep') {
        if (input === ' ' || key.return) {
          if (input === ' ') {
            setOptimizeKeepOriginal((v) => !v);
            return;
          }
        }
      }
      if (key.return) {
        if (!item) return;
        const q = Number.parseInt(optimizeQuality, 10);
        const quality = q >= 0 && q <= 100 ? q : undefined;
        const to = optimizeFormat === 'keep' ? undefined : optimizeFormat;
        const keepOriginal = optimizeKeepOriginal || undefined;
        const preview = optimizePreview || undefined;
        setOptimizeMode(false);
        setOptimizePreview(false);
        setOptimizeQuality('');
        setOptimizeFormat('keep');
        setOptimizeKeepOriginal(false);
        setOptimizeActiveField('profile');
        setOptimizeProfile('');
        doExit({ type: 'optimize', id: item.id, page, cursor, quality, to, keepOriginal, preview });
      }
      return;
    }

    // Convert format picker + quality overlay.
    if (convertMode) {
      const item = filteredItems[cursor];
      if (key.escape) {
        if (convertStep === 'quality') {
          setConvertStep('format');
          setConvertQuality('');
        } else {
          setConvertMode(false);
          setConvertStep('format');
          setConvertFormat('');
          setConvertQuality('');
        }
        return;
      }
      if (convertStep === 'format') {
        const fmtMap: Record<string, string> = { w: 'webp', a: 'avif', j: 'jpeg', p: 'png' };
        const fmt = fmtMap[input];
        if (fmt) {
          setConvertFormat(fmt);
          setConvertStep('quality');
        }
        return;
      }
      // Quality step.
      if (key.backspace || key.delete) {
        setConvertQuality((v) => v.slice(0, -1));
        return;
      }
      if (input && /^\d$/.test(input)) {
        setConvertQuality((v) => v + input);
        return;
      }
      if (key.return && item) {
        const q = Number.parseInt(convertQuality, 10);
        const quality = q >= 0 && q <= 100 ? q : undefined;
        const to = convertFormat;
        setConvertMode(false);
        setConvertStep('format');
        setConvertFormat('');
        setConvertQuality('');
        doExit({ type: 'convert', id: item.id, page, cursor, to, quality });
      }
      return;
    }

    // Resize dimension input overlay.
    if (resizeMode) {
      if (key.escape) {
        setResizeMode(false);
        setResizeWidth('');
        setResizeHeight('');
        setResizeActiveField('width');
        return;
      }
      if (key.tab) {
        setResizeActiveField((f) => (f === 'width' ? 'height' : 'width'));
        return;
      }
      if (key.return) {
        const item = filteredItems[cursor];
        if (!item) return;
        const w = Number.parseInt(resizeWidth, 10) || undefined;
        const h = Number.parseInt(resizeHeight, 10) || undefined;
        if (!w && !h) return;
        setResizeMode(false);
        setResizeWidth('');
        setResizeHeight('');
        setResizeActiveField('width');
        doExit({ type: 'resize', id: item.id, page, cursor, maxWidth: w, maxHeight: h });
        return;
      }
      if (key.backspace || key.delete) {
        if (resizeActiveField === 'width') setResizeWidth((v) => v.slice(0, -1));
        else setResizeHeight((v) => v.slice(0, -1));
        return;
      }
      if (input && /^\d$/.test(input)) {
        if (resizeActiveField === 'width') setResizeWidth((v) => v + input);
        else setResizeHeight((v) => v + input);
      }
      return;
    }

    // Search input mode.
    if (searchMode) {
      if (key.escape) {
        setSearchQuery('');
        setSearchMode(false);
        return;
      }
      if (key.return) {
        setSearchMode(false);
        return;
      }
      if (key.backspace || key.delete) {
        setSearchQuery((q) => q.slice(0, -1));
        return;
      }
      if (key.upArrow || input === 'k') {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow || input === 'j') {
        setCursor((c) => Math.min(filteredItems.length - 1, c + 1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setSearchQuery((q) => q + input);
      }
      return;
    }

    if (loading) return;

    if (input === '/') {
      setSearchMode(true);
    } else if (key.upArrow || input === 'k') {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.downArrow || input === 'j') {
      setCursor((c) => Math.min(filteredItems.length - 1, c + 1));
    } else if (input === 'n' || key.rightArrow) {
      loadPage(page + 1);
    } else if (input === 'b' || key.leftArrow) {
      loadPage(page - 1);
    } else if (input === ' ') {
      // Space: toggle selection on current item.
      const item = filteredItems[cursor];
      if (item) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(item.id)) {
            next.delete(item.id);
          } else {
            next.add(item.id);
          }
          return next;
        });
        // Move cursor down after selecting (like file managers).
        setCursor((c) => Math.min(filteredItems.length - 1, c + 1));
      }
    } else if (key.ctrl && input === 'a') {
      // Ctrl+A: select all on current page.
      setSelectedIds(new Set(filteredItems.map((i) => i.id)));
    } else if (key.ctrl && input === 'd') {
      // Ctrl+D: deselect all.
      setSelectedIds(new Set());
    } else if (key.escape || input === 'q') {
      if (searchQuery) {
        setSearchQuery('');
      } else if (selectedIds.size > 0) {
        // Escape clears selection first, then quits.
        setSelectedIds(new Set());
      } else {
        doExit({ type: 'quit', page, cursor });
      }
    } else if (key.return) {
      const item = filteredItems[cursor];
      if (!item) return;
      if (onFetchItem) {
        setDetailsLoading(true);
        onFetchItem(item.id)
          .then((full) => {
            setDetailsItem(full);
            setDetailsLoading(false);
            setDetailsMode(true);
          })
          .catch(() => {
            setDetailsItem(item);
            setDetailsLoading(false);
            setDetailsMode(true);
          });
      } else {
        doExit({ type: 'show', id: item.id, page, cursor });
      }
    } else if (input === 'o') {
      // If items are selected, dispatch bulk optimize.
      if (selectedIds.size > 0) {
        doExit({ type: 'bulk-optimize', ids: [...selectedIds], page, cursor });
        return;
      }
      const item = filteredItems[cursor];
      if (item) {
        setOptimizeQuality('');
        setOptimizeFormat('keep');
        setOptimizeKeepOriginal(false);
        setOptimizeActiveField('quality');
        setOptimizePreview(false);
        setOptimizeMode(true);
      }
    } else if (input === 'r') {
      // If items are selected, dispatch bulk remove-bg.
      if (selectedIds.size > 0) {
        doExit({ type: 'bulk-remove-bg', ids: [...selectedIds], page, cursor });
        return;
      }
      const item = filteredItems[cursor];
      if (item?.mimeType.startsWith('image/'))
        doExit({ type: 'remove-bg', id: item.id, page, cursor });
    } else if (input === 'R') {
      const item = filteredItems[cursor];
      if (item?.mimeType.startsWith('image/'))
        doExit({ type: 'remove-bg', id: item.id, page, cursor, preview: true });
    } else if (input === 'O') {
      // Skip the terminal settings form — go straight to browser preview.
      const item = filteredItems[cursor];
      if (item) {
        doExit({ type: 'optimize', id: item.id, page, cursor, preview: true });
      }
    } else if (input === 'c') {
      const item = filteredItems[cursor];
      if (item?.mimeType.startsWith('image/')) {
        setConvertStep('format');
        setConvertFormat('');
        setConvertQuality('');
        setConvertMode(true);
      }
    } else if (input === 's') {
      const item = filteredItems[cursor];
      if (item?.mimeType.startsWith('image/')) {
        setResizeWidth('');
        setResizeHeight('');
        setResizeActiveField('width');
        setResizeMode(true);
      }
    } else if (input === 'a') {
      const item = filteredItems[cursor];
      if (item?.mimeType.startsWith('image/'))
        doExit({ type: 'caption', id: item.id, page, cursor });
    } else if (input === 'e') {
      const item = filteredItems[cursor];
      if (item) doExit({ type: 'edit', id: item.id, page, cursor });
    } else if (input === 'W') {
      const item = filteredItems[cursor];
      if (item && onOpenInBrowser) onOpenInBrowser(item.id);
    } else if (input === 'p') {
      openPreview();
    } else if (input === 'P') {
      const item = filteredItems[cursor];
      if (item?.mimeType.startsWith('image/'))
        doExit({ type: 'browser-preview', id: item.id, page, cursor });
    }
  });

  const selectedItem = filteredItems[cursor];
  const scrollStart = Math.max(
    0,
    Math.min(cursor - Math.floor(listHeight / 2), filteredItems.length - listHeight),
  );
  const visibleItems = filteredItems.slice(scrollStart, scrollStart + listHeight);
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  // ── Optimize settings overlay ([o]) ───────────────────────────────────────
  if (optimizeMode) {
    const item = filteredItems[cursor];
    const qNum = Number.parseInt(optimizeQuality, 10);
    const qValid = optimizeQuality === '' || (qNum >= 0 && qNum <= 100);
    const fmtIdx = OPTIMIZE_FORMATS.indexOf(optimizeFormat);
    return (
      <Box flexDirection="column" width={termWidth}>
        <Box paddingX={1} justifyContent="space-between">
          <Box gap={1}>
            <Text bold color="green">
              Optimize
            </Text>
            {optimizePreview && <Text color="cyan"> (browser preview)</Text>}
            {item && (
              <Text dimColor>
                — {item.filename}
                {item.sizeBytes ? `  (${formatBytes(item.sizeBytes)})` : ''}
                {item.width ? `  ${item.width}×${item.height}px` : ''}
              </Text>
            )}
          </Box>
          <Text dimColor>[↵] confirm [Esc] cancel</Text>
        </Box>
        <Box>
          <Text dimColor>{'─'.repeat(termWidth)}</Text>
        </Box>
        <Box flexDirection="column" paddingX={2} paddingY={1} gap={1}>
          <Text dimColor>Leave fields blank to use defaults. [Tab] to move between fields.</Text>
          <Text> </Text>

          {/* Profile field */}
          {profiles && profiles.length > 0 && (
            <Box gap={2} alignItems="center">
              <Text
                color={optimizeActiveField === 'profile' ? 'green' : undefined}
                dimColor={optimizeActiveField !== 'profile'}
                bold={optimizeActiveField === 'profile'}
              >
                Profile:
              </Text>
              <Text
                color={optimizeProfile ? 'green' : undefined}
                dimColor={!optimizeProfile}
                inverse={optimizeActiveField === 'profile'}
              >
                {optimizeProfile || '(none)'}
              </Text>
              {optimizeActiveField === 'profile' && <Text dimColor> ← → or space to cycle</Text>}
            </Box>
          )}

          {/* Quality field */}
          <Box gap={2} alignItems="center">
            <Text
              color={optimizeActiveField === 'quality' ? 'green' : undefined}
              dimColor={optimizeActiveField !== 'quality'}
              bold={optimizeActiveField === 'quality'}
            >
              Quality (0–100):
            </Text>
            <Text
              color={optimizeActiveField === 'quality' ? 'green' : undefined}
              dimColor={optimizeActiveField !== 'quality'}
            >
              {optimizeQuality || (optimizeActiveField === 'quality' ? '' : '—')}
              {optimizeActiveField === 'quality' && <Text color="green">█</Text>}
            </Text>
            {!qValid && <Text color="red"> invalid</Text>}
            {optimizeActiveField === 'quality' && <Text dimColor> (blank = default ~75)</Text>}
          </Box>

          {/* Format field */}
          <Box gap={2} alignItems="center">
            <Text
              color={optimizeActiveField === 'format' ? 'green' : undefined}
              dimColor={optimizeActiveField !== 'format'}
              bold={optimizeActiveField === 'format'}
            >
              Convert to:
            </Text>
            <Box gap={1}>
              {OPTIMIZE_FORMATS.map((f, i) => (
                <Text
                  key={f}
                  color={optimizeFormat === f ? 'green' : undefined}
                  dimColor={optimizeFormat !== f}
                  inverse={optimizeActiveField === 'format' && optimizeFormat === f}
                >
                  {i > 0 && ' '}
                  {f === 'keep' ? 'keep' : f}
                </Text>
              ))}
            </Box>
            {optimizeActiveField === 'format' && (
              <Text dimColor>
                {' '}
                ← → or space to cycle (current: {fmtIdx + 1}/{OPTIMIZE_FORMATS.length})
              </Text>
            )}
          </Box>

          {/* Keep original toggle */}
          <Box gap={2} alignItems="center">
            <Text
              color={optimizeActiveField === 'keep' ? 'green' : undefined}
              dimColor={optimizeActiveField !== 'keep'}
              bold={optimizeActiveField === 'keep'}
            >
              Keep original:
            </Text>
            <Text
              color={optimizeKeepOriginal ? 'green' : undefined}
              dimColor={!optimizeKeepOriginal}
            >
              {optimizeKeepOriginal ? 'yes — upload as new attachment' : 'no — replace in place'}
            </Text>
            {optimizeActiveField === 'keep' && <Text dimColor> [Space] toggle</Text>}
          </Box>
        </Box>
        <Box>
          <Text dimColor>{'─'.repeat(termWidth)}</Text>
        </Box>
        <Box paddingX={1} gap={3}>
          <Text dimColor>[Tab] next field</Text>
          <Text color="green">[↵] confirm</Text>
          <Text dimColor>[Esc] cancel</Text>
        </Box>
      </Box>
    );
  }

  // ── Convert format picker + quality overlay ([c]) ─────────────────────────
  if (convertMode) {
    const item = filteredItems[cursor];
    const fmtLabels: Record<string, string> = {
      webp: 'WebP',
      avif: 'AVIF',
      jpeg: 'JPEG',
      png: 'PNG',
    };
    const qNum = Number.parseInt(convertQuality, 10);
    const qValid = convertQuality === '' || (qNum >= 0 && qNum <= 100);

    if (convertStep === 'format') {
      return (
        <Box flexDirection="column" width={termWidth}>
          <Box paddingX={1} justifyContent="space-between">
            <Box gap={1}>
              <Text bold color="green">
                Convert
              </Text>
              {item && <Text dimColor>— {item.filename}</Text>}
            </Box>
            <Text dimColor>[Esc] cancel</Text>
          </Box>
          <Box>
            <Text dimColor>{'─'.repeat(termWidth)}</Text>
          </Box>
          <Box flexDirection="column" paddingX={2} paddingY={1} gap={1}>
            <Text dimColor>Choose target format:</Text>
            <Text> </Text>
            <Text>
              <Text color="green">[w]</Text>
              <Text dimColor> WebP </Text>browser-native, lossy + lossless
            </Text>
            <Text>
              <Text color="green">[a]</Text>
              <Text dimColor> AVIF </Text>best compression, broad support
            </Text>
            <Text>
              <Text color="green">[j]</Text>
              <Text dimColor> JPEG </Text>universal compatibility
            </Text>
            <Text>
              <Text color="green">[p]</Text>
              <Text dimColor> PNG </Text>lossless, supports transparency
            </Text>
          </Box>
          <Box>
            <Text dimColor>{'─'.repeat(termWidth)}</Text>
          </Box>
          <Box paddingX={1}>
            <Text dimColor>Press a format key, or [Esc] to cancel</Text>
          </Box>
        </Box>
      );
    }

    // Quality step.
    return (
      <Box flexDirection="column" width={termWidth}>
        <Box paddingX={1} justifyContent="space-between">
          <Box gap={1}>
            <Text bold color="green">
              Convert
            </Text>
            <Text dimColor>— {item?.filename}</Text>
            <Text color="green">→ {fmtLabels[convertFormat] ?? convertFormat}</Text>
          </Box>
          <Text dimColor>[↵] confirm [Esc] back</Text>
        </Box>
        <Box>
          <Text dimColor>{'─'.repeat(termWidth)}</Text>
        </Box>
        <Box flexDirection="column" paddingX={2} paddingY={1} gap={1}>
          <Box gap={2} alignItems="center">
            <Text bold color="green">
              Quality (0–100):
            </Text>
            <Text color="green">
              {convertQuality}
              <Text color="green">█</Text>
            </Text>
            {!qValid && <Text color="red"> invalid</Text>}
            <Text dimColor> (blank = default ~75)</Text>
          </Box>
        </Box>
        <Box>
          <Text dimColor>{'─'.repeat(termWidth)}</Text>
        </Box>
        <Box paddingX={1} gap={3}>
          <Text color="green">[↵] confirm</Text>
          <Text dimColor>[Esc] back to format</Text>
        </Box>
      </Box>
    );
  }

  // ── Resize dimension input overlay ([s]) ──────────────────────────────────
  if (resizeMode) {
    const item = filteredItems[cursor];
    const dims = item?.width && item?.height ? `${item.width}×${item.height}px` : '';
    const widthValid = resizeWidth === '' || /^\d+$/.test(resizeWidth);
    const heightValid = resizeHeight === '' || /^\d+$/.test(resizeHeight);
    const canConfirm =
      Number.parseInt(resizeWidth, 10) > 0 || Number.parseInt(resizeHeight, 10) > 0;
    return (
      <Box flexDirection="column" width={termWidth}>
        <Box paddingX={1} justifyContent="space-between">
          <Box gap={1}>
            <Text bold color="green">
              Resize
            </Text>
            {item && (
              <Text dimColor>
                — {item.filename}
                {dims ? `  (${dims})` : ''}
              </Text>
            )}
          </Box>
          <Text dimColor>[↵] confirm [Esc] cancel</Text>
        </Box>
        <Box>
          <Text dimColor>{'─'.repeat(termWidth)}</Text>
        </Box>
        <Box flexDirection="column" paddingX={2} paddingY={1} gap={1}>
          <Text dimColor>At least one constraint required. Aspect ratio is preserved.</Text>
          <Text> </Text>
          <Box gap={2} alignItems="center">
            <Text dimColor>Max width (px):</Text>
            <Text
              color={resizeActiveField === 'width' ? 'green' : undefined}
              dimColor={resizeActiveField !== 'width'}
            >
              {resizeWidth || (resizeActiveField === 'width' ? '' : '—')}
              {resizeActiveField === 'width' && <Text color="green">█</Text>}
            </Text>
            {!widthValid && <Text color="red"> invalid</Text>}
          </Box>
          <Box gap={2} alignItems="center">
            <Text dimColor>Max height (px):</Text>
            <Text
              color={resizeActiveField === 'height' ? 'green' : undefined}
              dimColor={resizeActiveField !== 'height'}
            >
              {resizeHeight || (resizeActiveField === 'height' ? '' : '—')}
              {resizeActiveField === 'height' && <Text color="green">█</Text>}
            </Text>
            {!heightValid && <Text color="red"> invalid</Text>}
          </Box>
        </Box>
        <Box>
          <Text dimColor>{'─'.repeat(termWidth)}</Text>
        </Box>
        <Box paddingX={1} gap={3}>
          <Text dimColor>[Tab] switch field</Text>
          <Text color={canConfirm ? 'green' : undefined} dimColor={!canConfirm}>
            [↵] confirm
          </Text>
          <Text dimColor>[Esc] cancel</Text>
        </Box>
      </Box>
    );
  }

  // ── Details overlay (↵) ───────────────────────────────────────────────────
  if (detailsLoading || (detailsMode && detailsItem)) {
    const d = detailsItem;
    return (
      <Box flexDirection="column" width={termWidth}>
        <Box paddingX={1} justifyContent="space-between">
          <Box gap={1}>
            <Text bold color="green">
              Details
            </Text>
            {d && <Text dimColor>— {d.filename}</Text>}
          </Box>
          <Text dimColor>[any key] close</Text>
        </Box>
        <Box>
          <Text dimColor>{'─'.repeat(termWidth)}</Text>
        </Box>

        {detailsLoading ? (
          <Box height={8} alignItems="center" justifyContent="center">
            <Text color="green">
              {SPIN_FRAMES[spinFrame]}
              {'  '}Loading…
            </Text>
          </Box>
        ) : d ? (
          <Box flexDirection="column" paddingX={2} paddingY={1}>
            <Text>
              <Text dimColor>Title </Text>
              {d.title}
            </Text>
            <Text>
              <Text dimColor>Filename </Text>
              {d.filename}
            </Text>
            <Text>
              <Text dimColor>URL </Text>
              <Text wrap="truncate">{d.url}</Text>
            </Text>
            <Text>
              <Text dimColor>MIME </Text>
              {d.mimeType}
            </Text>
            {d.width !== undefined && (
              <Text>
                <Text dimColor>Dimensions</Text>
                {'  '}
                {d.width}×{d.height}px
              </Text>
            )}
            {d.sizeBytes !== undefined && (
              <Text>
                <Text dimColor>Size </Text>
                {'  '}
                {formatBytes(d.sizeBytes)}
              </Text>
            )}
            {d.mimeType.startsWith('image/') && (
              <Text color={d.altText ? undefined : 'yellow'}>
                <Text dimColor>Alt text </Text>
                {'  '}
                {d.altText ?? <Text color="yellow">⚠ missing — press [a] to generate</Text>}
              </Text>
            )}
            {d.caption && (
              <Text>
                <Text dimColor>Caption </Text>
                <Text wrap="truncate">{d.caption}</Text>
              </Text>
            )}
            {d.description && (
              <Text>
                <Text dimColor>Description </Text>
                <Text wrap="truncate">{d.description}</Text>
              </Text>
            )}
            {d.uploadedAt && (
              <Text>
                <Text dimColor>Uploaded </Text>
                {'  '}
                {d.uploadedAt}
              </Text>
            )}
            {d.sizes && Object.keys(d.sizes).length > 0 && (
              <>
                <Text> </Text>
                <Text bold dimColor>
                  Registered sizes:
                </Text>
                {Object.entries(d.sizes).map(([name, sz]) => (
                  <Text key={name} dimColor>
                    {`  ${name.padEnd(14)} ${sz.width}×${sz.height}${sz.sizeBytes ? `  (${formatBytes(sz.sizeBytes)})` : ''}`}
                  </Text>
                ))}
              </>
            )}
            {processedIds.has(d.id) && (
              <>
                <Text> </Text>
                <Text color="green">✓ Processed by localpress</Text>
              </>
            )}
          </Box>
        ) : null}

        <Box>
          <Text dimColor>{'─'.repeat(termWidth)}</Text>
        </Box>
        <Box paddingX={1}>
          <Text dimColor>Press any key to return to the browser</Text>
        </Box>
      </Box>
    );
  }

  // ── Preview overlay ────────────────────────────────────────────────────────
  if (previewMode && selectedItem) {
    const previewRows = Math.max(8, termHeight - 8);
    const previewCols = Math.max(20, termWidth - 6);

    return (
      <Box flexDirection="column" width={termWidth}>
        <Box paddingX={1} justifyContent="space-between">
          <Box gap={1}>
            <Text bold color="green">
              Preview
            </Text>
            <Text dimColor>— {selectedItem.filename}</Text>
          </Box>
          <Text dimColor>[p / Esc] close</Text>
        </Box>
        <Box>
          <Text dimColor>{'─'.repeat(termWidth)}</Text>
        </Box>

        <Box height={previewRows} paddingX={2} flexDirection="column">
          {previewLoading ? (
            <Box height={previewRows} alignItems="center" justifyContent="center">
              <Text color="green">
                {SPIN_FRAMES[previewSpinFrame]}
                {'  '}Loading preview…
              </Text>
            </Box>
          ) : previewB64 ? (
            <Text>
              {buildItermSequence(
                previewB64,
                previewBytes,
                selectedItem.filename,
                previewCols,
                previewRows,
              )}
            </Text>
          ) : (
            <Box height={previewRows} alignItems="center" justifyContent="center">
              <Text dimColor>Preview unavailable</Text>
            </Box>
          )}
        </Box>

        <Box>
          <Text dimColor>{'─'.repeat(termWidth)}</Text>
        </Box>
        <Box paddingX={2} gap={3}>
          <Text dimColor>#{selectedItem.id}</Text>
          <Text dimColor>{selectedItem.mimeType}</Text>
          {selectedItem.width !== undefined && (
            <Text dimColor>
              {selectedItem.width}×{selectedItem.height}px
            </Text>
          )}
          {selectedItem.sizeBytes !== undefined && (
            <Text dimColor>{formatBytes(selectedItem.sizeBytes)}</Text>
          )}
          {processedIds.has(selectedItem.id) && <Text color="green">✓ optimized</Text>}
        </Box>
        <Box paddingX={1}>
          <Text dimColor>Press [p] or [Esc] to return to list</Text>
        </Box>
      </Box>
    );
  }

  // ── Normal list view ───────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" width={termWidth}>
      {/* ── Header ── */}
      <Box paddingX={1} justifyContent="space-between">
        <Box gap={1}>
          <Text bold color="green">
            localPress
          </Text>
          {siteName && <Text color="cyan">· {siteName}</Text>}
          <Text dimColor>— media library</Text>
          {sortBy && sortBy !== 'date' && (
            <Text dimColor>
              · {sortBy} {sortOrder ?? 'desc'}
            </Text>
          )}
        </Box>
        <Text dimColor>
          Page {page}/{totalPages} · {total} total
        </Text>
      </Box>

      {/* ── Page navigation bar ── */}
      <Box paddingX={1} justifyContent="space-between">
        <Text color={hasPrev ? 'green' : undefined} dimColor={!hasPrev}>
          {hasPrev ? '← [b] prev page' : '              '}
        </Text>
        {loading && (
          <Text color="green">
            {SPIN_FRAMES[spinFrame]} loading page {page}…
          </Text>
        )}
        <Text color={hasNext ? 'green' : undefined} dimColor={!hasNext}>
          {hasNext ? '[n] next page →' : '              '}
        </Text>
      </Box>

      {/* ── Search bar (shown when active or a query is set) ── */}
      {(searchMode || searchQuery) && (
        <Box paddingX={1} gap={1}>
          <Text color="yellow" bold>
            /
          </Text>
          <Text>{searchQuery}</Text>
          {searchMode && <Text color="yellow">█</Text>}
          {searchQuery && (
            <Text dimColor>
              {' '}
              —{' '}
              {filteredItems.length === 0
                ? 'no matches'
                : `${filteredItems.length} match${filteredItems.length === 1 ? '' : 'es'}`}
              {!searchMode && '  [/] edit  [Esc] clear'}
            </Text>
          )}
          {searchMode && !searchQuery && <Text dimColor> type to filter · [Esc] cancel</Text>}
        </Box>
      )}

      <Box>
        <Text dimColor>{'─'.repeat(termWidth)}</Text>
      </Box>

      {/* ── Main ── */}
      <Box flexDirection="row">
        {/* List panel */}
        <Box flexDirection="column" width={listWidth}>
          {loadError ? (
            <Box paddingX={2} paddingY={1}>
              <Text color="red">Error: {loadError}</Text>
            </Box>
          ) : visibleItems.length === 0 ? (
            <Box paddingX={2} paddingY={1}>
              <Text dimColor>{searchQuery ? `No matches for "${searchQuery}"` : 'No items.'}</Text>
            </Box>
          ) : (
            visibleItems.map((item, i) => {
              // Keep the previous page's rows visible (dimmed) while loading —
              // avoids the tall-box → rows layout thrash that causes flicker.
              const isSelected = !loading && scrollStart + i === cursor;
              const isChecked = selectedIds.has(item.id);
              const isProcessed = !loading && processedIds.has(item.id);
              const isImage = item.mimeType.startsWith('image/');
              const missingAlt = !loading && isImage && !item.altText;
              const size = item.sizeBytes ? formatBytes(item.sizeBytes) : '     ';
              const ext = (item.mimeType.split('/')[1] ?? '').slice(0, 4).padEnd(4);
              const maxName = listWidth - 32;
              const name =
                item.filename.length > maxName
                  ? `${item.filename.slice(0, maxName - 1)}…`
                  : item.filename.padEnd(maxName);

              return (
                <Box key={item.id} paddingX={1}>
                  <Text
                    inverse={isSelected}
                    color={isSelected ? undefined : isProcessed ? 'green' : undefined}
                    dimColor={loading || (!isSelected && !isProcessed)}
                  >
                    {isSelected ? '▶ ' : isChecked ? '● ' : '  '}
                    <Text color={isSelected ? undefined : 'cyan'}>
                      #{String(item.id).padEnd(5)}
                    </Text>{' '}
                    {name}{' '}
                    <Text
                      color={!loading && missingAlt ? 'yellow' : undefined}
                      dimColor={loading || !missingAlt}
                    >
                      {missingAlt ? '⚠' : ' '}
                    </Text>{' '}
                    <Text dimColor={loading || !isSelected}>{ext}</Text>{' '}
                    <Text dimColor={loading || !isSelected}>{size.padStart(8)}</Text>
                  </Text>
                </Box>
              );
            })
          )}
        </Box>

        {/* Sidebar — metadata only; no inline image to avoid layout disruption */}
        {showSidebar && (
          <Box
            flexDirection="column"
            width={SIDEBAR_WIDTH}
            borderStyle="single"
            borderTop={false}
            borderBottom={false}
            borderRight={false}
            paddingX={1}
          >
            {selectedItem ? (
              <>
                <Text bold color="green" wrap="truncate">
                  {selectedItem.filename}
                </Text>
                <Text dimColor>#{selectedItem.id}</Text>
                <Text dimColor>{selectedItem.mimeType}</Text>
                {selectedItem.sizeBytes !== undefined && (
                  <Text dimColor>{formatBytes(selectedItem.sizeBytes)}</Text>
                )}
                {selectedItem.width !== undefined && (
                  <Text dimColor>
                    {selectedItem.width}×{selectedItem.height}px
                  </Text>
                )}
                {processedIds.has(selectedItem.id) && <Text color="green">✓ optimized</Text>}
                {selectedItem.mimeType.startsWith('image/') &&
                  (selectedItem.altText ? (
                    <Text color="green" wrap="truncate">
                      ✓ alt: {selectedItem.altText}
                    </Text>
                  ) : (
                    <Text color="yellow">⚠ no alt text</Text>
                  ))}
                <Text> </Text>
                <Text dimColor wrap="truncate">
                  {selectedItem.url}
                </Text>
                <Text> </Text>
                <Text dimColor>── actions ────────────</Text>
                <Text>
                  <Text color="green">[o]</Text>
                  <Text dimColor> optimize…</Text>
                </Text>
                <Text>
                  <Text color="cyan">[O]</Text>
                  <Text dimColor> optimize (preview)…</Text>
                </Text>
                {selectedItem.mimeType.startsWith('image/') && (
                  <>
                    <Text>
                      <Text color="green">[r]</Text>
                      <Text dimColor> remove background</Text>
                    </Text>
                    <Text>
                      <Text color="cyan">[R]</Text>
                      <Text dimColor> remove bg (preview)</Text>
                    </Text>
                    <Text>
                      <Text color="green">[c]</Text>
                      <Text dimColor> convert format…</Text>
                    </Text>
                    <Text>
                      <Text color="green">[s]</Text>
                      <Text dimColor> resize…</Text>
                    </Text>
                    <Text>
                      <Text color="green">[a]</Text>
                      <Text dimColor> caption / alt text</Text>
                    </Text>
                  </>
                )}
                <Text>
                  <Text color="green">[e]</Text>
                  <Text dimColor> edit (round-trip)</Text>
                </Text>
                {onOpenInBrowser && (
                  <Text>
                    <Text color="cyan">[W]</Text>
                    <Text dimColor> open in WordPress</Text>
                  </Text>
                )}
                <Text> </Text>
                <Text dimColor>── view ───────────────</Text>
                <Text>
                  <Text color="green">[↵]</Text>
                  <Text dimColor> show details</Text>
                </Text>
                {canImages && selectedItem.mimeType.startsWith('image/') && (
                  <Text>
                    <Text color="cyan">[p]</Text>
                    <Text dimColor> preview image</Text>
                  </Text>
                )}
                {selectedItem.mimeType.startsWith('image/') && (
                  <Text>
                    <Text color="cyan">[P]</Text>
                    <Text dimColor> open in browser</Text>
                  </Text>
                )}
              </>
            ) : (
              <Text dimColor>
                {searchQuery ? `No matches for "${searchQuery}"` : 'No selection'}
              </Text>
            )}
          </Box>
        )}
      </Box>

      {/* ── Footer ── */}
      <Box>
        <Text dimColor>{'─'.repeat(termWidth)}</Text>
      </Box>
      <Box paddingX={1}>
        {selectedItem?.mimeType.startsWith('image/') ? (
          <Text dimColor>
            [jk] nav [nb] page [/] search [o] opt [O] opt+preview [r] rembg [R] rembg+preview [c]
            conv [s] resize [a] cap [e] edit [W] WP [↵] details
            {canImages ? '  [p] preview' : ''} [q] quit
          </Text>
        ) : (
          <Text dimColor>
            [↑↓/jk] navigate [←→/n/b] page [/] search [o] optimize [O] opt+preview [e] edit [W] open
            in WP [↵] details [q] quit
          </Text>
        )}
      </Box>
    </Box>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
