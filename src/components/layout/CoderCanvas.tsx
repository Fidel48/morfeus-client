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
  RotateCcw,
  X,
  Loader2,
  FileText,
  AlertCircle
} from 'lucide-react';
import { useCanvasStore } from '@/stores/canvasStore';
import { tauriApi } from '@/lib/tauri';
import { cn } from '@/lib/utils';

export const CoderCanvas: React.FC = () => {
  const {
    code,
    filePath,
    language,
    originalCode,
    isModified,
    showDiff,
    consoleOutput,
    isExecuting,
    setCode,
    setShowDiff,
    toggleDiff,
    clearConsole,
    saveCurrentFile,
    runCurrentCode,
  } = useCanvasStore();

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
      // Try code -g first, fallback to open / start
      await tauriApi.runTerminalCommand(`code "${filePath}" 2>/dev/null || open "${filePath}" 2>/dev/null || xdg-open "${filePath}" 2>/dev/null`);
    } catch {
      // Fallback
    }
  };

  // Support Tab key in editor textarea
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = e.currentTarget.selectionStart;
      const end = e.currentTarget.selectionEnd;
      const value = e.currentTarget.value;
      const newValue = value.substring(0, start) + '  ' + value.substring(end);
      setCode(newValue);

      // Restore cursor position after state update
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

  // Compute a line-by-line diff if showDiff is active
  const diffLines = React.useMemo(() => {
    if (!showDiff || originalCode === null) return [];
    const orig = originalCode.split('\n');
    const curr = code.split('\n');
    const max = Math.max(orig.length, curr.length);
    const result: Array<{ type: 'same' | 'added' | 'removed' | 'modified'; text: string; origLine?: number; currLine?: number }> = [];

    // Simple line diff visualization
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

  const fileName = filePath ? filePath.split(/[/\\]/).pop() : 'Scratchpad';

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100 select-none overflow-hidden">
      {/* Header Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 bg-zinc-900/60 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode size={15} className="text-violet-400 flex-shrink-0" />
          <div className="flex items-center gap-1.5 min-w-0" title={filePath || 'Scratchpad buffer'}>
            <span className="text-xs font-semibold text-zinc-200 truncate">{fileName}</span>
            {isModified && (
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" title="Modified" />
            )}
          </div>
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-white/5 text-zinc-400 border border-white/10 uppercase flex-shrink-0">
            {language}
          </span>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Run Button */}
          <button
            onClick={runCurrentCode}
            disabled={isExecuting}
            className={cn(
              'flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all shadow-sm',
              isExecuting
                ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                : 'bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 border border-emerald-500/30'
            )}
            title="Execute current buffer (Python / Shell / Preview)"
          >
            {isExecuting ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} className="fill-current" />}
            <span className="hidden sm:inline">Run</span>
          </button>

          {/* Save Button */}
          {filePath && (
            <button
              onClick={handleSave}
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-all',
                isModified
                  ? 'bg-violet-600 text-white hover:bg-violet-500 shadow-sm shadow-violet-600/30'
                  : 'text-zinc-400 hover:text-white hover:bg-white/8'
              )}
              title="Save changes to workspace file"
            >
              <Save size={12} />
              <span className="hidden sm:inline">Save</span>
            </button>
          )}

          {/* Diff Toggle */}
          {originalCode !== null && isModified && (
            <button
              onClick={toggleDiff}
              className={cn(
                'p-1.5 rounded-md text-xs transition-colors',
                showDiff
                  ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/40'
                  : 'text-zinc-400 hover:text-white hover:bg-white/8'
              )}
              title={showDiff ? 'Exit Diff View' : 'Compare Diff with disk version'}
            >
              <SplitSquareVertical size={13} />
            </button>
          )}

          {/* Copy Button */}
          <button
            onClick={handleCopy}
            className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/8 transition-colors"
            title="Copy buffer code"
          >
            {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
          </button>

          {/* Open in External IDE */}
          {filePath && (
            <button
              onClick={handleOpenExternal}
              className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/8 transition-colors"
              title="Open file in external editor (VS Code / default)"
            >
              <ExternalLink size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Save Notification Toast */}
      {saveStatus && (
        <div className="px-3 py-1 bg-violet-950/80 border-b border-violet-500/30 text-xs text-violet-300 flex items-center justify-between">
          <span>{saveStatus}</span>
          <button onClick={() => setSaveStatus(null)} className="text-violet-400 hover:text-white">
            <X size={12} />
          </button>
        </div>
      )}

      {/* Main Canvas Editor Area */}
      <div className="relative flex-1 overflow-hidden flex">
        {showDiff ? (
          /* Diff Mode View */
          <div className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed space-y-0.5 select-text">
            {diffLines.map((line, idx) => (
              <div
                key={idx}
                className={cn(
                  'flex items-start px-2 py-0.5 rounded font-mono',
                  line.type === 'added' && 'bg-emerald-500/15 text-emerald-300 border-l-2 border-emerald-500',
                  line.type === 'removed' && 'bg-red-500/15 text-red-300 border-l-2 border-red-500 line-through opacity-75',
                  line.type === 'same' && 'text-zinc-400'
                )}
              >
                <span className="w-6 text-[10px] text-zinc-600 select-none mr-2 text-right">
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
          /* Normal Code Editor View */
          <div className="flex-1 flex overflow-hidden">
            {/* Line Numbers Gutter */}
            <div
              ref={lineNumbersRef}
              className="w-12 flex-shrink-0 bg-zinc-950/80 text-zinc-600 font-mono text-xs text-right pr-3 pt-3 pb-6 select-none overflow-hidden border-r border-white/5 leading-relaxed"
            >
              {Array.from({ length: lineCount }).map((_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>

            {/* Editable Code Textarea */}
            <textarea
              ref={textareaRef}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onScroll={handleScroll}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              className="flex-1 bg-transparent text-zinc-100 font-mono text-xs leading-relaxed p-3 outline-none resize-none overflow-y-auto whitespace-pre tab-4 selection:bg-violet-600/30 selection:text-white"
              placeholder="// Write or paste code here..."
            />
          </div>
        )}
      </div>

      {/* Collapsible Execution Console Drawer (Bottom) */}
      <AnimatePresence>
        {consoleOutput !== null && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 160, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="border-t border-white/10 bg-zinc-900/90 flex flex-col flex-shrink-0 overflow-hidden"
          >
            {/* Console Header */}
            <div className="flex items-center justify-between px-3 py-1.5 bg-black/40 border-b border-white/5">
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
