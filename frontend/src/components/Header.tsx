import type React from 'react';
import { useRef, useCallback } from 'react';
import type { NotificationMode } from '../hooks/useNotifications';

const MODE_ICONS: Record<NotificationMode, string> = {
  off: '\uD83D\uDD15',     // 🔕
  silent: '\uD83D\uDD14',  // 🔔
  vibrate: '\uD83D\uDCF3', // 📳
  full: '\uD83D\uDD0A',    // 🔊
};

const MODE_LABELS: Record<NotificationMode, string> = {
  off: 'Off',
  silent: 'Silent',
  vibrate: 'Vibrate',
  full: 'Sound',
};

interface HeaderProps {
  connected: boolean;
  reconnecting: boolean;
  version: string;
  notificationMode: NotificationMode;
  onToggleNotifications: () => void;
  onTestNotification: () => void;
  onNewSession: () => void;
  onGoHome: () => void;
}

export function Header({
  connected,
  reconnecting,
  version,
  notificationMode,
  onToggleNotifications,
  onTestNotification,
  onNewSession,
  onGoHome,
}: HeaderProps): React.ReactElement {
  const connClass = connected
    ? 'conn-dot connected'
    : reconnecting
      ? 'conn-dot reconnecting'
      : 'conn-dot';
  const connTitle = connected
    ? 'Connected'
    : reconnecting
      ? 'Reconnecting'
      : 'Disconnected';

  // Long-press bell to fire test notification
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);
  const onPointerDown = useCallback(() => {
    didLongPress.current = false;
    longPressTimer.current = setTimeout(() => {
      didLongPress.current = true;
      onTestNotification();
    }, 600);
  }, [onTestNotification]);
  const onPointerUp = useCallback(() => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  }, []);
  const onBellClick = useCallback(() => {
    if (didLongPress.current) return;
    onToggleNotifications();
  }, [onToggleNotifications]);

  return (
    <header>
      <h1 className="header-logo" onClick={onGoHome}>Remote Claude</h1>
      <div className="header-right">
        {version && <span className="version-text">v{version}</span>}
        <div className={connClass} title={connTitle} />
        <button
          className="btn-icon notification-mode-btn"
          title={`Notifications: ${MODE_LABELS[notificationMode]} (long-press to test)`}
          style={{ fontSize: 18, opacity: notificationMode === 'off' ? 0.4 : 1 }}
          onClick={onBellClick}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {MODE_ICONS[notificationMode]}
        </button>
        <button className="btn-icon" title="New Session" onClick={onNewSession}>
          +
        </button>
      </div>
    </header>
  );
}
