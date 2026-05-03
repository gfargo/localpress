/**
 * Interactive media browser TUI (`localpress list --interactive`).
 *
 * Layout (wide terminal ≥ 110 cols):
 *   ┌ header: title + page/total ──────────────────────────────┐
 *   │ [← prev page]   Page N/M   [next page →]                 │
 *   │ list (scrollable)             │ sidebar: metadata only    │
 *   └ footer: keybindings ─────────────────────────────────────┘
 *
 * Press [p] on any image to open a full-screen preview overlay.
 * The inline image is rendered only in preview mode to avoid
 * the iTerm2 escape sequence displacing the list layout.
 */

import { Box, Text, useApp, useInput } from 'ink';
import { useCallback, useEffect, useState } from 'react';
import type { MediaItem, PagedResult, SortField, SortOrder } from '../../adapters/types.ts';

export type MediaBrowserAction =
  | { type: 'quit' }
  | { type: 'optimize'; id: number }
  | { type: 'edit'; id: number }
  | { type: 'show'; id: number };

interface Props {
  initialItems: MediaItem[];
  total: number;
  totalPages: number;
  currentPage: number;
  processedIds: Set<number>;
  sortBy?: SortField;
  sortOrder?: SortOrder;
  onAction: (action: MediaBrowserAction) => void;
  onPageChange: (page: number) => Promise<PagedResult<MediaItem>>;
}

const SIDEBAR_WIDTH = 38;
const MIN_SIDEBAR_TERMINAL_WIDTH = 110;
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

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

export function MediaBrowser({
  initialItems,
  total,
  totalPages: initialTotalPages,
  currentPage: initialPage,
  processedIds,
  sortBy,
  sortOrder,
  onAction,
  onPageChange,
}: Props) {
  const { exit } = useApp();

  const [items, setItems] = useState(initialItems);
  const [page, setPage] = useState(initialPage);
  const [totalPages, setTotalPages] = useState(initialTotalPages);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [spinFrame, setSpinFrame] = useState(0);

  // On-demand preview state (only populated when user presses [p]).
  const [previewMode, setPreviewMode] = useState(false);
  const [previewB64, setPreviewB64] = useState<string | null>(null);
  const [previewBytes, setPreviewBytes] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewSpinFrame, setPreviewSpinFrame] = useState(0);

  const termWidth = process.stdout.columns ?? 100;
  const termHeight = process.stdout.rows ?? 24;
  const showSidebar = termWidth >= MIN_SIDEBAR_TERMINAL_WIDTH;
  const listWidth = showSidebar ? termWidth - SIDEBAR_WIDTH - 1 : termWidth;
  // 5 reserved rows: header + page bar + divider + divider + footer.
  const listHeight = Math.max(4, termHeight - 5);
  const canImages = supportsInlineImages();

  // Spinner animation while a page is loading.
  useEffect(() => {
    if (!loading) return;
    const id = setInterval(() => setSpinFrame((f) => (f + 1) % SPIN_FRAMES.length), 80);
    return () => clearInterval(id);
  }, [loading]);

  // Spinner animation while a preview image is loading.
  useEffect(() => {
    if (!previewLoading) return;
    const id = setInterval(() => setPreviewSpinFrame((f) => (f + 1) % SPIN_FRAMES.length), 80);
    return () => clearInterval(id);
  }, [previewLoading]);

  // When selection changes, clear cached preview so [p] fetches fresh for new item.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on item id intentionally
  useEffect(() => {
    setPreviewMode(false);
    setPreviewB64(null);
    setPreviewBytes(0);
  }, [items[cursor]?.id]);

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
    const item = items[cursor];
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
  }, [items, cursor, canImages, previewB64]);

  useInput((input, key) => {
    // In preview mode only Esc/p/q dismiss the overlay; everything else is blocked.
    if (previewMode) {
      if (key.escape || input === 'p' || input === 'q') setPreviewMode(false);
      return;
    }

    if (loading) return;

    if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow || input === 'j') setCursor((c) => Math.min(items.length - 1, c + 1));
    else if (input === 'n' || key.rightArrow) loadPage(page + 1);
    else if (input === 'b' || key.leftArrow) loadPage(page - 1);
    else if (input === 'q' || key.escape) doExit({ type: 'quit' });
    else if (key.return) {
      const item = items[cursor];
      if (item) doExit({ type: 'show', id: item.id });
    } else if (input === 'o') {
      const item = items[cursor];
      if (item) doExit({ type: 'optimize', id: item.id });
    } else if (input === 'e') {
      const item = items[cursor];
      if (item) doExit({ type: 'edit', id: item.id });
    } else if (input === 'p') {
      openPreview();
    }
  });

  const selectedItem = items[cursor];
  const scrollStart = Math.max(
    0,
    Math.min(cursor - Math.floor(listHeight / 2), items.length - listHeight),
  );
  const visibleItems = items.slice(scrollStart, scrollStart + listHeight);
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  // ── Preview overlay ────────────────────────────────────────────────────────
  // Rendered as a standalone full-width layout so the iTerm2 escape sequence
  // doesn't push list items around (no flex siblings to displace).
  if (previewMode && selectedItem) {
    const previewRows = Math.max(8, termHeight - 8);
    const previewCols = Math.max(20, termWidth - 6);

    return (
      <Box flexDirection="column" width={termWidth}>
        {/* Header */}
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

        {/* Image area */}
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
              {buildItermSequence(previewB64, previewBytes, selectedItem.filename, previewCols, previewRows)}
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

        {/* Metadata strip */}
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

        {/* Footer */}
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

      <Box>
        <Text dimColor>{'─'.repeat(termWidth)}</Text>
      </Box>

      {/* ── Main ── */}
      <Box flexDirection="row">
        {/* List panel */}
        <Box flexDirection="column" width={listWidth}>
          {loading ? (
            <Box height={listHeight} alignItems="center" justifyContent="center">
              <Text color="green">
                {SPIN_FRAMES[spinFrame]}
                {'  '}Loading page {page}…
              </Text>
            </Box>
          ) : loadError ? (
            <Box paddingX={2} paddingY={1}>
              <Text color="red">Error: {loadError}</Text>
            </Box>
          ) : visibleItems.length === 0 ? (
            <Box paddingX={2} paddingY={1}>
              <Text dimColor>No items.</Text>
            </Box>
          ) : (
            visibleItems.map((item, i) => {
              const isSelected = scrollStart + i === cursor;
              const isProcessed = processedIds.has(item.id);
              const size = item.sizeBytes ? formatBytes(item.sizeBytes) : '     ';
              const ext = (item.mimeType.split('/')[1] ?? '').slice(0, 4).padEnd(4);
              const maxName = listWidth - 27;
              const name =
                item.filename.length > maxName
                  ? `${item.filename.slice(0, maxName - 1)}…`
                  : item.filename.padEnd(maxName);

              return (
                <Box key={item.id} paddingX={1}>
                  <Text
                    inverse={isSelected}
                    color={isSelected ? undefined : isProcessed ? 'green' : undefined}
                    dimColor={!isSelected && !isProcessed}
                  >
                    {isSelected ? '▶ ' : '  '}
                    <Text color={isSelected ? undefined : 'cyan'}>
                      #{String(item.id).padEnd(5)}
                    </Text>{' '}
                    {name} <Text dimColor={!isSelected}>{ext}</Text>{' '}
                    <Text dimColor={!isSelected}>{size.padStart(8)}</Text>
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
                <Text> </Text>
                <Text dimColor wrap="truncate">
                  {selectedItem.url}
                </Text>
                <Text> </Text>
                <Text dimColor>──────────────────────</Text>
                <Text>
                  <Text color="green">[o]</Text>
                  <Text dimColor> optimize</Text>
                </Text>
                <Text>
                  <Text color="green">[e]</Text>
                  <Text dimColor> edit (round-trip)</Text>
                </Text>
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
              </>
            ) : (
              <Text dimColor>No selection</Text>
            )}
          </Box>
        )}
      </Box>

      {/* ── Footer ── */}
      <Box>
        <Text dimColor>{'─'.repeat(termWidth)}</Text>
      </Box>
      <Box paddingX={1}>
        <Text dimColor>
          [↑↓/jk] navigate [←→/n/b] page{canImages ? ' [p] preview' : ''} [o] optimize [e] edit
          [↵] details [q] quit
        </Text>
      </Box>
    </Box>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
