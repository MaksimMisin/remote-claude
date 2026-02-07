import type React from 'react';
import type { ManagedSession } from '../types';
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
  onSelect: (id: string | null) => void;
  onDismiss: (id: string) => void;
  onClose: (id: string) => void;
}

export function SessionList({
  sessions,
  selectedId,
  cancellingIds,
  onSelect,
  onDismiss,
  onClose,
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
            onClick={() => onSelect(null)}
            onDismiss={() => onDismiss(selected.id)}
            onClose={() => onClose(selected.id)}
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
          onClick={() => onSelect(s.id)}
          onDismiss={() => onDismiss(s.id)}
          onClose={() => onClose(s.id)}
        />
      ))}
    </div>
  );
}
