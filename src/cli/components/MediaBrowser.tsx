/**
 * Interactive media browser TUI (`localpress list --interactive`).
 *
 * Layout (wide terminal ≥ 110 cols):
 *   ┌ header: title + page/total ──────────────────────────────┐
 *   │ [← prev page]   Page N/M   [next page →]                 │
 *   │ list (scrollable)             │ sidebar: thumbnail + meta │
 *   └ footer: keybindings ─────────────────────────────────────┘
 */

import { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
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
// Image preview dimensions (character cells). Height is specified in the
// iTerm2 protocol so the terminal allocates exactly this many rows.
const IMAGE_COLS = 32;
const IMAGE_ROWS = 10;
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

function buildItermSequence(b64: string, bytes: number, name: string): string {
  const nameB64 = Buffer.from(name).toString('base64');
  return (
    `\x1b]1337;File=name=${nameB64};size=${bytes};` +
    `inline=1;width=${IMAGE_COLS};height=${IMAGE_ROWS};preserveAspectRatio=1:${b64}\x07`
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

  // Per-item thumbnail state.
  const [imageB64, setImageB64] = useState<string | null>(null);
  const [imageBytes, setImageBytes] = useState(0);
  const [imageLoading, setImageLoading] = useState(false);

  const termWidth = process.stdout.columns ?? 100;
  const termHeight = process.stdout.rows ?? 24;
  const showSidebar = termWidth >= MIN_SIDEBAR_TERMINAL_WIDTH;
  const listWidth = showSidebar ? termWidth - SIDEBAR_WIDTH - 1 : termWidth;
  // 5 reserved rows: header + page bar + divider + divider + footer.
  const listHeight = Math.max(4, termHeight - 5);
  const canImages = showSidebar && supportsInlineImages();

  // Spinner animation while a page is loading.
  useEffect(() => {
    if (!loading) return;
    const id = setInterval(() => setSpinFrame((f) => (f + 1) % SPIN_FRAMES.length), 80);
    return () => clearInterval(id);
  }, [loading]);

  // Auto-load thumbnail when selection changes.
  useEffect(() => {
    if (!canImages || !items[cursor]?.mimeType.startsWith('image/')) {
      setImageB64(null);
      setImageLoading(false);
      return;
    }
    const item = items[cursor];
    const controller = new AbortController();
    setImageB64(null);
    setImageLoading(true);

    fetch(item.url, { signal: controller.signal })
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (!controller.signal.aborted) {
          setImageB64(Buffer.from(buf).toString('base64'));
          setImageBytes(buf.byteLength);
          setImageLoading(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setImageLoading(false);
      });

    return () => controller.abort();
  }, [items[cursor]?.id, canImages]);

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
      setImageB64(null);
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

  useInput((input, key) => {
    if (loading) return;
    if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow || input === 'j') setCursor((c) => Math.min(items.length - 1, c + 1));
    else if (input === 'n' || key.rightArrow) loadPage(page + 1);
    else if (input === 'b' || key.leftArrow) loadPage(page - 1);
    else if (input === 'q' || key.escape) doExit({ type: 'quit' });
    else if (key.return) { const item = items[cursor]; if (item) doExit({ type: 'show', id: item.id }); }
    else if (input === 'o') { const item = items[cursor]; if (item) doExit({ type: 'optimize', id: item.id }); }
    else if (input === 'e') { const item = items[cursor]; if (item) doExit({ type: 'edit', id: item.id }); }
  });

  const selectedItem = items[cursor];
  const scrollStart = Math.max(0, Math.min(cursor - Math.floor(listHeight / 2), items.length - listHeight));
  const visibleItems = items.slice(scrollStart, scrollStart + listHeight);
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  return (
    <Box flexDirection="column" width={termWidth}>

      {/* ── Header ── */}
      <Box paddingX={1} justifyContent="space-between">
        <Box gap={1}>
          <Text bold color="green">localPress</Text>
          <Text dimColor>— media library</Text>
          {sortBy && sortBy !== 'date' && (
            <Text dimColor>· {sortBy} {sortOrder ?? 'desc'}</Text>
          )}
        </Box>
        <Text dimColor>Page {page}/{totalPages} · {total} total</Text>
      </Box>

      {/* ── Page navigation bar ── */}
      <Box paddingX={1} justifyContent="space-between">
        <Text color={hasPrev ? 'green' : undefined} dimColor={!hasPrev}>
          {hasPrev ? '← [b] prev page' : '              '}
        </Text>
        {loading && (
          <Text color="green">{SPIN_FRAMES[spinFrame]} loading page {page}…</Text>
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
            // Full-panel spinner while page is in flight.
            <Box
              height={listHeight}
              alignItems="center"
              justifyContent="center"
            >
              <Text color="green">
                {SPIN_FRAMES[spinFrame]}{'  '}Loading page {page}…
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
                    </Text>
                    {' '}
                    {name}
                    {' '}
                    <Text dimColor={!isSelected}>{ext}</Text>
                    {' '}
                    <Text dimColor={!isSelected}>{size.padStart(8)}</Text>
                  </Text>
                </Box>
              );
            })
          )}
        </Box>

        {/* Sidebar */}
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
                {/* ── Thumbnail slot ── */}
                {canImages && selectedItem.mimeType.startsWith('image/') && (
                  <Box height={IMAGE_ROWS} flexDirection="column">
                    {imageB64 ? (
                      // Raw iTerm2 inline image — measured width is 0 by string-width,
                      // but the terminal renders it into the IMAGE_ROWS rows we allocated.
                      <Text>{buildItermSequence(imageB64, imageBytes, selectedItem.filename)}</Text>
                    ) : (
                      <Box height={IMAGE_ROWS} alignItems="center" justifyContent="center">
                        <Text dimColor>
                          {imageLoading
                            ? `${SPIN_FRAMES[spinFrame]} loading preview…`
                            : ''}
                        </Text>
                      </Box>
                    )}
                  </Box>
                )}

                {/* ── Metadata ── */}
                <Text bold color="green" wrap="truncate">{selectedItem.filename}</Text>
                <Text dimColor>#{selectedItem.id}</Text>
                <Text dimColor>{selectedItem.mimeType}</Text>
                {selectedItem.sizeBytes !== undefined && (
                  <Text dimColor>{formatBytes(selectedItem.sizeBytes)}</Text>
                )}
                {selectedItem.width !== undefined && (
                  <Text dimColor>{selectedItem.width}×{selectedItem.height}px</Text>
                )}
                {processedIds.has(selectedItem.id) && (
                  <Text color="green">✓ optimized</Text>
                )}
                <Text> </Text>
                <Text dimColor wrap="truncate">{selectedItem.url}</Text>
                <Text> </Text>
                <Text dimColor>──────────────────────</Text>
                <Text><Text color="green">[o]</Text><Text dimColor> optimize</Text></Text>
                <Text><Text color="green">[e]</Text><Text dimColor> edit (round-trip)</Text></Text>
                <Text><Text color="green">[↵]</Text><Text dimColor> show details</Text></Text>
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
          [↑↓/jk] navigate  [←→/n/b] page  [o] optimize  [e] edit  [↵] details  [q] quit
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
