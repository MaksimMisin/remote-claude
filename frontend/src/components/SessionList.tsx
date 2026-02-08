import type React from 'react';
import type { ManagedSession } from '../types';
import type { PermissionAction } from './PermissionPrompt';
import { SessionCard } from './SessionCard';

const STATUS_ORDER: Record<string, number> = {
  waiting: 0,
  working: 1,
  idle: 2,
  offline: 3,
};

interface SessionListProps {
  sessions: Record<string, ManagedSession>;
  selectedId: string | null;
  cancellingIds: Set<string>;
  queuedSessionIds?: Set<string>;
  queuedSessionCounts?: Record<string, number>;
  onSelect: (id: string | null) => void;
  onDismiss: (id: string) => void;
  onClose: (id: string) => void;
  onPermissionAction?: (sessionId: string, action: PermissionAction) => void;
  onRename?: (id: string, name: string) => void;
}

export function SessionList({
  sessions,
  selectedId,
  cancellingIds,
  queuedSessionIds,
  queuedSessionCounts,
  onSelect,
  onDismiss,
  onClose,
  onPermissionAction,
  onRename,
}: SessionListProps): React.ReactElement {
  const sorted = Object.values(sessions).sort((a, b) => {
    const oa = STATUS_ORDER[a.status] ?? 9;
    const ob = STATUS_ORDER[b.status] ?? 9;
    if (oa !== ob) return oa - ob;
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });

  if (sorted.length === 0) {
    return (
      <div id="no-sessions">
        No sessions yet.
        <br />
        Tap + to create one.
      </div>
    );
  }

  // When a session is selected, only show that card (compact)
  if (selectedId) {
    const selected = sessions[selectedId];
    if (selected) {
      return (
        <div id="sessions">
          <SessionCard
            session={selected}
            selected
            cancelling={cancellingIds.has(selected.id)}
            hasQueuedPrompt={queuedSessionIds?.has(selected.id)}
            queuedCount={queuedSessionCounts?.[selected.id] || 0}
            onClick={() => onSelect(null)}
            onDismiss={() => onDismiss(selected.id)}
            onClose={() => onClose(selected.id)}
            onPermissionAction={onPermissionAction ? (action) => onPermissionAction(selected.id, action) : undefined}
            onRename={onRename}
          />
        </div>
      );
    }
  }

  return (
    <div id="sessions">
      {sorted.map((s) => (
        <SessionCard
          key={s.id}
          session={s}
          selected={false}
          cancelling={cancellingIds.has(s.id)}
          hasQueuedPrompt={queuedSessionIds?.has(s.id)}
          queuedCount={queuedSessionCounts?.[s.id] || 0}
          onClick={() => onSelect(s.id)}
          onDismiss={() => onDismiss(s.id)}
          onClose={() => onClose(s.id)}
          onRename={onRename}
        />
      ))}
    </div>
  );
}
