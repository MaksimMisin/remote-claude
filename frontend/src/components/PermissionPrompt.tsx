import { memo } from 'react';
import { basename, truncate } from '../utils/events';

export type PermissionAction = 'yes' | 'allow_all' | 'no';

interface PermissionPromptProps {
  tool: string;
  toolInput: Record<string, unknown>;
  onAction: (action: PermissionAction) => void;
}

/** Render a diff for Edit tool: old lines red, new lines green. */
function EditDetail({ toolInput }: { toolInput: Record<string, unknown> }) {
  const filePath = (toolInput.file_path as string) || '';
  const oldStr = (toolInput.old_string as string) || '';
  const newStr = (toolInput.new_string as string) || '';

  const oldLines = oldStr.split('\n').slice(0, 10);
  const newLines = newStr.split('\n').slice(0, 10);
  const truncated =
    oldStr.split('\n').length > 10 || newStr.split('\n').length > 10;

  return (
    <div className="perm-detail">
      <div className="perm-file">{basename(filePath)}</div>
      <div className="perm-diff">
        {oldLines.map((line, i) => (
          <div key={`d-${i}`} className="diff-del">
            - {line}
          </div>
        ))}
        {newLines.map((line, i) => (
          <div key={`a-${i}`} className="diff-add">
            + {line}
          </div>
        ))}
        {truncated && <div className="diff-trunc">... (truncated)</div>}
      </div>
    </div>
  );
}

/** Render Bash command details. */
function BashDetail({ toolInput }: { toolInput: Record<string, unknown> }) {
  const cmd = truncate(toolInput.command as string, 500);
  const desc = (toolInput.description as string) || '';
  return (
    <div className="perm-detail">
      {desc && <div className="perm-desc">{desc}</div>}
      <pre className="perm-command">$ {cmd}</pre>
    </div>
  );
}

/** Render Write tool details. */
function WriteDetail({ toolInput }: { toolInput: Record<string, unknown> }) {
  const filePath = (toolInput.file_path as string) || '';
  const content = (toolInput.content as string) || '';
  const lines = content.split('\n').length;
  return (
    <div className="perm-detail">
      <div className="perm-file">
        {basename(filePath)} ({lines} lines)
      </div>
    </div>
  );
}

/** Render AskUserQuestion — shows question text, NO action buttons. */
function AskUserDetail({ toolInput }: { toolInput: Record<string, unknown> }) {
  const questions = toolInput.questions as
    | Array<{ question?: string; options?: Array<{ label?: string }> }>
    | undefined;
  if (!questions || questions.length === 0) return null;
  return (
    <div className="perm-detail">
      {questions.map((q, i) => (
        <div key={i}>
          <div className="perm-question">{q.question}</div>
          {q.options && (
            <div className="perm-options">
              {q.options.map((opt, j) => (
                <span key={j} className="perm-option">
                  {opt.label}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Default tool detail — just show the tool name. */
function DefaultDetail({ tool }: { tool: string }) {
  return (
    <div className="perm-detail">
      <div className="perm-tool-name">Wants to use: {tool}</div>
    </div>
  );
}

/** Compact one-line summary for unselected cards. */
export function permissionSummary(
  tool: string,
  toolInput: Record<string, unknown>,
): string {
  if (tool === 'Edit') {
    return 'Approve edit: ' + basename(toolInput.file_path as string);
  }
  if (tool === 'Write') {
    return 'Approve write: ' + basename(toolInput.file_path as string);
  }
  if (tool === 'Bash') {
    const desc = toolInput.description as string;
    const cmd = toolInput.command as string;
    return 'Approve: ' + truncate(desc || cmd, 60);
  }
  if (tool === 'Read') {
    return 'Approve read: ' + basename(toolInput.file_path as string);
  }
  if (tool === 'AskUserQuestion') {
    const questions = toolInput.questions as
      | Array<{ question?: string }>
      | undefined;
    if (questions && questions[0]?.question) {
      return truncate(questions[0].question, 80);
    }
    return 'Asking a question';
  }
  return 'Approve: ' + tool;
}

export const PermissionPrompt = memo(function PermissionPrompt({
  tool,
  toolInput,
  onAction,
}: PermissionPromptProps) {
  const isQuestion = tool === 'AskUserQuestion';

  return (
    <div className="permission-prompt">
      <div className="perm-header">
        {isQuestion ? 'Question' : `Approve ${tool}?`}
      </div>
      <div className="perm-body">
        {tool === 'Edit' && <EditDetail toolInput={toolInput} />}
        {tool === 'Bash' && <BashDetail toolInput={toolInput} />}
        {tool === 'Write' && <WriteDetail toolInput={toolInput} />}
        {tool === 'AskUserQuestion' && <AskUserDetail toolInput={toolInput} />}
        {!['Edit', 'Bash', 'Write', 'AskUserQuestion'].includes(tool) && (
          <DefaultDetail tool={tool} />
        )}
      </div>
      {!isQuestion && (
        <div className="perm-actions">
          <button className="perm-btn perm-btn-yes" onClick={() => onAction('yes')}>
            Yes
          </button>
          <button
            className="perm-btn perm-btn-all"
            onClick={() => onAction('allow_all')}
          >
            Allow All
          </button>
          <button className="perm-btn perm-btn-no" onClick={() => onAction('no')}>
            No
          </button>
        </div>
      )}
    </div>
  );
});
