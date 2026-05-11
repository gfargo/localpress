/**
 * Interactive history browser TUI (`localpress history -i`).
 *
 * Two views:
 *   - Session list: top-level. Up/Down navigates, Enter drills into snapshots.
 *   - Snapshot list: snapshots within a selected session. Backspace returns.
 *
 * Keybindings (footer always shown):
 *   ↑ / ↓ / j / k     navigate
 *   Enter              drill into session (in session view)
 *   Esc / Backspace    back / quit
 *   q                  quit
 */

import { Box, Text, useApp, useInput } from 'ink';
import { useState } from 'react';
import type { SessionRecord, SnapshotRecord, SnapshotStore } from '../../engine/history/index.ts';

export interface HistoryBrowserProps {
  sessions: SessionRecord[];
  store: SnapshotStore;
  siteName: string;
  onExit: () => void;
}

export function HistoryBrowser({ sessions, store, siteName, onExit }: HistoryBrowserProps) {
  const { exit } = useApp();
  const [view, setView] = useState<'sessions' | 'snapshots'>('sessions');
  const [sessionCursor, setSessionCursor] = useState(0);
  const [snapshotCursor, setSnapshotCursor] = useState(0);
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>([]);

  useInput((input, key) => {
    if (input === 'q' || (key.escape && view === 'sessions')) {
      exit();
      onExit();
      return;
    }
    if (view === 'sessions') {
      if (key.upArrow || input === 'k') {
        setSessionCursor((c) => Math.max(0, c - 1));
      } else if (key.downArrow || input === 'j') {
        setSessionCursor((c) => Math.min(sessions.length - 1, c + 1));
      } else if (key.return) {
        const session = sessions[sessionCursor];
        const snaps = store.listSnapshots(siteName, { sessionId: session.id, limit: 500 });
        setSnapshots(snaps);
        setSnapshotCursor(0);
        setView('snapshots');
      }
    } else {
      if (key.escape || key.backspace || input === 'h') {
        setView('sessions');
      } else if (key.upArrow || input === 'k') {
        setSnapshotCursor((c) => Math.max(0, c - 1));
      } else if (key.downArrow || input === 'j') {
        setSnapshotCursor((c) => Math.min(snapshots.length - 1, c + 1));
      }
    }
  });

  if (view === 'sessions') {
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>History — {siteName}</Text>
          <Text dimColor>
            {' '}
            ({sessions.length} session{sessions.length === 1 ? '' : 's'})
          </Text>
        </Box>
        {sessions.map((s, idx) => (
          <Box key={s.id} flexDirection="row">
            <Text color={idx === sessionCursor ? 'cyan' : undefined}>
              {idx === sessionCursor ? '▶ ' : '  '}
              {s.id.slice(0, 8)} {s.command.padEnd(12)} {String(s.itemCount).padStart(4)} items{' '}
              {new Date(s.startedAt).toLocaleString()}
            </Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text dimColor>↑/↓ navigate · Enter drill in · q quit</Text>
        </Box>
      </Box>
    );
  }

  const session = sessions[sessionCursor];
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Session {session.id.slice(0, 8)} </Text>
        <Text dimColor>
          · {session.command} · {snapshots.length} snapshot{snapshots.length === 1 ? '' : 's'}
        </Text>
      </Box>
      {snapshots.length === 0 ? (
        <Text dimColor>(no snapshots in this session)</Text>
      ) : (
        snapshots.map((s, idx) => (
          <Box key={s.id} flexDirection="row">
            <Text color={idx === snapshotCursor ? 'cyan' : undefined}>
              {idx === snapshotCursor ? '▶ ' : '  '}#{String(s.id).padStart(5)} attachment #
              {String(s.wpId).padStart(5)} {s.operation.padEnd(10)} {s.beforeMeta.filename}
              {s.restoredAt ? ' [restored]' : ''}
            </Text>
          </Box>
        ))
      )}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ navigate · Esc/Backspace back · q quit</Text>
      </Box>
    </Box>
  );
}
