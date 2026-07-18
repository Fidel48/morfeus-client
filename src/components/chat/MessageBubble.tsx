import React from 'react';
import { motion } from 'framer-motion';
import { Message } from '@/types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { cn } from '@/lib/utils';
import { Bot, User, Wrench, Globe, FileText, Copy, VolumeX } from 'lucide-react';
import { tauriApi } from '@/lib/tauri';

interface MessageBubbleProps {
  message: Message;
  index: number;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({ message, index }) => {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index * 0.02, 0.1) }}
      className={cn(
        'flex gap-3 w-full max-w-3xl group',
        isUser ? 'flex-row-reverse ml-auto' : 'flex-row'
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center mt-1',
          isUser
            ? 'bg-violet-600 text-white'
            : 'bg-zinc-800 border border-white/10 text-zinc-400'
        )}
      >
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>

      {/* Content */}
      <div
        className={cn(
          'flex-1 min-w-0',
          isUser ? 'items-end' : 'items-start',
          'flex flex-col'
        )}
      >
        <div
          className={cn(
            'px-4 py-3 rounded-2xl text-sm leading-relaxed',
            isUser
              ? 'bg-violet-600 text-white rounded-tr-sm max-w-[85%] self-end'
              : 'bg-zinc-900/60 border border-white/8 text-zinc-100 rounded-tl-sm w-full'
          )}
        >
          {isUser ? (
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          ) : message.tool_calls && message.tool_calls.length > 0 ? (
            <div className="flex flex-col gap-2">
              {message.content && <MarkdownRenderer content={message.content} />}
              {message.tool_calls.map((tc, idx) => {
                const toolName = tc.function?.name;
                let text = `Using tool: ${toolName || 'unknown'}`;
                let Icon = Wrench;
                
                if (toolName === 'web_search') {
                  text = 'Searching the web';
                  Icon = Globe;
                } else if (toolName === 'read_webpage') {
                  text = 'Reading webpage';
                  Icon = FileText;
                }

                return (
                  <div key={idx} className="flex items-center gap-2 text-xs text-zinc-300 bg-white/5 px-3 py-1.5 rounded-full border border-white/10 w-fit shadow-sm">
                    <Icon size={12} className="text-violet-400" />
                    <span className="font-medium">{text}</span>
                  </div>
                );
              })}
            </div>
          ) : message.content ? (
            <MarkdownRenderer content={message.content} />
          ) : (
            <div className="flex flex-col items-center gap-2 text-zinc-400 py-2">
              <span className="text-xs">⚠️ The model returned an empty response.</span>
              <span className="text-[10px] text-zinc-500 text-center max-w-[200px]">
                This usually happens if the conversation exceeded the local model's maximum context length limit, causing it to crash.
              </span>
            </div>
          )}
        </div>

        {/* Footer: Timestamp and Actions */}
        <div className={cn(
          "flex items-center mt-1.5 px-1",
          isUser ? "justify-end" : "justify-between w-full"
        )}>
          {isAssistant && message.content && (
            <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => navigator.clipboard.writeText(message.content || '')}
                className="p-1 text-zinc-500 hover:text-zinc-300 hover:bg-white/5 rounded transition-colors"
                title="Copy text"
              >
                <Copy size={12} />
              </button>
              <button
                onClick={() => tauriApi.stopSpeaking()}
                className="p-1 text-zinc-500 hover:text-zinc-300 hover:bg-white/5 rounded transition-colors"
                title="Stop speaking"
              >
                <VolumeX size={12} />
              </button>
            </div>
          )}
          <span className="text-[10px] text-zinc-600">
            {new Date(message.created_at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
      </div>
    </motion.div>
  );
};

interface StreamingMessageProps {
  content: string;
}

export const StreamingMessage: React.FC<StreamingMessageProps> = ({ content }) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex gap-3 w-full max-w-3xl flex-row"
    >
      <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center mt-1 bg-zinc-800 border border-white/10">
        <Bot size={14} className="text-violet-400 animate-pulse-slow" />
      </div>

      <div className="flex-1 min-w-0 flex flex-col items-start">
        <div className="px-4 py-3 rounded-2xl rounded-tl-sm text-sm leading-relaxed bg-zinc-900/60 border border-white/8 text-zinc-100 w-full">
          {content ? (
            <MarkdownRenderer content={content} />
          ) : (
            <div className="flex gap-1 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          )}
          {content && (
            <span className="inline-block w-0.5 h-4 bg-violet-400 ml-0.5 animate-blink align-middle" />
          )}
        </div>
      </div>
    </motion.div>
  );
};
