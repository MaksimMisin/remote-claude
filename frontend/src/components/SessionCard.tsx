import { memo, useCallback, useRef, useState } from 'react';
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
  onRename?: (id: string, name: string) => void;
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

/** Shorten a path like /Users/maksim/code/remote-claude -> ~/code/remote-claude */
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

const SWIPE_THRESHOLD = 80;

export const SessionCard = memo(function SessionCard({
  session,
  selected,
  cancelling,
  hasQueuedPrompt,
  onClick,
  onDismiss,
  onClose,
  onPermissionAction,
  onRename,
}: SessionCardProps) {
  const isWaiting = session.status === 'waiting';
  const showContext = needsContext(session);
  let className = 'card';
  if (selected) className += ' selected';
  if (isWaiting && !selected) className += ' card-waiting';
  if (session.status === 'offline') className += ' card-offline';

  // Priority: manual override > tmux window name > auto-discovered name > id
  const displayName = session.customName
    ? session.customName
    : session.windowName
      ? stripEmojiPrefix(session.windowName)
      : session.name || session.id;

  const handleRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onRename) return;
    const newName = prompt('Rename session:', displayName);
    if (newName === null) return; // cancelled
    onRename(session.id, newName.trim());
  }, [onRename, session.id, displayName]);

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

  // --- Swipe handling (mobile) ---
  const cardRef = useRef<HTMLDivElement>(null);
  const touchRef = useRef({ startX: 0, startY: 0, locked: null as 'h' | 'v' | null, currentX: 0 });
  const preventClickRef = useRef(false);
  const [swipeDir, setSwipeDir] = useState<'left' | 'right' | null>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchRef.current = { startX: t.clientX, startY: t.clientY, locked: null, currentX: 0 };
    const el = cardRef.current;
    if (el) {
      el.style.transition = 'none';
      el.style.transform = '';
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const tr = touchRef.current;
    const t = e.touches[0];
    const dx = t.clientX - tr.startX;
    const dy = t.clientY - tr.startY;
    if (!tr.locked) {
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        tr.locked = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      }
    }
    if (tr.locked === 'h') {
      tr.currentX = dx;
      const el = cardRef.current;
      if (el) el.style.transform = `translateX(${dx}px)`;
      setSwipeDir(dx > 0 ? 'right' : 'left');
    }
  };

  const handleTouchEnd = () => {
    const tr = touchRef.current;
    const el = cardRef.current;
    if (!el || tr.locked !== 'h') {
      setSwipeDir(null);
      return;
    }
    preventClickRef.current = true;
    el.style.transition = 'transform 0.3s ease-out';
    if (tr.currentX < -SWIPE_THRESHOLD) {
      if (confirm('Close and kill this session?')) {
        el.style.transform = `translateX(-${window.innerWidth}px)`;
        setTimeout(() => onClose(), 280);
      } else {
        el.style.transform = '';
        setSwipeDir(null);
        setTimeout(() => { if (el) el.style.transition = ''; }, 300);
      }
    } else if (tr.currentX > SWIPE_THRESHOLD) {
      if (confirm('Hide this session?')) {
        el.style.transform = `translateX(${window.innerWidth}px)`;
        setTimeout(() => onDismiss(), 280);
      } else {
        el.style.transform = '';
        setSwipeDir(null);
        setTimeout(() => { if (el) el.style.transition = ''; }, 300);
      }
    } else {
      el.style.transform = '';
      setSwipeDir(null);
      setTimeout(() => { if (el) el.style.transition = ''; }, 300);
    }
    tr.currentX = 0;
  };

  const handleTouchCancel = () => {
    const el = cardRef.current;
    if (el) {
      el.style.transition = 'transform 0.3s ease-out';
      el.style.transform = '';
      setTimeout(() => { if (el) el.style.transition = ''; }, 300);
    }
    setSwipeDir(null);
    touchRef.current.currentX = 0;
  };

  const handleClick = () => {
    if (preventClickRef.current) {
      preventClickRef.current = false;
      return;
    }
    onClick();
  };

  return (
    <div className="swipe-container">
      {swipeDir && (
        <div className={`swipe-action ${swipeDir === 'right' ? 'swipe-hide' : 'swipe-close'}`}>
          {swipeDir === 'right' ? 'Hide' : 'Close'}
        </div>
      )}
      <div
        ref={cardRef}
        className={className}
        onClick={handleClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
      >
        <div className="card-header">
          <div className={`dot dot-${session.status}`} />
          <div
            className={`card-name${selected && onRename ? ' card-name-editable' : ''}`}
            onClick={selected && onRename ? handleRename : undefined}
          >
            {displayName}
            {session.customName && <span className="card-name-custom-indicator" />}
          </div>
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
          <ExpandableContext text={contextText} />
        )}
        {isWaiting && !hasPerm && session.lastMarker && !contextText && (
          <div className="card-marker">{session.lastMarker.message}</div>
        )}
      </div>
    </div>
  );
});

function ExpandableContext({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  // Consider "long" if likely to be clamped (rough heuristic: > 150 chars)
  const isLong = text.length > 150;

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded((v) => !v);
  }, []);

  return (
    <div
      className={`card-context${expanded ? ' card-context-expanded' : ''}`}
      onClick={isLong ? toggle : undefined}
    >
      {text}
      {isLong && (
        <div className="expand-hint">{expanded ? 'Tap to collapse' : 'Tap to expand'}</div>
      )}
    </div>
  );
}
