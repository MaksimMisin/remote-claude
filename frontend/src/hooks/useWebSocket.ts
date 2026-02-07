import { useEffect, useRef, useCallback, useState } from 'react';
import type {
  ServerMessage,
  ManagedSession,
  ClaudeEvent,
  RcMarker,
} from '../types';

interface UseWebSocketCallbacks {
  onSessions: (sessions: ManagedSession[]) => void;
  onSessionUpdate: (session: ManagedSession) => void;
  onSessionRemoved: (sessionId: string) => void;
  onEvent: (event: ClaudeEvent) => void;
  onHistory: (events: ClaudeEvent[]) => void;
  onMarker: (sessionId: string, marker: RcMarker) => void;
  onVersion: (version: string) => void;
}

interface UseWebSocketReturn {
  connected: boolean;
  reconnecting: boolean;
  send: (data: unknown) => void;
}

export function useWebSocket(
  callbacks: UseWebSocketCallbacks,
): UseWebSocketReturn {
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelayRef = useRef(1000);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callbacksRef = useRef(callbacks);

  // Keep callbacks ref current without causing reconnects
  callbacksRef.current = callbacks;

  const send = useCallback((data: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }, []);

  useEffect(() => {
    function connect() {
      // Clean up previous ping timer
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = proto + '//' + location.host + '/ws';
      const ws = new WebSocket(url);
      wsRef.current = ws;
      setReconnecting(true);

      ws.onopen = () => {
        setConnected(true);
        setReconnecting(false);
        reconnectDelayRef.current = 1000;
        ws.send(JSON.stringify({ type: 'subscribe' }));

        // Start ping interval
        pingTimerRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 30000);
      };

      ws.onmessage = (e: MessageEvent) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        handleMessage(msg);
      };

      ws.onclose = () => {
        setConnected(false);
        setReconnecting(false);
        if (pingTimerRef.current) {
          clearInterval(pingTimerRef.current);
          pingTimerRef.current = null;
        }
        scheduleReconnect();
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    function scheduleReconnect() {
      if (reconnectTimerRef.current) return;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        reconnectDelayRef.current = Math.min(
          reconnectDelayRef.current * 2,
          30000,
        );
        connect();
      }, reconnectDelayRef.current);
    }

    function handleMessage(msg: ServerMessage) {
      const cb = callbacksRef.current;
      switch (msg.type) {
        case 'connected':
          if (msg.payload?.version) {
            cb.onVersion(msg.payload.version);
          }
          break;
        case 'sessions':
          cb.onSessions(msg.payload || []);
          break;
        case 'session_update':
          if (msg.payload) {
            cb.onSessionUpdate(msg.payload);
          }
          break;
        case 'event':
          if (msg.payload) {
            cb.onEvent(msg.payload);
          }
          break;
        case 'history':
          if (Array.isArray(msg.payload)) {
            cb.onHistory(msg.payload);
          }
          break;
        case 'marker':
          if (msg.payload) {
            cb.onMarker(msg.payload.sessionId, msg.payload.marker);
          }
          break;
        case 'session_removed':
          if (msg.payload) {
            cb.onSessionRemoved(msg.payload.sessionId);
          }
          break;
      }
    }

    connect();

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on cleanup
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  return { connected, reconnecting, send };
}
