import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Code2,
  FolderOpen,
  FolderGit2,
  X,
  ArrowLeft,
  Clock,
  Plus,
  Compass,
  FolderPlus,
  Terminal,
  Loader2,
  ChevronRight,
  Sparkles,
} from 'lucide-react';
import { useProjectStore, formatDisplayPath } from '@/stores/projectStore';
import { useChatStore } from '@/stores/chatStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { cn } from '@/lib/utils';

/**
 * VS Code-style Welcome / Project Launcher:
 * Displays Start actions (Open Folder, New Scratchpad, Manual Path)
 * and Recent projects list with persistent filesystem storage.
 */
export const ProjectPicker: React.FC = () => {
  const {
    recentProjects,
    dismissedPaths,
    openProject,
    removeProject,
    clearAllRecent,
    pickAndOpenProject,
    discoverLocalProjects,
    isDiscovering,
  } = useProjectStore();
  const { setChatMode } = useChatStore();
  const [manualPath, setManualPath] = useState('');
  const [showManualInput, setShowManualInput] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);

  useEffect(() => {
    // Only auto-discover once on initial launch if the user has never loaded or dismissed projects
    const store = useProjectStore.getState();
    if (store.recentProjects.length === 0 && store.dismissedPaths.length === 0) {
      discoverLocalProjects();
    }
  }, [discoverLocalProjects]);

  const handleOpen = (path: string) => {
    openProject(path);
  };

  const handlePick = async () => {
    await pickAndOpenProject();
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = manualPath.trim();
    if (!clean) {
      setInputError('Please enter a valid folder path');
      return;
    }
    openProject(clean);
  };

  const handleNewScratchpad = () => {
    // Open a scratchpad without tying to a folder
    useCanvasStore.getState().loadCodeSnippet('', 'python');
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-zinc-950 text-zinc-100 relative select-none">
      {/* Top Bar: Back to Chat Button */}
      <div className="px-6 pt-5 pb-2 flex items-center justify-between flex-shrink-0">
        <button
          onClick={() => setChatMode('fast')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-100 hover:bg-white/6 transition-colors"
          title="Back to standard Chat mode"
        >
          <ArrowLeft size={13} />
          <span>Back to Chat</span>
        </button>

        <button
          onClick={discoverLocalProjects}
          disabled={isDiscovering}
          className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          title="Scan ~/Documents/projects for existing workspaces"
        >
          {isDiscovering ? <Loader2 size={12} className="animate-spin" /> : <Compass size={12} />}
          <span>{isDiscovering ? 'Scanning...' : 'Detect Projects'}</span>
        </button>
      </div>

      {/* Main Content: VS Code Welcome Page Style */}
      <div className="flex-1 overflow-y-auto px-8 py-6 flex flex-col max-w-4xl w-full mx-auto">
        {/* Header Title */}
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shadow-[0_0_16px_rgba(99,102,241,0.3)]">
              <Code2 size={18} />
            </div>
            <h1 className="text-2xl font-semibold text-white tracking-tight">Morfeus Developer</h1>
          </div>
          <p className="text-sm text-zinc-500 ml-11">Editing evolved &bull; Agent Coder IDE</p>
        </div>

        {/* 2-Column Section (Start & Recent) */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
          {/* Left Column: Start Actions */}
          <div>
            <h2 className="text-sm font-semibold text-zinc-300 mb-3 tracking-wide">Start</h2>
            <div className="space-y-1">
              {/* Open Folder... */}
              <button
                onClick={handlePick}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 text-left transition-colors text-xs text-zinc-300 hover:text-white group"
              >
                <FolderOpen size={16} className="text-sky-400 group-hover:scale-110 transition-transform" />
                <div className="flex-1">
                  <div className="font-medium text-zinc-200 group-hover:text-sky-300 transition-colors">
                    Open Folder...
                  </div>
                  <div className="text-[11px] text-zinc-500">Pick a workspace folder on your machine</div>
                </div>
                <ChevronRight size={13} className="text-zinc-600 group-hover:text-zinc-400 transition-colors" />
              </button>

              {/* Enter Path Manually */}
              <button
                onClick={() => setShowManualInput(!showManualInput)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 text-left transition-colors text-xs text-zinc-300 hover:text-white group"
              >
                <FolderPlus size={16} className="text-indigo-400 group-hover:scale-110 transition-transform" />
                <div className="flex-1">
                  <div className="font-medium text-zinc-200 group-hover:text-indigo-300 transition-colors">
                    Open by Path...
                  </div>
                  <div className="text-[11px] text-zinc-500">Type or paste full project directory path</div>
                </div>
                <ChevronRight size={13} className="text-zinc-600 group-hover:text-zinc-400 transition-colors" />
              </button>

              {/* Inline Manual Path Input */}
              <AnimatePresence>
                {showManualInput && (
                  <motion.form
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    onSubmit={handleManualSubmit}
                    className="overflow-hidden pl-9 pr-2 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={manualPath}
                        onChange={(e) => {
                          setManualPath(e.target.value);
                          setInputError(null);
                        }}
                        placeholder="/Users/username/projects/my-app"
                        className="flex-1 px-3 py-1.5 rounded-lg bg-zinc-900 border border-white/10 text-xs font-mono text-zinc-200 placeholder-zinc-600 outline-none focus:border-indigo-500"
                        autoFocus
                      />
                      <button
                        type="submit"
                        className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-500 transition-colors"
                      >
                        Open
                      </button>
                    </div>
                    {inputError && (
                      <div className="text-[11px] text-red-400 mt-1">{inputError}</div>
                    )}
                  </motion.form>
                )}
              </AnimatePresence>

              {/* New Scratchpad */}
              <button
                onClick={handleNewScratchpad}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 text-left transition-colors text-xs text-zinc-300 hover:text-white group"
              >
                <Plus size={16} className="text-emerald-400 group-hover:scale-110 transition-transform" />
                <div className="flex-1">
                  <div className="font-medium text-zinc-200 group-hover:text-emerald-300 transition-colors">
                    New Scratchpad...
                  </div>
                  <div className="text-[11px] text-zinc-500">Open a temporary code editor without a project</div>
                </div>
              </button>
            </div>
          </div>

          {/* Right Column: Recent Workspaces (VS Code style) */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-zinc-300 tracking-wide">Recent</h2>
              <div className="flex items-center gap-3">
                {recentProjects.length > 0 && (
                  <button
                    onClick={clearAllRecent}
                    className="text-[11px] text-zinc-500 hover:text-red-400 transition-colors"
                    title="Clear all recent workspaces"
                  >
                    Clear All
                  </button>
                )}
                <span className="text-[11px] text-zinc-600">{recentProjects.length} workspaces</span>
              </div>
            </div>

            {recentProjects.length === 0 ? (
              <div className="p-6 text-center rounded-xl border border-white/5 bg-white/[0.02]">
                <FolderGit2 size={24} className="mx-auto text-zinc-700 mb-2" />
                <p className="text-xs text-zinc-500">No recent projects saved yet</p>
                <p className="text-[11px] text-zinc-600 mt-1">
                  Click "Open Folder..." or "Detect Projects" to load your workspaces.
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                {recentProjects.map((p) => {
                  const displayPath = formatDisplayPath(p.path);
                  return (
                    <div
                      key={p.path}
                      className="group flex items-center justify-between px-3 py-2 rounded-xl hover:bg-white/5 transition-colors cursor-pointer"
                      onClick={() => handleOpen(p.path)}
                    >
                      <div className="min-w-0 flex-1 pr-2">
                        <div className="text-xs font-medium text-zinc-200 group-hover:text-indigo-300 transition-colors truncate">
                          {p.name}
                        </div>
                        <div
                          className="text-[11px] text-zinc-500 font-mono truncate"
                          title={p.path}
                        >
                          {displayPath}
                        </div>
                      </div>

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeProject(p.path);
                        }}
                        className="p-1 rounded text-zinc-600 hover:text-red-400 hover:bg-red-400/10 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Remove from recent"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
