/**
 * Interactive media browser TUI (`localpress list --interactive`).
 *
 * Layout (wide terminal ≥ 110 cols):
 *   ┌ header: title + page/total ──────────────────────────────┐
 *   │ list (scrollable)             │ sidebar: selected item    │
 *   └ footer: keybindings ─────────────────────────────────────┘
 *
 * Narrow terminals show the list without the sidebar.
 */

import { useState, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import type { MediaItem, PagedResult } from '../../adapters/types.ts';

export type MediaBrowserAction =
  | { type: 'quit' }
  | { type: 'optimize'; id: number }
  | { type: 'edit'; id: number }
  | { type: 'show'; id: number }
  | { type: 'preview'; item: MediaItem };

interface Props {
  initialItems: MediaItem[];
  total: number;
  totalPages: number;
  currentPage: number;
  processedIds: Set<number>;
  onAction: (action: MediaBrowserAction) => void;
  onPageChange: (page: number) => Promise<PagedResult<MediaItem>>;
}

const SIDEBAR_WIDTH = 36;
const MIN_SIDEBAR_TERMINAL_WIDTH = 110;

export function MediaBrowser({
  initialItems,
  total,
  totalPages: initialTotalPages,
  currentPage: initialPage,
  processedIds,
  onAction,
  onPageChange,
}: Props) {
  const { exit } = useApp();
  const [items, setItems] = useState(initialItems);
  const [page, setPage] = useState(initialPage);
  const [totalPages, setTotalPages] = useState(initialTotalPages);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const termWidth = process.stdout.columns ?? 100;
  const termHeight = process.stdout.rows ?? 24;
  const showSidebar = termWidth >= MIN_SIDEBAR_TERMINAL_WIDTH;
  const listWidth = showSidebar ? termWidth - SIDEBAR_WIDTH - 1 : termWidth;
  // Reserve 3 rows for header + 1 for footer.
  const listHeight = Math.max(4, termHeight - 4);

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
      setStatusMsg(`Loading page ${p}…`);
      try {
        const result = await onPageChange(p);
        setItems(result.items);
        setPage(p);
        setTotalPages(result.totalPages);
        setCursor(0);
        setStatusMsg('');
      } catch (err) {
        setStatusMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setLoading(false);
      }
    },
    [totalPages, loading, onPageChange],
  );

  useInput((input, key) => {
    if (loading) return;

    if (key.upArrow || input === 'k') {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.downArrow || input === 'j') {
      setCursor((c) => Math.min(items.length - 1, c + 1));
    } else if (input === 'n' || key.rightArrow) {
      loadPage(page + 1);
    } else if (input === 'b' || key.leftArrow) {
      loadPage(page - 1);
    } else if (input === 'q' || key.escape) {
      doExit({ type: 'quit' });
    } else if (key.return) {
      const item = items[cursor];
      if (item) doExit({ type: 'show', id: item.id });
    } else if (input === 'o') {
      const item = items[cursor];
      if (item) doExit({ type: 'optimize', id: item.id });
    } else if (input === 'e') {
      const item = items[cursor];
      if (item) doExit({ type: 'edit', id: item.id });
    } else if (input === 'v') {
      const item = items[cursor];
      if (item) doExit({ type: 'preview', item });
    }
  });

  const selectedItem = items[cursor];

  // Compute scroll window centered around cursor.
  const scrollStart = Math.max(0, Math.min(cursor - Math.floor(listHeight / 2), items.length - listHeight));
  const visibleItems = items.slice(scrollStart, scrollStart + listHeight);

  const pageInfo = `Page ${page}/${totalPages} · ${total} total`;

  return (
    <Box flexDirection="column" width={termWidth}>
      {/* ── Header ── */}
      <Box paddingX={1} justifyContent="space-between">
        <Box gap={1}>
          <Text bold color="green">localPress</Text>
          <Text dimColor>— media library</Text>
        </Box>
        <Text dimColor>{pageInfo}</Text>
      </Box>

      <Box>
        <Text dimColor>{'─'.repeat(termWidth)}</Text>
      </Box>

      {/* ── Main ── */}
      <Box flexDirection="row" flexGrow={1}>
        {/* List panel */}
        <Box flexDirection="column" width={listWidth}>
          {visibleItems.length === 0 ? (
            <Box paddingX={2} paddingY={1}>
              <Text dimColor>No items.</Text>
            </Box>
          ) : (
            visibleItems.map((item, i) => {
              const isSelected = scrollStart + i === cursor;
              const isProcessed = processedIds.has(item.id);
              const size = item.sizeBytes ? formatBytes(item.sizeBytes) : '     ';
              const ext = item.mimeType.split('/')[1]?.slice(0, 4).padEnd(4) ?? '    ';
              const maxName = listWidth - 26;
              const name = item.filename.length > maxName
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
                    <Text color={isSelected ? undefined : 'cyan'}>#{String(item.id).padEnd(5)}</Text>
                    {' '}
                    {name}
                    {' '}
                    <Text dimColor={isSelected ? false : true}>{ext}</Text>
                    {' '}
                    <Text dimColor={isSelected ? false : true}>{size.padStart(8)}</Text>
                  </Text>
                </Box>
              );
            })
          )}
        </Box>

        {/* Sidebar */}
        {showSidebar && (
          <Box flexDirection="column" width={SIDEBAR_WIDTH} borderStyle="single"
            borderTop={false} borderBottom={false} borderRight={false} paddingX={1}>
            {selectedItem ? (
              <>
                <Text bold color="green" wrap="truncate">{selectedItem.filename}</Text>
                <Text dimColor>#{selectedItem.id}</Text>
                <Text> </Text>
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
                <Text dimColor>─────────────────────</Text>
                <Text dimColor>Actions:</Text>
                <Text><Text color="green">[o]</Text><Text dimColor> optimize</Text></Text>
                <Text><Text color="green">[e]</Text><Text dimColor> edit (round-trip)</Text></Text>
                <Text><Text color="green">[v]</Text><Text dimColor> preview image</Text></Text>
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
          {statusMsg
            ? statusMsg
            : loading
              ? 'Loading…'
              : `[↑↓/jk] navigate  [n/b] page  [o] optimize  [e] edit  [v] preview  [↵] details  [q] quit`}
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
