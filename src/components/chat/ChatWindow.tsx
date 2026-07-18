import React, { useEffect, useRef, useState, useCallback, KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Send, Square, PanelRight, Loader2, Wrench, Paperclip, X, FileText, Image as ImageIcon } from 'lucide-react';
import { MessageBubble, StreamingMessage } from './MessageBubble';
import { VoiceButton } from '@/components/voice/VoiceButton';
import { useChat } from '@/hooks/useChat';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { tauriApi } from '@/lib/tauri';
import { extractPdfText, renderPdfToImages } from '@/lib/pdfParser';
import { ContentPart } from '@/types';
import { cn, bytesToBase64, isVisionModel } from '@/lib/utils';

interface Attachment {
  name: string;
  path: string;
}

interface StatusBadgeProps {
  status: string;
}

const StatusBadge: React.FC<StatusBadgeProps> = ({ status }) => {
  const config = {
    thinking: { label: 'Thinking…', icon: <Loader2 size={12} className="animate-spin" />, color: 'text-blue-400' },
    streaming: { label: 'Generating…', icon: <Loader2 size={12} className="animate-spin" />, color: 'text-violet-400' },
    'calling-tool': { label: 'Calling tool…', icon: <Wrench size={12} />, color: 'text-amber-400' },
    'tool-result': { label: 'Tool result received', icon: <Wrench size={12} />, color: 'text-emerald-400' },
  };

  const cfg = config[status as keyof typeof config];
  if (!cfg) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      className={cn('flex items-center gap-1.5 text-xs px-2 py-1', cfg.color)}
    >
      {cfg.icon}
      <span>{cfg.label}</span>
    </motion.div>
  );
};

export const ChatWindow: React.FC = () => {
  const { messages, isStreaming, streamingContent, chatStatus, sendMessage, stopStreaming } = useChat();
  const { rightPanelOpen, toggleRightPanel } = useChatStore();
  const { settings } = useSettingsStore();
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Keep a ref to latest handleSend so auto-send never captures a stale closure
  const handleSendRef = useRef<() => void>(() => {});

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamingContent]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  const handleSend = useCallback(async () => {
    const userText = input.trim();
    if (!userText && attachments.length === 0) return;
    if (isStreaming || isParsing) return;

    setInput('');
    const currentAttachments = [...attachments];
    setAttachments([]);

    if (currentAttachments.length > 0) {
      setIsParsing(true);

      // Multimodal content array — we'll build this if any PDF needs vision
      const contentParts: ContentPart[] = [];
      let hasImages = false;
      let textContext = '';

      for (const att of currentAttachments) {
        const isPdf = att.name.toLowerCase().endsWith('.pdf');
        const isImage = /\.(png|jpe?g|gif|webp)$/i.test(att.name);

        if (isImage) {
          try {
            const bytes = await tauriApi.readFileBytes(att.path);
            const b64 = bytesToBase64(bytes);
            
            const ext = att.name.split('.').pop()?.toLowerCase();
            let mimeType = 'image/jpeg';
            if (ext === 'png') mimeType = 'image/png';
            if (ext === 'gif') mimeType = 'image/gif';
            if (ext === 'webp') mimeType = 'image/webp';

            hasImages = true;
            contentParts.push({
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${b64}` },
            });
            textContext += `\n--- File: ${att.name} (Attached Image) ---\n`;
          } catch (e) {
            console.error(`[attachment] Image error for "${att.name}":`, e);
            textContext += `\n--- File: ${att.name} ---\n[Error reading image: ${e}]\n---\n`;
          }
        } else if (isPdf) {
          try {
            const bytes = await tauriApi.readFileBytes(att.path);

            // First, try text extraction
            const text = await extractPdfText(bytes);

            if (text) {
              // Text layer exists — inject as text context
              let clipped = text.length > 12000
                ? text.slice(0, 12000) + '\n[...truncated...]'
                : text;
              textContext += `\n--- File: ${att.name} ---\n${clipped}\n---\n`;
              console.log(`[attachment] "${att.name}" text: ${clipped.length} chars`);
            } else {
              // No text layer — render pages to images and send via vision API
              console.log(`[attachment] "${att.name}" has no text layer, rendering to images...`);
              const images = await renderPdfToImages(bytes, 4);
              if (images.length > 0) {
                hasImages = true;
                textContext += `\n--- File: ${att.name} (${images.length} page image(s) attached below) ---\n`;
                for (const b64 of images) {
                  contentParts.push({
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${b64}` },
                  });
                }
              } else {
                textContext += `\n--- File: ${att.name} ---\n[Could not render PDF pages. Try a different PDF file.]\n---\n`;
              }
            }
          } catch (e) {
            console.error(`[attachment] PDF error for "${att.name}":`, e);
            textContext += `\n--- File: ${att.name} ---\n[Error reading PDF: ${e}]\n---\n`;
          }
        } else {
          // Plain text/code file — use Rust backend
          try {
            let content = await tauriApi.parseLocalFile(att.path);
            if (content.length > 12000) {
              content = content.slice(0, 12000) + '\n[...truncated...]';
            }
            textContext += `\n--- File: ${att.name} ---\n${content}\n---\n`;
          } catch (e) {
            textContext += `\n--- File: ${att.name} ---\n[Failed to read: ${e}]\n---\n`;
          }
        }
      }

      setIsParsing(false);

      const questionText = userText || 'Please analyze the attached file(s).';
      
      // Clean display text for the UI chat bubble
      const displayContent = `📎 Attached: ${currentAttachments.map(a => a.name).join(', ')}\n\n${userText}`.trim();

      if (hasImages) {
        // Build a multimodal content array for vision-capable models
        const fullText = textContext
          ? `I have attached the following files for reference:${textContext}\nUser Question/Message: ${questionText}`
          : questionText;

        const multimodalContent: ContentPart[] = [
          { type: 'text', text: fullText },
          ...contentParts,
        ];
        
        // Pass system payload so UI and API get different content
        await sendMessage(JSON.stringify({
          __system_payload: true,
          displayContent,
          apiContent: multimodalContent
        }));
      } else {
        // Pure text — normal flow, but still hide the raw text from UI!
        const finalPrompt = `I have attached the following files for reference:${textContext}\nUser Question/Message: ${questionText}`;
        
        await sendMessage(JSON.stringify({
          __system_payload: true,
          displayContent,
          apiContent: finalPrompt
        }));
      }
    } else {
      await sendMessage(userText);
    }
  }, [input, isStreaming, isParsing, sendMessage, attachments]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleVoiceTranscript = useCallback((text: string) => {
    setInput((prev) => (prev ? `${prev} ${text}` : text));
  }, []);

  // Always keep handleSendRef current so triggerAutoSend can call it without stale closures
  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);

  const triggerAutoSend = useCallback(() => {
    // Give React 100ms to flush the transcript into `input` state, then send
    setTimeout(() => {
      handleSendRef.current();
    }, 100);
  }, []);

  const handleAttachFiles = async () => {
    try {
      const paths = await tauriApi.openFileDialog();
      if (paths) {
        const newAttachments = paths.map(p => {
          const name = p.split(/[/\\]/).pop() || 'Unknown file';
          return { name, path: p };
        });
        setAttachments(prev => [...prev, ...newAttachments]);
      }
    } catch (e) {
      console.error('Failed to open file dialog:', e);
    }
  };

  const handleAttachImages = async () => {
    try {
      const paths = await tauriApi.openImageDialog();
      if (paths) {
        const newAttachments = paths.map(p => {
          const name = p.split(/[/\\]/).pop() || 'Unknown image';
          return { name, path: p };
        });
        setAttachments(prev => [...prev, ...newAttachments]);
      }
    } catch (e) {
      console.error('Failed to open image dialog:', e);
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const isEmpty = messages.length === 0 && !isStreaming;

  return (
    <div className="flex flex-col h-full relative">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/8 flex-shrink-0">
        <div className="flex items-center gap-2">
          <AnimatePresence mode="wait">
            {chatStatus !== 'idle' && <StatusBadge status={chatStatus} />}
          </AnimatePresence>
        </div>
        <button
          onClick={toggleRightPanel}
          className={cn(
            'p-2 rounded-lg transition-colors',
            rightPanelOpen
              ? 'bg-violet-600/20 text-violet-400 border border-violet-500/30'
              : 'text-zinc-500 hover:text-white hover:bg-white/8'
          )}
          title="Toggle right panel (Ctrl+\)"
        >
          <PanelRight size={16} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6 scroll-smooth">
        {isEmpty ? (
          <EmptyState />
        ) : (
          <>
            {messages.filter(m => m.role !== 'tool' && m.role !== 'system').map((message, index) => (
              <div key={message.id} className="flex justify-center">
                <MessageBubble message={message} index={index} />
              </div>
            ))}
            {isStreaming && (
              <div className="flex justify-center">
                <StreamingMessage content={streamingContent} />
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="flex-shrink-0 px-4 pb-4">
        <div className="max-w-3xl mx-auto flex flex-col gap-2">
          
          {/* Attachments Pills */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-1">
              {attachments.map((att, idx) => (
                <div key={idx} className="flex items-center gap-1.5 bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1 shadow-sm">
                  <FileText size={12} className="text-violet-400" />
                  <span className="text-xs text-zinc-300 truncate max-w-[150px]" title={att.name}>{att.name}</span>
                  <button 
                    onClick={() => removeAttachment(idx)}
                    className="p-0.5 text-zinc-500 hover:text-red-400 rounded-full transition-colors ml-1"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="relative flex items-end gap-2 bg-zinc-900/80 border border-white/10 rounded-2xl p-2 shadow-lg shadow-black/20 backdrop-blur-sm focus-within:border-violet-500/50 transition-colors">
            
            {/* Image Button (always enabled for local flexibility) */}
            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={handleAttachImages}
              disabled={isStreaming}
              className="self-end mb-0.5 p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
              title="Attach images"
            >
              <ImageIcon size={18} />
            </motion.button>

            {/* Attachment Button */}
            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={handleAttachFiles}
              className="self-end mb-0.5 p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
              title="Attach a file (PDF, TXT, MD, Code...)"
              disabled={isStreaming}
            >
              <Paperclip size={18} />
            </motion.button>

            {/* Voice button */}
            <VoiceButton 
              onTranscript={handleVoiceTranscript} 
              onAutoSend={triggerAutoSend}
              className="self-end mb-0.5" 
            />

            {/* Textarea */}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message Morfeus… (Enter to send, Shift+Enter for newline)"
              rows={1}
              className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-600 resize-none outline-none py-2 px-1 max-h-48 leading-relaxed"
              disabled={isStreaming}
            />

            {/* Send / Stop button */}
            {isParsing ? (
              <div className="self-end mb-0.5 p-2.5 rounded-xl bg-violet-600/20 text-violet-400 border border-violet-500/40 flex items-center gap-1.5 text-xs font-medium px-3">
                <Loader2 size={14} className="animate-spin" />
                <span>Reading…</span>
              </div>
            ) : isStreaming ? (
              <motion.button
                whileTap={{ scale: 0.92 }}
                onClick={stopStreaming}
                className="self-end mb-0.5 p-2.5 rounded-xl bg-red-500/20 text-red-400 border border-red-500/40 hover:bg-red-500/30 transition-colors"
                title="Stop generation"
              >
                <Square size={16} className="fill-red-400" />
              </motion.button>
            ) : (
              <motion.button
                whileTap={{ scale: 0.92 }}
                onClick={handleSend}
                disabled={!input.trim()}
                className={cn(
                  'self-end mb-0.5 p-2.5 rounded-xl transition-all duration-150',
                  input.trim()
                    ? 'bg-violet-600 text-white hover:bg-violet-500 shadow-[0_0_16px_rgba(124,58,237,0.4)]'
                    : 'text-zinc-600 cursor-not-allowed'
                )}
                title="Send message (Enter)"
              >
                <Send size={16} />
              </motion.button>
            )}
          </div>
          <p className="text-center text-[10px] text-zinc-700 mt-1">
            Morfeus may make mistakes. Verify important information.
          </p>
        </div>
      </div>
    </div>
  );
};

const EmptyState: React.FC = () => (
  <motion.div
    initial={{ opacity: 0, y: 16 }}
    animate={{ opacity: 1, y: 0 }}
    className="flex flex-col items-center justify-center h-full text-center py-20"
  >
    <div className="w-16 h-16 rounded-2xl bg-violet-600/20 border border-violet-500/30 flex items-center justify-center mb-4">
      <svg
        width="32"
        height="32"
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="text-violet-400"
      >
        <path
          d="M16 4C9.373 4 4 9.373 4 16s5.373 12 12 12 12-5.373 12-12S22.627 4 16 4z"
          fill="currentColor"
          fillOpacity="0.2"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M11 16h10M16 11v10"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </div>
    <h2 className="text-lg font-semibold text-zinc-300 mb-2">Start a conversation</h2>
    <p className="text-sm text-zinc-600 max-w-sm">
      Type a message below or hold the microphone button to speak. Connect to your LLM server in Settings.
    </p>
  </motion.div>
);
