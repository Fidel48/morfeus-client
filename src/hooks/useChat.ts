import { useCallback } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMcpStore } from '@/stores/mcpStore';
import { streamChat, WEB_TOOLS, FAST_CHAT_TOOLS } from '@/lib/api';
import { tauriApi } from '@/lib/tauri';
import { kokoroSpeak, kokoroStop, speechQueue } from '@/lib/kokoroTts';
import { generateId, extractTextContent } from '@/lib/utils';
import { Message, ContentPart, ToolDefinition, AppSettings } from '@/types';

// Max chars returned from any single file/page tool call.
// Keeps local 14B model context from being flooded.
const MAX_TOOL_OUTPUT_CHARS = 6000;

function capOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_TOOL_OUTPUT_CHARS) + `\n\n[... output truncated at ${MAX_TOOL_OUTPUT_CHARS} chars ...]`;
}

export function formatChatErrorMessage(rawError: string | unknown, activeModelName?: string): string {
  let text = rawError instanceof Error ? rawError.message : String(rawError || 'Unknown error');
  text = text.replace(/^Error:\s*/i, '').trim();

  // Try extracting inner JSON error messages if any provider returned JSON string
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  let extractedDetail: string | null = null;
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      extractedDetail =
        parsed?.error?.metadata?.raw ||
        parsed?.error?.message ||
        parsed?.message ||
        (typeof parsed?.error === 'string' ? parsed.error : null);
    } catch {
      // not JSON
    }
  }

  const is429 = /429|rate[- ]limit/i.test(text);
  const is401 = /401|403|unauthorized|authentication failed/i.test(text);
  const is402 = /402|insufficient|payment required|credit/i.test(text);
  const is404 = /404|not found/i.test(text);
  const is503 = /503|service unavailable|overloaded/i.test(text);

  const cleanBody = (extractedDetail || text.replace(/^HTTP\s+\d+[:\s]*/i, '')).trim();

  if (is429) {
    return `### ⚠️ Model Rate Limited (HTTP 429)\n\n${cleanBody}\n\n**Why did this happen?**\nFree models (like \`${activeModelName || 'this model'}\`) share a public upstream quota pool on OpenRouter and can be temporarily throttled during high traffic.\n\n💡 **How to continue:**\n- **Wait 30–60 seconds** and try sending your message again, or\n- **Switch models**: Click the model pill in the bottom toolbar to switch to a local model (Ollama) or another cloud model.`;
  }

  if (is402) {
    return `### ⚠️ Insufficient Credits (HTTP 402)\n\n${cleanBody}\n\n💡 **How to continue:**\n- Your provider account has run out of credits or requires billing setup.\n- Add credits in your provider dashboard or switch to a free or local model.`;
  }

  if (is401) {
    return `### ⚠️ Authentication Failed (HTTP 401/403)\n\n${cleanBody}\n\n💡 **How to continue:**\n- Open **Settings → Model Providers** and verify your API key is correctly entered.\n- Make sure the API key is active on your provider's dashboard.`;
  }

  if (is404) {
    return `### ⚠️ Model or Endpoint Not Found (HTTP 404)\n\n${cleanBody}\n\n💡 **How to continue:**\n- The model \`${activeModelName || 'selected'}\` could not be found at this endpoint.\n- In **Settings → Model Providers**, click **Edit** on your provider and click **Fetch available models** to update your model catalog.`;
  }

  if (is503) {
    return `### ⚠️ Provider Server Busy (HTTP 503)\n\n${cleanBody}\n\n💡 **How to continue:**\n- The model server is currently loading or under heavy load. Please retry shortly.`;
  }

  return `### ⚠️ Provider Error\n\n${cleanBody}`;
}

export function useChat() {
  const {
    messages,
    activeConversationId,
    isStreaming,
    streamingContent,
    streamingReasoning,
    chatStatus,
    addMessage,
    appendStreamToken,
    appendReasoningToken,
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
      const currentSettings = useSettingsStore.getState().settings;
      const mode = useChatStore.getState().chatMode || 'fast';
      const activeModel = mode === 'fast'
        ? (currentSettings.fast_chat_model_id || currentSettings.model_id)
        : (currentSettings.agent_coder_model_id || currentSettings.model_id);
      if (!activeModel) {
        console.error('No model selected');
        return;
      }

      // ── Ensure active conversation ──
      let convId = activeConversationId;
      if (!convId) {
        const wasTtsEnabled = useSettingsStore.getState().settings.tts_enabled;
        const conv = useChatStore.getState().newConversation();
        convId = conv.id;
        if (wasTtsEnabled) {
          useSettingsStore.getState().updateSettings({ tts_enabled: true });
        }
      }

      // ── Reset voice queue for this interaction ──
      speechQueue.stop();
      speechQueue.reset();
      const sendSettings = useSettingsStore.getState().settings;
      speechQueue.setVoice(sendSettings.tts_voice || 'af_heart');
      speechQueue.setRate(sendSettings.tts_rate || 1.0);

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
        const currentSettings = useSettingsStore.getState().settings;
        const chatMode = useChatStore.getState().chatMode || 'fast';
        const isFastMode = chatMode === 'fast';
        const isThink = currentSettings.think_enabled ?? true;

        // Helper to detect any variant of DeepSeek-R1
        const isDeepSeekR1 = (id?: string) => {
          if (!id) return false;
          const s = id.toLowerCase();
          return s.includes('deepseek-r1') || s.includes('deepseek_r1') || (s.includes('deepseek') && s.includes('r1'));
        };

        // Model & Provider resolution: use configured model and provider for the active mode
        const resolvedModelId = isFastMode
          ? (currentSettings.fast_chat_model_id || currentSettings.model_id)
          : (currentSettings.agent_coder_model_id || currentSettings.model_id);

        const resolvedProviderId = isFastMode
          ? currentSettings.fast_chat_provider_id
          : currentSettings.agent_coder_provider_id;

        const matchedProvider =
          (currentSettings.providers || []).find((p) => p.id === resolvedProviderId) ||
          (currentSettings.providers || []).find((p) => p.models?.some((m) => m.id === resolvedModelId));

        const effectiveBaseUrl = matchedProvider ? matchedProvider.base_url : currentSettings.base_url;
        const effectiveApiKey = matchedProvider ? (matchedProvider.api_key || '') : currentSettings.api_key;

        // Reasoning tokens count against max_tokens on most servers. When Think is on, add
        // headroom so the model can finish thinking AND write an answer, but never exceed
        // half of the user's chosen context window, so history/prompt still fit and the
        // context window setting is respected exactly as configured.
        const REASONING_HEADROOM = 6144;
        const baseMaxTokens = currentSettings.max_tokens > 0 ? currentSettings.max_tokens : 2048;
        const userContext = currentSettings.context_length || 4096;
        const effectiveMaxTokens = isThink
          ? Math.max(baseMaxTokens, Math.min(baseMaxTokens + REASONING_HEADROOM, Math.floor(userContext / 2)))
          : baseMaxTokens;

        const effectiveSettings: AppSettings = {
          ...currentSettings,
          base_url: effectiveBaseUrl,
          api_key: effectiveApiKey,
          model_id: resolvedModelId,
          max_tokens: effectiveMaxTokens,
        };

        const isVoiceActive = useSettingsStore.getState().settings.tts_enabled;
        const voiceDirective = isVoiceActive
          ? `\n\nVOICE MODE DIRECTIVE: Your response will be spoken aloud to the user using text-to-speech. Keep conversational answers natural, direct, and concise (1 to 3 punchy sentences). Avoid long rambling introductions, bullet lists, or reading code out loud—provide the code in markdown and give a brief 1-sentence spoken summary. Display all source links and references at the very end under a "### Sources" heading so they are displayed visually but not spoken.`
          : '';

        const thinkDirective = !isThink
          ? `\n\nCRITICAL THINKING DIRECTIVE: Thinking mode is explicitly turned OFF by the user. Do NOT output internal reasoning scratchpads, thinking tokens, or <think> tags. Answer immediately, directly, and concisely.`
          : '';

        let systemPrompt: string;

        if (isFastMode) {
          systemPrompt = `You are Morfeus in Chat mode. Be direct, clear, and concise.

Today's Date: ${dateStr}
Current Time: ${timeStr}

DIRECTIVES:
1. SPEED & CLARITY: Respond immediately and articulately without unnecessary conversational filler.
2. TOOLS AVAILABLE: You have access to web search (web_search, read_webpage) and local PC file tools (get_special_dirs, search_files, list_directory, read_local_file).
3. FILE SUMMARIZATION: When asked to find, inspect, or summarize files on the PC, call the appropriate file tools to locate and read them, then provide a clear, structured summary.
4. WEB SEARCH, ARTICLES & GROUNDING: When searching the web or asked to read news stories or articles, provide a thorough, informative breakdown covering the key details (who, what, when, where, charges, facts, context). State the exact current date/time ("As of ${dateStr} at ${timeStr}...") and ALWAYS conclude with direct clickable Markdown source links formatted under a "### Sources" section at the very end: [Source Title](url).
5. CODING LIMITATION: Chat mode does NOT run shell commands or edit files directly. If the user wants to execute code, run terminal commands, edit codebase files, or use MCP servers, inform them to switch to "Agent Coder" mode.${voiceDirective}${thinkDirective}`;
        } else {
          const basePrompt = currentSettings.system_prompt || 'You are Morfeus, a powerful, articulate, and autonomous desktop AI developer harness and assistant.';
          systemPrompt = `${basePrompt}

Today's Date: ${dateStr}
Current Time: ${timeStr}

CRITICAL AGENT CODER DIRECTIVES (IDE DEVELOPER HARNESS):
1. AUTONOMOUS ReAct LOOP: You are in Agent Coder mode with full IDE developer harness capabilities. When tasked with solving a problem, debugging, or coding, operate autonomously in a continuous ReAct (Reason, Act, Observe) loop. Do not stop at the first step—inspect files, search, run code, observe outputs, and iterate until the objective is accomplished.
2. FULL DEVELOPER TOOL ACCESS: You have complete access to terminal commands (run_terminal_command), Python execution (run_python, run_python_file), package installation (install_python_packages), file creation and editing (write_to_file, delete_file), filesystem exploration, screen inspection (analyze_screen), and OS automation.
3. EXTENSIBILITY & MCP: You have native integration with Model Context Protocol (MCP). Active MCP servers provide dynamic tools prefixed with mcp__<server>__<tool>. You can also manage servers using list_mcp_servers, connect_mcp_server, and remove_mcp_server.
4. SURGICAL PRECISION: Always inspect files and read existing code before editing to preserve project conventions and architecture.
5. CONVERSATIONAL BALANCE: When the user asks general questions or explanations, answer directly, concisely, and articulately without invoking unnecessary tools.
6. WEB SEARCH, ARTICLES & GROUNDING: When searching the web or reading news/articles, synthesize comprehensive, verified information with key details and quotes. State the exact current date/time ("As of ${dateStr} at ${timeStr}...") and ALWAYS provide direct clickable markdown source links: [Source Title](url).
7. SUMMARY ON COMPLETION: When finishing a multi-step task, provide a clear, structured summary of what was accomplished (files read/modified, tools executed, results verified).${voiceDirective}${thinkDirective}`;
        }

        // ── Tool dedup + rate limiting: persists across all recursive depths for this turn ──
        const calledToolKeys = new Set<string>();
        let totalToolCalls = 0;       // hard cap: max tools total per user turn
        let consecutiveErrors = 0;    // if 2 errors in a row, stop and answer from what we know
        const MAX_TOTAL_TOOLS = 25;

        // ── Build API-formatted message history ──
        const buildApiMessages = (isInitialTurn: boolean) => {
          const estimateTokens = (s: string) => Math.ceil(s.length / 4);
          let budget = estimateTokens(systemPrompt) + settings.max_tokens;

          const allMsgs = useChatStore.getState().messages.filter(
            m => m.conversation_id === convId
          );

          // Find the active user query for this current interaction
          const lastUserMsg = [...allMsgs].reverse().find(m => m.role === 'user');

          const history: any[] = [];
          // Walk backwards, newest first, until context budget is exhausted
          for (let i = allMsgs.length - 1; i >= 0; i--) {
            const msg = allMsgs[i];
            const isCurrentTurnUser = msg === lastUserMsg;
            const tokCost = 20 + estimateTokens(msg.content ?? '') + (msg.tool_calls ? 50 : 0);

            // Never truncate the current user query even if budget is tight
            if (!isCurrentTurnUser && budget + tokCost > settings.context_length) {
              console.log('[Context] Truncated older messages to fit context window.');
              break;
            }
            budget += tokCost;

            // Format each role correctly for the OpenAI API spec
            let apiMsg: any;
            if (msg.role === 'assistant') {
              apiMsg = msg.tool_calls?.length
                ? {
                    role: 'assistant',
                    content: msg.content ?? null,
                    tool_calls: msg.tool_calls.map((tc, idx) => ({
                      id: tc.id || `call_${Date.now()}_${idx}`,
                      type: tc.type || 'function',
                      function: {
                        name: tc.function?.name || '',
                        arguments: typeof tc.function?.arguments === 'string'
                          ? tc.function.arguments
                          : JSON.stringify(tc.function?.arguments || {}),
                      },
                    })),
                  }
                : { role: 'assistant', content: msg.content ?? '' };
            } else if (msg.role === 'tool') {
              if (typeof msg.content === 'string' && msg.content.startsWith('![Screenshot](data:image/png;base64,')) {
                const match = msg.content.match(/\((data:image\/png;base64,.*?)\)/);
                if (match && match[1]) {
                  // Inject the image as a simulated user message *after* the tool message
                  history.unshift({
                    role: 'user',
                    content: [
                      { type: 'text', text: 'Here is the screenshot you requested:' },
                      { type: 'image_url', image_url: { url: match[1] } }
                    ]
                  });
                  apiMsg = {
                    role: 'tool',
                    tool_call_id: msg.tool_call_id || 'call_default',
                    content: 'Screenshot captured successfully.',
                  };
                } else {
                  apiMsg = {
                    role: 'tool',
                    tool_call_id: msg.tool_call_id || 'call_default',
                    content: msg.content ?? '',
                  };
                }
              } else {
                apiMsg = {
                  role: 'tool',
                  tool_call_id: msg.tool_call_id || 'call_default',
                  content: typeof msg.content === 'string' ? capOutput(msg.content) : (msg.content ?? ''),
                };
              }
            } else {
              apiMsg = { role: msg.role, content: msg.content ?? '' };
            }

            // On the initial user turn, swap in the real apiContent (may include images)
            if (isInitialTurn && i === allMsgs.length - 1) {
              apiMsg.content = apiContent;
            }

            history.unshift(apiMsg);
          }

          // Clean up any leading orphaned tool messages
          while (history.length > 0 && history[0].role === 'tool') {
            history.shift();
          }

          // Ensure at least one user query is present in history (required by LLM chat templates)
          const hasUser = history.some(m => m.role === 'user');
          if (!hasUser) {
            history.unshift({
              role: 'user',
              content: lastUserMsg?.content || userDisplayContent || 'Help me with this task.',
            });
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
              let res: any[] = [];
              try {
                res = await tauriApi.webSearch(q);
              } catch (err) {
                console.warn('[web_search] Backend search returned error:', err);
              }
              if (Array.isArray(res) && res.length > 0) {
                // Auto-fetch top article content so the LLM has complete context (like Gemini/Perplexity/Grok)
                let topArticleContent = '';
                const topResult = res[0];
                if (topResult?.url && (topResult.url.startsWith('http://') || topResult.url.startsWith('https://'))) {
                  try {
                    const pageText = await tauriApi.fetchWebpage(topResult.url);
                    if (pageText && !pageText.startsWith('[Webpage Notice]') && pageText.length > 50) {
                      topArticleContent = `\n\n═══════════════════════════════════════════════════\nFULL ARTICLE CONTENT (From Top Source: "${topResult.title}" | ${topResult.url}):\n═══════════════════════════════════════════════════\n${pageText}\n═══════════════════════════════════════════════════`;
                    }
                  } catch (e) {
                    console.warn('[web_search] Could not auto-scrape top article:', e);
                  }
                }

                const searchSnippets = res.map((r, i) =>
                  `[Source ${i + 1}]: "${r.title}"\nURL: ${r.url}\nSnippet: ${r.snippet}`
                ).join('\n\n');

                result = `Search Results for query "${q}":\n\n${searchSnippets}${topArticleContent}\n\nSYNTHESIS DIRECTIVE: Synthesize an articulate, comprehensive response based on the article content and search results above. Detail key facts, names, chronology, charges, and context. State the exact current date/time ("As of ${dateStr} at ${timeStr}...") and ALWAYS conclude with direct clickable markdown source links at the end: [${topResult?.title || 'Source'}](${topResult?.url || ''}). If more depth from other sources is needed, you can call \`read_webpage\`.`;
              } else {
                result = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
              }
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
          } else if (name === 'run_python') {
            const codeArg = typeof args.code === 'string' ? args.code : JSON.stringify(args.code);
            const pyResult = await tauriApi.runPythonCode(codeArg);
            const status = pyResult.success ? '✅ Success' : `❌ Failed (exit code ${pyResult.exit_code})`;
            const out = pyResult.stdout.trim();
            const err = pyResult.stderr.trim();
            result = [
              `${status}`,
              out ? `\n**stdout:**\n\`\`\`\n${out}\n\`\`\`` : '',
              err ? `\n**stderr:**\n\`\`\`\n${err}\n\`\`\`` : '',
            ].filter(Boolean).join('\n');
          } else if (name === 'run_python_file') {
            const pyResult = await tauriApi.runPythonFile(args.path);
            const status = pyResult.success ? '✅ Success' : `❌ Failed (exit code ${pyResult.exit_code})`;
            const out = pyResult.stdout.trim();
            const err = pyResult.stderr.trim();
            result = [
              `${status} — ran: ${args.path}`,
              out ? `\n**stdout:**\n\`\`\`\n${out}\n\`\`\`` : '',
              err ? `\n**stderr:**\n\`\`\`\n${err}\n\`\`\`` : '',
            ].filter(Boolean).join('\n');
          } else if (name === 'install_python_packages') {
            const pipResult = await tauriApi.installPythonPackages(args.packages);
            const status = pipResult.success ? '✅ Installed' : `❌ Install failed (exit code ${pipResult.exit_code})`;
            const out = pipResult.stdout.trim();
            const err = pipResult.stderr.trim();
            result = [
              `${status}: ${args.packages}`,
              out ? `\n\`\`\`\n${out}\n\`\`\`` : '',
              err ? `\n**stderr:**\n\`\`\`\n${err}\n\`\`\`` : '',
            ].filter(Boolean).join('\n');
          } else if (
            name === 'run_terminal_command' ||
            name === 'write_to_file' ||
            name === 'delete_file' ||
            name === 'analyze_screen' ||
            name === 'mouse_click' ||
            name === 'type_text' ||
            name === 'press_key' ||
            name === 'mouse_move'
          ) {
            let needsApproval = false;
            
            // Require approval for sensitive or active OS tools
            if (
              name === 'delete_file' ||
              name === 'mouse_click' ||
              name === 'type_text' ||
              name === 'press_key' ||
              name === 'run_terminal_command'
            ) {
              needsApproval = true;
            }

            let approved = true;
            if (needsApproval) {
              approved = await new Promise<boolean>((resolve) => {
                useChatStore.getState().setPendingApproval({ toolName: name, args, resolve });
              });
              useChatStore.getState().setPendingApproval(null);
            }

            if (!approved) {
              return "Action aborted by the user. Do not attempt this specific action again without asking first.";
            }

            if (name === 'run_terminal_command') {
              const res = await tauriApi.runTerminalCommand(args.command);
              const status = res.success ? '✅ Success' : `❌ Failed (exit code ${res.exit_code})`;
              const out = res.stdout.trim();
              const err = res.stderr.trim();
              result = [
                `${status}`,
                out ? `\n**stdout:**\n\`\`\`\n${out}\n\`\`\`` : '',
                err ? `\n**stderr:**\n\`\`\`\n${err}\n\`\`\`` : '',
              ].filter(Boolean).join('\n');
            } else if (name === 'write_to_file') {
              result = await tauriApi.writeToFile(args.path, args.content);
            } else if (name === 'delete_file') {
              result = await tauriApi.deleteFile(args.path);
            } else if (name === 'analyze_screen') {
              const b64 = await tauriApi.captureScreen();
              result = `![Screenshot](${b64})`;
            } else if (name === 'mouse_move') {
              await tauriApi.mouseMove(args.x, args.y);
              result = "Mouse moved successfully.";
            } else if (name === 'mouse_click') {
              await tauriApi.mouseClick(args.button);
              result = `Mouse clicked (${args.button}) successfully.`;
            } else if (name === 'type_text') {
              await tauriApi.typeText(args.text);
              result = `Text typed successfully.`;
            } else if (name === 'press_key') {
              await tauriApi.pressKey(args.key);
              result = `Key '${args.key}' pressed successfully.`;
            } else {
              result = "Unknown tool branch.";
            }
          } else if (name === 'list_mcp_servers') {
            const servers = useMcpStore.getState().servers;
            if (servers.length === 0) {
              result = "No MCP servers configured yet. You can connect to one using connect_mcp_server, or the user can add one in Settings > MCP Servers.";
            } else {
              result = JSON.stringify(servers.map(s => ({
                id: s.id,
                name: s.name,
                status: s.status,
                transport: s.transport,
                command: s.command,
                args: s.args,
                tools: (s.tools || []).map(t => ({ name: t.name, description: t.description })),
                errorMessage: s.errorMessage,
              })), null, 2);
            }
          } else if (name === 'connect_mcp_server') {
            const mcpStore = useMcpStore.getState();
            const config = {
              id: args.id,
              name: args.name || args.id,
              transport: (args.transport as 'stdio' | 'sse') || 'stdio',
              command: args.command,
              args: args.args || [],
              env: args.env || {},
              url: args.url,
              enabled: true,
            };
            mcpStore.addServer(config);
            await mcpStore.connectServer(args.id);
            const updated = useMcpStore.getState().servers.find(s => s.id === args.id);
            if (updated?.status === 'connected') {
              result = `✅ Successfully connected to MCP server "${config.name}" (${config.id}). Discovered ${updated.tools?.length || 0} tools: ${(updated.tools || []).map(t => t.name).join(', ')}`;
            } else {
              result = `⚠️ MCP server "${config.name}" was registered, but status is: ${updated?.status || 'unknown'}. Error: ${updated?.errorMessage || 'Check server configuration'}`;
            }
          } else if (name === 'remove_mcp_server') {
            await useMcpStore.getState().removeServer(args.id);
            result = `MCP server "${args.id}" has been removed and disconnected.`;
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
        // disableTools: set after an empty-response auto-retry so we don't keep sending tools to models that ignore them
        const executeChatLoop = async (isInitialTurn: boolean, depth: number, disableTools = false): Promise<void> => {
          if (controller.signal.aborted) return;

          const apiMessages = buildApiMessages(isInitialTurn);

          // At max depth, stop passing tools so model must respond with text
          const isFastMode = chatMode === 'fast';
          const maxDepth = isFastMode ? 5 : 25;
          const isMaxDepth = depth >= maxDepth;
          if (isMaxDepth) {
            apiMessages.push({
              role: 'system',
              content: 'You have reached the maximum tool call depth for this mode. DO NOT call any more tools. Write your final answer now using the information already gathered.',
            });
          }

          let availableTools: ToolDefinition[] = [];
          if (!isMaxDepth) {
            if (isFastMode) {
              // Chat: minimal lightweight read-only tools for instant response & low prefill latency
              availableTools = FAST_CHAT_TOOLS;
            } else {
              // Agent Coder: full developer suite with all built-in tools + active MCP servers
              const mcpTools: ToolDefinition[] = [];
              const activeTools = useMcpStore.getState().getActiveTools();
              for (const { serverId, tool } of activeTools) {
                mcpTools.push({
                  type: 'function',
                  function: {
                    name: `mcp__${serverId}__${tool.name}`,
                    description: `[MCP: ${serverId}] ${tool.description ?? ''}`,
                    parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
                  },
                });
              }
              availableTools = [...WEB_TOOLS, ...mcpTools];
            }
          }

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

          let finishReason: string | null = null;
          for await (const chunk of streamChat(effectiveSettings, apiMessages, controller.signal, availableTools, disableTools)) {
            if (controller.signal.aborted) break;
            if (!chunk || !Array.isArray(chunk.choices) || chunk.choices.length === 0) continue;

            const choice = chunk.choices[0];
            const delta = choice?.delta;
            if (!delta) continue;

            const reasoningDelta = delta.reasoning || delta.reasoning_content;

            if (!firstToken && (delta.content || reasoningDelta || delta.tool_calls)) {
              firstToken = true;
              setChatStatus('streaming');
            }

            if (reasoningDelta) {
              appendReasoningToken(reasoningDelta);
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

              // Real-time sentence speech streaming
              const liveTts = useSettingsStore.getState().settings.tts_enabled;
              if (liveTts) {
                speechQueue.feedToken(delta.content);
              } else {
                speechQueue.stop();
              }

              appendStreamToken(delta.content);
            }

            if (delta.tool_calls) {
              speechQueue.stop(); // Don't speak tool call JSON
              appendToolCallDelta(delta.tool_calls);
            }

            if (choice?.finish_reason) finishReason = choice.finish_reason;

            if (choice?.finish_reason === 'stop' || choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'length') {
              break;
            }
          }

          if (repetitionAborted) {
            finalizeStreamMessage(convId!);
            return;
          }

          const hadReasoning = !!useChatStore.getState().streamingReasoning;
          const finalMessage = finalizeStreamMessage(convId!);
          const hasToolCalls = finalMessage.tool_calls && finalMessage.tool_calls.length > 0;

          // ── Truncated while thinking: model hit the token limit before writing an answer ──
          // A retry can't help (same limit) and would discard the reasoning, so show an
          // actionable notice and keep the thinking text visible.
          const isEmptyContent = !finalMessage.content
            || finalMessage.content === '[empty response]'
            || finalMessage.content.trim() === '';
          const noToolCalls = !finalMessage.tool_calls || finalMessage.tool_calls.length === 0;
          const wasTruncated = !controller.signal.aborted
            && (finishReason === 'length' || (hadReasoning && finishReason !== 'stop'));

          if (isEmptyContent && noToolCalls && hadReasoning && wasTruncated) {
            tauriApi.appendSystemLog('warn', 'Model ran out of tokens while thinking (finish_reason=length). Raise Max Tokens / Context Length or turn off Think.');
            useChatStore.setState((state) => ({
              messages: state.messages.map((m) =>
                m.id === finalMessage.id
                  ? { ...m, content: '⚠️ **The model ran out of tokens while thinking**, so it never wrote a final answer. Raise **Max Tokens** / **Context Length** in the Params panel, turn off **Think**, or try a simpler request.' }
                  : m
              ),
            }));
            return;
          }

          // ── Auto-retry without tools if model returned an empty response ──
          // This happens when GGUF/Ollama models don't support function calling:
          // they receive the tools array, get confused, and return nothing.
          // Retry once without the tools array so the model can respond normally.
          const isEmptyResponse = isEmptyContent;
          const hasNoToolCalls = noToolCalls;

          if (isEmptyResponse && hasNoToolCalls && depth === 0 && !disableTools) {
            console.warn('[Chat] Empty response received — model may not support function calling. Retrying without tools.');
            tauriApi.appendSystemLog('warn', 'Empty response from model — retrying without tools array (model may not support function calling).');
            // Remove the empty message we just finalized
            useChatStore.setState((state) => ({
              messages: state.messages.filter((m) => m.id !== finalMessage.id),
            }));
            clearStreamingContent();
            await executeChatLoop(isInitialTurn, depth, true); // retry with tools disabled
            return;
          }

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
            try {
              await executeChatLoop(false, depth + 1);
            } catch (err: unknown) {
              console.error('[Stream error on turn 2]:', err);
              addMessage({
                id: generateId(),
                conversation_id: convId!,
                role: 'assistant',
                content: formatChatErrorMessage(err, activeModel),
                created_at: Date.now(),
              });
            }
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

          // ── Final response: Flush speechQueue if TTS enabled ──
          const liveSettings = useSettingsStore.getState().settings;
          if (liveSettings.tts_enabled && !hasToolCalls) {
            speechQueue.flush();
          } else if (!hasToolCalls && liveSettings.continuous_voice && liveSettings.tts_enabled) {
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('speech-playback-complete'));
            }
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
          addMessage({
            id: generateId(),
            conversation_id: convId!,
            role: 'assistant',
            content: formatChatErrorMessage(error, activeModel),
            created_at: Date.now(),
          });
          clearStreamingContent();
          const activeSettings = useSettingsStore.getState().settings;
          if (typeof window !== 'undefined' && activeSettings.continuous_voice && activeSettings.tts_enabled) {
            window.dispatchEvent(new CustomEvent('speech-playback-complete'));
          }
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
      appendReasoningToken,
      appendToolCallDelta,
      finalizeStreamMessage,
      clearStreamingContent,
      setIsStreaming,
      setChatStatus,
      setAbortController,
      updateConversation,
    ]
  );

  const handleStopStreaming = useCallback(() => {
    speechQueue.stop();
    stopStreaming();
  }, [stopStreaming]);

  return {
    messages: messages.filter(m => m.conversation_id === activeConversationId),
    isStreaming,
    streamingContent,
    streamingReasoning,
    chatStatus,
    sendMessage,
    stopStreaming: handleStopStreaming,
  };
}
