// ============================================================
// TelegramBot -- grammY-based Telegram bot for status notifications
// and session control. Supports both DM chat (single user) and
// forum-mode (supergroup with topics, one topic per session).
// ============================================================

import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { ClaudeEvent, ManagedSession, SessionStatus } from '../shared/types.js';
import { TELEGRAM_GENERAL_TOPIC_ID } from '../shared/defaults.js';
import { TopicManager } from './TopicManager.js';
import * as fmt from './telegram-format.js';

// --- Config interface ---

export interface TelegramBotConfig {
  token: string;
  chatId: string;
  forumMode?: 'auto' | 'true' | 'false';
  getSessions: () => ManagedSession[];
  getSession: (id: string) => ManagedSession | undefined;
  sendPrompt: (sessionId: string, text: string) => Promise<void>;
  sendKeys: (sessionId: string, keys: string[]) => Promise<void>;
}

// --- TelegramBot class ---

export class TelegramBot {
  private bot: Bot;
  private config: TelegramBotConfig;
  private chatId: string;
  private activeSessionId: string | null = null;
  private forumMode: boolean = false;
  private topicManager: TopicManager | null = null;
  private pinnedStatusDebounce: ReturnType<typeof setTimeout> | null = null;
  /** Per-session event buffer for batched sending. */
  private eventBuffer = new Map<string, string[]>();
  /** Per-session flush timers for event batches. */
  private eventFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private getSessions: TelegramBotConfig['getSessions'];
  private getSession: TelegramBotConfig['getSession'];
  private sendPrompt: TelegramBotConfig['sendPrompt'];
  private sendKeys: TelegramBotConfig['sendKeys'];

  constructor(config: TelegramBotConfig) {
    this.config = config;
    this.chatId = config.chatId;
    this.getSessions = config.getSessions;
    this.getSession = config.getSession;
    this.sendPrompt = config.sendPrompt;
    this.sendKeys = config.sendKeys;

    this.bot = new Bot(config.token);

    this.registerHandlers();
  }

  // ---- Handler registration ----

  private registerHandlers(): void {
    // Global error handler -- log but don't crash the server
    this.bot.catch((err) => {
      console.error('[Telegram] Bot error:', err.message || err);
    });

    // Command handlers
    this.bot.command('start', (ctx) => this.handleStart(ctx));
    this.bot.command('sessions', (ctx) => this.handleSessions(ctx));
    this.bot.command('bind', (ctx) => this.handleBind(ctx));
    this.bot.command('status', (ctx) => this.handleStatus(ctx));
    this.bot.command('help', (ctx) => this.handleHelp(ctx));

    // Callback query handler (inline keyboard button presses)
    this.bot.on('callback_query:data', (ctx) => this.handleCallbackQuery(ctx));

    // Text message handler (prompt delivery)
    this.bot.on('message:text', (ctx) => this.handleTextMessage(ctx));
  }

  // ---- Authorization guard ----

  /** Returns true if the message is from the authorized user. Silently ignores unauthorized. */
  private isAuthorized(ctx: Context): boolean {
    return ctx.chat?.id.toString() === this.chatId;
  }

  // ---- Command handlers ----

  private async handleStart(ctx: Context): Promise<void> {
    if (!this.isAuthorized(ctx)) {
      await ctx.reply('Unauthorized. Your chat ID: ' + ctx.chat?.id);
      return;
    }

    const chatId = ctx.chat?.id.toString() ?? 'unknown';
    const threadId = ctx.message?.message_thread_id;

    await ctx.reply(
      'Remote Claude bot is active.\n\n' +
        'This bot sends status notifications for your Claude Code sessions ' +
        'and lets you send prompts and approve permissions.\n\n' +
        'Commands:\n' +
        '/sessions \u2014 List sessions\n' +
        '/bind <name> \u2014 Set active session\n' +
        '/status \u2014 Active session status\n' +
        '/help \u2014 Command reference\n\n' +
        `Your chat ID: <code>${fmt.escapeHtml(chatId)}</code>`,
      {
        parse_mode: 'HTML',
        ...(threadId ? { message_thread_id: threadId } : {}),
      },
    );
  }

  private async handleSessions(ctx: Context): Promise<void> {
    if (!this.isAuthorized(ctx)) return;

    // Forum mode: ensure topics exist and update pinned status
    if (this.forumMode && this.topicManager) {
      const sessions = this.getSessions();
      for (const s of sessions) {
        if (s.status !== 'offline') {
          await this.topicManager.ensureTopic(s.id, fmt.getDisplayName(s));
        }
      }
      // Update pinned status
      await this.updatePinnedStatus();
      const threadId = ctx.message?.message_thread_id;
      await ctx.reply('Topics updated and status refreshed.', {
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
      return;
    }

    // DM mode: list sessions with bind buttons
    const sessions = this.getSessions();
    const html = fmt.formatSessionList(sessions);

    // Build inline keyboard with bind buttons for each session
    const keyboard = new InlineKeyboard();
    for (const s of sessions) {
      if (s.status === 'offline') continue;
      const displayName = fmt.getDisplayName(s);
      const label = this.activeSessionId === s.id
        ? `\u2714 ${displayName}`
        : displayName;
      keyboard.text(label, `bind:${s.id}`).row();
    }

    await this.sendControlMessage(html, sessions.length > 0 ? keyboard : undefined);
  }

  private async handleBind(ctx: Context): Promise<void> {
    if (!this.isAuthorized(ctx)) return;

    // Forum mode: binding is not needed
    if (this.forumMode) {
      await ctx.reply('Not needed in forum mode \u2014 send messages directly in session topics.', {
        ...(ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {}),
      });
      return;
    }

    const text = ctx.message?.text ?? '';
    const arg = text.replace(/^\/bind\s*/i, '').trim();

    if (!arg) {
      if (this.activeSessionId) {
        const session = this.getSession(this.activeSessionId);
        const name = session
          ? fmt.getDisplayName(session)
          : this.activeSessionId;
        await ctx.reply(`Active session: <b>${fmt.escapeHtml(name)}</b>\n\nUsage: /bind &lt;name-or-id&gt;`, {
          parse_mode: 'HTML',
        });
      } else {
        await ctx.reply('No active session. Usage: /bind <name-or-id>');
      }
      return;
    }

    const session = this.resolveSession(arg);
    if (!session) {
      await ctx.reply(`No session matching "${fmt.escapeHtml(arg)}". Use /sessions to see available sessions.`, {
        parse_mode: 'HTML',
      });
      return;
    }

    this.activeSessionId = session.id;
    const name = fmt.getDisplayName(session);
    await ctx.reply(`Bound to <b>${fmt.escapeHtml(name)}</b>. Text messages will be sent to this session.`, {
      parse_mode: 'HTML',
    });
  }

  private async handleStatus(ctx: Context): Promise<void> {
    if (!this.isAuthorized(ctx)) return;

    // In forum mode, show status for the topic's session
    if (this.forumMode && this.topicManager) {
      const threadId = ctx.message?.message_thread_id;
      if (threadId && threadId !== TELEGRAM_GENERAL_TOPIC_ID) {
        const sessionId = this.topicManager.getSessionId(threadId);
        if (sessionId) {
          const session = this.getSession(sessionId);
          if (session) {
            const name = fmt.getDisplayName(session);
            const lines: string[] = [
              `<b>${fmt.escapeHtml(name)}</b>`,
              '',
              `Status: ${fmt.escapeHtml(session.status)}`,
            ];
            if (session.cwd) lines.push(`Directory: <code>${fmt.escapeHtml(session.cwd)}</code>`);
            if (session.gitBranch) lines.push(`Branch: <code>${fmt.escapeHtml(session.gitBranch)}</code>${session.gitDirty ? ' (dirty)' : ''}`);
            if (session.currentTool) lines.push(`Tool: <code>${fmt.escapeHtml(session.currentTool)}</code>`);
            if (session.lastMarker) lines.push(`Last marker: ${fmt.escapeHtml(session.lastMarker.category)} \u2014 ${fmt.escapeHtml(session.lastMarker.message)}`);
            if (session.totalTokens != null) lines.push(`Tokens: ${session.totalTokens.toLocaleString()}`);
            await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', message_thread_id: threadId });
            return;
          }
        }
      }
      // General topic or unknown -- show all sessions
      await this.handleSessions(ctx);
      return;
    }

    // DM mode: show active session status
    if (!this.activeSessionId) {
      await ctx.reply('No active session. Use /sessions to bind one.');
      return;
    }

    const session = this.getSession(this.activeSessionId);
    if (!session) {
      this.activeSessionId = null;
      await ctx.reply('Active session no longer exists. Use /sessions to bind one.');
      return;
    }

    const name = fmt.getDisplayName(session);
    const lines: string[] = [
      `<b>${fmt.escapeHtml(name)}</b>`,
      '',
      `Status: ${fmt.escapeHtml(session.status)}`,
    ];

    if (session.cwd) {
      lines.push(`Directory: <code>${fmt.escapeHtml(session.cwd)}</code>`);
    }
    if (session.gitBranch) {
      lines.push(`Branch: <code>${fmt.escapeHtml(session.gitBranch)}</code>${session.gitDirty ? ' (dirty)' : ''}`);
    }
    if (session.currentTool) {
      lines.push(`Tool: <code>${fmt.escapeHtml(session.currentTool)}</code>`);
    }
    if (session.lastMarker) {
      lines.push(`Last marker: ${fmt.escapeHtml(session.lastMarker.category)} \u2014 ${fmt.escapeHtml(session.lastMarker.message)}`);
    }
    if (session.totalTokens != null) {
      lines.push(`Tokens: ${session.totalTokens.toLocaleString()}`);
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  }

  private async handleHelp(ctx: Context): Promise<void> {
    if (!this.isAuthorized(ctx)) return;

    const threadId = ctx.message?.message_thread_id;

    await ctx.reply(
      '<b>Commands</b>\n\n' +
        '/sessions \u2014 List sessions and bind to one\n' +
        '/bind &lt;name&gt; \u2014 Set active session by name or ID\n' +
        '/status \u2014 Show active session details\n' +
        '/help \u2014 This message\n\n' +
        '<b>Usage</b>\n\n' +
        (this.forumMode
          ? 'Each session gets its own topic. Send messages in a session topic to deliver prompts. '
          : 'Text messages are sent as prompts to the active session. ') +
        'Use the inline buttons on permission notifications to approve or reject.',
      {
        parse_mode: 'HTML',
        ...(threadId ? { message_thread_id: threadId } : {}),
      },
    );
  }

  // ---- Text message handler ----

  private async handleTextMessage(ctx: Context): Promise<void> {
    if (!this.isAuthorized(ctx)) return;
    const text = ctx.message?.text;
    if (!text) return;

    // Forum mode: route by topic
    if (this.forumMode && this.topicManager) {
      const threadId = ctx.message?.message_thread_id;

      // General topic or no thread -- show help
      if (!threadId || threadId === TELEGRAM_GENERAL_TOPIC_ID) {
        await ctx.reply('Send messages in a session topic to deliver prompts.');
        return;
      }

      const sessionId = this.topicManager.getSessionId(threadId);
      if (!sessionId) {
        await ctx.reply('This topic is not linked to a session.', {
          message_thread_id: threadId,
        });
        return;
      }

      const session = this.getSession(sessionId);
      if (!session) {
        await ctx.reply('Session no longer exists.', {
          message_thread_id: threadId,
        });
        return;
      }

      if (session.status === 'offline') {
        await ctx.reply('Session is offline.', {
          message_thread_id: threadId,
        });
        return;
      }

      try {
        await this.sendPrompt(sessionId, text);
        await ctx.reply('\u2192 sent', {
          message_thread_id: threadId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await ctx.reply(`Failed: ${fmt.escapeHtml(message)}`, {
          parse_mode: 'HTML',
          message_thread_id: threadId,
        });
      }
      return;
    }

    // DM mode: existing behavior
    if (!this.activeSessionId) {
      await ctx.reply('No active session. Use /sessions to bind one.');
      return;
    }

    const session = this.getSession(this.activeSessionId);
    if (!session) {
      this.activeSessionId = null;
      await ctx.reply('Active session no longer exists. Use /sessions to bind one.');
      return;
    }

    if (session.status === 'offline') {
      await ctx.reply(`Session <b>${fmt.escapeHtml(fmt.getDisplayName(session))}</b> is offline.`, {
        parse_mode: 'HTML',
      });
      return;
    }

    try {
      await this.sendPrompt(this.activeSessionId, text);
      const name = fmt.getDisplayName(session);
      await ctx.reply(`\u2192 sent to <b>${fmt.escapeHtml(name)}</b>`, {
        parse_mode: 'HTML',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Telegram] Failed to send prompt:', message);
      await ctx.reply(`Failed to send: ${fmt.escapeHtml(message)}`, {
        parse_mode: 'HTML',
      });
    }
  }

  // ---- Callback query handler ----

  private async handleCallbackQuery(ctx: Context): Promise<void> {
    if (!this.isAuthorized(ctx)) {
      await ctx.answerCallbackQuery({ text: 'Unauthorized' });
      return;
    }

    const data = ctx.callbackQuery?.data;
    if (!data) {
      await ctx.answerCallbackQuery();
      return;
    }

    const [action, sessionId] = data.split(':');
    if (!sessionId) {
      await ctx.answerCallbackQuery({ text: 'Invalid action' });
      return;
    }

    try {
      switch (action) {
        case 'bind': {
          const session = this.getSession(sessionId);
          if (!session) {
            await ctx.answerCallbackQuery({ text: 'Session not found' });
            return;
          }
          this.activeSessionId = sessionId;
          const name = fmt.getDisplayName(session);
          await ctx.answerCallbackQuery({ text: `Bound to ${name}` });
          break;
        }

        case 'yes': {
          await this.sendKeys(sessionId, ['Enter']);
          await ctx.answerCallbackQuery({ text: 'Approved' });
          // Self-clean: replace message with compact one-liner
          try {
            const session = this.getSession(sessionId);
            const name = session ? fmt.getDisplayName(session) : sessionId;
            const tool = session?.permissionRequest?.tool;
            await ctx.editMessageText(
              fmt.formatPermissionResolved(name, 'approved', tool),
              { parse_mode: 'HTML' },
            );
          } catch { /* message may be too old to edit */ }
          break;
        }

        case 'no': {
          await this.sendKeys(sessionId, ['Escape']);
          await ctx.answerCallbackQuery({ text: 'Rejected' });
          try {
            const session = this.getSession(sessionId);
            const name = session ? fmt.getDisplayName(session) : sessionId;
            const tool = session?.permissionRequest?.tool;
            await ctx.editMessageText(
              fmt.formatPermissionResolved(name, 'rejected', tool),
              { parse_mode: 'HTML' },
            );
          } catch { /* message may be too old to edit */ }
          break;
        }

        default:
          await ctx.answerCallbackQuery({ text: 'Unknown action' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Telegram] Callback query error:', message);
      await ctx.answerCallbackQuery({ text: 'Error: ' + message.slice(0, 100) });
    }
  }

  // ---- Session resolution ----

  /** Resolve a session by ID prefix or name (case-insensitive partial match). */
  private resolveSession(query: string): ManagedSession | undefined {
    const lower = query.toLowerCase();
    const sessions = this.getSessions();

    // Exact ID match
    const exact = sessions.find((s) => s.id === query);
    if (exact) return exact;

    // ID prefix match
    const byPrefix = sessions.find((s) => s.id.toLowerCase().startsWith(lower));
    if (byPrefix) return byPrefix;

    // Display name match (case-insensitive partial -- matches same name shown in UI)
    const byName = sessions.find((s) => {
      return fmt.getDisplayName(s).toLowerCase().includes(lower);
    });
    if (byName) return byName;

    return undefined;
  }

  // ---- Status change handler (called from index.ts) ----

  /**
   * Called by the server when a session's status changes.
   * Sends appropriate notifications to the authorized Telegram chat.
   * In forum mode, routes messages to the session's topic.
   */
  async onStatusChange(
    prevStatus: SessionStatus | undefined,
    session: ManagedSession,
  ): Promise<void> {
    const name = fmt.getDisplayName(session);
    const markerMsg = session.lastMarker?.message;
    const snippet = session.lastAssistantText
      ?.replace(/<!--rc:\w+:?[^>]*-->/g, '')
      .trim()
      .slice(0, 500);

    // In forum mode, get/create the session's topic
    // If topic creation fails, skip notification — never fall through to General
    let topicId: number | undefined;
    if (this.forumMode && this.topicManager) {
      topicId = await this.topicManager.ensureTopic(session.id, name);
      if (!topicId) {
        console.warn(`[Telegram] No topic for session ${session.id}, skipping notification`);
        // Still update pinned status even if topic is missing
        this.debouncedUpdatePinnedStatus();
        return;
      }
    }

    // Leaving working — flush any pending event buffer immediately
    if (prevStatus === 'working' && session.status !== 'working') {
      this.flushEventBuffer(session.id);
    }

    // working -> idle
    if (prevStatus === 'working' && session.status === 'idle') {
      if (session.lastMarker?.category === 'question') {
        await this.sendMessage(
          fmt.formatSessionQuestion(name, markerMsg || 'Has a question'),
          { topicId },
        );
      } else {
        await this.sendMessage(
          fmt.formatSessionFinished(name, snippet, markerMsg),
          { topicId, silent: true },
        );
      }
    }

    // any -> waiting (permission prompt)
    if (session.status === 'waiting' && prevStatus !== 'waiting') {
      // Auto-bind in DM mode
      if (!this.forumMode) {
        this.activeSessionId = session.id;
      }

      const tool = session.permissionRequest?.tool;
      const toolInput = session.permissionRequest?.toolInput;

      const keyboard = new InlineKeyboard()
        .text('\u2705 Approve', `yes:${session.id}`)
        .text('\u274C Reject', `no:${session.id}`);

      await this.sendMessage(
        fmt.formatSessionWaiting(name, tool, toolInput),
        { keyboard, topicId },
      );
    }

    // any -> offline (but not on first discovery)
    if (
      session.status === 'offline' &&
      prevStatus !== 'offline' &&
      prevStatus !== undefined
    ) {
      await this.sendMessage(
        fmt.formatSessionOffline(name),
        { topicId, silent: true },
      );
    }

    // Update pinned status in forum mode
    if (this.forumMode) {
      this.debouncedUpdatePinnedStatus();
    }
  }

  // ---- Message sending ----

  /**
   * Send an HTML message to the authorized chat.
   * Handles message splitting for long content.
   * Supports topic routing (forum mode) and silent notifications.
   */
  private async sendMessage(
    html: string,
    options?: { keyboard?: InlineKeyboard; topicId?: number; silent?: boolean },
  ): Promise<import('grammy/types').Message.TextMessage | undefined> {
    try {
      const parts = fmt.splitMessage(html);
      let lastMsg: import('grammy/types').Message.TextMessage | undefined;

      for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        lastMsg = await this.bot.api.sendMessage(this.chatId, parts[i], {
          parse_mode: 'HTML',
          ...(options?.topicId ? { message_thread_id: options.topicId } : {}),
          ...(options?.silent ? { disable_notification: true } : {}),
          ...(isLast && options?.keyboard ? { reply_markup: options.keyboard } : {}),
        });
      }

      return lastMsg;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Telegram] Failed to send message:', message);
      return undefined;
    }
  }

  /** Send a message to the General topic (forum mode) or the DM chat.
   *  General topic = omit message_thread_id (Telegram rejects thread_id=1). */
  private async sendControlMessage(
    html: string,
    keyboard?: InlineKeyboard,
  ): Promise<import('grammy/types').Message.TextMessage | undefined> {
    // General topic: omit topicId — Telegram doesn't accept message_thread_id for General
    return this.sendMessage(html, { keyboard });
  }

  // ---- Pinned status message ----

  /** Update the pinned status message in the General topic.
   *  Uses a lock to prevent concurrent calls from creating duplicate messages. */
  private pinnedStatusLock = false;
  private async updatePinnedStatus(): Promise<void> {
    if (!this.forumMode || !this.topicManager) return;
    if (this.pinnedStatusLock) return; // another call is in progress
    this.pinnedStatusLock = true;

    try {
      const sessions = this.getSessions();
      const html = fmt.formatPinnedStatus(sessions);

      const existingId = this.topicManager.pinnedMessageId;

      // Try to edit existing pinned message
      if (existingId) {
        try {
          await this.bot.api.editMessageText(this.chatId, existingId, html, {
            parse_mode: 'HTML',
          });
          return;
        } catch {
          // Message was deleted or too old — don't recreate (avoids General spam)
          console.warn('[Telegram] Could not edit pinned status message, will recreate on /sessions');
          this.topicManager.pinnedMessageId = undefined;
          return;
        }
      }

      // No existing pinned message — create one (only happens on first startup or after /sessions)
      await this.createPinnedStatus(html);
    } finally {
      this.pinnedStatusLock = false;
    }
  }

  // ---- Event streaming to topics ----

  /**
   * Called by the server for each raw event. Buffers events and flushes
   * them as batched messages every 3 seconds per session topic.
   */
  async onEvent(event: ClaudeEvent, session: ManagedSession): Promise<void> {
    if (!this.forumMode || !this.topicManager) return;

    // Only stream pre_tool_use events (the start of each tool call)
    if (event.type !== 'pre_tool_use') return;

    const line = fmt.formatEventLine(event.tool, event.toolInput);
    if (!line) return;

    // Include assistant text snippet if present (what Claude said before calling the tool)
    const lines: string[] = [];
    if (event.assistantText) {
      const snippet = event.assistantText
        .replace(/<!--rc:\w+:?[^>]*-->/g, '')
        .trim()
        .slice(0, 200);
      if (snippet) {
        lines.push(`<i>${fmt.escapeHtml(snippet)}</i>`);
      }
    }
    lines.push(line);

    // Add to buffer
    const buf = this.eventBuffer.get(session.id) || [];
    buf.push(...lines);
    this.eventBuffer.set(session.id, buf);

    // Schedule flush if not already scheduled
    if (!this.eventFlushTimers.has(session.id)) {
      this.eventFlushTimers.set(session.id, setTimeout(() => {
        this.flushEventBuffer(session.id);
      }, 3000));
    }
  }

  /** Flush the event buffer for a session — send all collected lines as one message. */
  private async flushEventBuffer(sessionId: string): Promise<void> {
    // Clear timer
    const timer = this.eventFlushTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.eventFlushTimers.delete(sessionId);

    // Pop buffer
    const lines = this.eventBuffer.get(sessionId);
    this.eventBuffer.delete(sessionId);
    if (!lines || lines.length === 0) return;

    // Get topic
    const session = this.getSession(sessionId);
    if (!session) return;
    const topicId = this.topicManager?.getTopicId(sessionId);
    if (!topicId) return;

    // Send as one message
    const html = lines.join('\n');
    await this.sendMessage(html, { topicId, silent: true });
  }

  /** Create a new pinned status message in General. */
  private async createPinnedStatus(html: string): Promise<void> {
    const msg = await this.sendMessage(html, { silent: true });
    if (msg) {
      try {
        await this.bot.api.pinChatMessage(this.chatId, msg.message_id, {
          disable_notification: true,
        });
        if (this.topicManager) {
          this.topicManager.pinnedMessageId = msg.message_id;
        }
      } catch (err) {
        console.error('[Telegram] Failed to pin status message:', err);
      }
    }
  }

  /** Debounced version -- avoids flooding Telegram API on rapid status changes. */
  private debouncedUpdatePinnedStatus(): void {
    if (this.pinnedStatusDebounce) {
      clearTimeout(this.pinnedStatusDebounce);
    }
    this.pinnedStatusDebounce = setTimeout(() => {
      this.pinnedStatusDebounce = null;
      this.updatePinnedStatus().catch((err) => {
        console.error('[Telegram] Failed to update pinned status:', err);
      });
    }, 2000); // 2s debounce to batch rapid status changes
  }

  // ---- Lifecycle ----

  /** Start the bot with long-polling. */
  async start(): Promise<void> {
    console.log('[Telegram] Starting bot (long-polling)...');

    // Detect forum mode
    const forumSetting = this.config.forumMode || 'auto';
    if (forumSetting === 'true' || forumSetting === 'auto') {
      try {
        const chat = await this.bot.api.getChat(this.chatId);
        if ('is_forum' in chat && chat.is_forum) {
          this.forumMode = true;
          this.topicManager = new TopicManager(this.chatId, this.bot.api);
          console.log('[Telegram] Forum mode enabled');
        } else if (forumSetting === 'true') {
          console.warn('[Telegram] forumMode=true but chat is not a forum group');
        }
      } catch (err) {
        console.error('[Telegram] Failed to detect forum mode:', err);
      }
    }

    // start() returns immediately and runs in the background
    this.bot.start({
      drop_pending_updates: true,
      onStart: async () => {
        console.log('[Telegram] Bot is running');
        if (this.forumMode) {
          await this.updatePinnedStatus();
          // Send to General topic (omit topicId — Telegram rejects thread_id for General)
          await this.sendMessage('Bot connected.', { silent: true });
        } else {
          await this.sendMessage('Bot connected.');
        }
      },
    });
  }

  /** Stop the bot gracefully. */
  async stop(): Promise<void> {
    console.log('[Telegram] Stopping bot...');
    await this.bot.stop();
    console.log('[Telegram] Bot stopped');
  }
}
