// ============================================================
// TelegramBot -- grammY-based Telegram bot for status notifications
// and session control. Supports both DM chat (single user) and
// forum-mode (supergroup with topics, one topic per session).
// ============================================================

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import type { ClaudeEvent, ManagedSession, SessionStatus } from '../shared/types.js';
import { TELEGRAM_GENERAL_TOPIC_ID, TELEGRAM_MESSAGE_LIMIT } from '../shared/defaults.js';
import { TopicManager } from './TopicManager.js';
import * as fmt from './telegram-format.js';
import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { DATA_DIR } from '../shared/defaults.js';

const UPLOADS_DIR = join(DATA_DIR, 'uploads');

// --- Config interface ---

export interface TelegramBotConfig {
  token: string;
  chatId: string;
  forumMode?: 'auto' | 'true' | 'false';
  getSessions: () => ManagedSession[];
  getSession: (id: string) => ManagedSession | undefined;
  sendPrompt: (sessionId: string, text: string) => Promise<SessionStatus>;
  sendCancel: (sessionId: string) => Promise<void>;
  sendKeys: (sessionId: string, keys: string[]) => Promise<void>;
  createSession: (name: string, cwd: string, flags?: string) => Promise<ManagedSession>;
  closeSession: (sessionId: string) => Promise<boolean>;
  capturePane: (target: string, lines?: number) => Promise<string>;
  renameSession: (sessionId: string, name: string) => Promise<boolean>;
}

// --- Wizard state for /new interactive flow ---

interface WizardState {
  /** Message ID of the wizard keyboard message (for editing) */
  messageId: number;
  /** Current browse path (null = showing recent dirs) */
  browsePath: string | null;
  /** Thread/topic ID where the wizard was started */
  threadId?: number;
}

// --- TelegramBot class ---

export class TelegramBot {
  private bot: Bot;
  private config: TelegramBotConfig;
  private chatId: string;
  private activeSessionId: string | null = null;
  private forumMode: boolean = false;
  private topicManager: TopicManager | null = null;
  /** Per-session event buffer for batched sending. */
  private eventBuffer = new Map<string, string[]>();
  /** Per-session flush timers for event batches. */
  private eventFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private getSessions: TelegramBotConfig['getSessions'];
  private getSession: TelegramBotConfig['getSession'];
  private sendPrompt: TelegramBotConfig['sendPrompt'];
  private sendCancel: TelegramBotConfig['sendCancel'];
  private sendKeys: TelegramBotConfig['sendKeys'];
  private createSession: TelegramBotConfig['createSession'];
  private capturePane: TelegramBotConfig['capturePane'];
  private renameSession: TelegramBotConfig['renameSession'];
  private wizardState: WizardState | null = null;
  /** Per-session count of messages sent while Claude was working (queue depth estimate). */
  private queueCounters = new Map<string, number>();
  /** Per-session timers for delayed idle notifications (skip transient idle at tool boundaries). */
  private pendingIdleNotifications = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: TelegramBotConfig) {
    this.config = config;
    this.chatId = config.chatId;
    this.getSessions = config.getSessions;
    this.getSession = config.getSession;
    this.sendPrompt = config.sendPrompt;
    this.sendCancel = config.sendCancel;
    this.sendKeys = config.sendKeys;
    this.createSession = config.createSession;
    this.capturePane = config.capturePane;
    this.renameSession = config.renameSession;

    this.bot = new Bot(config.token);

    // Rate limiting: throttler queues to stay under Telegram's 20/min group limit,
    // auto-retry catches any 429s that slip through.
    this.bot.api.config.use(apiThrottler());
    this.bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

    this.registerHandlers();
  }

  // ---- Handler registration ----

  private registerHandlers(): void {
    // Global error handler -- log but don't crash the server
    this.bot.catch((err) => {
      console.error('[Telegram] Bot error:', err.message || err);
    });

    // In forum mode session topics, intercept /commands and forward them
    // as prompts to Claude Code (e.g. /compact, /status, /clear).
    // Without this, grammY's command handlers would eat them.
    // Exception: /close is our own bot command handled below.
    this.bot.use(async (ctx, next) => {
      if (
        this.forumMode && this.topicManager &&
        ctx.message?.text?.startsWith('/') &&
        !ctx.message.text.startsWith('/close') &&
        !ctx.message.text.startsWith('/purge') &&
        !ctx.message.text.startsWith('/stop') &&
        ctx.message.message_thread_id &&
        ctx.message.message_thread_id !== TELEGRAM_GENERAL_TOPIC_ID &&
        this.topicManager.getSessionId(ctx.message.message_thread_id)
      ) {
        await this.handleTextMessage(ctx);
        return;
      }
      await next();
    });

    // Command handlers (only fire in General topic / DM mode after middleware above)
    this.bot.command('start', (ctx) => this.handleStart(ctx));
    this.bot.command('sessions', (ctx) => this.handleSessions(ctx));
    this.bot.command('bind', (ctx) => this.handleBind(ctx));
    this.bot.command('status', (ctx) => this.handleStatus(ctx));
    this.bot.command('new', (ctx) => this.handleNew(ctx));
    this.bot.command('close', (ctx) => this.handleClose(ctx));
    this.bot.command('purge', (ctx) => this.handlePurge(ctx));
    this.bot.command('stop', (ctx) => this.handleStopCommand(ctx));
    this.bot.command('help', (ctx) => this.handleHelp(ctx));

    // Callback query handler (inline keyboard button presses)
    this.bot.on('callback_query:data', (ctx) => this.handleCallbackQuery(ctx));

    // Text message handler (prompt delivery)
    this.bot.on('message:text', (ctx) => this.handleTextMessage(ctx));

    // Photo and document handlers (file upload)
    this.bot.on('message:photo', (ctx) => this.handlePhotoMessage(ctx));
    this.bot.on('message:document', (ctx) => this.handleDocumentMessage(ctx));

    // Forum topic renamed by user in Telegram → rename session locally
    this.bot.on('message:forum_topic_edited', (ctx) => this.handleTopicRenamed(ctx));
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
        '/new \u2014 Create a new session\n' +
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

    // Forum mode: ensure topics exist and update their status emoji
    if (this.forumMode && this.topicManager) {
      const sessions = this.getSessions();
      console.debug(`[Telegram] /sessions: ${sessions.length} sessions, syncing topics...`);
      for (const s of sessions) {
        if (s.status !== 'offline') {
          const displayName = fmt.getDisplayName(s);
          console.debug(`[Telegram] /sessions: ensuring topic for ${s.id} "${displayName}" (${s.status})`);
          await this.topicManager.ensureTopic(s.id, displayName);
          await this.topicManager.updateTopicTitle(s.id, s.status, displayName);
        } else {
          console.debug(`[Telegram] /sessions: skipping offline session ${s.id}`);
        }
      }
      const threadId = ctx.message?.message_thread_id;
      await ctx.reply('Topics updated.', {
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
            if (session.cwd) {
              const dir = session.cwd.replace(/^\/Users\/\w+\//, '~/');
              lines.push(`📁 <code>${fmt.escapeHtml(dir)}</code>`);
            }
            if (session.gitBranch) lines.push(`🌿 <code>${fmt.escapeHtml(session.gitBranch)}</code>${session.gitDirty ? ' (dirty)' : ''}`);
            if (session.totalTokens != null) lines.push(`🔢 ${session.totalTokens.toLocaleString()} tokens`);
            if (session.currentTool) lines.push(`🔧 <code>${fmt.escapeHtml(session.currentTool)}</code>`);
            // Show initial prompt from topic metadata
            const initialPrompt = this.topicManager.getInitialPrompt(sessionId);
            if (initialPrompt) {
              const snippet = initialPrompt.length > 300
                ? initialPrompt.slice(0, 300) + '...'
                : initialPrompt;
              lines.push('', `💬 <i>${fmt.escapeHtml(snippet)}</i>`);
            }
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
        '/new \u2014 Create a new session (interactive)\n' +
        '/new &lt;path&gt; \u2014 Create session at path\n' +
        '/bind &lt;name&gt; \u2014 Set active session by name or ID\n' +
        '/status \u2014 Show active session details\n' +
        '/stop \u2014 Cancel current task (Ctrl+C)\n' +
        '/close \u2014 Close session and delete topic\n' +
        '/purge \u2014 Delete all closed topics\n' +
        '/help \u2014 This message\n\n' +
        '<b>Usage</b>\n\n' +
        (this.forumMode
          ? 'Each session gets its own topic. Send messages in a session topic to deliver prompts. '
          : 'Text messages are sent as prompts to the active session. ') +
        'Messages sent while Claude is working are queued and processed when ready. ' +
        'Prefix with <code>!</code> to interrupt and send immediately.\n\n' +
        'Use the inline buttons on permission notifications to approve or reject.',
      {
        parse_mode: 'HTML',
        ...(threadId ? { message_thread_id: threadId } : {}),
      },
    );
  }

  // ---- /stop command: cancel current task ----

  private async handleStopCommand(ctx: Context): Promise<void> {
    if (!this.isAuthorized(ctx)) return;

    const threadId = ctx.message?.message_thread_id;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};

    // Resolve session (forum: from topic, DM: active session)
    let sessionId: string | null = null;
    if (this.forumMode && this.topicManager && threadId && threadId !== TELEGRAM_GENERAL_TOPIC_ID) {
      sessionId = this.topicManager.getSessionId(threadId) || null;
    } else {
      sessionId = this.activeSessionId;
    }

    if (!sessionId) {
      await ctx.reply('No session to stop.', replyOpts);
      return;
    }

    const session = this.getSession(sessionId);
    if (!session || session.status === 'offline') {
      await ctx.reply('Session is offline.', replyOpts);
      return;
    }

    try {
      // sendCancel sends Escape twice (Claude Code's interrupt key)
      await this.sendCancel(sessionId);
      await ctx.reply('\u23F9 Cancelled.', replyOpts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Failed: ${fmt.escapeHtml(message)}`, { parse_mode: 'HTML', ...replyOpts });
    }
  }

  // ---- /close command: delete topic ----

  private async handleClose(ctx: Context): Promise<void> {
    if (!this.isAuthorized(ctx)) return;

    const threadId = ctx.message?.message_thread_id;

    if (!this.forumMode || !this.topicManager) {
      await ctx.reply('This command only works in forum mode.');
      return;
    }

    if (!threadId || threadId === TELEGRAM_GENERAL_TOPIC_ID) {
      await ctx.reply('Use /close inside a session topic to delete it.', {
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
      return;
    }

    const sessionId = this.topicManager.getSessionId(threadId);
    if (sessionId) {
      // Kill the tmux window and remove the session
      await this.config.closeSession(sessionId);

      // Clean up event buffers for this session
      const timer = this.eventFlushTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        this.eventFlushTimers.delete(sessionId);
      }
      this.eventBuffer.delete(sessionId);

      await this.topicManager.deleteTopic(sessionId);
    } else {
      // Untracked topic — set 🔴, then delete/close it
      await this.topicManager.closeUntrackedTopic(threadId);
    }
  }

  // ---- /purge command: bulk delete closed topics ----

  private async handlePurge(ctx: Context): Promise<void> {
    if (!this.isAuthorized(ctx)) return;

    if (!this.forumMode || !this.topicManager) {
      await ctx.reply('This command only works in forum mode.');
      return;
    }

    const threadId = ctx.message?.message_thread_id;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};

    await ctx.reply('Purging closed topics...', replyOpts);
    await this.topicManager.deleteClosedTopics();
    await ctx.reply('Done. Use /close inside orphaned topics to clean those too.', replyOpts);
  }

  // ---- Forum topic renamed by user ----

  private async handleTopicRenamed(ctx: Context): Promise<void> {
    if (!this.isAuthorized(ctx)) return;
    if (!this.forumMode || !this.topicManager) return;

    // Skip edits made by the bot itself (e.g. status emoji updates from updateTopicTitle).
    // Without this, every bot-initiated topic title change triggers a feedback loop:
    // bot edits topic → Telegram sends forum_topic_edited → bot strips emoji → renames tmux window → emoji gone
    if (ctx.from?.id === ctx.me.id) return;

    const threadId = ctx.message?.message_thread_id;
    const newName = ctx.message?.forum_topic_edited?.name;
    if (!threadId || !newName) return;

    const sessionId = this.topicManager.getSessionId(threadId);
    if (!sessionId) return;

    // Strip status emoji prefix (e.g. "🟢 my-project" → "my-project")
    const cleanName = newName.replace(/^[\p{Emoji}\p{Emoji_Presentation}\uFE0F]+\s*/u, '').trim();
    if (!cleanName) return;

    // Rename session locally (same as web dashboard rename)
    const ok = await this.renameSession(sessionId, cleanName);
    if (ok) {
      // Update TopicManager's stored name so it doesn't fight back
      this.topicManager.updateStoredName(sessionId, cleanName);
      console.log(`[Telegram] Topic rename → session ${sessionId} renamed to "${cleanName}"`);
    }
  }

  // ---- /new command: create session ----

  private async handleNew(ctx: Context): Promise<void> {
    if (!this.isAuthorized(ctx)) return;

    const threadId = ctx.message?.message_thread_id;
    const text = ctx.message?.text ?? '';
    const args = text.replace(/^\/new\s*/i, '').trim();

    if (args) {
      // Quick create mode: /new <path> [--chrome]
      await this.handleNewQuick(ctx, args, threadId);
    } else {
      // Interactive wizard
      await this.startWizard(ctx, threadId);
    }
  }

  /** Quick create: resolve path and create immediately. */
  private async handleNewQuick(ctx: Context, args: string, threadId?: number): Promise<void> {
    const hasChrome = /\s+--chrome\b/.test(args);
    const pathArg = args.replace(/\s+--chrome\b/, '').trim();

    const resolved = this.resolveNewPath(pathArg);
    if (!resolved) {
      await ctx.reply(
        `Could not resolve path: <code>${fmt.escapeHtml(pathArg)}</code>\n\n` +
          'Usage:\n' +
          '<code>/new ~/code/myproject</code>\n' +
          '<code>/new myproject</code> (matches recent dirs)\n' +
          '<code>/new ~/code/myproject --chrome</code>',
        { parse_mode: 'HTML', ...(threadId ? { message_thread_id: threadId } : {}) },
      );
      return;
    }

    const flags = hasChrome ? '--chrome' : undefined;
    await this.createAndNotify(resolved, flags, threadId);
  }

  /** Resolve a path argument to an absolute directory path. */
  private resolveNewPath(pathArg: string): string | null {
    const home = homedir();

    // Absolute path
    if (pathArg.startsWith('/')) {
      return existsSync(pathArg) ? pathArg : null;
    }

    // Tilde expansion
    if (pathArg.startsWith('~/') || pathArg === '~') {
      const expanded = pathArg === '~' ? home : join(home, pathArg.slice(2));
      return existsSync(expanded) ? expanded : null;
    }

    // Try matching against recent session dirs
    const recentDirs = this.getRecentDirs();

    // Exact basename match
    const exactMatch = recentDirs.find((d) => basename(d) === pathArg);
    if (exactMatch) return exactMatch;

    // Partial basename match (case-insensitive)
    const lower = pathArg.toLowerCase();
    const partialMatch = recentDirs.find((d) => basename(d).toLowerCase().includes(lower));
    if (partialMatch) return partialMatch;

    // Try ~/pathArg as a directory
    const asHome = join(home, pathArg);
    if (existsSync(asHome)) return asHome;

    return null;
  }

  /** Get unique recent working directories from sessions. */
  private getRecentDirs(): string[] {
    const cwds = new Set<string>();
    for (const session of this.getSessions()) {
      if (session.cwd) cwds.add(session.cwd);
    }
    return Array.from(cwds);
  }

  /** Start the interactive wizard: show recent dirs as buttons. */
  private async startWizard(ctx: Context, threadId?: number): Promise<void> {
    const recentDirs = this.getRecentDirs();
    const keyboard = this.buildRecentDirsKeyboard(recentDirs);

    const text = recentDirs.length > 0
      ? '<b>Create Session</b>\n\nSelect a directory or browse:'
      : '<b>Create Session</b>\n\nNo recent directories. Browse to select:';

    const msg = await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      ...(threadId ? { message_thread_id: threadId } : {}),
    });

    this.wizardState = {
      messageId: msg.message_id,
      browsePath: null,
      threadId,
    };
  }

  /** Build keyboard with recent dirs: each row has [dirname] [dirname + chrome]. */
  private buildRecentDirsKeyboard(dirs: string[]): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    for (let i = 0; i < dirs.length && i < 8; i++) {
      const name = basename(dirs[i]);
      keyboard
        .text(name, `nw:r:${i}`)
        .text(`${name} + chrome`, `nw:rc:${i}`)
        .row();
    }
    keyboard.text('📂 Browse...', 'nw:browse').text('❌ Cancel', 'nw:cancel').row();
    return keyboard;
  }

  /** Build keyboard for browsing a directory. */
  private buildBrowseKeyboard(dirPath: string): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      const subdirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();

      for (let i = 0; i < subdirs.length && i < 10; i++) {
        keyboard.text(`📁 ${subdirs[i]}`, `nw:s:${i}`).row();
      }
      if (subdirs.length > 10) {
        keyboard.text(`... ${subdirs.length - 10} more`, 'nw:noop').row();
      }
    } catch {
      keyboard.text('⚠️ Cannot read directory', 'nw:noop').row();
    }

    keyboard
      .text('⬆️ Up', 'nw:up')
      .text('✅ Create here', 'nw:here')
      .row()
      .text('✅ + Chrome', 'nw:herec')
      .text('❌ Cancel', 'nw:cancel')
      .row();

    return keyboard;
  }

  /** Build a t.me link to a forum topic in this chat. */
  private topicLink(topicId: number): string {
    // Private group chat IDs look like -100XXXXXXXXXX; strip -100 prefix for the t.me/c/ URL
    const internalId = this.chatId.replace(/^-100/, '');
    return `https://t.me/c/${internalId}/${topicId}`;
  }

  /** Create a session and send confirmation. */
  private async createAndNotify(cwd: string, flags?: string, threadId?: number): Promise<void> {
    const name = basename(cwd);
    try {
      const session = await this.createSession(name, cwd, flags);
      const displayName = fmt.getDisplayName(session);
      const chromeNote = flags?.includes('--chrome') ? ' (with Chrome)' : '';

      // In forum mode, eagerly create the topic so we can link to it
      let topicLink = '';
      if (this.forumMode && this.topicManager) {
        const topicId = await this.topicManager.ensureTopic(session.id, displayName);
        if (topicId) {
          topicLink = `\n<a href="${this.topicLink(topicId)}">Open topic</a>`;
        }
      }

      await this.bot.api.sendMessage(
        this.chatId,
        `✅ Created <b>${fmt.escapeHtml(displayName)}</b>${chromeNote}\n` +
          `📁 <code>${fmt.escapeHtml(cwd)}</code>${topicLink}`,
        {
          parse_mode: 'HTML',
          ...(threadId ? { message_thread_id: threadId } : {}),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Telegram] Failed to create session:', message);
      await this.bot.api.sendMessage(
        this.chatId,
        `❌ Failed to create session: ${fmt.escapeHtml(message)}`,
        {
          parse_mode: 'HTML',
          ...(threadId ? { message_thread_id: threadId } : {}),
        },
      );
    }
  }

  /** Edit the wizard message, or send a new one if editing fails. */
  private async editWizardMessage(text: string, keyboard: InlineKeyboard): Promise<void> {
    if (!this.wizardState) return;
    try {
      await this.bot.api.editMessageText(
        this.chatId,
        this.wizardState.messageId,
        text,
        { parse_mode: 'HTML', reply_markup: keyboard },
      );
    } catch {
      // Message may be too old to edit — send a new one
      const msg = await this.bot.api.sendMessage(this.chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        ...(this.wizardState.threadId ? { message_thread_id: this.wizardState.threadId } : {}),
      });
      this.wizardState.messageId = msg.message_id;
    }
  }

  /** Handle all wizard callback queries (nw: prefix). */
  private async handleWizardCallback(ctx: Context, data: string): Promise<void> {
    const parts = data.split(':');
    const action = parts[1]; // r, rc, browse, s, up, here, herec, cancel
    const index = parts[2] ? parseInt(parts[2], 10) : 0;

    try {
      switch (action) {
        case 'r':
        case 'rc': {
          // Create from recent dir
          const recentDirs = this.getRecentDirs();
          if (index >= recentDirs.length) {
            await ctx.answerCallbackQuery({ text: 'Directory no longer available' });
            return;
          }
          const dir = recentDirs[index];
          const flags = action === 'rc' ? '--chrome' : undefined;
          const threadId = this.wizardState?.threadId;
          await ctx.answerCallbackQuery({ text: `Creating in ${basename(dir)}...` });
          this.wizardState = null;
          // Remove the wizard keyboard
          try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* ok */ }
          await this.createAndNotify(dir, flags, threadId);
          break;
        }

        case 'browse': {
          // Switch to browse view starting from home
          const browsePath = homedir();
          if (this.wizardState) {
            this.wizardState.browsePath = browsePath;
          } else {
            // Wizard state lost — create new
            this.wizardState = {
              messageId: ctx.callbackQuery!.message!.message_id,
              browsePath,
            };
          }
          const keyboard = this.buildBrowseKeyboard(browsePath);
          await this.editWizardMessage(
            `<b>Create Session</b>\n\n📂 <code>${fmt.escapeHtml(browsePath)}</code>`,
            keyboard,
          );
          await ctx.answerCallbackQuery();
          break;
        }

        case 's': {
          // Drill into subdirectory
          if (!this.wizardState?.browsePath) {
            await ctx.answerCallbackQuery({ text: 'No browse path' });
            return;
          }
          try {
            const entries = readdirSync(this.wizardState.browsePath, { withFileTypes: true });
            const subdirs = entries
              .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
              .map((e) => e.name)
              .sort();
            if (index >= subdirs.length) {
              await ctx.answerCallbackQuery({ text: 'Directory not found' });
              return;
            }
            const newPath = join(this.wizardState.browsePath, subdirs[index]);
            this.wizardState.browsePath = newPath;
            const keyboard = this.buildBrowseKeyboard(newPath);
            await this.editWizardMessage(
              `<b>Create Session</b>\n\n📂 <code>${fmt.escapeHtml(newPath)}</code>`,
              keyboard,
            );
          } catch {
            await ctx.answerCallbackQuery({ text: 'Cannot read directory' });
            return;
          }
          await ctx.answerCallbackQuery();
          break;
        }

        case 'up': {
          // Go up one level
          if (!this.wizardState?.browsePath) {
            await ctx.answerCallbackQuery({ text: 'No browse path' });
            return;
          }
          const parent = resolve(this.wizardState.browsePath, '..');
          if (parent === this.wizardState.browsePath) {
            await ctx.answerCallbackQuery({ text: 'Already at root' });
            return;
          }
          this.wizardState.browsePath = parent;
          const keyboard = this.buildBrowseKeyboard(parent);
          await this.editWizardMessage(
            `<b>Create Session</b>\n\n📂 <code>${fmt.escapeHtml(parent)}</code>`,
            keyboard,
          );
          await ctx.answerCallbackQuery();
          break;
        }

        case 'here':
        case 'herec': {
          // Create at current browse path
          if (!this.wizardState?.browsePath) {
            await ctx.answerCallbackQuery({ text: 'No directory selected' });
            return;
          }
          const dir = this.wizardState.browsePath;
          const flags = action === 'herec' ? '--chrome' : undefined;
          const threadId = this.wizardState.threadId;
          await ctx.answerCallbackQuery({ text: `Creating in ${basename(dir)}...` });
          this.wizardState = null;
          try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* ok */ }
          await this.createAndNotify(dir, flags, threadId);
          break;
        }

        case 'cancel': {
          this.wizardState = null;
          await ctx.answerCallbackQuery({ text: 'Cancelled' });
          try { await ctx.editMessageText('Cancelled.'); } catch { /* ok */ }
          break;
        }

        case 'noop': {
          await ctx.answerCallbackQuery();
          break;
        }

        default:
          await ctx.answerCallbackQuery({ text: 'Unknown action' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Telegram] Wizard callback error:', message);
      await ctx.answerCallbackQuery({ text: 'Error: ' + message.slice(0, 100) });
    }
  }

  // ---- Session resolution from context ----

  /**
   * Resolve the target session from a message context.
   * Handles both forum mode (topic routing) and DM mode (activeSessionId).
   * Returns null (and replies with error) if no valid session found.
   */
  private async resolveSessionFromCtx(
    ctx: Context,
  ): Promise<{ sessionId: string; session: ManagedSession; threadId?: number } | null> {
    if (this.forumMode && this.topicManager) {
      const threadId = ctx.message?.message_thread_id;

      if (!threadId || threadId === TELEGRAM_GENERAL_TOPIC_ID) {
        await ctx.reply('Send messages in a session topic to deliver prompts.');
        return null;
      }

      const sessionId = this.topicManager.getSessionId(threadId);
      if (!sessionId) {
        // Orphaned topic — offer a close button for easy cleanup
        const keyboard = new InlineKeyboard()
          .text('\uD83D\uDDD1 Close this topic', `closetopic:${threadId}`);
        await ctx.reply('Orphaned topic \u2014 no linked session.', {
          message_thread_id: threadId,
          reply_markup: keyboard,
        });
        return null;
      }

      const session = this.getSession(sessionId);
      if (!session) {
        await ctx.reply('Session no longer exists.', { message_thread_id: threadId });
        return null;
      }

      if (session.status === 'offline') {
        await ctx.reply('Session is offline.', { message_thread_id: threadId });
        return null;
      }

      return { sessionId, session, threadId };
    }

    // DM mode
    if (!this.activeSessionId) {
      await ctx.reply('No active session. Use /sessions to bind one.');
      return null;
    }

    const session = this.getSession(this.activeSessionId);
    if (!session) {
      this.activeSessionId = null;
      await ctx.reply('Active session no longer exists. Use /sessions to bind one.');
      return null;
    }

    if (session.status === 'offline') {
      await ctx.reply(`Session <b>${fmt.escapeHtml(fmt.getDisplayName(session))}</b> is offline.`, {
        parse_mode: 'HTML',
      });
      return null;
    }

    return { sessionId: this.activeSessionId, session };
  }

  // ---- File download helper ----

  /**
   * Download a file from Telegram and save it to the uploads directory.
   * Returns the local file path, or null on failure.
   */
  private async downloadTelegramFile(
    fileId: string,
    originalName?: string,
    mimeType?: string,
  ): Promise<string | null> {
    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        console.error('[Telegram] getFile returned no file_path');
        return null;
      }

      const url = `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        console.error(`[Telegram] File download failed: ${resp.status}`);
        return null;
      }

      // Determine extension from original name, mime type, or telegram path
      let ext = '';
      if (originalName) {
        const dotIdx = originalName.lastIndexOf('.');
        if (dotIdx !== -1) ext = originalName.slice(dotIdx);
      }
      if (!ext && mimeType) {
        const map: Record<string, string> = {
          'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
          'image/webp': '.webp', 'application/pdf': '.pdf',
        };
        ext = map[mimeType] || '';
      }
      if (!ext && file.file_path) {
        const dotIdx = file.file_path.lastIndexOf('.');
        if (dotIdx !== -1) ext = file.file_path.slice(dotIdx);
      }

      if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

      const filename = `${Date.now()}-${randomBytes(4).toString('hex')}${ext}`;
      const filepath = join(UPLOADS_DIR, filename);
      const buffer = Buffer.from(await resp.arrayBuffer());
      writeFileSync(filepath, buffer);
      console.log(`[Telegram] Saved upload ${filepath} (${buffer.length} bytes)`);
      return filepath;
    } catch (err) {
      console.error('[Telegram] File download error:', err);
      return null;
    }
  }

  // ---- Photo and document handlers ----

  private async handlePhotoMessage(ctx: Context): Promise<void> {
    if (!this.isAuthorized(ctx)) return;

    const resolved = await this.resolveSessionFromCtx(ctx);
    if (!resolved) return;
    const { sessionId, session, threadId } = resolved;

    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) return;

    // Telegram sends multiple sizes; last element is the largest
    const largest = photos[photos.length - 1];
    const filepath = await this.downloadTelegramFile(largest.file_id, undefined, 'image/jpeg');
    if (!filepath) {
      await ctx.reply('Failed to download photo.', {
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
      return;
    }

    const caption = ctx.message?.caption || '';
    const promptText = `[User uploaded image: ${filepath}]\n${caption}`.trim();

    try {
      await this.sendPrompt(sessionId, promptText);
      const name = fmt.getDisplayName(session);
      const reply = this.forumMode
        ? '→ photo sent'
        : `→ photo sent to <b>${fmt.escapeHtml(name)}</b>`;
      await ctx.reply(reply, {
        parse_mode: 'HTML',
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Failed: ${fmt.escapeHtml(message)}`, {
        parse_mode: 'HTML',
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
    }
  }

  private async handleDocumentMessage(ctx: Context): Promise<void> {
    if (!this.isAuthorized(ctx)) return;

    const resolved = await this.resolveSessionFromCtx(ctx);
    if (!resolved) return;
    const { sessionId, session, threadId } = resolved;

    const doc = ctx.message?.document;
    if (!doc) return;

    const filepath = await this.downloadTelegramFile(doc.file_id, doc.file_name, doc.mime_type);
    if (!filepath) {
      await ctx.reply('Failed to download file.', {
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
      return;
    }

    const isImage = doc.mime_type?.startsWith('image/');
    const tag = isImage ? 'User uploaded image' : 'User uploaded file';
    const caption = ctx.message?.caption || '';
    const promptText = `[${tag}: ${filepath}]\n${caption}`.trim();

    try {
      await this.sendPrompt(sessionId, promptText);
      const name = fmt.getDisplayName(session);
      const displayName = doc.file_name || 'file';
      const reply = this.forumMode
        ? `→ ${fmt.escapeHtml(displayName)} sent`
        : `→ ${fmt.escapeHtml(displayName)} sent to <b>${fmt.escapeHtml(name)}</b>`;
      await ctx.reply(reply, {
        parse_mode: 'HTML',
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Failed: ${fmt.escapeHtml(message)}`, {
        parse_mode: 'HTML',
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
    }
  }

  // ---- Text message handler ----

  private async handleTextMessage(ctx: Context): Promise<void> {
    if (!this.isAuthorized(ctx)) return;
    let text = ctx.message?.text;
    if (!text) return;

    // Strip @botname suffix from /commands (Telegram appends it in groups)
    if (text.startsWith('/')) {
      text = text.replace(/^(\/\w+)@\w+/, '$1');
    }

    const resolved = await this.resolveSessionFromCtx(ctx);
    if (!resolved) return;
    const { sessionId, session, threadId } = resolved;
    const replyOpts = { parse_mode: 'HTML' as const, ...(threadId ? { message_thread_id: threadId } : {}) };

    // ! prefix = interrupt then send immediately
    const isInterrupt = text.startsWith('!') && text.length > 1;
    if (isInterrupt) {
      text = text.slice(1).trimStart();
      try {
        // sendCancel sends Escape twice (Claude Code's interrupt key)
        await this.sendCancel(sessionId);
        // Brief pause for Claude Code to process the interrupt
        await new Promise(r => setTimeout(r, 500));
      } catch {
        // Best-effort — continue sending regardless
      }
    }

    const isSlashCmd = text.startsWith('/');
    const tmuxTarget = session.tmuxTarget;

    // Slash commands that open interactive TUI dialogs (need Escape to dismiss)
    const INTERACTIVE_SLASH_CMDS = new Set(['/usage', '/status', '/config', '/settings']);
    const cmdName = text.split(/\s/)[0].toLowerCase();
    const isInteractiveSlash = isSlashCmd && INTERACTIVE_SLASH_CMDS.has(cmdName);

    // Capture pane before for slash command output diffing
    let paneBefore = '';
    if (isSlashCmd && tmuxTarget) {
      try { paneBefore = await this.capturePane(tmuxTarget); } catch { /* ok */ }
    }

    try {
      const sendStatus = await this.sendPrompt(sessionId, text);
      const name = fmt.getDisplayName(session);

      // Status-aware feedback — only confirm interrupts and queued messages.
      // Normal "→ sent" is dropped to save API budget (user just sent it, they know).
      if (isInterrupt) {
        this.queueCounters.delete(sessionId);
        const reply = this.forumMode
          ? '\u26A1 interrupted \u2192 sent'
          : `\u26A1 interrupted \u2192 sent to <b>${fmt.escapeHtml(name)}</b>`;
        await ctx.reply(reply, replyOpts);
      } else if (sendStatus === 'working') {
        const pos = (this.queueCounters.get(sessionId) || 0) + 1;
        this.queueCounters.set(sessionId, pos);
        const posLabel = pos > 1 ? ` #${pos}` : '';
        const reply = this.forumMode
          ? `\u23F3 queued${posLabel} (Claude is working)`
          : `\u23F3 queued${posLabel} for <b>${fmt.escapeHtml(name)}</b>`;
        await ctx.reply(reply, replyOpts);
      } else {
        this.queueCounters.delete(sessionId);
      }

      // For slash commands: capture pane output after a delay and send it back
      if (isSlashCmd && tmuxTarget) {
        setTimeout(async () => {
          try {
            const paneAfter = await this.capturePane(tmuxTarget);
            const strip = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
            const beforeLines = strip(paneBefore).split('\n');
            const afterLines = strip(paneAfter).split('\n');

            let commonPrefix = 0;
            while (commonPrefix < beforeLines.length && commonPrefix < afterLines.length
              && beforeLines[commonPrefix] === afterLines[commonPrefix]) {
              commonPrefix++;
            }
            const newLines = afterLines.slice(commonPrefix)
              .filter(l => l.trim() !== '')
              .join('\n').trim();

            if (newLines) {
              const snippet = newLines.length > 3500 ? newLines.slice(0, 3500) + '\n[... truncated]' : newLines;
              const topicId = this.forumMode && this.topicManager
                ? this.topicManager.getTopicId(sessionId)
                : undefined;
              await this.sendMessage(
                `<pre>${fmt.escapeHtml(snippet)}</pre>`,
                { topicId: topicId ?? undefined, silent: true },
              );
            }

            // Auto-dismiss interactive TUI dialogs (e.g. /usage, /status, /config)
            if (isInteractiveSlash) {
              await this.sendKeys(sessionId, ['Escape']);
            }
          } catch (err) {
            console.error('[Telegram] Failed to capture slash command output:', err);
          }
        }, 1500);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Failed: ${fmt.escapeHtml(message)}`, replyOpts);
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

    // Wizard callbacks (nw: prefix)
    if (data.startsWith('nw:')) {
      await this.handleWizardCallback(ctx, data);
      return;
    }

    const [action, actionArg] = data.split(':');
    if (!actionArg) {
      await ctx.answerCallbackQuery({ text: 'Invalid action' });
      return;
    }

    try {
      // Handle orphaned topic close button
      if (action === 'closetopic' && this.topicManager) {
        const topicId = parseInt(actionArg, 10);
        await ctx.answerCallbackQuery({ text: 'Closing...' });
        await this.topicManager.closeUntrackedTopic(topicId);
        try { await ctx.editMessageText('Topic closed.'); } catch { /* ok */ }
        return;
      }

      const sessionId = actionArg;

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

        case 'yesall': {
          await this.sendKeys(sessionId, ['BTab']);
          await ctx.answerCallbackQuery({ text: 'Approved all for session' });
          try {
            const session = this.getSession(sessionId);
            const name = session ? fmt.getDisplayName(session) : sessionId;
            const tool = session?.permissionRequest?.tool;
            await ctx.editMessageText(
              fmt.formatPermissionResolved(name, 'approved-all', tool),
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

  // ---- Display name change handler (called from index.ts) ----

  /**
   * Called when a session's display name changes (e.g. tmux window renamed by hook).
   * Updates the Telegram topic title to reflect the new name.
   */
  async onDisplayNameChange(session: ManagedSession): Promise<void> {
    if (!this.forumMode || !this.topicManager) return;
    const displayName = fmt.getDisplayName(session);
    const topicId = this.topicManager.getTopicId(session.id);
    console.debug(`[Telegram] onDisplayNameChange: session ${session.id} name="${displayName}" topicId=${topicId}`);
    if (!topicId) return;
    await this.topicManager.updateTopicTitle(session.id, session.status, displayName);
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
    console.debug(`[Telegram] onStatusChange: session ${session.id} "${fmt.getDisplayName(session)}" ${prevStatus} → ${session.status} (forumMode=${this.forumMode}, hasTM=${!!this.topicManager})`);
    const name = fmt.getDisplayName(session);
    const markerMsg = session.lastMarker?.message;
    const snippet = session.lastAssistantText
      ?.replace(/<!--rc:\w+:?[^>]*-->/g, '')
      .trim()
      .slice(0, 3500);

    // Cancel any pending idle notification if session is no longer idle
    // (e.g., went back to working before the 3s delay expired).
    // Don't cancel if still idle — health checks / meta updates re-trigger
    // onStatusChange with idle→idle and would silently eat the notification.
    const pendingIdle = this.pendingIdleNotifications.get(session.id);
    if (pendingIdle && session.status !== 'idle') {
      clearTimeout(pendingIdle);
      this.pendingIdleNotifications.delete(session.id);
    }

    // Reset queue counter when session stops working
    if (prevStatus === 'working' && session.status !== 'working') {
      this.queueCounters.delete(session.id);
    }

    // any -> offline (but not on first discovery): close the topic (preserves mapping).
    // Handle BEFORE ensureTopic to avoid creating/reopening a topic just to close it.
    if (
      session.status === 'offline' &&
      prevStatus !== 'offline' &&
      prevStatus !== undefined
    ) {
      console.debug(`[Telegram] ${prevStatus} → offline for session ${session.id}, closing topic`);
      if (prevStatus === 'working') {
        this.flushEventBuffer(session.id);
      }
      if (this.forumMode && this.topicManager) {
        await this.topicManager.closeTopic(session.id);
      } else {
        await this.sendMessage(fmt.formatSessionOffline(name), { silent: true });
      }
      return;
    }

    // In forum mode, get/create the session's topic
    // If topic creation fails, skip notification — never fall through to General
    let topicId: number | undefined;
    if (this.forumMode && this.topicManager) {
      console.debug(`[Telegram] Ensuring topic for session ${session.id} "${name}" (status=${session.status})`);
      topicId = await this.topicManager.ensureTopic(session.id, name);
      if (!topicId) {
        console.warn(`[Telegram] No topic for session ${session.id}, skipping notification`);
        return;
      }
      console.debug(`[Telegram] Got topic ${topicId} for session ${session.id}, updating title`);
      // Update topic title with status emoji
      await this.topicManager.updateTopicTitle(session.id, session.status, name);
    }

    // Leaving working — flush any pending event buffer immediately
    if (prevStatus === 'working' && session.status !== 'working') {
      this.flushEventBuffer(session.id);
    }

    // working -> idle: delay notification by 3s to skip transient idle at tool boundaries.
    // If session goes back to working within 3s, the timer is cancelled (see top of method).
    if (prevStatus === 'working' && session.status === 'idle') {
      console.debug(`[Telegram] Scheduling 3s delayed idle notification for session ${session.id} (marker=${session.lastMarker?.category})`);
      const capturedMarkerCategory = session.lastMarker?.category;
      const idleTimer = setTimeout(async () => {
        this.pendingIdleNotifications.delete(session.id);
        // Verify session is still idle (may have changed during the delay)
        const currentSession = this.getSession(session.id);
        if (!currentSession || currentSession.status !== 'idle') return;

        if (capturedMarkerCategory === 'question') {
          await this.sendMessage(
            fmt.formatSessionQuestion(name, markerMsg || 'Has a question'),
            { topicId },
          );
        } else {
          await this.sendMessage(
            fmt.formatSessionFinished(name, snippet, markerMsg),
            { topicId },
          );
        }
      }, 3000);
      this.pendingIdleNotifications.set(session.id, idleTimer);
    }

    // any -> waiting (permission prompt)
    if (session.status === 'waiting' && prevStatus !== 'waiting') {
      console.debug(`[Telegram] ${prevStatus} → waiting for session ${session.id}, sending permission notification (topic=${topicId})`);
      // Auto-bind in DM mode
      if (!this.forumMode) {
        this.activeSessionId = session.id;
      }

      const tool = session.permissionRequest?.tool;
      const toolInput = session.permissionRequest?.toolInput;

      const keyboard = new InlineKeyboard()
        .text('\u2705 Approve', `yes:${session.id}`)
        .text('\u2705 All', `yesall:${session.id}`)
        .text('\u274C Reject', `no:${session.id}`);

      await this.sendMessage(
        fmt.formatSessionWaiting(name, tool, toolInput),
        { keyboard, topicId },
      );
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

  // ---- Session removal handler ----

  /**
   * Called by the server when a session is removed/dismissed/closed.
   * Closes the topic and posts a brief summary to General.
   */
  async onSessionRemoved(sessionId: string, session?: ManagedSession): Promise<void> {
    console.debug(`[Telegram] onSessionRemoved: session ${sessionId} (forumMode=${this.forumMode})`);
    if (!this.forumMode || !this.topicManager) return;

    const topicId = this.topicManager.getTopicId(sessionId);
    console.debug(`[Telegram] onSessionRemoved: session ${sessionId} has topicId=${topicId}`);
    if (!topicId) return;

    // Delete the topic entirely
    await this.topicManager.deleteTopic(sessionId);
  }

  /**
   * Sync Telegram topics with active sessions. Closes topics for sessions
   * that no longer exist. Should be called after the first health check
   * has determined which sessions are alive.
   */
  async syncTopics(): Promise<void> {
    if (!this.forumMode || !this.topicManager) return;

    const allSessions = this.getSessions();
    const activeIds = new Set(
      allSessions
        .filter(s => s.status !== 'offline')
        .map(s => s.id),
    );
    console.debug(`[Telegram] syncTopics: ${allSessions.length} total sessions, ${activeIds.size} active: [${Array.from(activeIds).join(', ')}]`);
    console.debug(`[Telegram] syncTopics: all sessions: ${allSessions.map(s => `${s.id}(${s.status})`).join(', ')}`);
    await this.topicManager.closeStaleTopics(activeIds);
    // Fix emoji on topics that were closed before the emoji-on-close fix existed
    await this.topicManager.fixClosedEmojis();
  }

  /**
   * Called when a session is replaced on the same pane (e.g., /clear,
   * clean-context plan restart).  Transfers the old session's topic to the
   * new session so all events stay in the same Telegram topic.
   */
  async onSessionReplaced(oldSessionId: string, newSessionId: string, session: ManagedSession): Promise<void> {
    console.debug(`[Telegram] onSessionReplaced: ${oldSessionId} → ${newSessionId} "${fmt.getDisplayName(session)}" (forumMode=${this.forumMode})`);
    if (!this.forumMode || !this.topicManager) return;

    const entry = this.topicManager.transferTopic(oldSessionId, newSessionId);
    if (entry) {
      // Reopen the topic if it was closed (e.g. session_end timer raced)
      if (entry.closed) {
        try {
          await this.topicManager.reopenTopic(newSessionId);
        } catch (err) {
          console.warn(`[Telegram] Failed to reopen transferred topic:`, (err as Error).message);
        }
      }
      // Flush any pending event buffer under the old session ID
      const oldBuf = this.eventBuffer.get(oldSessionId);
      if (oldBuf && oldBuf.length > 0) {
        const newBuf = this.eventBuffer.get(newSessionId) || [];
        newBuf.push(...oldBuf);
        this.eventBuffer.set(newSessionId, newBuf);
        this.eventBuffer.delete(oldSessionId);
      }
      // Transfer flush timer
      const oldTimer = this.eventFlushTimers.get(oldSessionId);
      if (oldTimer) {
        clearTimeout(oldTimer);
        this.eventFlushTimers.delete(oldSessionId);
      }
      // Update topic title with new session info
      const name = fmt.getDisplayName(session);
      await this.topicManager.updateTopicTitle(newSessionId, session.status, name);
    }
  }

  // ---- Event streaming to topics ----

  /**
   * Called by the server for each raw event. Buffers events and flushes
   * them as batched messages every 3 seconds per session topic.
   */
  async onEvent(event: ClaudeEvent, session: ManagedSession): Promise<void> {
    // Only stream in forum mode (topics give per-session context)
    if (!this.forumMode || !this.topicManager) return;
    console.debug(`[Telegram] onEvent: ${event.type} for session ${session.id} (topic=${this.topicManager.getTopicId(session.id) ?? 'none'})`);

    let line: string | undefined;

    if (event.type === 'pre_tool_use' && event.tool) {
      // Tool activity — matches web dashboard event feed
      line = fmt.formatEventLine(event.tool, event.toolInput);
      // Include Claude's reasoning as context (like web dashboard's grey text)
      if (event.assistantText) {
        const cleaned = event.assistantText.replace(/<!--rc:\w+:?[^>]*-->/g, '').trim();
        if (cleaned) {
          const snippet = cleaned.length > 300 ? cleaned.slice(0, 300) + '...' : cleaned;
          line += `\n   <i>${fmt.escapeHtml(snippet)}</i>`;
        }
      }
    } else if (event.type === 'stop' && event.assistantText) {
      // Claude's response — skip silent markers
      if (event.marker?.category === 'silent') return;
      const cleaned = event.assistantText.replace(/<!--rc:\w+:?[^>]*-->/g, '').trim();
      if (cleaned) {
        const desc = event.marker?.message || 'Response';
        // Show marker as title, full text as expandable content
        if (cleaned.length > 100) {
          // Long content (plans, detailed responses): compute budget from Telegram limit,
          // flush pending buffer, and send as standalone message to avoid blockquote splitting
          const titleHtml = `✅ <b>${fmt.escapeHtml(desc)}</b>`;
          // Budget: message limit minus timestamp (~30), title, blockquote tags (~40), margin
          const overhead = 30 + titleHtml.length + 40 + 100;
          const budget = TELEGRAM_MESSAGE_LIMIT - overhead;
          const escaped = fmt.escapeHtml(cleaned);
          const snippet = escaped.length > budget
            ? escaped.slice(0, budget) + '\n[... truncated]'
            : escaped;
          const stopLine = `<code>${new Date(event.timestamp).toLocaleTimeString('en-US', {
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
          })}</code> ${titleHtml}\n<blockquote expandable>${snippet}</blockquote>`;

          // Flush any pending tool events first, then send stop as its own message
          await this.flushEventBuffer(session.id);
          const topicId = this.topicManager?.getTopicId(session.id);
          if (topicId) {
            await this.sendMessage(stopLine, { topicId, silent: true });
          }
          return; // Already sent — skip buffer
        } else {
          line = `✅ ${fmt.escapeHtml(cleaned)}`;
        }
      }
    } else if (event.type === 'user_prompt_submit' && event.assistantText) {
      // Store initial prompt for /status display (only captures the first one per topic)
      this.topicManager.setInitialPrompt(session.id, event.assistantText.trim());
      // User prompt — show what was sent
      const text = event.assistantText.trim();
      if (text) {
        const snippet = text.length > 200 ? text.slice(0, 200) + '...' : text;
        line = `💬 <i>${fmt.escapeHtml(snippet)}</i>`;
      }
    }

    if (!line) return;

    // Add timestamp prefix
    const time = new Date(event.timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    line = `<code>${time}</code> ${line}`;

    // Buffer per session
    const buf = this.eventBuffer.get(session.id) || [];
    buf.push(line);
    this.eventBuffer.set(session.id, buf);

    // Schedule 10-second batch flush with per-session random stagger (0-3s)
    // to prevent all sessions from flushing at the same instant.
    if (!this.eventFlushTimers.has(session.id)) {
      const stagger = Math.random() * 3000;
      this.eventFlushTimers.set(session.id, setTimeout(() => {
        this.flushEventBuffer(session.id);
      }, 10000 + stagger));
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
    if (!lines || lines.length === 0) {
      console.debug(`[Telegram] flushEventBuffer: empty buffer for session ${sessionId}`);
      return;
    }

    // Get topic
    const session = this.getSession(sessionId);
    if (!session) {
      console.debug(`[Telegram] flushEventBuffer: session ${sessionId} not found, dropping ${lines.length} lines`);
      return;
    }
    const topicId = this.topicManager?.getTopicId(sessionId);
    if (!topicId) {
      console.debug(`[Telegram] flushEventBuffer: no topic for session ${sessionId}, dropping ${lines.length} lines`);
      return;
    }

    console.debug(`[Telegram] flushEventBuffer: sending ${lines.length} lines to topic ${topicId} for session ${sessionId}`);
    // Send as one message
    const html = lines.join('\n');
    await this.sendMessage(html, { topicId, silent: true });
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
        await this.sendMessage('Bot connected.', { silent: true });
      },
    });
  }

  /** Stop the bot gracefully. */
  async stop(): Promise<void> {
    console.log('[Telegram] Stopping bot...');
    try {
      await this.sendMessage('Bot disconnected.', { silent: true });
    } catch { /* best-effort */ }
    await this.bot.stop();
    console.log('[Telegram] Bot stopped');
  }
}
