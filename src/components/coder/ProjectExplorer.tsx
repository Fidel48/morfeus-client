import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  FileCode,
  FileText,
  FileJson,
  FileSpreadsheet,
  RotateCw,
  ArrowLeftRight,
  Plus,
  Terminal,
  Trash2,
  Settings,
  ShieldCheck,
  ArrowLeft,
  FolderGit2,
  Boxes,
  FileTerminal,
  FileCode2,
  File,
  Layers,
} from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';
import { useProjectStore, projectNameFromPath } from '@/stores/projectStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { tauriApi } from '@/lib/tauri';
import { cn, groupConversationsByDate, truncateText } from '@/lib/utils';

interface FileTreeItem {
  name: string;
  path: string;
  is_dir: boolean;
  size_bytes: number | null;
  extension: string | null;
  children?: FileTreeItem[];
  isLoaded?: boolean;
}

export const ProjectExplorer: React.FC = () => {
  const {
    conversations,
    activeConversationId,
    setActiveConversation,
    deleteConversation,
    newConversation,
    setChatMode,
    autoApprove,
    setAutoApprove,
  } = useChatStore();
  const { activeProjectPath, closeProject } = useProjectStore();
  const { openSettings } = useSettingsStore();
  const currentFilePath = useCanvasStore((s) => s.filePath);
  const openFileFromDisk = useCanvasStore((s) => s.openFileFromDisk);

  // Tab switcher: 'files' (File Tree Explorer) vs 'sessions' (Project Chat Sessions)
  const [activeTab, setActiveTab] = useState<'files' | 'sessions'>('files');

  // File tree state
  const [rootEntries, setRootEntries] = useState<FileTreeItem[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [folderChildren, setFolderChildren] = useState<Record<string, FileTreeItem[]>>({});
  const [isLoading, setIsLoading] = useState(false);

  // Session group collapse state
  const [collapsedSessionGroups, setCollapsedSessionGroups] = useState<Set<string>>(new Set());
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null);

  // Load root directory items
  const loadRootDirectory = useCallback(async () => {
    if (!activeProjectPath) return;
    setIsLoading(true);
    try {
      const items = await tauriApi.listDirectory(activeProjectPath, false);
      setRootEntries(
        items.map((it) => ({
          name: it.name,
          path: it.path,
          is_dir: it.is_dir,
          size_bytes: it.size_bytes,
          extension: it.extension,
        }))
      );

      // Auto-open primary entry file if editor currently has no file open
      const canvas = useCanvasStore.getState();
      if (!canvas.filePath && canvas.openTabs.length === 0) {
        const preferred =
          items.find(
            (it) =>
              !it.is_dir &&
              /^(main\.(py|rs|ts|js)|index\.(ts|tsx|js|html)|app\.(py|tsx|ts|js)|readme\.md)$/i.test(it.name)
          ) || items.find((it) => !it.is_dir);

        if (preferred) {
          canvas.openFileFromDisk(preferred.path);
        }
      }
    } catch (err) {
      console.error('Failed to load project directory:', err);
    } finally {
      setIsLoading(false);
    }
  }, [activeProjectPath]);

  useEffect(() => {
    loadRootDirectory();
  }, [loadRootDirectory]);

  // Toggle folder expansion and lazy load contents
  const toggleFolder = async (folderPath: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });

    // If expanding and not yet cached, fetch children
    if (!folderChildren[folderPath]) {
      try {
        const items = await tauriApi.listDirectory(folderPath, false);
        setFolderChildren((prev) => ({
          ...prev,
          [folderPath]: items.map((it) => ({
            name: it.name,
            path: it.path,
            is_dir: it.is_dir,
            size_bytes: it.size_bytes,
            extension: it.extension,
          })),
        }));
      } catch (err) {
        console.error(`Failed to load directory ${folderPath}:`, err);
      }
    }
  };

  const handleFileClick = async (filePath: string) => {
    await openFileFromDisk(filePath);
  };

  const collapseAll = () => {
    setExpandedFolders(new Set());
  };

  // Sessions for this project
  const sessions = conversations.filter(
    (c) => c.mode === 'agent' && c.project_path === activeProjectPath
  );
  const groupedSessions = groupConversationsByDate(sessions);

  const toggleSessionGroup = (label: string) =>
    setCollapsedSessionGroups((prev) => {
      const next = new Set(prev);
      next.has(label) ? next.delete(label) : next.add(label);
      return next;
    });

  const projectName = activeProjectPath ? projectNameFromPath(activeProjectPath) : 'Project';

  return (
    <div className="flex flex-col h-full bg-zinc-950/95 text-zinc-300 select-none">
      {/* Top Header: Project Title & Global Actions */}
      <div className="px-3 pt-3 pb-2 border-b border-white/8 flex-shrink-0">
        <div className="flex items-center justify-between gap-1 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-6 h-6 rounded-md bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400 flex-shrink-0">
              <FolderGit2 size={13} />
            </div>
            <span className="font-semibold text-xs text-white truncate" title={activeProjectPath ?? ''}>
              {projectName}
            </span>
          </div>

          <div className="flex items-center gap-0.5 flex-shrink-0">
            <button
              onClick={closeProject}
              className="p-1 rounded text-zinc-500 hover:text-indigo-300 hover:bg-white/8 transition-colors"
              title="Switch project"
            >
              <ArrowLeftRight size={13} />
            </button>
          </div>
        </div>

        {/* View Switcher: Files vs Sessions */}
        <div className="flex items-center bg-white/[0.04] p-0.5 rounded-lg border border-white/6 text-xs">
          <button
            onClick={() => setActiveTab('files')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 py-1 rounded-md text-[11px] font-medium transition-all',
              activeTab === 'files'
                ? 'bg-indigo-500/20 text-indigo-200 border border-indigo-500/30 shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            )}
          >
            <Folder size={12} />
            <span>Files</span>
          </button>
          <button
            onClick={() => setActiveTab('sessions')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 py-1 rounded-md text-[11px] font-medium transition-all',
              activeTab === 'sessions'
                ? 'bg-indigo-500/20 text-indigo-200 border border-indigo-500/30 shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            )}
          >
            <Terminal size={12} />
            <span>Sessions</span>
            {sessions.length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[9px] bg-white/10 text-zinc-300">
                {sessions.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      {activeTab === 'files' ? (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Explorer Sub-Header */}
          <div className="flex items-center justify-between px-3 py-1.5 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider border-b border-white/5 flex-shrink-0">
            <span className="truncate">EXPLORER</span>
            <div className="flex items-center gap-1">
              <button
                onClick={loadRootDirectory}
                className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                title="Refresh explorer"
              >
                <RotateCw size={11} className={cn(isLoading && 'animate-spin')} />
              </button>
              <button
                onClick={collapseAll}
                className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                title="Collapse all folders"
              >
                <Layers size={11} />
              </button>
            </div>
          </div>

          {/* Root Project Tree Item */}
          <div className="flex-1 overflow-y-auto px-1 py-1 scrollbar-thin">
            {rootEntries.length === 0 && !isLoading ? (
              <div className="px-4 py-8 text-center text-xs text-zinc-600">
                No files found in this workspace
              </div>
            ) : (
              <div className="space-y-0.5">
                {rootEntries.map((item) => (
                  <TreeItemRow
                    key={item.path}
                    item={item}
                    depth={0}
                    expandedFolders={expandedFolders}
                    folderChildren={folderChildren}
                    currentFilePath={currentFilePath}
                    onToggleFolder={toggleFolder}
                    onFileClick={handleFileClick}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Sessions Tab */
        <div className="flex-1 flex flex-col min-h-0">
          {/* New Session Button */}
          <div className="p-2 border-b border-white/5 flex-shrink-0">
            <button
              onClick={() => newConversation()}
              className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg bg-indigo-500/15 border border-indigo-500/30 text-indigo-200 hover:bg-indigo-500/25 hover:border-indigo-400/50 transition-all text-xs font-medium group"
            >
              <Plus size={13} className="group-hover:rotate-90 transition-transform duration-200" />
              New Session
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1 scrollbar-thin">
            {sessions.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <Terminal size={18} className="mx-auto text-zinc-700 mb-2" />
                <p className="text-xs text-zinc-600">No sessions in this project yet</p>
              </div>
            ) : (
              groupedSessions.map((group) => (
                <div key={group.label}>
                  <button
                    onClick={() => toggleSessionGroup(group.label)}
                    className="w-full flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-zinc-500 uppercase tracking-wider hover:text-zinc-400 transition-colors"
                  >
                    {collapsedSessionGroups.has(group.label) ? (
                      <ChevronRight size={10} />
                    ) : (
                      <ChevronDown size={10} />
                    )}
                    {group.label}
                  </button>

                  <AnimatePresence>
                    {!collapsedSessionGroups.has(group.label) &&
                      group.items.map((conv) => {
                        const isActive = conv.id === activeConversationId;
                        return (
                          <motion.div
                            key={conv.id}
                            initial={{ opacity: 0, x: -6 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -6 }}
                            className="relative group"
                            onMouseEnter={() => setHoveredSessionId(conv.id)}
                            onMouseLeave={() => setHoveredSessionId(null)}
                          >
                            <button
                              onClick={() => setActiveConversation(conv.id)}
                              className={cn(
                                'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-all text-xs',
                                isActive
                                  ? 'bg-indigo-500/20 border border-indigo-500/30 text-white'
                                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'
                              )}
                            >
                              <Terminal size={12} className="flex-shrink-0 text-indigo-400" />
                              <span className="flex-1 truncate">{truncateText(conv.title, 26)}</span>
                            </button>

                            {(hoveredSessionId === conv.id || isActive) && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteConversation(conv.id);
                                }}
                                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-zinc-600 hover:text-red-400 hover:bg-red-400/10 transition-colors"
                                title="Delete session"
                              >
                                <Trash2 size={11} />
                              </button>
                            )}
                          </motion.div>
                        );
                      })}
                  </AnimatePresence>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Footer: Controls & Settings */}
      <div className="flex-shrink-0 border-t border-white/8 px-2 py-2 space-y-0.5 bg-zinc-950">
        <button
          onClick={() => setAutoApprove(!autoApprove)}
          className={cn(
            'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-all border',
            autoApprove
              ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
              : 'border-transparent text-zinc-500 hover:text-zinc-200 hover:bg-white/5'
          )}
          title="Skip terminal command approval prompts for this session"
        >
          <ShieldCheck size={14} className={autoApprove ? 'text-amber-400' : 'text-zinc-500'} />
          <span className="flex-1 text-left text-[11px]">Auto-approve</span>
          <span
            className={cn(
              'w-6 h-3.5 rounded-full relative transition-colors flex-shrink-0',
              autoApprove ? 'bg-amber-500/80' : 'bg-zinc-800'
            )}
          >
            <span
              className={cn(
                'absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all',
                autoApprove ? 'left-3' : 'left-0.5'
              )}
            />
          </span>
        </button>

        <button
          onClick={openSettings}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-white/5 transition-all text-xs"
        >
          <Settings size={13} />
          <span className="text-[11px]">Settings</span>
        </button>

        <button
          onClick={() => setChatMode('fast')}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-white/5 transition-all text-xs"
        >
          <ArrowLeft size={13} />
          <span className="text-[11px]">Back to Chat</span>
        </button>
      </div>
    </div>
  );
};

// ─── Tree Item Component ────────────────────────────────────────────────────────

interface TreeItemRowProps {
  item: FileTreeItem;
  depth: number;
  expandedFolders: Set<string>;
  folderChildren: Record<string, FileTreeItem[]>;
  currentFilePath: string | null;
  onToggleFolder: (path: string) => void;
  onFileClick: (path: string) => void;
}

const TreeItemRow: React.FC<TreeItemRowProps> = ({
  item,
  depth,
  expandedFolders,
  folderChildren,
  currentFilePath,
  onToggleFolder,
  onFileClick,
}) => {
  const isExpanded = expandedFolders.has(item.path);
  const isSelected = currentFilePath === item.path;
  const children = folderChildren[item.path] || [];

  if (item.is_dir) {
    return (
      <div>
        <button
          onClick={() => onToggleFolder(item.path)}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          className="w-full flex items-center gap-1.5 py-1 pr-2 rounded hover:bg-white/6 text-zinc-300 hover:text-white transition-colors text-xs text-left group"
        >
          <span className="text-zinc-500 group-hover:text-zinc-300 transition-colors flex-shrink-0">
            {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
          <span className="text-amber-400/90 flex-shrink-0">
            {isExpanded ? <FolderOpen size={13} /> : <Folder size={13} />}
          </span>
          <span className="truncate text-xs font-normal">{item.name}</span>
        </button>

        {isExpanded && (
          <div className="space-y-0.5">
            {children.length === 0 ? (
              <div
                style={{ paddingLeft: `${(depth + 1) * 12 + 20}px` }}
                className="py-1 text-[11px] text-zinc-600 italic"
              >
                Empty
              </div>
            ) : (
              children.map((child) => (
                <TreeItemRow
                  key={child.path}
                  item={child}
                  depth={depth + 1}
                  expandedFolders={expandedFolders}
                  folderChildren={folderChildren}
                  currentFilePath={currentFilePath}
                  onToggleFolder={onToggleFolder}
                  onFileClick={onFileClick}
                />
              ))
            )}
          </div>
        )}
      </div>
    );
  }

  // File row
  return (
    <button
      onClick={() => onFileClick(item.path)}
      style={{ paddingLeft: `${depth * 12 + 20}px` }}
      className={cn(
        'w-full flex items-center gap-1.5 py-1 pr-2 rounded text-xs transition-colors text-left group',
        isSelected
          ? 'bg-indigo-500/20 text-white font-medium border-l-2 border-indigo-400 pl-[18px]'
          : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/6'
      )}
      title={item.path}
    >
      <FileIcon extension={item.extension} name={item.name} />
      <span className="truncate text-xs">{item.name}</span>
    </button>
  );
};

// ─── File Icon Helper ──────────────────────────────────────────────────────────

const FileIcon: React.FC<{ extension: string | null; name: string }> = ({ extension, name }) => {
  const ext = (extension || name.split('.').pop() || '').toLowerCase();

  switch (ext) {
    case 'py':
      return <FileCode size={13} className="text-blue-400 flex-shrink-0" />;
    case 'ts':
    case 'tsx':
      return <FileCode size={13} className="text-sky-400 flex-shrink-0" />;
    case 'js':
    case 'jsx':
      return <FileCode size={13} className="text-amber-300 flex-shrink-0" />;
    case 'rs':
      return <Boxes size={13} className="text-orange-400 flex-shrink-0" />;
    case 'json':
    case 'toml':
    case 'yaml':
    case 'yml':
      return <FileJson size={13} className="text-emerald-400 flex-shrink-0" />;
    case 'csv':
      return <FileSpreadsheet size={13} className="text-emerald-500 flex-shrink-0" />;
    case 'sh':
    case 'bash':
    case 'zsh':
      return <FileTerminal size={13} className="text-green-400 flex-shrink-0" />;
    case 'scad':
    case 'stl':
      return <FileCode2 size={13} className="text-cyan-400 flex-shrink-0" />;
    case 'md':
    case 'txt':
    case 'rst':
      return <FileText size={13} className="text-violet-300 flex-shrink-0" />;
    case 'css':
    case 'scss':
    case 'html':
      return <FileCode size={13} className="text-pink-400 flex-shrink-0" />;
    default:
      return <File size={13} className="text-zinc-500 flex-shrink-0" />;
  }
};
