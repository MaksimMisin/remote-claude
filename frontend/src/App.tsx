import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { ManagedSession, ClaudeEvent, RcMarker, QueuedPrompt } from './types';
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
  const [queuedPrompts, setQueuedPrompts] = useState<Record<string, QueuedPrompt>>({});
  const queuedPromptsRef = useRef(queuedPrompts);
  queuedPromptsRef.current = queuedPrompts;

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Track recently closed/dismissed session IDs to ignore late-arriving updates
  const recentlyClosedRef = useRef(new Set<string>());

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const notifications = useNotifications();
  const notificationsRef = useRef(notifications);
  notificationsRef.current = notifications;

  // Key events by shortId of Claude UUID (first 8 chars).
  // This matches EventProcessor's keying and avoids timing issues where
  // sessionsRef isn't populated yet when bulk history arrives.
  const eventKey = useCallback(
    (claudeSessionId: string): string => claudeSessionId.slice(0, 8),
    [],
  );

  const addEvent = useCallback(
    (ev: ClaudeEvent, bulk = false) => {
      const key = eventKey(ev.sessionId);
      setEvents((prev) => {
        const list = prev[key] || [];
        // Avoid duplicates
        if (list.some((e) => e.id === ev.id)) return prev;
        let updated = [...list, ev];
        // Keep last 1000 events per session
        if (updated.length > 1000) updated = updated.slice(-1000);
        return { ...prev, [key]: updated };
      });
      // Bulk events don't need immediate re-render triggers
      void bulk;
    },
    [eventKey],
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

  // Ref for doSend — declared early so onSessionUpdate can reference it
  const doSendRef = useRef((_sid: string, _text: string, _images: { name: string; base64: string; mimeType: string }[]) => {});

  const wsCallbacks = useRef({
    onSessions: (list: ManagedSession[]) => {
      const map: Record<string, ManagedSession> = {};
      list.forEach((s) => (map[s.id] = s));
      setSessions(map);
    },
    onSessionUpdate: (session: ManagedSession) => {
      // Ignore updates for sessions we recently closed/dismissed locally
      if (recentlyClosedRef.current.has(session.id)) return;
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
          // Auto-send queued prompt after a short delay
          const queued = queuedPromptsRef.current[session.id];
          if (queued) {
            setQueuedPrompts((prev) => {
              const next = { ...prev };
              delete next[session.id];
              return next;
            });
            setTimeout(() => {
              doSendRef.current(session.id, queued.text, queued.images);
            }, 300);
          } else {
            notificationsRef.current.notify(
              session.name + ' finished',
              contextSnippet || session.lastMarker?.message || 'Task complete',
              false,
            );
          }
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

        // Clear queue when session goes offline
        if (session.status === 'offline') {
          setQueuedPrompts((prev) => {
            if (!prev[session.id]) return prev;
            const next = { ...prev };
            delete next[session.id];
            return next;
          });
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
      setQueuedPrompts((prev) => {
        if (!prev[sessionId]) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
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

  // Send prompt helper — also stored in a ref for use in callbacks
  const doSend = useCallback(
    (
      sid: string,
      text: string,
      images: { name: string; base64: string; mimeType: string }[],
    ) => {
      const body: Record<string, unknown> = { text: text || '' };
      if (images.length === 1) {
        body.image = images[0];
      } else if (images.length > 1) {
        body.images = images;
      }
      apiPost('/api/sessions/' + sid + '/prompt', body);
    },
    [],
  );
  doSendRef.current = doSend;

  const handleSend = useCallback(
    (
      text: string,
      images: { name: string; base64: string; mimeType: string }[],
    ) => {
      const sid = selectedIdRef.current;
      if (!sid) return;
      const session = sessionsRef.current[sid];
      if (session && session.status === 'working') {
        // Queue instead of sending immediately
        setQueuedPrompts((prev) => ({ ...prev, [sid]: { text, images } }));
      } else {
        doSend(sid, text, images);
      }
    },
    [doSend],
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

  // Cancel queued prompt
  const handleCancelQueue = useCallback((sid: string) => {
    setQueuedPrompts((prev) => {
      if (!prev[sid]) return prev;
      const next = { ...prev };
      delete next[sid];
      return next;
    });
  }, []);

  // Edit queued prompt — returns the queued prompt so InputArea can restore it
  const handleEditQueue = useCallback((sid: string): QueuedPrompt | undefined => {
    const queued = queuedPromptsRef.current[sid];
    if (queued) {
      setQueuedPrompts((prev) => {
        const next = { ...prev };
        delete next[sid];
        return next;
      });
    }
    return queued;
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
    // Suppress late-arriving session_update for this session and any
    // auto-discovered ghost (keyed by claudeSessionId prefix)
    const session = sessionsRef.current[id];
    recentlyClosedRef.current.add(id);
    if (session?.claudeSessionId) {
      recentlyClosedRef.current.add(session.claudeSessionId.slice(0, 8));
    }
    setTimeout(() => {
      recentlyClosedRef.current.delete(id);
      if (session?.claudeSessionId) {
        recentlyClosedRef.current.delete(session.claudeSessionId.slice(0, 8));
      }
    }, 30_000);
    setSessions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSelectedId((prev) => (prev === id ? null : prev));
    setQueuedPrompts((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    apiPost('/api/sessions/' + id + '/dismiss', {});
  }, []);

  // Rename session
  const handleRename = useCallback((id: string, name: string) => {
    apiPost('/api/sessions/' + id + '/rename', { name });
    // Optimistic update
    setSessions((prev) => {
      const session = prev[id];
      if (!session) return prev;
      return { ...prev, [id]: { ...session, customName: name || undefined } };
    });
  }, []);

  // Close (kill tmux window + remove)
  const handleClose = useCallback((id: string) => {
    const session = sessionsRef.current[id];
    recentlyClosedRef.current.add(id);
    if (session?.claudeSessionId) {
      recentlyClosedRef.current.add(session.claudeSessionId.slice(0, 8));
    }
    setTimeout(() => {
      recentlyClosedRef.current.delete(id);
      if (session?.claudeSessionId) {
        recentlyClosedRef.current.delete(session.claudeSessionId.slice(0, 8));
      }
    }, 30_000);
    setSessions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSelectedId((prev) => (prev === id ? null : prev));
    setQueuedPrompts((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
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

  const selectedSession = selectedId ? sessions[selectedId] : undefined;
  // Events are keyed by claudeSessionId prefix (matches EventProcessor)
  const selectedEventsKey = selectedSession?.claudeSessionId
    ? selectedSession.claudeSessionId.slice(0, 8)
    : selectedId;
  const selectedEvents = selectedEventsKey ? events[selectedEventsKey] || [] : [];
  const queuedSessionIds = useMemo(() => new Set(Object.keys(queuedPrompts)), [queuedPrompts]);

  return (
    <div id="app">
      <Header
        connected={connected}
        reconnecting={reconnecting}
        version={version}
        notificationMode={notifications.mode}
        onToggleNotifications={notifications.toggle}
        onTestNotification={() => notifications.notify('Test Notification', 'If you see this, notifications work!', true)}
        onNewSession={() => setModalOpen(true)}
        onGoHome={() => handleSelect(null)}
      />

      {banner.visible && <div id="banner" className="visible">{banner.text}</div>}

      <div id="main" style={selectedId ? { paddingBottom: 72 } : undefined}>
        <SessionList
          sessions={sessions}
          selectedId={selectedId}
          cancellingIds={cancellingIds}
          queuedSessionIds={queuedSessionIds}
          onSelect={handleSelect}
          onDismiss={handleDismiss}
          onClose={handleClose}
          onPermissionAction={handlePermissionAction}
          onRename={handleRename}
        />
        {selectedId && <EventFeed events={selectedEvents} />}
      </div>

      {selectedId && (
        <InputArea
          selectedId={selectedId}
          sessionStatus={selectedSession?.status}
          queuedPrompt={queuedPrompts[selectedId] || null}
          onSend={handleSend}
          onCancel={handleCancel}
          onCancelQueue={() => handleCancelQueue(selectedId)}
          onEditQueue={() => handleEditQueue(selectedId)}
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
