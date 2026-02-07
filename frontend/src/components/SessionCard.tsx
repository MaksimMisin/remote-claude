import { memo } from 'react';
import type { ManagedSession } from '../types';
import { relativeTime, formatTokens } from '../utils/time';
import { actionSummary, stripMarkers } from '../utils/events';

interface SessionCardProps {
  session: ManagedSession;
  selected: boolean;
  cancelling: boolean;
  onClick: () => void;
  onDismiss: () => void;
  onClose: () => void;
}

/** Strip leading emoji prefix (e.g. "fix auth" → "fix auth") set by tmux-title hook */
function stripEmojiPrefix(name: string): string {
  return name.replace(/^[\p{Emoji}\p{Emoji_Presentation}\uFE0F]+\s*/u, '');
}

/** Check if a session needs attention (waiting or idle with question/error marker). */
function needsContext(session: ManagedSession): boolean {
  if (session.status === 'waiting') return true;
  if (session.status === 'idle' && session.lastMarker) {
    return session.lastMarker.category === 'question' || session.lastMarker.category === 'error';
  }
  return false;
}

export const SessionCard = memo(function SessionCard({
  session,
  selected,
  cancelling,
  onClick,
  onDismiss,
  onClose,
}: SessionCardProps) {
  const isWaiting = session.status === 'waiting';
  const showContext = needsContext(session);
  let className = 'card';
  if (selected) className += ' selected';
  if (isWaiting && !selected) className += ' card-waiting';

  // Prefer tmux window name (LLM-generated or human-overridden) over auto-discovered name
  const displayName = session.windowName
    ? stripEmojiPrefix(session.windowName)
    : session.name || session.id;

  // Clean assistant text for display (strip rc markers)
  const contextText = showContext && session.lastAssistantText
    ? stripMarkers(session.lastAssistantText)
    : '';

  // Build git + token context pieces
  const gitInfo = session.gitBranch
    ? `${session.gitBranch}${session.gitDirty ? '*' : ''}`
    : '';
  const tokenInfo = session.totalTokens != null
    ? `${formatTokens(session.totalTokens)} tokens`
    : '';

  return (
    <div className={className} onClick={onClick}>
      <div className="card-header">
        <div className={`dot dot-${session.status}`} />
        <div className="card-name">{displayName}</div>
        {selected && (
          <div className="card-header-actions">
            <button
              className="card-header-btn card-btn-hide"
              onClick={(e) => { e.stopPropagation(); onDismiss(); }}
            >
              Hide
            </button>
            <button
              className="card-header-btn card-btn-close"
              onClick={(e) => { e.stopPropagation(); onClose(); }}
            >
              Close
            </button>
          </div>
        )}
        <div className="card-time">{relativeTime(session.lastActivity)}</div>
      </div>
      {(gitInfo || tokenInfo) && (
        <div className="card-meta">
          {gitInfo && <span className="card-git">{gitInfo}</span>}
          {tokenInfo && <span className="card-tokens">{tokenInfo}</span>}
        </div>
      )}
      <div className="card-summary">
        {actionSummary(session, cancelling)}
      </div>
      {showContext && contextText && (
        <div className="card-context">{contextText}</div>
      )}
      {isWaiting && session.lastMarker && !contextText && (
        <div className="card-marker">{session.lastMarker.message}</div>
      )}
    </div>
  );
});
