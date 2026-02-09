// ============================================================
// TelegramBot -- grammY-based Telegram bot for status notifications
// and session control via DM chat with a single authorized user.
// ============================================================

import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { ManagedSession, SessionStatus } from '../shared/types.js';
import * as fmt from './telegram-format.js';

// --- Config interface ---

export interface TelegramBotConfig {
  token: string;
  chatId: string;
  getSessions: () => ManagedSession[];
  getSession: (id: string) => ManagedSession | undefined;
  sendPrompt: (sessionId: string, text: string) => Promise<void>;
  sendKeys: (sessionId: string, keys: string[]) => Promise<void>;
}

// --- TelegramBot class ---

export class TelegramBot {
  private bot: Bot;
  private chatId: string;
  private activeSessionId: string | null = null;
  private getSessions: TelegramBotConfig['getSessions'];
  private getSession: TelegramBotConfig['getSession'];
  private sendPrompt: TelegramBotConfig['sendPrompt'];
  private sendKeys: TelegramBotConfig['sendKeys'];

  constructor(config: TelegramBotConfig) {
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
    // Global error handler — log but don't crash the server
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
      { parse_mode: 'HTML' },
    );
  }

  private async handleSessions(ctx: Context): Promise<void> {
    if (!this.isAuthorized(ctx)) return;

    const sessions = this.getSessions();
    const html = fmt.formatSessionList(sessions);

    // Build inline keyboard with bind buttons for each session
    const keyboard = new InlineKeyboard();
    for (const s of sessions) {
      if (s.status === 'offline') continue;
      const displayName = s.customName || s.name;
      const label = this.activeSessionId === s.id
        ? `\u2714 ${displayName}`
        : displayName;
      keyboard.text(label, `bind:${s.id}`).row();
    }

    await this.sendMessage(html, sessions.length > 0 ? keyboard : undefined);
  }

  private async handleBind(ctx: Context): Promise<void> {
    if (!this.isAuthorized(ctx)) return;

    const text = ctx.message?.text ?? '';
    const arg = text.replace(/^\/bind\s*/i, '').trim();

    if (!arg) {
      if (this.activeSessionId) {
        const session = this.getSession(this.activeSessionId);
        const name = session
          ? (session.customName || session.name)
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
    const name = session.customName || session.name;
    await ctx.reply(`Bound to <b>${fmt.escapeHtml(name)}</b>. Text messages will be sent to this session.`, {
      parse_mode: 'HTML',
    });
  }

  private async handleStatus(ctx: Context): Promise<void> {
    if (!this.isAuthorized(ctx)) return;

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

    const name = session.customName || session.name;
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

    await ctx.reply(
      '<b>Commands</b>\n\n' +
        '/sessions \u2014 List sessions and bind to one\n' +
        '/bind &lt;name&gt; \u2014 Set active session by name or ID\n' +
        '/status \u2014 Show active session details\n' +
        '/help \u2014 This message\n\n' +
        '<b>Usage</b>\n\n' +
        'Text messages are sent as prompts to the active session. ' +
        'Use the inline buttons on permission notifications to approve or reject.',
      { parse_mode: 'HTML' },
    );
  }

  // ---- Text message handler ----

  private async handleTextMessage(ctx: Context): Promise<void> {
    if (!this.isAuthorized(ctx)) return;

    const text = ctx.message?.text;
    if (!text) return;

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
      await ctx.reply(`Session <b>${fmt.escapeHtml(session.customName || session.name)}</b> is offline.`, {
        parse_mode: 'HTML',
      });
      return;
    }

    try {
      await this.sendPrompt(this.activeSessionId, text);
      const name = session.customName || session.name;
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
          const name = session.customName || session.name;
          await ctx.answerCallbackQuery({ text: `Bound to ${name}` });
          break;
        }

        case 'yes': {
          await this.sendKeys(sessionId, ['Enter']);
          await ctx.answerCallbackQuery({ text: 'Approved' });
          // Edit the message to show it was approved
          try {
            await ctx.editMessageReplyMarkup({ reply_markup: undefined });
          } catch { /* message may be too old to edit */ }
          break;
        }

        case 'no': {
          await this.sendKeys(sessionId, ['Escape']);
          await ctx.answerCallbackQuery({ text: 'Rejected' });
          try {
            await ctx.editMessageReplyMarkup({ reply_markup: undefined });
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

    // Name match (case-insensitive partial)
    const byName = sessions.find((s) => {
      const name = (s.customName || s.name).toLowerCase();
      return name.includes(lower);
    });
    if (byName) return byName;

    return undefined;
  }

  // ---- Status change handler (called from index.ts) ----

  /**
   * Called by the server when a session's status changes.
   * Sends appropriate notifications to the authorized Telegram chat.
   */
  async onStatusChange(
    prevStatus: SessionStatus | undefined,
    session: ManagedSession,
  ): Promise<void> {
    const name = session.customName || session.name;
    const markerMsg = session.lastMarker?.message;
    const snippet = session.lastAssistantText
      ?.replace(/<!--rc:\w+:?[^>]*-->/g, '')
      .trim()
      .slice(0, 500);

    // working -> idle
    if (prevStatus === 'working' && session.status === 'idle') {
      if (session.lastMarker?.category === 'question') {
        await this.sendMessage(
          fmt.formatSessionQuestion(name, markerMsg || 'Has a question'),
        );
      } else {
        await this.sendMessage(
          fmt.formatSessionFinished(name, snippet, markerMsg),
        );
      }
    }

    // any -> waiting (permission prompt)
    if (session.status === 'waiting' && prevStatus !== 'waiting') {
      // Auto-bind to this session so the user can reply immediately
      this.activeSessionId = session.id;

      const tool = session.permissionRequest?.tool;
      const toolInput = session.permissionRequest?.toolInput;

      const keyboard = new InlineKeyboard()
        .text('\u2705 Approve', `yes:${session.id}`)
        .text('\u274C Reject', `no:${session.id}`);

      await this.sendMessage(
        fmt.formatSessionWaiting(name, tool, toolInput),
        keyboard,
      );
    }

    // any -> offline (but not on first discovery)
    if (
      session.status === 'offline' &&
      prevStatus !== 'offline' &&
      prevStatus !== undefined
    ) {
      await this.sendMessage(fmt.formatSessionOffline(name));
    }
  }

  // ---- Message sending ----

  /**
   * Send an HTML message to the authorized chat.
   * Handles message splitting for long content.
   * If a keyboard is provided, it is attached to the last message part only.
   */
  private async sendMessage(
    html: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    try {
      const parts = fmt.splitMessage(html);

      for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        await this.bot.api.sendMessage(this.chatId, parts[i], {
          parse_mode: 'HTML',
          ...(isLast && keyboard ? { reply_markup: keyboard } : {}),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Telegram] Failed to send message:', message);
    }
  }

  // ---- Lifecycle ----

  /** Start the bot with long-polling. */
  async start(): Promise<void> {
    console.log('[Telegram] Starting bot (long-polling)...');
    // start() returns immediately and runs in the background
    this.bot.start({
      drop_pending_updates: true,
      onStart: () => {
        console.log('[Telegram] Bot is running');
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
