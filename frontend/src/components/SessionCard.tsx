import { memo, useState, useRef, useCallback } from 'react';
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

const SWIPE_THRESHOLD = 60;
const ACTION_WIDTH = 140; // total width of revealed actions

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

  // Swipe state
  const [offsetX, setOffsetX] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const swipingRef = useRef(false);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    swipingRef.current = false;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;

    // If vertical movement dominates, don't swipe
    if (!swipingRef.current && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) {
      touchStartRef.current = null;
      return;
    }

    if (Math.abs(dx) > 10) {
      swipingRef.current = true;
    }

    if (swipingRef.current) {
      // If already revealed, offset from the revealed position
      const base = revealed ? -ACTION_WIDTH : 0;
      const raw = base + dx;
      // Clamp: don't go positive, and limit max swipe
      const clamped = Math.max(-ACTION_WIDTH - 20, Math.min(0, raw));
      setOffsetX(clamped);
    }
  }, [revealed]);

  const handleTouchEnd = useCallback(() => {
    if (!swipingRef.current) {
      // It was a tap, not a swipe
      if (revealed) {
        setRevealed(false);
        setOffsetX(0);
      } else {
        onClick();
      }
      touchStartRef.current = null;
      return;
    }

    // Snap: if past threshold, reveal; otherwise close
    if (offsetX < -SWIPE_THRESHOLD) {
      setRevealed(true);
      setOffsetX(-ACTION_WIDTH);
    } else {
      setRevealed(false);
      setOffsetX(0);
    }
    touchStartRef.current = null;
    swipingRef.current = false;
  }, [offsetX, revealed, onClick]);

  // For non-touch: click handler
  const handleClick = useCallback(() => {
    if (revealed) {
      setRevealed(false);
      setOffsetX(0);
    } else {
      onClick();
    }
  }, [revealed, onClick]);

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
    <div className="card-swipe-container">
      <div className="card-actions">
        <button
          className="card-action-btn card-action-dismiss"
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
        >
          Hide
        </button>
        <button
          className="card-action-btn card-action-close"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
        >
          Close
        </button>
      </div>
      <div
        className={className}
        style={{
          transform: `translateX(${offsetX}px)`,
          transition: swipingRef.current ? 'none' : 'transform 0.25s ease',
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={handleClick}
      >
        <div className="card-header">
          <div className={`dot dot-${session.status}`} />
          <div className="card-name">{displayName}</div>
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
    </div>
  );
});
