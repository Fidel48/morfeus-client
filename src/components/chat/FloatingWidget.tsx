import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bot, Sparkles, X, Terminal, Globe, Minimize2, Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useChatStore } from '@/stores/chatStore';

export const FloatingWidget: React.FC = () => {
  const { isAgenticMode, chatStatus } = useChatStore();
  const [isMinimized, setIsMinimized] = useState(false);

  if (!isAgenticMode) return null;

  return (
    <motion.div
      drag
      dragConstraints={{ left: -500, right: 0, top: -500, bottom: 0 }}
      dragElastic={0.1}
      dragMomentum={false}
      initial={{ opacity: 0, scale: 0.9, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9, y: 20 }}
      className="absolute bottom-24 right-8 z-50 flex flex-col gap-2 shadow-2xl"
      style={{ touchAction: 'none' }}
    >
      <div className={cn(
        "bg-zinc-900/90 backdrop-blur-xl border border-white/10 rounded-2xl overflow-hidden transition-all duration-300",
        isMinimized ? "w-14 h-14" : "w-72"
      )}>
        {/* Header / Orb */}
        <div className="flex items-center justify-between p-3 cursor-grab active:cursor-grabbing border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center",
                chatStatus !== 'idle' ? "bg-indigo-500/20 text-indigo-400" : "bg-zinc-800 text-zinc-400"
              )}>
                <Bot size={16} />
              </div>
              {chatStatus !== 'idle' && (
                <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-indigo-500 rounded-full animate-ping" />
              )}
            </div>
            {!isMinimized && (
              <span className="text-sm font-medium text-white/90 flex items-center gap-1.5">
                Agentic Assist
                <Sparkles size={12} className="text-indigo-400" />
              </span>
            )}
          </div>
          {!isMinimized && (
            <button 
              onClick={(e) => { e.stopPropagation(); setIsMinimized(true); }}
              className="text-zinc-500 hover:text-white transition-colors p-1"
            >
              <Minimize2 size={14} />
            </button>
          )}
        </div>

        {/* Content */}
        <AnimatePresence>
          {!isMinimized && (
            <motion.div 
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="p-4"
            >
              <div className="text-xs text-indigo-300/80 mb-4 bg-indigo-500/10 p-2.5 rounded-lg border border-indigo-500/20">
                {chatStatus === 'thinking' ? 'Analyzing screen & intent...' :
                 chatStatus === 'streaming' ? 'Executing autonomous actions...' :
                 'I am ready to proactively assist you with autonomous tasks.'}
              </div>
              
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs bg-white/5 px-2.5 py-2 rounded-lg border border-white/5">
                  <Globe size={13} className="text-blue-400" />
                  <span className="text-zinc-300">Web Research</span>
                  <span className="ml-auto text-[9px] uppercase font-bold tracking-wider text-emerald-500/80">Active</span>
                </div>
                <div className="flex items-center gap-2 text-xs bg-white/5 px-2.5 py-2 rounded-lg border border-white/5">
                  <Terminal size={13} className="text-orange-400" />
                  <span className="text-zinc-300">System Execution</span>
                  <span className="ml-auto text-[9px] uppercase font-bold tracking-wider text-emerald-500/80">Active</span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {isMinimized && (
        <button
          onClick={() => setIsMinimized(false)}
          className="absolute -top-2 -right-2 bg-zinc-800 border border-white/10 rounded-full p-1.5 text-zinc-400 hover:text-white shadow-lg z-10"
        >
          <Maximize2 size={12} />
        </button>
      )}
    </motion.div>
  );
};
