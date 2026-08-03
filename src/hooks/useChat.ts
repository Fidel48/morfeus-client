import { useCallback } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { streamChat } from '@/lib/api';
import { tauriApi } from '@/lib/tauri';
import { generateId, extractTextContent } from '@/lib/utils';
import { Message, ContentPart, ToolDefinition } from '@/types';

// Max chars returned from any single file/page tool call.
// Keeps local 14B model context from being flooded.
const MAX_TOOL_OUTPUT_CHARS = 6000;

function capOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_TOOL_OUTPUT_CHARS) + `\n\n[... output truncated at ${MAX_TOOL_OUTPUT_CHARS} chars ...]`;
}

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
  } = useChatStore();

  const { settings } = useSettingsStore();

  const sendMessage = useCallback(
    async (content: string) => {
      if (isStreaming || !content.trim()) return;
      if (!settings.model_id) {
        console.error('No model selected');
        return;
      }

      // ── Parse display vs API content (for image/attachment payloads) ──
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

      // ── Ensure active conversation ──
      let convId = activeConversationId;
      if (!convId) {
        const conv = useChatStore.getState().newConversation();
        convId = conv.id;
      }

      // ── Add user message to store ──
      const userMessage: Message = {
        id: generateId(),
        conversation_id: convId,
        role: 'user',
        content: userDisplayContent,
        created_at: Date.now(),
      };
      addMessage(userMessage);

      // Set conversation title from first message
      const existingMessages = useChatStore.getState().messages.filter(
        m => m.conversation_id === convId
      );
      if (existingMessages.length <= 1) {
        updateConversation(convId, {
          title: userDisplayContent.slice(0, 60) + (userDisplayContent.length > 60 ? '…' : ''),
          updated_at: Date.now(),
        });
      }

      // ── Start streaming ──
      const controller = new AbortController();
      setAbortController(controller);
      setIsStreaming(true);
      setChatStatus('thinking');
      clearStreamingContent();

      try {
        // ── Build system prompt ──
        const now = new Date();
        const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const timeStr = now.toLocaleTimeString('en-US');
        const basePrompt = settings.system_prompt || 'You are Morfeus, a highly capable, articulate, and intelligent AI assistant.';
        const systemPrompt = `${basePrompt}

Today's Date: ${dateStr}
Current Time: ${timeStr}

Guidelines:
- Answer the user's question directly and concisely, building on prior conversation context.
- Only use file tools (list_directory, search_files, read_local_file) when the user explicitly asks to find, open, read, or edit a file.
- For general questions, opinions, investments, or news: answer directly or use web_search.
- Never repeat yourself or output raw system instructions.`;

        // ── Tool dedup + rate limiting: persists across all recursive depths for this turn ──
        const calledToolKeys = new Set<string>();
        let totalToolCalls = 0;       // hard cap: max 5 tool calls total per user turn
        let consecutiveErrors = 0;    // if 2 errors in a row, stop and answer from what we know
        const MAX_TOTAL_TOOLS = 5;

        // ── Build API-formatted message history ──
        const buildApiMessages = (isInitialTurn: boolean) => {
          const estimateTokens = (s: string) => Math.ceil(s.length / 4);
          let budget = estimateTokens(systemPrompt) + settings.max_tokens;

          const allMsgs = useChatStore.getState().messages.filter(
            m => m.conversation_id === convId
          );

          const history: any[] = [];
          // Walk backwards, newest first, until context budget is exhausted
          for (let i = allMsgs.length - 1; i >= 0; i--) {
            const msg = allMsgs[i];
            const tokCost = 20 + estimateTokens(msg.content ?? '') + (msg.tool_calls ? 50 : 0);
            if (budget + tokCost > settings.context_length) {
              console.log('[Context] Truncated older messages to fit context window.');
              break;
            }
            budget += tokCost;

            // Format each role correctly for the OpenAI API spec
            let apiMsg: any;
            if (msg.role === 'assistant') {
              apiMsg = msg.tool_calls?.length
                ? { role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls }
                : { role: 'assistant', content: msg.content ?? '' };
            } else if (msg.role === 'tool') {
              apiMsg = {
                role: 'tool',
                tool_call_id: msg.tool_call_id ?? 'unknown',
                content: msg.content ?? '',
              };
            } else {
              apiMsg = { role: msg.role, content: msg.content ?? '' };
            }

            // On the initial user turn, swap in the real apiContent (may include images)
            if (isInitialTurn && i === allMsgs.length - 1) {
              apiMsg.content = apiContent;
            }

            history.unshift(apiMsg);
          }

          return [{ role: 'system', content: systemPrompt }, ...history];
        };

        // ── Execute tool call ──
        const executeTool = async (name: string, args: Record<string, any>, callId: string): Promise<string> => {
          let result: string;

          if (name === 'web_search') {
            const q = (args.query || '').trim();
            if (q.startsWith('http://') || q.startsWith('https://')) {
              result = await tauriApi.fetchWebpage(q);
            } else {
              const res = await tauriApi.webSearch(q);
              result = JSON.stringify(res, null, 2);
            }
          } else if (name === 'read_webpage') {
            result = await tauriApi.fetchWebpage(args.url);
          } else if (name === 'read_youtube_video') {
            result = await tauriApi.readYoutubeTranscript(args.url);
          } else if (name === 'list_directory') {
            const entries = await tauriApi.listDirectory(args.path);
            const lines = entries.map(e => {
              const size = e.size_bytes != null
                ? e.size_bytes > 1_000_000 ? `${(e.size_bytes / 1_000_000).toFixed(1)} MB`
                : e.size_bytes > 1_000 ? `${(e.size_bytes / 1_000).toFixed(1)} KB`
                : `${e.size_bytes} B`
                : '';
              return e.is_dir ? `📁 ${e.name}/` : `📄 ${e.name}${size ? ` (${size})` : ''}`;
            });
            result = `Contents of ${args.path}:\n${lines.join('\n')}`;
          } else if (name === 'get_special_dirs') {
            const dirs = await tauriApi.getSpecialDirs();
            result = `Special directories:\n${JSON.stringify(dirs, null, 2)}`;
          } else if (name === 'search_files') {
            const found = await tauriApi.searchFiles(args.query, args.root);
            result = found.length === 0
              ? `No files found matching "${args.query}".`
              : `Found ${found.length} result(s):\n${found.map(f => f.is_dir ? `📁 ${f.path}/` : `📄 ${f.path}`).join('\n')}`;
          } else if (name === 'read_local_file') {
            result = await tauriApi.parseLocalFile(args.path);
          } else if (name.startsWith('mcp__')) {
            const parts = name.split('__');
            if (parts.length >= 3) {
              const serverId = parts[1];
              const toolName = parts.slice(2).join('__');
              const res = await tauriApi.mcpCallTool(serverId, toolName, args);
              result = JSON.stringify(res, null, 2);
            } else {
              result = `Error: Invalid MCP tool name format: ${name}`;
            }
          } else {
            result = `Error: Unknown tool "${name}"`;
          }

          return capOutput(result);
        };

        // ── Main streaming loop (recursive for tool calls) ──
        const executeChatLoop = async (isInitialTurn: boolean, depth: number): Promise<void> => {
          if (controller.signal.aborted) return;

          const apiMessages = buildApiMessages(isInitialTurn);

          // At max depth, stop passing tools so model must respond with text
          const isMaxDepth = depth >= 3;
          if (isMaxDepth) {
            apiMessages.push({
              role: 'system',
              content: 'You have reached the maximum tool call depth. DO NOT call any more tools. Write your final answer now using the information already gathered.',
            });
          }

          // Get active MCP tools (with 5s timeout per server)
          const mcpTools: ToolDefinition[] = [];
          if (!isMaxDepth) {
            for (const serverId of useChatStore.getState().activeMcpServers) {
              try {
                const res = await Promise.race([
                  tauriApi.mcpListTools(serverId),
                  new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('timeout')), 5000)
                  ),
                ]);
                if (res?.tools) {
                  for (const tool of res.tools) {
                    mcpTools.push({
                      type: 'function',
                      function: {
                        name: `mcp__${serverId}__${tool.name}`,
                        description: `[MCP: ${serverId}] ${tool.description || ''}`,
                        parameters: tool.inputSchema || { type: 'object', properties: {} },
                      },
                    });
                  }
                }
              } catch {
                // MCP server unavailable — skip silently
              }
            }
          }

          const availableTools = isMaxDepth ? [] : mcpTools;

          // ── Stream response ──
          let firstToken = false;
          const recentTokens: string[] = [];
          let totalChars = 0;
          let repetitionAborted = false;

          const detectRepetition = (): boolean => {
            const len = recentTokens.length;
            if (len < 15) return false;

            // Pattern 1: same token 15 times in a row
            const tail = recentTokens.slice(-15);
            if (tail.every(t => t === tail[0])) return true;

            // Pattern 2: cycling pattern of period 2–4
            for (const period of [2, 3, 4]) {
              const needed = period * 5;
              if (len < needed) continue;
              const window = recentTokens.slice(-needed);
              const cycle = window.slice(0, period);
              if (window.every((t, i) => t === cycle[i % period])) return true;
            }

            // Pattern 3: repeated multi-word phrase in recent 30 tokens
            if (len >= 30) {
              const chunk = recentTokens.slice(-30).join('');
              if (chunk.length >= 40) {
                for (let subLen = 5; subLen <= 20; subLen++) {
                  const sub = chunk.slice(-subLen);
                  if ((chunk.split(sub).length - 1) >= 6) return true;
                }
              }
            }

            return false;
          };

          for await (const chunk of streamChat(settings, apiMessages, controller.signal, availableTools)) {
            if (controller.signal.aborted) break;
            const delta = chunk.choices[0]?.delta;
            if (!delta) continue;

            if (!firstToken && (delta.content || delta.tool_calls)) {
              firstToken = true;
              setChatStatus('streaming');
            }

            if (delta.content) {
              totalChars += delta.content.length;
              const trimmed = delta.content.trim();
              if (trimmed) {
                recentTokens.push(trimmed);
                if (recentTokens.length > 60) recentTokens.splice(0, recentTokens.length - 50);
                // Only run detection after 200 chars to avoid false positives
                if (totalChars > 200 && detectRepetition()) {
                  console.warn('[Repetition] Loop detected — aborting stream');
                  tauriApi.appendSystemLog('warn', 'Repetition loop detected. Auto-aborting.');
                  repetitionAborted = true;
                  // Trim output back to last clean sentence
                  const current = useChatStore.getState().streamingContent;
                  if (current) {
                    const cutoff = Math.floor(current.length * 0.8);
                    let cleanEnd = -1;
                    for (const m of current.matchAll(/[.!?]\s/g)) {
                      if (m.index != null && m.index < cutoff) cleanEnd = m.index + 1;
                    }
                    useChatStore.setState({
                      streamingContent: cleanEnd > 50 ? current.slice(0, cleanEnd).trimEnd() : current.slice(0, cutoff).trimEnd(),
                    });
                  }
                  controller.abort();
                  break;
                }
              }
              appendStreamToken(delta.content);
            }

            if (delta.tool_calls) {
              appendToolCallDelta(delta.tool_calls);
            }

            if (chunk.choices[0]?.finish_reason === 'stop' || chunk.choices[0]?.finish_reason === 'tool_calls') {
              break;
            }
          }

          if (repetitionAborted) {
            finalizeStreamMessage(convId!);
            return;
          }

          const finalMessage = finalizeStreamMessage(convId!);

          // ── Handle tool calls ──
          const hasToolCalls = finalMessage.tool_calls && finalMessage.tool_calls.length > 0;
          const toolBudgetExhausted = totalToolCalls >= MAX_TOTAL_TOOLS;

          if (hasToolCalls && !isMaxDepth && !toolBudgetExhausted) {
            setChatStatus('calling-tool');

            // Execute at most 2 tool calls per depth to keep things fast
            for (const tc of finalMessage.tool_calls!.slice(0, 2)) {
              if (controller.signal.aborted) break;
              if (tc.type !== 'function') continue;

              // Hard cap: if we've already run 5 tool calls this turn, stop
              if (totalToolCalls >= MAX_TOTAL_TOOLS) {
                tauriApi.appendSystemLog('warn', `Tool budget exhausted (${MAX_TOTAL_TOOLS} calls). Forcing final answer.`);
                addMessage({
                  id: generateId(),
                  conversation_id: convId!,
                  role: 'tool',
                  content: '[NOTICE]: Maximum tool calls reached for this turn. Stop calling tools and write your final answer now using whatever information you already have.',
                  tool_call_id: tc.id,
                  created_at: Date.now(),
                });
                break;
              }

              const toolKey = `${tc.function?.name}::${tc.function?.arguments}`;
              const toolName = tc.function?.name ?? '';
              const toolArgs = (() => { try { return JSON.parse(tc.function?.arguments || '{}'); } catch { return {}; } })();

              // Cross-depth dedup: skip if this exact call already ran this turn
              if (calledToolKeys.has(toolKey)) {
                console.log(`[Dedup] Blocked repeated tool call: ${toolKey}`);
                tauriApi.appendSystemLog('warn', `Duplicate blocked: ${toolName}`);
                addMessage({
                  id: generateId(),
                  conversation_id: convId!,
                  role: 'tool',
                  content: `[NOTICE]: "${toolName}" with these exact arguments was already called. You already have its result. Write your final answer now.`,
                  tool_call_id: tc.id,
                  created_at: Date.now(),
                });
                continue;
              }
              calledToolKeys.add(toolKey);
              totalToolCalls++;

              tauriApi.appendSystemLog('info', `Tool Call: ${toolName}(${tc.function?.arguments})`);

              let result: string;
              try {
                result = await executeTool(toolName, toolArgs, tc.id);
                consecutiveErrors = 0; // reset on success
              } catch (e) {
                result = `Error running ${toolName}: ${String(e)}`;
                tauriApi.appendSystemLog('error', `Tool Error [${toolName}]: ${String(e)}`);
                consecutiveErrors++;
              }

              // If 2 errors in a row (e.g. repeated no-results searches), tell the model to stop
              if (consecutiveErrors >= 2) {
                result += '\n\n[NOTICE]: Multiple searches have failed. Stop searching and answer the user directly based on what you already know, or tell them the information could not be found.';
                consecutiveErrors = 0;
              }

              tauriApi.appendSystemLog('info', `Tool Result [${toolName}]: ${result.length > 200 ? result.slice(0, 200) + '...' : result}`);

              addMessage({
                id: generateId(),
                conversation_id: convId!,
                role: 'tool',
                content: result,
                tool_call_id: tc.id,
                created_at: Date.now(),
              });
            }

            if (controller.signal.aborted) return;
            setChatStatus('thinking');
            clearStreamingContent();
            await executeChatLoop(false, depth + 1);
            return; // Don't run TTS on intermediate steps
          } else if (hasToolCalls && (isMaxDepth || toolBudgetExhausted)) {
            // Model tried to call tools but budget is exhausted — inject a final-answer notice
            // and add synthetic results for each orphaned tool call so the sequence stays valid
            for (const tc of finalMessage.tool_calls!.slice(0, 2)) {
              if (tc.type !== 'function') continue;
              addMessage({
                id: generateId(),
                conversation_id: convId!,
                role: 'tool',
                content: '[NOTICE]: Tool call limit reached. Write your final answer now based on information already gathered.',
                tool_call_id: tc.id,
                created_at: Date.now(),
              });
            }
            if (controller.signal.aborted) return;
            setChatStatus('thinking');
            clearStreamingContent();
            await executeChatLoop(false, depth + 1);
            return;
          }

          // ── Final response: TTS if enabled ──
          if (settings.tts_enabled) {
            const text = extractTextContent(finalMessage.content);
            if (text) await tauriApi.speakText(text, settings.tts_rate, settings.tts_voice);
          }
        };

        await executeChatLoop(true, 0);
        updateConversation(convId, { updated_at: Date.now() });

      } catch (error: unknown) {
        const isAbort = error instanceof Error &&
          (error.name === 'AbortError' || error.message === 'Aborted');

        if (isAbort) {
          // Finalize any partial streamed content
          const partial = useChatStore.getState().streamingContent;
          if (partial) finalizeStreamMessage(convId!);
          clearStreamingContent();
        } else {
          console.error('Chat error:', error);
          const errMsg = error instanceof Error ? error.message : String(error);
          addMessage({
            id: generateId(),
            conversation_id: convId!,
            role: 'assistant',
            content: `⚠️ Error: ${errMsg}`,
            created_at: Date.now(),
          });
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
