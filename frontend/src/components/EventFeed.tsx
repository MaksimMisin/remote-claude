import { useMemo } from 'react';
import type React from 'react';
import type { ClaudeEvent } from '../types';
import { formatTime } from '../utils/time';
import {
  eventDescription,
  toolIcon,
  truncate,
  stripMarkers,
} from '../utils/events';

interface EventFeedProps {
  events: ClaudeEvent[];
}

export function EventFeed({ events }: EventFeedProps): React.ReactElement | null {
  const filtered = useMemo(() => {
    return events
      .filter((ev) => {
        if (ev.type === 'pre_tool_use') return !!ev.assistantText;
        return true;
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [events]);

  if (filtered.length === 0) return null;

  return (
    <div id="event-feed">
      <div className="feed-title">Events</div>
      <div id="events">
        {filtered.map((ev, idx) => {
          // Deduplicate consecutive identical assistantText on pre_tool_use events
          // Events are sorted newest-first, so skip if the previous (newer) event had the same text
          let showAssistantText = false;
          if (ev.type === 'pre_tool_use' && ev.assistantText) {
            const cleanText = stripMarkers(ev.assistantText);
            if (cleanText) {
              showAssistantText = true;
              // Check if a newer event (lower index) already showed the same text
              for (let j = idx - 1; j >= 0; j--) {
                const prev = filtered[j];
                if (prev.type === 'pre_tool_use' && prev.assistantText) {
                  if (stripMarkers(prev.assistantText) === cleanText) {
                    showAssistantText = false;
                  }
                  break;
                }
                break;
              }
            }
          }
          return (
            <EventItem key={ev.id} event={ev} showAssistantText={showAssistantText} />
          );
        })}
      </div>
    </div>
  );
}

function EventItem({ event: ev, showAssistantText }: { event: ClaudeEvent; showAssistantText: boolean }) {
  const hasAssistantMsg = ev.type === 'pre_tool_use' && !!ev.assistantText;
  const icon =
    ev.type === 'stop'
      ? '\u2705'
      : ev.type === 'user_prompt_submit'
        ? '\uD83D\uDCAC'
        : ev.type === 'notification'
          ? '\uD83D\uDD14'
          : ev.type === 'session_start'
            ? '\uD83D\uDE80'
            : hasAssistantMsg
              ? '\uD83D\uDCAC'
              : toolIcon(ev.tool);

  const isHighlight =
    ev.type === 'stop' ||
    ev.type === 'user_prompt_submit' ||
    ev.type === 'notification' ||
    hasAssistantMsg;

  return (
    <div
      className="event-item"
      style={isHighlight ? { padding: '8px 0' } : undefined}
    >
      <span className="event-time">{formatTime(ev.timestamp)}</span>
      <span className="event-icon">{icon}</span>
      <span className="event-desc">
        {eventDescription(ev)}

        {/* User prompt text */}
        {ev.type === 'user_prompt_submit' && ev.assistantText && (
          <div className="event-prompt">
            {truncate(ev.assistantText, 300)}
          </div>
        )}

        {/* Claude response on stop */}
        {ev.type === 'stop' && ev.assistantText && (() => {
          const cleanText = stripMarkers(ev.assistantText);
          return cleanText ? (
            <div className="event-assistant">
              {truncate(cleanText, 500)}
            </div>
          ) : null;
        })()}

        {/* Claude's message before tool call */}
        {showAssistantText && ev.assistantText && (() => {
          const cleanText = stripMarkers(ev.assistantText);
          return cleanText ? (
            <div className="event-assistant">
              {truncate(cleanText, 500)}
            </div>
          ) : null;
        })()}

        {/* Marker badge */}
        {ev.marker && ev.type !== 'stop' && (
          <div className="event-marker">
            {ev.marker.category}: {ev.marker.message}
          </div>
        )}

        {/* Error display */}
        {ev.error && (
          <div className="event-assistant" style={{ color: 'var(--red)' }}>
            {'\u274C'} {ev.error}
          </div>
        )}

        {/* Failed badge */}
        {ev.success === false && !ev.error && (
          <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 2 }}>
            {'\u274C'} Failed
          </div>
        )}
      </span>
    </div>
  );
}
