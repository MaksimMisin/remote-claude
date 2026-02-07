import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type React from 'react';
import type { ManagedSession } from '../types';

interface CreateSessionModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, cwd: string, flags?: string) => void;
  sessions: Record<string, ManagedSession>;
}

function basenameFromPath(path: string): string {
  if (!path) return '';
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || '';
}

export function CreateSessionModal({
  open,
  onClose,
  onCreate,
  sessions,
}: CreateSessionModalProps): React.ReactElement | null {
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [flags, setFlags] = useState('');
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [duplicateFrom, setDuplicateFrom] = useState('');
  const [dirSuggestions, setDirSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cwdInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Collect recent directories from existing sessions
  const recentDirs = useMemo(() => {
    const dirs = new Set<string>();
    Object.values(sessions).forEach((s) => {
      if (s.cwd) dirs.add(s.cwd);
    });
    return Array.from(dirs);
  }, [sessions]);

  // Session list for "duplicate from" dropdown
  const sessionList = useMemo(() => Object.values(sessions), [sessions]);

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      setName('');
      setCwd('');
      setFlags('');
      setSkipPermissions(false);
      setDuplicateFrom('');
      setDirSuggestions([]);
      setShowSuggestions(false);
      setNameManuallyEdited(false);
    }
  }, [open]);

  // Auto-generate name from directory
  useEffect(() => {
    if (!nameManuallyEdited && cwd) {
      setName(basenameFromPath(cwd));
    }
  }, [cwd, nameManuallyEdited]);

  // Debounced directory autocomplete
  const fetchDirectories = useCallback((prefix: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!prefix) {
      setDirSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          '/api/directories?prefix=' + encodeURIComponent(prefix),
        );
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data)) {
          setDirSuggestions(data);
          setShowSuggestions(data.length > 0);
        } else if (data && Array.isArray(data.directories)) {
          setDirSuggestions(data.directories);
          setShowSuggestions(data.directories.length > 0);
        }
      } catch {
        // API not available yet, ignore
      }
    }, 300);
  }, []);

  // Clean up debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleCwdChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setCwd(val);
      fetchDirectories(val);
    },
    [fetchDirectories],
  );

  const selectSuggestion = useCallback((dir: string) => {
    setCwd(dir);
    setShowSuggestions(false);
    setDirSuggestions([]);
  }, []);

  const selectRecentDir = useCallback((dir: string) => {
    setCwd(dir);
    setShowSuggestions(false);
  }, []);

  const handleDuplicate = useCallback(
    (sessionId: string) => {
      setDuplicateFrom(sessionId);
      if (!sessionId) return;
      const s = sessions[sessionId];
      if (!s) return;
      setCwd(s.cwd || '');
      setNameManuallyEdited(false);
    },
    [sessions],
  );

  const handleCreate = useCallback(() => {
    const finalName = name.trim();
    if (!finalName) return;
    const finalCwd = cwd.trim() || undefined;
    let finalFlags = flags.trim();
    if (skipPermissions) {
      const skipFlag = '--dangerously-skip-permissions';
      if (!finalFlags.includes(skipFlag)) {
        finalFlags = finalFlags ? finalFlags + ' ' + skipFlag : skipFlag;
      }
    }
    onCreate(finalName, finalCwd || '', finalFlags || undefined);
    onClose();
  }, [name, cwd, flags, skipPermissions, onCreate, onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  // Close suggestions when clicking outside
  useEffect(() => {
    if (!showSuggestions) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(e.target as Node) &&
        cwdInputRef.current &&
        !cwdInputRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSuggestions]);

  if (!open) return null;

  return (
    <div
      id="modal-overlay"
      className="visible"
      onClick={handleOverlayClick}
    >
      <div id="modal">
        <h2>New Session</h2>

        {/* Duplicate from existing session */}
        {sessionList.length > 0 && (
          <div className="modal-field">
            <label className="modal-label">Duplicate from...</label>
            <select
              className="modal-select"
              value={duplicateFrom}
              onChange={(e) => handleDuplicate(e.target.value)}
            >
              <option value="">-- None --</option>
              {sessionList.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({basenameFromPath(s.cwd)})
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Recent directories as chips */}
        {recentDirs.length > 0 && (
          <div className="recent-dirs">
            {recentDirs.map((dir) => (
              <button
                key={dir}
                className="dir-chip"
                onClick={() => selectRecentDir(dir)}
              >
                {basenameFromPath(dir)}
              </button>
            ))}
          </div>
        )}

        {/* Directory input with autocomplete */}
        <div className="modal-field-wrap">
          <input
            type="text"
            ref={cwdInputRef}
            value={cwd}
            onChange={handleCwdChange}
            onFocus={() => {
              if (dirSuggestions.length > 0) setShowSuggestions(true);
            }}
            placeholder="Working directory"
          />
          {showSuggestions && dirSuggestions.length > 0 && (
            <div className="dir-suggestions" ref={suggestionsRef}>
              {dirSuggestions.map((dir) => (
                <div
                  key={dir}
                  className="dir-suggestion-item"
                  onClick={() => selectSuggestion(dir)}
                >
                  {dir}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Session name */}
        <input
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameManuallyEdited(true);
          }}
          placeholder="Session name"
        />

        {/* Claude flags */}
        <input
          type="text"
          value={flags}
          onChange={(e) => setFlags(e.target.value)}
          placeholder="Claude flags (e.g. --model sonnet)"
        />

        {/* Common flag toggles */}
        <label className="modal-checkbox">
          <input
            type="checkbox"
            checked={skipPermissions}
            onChange={(e) => setSkipPermissions(e.target.checked)}
          />
          <span>--dangerously-skip-permissions</span>
        </label>

        <div className="modal-btns">
          <button
            style={{ background: '#3A3A3C', color: '#fff' }}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            style={{ background: 'var(--blue)', color: '#fff' }}
            onClick={handleCreate}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
