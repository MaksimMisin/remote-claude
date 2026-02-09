// ============================================================
// telegram-format -- HTML formatting helpers for Telegram bot messages
// ============================================================

import { TELEGRAM_MESSAGE_LIMIT } from '../shared/defaults.js';

/** Strip leading emoji prefix from tmux window name (same logic as web dashboard). */
function stripEmojiPrefix(name: string): string {
  return name.replace(/^[\p{Emoji}\p{Emoji_Presentation}\uFE0F]+\s*/u, '');
}

/** Get display name matching the web dashboard priority:
 *  customName > windowName (emoji-stripped) > name (tmux-target-stripped) > id */
export function getDisplayName(session: {
  id: string;
  name: string;
  customName?: string;
  windowName?: string;
}): string {
  if (session.customName) return session.customName;
  if (session.windowName) return stripEmojiPrefix(session.windowName);
  // Strip " (tmuxTarget)" suffix added by auto-discovery
  return session.name.replace(/\s*\([^)]*:\d+\.\d+\)$/, '') || session.id;
}

/** Escape <, >, & for safe embedding in Telegram HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** One-line tool summary for display in notifications. */
export function formatToolSummary(
  tool: string,
  toolInput?: Record<string, unknown>,
): string {
  if (!tool) return '';

  switch (tool) {
    case 'Bash': {
      const cmd = String(toolInput?.command ?? '');
      const truncated = cmd.length > 200 ? cmd.slice(0, 200) + '...' : cmd;
      return `$ ${truncated}`;
    }
    case 'Read':
      return `Read(${String(toolInput?.file_path ?? '')})`;
    case 'Edit':
    case 'Write':
      return `${tool}(${String(toolInput?.file_path ?? '')})`;
    case 'Glob':
      return `Glob(${String(toolInput?.pattern ?? '')})`;
    case 'Grep':
      return `Grep(${String(toolInput?.pattern ?? '')})`;
    default:
      return `${tool}()`;
  }
}

/** Format a "session finished" notification. */
export function formatSessionFinished(
  sessionName: string,
  snippet?: string,
  markerMsg?: string,
): string {
  const content = snippet || markerMsg;
  let msg = `\u2705 <b>${escapeHtml(sessionName)}</b> finished`;
  if (content) {
    msg += `\n<blockquote expandable>${escapeHtml(content)}</blockquote>`;
  }
  return msg;
}

/** Format a "needs approval" notification. */
export function formatSessionWaiting(
  sessionName: string,
  tool?: string,
  toolInput?: Record<string, unknown>,
): string {
  let msg = `\u26A0\uFE0F <b>${escapeHtml(sessionName)}</b> needs approval`;
  if (tool) {
    const summary = formatToolSummary(tool, toolInput);
    msg += `\n\n<b>${escapeHtml(tool)}</b>: <code>${escapeHtml(summary)}</code>`;
  }
  return msg;
}

/** Format an "offline" notification. */
export function formatSessionOffline(sessionName: string): string {
  return `\uD83D\uDD34 <b>${escapeHtml(sessionName)}</b> went offline`;
}

/** Format a "question" notification. */
export function formatSessionQuestion(
  sessionName: string,
  questionText: string,
): string {
  return (
    `\u2753 <b>${escapeHtml(sessionName)}</b> has a question\n` +
    `<blockquote expandable>${escapeHtml(questionText)}</blockquote>`
  );
}

/** Status emoji mapping. */
const STATUS_EMOJI: Record<string, string> = {
  idle: '\uD83D\uDFE2',
  working: '\uD83D\uDD35',
  waiting: '\uD83D\uDFE1',
  offline: '\uD83D\uDD34',
};

/** Format a list of sessions for the /sessions command. */
export function formatSessionList(
  sessions: Array<{
    name: string;
    customName?: string;
    windowName?: string;
    id: string;
    status: string;
    currentTool?: string;
  }>,
): string {
  if (sessions.length === 0) {
    return '<b>Sessions</b>\n\nNo active sessions.';
  }

  const lines = sessions.map((s) => {
    const emoji = STATUS_EMOJI[s.status] ?? '\u2B1C';
    const displayName = getDisplayName(s);
    let line = `${emoji} <b>${escapeHtml(displayName)}</b> \u2014 ${escapeHtml(s.status)}`;
    if (s.status === 'working' && s.currentTool) {
      line += ` (${escapeHtml(s.currentTool)})`;
    }
    return line;
  });

  return `<b>Sessions</b>\n\n${lines.join('\n')}`;
}

/**
 * Split an HTML message that exceeds Telegram's character limit.
 * Splits on newline boundaries, never inside an HTML tag.
 * Returns an array of message parts, each within maxLen.
 */
export function splitMessage(
  html: string,
  maxLen: number = TELEGRAM_MESSAGE_LIMIT,
): string[] {
  if (html.length <= maxLen) return [html];

  const parts: string[] = [];
  const lines = html.split('\n');
  let current = '';

  for (const line of lines) {
    // If adding this line (plus newline separator) would exceed the limit
    if (current.length > 0 && current.length + 1 + line.length > maxLen) {
      parts.push(current);
      current = '';
    }

    // Single line exceeds maxLen — truncate to avoid broken HTML
    // (splitting mid-line can break HTML tags and entities)
    if (line.length > maxLen) {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
      parts.push(line.slice(0, maxLen - 10) + ' [...]');
      continue;
    }

    // Normal append
    current = current.length > 0 ? current + '\n' + line : line;
  }

  if (current.length > 0) {
    parts.push(current);
  }

  return parts;
}
