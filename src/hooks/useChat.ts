import { useCallback } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useVoiceStore } from '@/stores/voiceStore';
import { streamChat } from '@/lib/api';
import { tauriApi } from '@/lib/tauri';
import { generateId, extractTextContent } from '@/lib/utils';
import { Message, ContentPart } from '@/types';

export function useChat() {
  const {
    messages,
    activeConversationId,
    isStreaming,
    streamingContent,
    chatStatus,
    addMessage,
    appendStreamToken,
    appendToolCallDelta,
    finalizeStreamMessage,
    clearStreamingContent,
    setIsStreaming,
    setChatStatus,
    setAbortController,
    stopStreaming,
    updateConversation,
    newConversation,
  } = useChatStore();

  const { settings } = useSettingsStore();

  const sendMessage = useCallback(
    async (content: string) => {
      if (isStreaming || !content.trim()) return;
      if (!settings.model_id) {
        console.error('No model selected');
        return;
      }

      // Detect system payload that splits display text vs API context
      let userDisplayContent: string;
      let apiContent: string | ContentPart[];

      if (content.startsWith('{"__system_payload":true')) {
        try {
          const parsed = JSON.parse(content);
          apiContent = parsed.apiContent;
          userDisplayContent = parsed.displayContent || '[Attachment message]';
        } catch {
          apiContent = content;
          userDisplayContent = content;
        }
      } else {
        apiContent = content;
        userDisplayContent = content;
      }

      // Ensure we have an active conversation
      let convId = activeConversationId;
      if (!convId) {
        const conv = useChatStore.getState().newConversation();
        convId = conv.id;
      }

      // Add user message (display content shown in UI)
      const userMessage: Message = {
        id: generateId(),
        conversation_id: convId,
        role: 'user',
        content: userDisplayContent,
        created_at: Date.now(),
      };
      addMessage(userMessage);

      // Update conversation title from first message
      const allMessages = useChatStore.getState().messages;
      const currentMessages = allMessages.filter(m => m.conversation_id === convId);
      
      if (currentMessages.length <= 1) {
        updateConversation(convId, {
          title: userDisplayContent.slice(0, 60) + (userDisplayContent.length > 60 ? '…' : ''),
          updated_at: Date.now(),
        });
      }

      // Start streaming
      const controller = new AbortController();
      setAbortController(controller);
      setIsStreaming(true);
      setChatStatus('thinking');
      clearStreamingContent();

      try {
        // Dynamically inject temporal awareness and anti-hallucination guidelines
        let finalSystemPrompt = settings.system_prompt || 'You are a helpful AI assistant.';
        
        const now = new Date();
        const dateString = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const timeString = now.toLocaleTimeString('en-US');
        
        finalSystemPrompt += `\n\n[SYSTEM CONTEXT]\nCurrent Date: ${dateString}\nCurrent Time: ${timeString}\n`;
        finalSystemPrompt += `When using tools like web_search or answering questions about current events, prices, or facts:\n`;
        finalSystemPrompt += `- ALWAYS cite your sources by providing the exact URL links from the search results.\n`;
        finalSystemPrompt += `- State the date of the information (e.g., "As of June 7, 2026, the price is...").\n`;
        finalSystemPrompt += `- Do not hallucinate or guess facts; rely strictly on the data provided by your tools.`;

        // ─── CONTEXT WINDOW PRUNING ───
        const estimateTokens = (text: string) => Math.ceil(text.length / 4);
        
        // Reserve tokens for system prompt + max generation output
        let currentTokens = estimateTokens(finalSystemPrompt) + settings.max_tokens;

        // Reserve tokens for the NEW user message
        if (typeof apiContent === 'string') {
          currentTokens += estimateTokens(apiContent);
        } else {
          apiContent.forEach(p => {
            if (p.type === 'text' && p.text) currentTokens += estimateTokens(p.text);
            if (p.type === 'image_url') currentTokens += 85; // rough estimate
          });
        }

        // Build history from current messages
        const fullHistory = [...currentMessages].map((m) => ({
          role: m.role,
          content: m.content ?? null,
          tool_calls: m.tool_calls,
          tool_call_id: m.tool_call_id,
        }));

        // Traverse backwards and keep messages until we hit the context limit
        const prunedHistory = [];
        for (let i = fullHistory.length - 1; i >= 0; i--) {
          const msg = fullHistory[i];
          let msgTokens = 20; // JSON overhead
          if (msg.content) msgTokens += estimateTokens(msg.content);
          if (msg.tool_calls) msgTokens += 50; 
          
          if (currentTokens + msgTokens > settings.context_length) {
            console.log(`[Context Window] Truncated history at message ${i} to fit ${settings.context_length} limit.`);
            break;
          }
          currentTokens += msgTokens;
          prunedHistory.unshift(msg);
        }

        const apiMessages = [
          {
            role: 'system',
            content: finalSystemPrompt,
            tool_calls: undefined,
            tool_call_id: undefined,
          },
          ...prunedHistory,
          {
            role: 'user' as const,
            content: apiContent,
            tool_calls: undefined,
            tool_call_id: undefined,
          },
        ];

      const executeChatLoop = async (apiMessages: any[]) => {
        let firstToken = false;
        
        for await (const chunk of streamChat(settings, apiMessages, controller.signal)) {
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          if (!firstToken && (delta.content || delta.tool_calls)) {
            firstToken = true;
            setChatStatus('streaming');
          }

          if (delta.content) {
            appendStreamToken(delta.content);
          }
          if (delta.tool_calls) {
            appendToolCallDelta(delta.tool_calls);
          }

          if (chunk.choices[0]?.finish_reason === 'stop' || chunk.choices[0]?.finish_reason === 'tool_calls') {
            break;
          }
        }

        // Finalize the assistant message
        const finalMessage = finalizeStreamMessage(convId);
        
        // Handle tool calls
        if (finalMessage.tool_calls && finalMessage.tool_calls.length > 0) {
          setChatStatus('calling-tool');
          
          for (const tc of finalMessage.tool_calls) {
            if (tc.type === 'function') {
              try {
                const args = JSON.parse(tc.function.arguments);
                let result = '';
                
                if (tc.function.name === 'web_search') {
                  const searchRes = await tauriApi.webSearch(args.query);
                  result = JSON.stringify(searchRes, null, 2);
                } else if (tc.function.name === 'read_webpage') {
                  const scrapeRes = await tauriApi.fetchWebpage(args.url);
                  result = scrapeRes;
                } else {
                  result = `Error: Unknown tool ${tc.function.name}`;
                }

                // Add tool result message
                const toolMsg: Message = {
                  id: generateId(),
                  conversation_id: convId,
                  role: 'tool',
                  content: result,
                  tool_call_id: tc.id,
                  created_at: Date.now(),
                };
                addMessage(toolMsg);
                
                // Append to apiMessages for the next loop
                apiMessages.push({
                  role: 'assistant',
                  content: finalMessage.content || null,
                  tool_calls: finalMessage.tool_calls,
                });
                apiMessages.push({
                  role: 'tool',
                  content: toolMsg.content,
                  tool_call_id: toolMsg.tool_call_id,
                });
                
              } catch (e) {
                console.error('Tool execution error:', e);
                // Add error message as tool result
                const errorMsg: Message = {
                  id: generateId(),
                  conversation_id: convId,
                  role: 'tool',
                  content: `Tool execution failed: ${String(e)}`,
                  tool_call_id: tc.id,
                  created_at: Date.now(),
                };
                addMessage(errorMsg);
                
                apiMessages.push({
                  role: 'assistant',
                  content: finalMessage.content || null,
                  tool_calls: finalMessage.tool_calls,
                });
                apiMessages.push({
                  role: 'tool',
                  content: errorMsg.content,
                  tool_call_id: errorMsg.tool_call_id,
                });
              }
            }
          }
          
          setChatStatus('tool-result');
          // Automatically re-trigger LLM with new tool result context
          setIsStreaming(true);
          setChatStatus('thinking');
          clearStreamingContent();
          firstToken = false;
          await executeChatLoop(apiMessages);
          return; // exit current frame to prevent duplicate TTS on intermediate steps
        }

        // Auto-speak if enabled (only for final text output)
          // Speak aloud if enabled
          if (settings.tts_enabled) {
            const textToSpeak = extractTextContent(finalMessage.content);
            if (textToSpeak) {
              await tauriApi.speakText(textToSpeak, settings.tts_rate, settings.tts_voice);
            }
          }
      };

      await executeChatLoop(apiMessages);

      updateConversation(convId, { updated_at: Date.now() });
      } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') {
          // User stopped streaming — finalize partial content
          const { streamingContent: partial } = useChatStore.getState();
          if (partial) {
            finalizeStreamMessage(convId);
          }
        } else {
          console.error('Streaming error:', error);
          const errMsg = error instanceof Error ? error.message : 'Unknown error';
          const errorMessage: Message = {
            id: generateId(),
            conversation_id: convId,
            role: 'assistant',
            content: `⚠️ Error: ${errMsg}`,
            created_at: Date.now(),
          };
          addMessage(errorMessage);
          clearStreamingContent();
        }
      } finally {
        setIsStreaming(false);
        setChatStatus('idle');
        setAbortController(null);
      }
    },
    [
      isStreaming,
      settings,
      activeConversationId,
      addMessage,
      appendStreamToken,
      appendToolCallDelta,
      finalizeStreamMessage,
      clearStreamingContent,
      setIsStreaming,
      setChatStatus,
      setAbortController,
      updateConversation,
    ]
  );

  return {
    messages: messages.filter(m => m.conversation_id === activeConversationId),
    isStreaming,
    streamingContent,
    chatStatus,
    sendMessage,
    stopStreaming,
  };
}
