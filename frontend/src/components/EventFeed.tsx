import { useMemo, useState } from 'react';
import type React from 'react';
import type { ClaudeEvent } from '../types';
import { formatTime } from '../utils/time';
import {
  basename,
  eventDescription,
  toolIcon,
  truncate,
  stripMarkers,
} from '../utils/events';

const COLLAPSED_LIMIT = 2000;

interface EventFeedProps {
  events: ClaudeEvent[];
}

export function EventFeed({ events }: EventFeedProps): React.ReactElement | null {
  const filtered = useMemo(() => {
    return events
      .filter((ev) => {
        if (ev.type === 'pre_tool_use') return !!ev.assistantText || hasToolDetail(ev);
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

function ExpandableText({ text, className, limit = COLLAPSED_LIMIT }: { text: string; className: string; limit?: number }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > limit;

  if (!isLong) {
    return <div className={className}>{text}</div>;
  }

  return (
    <div
      className={`${className}${expanded ? ' expanded' : ' collapsed'}`}
      onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
    >
      {expanded ? text : truncate(text, limit)}
      <div className="expand-hint">{expanded ? 'Tap to collapse' : 'Tap to expand'}</div>
    </div>
  );
}

/** Check if an event has expandable tool details. */
function hasToolDetail(ev: ClaudeEvent): boolean {
  if (!ev.tool || !ev.toolInput) return false;
  const t = ev.tool;
  return t === 'Edit' || t === 'Bash' || t === 'Write' || t === 'ExitPlanMode';
}

/** Inline tool detail for event items (expandable). */
function ToolDetail({ tool, toolInput }: { tool: string; toolInput: Record<string, unknown> }) {
  if (tool === 'Edit') {
    const filePath = (toolInput.file_path as string) || '';
    const oldStr = (toolInput.old_string as string) || '';
    const newStr = (toolInput.new_string as string) || '';
    const oldLines = oldStr.split('\n').slice(0, 15);
    const newLines = newStr.split('\n').slice(0, 15);
    const truncated = oldStr.split('\n').length > 15 || newStr.split('\n').length > 15;
    return (
      <div className="event-tool-detail">
        <div className="etd-file">{basename(filePath)}</div>
        <div className="etd-diff">
          {oldLines.map((line, i) => (
            <div key={`d-${i}`} className="diff-del">- {line}</div>
          ))}
          {newLines.map((line, i) => (
            <div key={`a-${i}`} className="diff-add">+ {line}</div>
          ))}
          {truncated && <div className="diff-trunc">... (truncated)</div>}
        </div>
      </div>
    );
  }
  if (tool === 'Bash') {
    const cmd = (toolInput.command as string) || '';
    const desc = (toolInput.description as string) || '';
    return (
      <div className="event-tool-detail">
        {desc && <div className="etd-desc">{desc}</div>}
        <pre className="etd-command">$ {truncate(cmd, 800)}</pre>
      </div>
    );
  }
  if (tool === 'Write') {
    const filePath = (toolInput.file_path as string) || '';
    const content = (toolInput.content as string) || '';
    const lines = content.split('\n');
    const preview = lines.slice(0, 10).join('\n');
    const truncated = lines.length > 10;
    return (
      <div className="event-tool-detail">
        <div className="etd-file">{basename(filePath)} ({lines.length} lines)</div>
        <pre className="etd-command">{preview}{truncated ? '\n... (truncated)' : ''}</pre>
      </div>
    );
  }
  if (tool === 'ExitPlanMode') {
    const planContent = (toolInput.planContent as string) || '';
    const planFile = (toolInput.planFile as string) || '';
    if (!planContent) return null;
    return (
      <div className="event-tool-detail">
        <div className="etd-file">{planFile.split('/').pop() || 'Plan'}</div>
        <pre className="etd-plan">{planContent}</pre>
      </div>
    );
  }
  return null;
}

function EventItem({ event: ev, showAssistantText }: { event: ClaudeEvent; showAssistantText: boolean }) {
  const [detailExpanded, setDetailExpanded] = useState(false);
  const hasAssistantMsg = ev.type === 'pre_tool_use' && !!ev.assistantText;
  const hasDetail = hasToolDetail(ev);
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

  const handleDescClick = hasDetail ? (e: React.MouseEvent) => {
    e.stopPropagation();
    setDetailExpanded(v => !v);
  } : undefined;

  return (
    <div
      className={`event-item${hasDetail ? ' event-expandable' : ''}`}
      style={isHighlight ? { padding: '8px 0' } : undefined}
    >
      <span className="event-time">{formatTime(ev.timestamp)}</span>
      <span className="event-icon">{icon}</span>
      <span className="event-desc" onClick={handleDescClick}>
        <span className="event-desc-line">
          {eventDescription(ev)}
          {hasDetail && !detailExpanded && <span className="event-expand-arrow"> ▸</span>}
          {hasDetail && detailExpanded && <span className="event-expand-arrow"> ▾</span>}
        </span>

        {/* Expandable tool detail */}
        {detailExpanded && ev.tool && ev.toolInput && (
          <ToolDetail tool={ev.tool} toolInput={ev.toolInput} />
        )}

        {/* User prompt text */}
        {ev.type === 'user_prompt_submit' && ev.assistantText && (
          <ExpandableText text={ev.assistantText} className="event-prompt" limit={300} />
        )}

        {/* Claude response on stop */}
        {ev.type === 'stop' && ev.assistantText && (() => {
          const cleanText = stripMarkers(ev.assistantText);
          return cleanText ? (
            <ExpandableText text={cleanText} className="event-assistant" />
          ) : null;
        })()}

        {/* Claude's message before tool call */}
        {showAssistantText && ev.assistantText && (() => {
          const cleanText = stripMarkers(ev.assistantText);
          return cleanText ? (
            <ExpandableText text={cleanText} className="event-assistant" />
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
