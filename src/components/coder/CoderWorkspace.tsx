import React, { useState } from 'react';
import { ChatWindow } from '@/components/chat/ChatWindow';
import { useProjectStore } from '@/stores/projectStore';
import { ProjectExplorer } from './ProjectExplorer';
import { CodeEditorView } from './CodeEditorView';
import { ProjectPicker } from './ProjectPicker';
import { PanelRightClose, PanelRightOpen, Bot } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 3-Column VS Code + Cline Developer IDE Workspace:
 * - Left: Interactive Project File Explorer & Session Manager
 * - Center: Full Code Editor (tabs, line numbers, diff view, execution console)
 * - Right: Agent Coder (autonomous AI developer assistant panel)
 */
export const CoderWorkspace: React.FC = () => {
  const activeProjectPath = useProjectStore((s) => s.activeProjectPath);
  const [agentPanelOpen, setAgentPanelOpen] = useState(true);

  if (!activeProjectPath) return <ProjectPicker />;

  return (
    <div className="flex flex-1 h-full overflow-hidden bg-zinc-950">
      {/* 1. Left Column: Project Explorer (~256px) */}
      <div className="w-64 flex-shrink-0 border-r border-white/8 overflow-hidden flex flex-col">
        <ProjectExplorer />
      </div>

      {/* 2. Center Column: Code Editor View (flex-1) */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden relative">
        <CodeEditorView />

        {/* Toggle button if agent panel is collapsed */}
        {!agentPanelOpen && (
          <button
            onClick={() => setAgentPanelOpen(true)}
            className="absolute top-2 right-3 z-20 flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 hover:bg-indigo-600/30 text-xs font-medium shadow-md transition-all"
            title="Open Agent Coder panel"
          >
            <Bot size={13} />
            <span>Agent Coder</span>
            <PanelRightOpen size={12} />
          </button>
        )}
      </div>

      {/* 3. Right Column: Agent Coder AI Assistant (~450px) */}
      {agentPanelOpen && (
        <div className="w-[450px] flex-shrink-0 border-l border-white/8 overflow-hidden flex flex-col bg-zinc-950 relative">
          <ChatWindow />
        </div>
      )}
    </div>
  );
};
