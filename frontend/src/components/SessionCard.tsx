import { memo } from 'react';
import type { ManagedSession } from '../types';
import { relativeTime, formatTokens } from '../utils/time';
import { actionSummary, stripMarkers } from '../utils/events';
import { PermissionPrompt, permissionSummary, type PermissionAction } from './PermissionPrompt';

interface SessionCardProps {
  session: ManagedSession;
  selected: boolean;
  cancelling: boolean;
  hasQueuedPrompt?: boolean;
  onClick: () => void;
  onDismiss: () => void;
  onClose: () => void;
  onPermissionAction?: (action: PermissionAction) => void;
}

/** Strip leading emoji prefix (e.g. "fix auth" -> "fix auth") set by tmux-title hook */
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

/** Shorten a path like /Users/user/code/remote-claude -> ~/code/remote-claude */
function shortenPath(cwd: string): string {
  const home = '/Users/';
  if (cwd.startsWith(home)) {
    const afterHome = cwd.slice(home.length);
    const slashIdx = afterHome.indexOf('/');
    if (slashIdx !== -1) return '~' + afterHome.slice(slashIdx);
    return '~';
  }
  return cwd;
}

export const SessionCard = memo(function SessionCard({
  session,
  selected,
  cancelling,
  hasQueuedPrompt,
  onClick,
  onDismiss,
  onClose,
  onPermissionAction,
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

  const hasPerm = isWaiting && !!session.permissionRequest;

  // Clean assistant text for display (strip rc markers)
  const contextText = showContext && !hasPerm && session.lastAssistantText
    ? stripMarkers(session.lastAssistantText)
    : '';

  // Context info
  const folder = session.cwd ? shortenPath(session.cwd) : '';
  const gitBranch = session.gitBranch || '';
  const gitDirty = session.gitDirty || false;
  const tokens = session.totalTokens;

  return (
    <div className={className} onClick={onClick}>
      <div className="card-header">
        <div className={`dot dot-${session.status}`} />
        <div className="card-name">{displayName}</div>
        <div className={`card-header-actions${selected ? ' always-visible' : ''}`}>
          <button
            className="card-header-btn card-btn-hide"
            onClick={(e) => { e.stopPropagation(); if (confirm('Hide this session?')) onDismiss(); }}
          >
            Hide
          </button>
          <button
            className="card-header-btn card-btn-close"
            onClick={(e) => { e.stopPropagation(); if (confirm('Close and kill this session?')) onClose(); }}
          >
            Close
          </button>
        </div>
        <div className="card-time">{relativeTime(session.lastActivity)}</div>
      </div>

      {/* Context bar: folder, git branch, tokens */}
      <div className="card-ctx">
        {folder && (
          <span className="ctx-item ctx-folder" title={session.cwd}>{folder}</span>
        )}
        {gitBranch && (
          <span className="ctx-item ctx-git">
            {gitBranch}{gitDirty && <span className="ctx-dirty">*</span>}
          </span>
        )}
        {tokens != null && tokens > 0 && (
          <span className="ctx-item ctx-tokens">{formatTokens(tokens)} tok</span>
        )}
        {hasQueuedPrompt && session.status === 'working' && (
          <span className="card-queued-badge">Queued</span>
        )}
      </div>

      <div className="card-summary">
        {hasPerm && !selected
          ? permissionSummary(session.permissionRequest!.tool, session.permissionRequest!.toolInput)
          : actionSummary(session, cancelling)}
      </div>
      {selected && hasPerm && onPermissionAction && (
        <PermissionPrompt
          tool={session.permissionRequest!.tool}
          toolInput={session.permissionRequest!.toolInput}
          onAction={onPermissionAction}
        />
      )}
      {showContext && contextText && (
        <div className="card-context">{contextText}</div>
      )}
      {isWaiting && !hasPerm && session.lastMarker && !contextText && (
        <div className="card-marker">{session.lastMarker.message}</div>
      )}
    </div>
  );
});
