import type React from 'react';

interface HeaderProps {
  connected: boolean;
  reconnecting: boolean;
  version: string;
  notificationsEnabled: boolean;
  onToggleNotifications: () => void;
  onNewSession: () => void;
}

export function Header({
  connected,
  reconnecting,
  version,
  notificationsEnabled,
  onToggleNotifications,
  onNewSession,
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

  return (
    <header>
      <h1>Remote Claude</h1>
      <div className="header-right">
        {version && <span className="version-text">v{version}</span>}
        <div className={connClass} title={connTitle} />
        <button
          className="btn-icon"
          title="Notifications"
          style={{ fontSize: 18, opacity: notificationsEnabled ? 1 : 0.4 }}
          onClick={onToggleNotifications}
        >
          {'\uD83D\uDD14'}
        </button>
        <button className="btn-icon" title="New Session" onClick={onNewSession}>
          +
        </button>
      </div>
    </header>
  );
}
