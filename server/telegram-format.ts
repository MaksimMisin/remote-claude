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

/**
 * Convert common Markdown to Telegram HTML.
 * Handles: fenced code blocks, inline code, tables, bold, italic, headings.
 * Use instead of escapeHtml() for Claude's assistant text in blockquotes.
 */
export function markdownToTelegramHtml(text: string): string {
  const blocks: string[] = [];
  const ph = (idx: number) => `\x00B${idx}\x00`;

  let result = text;

  // 1. Extract fenced code blocks (```lang\n...\n```)
  result = result.replace(/```\w*\n([\s\S]*?)```/g, (_, code) => {
    const idx = blocks.length;
    blocks.push(`<pre>${escapeHtml(code.trimEnd())}</pre>`);
    return ph(idx);
  });

  // 2. Convert markdown tables to clean text lines (before inline code extraction)
  result = result.replace(/((?:^|\n)\|[^\n]+\|(?:\n\|[^\n]+\|)*)/g, (match) => {
    const lines = match.trim().split('\n');
    const dataLines = lines
      .filter(line => !/^\|[\s\-:|]+\|$/.test(line))  // drop separator rows
      .map(line => {
        // Strip markdown formatting inside cells
        let clean = line.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
        // Parse cells: split on |, trim, drop empty first/last from leading/trailing |
        const cells = clean.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
        return cells;
      });
    // First row = header (bold), rest = data rows joined with " — "
    const formatted = dataLines.map((cells, i) => {
      const joined = cells.join(' — ');
      return i === 0 ? `<b>${escapeHtml(joined)}</b>` : escapeHtml(joined);
    });
    const idx = blocks.length;
    blocks.push(formatted.join('\n'));
    return '\n' + ph(idx) + '\n';
  });

  // 3. Extract inline code (`...`)
  result = result.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = blocks.length;
    blocks.push(`<code>${escapeHtml(code)}</code>`);
    return ph(idx);
  });

  // 4. Escape HTML in remaining text
  result = escapeHtml(result);

  // 5. Headings: # text → bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // 6. Bold: **text**
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // 7. Italic: *text* (not within words, not part of **)
  result = result.replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, '<i>$1</i>');

  // 8. Restore extracted blocks
  blocks.forEach((html, idx) => {
    result = result.replace(ph(idx), html);
  });

  return result;
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
    case 'ExitPlanMode': {
      const pf = String(toolInput?.planFile ?? '');
      const name = pf.split('/').pop() || 'Plan';
      return `Review plan: ${name}`;
    }
    default:
      return `${tool}()`;
  }
}

/** Format a single event line for the batched event stream. */
export function formatEventLine(
  tool?: string,
  toolInput?: Record<string, unknown>,
): string | undefined {
  if (!tool) return undefined;

  // Friendly verb + subject format matching the web dashboard
  switch (tool) {
    case 'Read': {
      const fp = String(toolInput?.file_path ?? '');
      const name = fp.split('/').pop() || fp;
      return `\uD83D\uDCD6 Reading <code>${escapeHtml(name)}</code>`;
    }
    case 'Grep': {
      const pattern = String(toolInput?.pattern ?? '');
      return `\uD83D\uDD0D Searching: <code>${escapeHtml(pattern.slice(0, 100))}</code>`;
    }
    case 'Glob': {
      const pattern = String(toolInput?.pattern ?? '');
      return `\uD83D\uDCC1 Glob: <code>${escapeHtml(pattern.slice(0, 100))}</code>`;
    }
    case 'Edit': {
      const fp = String(toolInput?.file_path ?? '');
      const name = fp.split('/').pop() || fp;
      return `\u270F\uFE0F Editing <code>${escapeHtml(name)}</code>`;
    }
    case 'Write': {
      const fp = String(toolInput?.file_path ?? '');
      const name = fp.split('/').pop() || fp;
      return `\uD83D\uDCDD Writing <code>${escapeHtml(name)}</code>`;
    }
    case 'Bash': {
      // Prefer description (matches web dashboard behavior)
      const desc = String(toolInput?.description ?? '');
      if (desc) return `\uD83D\uDCBB ${escapeHtml(desc)}`;
      const cmd = String(toolInput?.command ?? '');
      const truncated = cmd.length > 120 ? cmd.slice(0, 120) + '...' : cmd;
      return `\uD83D\uDCBB <code>$ ${escapeHtml(truncated)}</code>`;
    }
    case 'Task': {
      const desc = String(toolInput?.description ?? toolInput?.prompt ?? '').slice(0, 100);
      return `\uD83D\uDE80 Task: ${escapeHtml(desc)}`;
    }
    default: {
      const summary = formatToolSummary(tool, toolInput);
      return `\uD83D\uDD27 <code>${escapeHtml(summary)}</code>`;
    }
  }
}

/** Input shape for activity digest events. */
export interface DigestEvent {
  tool: string;
  toolInput: Record<string, unknown>;
  assistantText?: string;
}

/**
 * Convert a list of buffered tool events into a single condensed digest line.
 * Output format: '⚙️ verb1 · verb2 · verb3'
 * Deduplicates repeated tools (e.g. 5 Reads → 'read 5 files').
 * Returns empty string when input is empty or contains no meaningful events.
 */
export function formatActivityDigest(events: DigestEvent[]): string {
  if (!events || events.length === 0) return '';

  // Group events by tool type
  const groups = new Map<string, DigestEvent[]>();
  for (const ev of events) {
    if (!ev.tool) continue;
    const existing = groups.get(ev.tool) || [];
    existing.push(ev);
    groups.set(ev.tool, existing);
  }

  if (groups.size === 0) return '';

  const parts: string[] = [];

  for (const [tool, toolEvents] of groups) {
    const count = toolEvents.length;

    switch (tool) {
      case 'Read': {
        parts.push(count === 1
          ? 'read 1 file'
          : `read ${count} files`);
        break;
      }
      case 'Grep': {
        parts.push(count === 1
          ? '1 search'
          : `${count} searches`);
        break;
      }
      case 'Glob': {
        parts.push(count === 1
          ? '1 glob'
          : `${count} globs`);
        break;
      }
      case 'Edit': {
        // Always include basenames
        const names = [...new Set(toolEvents.map(ev => {
          const fp = String(ev.toolInput?.file_path ?? '');
          return fp.split('/').pop() || 'file';
        }))];
        if (names.length === 1) {
          parts.push(`edited ${escapeHtml(names[0])}`);
        } else {
          parts.push(`edited ${names.map(n => escapeHtml(n)).join(', ')}`);
        }
        break;
      }
      case 'Write': {
        // Always include basenames
        const names = [...new Set(toolEvents.map(ev => {
          const fp = String(ev.toolInput?.file_path ?? '');
          return fp.split('/').pop() || 'file';
        }))];
        if (names.length === 1) {
          parts.push(`wrote ${escapeHtml(names[0])}`);
        } else {
          parts.push(`wrote ${names.map(n => escapeHtml(n)).join(', ')}`);
        }
        break;
      }
      case 'Bash': {
        // Each bash command is unique — list them individually
        for (const ev of toolEvents) {
          const desc = String(ev.toolInput?.description ?? '');
          if (desc) {
            parts.push(escapeHtml(desc.length > 40 ? desc.slice(0, 37) + '...' : desc));
          } else {
            const cmd = String(ev.toolInput?.command ?? '');
            const truncated = cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd;
            parts.push(escapeHtml(truncated));
          }
        }
        break;
      }
      case 'Task': {
        for (const ev of toolEvents) {
          const desc = String(ev.toolInput?.description ?? ev.toolInput?.prompt ?? '').slice(0, 40);
          parts.push(`task: ${escapeHtml(desc)}`);
        }
        break;
      }
      default: {
        parts.push(count === 1
          ? tool.toLowerCase()
          : `${count}× ${tool.toLowerCase()}`);
        break;
      }
    }
  }

  if (parts.length === 0) return '';

  let result = `⚙️ ${parts.join(' · ')}`;

  // Find longest non-trivial assistantText
  const trivialPrefixes = ['Let me', "I'll", 'Now'];
  const candidates = events
    .filter(ev => ev.assistantText)
    .map(ev => ev.assistantText!.replace(/<!--rc:\w+:?[^>]*-->/g, '').trim())
    .filter(text => {
      if (!text) return false;
      // Skip single sentences starting with trivial prefixes
      const isSingleSentence = !text.includes('\n') && (text.match(/\./g) || []).length <= 1;
      if (isSingleSentence && trivialPrefixes.some(p => text.startsWith(p))) return false;
      return true;
    });

  if (candidates.length > 0) {
    const longest = candidates.reduce((a, b) => a.length >= b.length ? a : b);
    const truncated = longest.length > 300 ? longest.slice(0, 297) + '...' : longest;
    result += `\n  <i>${escapeHtml(truncated)}</i>`;
  }

  return result;
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
    const htmlContent = markdownToTelegramHtml(content);
    if (content.length > 300) {
      msg += `\n<blockquote expandable>${htmlContent}</blockquote>`;
    } else {
      msg += `\n${htmlContent}`;
    }
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

  // For ExitPlanMode, include the plan content so reviewers can make informed decisions
  if (tool === 'ExitPlanMode' && toolInput?.planContent) {
    const plan = String(toolInput.planContent);
    // Blockquote overhead: "<blockquote expandable>...</blockquote>\n\n" ≈ 40 chars
    // Budget applied to raw text; HTML conversion may add ~10-20% from tags
    const budget = TELEGRAM_MESSAGE_LIMIT - msg.length - 60;
    if (budget > 200) {
      const truncated = plan.length > budget
        ? plan.slice(0, budget) + '\n[... truncated]'
        : plan;
      msg += `\n\n<blockquote expandable>${markdownToTelegramHtml(truncated)}</blockquote>`;
    }
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
    `<blockquote expandable>${markdownToTelegramHtml(questionText)}</blockquote>`
  );
}

/** Status emoji mapping. */
const STATUS_EMOJI: Record<string, string> = {
  idle: '\uD83D\uDFE2',       // 🟢 green = done/idle
  working: '\u270F\uFE0F',    // ✏️ pencil = actively writing
  waiting: '\uD83D\uDFE1',    // 🟡 yellow = needs attention
  offline: '\uD83D\uDD34',    // 🔴 red = dead
};

/** Get status emoji for a session status. */
export function getStatusEmoji(status: string): string {
  return STATUS_EMOJI[status] ?? '\u2B1C';
}

/** Format a duration in ms to a human-readable string (e.g. "2h 34m"). */
export function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return '<1m';
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours === 0) return `${mins}m`;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

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

/** Format a compact one-liner for resolved permission buttons. */
export function formatPermissionResolved(
  sessionName: string,
  action: 'approved' | 'approved-all' | 'rejected',
  tool?: string,
): string {
  const time = new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const emoji = action === 'rejected' ? '\u274C' : '\u2705';
  const verb = action === 'approved' ? 'Approved' : action === 'approved-all' ? 'Approved all' : 'Rejected';
  let msg = `${emoji} ${verb}`;
  if (tool) {
    msg += ` ${escapeHtml(tool)}`;
  }
  msg += ` on <b>${escapeHtml(sessionName)}</b> (${time})`;
  return msg;
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
