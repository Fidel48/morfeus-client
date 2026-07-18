import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MessageSquare,
  Plus,
  Settings,
  Mic,
  Search,
  Trash2,
  ChevronDown,
  ChevronRight,
  Pill,
} from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { cn, groupConversationsByDate, truncateText } from '@/lib/utils';
import { Conversation } from '@/types';

export const Sidebar: React.FC = () => {
  const {
    conversations,
    activeConversationId,
    setActiveConversation,
    deleteConversation,
    newConversation,
  } = useChatStore();
  const { openSettings } = useSettingsStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const filtered = conversations.filter((c) =>
    c.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const grouped = groupConversationsByDate(filtered);

  const toggleGroup = (label: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full bg-zinc-950/80 border-r border-white/8">
      {/* Header */}
      <div className="px-3 pt-4 pb-3 flex-shrink-0">
        {/* App logo */}
        <div className="flex items-center gap-2.5 px-1 mb-4">
          <div className="w-7 h-7 rounded-lg bg-red-500/15 flex items-center justify-center border border-red-500/25 shadow-[0_0_12px_rgba(239,68,68,0.4)]">
            <Pill size={15} className="text-red-400 rotate-45" />
          </div>
          <span className="font-semibold text-sm text-white tracking-tight">Morfeus Client</span>
        </div>

        {/* New Chat button */}
        <button
          onClick={newConversation}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-violet-600/15 border border-violet-500/25 text-violet-300 hover:bg-violet-600/25 hover:border-violet-500/40 transition-all text-sm font-medium group"
        >
          <Plus size={15} className="group-hover:rotate-90 transition-transform duration-200" />
          New Chat
        </button>

        {/* Search */}
        <div className="relative mt-2">
          <Search
            size={13}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search chats…"
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-white/5 border border-white/8 rounded-lg text-zinc-300 placeholder-zinc-600 outline-none focus:border-violet-500/40 focus:bg-white/8 transition-colors"
          />
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5 scrollbar-thin">
        {conversations.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <MessageSquare size={20} className="mx-auto text-zinc-700 mb-2" />
            <p className="text-xs text-zinc-700">No conversations yet</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <p className="text-xs text-zinc-700">No results for "{searchQuery}"</p>
          </div>
        ) : (
          grouped.map((group) => (
            <div key={group.label}>
              {/* Group header */}
              <button
                onClick={() => toggleGroup(group.label)}
                className="w-full flex items-center gap-1 px-3 py-1.5 text-[10px] font-medium text-zinc-600 uppercase tracking-wider hover:text-zinc-500 transition-colors"
              >
                {collapsedGroups.has(group.label) ? (
                  <ChevronRight size={10} />
                ) : (
                  <ChevronDown size={10} />
                )}
                {group.label}
              </button>

              <AnimatePresence>
                {!collapsedGroups.has(group.label) &&
                  group.items.map((conv) => (
                    <ConversationItem
                      key={conv.id}
                      conversation={conv}
                      isActive={conv.id === activeConversationId}
                      isHovered={conv.id === hoveredId}
                      onSelect={() => setActiveConversation(conv.id)}
                      onDelete={() => deleteConversation(conv.id)}
                      onHover={(id) => setHoveredId(id)}
                    />
                  ))}
              </AnimatePresence>
            </div>
          ))
        )}
      </div>

      {/* Bottom nav */}
      <div className="flex-shrink-0 border-t border-white/8 px-2 py-2 space-y-0.5">
        <NavButton icon={<Settings size={15} />} label="Settings" onClick={openSettings} />
      </div>
    </div>
  );
};

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  isHovered: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onHover: (id: string | null) => void;
}

const ConversationItem: React.FC<ConversationItemProps> = ({
  conversation,
  isActive,
  isHovered,
  onSelect,
  onDelete,
  onHover,
}) => (
  <motion.div
    initial={{ opacity: 0, x: -8 }}
    animate={{ opacity: 1, x: 0 }}
    exit={{ opacity: 0, x: -8 }}
    className="relative group"
    onMouseEnter={() => onHover(conversation.id)}
    onMouseLeave={() => onHover(null)}
  >
    <button
      onClick={onSelect}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-all text-xs',
        isActive
          ? 'bg-violet-600/15 border border-violet-500/25 text-white'
          : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'
      )}
    >
      <MessageSquare size={13} className="flex-shrink-0" />
      <span className="flex-1 truncate">{truncateText(conversation.title, 36)}</span>
    </button>

    {/* Delete button */}
    <AnimatePresence>
      {(isHovered || isActive) && (
        <motion.button
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-400/10 transition-colors"
          title="Delete conversation"
        >
          <Trash2 size={11} />
        </motion.button>
      )}
    </AnimatePresence>
  </motion.div>
);

interface NavButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}

const NavButton: React.FC<NavButtonProps> = ({ icon, label, onClick }) => (
  <button
    onClick={onClick}
    className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-white/5 transition-all text-xs"
  >
    {icon}
    {label}
  </button>
);
