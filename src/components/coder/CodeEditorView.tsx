import React, { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Play,
  Save,
  Copy,
  Check,
  FileCode,
  Terminal,
  ExternalLink,
  SplitSquareVertical,
  X,
  Loader2,
  Plus,
  Code2,
  Sparkles,
  FolderOpen,
  Boxes,
  FileJson,
  FileSpreadsheet,
  FileTerminal,
  FileCode2,
  FileText,
  File,
} from 'lucide-react';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore, projectNameFromPath } from '@/stores/projectStore';
import { tauriApi } from '@/lib/tauri';
import { cn } from '@/lib/utils';

export const CodeEditorView: React.FC = () => {
  const {
    code,
    filePath,
    language,
    originalCode,
    isModified,
    showDiff,
    consoleOutput,
    isExecuting,
    openTabs,
    setCode,
    switchTab,
    closeTab,
    toggleDiff,
    clearConsole,
    saveCurrentFile,
    runCurrentCode,
    loadCodeSnippet,
  } = useCanvasStore();

  const activeProjectPath = useProjectStore((s) => s.activeProjectPath);
  const projectName = activeProjectPath ? projectNameFromPath(activeProjectPath) : 'Workspace';

  const [copied, setCopied] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);

  const lines = code.split('\n');
  const lineCount = lines.length;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard fallback
    }
  };

  const handleSave = async () => {
    const res = await saveCurrentFile();
    setSaveStatus(res.success ? 'Saved!' : res.message);
    setTimeout(() => setSaveStatus(null), 3000);
  };

  const handleOpenExternal = async () => {
    if (!filePath) return;
    try {
      await tauriApi.runTerminalCommand(
        `code "${filePath}" 2>/dev/null || open "${filePath}" 2>/dev/null || xdg-open "${filePath}" 2>/dev/null`
      );
    } catch {
      // Fallback
    }
  };

  // Support Tab key in editor textarea (2 spaces indentation)
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = e.currentTarget.selectionStart;
      const end = e.currentTarget.selectionEnd;
      const value = e.currentTarget.value;
      const newValue = value.substring(0, start) + '  ' + value.substring(end);
      setCode(newValue);

      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + 2;
        }
      }, 0);
    }
  };

  // Sync scroll between textarea and line numbers gutter
  const handleScroll = () => {
    if (textareaRef.current && lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  // Line-by-line diff when showDiff is toggled
  const diffLines = React.useMemo(() => {
    if (!showDiff || originalCode === null) return [];
    const orig = originalCode.split('\n');
    const curr = code.split('\n');
    const max = Math.max(orig.length, curr.length);
    const result: Array<{
      type: 'same' | 'added' | 'removed' | 'modified';
      text: string;
      origLine?: number;
      currLine?: number;
    }> = [];

    for (let i = 0; i < max; i++) {
      const o = orig[i];
      const c = curr[i];
      if (o === c) {
        result.push({ type: 'same', text: o ?? '', origLine: i + 1, currLine: i + 1 });
      } else if (o !== undefined && c !== undefined) {
        result.push({ type: 'removed', text: o, origLine: i + 1 });
        result.push({ type: 'added', text: c, currLine: i + 1 });
      } else if (o !== undefined) {
        result.push({ type: 'removed', text: o, origLine: i + 1 });
      } else if (c !== undefined) {
        result.push({ type: 'added', text: c, currLine: i + 1 });
      }
    }
    return result;
  }, [showDiff, originalCode, code]);

  const hasOpenFile = filePath !== null || (code.trim().length > 0 && openTabs.length > 0);

  // Relative path breadcrumb
  const displayBreadcrumb = React.useMemo(() => {
    if (!filePath) return 'Scratchpad';
    if (activeProjectPath && filePath.startsWith(activeProjectPath)) {
      const rel = filePath.slice(activeProjectPath.length).replace(/^[/\\]/, '');
      return `${projectName} > ${rel.replace(/[/\\]/g, ' > ')}`;
    }
    return filePath.split(/[/\\]/).pop() || 'File';
  }, [filePath, activeProjectPath, projectName]);

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100 select-none overflow-hidden">
      {/* 1. Tab Bar */}
      <div className="flex items-center bg-zinc-900/90 border-b border-white/8 px-1 pt-1 overflow-x-auto scrollbar-none flex-shrink-0">
        <div className="flex items-center gap-0.5 min-w-0">
          {openTabs.map((tab) => {
            const isActive = tab.path === filePath;
            const tabModified = isActive && isModified;
            return (
              <div
                key={tab.path}
                onClick={() => switchTab(tab.path)}
                className={cn(
                  'group flex items-center gap-2 px-3 py-1.5 rounded-t-lg text-xs font-medium cursor-pointer transition-colors border-t-2',
                  isActive
                    ? 'bg-zinc-950 text-zinc-100 border-indigo-500 shadow-sm'
                    : 'bg-zinc-900/50 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 border-transparent'
                )}
                title={tab.path}
              >
                <TabIcon path={tab.path} />
                <span className="truncate max-w-[140px]">{tab.name}</span>

                {tabModified ? (
                  <span
                    className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0"
                    title="Unsaved changes"
                  />
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.path);
                    }}
                    className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                    title="Close tab"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* New Scratchpad Button */}
        <button
          onClick={() => loadCodeSnippet('', 'plaintext')}
          className="ml-1 p-1 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/5 transition-colors flex-shrink-0"
          title="New scratchpad buffer"
        >
          <Plus size={13} />
        </button>
      </div>

      {/* 2. Action Toolbar */}
      {hasOpenFile && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900/40 border-b border-white/6 flex-shrink-0 text-xs">
          {/* Breadcrumb path */}
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[11px] text-zinc-400 font-mono truncate" title={filePath ?? ''}>
              {displayBreadcrumb}
            </span>
            <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-white/5 text-zinc-400 border border-white/8 uppercase flex-shrink-0">
              {language}
            </span>
          </div>

          {/* Action Toolbar Buttons */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {/* Run Button */}
            <button
              onClick={runCurrentCode}
              disabled={isExecuting}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all shadow-sm',
                isExecuting
                  ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                  : 'bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 border border-emerald-500/30'
              )}
              title="Run code in this file (Python / Shell / Preview)"
            >
              {isExecuting ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Play size={12} className="fill-current text-emerald-400" />
              )}
              <span>Run</span>
            </button>

            {/* Save Button */}
            {filePath && (
              <button
                onClick={handleSave}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all',
                  isModified
                    ? 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-sm shadow-indigo-600/30'
                    : 'text-zinc-400 hover:text-white hover:bg-white/8'
                )}
                title="Save changes to disk"
              >
                <Save size={12} />
                <span>Save</span>
              </button>
            )}

            {/* Diff Toggle */}
            {originalCode !== null && isModified && (
              <button
                onClick={toggleDiff}
                className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors',
                  showDiff
                    ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/40'
                    : 'text-zinc-400 hover:text-white hover:bg-white/8'
                )}
                title={showDiff ? 'Exit Diff View' : 'Compare Diff with disk file'}
              >
                <SplitSquareVertical size={13} />
                <span className="hidden sm:inline">Diff</span>
              </button>
            )}

            {/* Copy Button */}
            <button
              onClick={handleCopy}
              className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/8 transition-colors"
              title="Copy code to clipboard"
            >
              {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
            </button>

            {/* Open in External IDE */}
            {filePath && (
              <button
                onClick={handleOpenExternal}
                className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/8 transition-colors"
                title="Open in VS Code or external editor"
              >
                <ExternalLink size={13} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Save Notification Toast */}
      {saveStatus && (
        <div className="px-3 py-1 bg-indigo-950/90 border-b border-indigo-500/30 text-xs text-indigo-200 flex items-center justify-between">
          <span>{saveStatus}</span>
          <button onClick={() => setSaveStatus(null)} className="text-indigo-400 hover:text-white">
            <X size={12} />
          </button>
        </div>
      )}

      {/* 3. Editor Body or Empty State */}
      <div className="relative flex-1 overflow-hidden flex">
        {!hasOpenFile ? (
          /* Clean VS Code-style Minimal Empty Editor Group */
          <div className="flex-1 flex flex-col items-center justify-center p-8 select-none bg-zinc-950">
            {/* Subtle faint watermark */}
            <div className="mb-6 opacity-[0.06] pointer-events-none">
              <Code2 size={72} className="text-zinc-300" />
            </div>

            {/* Minimalist aligned keybindings */}
            <div className="space-y-2 text-xs text-zinc-500 max-w-xs w-full">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Open File</span>
                <span className="text-zinc-600 font-mono text-[11px]">Select in Explorer</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Agent Coder</span>
                <kbd className="px-1.5 py-0.5 rounded bg-zinc-900 border border-white/10 text-zinc-400 font-mono text-[10px]">
                  Ctrl \
                </kbd>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">New Scratchpad</span>
                <span className="text-zinc-600 font-mono text-[11px]">+ Tab</span>
              </div>
            </div>
          </div>
        ) : showDiff ? (
          /* Diff Mode View */
          <div className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed space-y-0.5 select-text">
            {diffLines.map((line, idx) => (
              <div
                key={idx}
                className={cn(
                  'flex items-start px-2 py-0.5 rounded font-mono',
                  line.type === 'added' &&
                    'bg-emerald-500/15 text-emerald-300 border-l-2 border-emerald-500',
                  line.type === 'removed' &&
                    'bg-red-500/15 text-red-300 border-l-2 border-red-500 line-through opacity-75',
                  line.type === 'same' && 'text-zinc-400'
                )}
              >
                <span className="w-8 text-[10px] text-zinc-600 select-none mr-2 text-right">
                  {line.currLine || line.origLine || ''}
                </span>
                <span className="w-3 select-none text-zinc-500 mr-1">
                  {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                </span>
                <span className="flex-1 whitespace-pre-wrap break-all">{line.text || ' '}</span>
              </div>
            ))}
          </div>
        ) : (
          /* Normal Code Editor Surface */
          <div className="flex-1 flex overflow-hidden">
            {/* Line Numbers Gutter */}
            <div
              ref={lineNumbersRef}
              className="w-12 flex-shrink-0 bg-zinc-950 text-zinc-600 font-mono text-xs text-right pr-3 pt-3 pb-6 select-none overflow-hidden border-r border-white/5 leading-relaxed"
            >
              {Array.from({ length: lineCount }).map((_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>

            {/* Editable Textarea */}
            <textarea
              ref={textareaRef}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onScroll={handleScroll}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              className="flex-1 bg-transparent text-zinc-100 font-mono text-xs leading-relaxed p-3 outline-none resize-none overflow-y-auto whitespace-pre tab-4 selection:bg-indigo-600/30 selection:text-white"
              placeholder="// Write or paste code here..."
            />
          </div>
        )}
      </div>

      {/* 4. Collapsible Execution Console Drawer (Bottom) */}
      <AnimatePresence>
        {consoleOutput !== null && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 160, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="border-t border-white/10 bg-zinc-900/95 flex flex-col flex-shrink-0 overflow-hidden"
          >
            {/* Console Header */}
            <div className="flex items-center justify-between px-3 py-1.5 bg-black/40 border-b border-white/6">
              <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                <Terminal size={12} className="text-emerald-400" />
                <span className="font-semibold text-zinc-200">Execution Output</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={clearConsole}
                  className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  Clear
                </button>
                <button
                  onClick={clearConsole}
                  className="p-1 rounded text-zinc-500 hover:text-white transition-colors"
                >
                  <X size={12} />
                </button>
              </div>
            </div>

            {/* Console Logs */}
            <pre className="flex-1 p-3 overflow-y-auto font-mono text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap select-text">
              {consoleOutput}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// ─── Tab Icon Helper ──────────────────────────────────────────────────────────

const TabIcon: React.FC<{ path: string }> = ({ path }) => {
  const ext = path.split('.').pop()?.toLowerCase() || '';

  switch (ext) {
    case 'py':
      return <FileCode size={12} className="text-blue-400 flex-shrink-0" />;
    case 'ts':
    case 'tsx':
      return <FileCode size={12} className="text-sky-400 flex-shrink-0" />;
    case 'js':
    case 'jsx':
      return <FileCode size={12} className="text-amber-300 flex-shrink-0" />;
    case 'rs':
      return <Boxes size={12} className="text-orange-400 flex-shrink-0" />;
    case 'json':
    case 'toml':
    case 'yaml':
    case 'yml':
      return <FileJson size={12} className="text-emerald-400 flex-shrink-0" />;
    case 'csv':
      return <FileSpreadsheet size={12} className="text-emerald-500 flex-shrink-0" />;
    case 'sh':
    case 'bash':
    case 'zsh':
      return <FileTerminal size={12} className="text-green-400 flex-shrink-0" />;
    case 'scad':
    case 'stl':
      return <FileCode2 size={12} className="text-cyan-400 flex-shrink-0" />;
    case 'md':
    case 'txt':
    case 'rst':
      return <FileText size={12} className="text-violet-300 flex-shrink-0" />;
    case 'css':
    case 'scss':
    case 'html':
      return <FileCode size={12} className="text-pink-400 flex-shrink-0" />;
    default:
      return <File size={12} className="text-zinc-500 flex-shrink-0" />;
  }
};
