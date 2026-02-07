import { useState, useCallback, useRef, useEffect } from 'react';
import type { ManagedSession, ClaudeEvent, RcMarker } from './types';
import type { PermissionAction } from './components/PermissionPrompt';
import { useWebSocket } from './hooks/useWebSocket';
import { useNotifications } from './hooks/useNotifications';
import { Header } from './components/Header';
import { SessionList } from './components/SessionList';
import { EventFeed } from './components/EventFeed';
import { InputArea } from './components/InputArea';
import { CreateSessionModal } from './components/CreateSessionModal';
import './App.css';

function apiPost(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export default function App() {
  const [sessions, setSessions] = useState<Record<string, ManagedSession>>({});
  const [events, setEvents] = useState<Record<string, ClaudeEvent[]>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [version, setVersion] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [banner, setBanner] = useState<{ text: string; visible: boolean }>({
    text: '',
    visible: false,
  });
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const notifications = useNotifications();
  const notificationsRef = useRef(notifications);
  notificationsRef.current = notifications;

  // Resolve Claude's full UUID sessionId to our short session id
  const resolveSessionId = useCallback(
    (claudeSessionId: string): string => {
      for (const s of Object.values(sessionsRef.current)) {
        if (s.claudeSessionId === claudeSessionId) return s.id;
      }
      // Fallback: short ID is first 8 chars of the Claude session UUID
      return claudeSessionId.slice(0, 8);
    },
    [],
  );

  const addEvent = useCallback(
    (ev: ClaudeEvent, bulk = false) => {
      const sid = resolveSessionId(ev.sessionId);
      setEvents((prev) => {
        const list = prev[sid] || [];
        // Avoid duplicates
        if (list.some((e) => e.id === ev.id)) return prev;
        let updated = [...list, ev];
        // Keep last 200 events per session
        if (updated.length > 200) updated = updated.slice(-200);
        return { ...prev, [sid]: updated };
      });
      // Bulk events don't need immediate re-render triggers
      void bulk;
    },
    [resolveSessionId],
  );

  const showBanner = useCallback(
    (marker: RcMarker, sessionId: string) => {
      let sName = '';
      for (const s of Object.values(sessionsRef.current)) {
        if (s.id === sessionId || s.claudeSessionId === sessionId) {
          sName = s.name;
          break;
        }
      }
      const text = (sName ? sName + ': ' : '') + marker.message;
      setBanner({ text, visible: true });

      if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = setTimeout(() => {
        setBanner((prev) => ({ ...prev, visible: false }));
      }, 8000);

      // Notify for important marker categories
      const urgent =
        marker.category === 'question' || marker.category === 'error';
      if (marker.category !== 'silent' && marker.category !== 'progress') {
        notificationsRef.current.notify(sName || 'Claude', marker.message, urgent);
      }
    },
    [],
  );

  const wsCallbacks = useRef({
    onSessions: (list: ManagedSession[]) => {
      const map: Record<string, ManagedSession> = {};
      list.forEach((s) => (map[s.id] = s));
      setSessions(map);
    },
    onSessionUpdate: (session: ManagedSession) => {
      setSessions((prev) => {
        const prevSession = prev[session.id];
        const prevStatus = prevSession?.status;

        // Clear cancelling state on any session_update
        setCancellingIds((ids) => {
          if (!ids.has(session.id)) return ids;
          const next = new Set(ids);
          next.delete(session.id);
          return next;
        });

        // Notify on important status transitions, include assistant text for context
        const contextSnippet = session.lastAssistantText
          ? session.lastAssistantText.replace(/<!--rc:\w+:?[^>]*-->/g, '').trim().slice(0, 200)
          : '';
        if (prevStatus === 'working' && session.status === 'waiting') {
          notificationsRef.current.notify(
            session.name + ' needs input',
            contextSnippet || session.lastMarker?.message || 'Waiting for your response',
            true,
          );
        } else if (prevStatus === 'working' && session.status === 'idle') {
          notificationsRef.current.notify(
            session.name + ' finished',
            contextSnippet || session.lastMarker?.message || 'Task complete',
            false,
          );
        } else if (
          session.status === 'waiting' &&
          prevStatus !== 'waiting'
        ) {
          notificationsRef.current.notify(
            session.name + ' needs input',
            contextSnippet || session.lastMarker?.message || 'Waiting for your response',
            true,
          );
        }

        return { ...prev, [session.id]: session };
      });
    },
    onEvent: (ev: ClaudeEvent) => {
      addEvent(ev);
    },
    onHistory: (evts: ClaudeEvent[]) => {
      evts.forEach((ev) => addEvent(ev, true));
    },
    onMarker: (sessionId: string, marker: RcMarker) => {
      showBanner(marker, sessionId);
    },
    onSessionRemoved: (sessionId: string) => {
      setSessions((prev) => {
        if (!prev[sessionId]) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setSelectedId((prev) => (prev === sessionId ? null : prev));
    },
    onVersion: (v: string) => {
      setVersion(v);
    },
  });

  // Keep callbacks in sync
  wsCallbacks.current.onEvent = (ev: ClaudeEvent) => addEvent(ev);
  wsCallbacks.current.onHistory = (evts: ClaudeEvent[]) =>
    evts.forEach((ev) => addEvent(ev, true));
  wsCallbacks.current.onMarker = (sessionId: string, marker: RcMarker) =>
    showBanner(marker, sessionId);

  const { connected, reconnecting, send } = useWebSocket(wsCallbacks.current);

  // Handle session selection
  const handleSelect = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      if (id) {
        send({ type: 'select_session', payload: { sessionId: id } });
      }
    },
    [send],
  );

  // Send prompt
  const handleSend = useCallback(
    (
      text: string,
      images: { name: string; base64: string; mimeType: string }[],
    ) => {
      if (!selectedIdRef.current) return;
      const body: Record<string, unknown> = { text: text || '' };
      if (images.length === 1) {
        body.image = images[0];
      } else if (images.length > 1) {
        body.images = images;
      }
      apiPost('/api/sessions/' + selectedIdRef.current + '/prompt', body);
    },
    [],
  );

  // Cancel
  const handleCancel = useCallback(() => {
    const sid = selectedIdRef.current;
    if (!sid) return;
    setCancellingIds((prev) => {
      const next = new Set(prev);
      next.add(sid);
      return next;
    });
    apiPost('/api/sessions/' + sid + '/cancel', {});
  }, []);

  // Permission action (Yes/Allow All/No)
  const handlePermissionAction = useCallback(
    (sessionId: string, action: PermissionAction) => {
      const keyMap: Record<PermissionAction, string[]> = {
        yes: ['Enter'],
        allow_all: ['BTab'],
        no: ['Escape'],
      };
      apiPost('/api/sessions/' + sessionId + '/keys', { keys: keyMap[action] });
    },
    [],
  );

  // Dismiss (hide from UI, keep tmux)
  const handleDismiss = useCallback((id: string) => {
    setSessions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSelectedId((prev) => (prev === id ? null : prev));
    apiPost('/api/sessions/' + id + '/dismiss', {});
  }, []);

  // Close (kill tmux window + remove)
  const handleClose = useCallback((id: string) => {
    setSessions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSelectedId((prev) => (prev === id ? null : prev));
    apiPost('/api/sessions/' + id + '/close', {});
  }, []);

  // Create session and navigate to it
  const handleCreate = useCallback(
    async (name: string, cwd: string, flags?: string) => {
      const body: Record<string, unknown> = { name, cwd: cwd || undefined };
      if (flags) body.flags = flags;
      try {
        const res = await apiPost('/api/sessions', body);
        if (res.ok) {
          const session: ManagedSession = await res.json();
          setSessions((prev) => ({ ...prev, [session.id]: session }));
          handleSelect(session.id);
        }
      } catch {
        // Will appear via WebSocket update anyway
      }
    },
    [handleSelect],
  );

  // Live relative time updates
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(timer);
  }, []);

  const selectedEvents = selectedId ? events[selectedId] || [] : [];

  return (
    <div id="app">
      <Header
        connected={connected}
        reconnecting={reconnecting}
        version={version}
        notificationsEnabled={notifications.enabled}
        onToggleNotifications={notifications.toggle}
        onNewSession={() => setModalOpen(true)}
      />

      {banner.visible && <div id="banner" className="visible">{banner.text}</div>}

      <div id="main" style={selectedId ? { paddingBottom: 72 } : undefined}>
        <SessionList
          sessions={sessions}
          selectedId={selectedId}
          cancellingIds={cancellingIds}
          onSelect={handleSelect}
          onDismiss={handleDismiss}
          onClose={handleClose}
          onPermissionAction={handlePermissionAction}
        />
        {selectedId && <EventFeed events={selectedEvents} />}
      </div>

      {selectedId && (
        <InputArea
          selectedId={selectedId}
          onSend={handleSend}
          onCancel={handleCancel}
        />
      )}

      <CreateSessionModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreate={handleCreate}
        sessions={sessions}
      />
    </div>
  );
}
