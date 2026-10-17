import React, { useEffect, useRef, useState, useCallback, KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Send, Square, PanelRight, Loader2, Wrench, Paperclip, X, FileText, Image as ImageIcon, Sparkles, AlertTriangle, Check, Zap, Code2, Volume2, VolumeX, Atom, ChevronUp, RefreshCw, Settings, Search } from 'lucide-react';
import { MessageBubble, StreamingMessage } from './MessageBubble';
import { VoiceButton } from '@/components/voice/VoiceButton';
import { useChat } from '@/hooks/useChat';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { tauriApi } from '@/lib/tauri';
import { extractPdfText, renderPdfToImages } from '@/lib/pdfParser';
import { ContentPart, Message } from '@/types';
import { cn, bytesToBase64, isVisionModel, resizeImage } from '@/lib/utils';

interface Attachment {
  name: string;
  path?: string;
  file?: File;
  previewUrl?: string;
  base64?: string;
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
  const { messages, isStreaming, streamingContent, streamingReasoning, chatStatus, sendMessage, stopStreaming } = useChat();
  const { rightPanelOpen, toggleRightPanel, chatMode, setChatMode, pendingApproval } = useChatStore();
  const {
    settings,
    updateSettings,
    openSettings,
    availableModels,
    isLoadingModels,
    fetchAvailableModels,
  } = useSettingsStore();
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const handleSendRef = useRef<(overrideText?: string | React.MouseEvent) => Promise<void> | void>(() => {});

  const isDeepSeekR1 = useCallback((id?: string) => {
    if (!id) return false;
    const s = id.toLowerCase();
    return s.includes('deepseek-r1') || s.includes('deepseek_r1') || (s.includes('deepseek') && s.includes('r1'));
  }, []);

  const isFastMode = chatMode === 'fast';
  const activeModelName = isFastMode
    ? (settings.fast_chat_model_id || settings.model_id)
    : (settings.agent_coder_model_id || settings.model_id);

  const activeModelShortName = activeModelName.split('/').pop() || activeModelName || 'Select Model';

  const filteredModels = availableModels.filter(m =>
    m.id.toLowerCase().includes(modelSearchQuery.toLowerCase().trim())
  );

  // Pre-fetch models on mount if empty
  useEffect(() => {
    if (availableModels.length === 0 && settings.base_url) {
      fetchAvailableModels().catch(() => {});
    }
  }, [availableModels.length, settings.base_url, fetchAvailableModels]);

  // Close model menu when clicking outside
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setIsModelMenuOpen(false);
      }
    };
    if (isModelMenuOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [isModelMenuOpen]);

  const handleToggleModelMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsModelMenuOpen((prev) => {
      const next = !prev;
      if (next && availableModels.length === 0) {
        fetchAvailableModels().catch(() => {});
      }
      return next;
    });
  };

  const handleSelectModel = (modelId: string) => {
    if (isFastMode) {
      updateSettings({ fast_chat_model_id: modelId, model_id: modelId });
    } else {
      updateSettings({ agent_coder_model_id: modelId, model_id: modelId });
    }
    setIsModelMenuOpen(false);
  };

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamingContent]);
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  // Tab/Enter to Act, Escape to Deny
  useEffect(() => {
    if (!pendingApproval) return;

    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        pendingApproval.resolve(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        pendingApproval.resolve(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pendingApproval]);



  const handleSend = useCallback(async (overrideText?: string | React.MouseEvent) => {
    const textParam = typeof overrideText === 'string' ? overrideText : undefined;
    const rawText = textParam !== undefined ? textParam : input;
    const userText = rawText.trim();
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
            let b64 = att.base64;
            if (!b64) {
              let bytes: Uint8Array;
              if (att.file) {
                const arrayBuffer = await att.file.arrayBuffer();
                bytes = new Uint8Array(arrayBuffer);
              } else if (att.path) {
                bytes = await tauriApi.readFileBytes(att.path);
              } else {
                throw new Error("No file or path provided");
              }
              b64 = bytesToBase64(bytes);
            }
            
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
            let bytes: Uint8Array;
            if (att.file) {
              const arrayBuffer = await att.file.arrayBuffer();
              bytes = new Uint8Array(arrayBuffer);
            } else if (att.path) {
              bytes = await tauriApi.readFileBytes(att.path);
            } else {
              throw new Error("No file or path provided");
            }

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
            let content = '';
            if (att.file) {
              content = await att.file.text();
            } else if (att.path) {
              content = await tauriApi.parseLocalFile(att.path);
            }
            if (content.length > 12000) {
              content = content.slice(0, 12000) + '\n[...truncated...]';
            }
            textContext += `\n--- File: ${att.name} ---\n${content}\n---\n`;
          } catch (e) {
            textContext += `\n--- File: ${att.name} ---\n[Failed to read: ${e}]\n---\n`;
          }
        }
      }

      let rulesContext = '';
      if (currentAttachments.length > 0) {
        try {
          const firstPathAtt = currentAttachments.find(a => a.path);
          if (firstPathAtt && firstPathAtt.path) {
            const rules = await tauriApi.findProjectRules(firstPathAtt.path);
            for (const rule of rules) {
               rulesContext += `\n--- Project Rule (${rule.file_name}) ---\n${rule.content}\n---\n`;
            }
            if (rules.length > 0) {
              console.log(`[context] Injected ${rules.length} project rule file(s).`);
            }
          }
        } catch (e) {
          console.error('Failed to load project rules', e);
        }
      }

      setIsParsing(false);

      const questionText = userText || 'Please analyze the attached file(s).';
      
      // Clean display text for the UI chat bubble
      const imageDisplays = currentAttachments
        .filter(a => /\.(png|jpe?g|gif|webp)$/i.test(a.name) && (a.previewUrl || a.base64))
        .map(a => `![${a.name}](${a.previewUrl || `data:image/jpeg;base64,${a.base64}`})`)
        .join('\n\n');
      
      const fileNames = currentAttachments
        .filter(a => !/\.(png|jpe?g|gif|webp)$/i.test(a.name))
        .map(a => a.name)
        .join(', ');

      const attachText = fileNames ? `📎 Attached: ${fileNames}\n\n` : '';
      const displayContent = `${attachText}${imageDisplays}\n\n${userText}`.trim();

      if (hasImages) {
        // Build a multimodal content array for vision-capable models
        const fullText = textContext
          ? `I have attached the following files for reference:${textContext}\n${rulesContext ? "\n--- Context Rules ---\n" + rulesContext : ""}\nUser Question/Message: ${questionText}`
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
        const finalPrompt = `I have attached the following files for reference:${textContext}\n${rulesContext ? "\n--- Context Rules ---\n" + rulesContext : ""}\nUser Question/Message: ${questionText}`;
        
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
    setInput(text);
  }, []);

  // Always keep handleSendRef current so triggerAutoSend can call it without stale closures
  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);

  const triggerAutoSend = useCallback((overrideText?: string) => {
    handleSendRef.current(overrideText);
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
        const newAttachments: Attachment[] = [];
        for (const p of paths) {
          const name = p.split(/[/\\]/).pop() || 'Unknown image';
          try {
            const bytes = await tauriApi.readFileBytes(p);
            const blob = new Blob([bytes], { type: 'image/jpeg' });
            const { base64 } = await resizeImage(blob, 1024);
            newAttachments.push({ name, path: p, previewUrl: `data:image/jpeg;base64,${base64}`, base64 });
          } catch(e) {
            newAttachments.push({ name, path: p }); // fallback to just path
          }
        }
        setAttachments(prev => [...prev, ...newAttachments]);
      }
    } catch (e) {
      console.error('Failed to open image dialog:', e);
    }
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const newAttachments: Attachment[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          const ext = file.type.split('/')[1] || 'bin';
          const fileName = file.name === 'image.png' ? `pasted_image_${Date.now()}.${ext}` : (file.name || `Pasted file.${ext}`);
          
          if (file.type.startsWith('image/')) {
            try {
              const { base64 } = await resizeImage(file, 1024);
              newAttachments.push({
                name: fileName,
                file: file,
                previewUrl: `data:${file.type};base64,${base64}`,
                base64
              });
            } catch(e) {
              newAttachments.push({ name: fileName, file: file });
            }
          } else {
            newAttachments.push({ name: fileName, file: file });
          }
        }
      }
    }

    if (newAttachments.length > 0) {
      setAttachments(prev => [...prev, ...newAttachments]);
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  // Consolidate duplicate web_search badges so only ONE Web Search indicator is shown per user turn
  const displayMessages = React.useMemo(() => {
    const filtered = messages.filter(m => m.role !== 'tool' && m.role !== 'system');
    const result: Message[] = [];
    let seenWebSearchInTurn = false;

    for (const msg of filtered) {
      if (msg.role === 'user') {
        seenWebSearchInTurn = false;
        result.push(msg);
        continue;
      }

      const hasWebSearch = msg.tool_calls?.some(tc => tc.function?.name === 'web_search' || tc.function?.name === 'read_webpage');
      const isToolCallOnly = msg.tool_calls && msg.tool_calls.length > 0 && !msg.content?.trim();

      if (hasWebSearch && isToolCallOnly) {
        if (seenWebSearchInTurn) {
          // Skip duplicate web_search / read_webpage badges in the same user turn
          continue;
        }
        seenWebSearchInTurn = true;
      }

      result.push(msg);
    }

    return result;
  }, [messages]);

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

        {/* Chat Mode Selector (Center) */}
        <div className="absolute left-1/2 -translate-x-1/2 flex items-center bg-zinc-950/80 p-0.5 rounded-full border border-white/10 backdrop-blur-md shadow-lg">
          <button
            onClick={() => setChatMode('fast')}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all duration-200 cursor-pointer',
              chatMode === 'fast'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm shadow-emerald-500/10'
                : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
            )}
            title="Fast Chat: Lightning-fast responses with web search & local PC file summarization"
          >
            <Zap size={13} className={cn(chatMode === 'fast' ? 'text-emerald-400 fill-emerald-400/30' : 'text-zinc-500')} />
            <span>Fast Chat</span>
          </button>

          <button
            onClick={() => setChatMode('agent')}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-all duration-200 cursor-pointer',
              chatMode === 'agent'
                ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 shadow-sm shadow-indigo-500/10'
                : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
            )}
            title="Agent Coder: Full IDE developer harness with code execution, file editing, terminal & MCP servers"
          >
            <Code2 size={13} className={cn(chatMode === 'agent' ? 'text-indigo-400' : 'text-zinc-500')} />
            <span>Agent Coder</span>
          </button>
        </div>

        <div className="flex items-center gap-1">
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
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6 scroll-smooth">
        {isEmpty ? (
          <EmptyState />
        ) : (
          <>
            {displayMessages.map((message, index) => (
              <div key={message.id} className="flex justify-center">
                <MessageBubble message={message} index={index} />
              </div>
            ))}
            {isStreaming && (
              <div className="flex justify-center">
                <StreamingMessage content={streamingContent} reasoning={streamingReasoning} />
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="flex-shrink-0 px-4 pb-4">
        <div className="max-w-3xl mx-auto flex flex-col gap-2">
          
          {/* Attachments Pills & Previews */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-1">
              {attachments.map((att, idx) => (
                <div key={idx} className="flex items-center gap-1.5 bg-zinc-800 border border-zinc-700 rounded-md shadow-sm relative group p-1">
                  {att.previewUrl ? (
                    <img src={att.previewUrl} alt={att.name} className="w-12 h-12 object-cover rounded" />
                  ) : (
                    <div className="flex items-center gap-1.5 px-2 py-1">
                      <FileText size={12} className="text-violet-400" />
                      <span className="text-xs text-zinc-300 truncate max-w-[150px]" title={att.name}>{att.name}</span>
                    </div>
                  )}
                  <button 
                    onClick={() => removeAttachment(idx)}
                    className="absolute -top-2 -right-2 bg-zinc-800 hover:bg-red-500 border border-zinc-700 text-zinc-400 hover:text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-all shadow-md z-10"
                    title="Remove attachment"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="relative flex flex-col bg-zinc-900/90 border border-white/10 focus-within:border-violet-500/50 rounded-2xl p-2.5 shadow-lg shadow-black/20 backdrop-blur-sm transition-all duration-300 gap-2">
            
            {/* Textarea */}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={
                chatMode === 'fast'
                  ? "Fast Chat: Ask questions, search web, or summarize PC files… (Enter to send)"
                  : "Agent Coder: Build, refactor, run commands, or code tasks… (Enter to send)"
              }
              rows={1}
              className="w-full bg-transparent text-sm text-zinc-100 placeholder-zinc-500 resize-none outline-none py-1 px-1.5 max-h-48 leading-relaxed"
              disabled={isStreaming}
            />

            {/* Bottom action bar */}
            <div className="flex items-center justify-between pt-1 border-t border-white/5 gap-2">
              
              {/* Left action tools */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {/* [ ⚛️ Think ] Toggle Pill */}
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.94 }}
                  onClick={() => updateSettings({ think_enabled: !(settings.think_enabled ?? true) })}
                  className={cn(
                    'px-3 py-1 rounded-full flex items-center gap-1.5 text-xs font-medium transition-all duration-200 select-none cursor-pointer',
                    (settings.think_enabled ?? true)
                      ? 'bg-white text-zinc-950 shadow-sm hover:bg-zinc-100'
                      : 'bg-zinc-800/80 text-zinc-400 hover:text-zinc-200 border border-white/10'
                  )}
                  title={
                    (settings.think_enabled ?? true)
                      ? 'Thinking Mode is ON (Click to disable reasoning and save tokens/time)'
                      : 'Thinking Mode is OFF (Immediate fast response, no reasoning tokens)'
                  }
                >
                  <Atom
                    size={14}
                    className={cn(
                      'transition-colors',
                      (settings.think_enabled ?? true) ? 'text-zinc-950' : 'text-zinc-400'
                    )}
                  />
                  <span>Think</span>
                </motion.button>

                {/* Attach Images */}
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.92 }}
                  onClick={handleAttachImages}
                  disabled={isStreaming}
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
                  title="Attach images"
                >
                  <ImageIcon size={16} />
                </motion.button>

                {/* Attach Files */}
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.92 }}
                  onClick={handleAttachFiles}
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
                  title="Attach a file (PDF, TXT, MD, Code...)"
                  disabled={isStreaming}
                >
                  <Paperclip size={16} />
                </motion.button>

                {/* Voice button */}
                <VoiceButton 
                  currentInput={input}
                  onTranscript={handleVoiceTranscript} 
                  onAutoSend={triggerAutoSend}
                />

                {/* Voice Readout Toggle Pill */}
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.94 }}
                  onClick={() => {
                    const nextTts = !settings.tts_enabled;
                    updateSettings({
                      tts_enabled: nextTts,
                      ...(!nextTts ? { continuous_voice: false } : {}),
                    });
                  }}
                  className={cn(
                    'hidden sm:flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all select-none border',
                    settings.tts_enabled
                      ? 'bg-violet-600/15 text-violet-300 border-violet-500/35 shadow-[0_0_8px_rgba(139,92,246,0.2)] hover:bg-violet-600/25'
                      : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5 border-white/5'
                  )}
                  title={settings.tts_enabled ? 'Voice readout is ON: Morfeus speaks responses using Kokoro TTS. Click to mute.' : 'Voice readout is OFF: Silent text-only responses. Click to unmute.'}
                >
                  {settings.tts_enabled ? <Volume2 size={13} className="text-violet-400" /> : <VolumeX size={13} />}
                  <span>{settings.tts_enabled ? 'Voice On' : 'Voice Off'}</span>
                </motion.button>

                {/* Active Model Indicator Pill with in-place Dropdown */}
                <div className="relative" ref={modelMenuRef}>
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.94 }}
                    onClick={handleToggleModelMenu}
                    className={cn(
                      'hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-mono transition-all max-w-[200px] select-none',
                      isModelMenuOpen
                        ? 'bg-white/15 text-white border-white/20 shadow-md'
                        : 'bg-white/5 hover:bg-white/10 border-white/8 text-zinc-400 hover:text-zinc-200'
                    )}
                    title={`Click to switch model for ${isFastMode ? 'Fast Chat' : 'Agent Coder'}. Active: ${activeModelName}`}
                  >
                    <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', isFastMode ? 'bg-emerald-400' : 'bg-indigo-400')} />
                    <span className="truncate">{activeModelShortName}</span>
                    <ChevronUp size={12} className={cn('transition-transform duration-200 text-zinc-500', isModelMenuOpen ? 'rotate-180' : '')} />
                  </motion.button>

                  {/* Floating Model Selection Popover */}
                  <AnimatePresence>
                    {isModelMenuOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: 8, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 8, scale: 0.96 }}
                        transition={{ duration: 0.15 }}
                        className="absolute bottom-full mb-2 left-0 w-72 sm:w-80 bg-zinc-950/95 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl p-2.5 z-50 overflow-hidden flex flex-col gap-2"
                      >
                        {/* Header */}
                        <div className="flex items-center justify-between px-2 pt-1 pb-1 border-b border-white/5">
                          <div className="flex items-center gap-1.5">
                            {isFastMode ? (
                              <Zap size={14} className="text-emerald-400" />
                            ) : (
                              <Code2 size={14} className="text-indigo-400" />
                            )}
                            <span className="text-xs font-semibold text-zinc-200">
                              {isFastMode ? 'Fast Chat Model' : 'Agent Coder Model'}
                            </span>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => fetchAvailableModels()}
                              className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
                              title="Refresh models from server"
                            >
                              <RefreshCw size={12} className={cn(isLoadingModels && 'animate-spin text-violet-400')} />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setIsModelMenuOpen(false);
                                openSettings();
                              }}
                              className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
                              title="Open full Settings"
                            >
                              <Settings size={12} />
                            </button>
                          </div>
                        </div>

                        {/* Search bar if > 4 models */}
                        {availableModels.length > 4 && (
                          <div className="relative px-1">
                            <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                            <input
                              type="text"
                              value={modelSearchQuery}
                              onChange={(e) => setModelSearchQuery(e.target.value)}
                              placeholder="Search models..."
                              className="w-full pl-7 pr-2 py-1 text-xs bg-white/5 border border-white/8 rounded-lg text-zinc-200 placeholder-zinc-500 outline-none focus:border-violet-500/50"
                              autoFocus
                            />
                          </div>
                        )}

                        {/* Model list */}
                        <div className="max-h-60 overflow-y-auto space-y-1 pr-0.5 custom-scrollbar">
                          {isLoadingModels && availableModels.length === 0 ? (
                            <div className="py-6 flex flex-col items-center justify-center text-xs text-zinc-500 gap-1.5">
                              <Loader2 size={16} className="animate-spin text-violet-400" />
                              <span>Fetching models from {settings.base_url.split('/')[2] || 'server'}…</span>
                            </div>
                          ) : filteredModels.length === 0 ? (
                            <div className="py-6 px-3 text-center text-xs text-zinc-500 flex flex-col items-center gap-2">
                              <span>{availableModels.length === 0 ? 'No models loaded on server.' : 'No matching models.'}</span>
                              <button
                                type="button"
                                onClick={() => {
                                  setIsModelMenuOpen(false);
                                  openSettings();
                                }}
                                className="px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-[11px] text-zinc-300 transition-colors border border-white/10"
                              >
                                Configure Server in Settings
                              </button>
                            </div>
                          ) : (
                            filteredModels.map((m) => {
                              const isSelected = m.id === activeModelName;
                              const isR1 = isDeepSeekR1(m.id);
                              return (
                                <button
                                  key={m.id}
                                  type="button"
                                  onClick={() => handleSelectModel(m.id)}
                                  className={cn(
                                    'w-full flex items-center justify-between px-2.5 py-2 rounded-xl text-left text-xs transition-all group select-none',
                                    isSelected
                                      ? isFastMode
                                        ? 'bg-emerald-500/15 text-emerald-200 border border-emerald-500/30 shadow-sm'
                                        : 'bg-indigo-500/15 text-indigo-200 border border-indigo-500/30 shadow-sm'
                                      : 'text-zinc-300 hover:text-white hover:bg-white/8 border border-transparent'
                                  )}
                                >
                                  <div className="flex items-center gap-2 min-w-0 pr-2">
                                    <span className={cn(
                                      'w-1.5 h-1.5 rounded-full flex-shrink-0',
                                      isSelected ? (isFastMode ? 'bg-emerald-400' : 'bg-indigo-400') : 'bg-zinc-600'
                                    )} />
                                    <span className="font-mono truncate">{m.id}</span>
                                    {isR1 && (
                                      <span className="px-1.5 py-0.2 rounded text-[9px] bg-violet-500/20 text-violet-300 font-sans border border-violet-500/30 flex-shrink-0">
                                        Reasoning
                                      </span>
                                    )}
                                  </div>
                                  {isSelected && (
                                    <Check size={13} className={cn('flex-shrink-0', isFastMode ? 'text-emerald-400' : 'text-indigo-400')} />
                                  )}
                                </button>
                              );
                            })
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              {/* Right: Send / Stop button */}
              <div className="flex items-center gap-2">
                {isParsing ? (
                  <div className="p-2 rounded-xl bg-violet-600/20 text-violet-400 border border-violet-500/40 flex items-center gap-1.5 text-xs font-medium px-3">
                    <Loader2 size={14} className="animate-spin" />
                    <span>Reading…</span>
                  </div>
                ) : isStreaming ? (
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.92 }}
                    onClick={stopStreaming}
                    className="p-2 rounded-xl bg-red-500/20 text-red-400 border border-red-500/40 hover:bg-red-500/30 transition-colors"
                    title="Stop generation"
                  >
                    <Square size={15} className="fill-red-400" />
                  </motion.button>
                ) : (
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.92 }}
                    onClick={() => handleSend()}
                    disabled={!input.trim() && attachments.length === 0}
                    className={cn(
                      'p-2 rounded-xl transition-all duration-300',
                      !input.trim() && attachments.length === 0
                        ? 'text-zinc-600 cursor-not-allowed bg-transparent'
                        : 'bg-violet-600 text-white hover:bg-violet-500 shadow-[0_0_16px_rgba(124,58,237,0.4)]'
                    )}
                    title="Send message (Enter)"
                  >
                    <Send size={15} />
                  </motion.button>
                )}
              </div>
            </div>
          </div>
          <p className="text-center text-[10px] text-zinc-700 mt-1">
            Morfeus may make mistakes. Verify important information.
          </p>
        </div>
      </div>

      {/* Tool Approval Modal */}
      <AnimatePresence>
        {pendingApproval && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 max-w-md w-full shadow-2xl flex flex-col gap-4"
            >
              <div className="flex items-center gap-3 text-amber-400">
                <AlertTriangle size={24} />
                <h3 className="text-lg font-medium text-white">Action Requires Approval</h3>
              </div>
              
              <p className="text-sm text-zinc-300">
                Morfeus is attempting to execute a potentially destructive action. Do you approve?
              </p>

              <div className="bg-black/50 border border-white/5 rounded-lg p-3 overflow-x-auto text-xs font-mono text-zinc-300">
                <div className="text-violet-400 mb-1">{pendingApproval.toolName}</div>
                <pre>{JSON.stringify(pendingApproval.args, null, 2)}</pre>
              </div>

              <div className="flex items-center justify-end gap-3 mt-2">
                <button
                  onClick={() => pendingApproval.resolve(false)}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
                >
                  Deny
                </button>
                <button
                  onClick={() => pendingApproval.resolve(true)}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30 transition-colors flex items-center gap-2"
                >
                  <Check size={16} />
                  Approve Execution
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
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
