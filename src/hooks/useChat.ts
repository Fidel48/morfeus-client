import { useCallback } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useVoiceStore } from '@/stores/voiceStore';
import { streamChat } from '@/lib/api';
import { tauriApi } from '@/lib/tauri';
import { generateId, extractTextContent } from '@/lib/utils';
import { Message, ContentPart, ToolDefinition } from '@/types';

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

      const executeChatLoop = async (isInitialUserTurn: boolean = false) => {
        // ─── CONTEXT WINDOW PRUNING ───
        const estimateTokens = (text: string) => Math.ceil(text.length / 4);
        
        // Reserve tokens for system prompt + max generation output
        let currentTokens = estimateTokens(finalSystemPrompt) + settings.max_tokens;

        // Build history from current messages in the store (excluding the very last one if it's the initial turn because we handle it specially with apiContent)
        const allMessages = useChatStore.getState().messages.filter(m => m.conversation_id === convId);
        
        // If this is the initial user turn, the last message in store is the user message.
        // If it's a tool loop, the last messages in store are tool responses.
        const historyToPrune = [...allMessages];
        
        const prunedHistory = [];
        for (let i = historyToPrune.length - 1; i >= 0; i--) {
          const msg = historyToPrune[i];
          let msgTokens = 20; // JSON overhead
          
          // Special handling: if this is the initial turn and we are at the very last message, 
          // we use the apiContent (which might contain base64 images) for token estimation.
          if (isInitialUserTurn && i === historyToPrune.length - 1) {
            if (typeof apiContent === 'string') {
              msgTokens += estimateTokens(apiContent);
            } else {
              apiContent.forEach((p: any) => {
                if (p.type === 'text' && p.text) msgTokens += estimateTokens(p.text);
                if (p.type === 'image_url') msgTokens += 85; 
              });
            }
          } else {
            if (msg.content) msgTokens += estimateTokens(msg.content);
          }
          
          if (msg.tool_calls) msgTokens += 50; 
          
          if (currentTokens + msgTokens > settings.context_length) {
            console.log(`[Context Window] Truncated history to fit ${settings.context_length} limit.`);
            break;
          }
          currentTokens += msgTokens;
          
          // Format for API
          const apiMsg: any = {
            role: msg.role,
            content: msg.content ?? null,
            tool_calls: msg.tool_calls,
            tool_call_id: msg.tool_call_id,
          };
          
          // Replace content for the last user message on initial turn
          if (isInitialUserTurn && i === historyToPrune.length - 1) {
            apiMsg.content = apiContent;
          }
          
          prunedHistory.unshift(apiMsg);
        }

        const apiMessages = [
          {
            role: 'system',
            content: finalSystemPrompt,
          },
          ...prunedHistory,
        ];

        // ─── MCP DYNAMIC TOOL INJECTION ───
        const mcpTools: ToolDefinition[] = [];
        const activeMcpServers = useChatStore.getState().activeMcpServers;
        
        for (const serverId of activeMcpServers) {
          try {
            const result = await tauriApi.mcpListTools(serverId);
            if (result && Array.isArray(result.tools)) {
              for (const tool of result.tools) {
                mcpTools.push({
                  type: 'function',
                  function: {
                    name: `mcp__${serverId}__${tool.name}`,
                    description: `[MCP Server: ${serverId}] ${tool.description || ''}`,
                    parameters: tool.inputSchema || { type: 'object', properties: {} },
                  },
                });
              }
            }
          } catch (e) {
            console.error(`Failed to list tools from MCP server ${serverId}:`, e);
          }
        }

        let firstToken = false;
        
        for await (const chunk of streamChat(settings, apiMessages, controller.signal, mcpTools)) {
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
                } else if (tc.function.name === 'read_youtube_video') {
                  result = await tauriApi.readYoutubeTranscript(args.url);
                } else if (tc.function.name === 'list_directory') {
                  const entries = await tauriApi.listDirectory(args.path);
                  const lines = entries.map(e => {
                    const size = e.size_bytes != null
                      ? e.size_bytes > 1_000_000
                        ? `${(e.size_bytes / 1_000_000).toFixed(1)} MB`
                        : e.size_bytes > 1_000
                          ? `${(e.size_bytes / 1_000).toFixed(1)} KB`
                          : `${e.size_bytes} B`
                      : '';
                    return e.is_dir
                      ? `📁 ${e.name}/`
                      : `📄 ${e.name}${size ? ` (${size})` : ''}`;
                  });
                  result = `Contents of ${args.path}:\n${lines.join('\n')}`;
                } else if (tc.function.name === 'get_special_dirs') {
                  const dirs = await tauriApi.getSpecialDirs();
                  result = `User's special directories:\n${JSON.stringify(dirs, null, 2)}`;
                } else if (tc.function.name === 'lsp_start_server') {
                  await tauriApi.lspStartServer(args.languageId, args.command, args.args, args.workspaceRoot);
                  result = `LSP server started successfully for language ID: ${args.languageId}`;
                } else if (tc.function.name === 'lsp_goto_definition') {
                  const defRes = await tauriApi.lspGotoDefinition(args.languageId, args.filePath, args.line, args.col);
                  result = JSON.stringify(defRes, null, 2);
                } else if (tc.function.name === 'mcp_start_server') {
                  await tauriApi.mcpStartServer(args.id, args.command, args.args, args.env || {});
                  useChatStore.getState().addMcpServer(args.id);
                  result = `MCP server started successfully with ID: ${args.id}. The tools will be available in the next turn.`;
                } else if (tc.function.name.startsWith('mcp__')) {
                  // Format: mcp__SERVERID__TOOLNAME
                  const parts = tc.function.name.split('__');
                  if (parts.length >= 3) {
                    const serverId = parts[1];
                    const toolName = parts.slice(2).join('__');
                    const callRes = await tauriApi.mcpCallTool(serverId, toolName, args);
                    result = JSON.stringify(callRes, null, 2);
                  } else {
                    result = `Error: Invalid MCP tool name format: ${tc.function.name}`;
                  }
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
                // We DO NOT manually append to apiMessages here anymore,
                // because the recursive executeChatLoop() will rebuild and prune it 
                // directly from useChatStore state!
                
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
                
                // We DO NOT manually append to apiMessages here anymore,
                // because the recursive executeChatLoop() will rebuild and prune it 
                // directly from useChatStore state!
              }
            }
          }
          
          setChatStatus('tool-result');
          // Automatically re-trigger LLM with new tool result context
          setIsStreaming(true);
          setChatStatus('thinking');
          clearStreamingContent();
          firstToken = false;
          await executeChatLoop(false);
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

      await executeChatLoop(true);

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
