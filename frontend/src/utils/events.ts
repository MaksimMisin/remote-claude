import type { ClaudeEvent, ManagedSession } from '../types';

/**
 * Extract filename from a file path.
 */
export function basename(path: string | undefined): string {
  if (!path) return '';
  return path.split('/').pop() || path;
}

/**
 * Truncate a string with ellipsis.
 */
export function truncate(s: string | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '\u2026' : s;
}

/**
 * Strip <!--rc:...--> markers from displayed text.
 */
export function stripMarkers(s: string | undefined): string {
  if (!s) return '';
  return s.replace(/<!--rc:\w+:?[^>]*-->/g, '').trim();
}

/**
 * Map MCP tool names to human-readable descriptions.
 */
export function humanizeMcpTool(
  tool: string,
  inp: Record<string, unknown>,
): string {
  const match = tool.match(/^mcp__[^_]+__(.+)$/);
  if (!match) return tool;
  const action = match[1];

  const names: Record<string, string | null> = {
    computer: null, // handled below with action detail
    read_page: 'Reading page',
    navigate:
      inp && inp.url
        ? 'Opening ' + truncate(inp.url as string, 30)
        : 'Navigating',
    tabs_context_mcp: 'Getting tab context',
    tabs_create_mcp: 'Creating tab',
    find:
      inp && inp.query
        ? 'Finding: ' + truncate(inp.query as string, 30)
        : 'Finding element',
    form_input: 'Filling form field',
    javascript_tool: 'Running JavaScript',
    get_page_text: 'Reading page text',
    resize_window: 'Resizing window',
    gif_creator: 'Recording GIF',
    upload_image: 'Uploading image',
    update_plan: 'Updating plan',
    read_console_messages: 'Reading console',
    read_network_requests: 'Reading network',
    shortcuts_list: 'Listing shortcuts',
    shortcuts_execute: 'Running shortcut',
  };

  if (action === 'computer' || names[action] === null) {
    const ca = ((inp && inp.action) as string) || '';
    const computerActions: Record<string, string> = {
      screenshot: 'Taking screenshot',
      left_click: 'Clicking',
      right_click: 'Right-clicking',
      double_click: 'Double-clicking',
      triple_click: 'Triple-clicking',
      type: 'Typing',
      key: 'Pressing key',
      scroll: 'Scrolling',
      scroll_to: 'Scrolling to element',
      wait: 'Waiting',
      hover: 'Hovering',
      left_click_drag: 'Dragging',
      zoom: 'Zooming in',
    };
    return computerActions[ca] || 'Browser action';
  }

  return names[action] || action.replace(/_/g, ' ');
}

/**
 * Emoji icon for a tool.
 */
export function toolIcon(tool: string | undefined): string {
  if (!tool) return '\u2022';
  if (tool.startsWith('mcp__')) return '\uD83C\uDF10';
  const icons: Record<string, string> = {
    Read: '\uD83D\uDCD6',
    Write: '\u270F\uFE0F',
    Edit: '\uD83D\uDD27',
    Bash: '\uD83D\uDCBB',
    Grep: '\uD83D\uDD0D',
    Glob: '\uD83D\uDD0D',
    WebFetch: '\uD83C\uDF10',
    WebSearch: '\uD83C\uDF10',
    Task: '\uD83D\uDD00',
    NotebookEdit: '\uD83D\uDCD3',
    AskUserQuestion: '\u2753',
    TaskCreate: '\uD83D\uDCCB',
    TaskUpdate: '\uD83D\uDCCB',
  };
  return icons[tool] || '\u2022';
}

/**
 * Generate a human-readable description of a ClaudeEvent.
 */
export function eventDescription(ev: ClaudeEvent): string {
  const t = ev.tool;
  const inp = (ev.toolInput || {}) as Record<string, unknown>;

  if (ev.type === 'stop') return ev.marker ? ev.marker.message : 'Finished';
  if (ev.type === 'session_start') return 'Session started';
  if (ev.type === 'session_end') return 'Session ended';
  if (ev.type === 'user_prompt_submit') return 'Prompt';
  if (ev.type === 'notification') {
    if (ev.tool && ev.toolInput) {
      return permissionToolSummary(ev.tool, ev.toolInput);
    }
    return ev.marker ? ev.marker.message : 'Waiting for input';
  }
  if (!t) return ev.type;

  // MCP tools
  if (t.startsWith('mcp__')) return humanizeMcpTool(t, inp);

  // Standard Claude Code tools
  if (t === 'Bash')
    return (
      (inp.description as string) || '$ ' + truncate(inp.command as string, 50)
    );
  if (t === 'Read') return 'Reading ' + basename(inp.file_path as string);
  if (t === 'Edit') return 'Editing ' + basename(inp.file_path as string);
  if (t === 'Write') return 'Writing ' + basename(inp.file_path as string);
  if (t === 'Grep')
    return 'Searching: ' + truncate(inp.pattern as string, 40);
  if (t === 'Glob') return 'Finding: ' + truncate(inp.pattern as string, 40);
  if (t === 'WebFetch') return 'Fetching ' + truncate(inp.url as string, 40);
  if (t === 'WebSearch')
    return 'Web search: ' + truncate(inp.query as string, 40);
  if (t === 'Task')
    return 'Agent: ' + truncate(inp.description as string, 50);
  if (t === 'AskUserQuestion') return 'Asking a question';
  if (t === 'TaskCreate' || t === 'TaskUpdate') return 'Updating tasks';

  return t + (inp.file_path ? ': ' + basename(inp.file_path as string) : '');
}

/**
 * Humanize a current tool name for session card summaries.
 */
export function humanizeCurrentTool(tool: string | undefined): string {
  if (!tool) return 'Working...';
  if (tool.startsWith('mcp__')) {
    const m = tool.match(/^mcp__[^_]+__(.+)$/);
    if (m) {
      const act = m[1];
      if (act === 'computer') return 'Using browser';
      if (act === 'read_page') return 'Reading page';
      if (act === 'navigate') return 'Navigating browser';
      return act.replace(/_/g, ' ');
    }
  }
  const toolNames: Record<string, string> = {
    Bash: 'Running command',
    Read: 'Reading file',
    Write: 'Writing file',
    Edit: 'Editing file',
    Grep: 'Searching code',
    Glob: 'Finding files',
    Task: 'Running agent',
    WebSearch: 'Searching web',
    WebFetch: 'Fetching page',
    AskUserQuestion: 'Asking question',
  };
  return toolNames[tool] || tool;
}

/**
 * Build a short tool-specific summary for a permission request.
 */
function permissionToolSummary(tool: string, toolInput: Record<string, unknown>): string {
  if (tool === 'Edit') return 'Approve edit: ' + basename(toolInput.file_path as string);
  if (tool === 'Write') return 'Approve write: ' + basename(toolInput.file_path as string);
  if (tool === 'Read') return 'Approve read: ' + basename(toolInput.file_path as string);
  if (tool === 'Bash') {
    const desc = toolInput.description as string;
    const cmd = toolInput.command as string;
    return 'Approve: ' + truncate(desc || cmd, 60);
  }
  if (tool === 'AskUserQuestion') {
    const questions = toolInput.questions as Array<{ question?: string }> | undefined;
    if (questions && questions[0]?.question) return truncate(questions[0].question, 80);
    return 'Asking a question';
  }
  return 'Approve: ' + tool;
}

/**
 * Generate action summary text for a session card.
 */
export function actionSummary(
  session: ManagedSession,
  cancelling: boolean,
): string {
  if (cancelling) return 'Cancelling...';
  if (session.status === 'offline') return 'Disconnected';
  if (session.status === 'waiting') {
    if (session.permissionRequest) {
      return permissionToolSummary(session.permissionRequest.tool, session.permissionRequest.toolInput);
    }
    return session.lastMarker
      ? session.lastMarker.message
      : 'Waiting for input';
  }
  if (session.lastMarker && session.status === 'idle')
    return session.lastMarker.message;
  if (session.currentTool) return humanizeCurrentTool(session.currentTool);
  if (session.status === 'working') return 'Working...';
  return 'Idle';
}
