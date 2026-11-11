import { useCallback } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMcpStore } from '@/stores/mcpStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { streamChat, WEB_TOOLS, FAST_CHAT_TOOLS, resolveEffectiveContextLength } from '@/lib/api';
import { tauriApi } from '@/lib/tauri';
import { sanitizeHistory, trimHistoryToContext } from '@/lib/chatHistory';
import { kokoroSpeak, kokoroStop, speechQueue } from '@/lib/kokoroTts';
import { generateId, extractTextContent } from '@/lib/utils';
import { Message, ContentPart, ToolDefinition, AppSettings, ToolCall } from '@/types';

// Max chars returned from any single file/page tool call.
// Sized at 12,000 chars so multi-article web_search extracts + SYNTHESIS DIRECTIVE never get truncated.
const MAX_TOOL_OUTPUT_CHARS = 12000;

function capOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_TOOL_OUTPUT_CHARS) + `\n\n[... output truncated at ${MAX_TOOL_OUTPUT_CHARS} chars ...]`;
}

/**
 * Detects whether the user's input represents remote logs, containers, or non-local shell sessions
 * where local filesystem tools should NEVER be invoked.
 */
export function isRemoteOrPastedLog(text: string): boolean {
  if (!text) return false;
  return /pi@[\w.-]+|root@[\w.-]+|[\w.-]+@[\w.-]+[:#$]|docker logs|docker exec|docker run|containerd|podman|kubectl|journalctl/i.test(text);
}

/**
 * In Fast Chat mode, determine whether local PC file tools should be active.
 * Only activate when the user explicitly requests local filesystem inspection.
 */
export function shouldEnableLocalFileToolsInFastChat(text: string): boolean {
  if (!text || isRemoteOrPastedLog(text)) return false;
  return /\b(find|search|locate|look for|browse|list|show)\b.*\b(file|files|folder|folders|directory|directories|pdf|document|documents|desktop|downloads)\b/i.test(text)
    || /\b(read|open|inspect|check)\b.*\b(file|document|pdf|csv|json)\b/i.test(text)
    || /^[~/]|[a-zA-Z]:[/\\]/i.test(text.trim());
}

/**
 * Strips conversational voice/chat filler from the front of a user prompt
 * so `web_search` receives a clean, high-signal search query.
 */
export function extractCleanSearchQuery(text: string): string {
  let s = (text || '')
    .trim()
    .replace(/[?.!]+$/g, '')
    .replace(/^(?:an|ca|cn)\s+you\s+/i, 'can you ')
    .replace(/\b(?:lates|lastes|latets|lastest)\s+news\b/gi, 'latest news')
    .replace(/\b(?:happeing|hapening|happenning)\b/gi, 'happening')
    .replace(/\b(?:heiti|heati|hiati|hatii)\b/gi, 'Haiti')
    .replace(/\b(?:salavdor|salvabdor)\b/gi, 'Salvador')
    .replace(/\bthat\s+(latest|breaking|current)\s+news\b/gi, 'the $1 news')
    .trim();
  const prefixes = [
    /^hey morfeus[, ]+/i,
    /^hi morfeus[, ]+/i,
    /^ok morfeus[, ]+/i,
    /^morfeus[, ]+/i,
    /^(?:can|could|would) you (?:please )?(?:tell me|check|find out|search(?: the web)? for|look up)\s+/i,
    /^please (?:tell me|check|search(?: the web)? for|look up)\s+/i,
    /^(?:tell me|do you know)\s+/i,
    /^(?:search the web for|search online for|look up online|look up)\s+/i,
    /^(?:what is the|what's the|whats the|what are the|what is|what's|whats|the)\s+/i,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const rx of prefixes) {
      const m = s.match(rx);
      if (m && s.length > m[0].length + 2) {
        s = s.slice(m[0].length).trim();
        changed = true;
        break;
      }
    }
  }
  return s || (text || '').trim();
}

/**
 * Detects if a follow-up turn is correcting or swapping the subject entity of the prior search
 * (e.g. "i am sorry i meant to say haiti", "sorry i meant ethereum", "not heat, haiti", "what about haiti?").
 */
export function extractCorrectionTarget(userText: string, allowBareEntity = false): string | null {
  const raw = (userText || '').trim().replace(/[?.!]+$/g, '').trim();
  if (!raw || raw.length > 160) return null;

  const isCorrectionPattern =
    /\b(?:i\s+meant(?:\s+to\s+say)?|i\s+mean|meant\s+to\s+say|sorry|apologies|my\s+bad|oops|typo|i\s+was\s+(?:asking|talking)\s+about|instead\s+of)\b/i.test(raw) ||
    /^(?:no[, ]+)?not\s+[a-z0-9_-]+[, ]+/i.test(raw) ||
    /^(?:what\s+about|how\s+about|and\s+(?:what\s+about|in|for|about))\s+/i.test(raw);

  if (!isCorrectionPattern) {
    if (
      allowBareEntity &&
      raw.split(/\s+/).length <= 2 &&
      !/\b(why|how|who|when|where|what|which|explain|details|more|those|these|that|they|them|their|news|price|weather|stock|score|forecast)\b/i.test(raw)
    ) {
      return raw.replace(/^(?:in|for|about|of)\s+/i, '').trim() || null;
    }
    return null;
  }

  let target = raw;
  const stripPasses = [
    /^(?:no|oh|uh|um|wait|oops|my\s+bad|i\s+am\s+sorry|i'?m\s+sorry|im\s+sorry|sorry|apologies|excuse\s+me)[,!.:\s-]*/i,
    /^not\s+[a-z0-9_-]+(?:[,:\s]+(?:i\s+meant(?:\s+to\s+say)?\s+)?|\s+)/i,
    /^(?:actually|instead)?[,:\s]*(?:i\s+meant(?:\s+to\s+(?:say|ask|type|write))?|i\s+mean|meant(?:\s+to\s+say)?|i\s+was\s+(?:asking|talking)\s+about|i\s+said|it\s+was\s+supposed\s+to\s+be|what\s+about|how\s+about|and\s+(?:what\s+about|in|for|about)?)[,:\s-]*/i,
    /\s+(?:instead(?:\s+of\s+[a-z0-9_-]+)?|please|now|today)$/i,
  ];

  let loop = true;
  while (loop) {
    loop = false;
    for (const rx of stripPasses) {
      const next = target.replace(rx, '').trim();
      if (next && next !== target) {
        target = next;
        loop = true;
      }
    }
  }

  target = extractCleanSearchQuery(target);
  return target.length >= 2 ? target : null;
}

/**
 * Enriches a follow-up search query:
 * 1. If the user is correcting or swapping the subject entity (e.g. "i am sorry i meant to say haiti"
 *    after "latest news in heat"), applies the prior search's intent frame ("latest news in") to the
 *    corrected target ("haiti") -> "latest news in haiti".
 * 2. Otherwise, for drill-down follow-up questions (e.g. "why did el salvador deploy those troops"
 *    after "latest news Haiti"), appends the prior search's topic entity ("Haiti") if missing.
 */
export function buildContextualSearchQuery(userText: string, priorSearchQueries: string[] = []): string {
  const cleaned = extractCleanSearchQuery(userText);
  if (!priorSearchQueries.length) return cleaned;

  const lastQuery = priorSearchQueries[priorSearchQueries.length - 1] || '';

  // Case 1: Correction or entity-swap follow-up (e.g. "i am sorry i meant to say haiti", or bare "haiti")
  const correctedTarget = extractCorrectionTarget(userText, true);
  if (correctedTarget) {
    // If the corrected target already includes an explicit intent phrase, use it directly
    if (/\b(news|price|weather|temperature|forecast|stock|score|who|why|how|when|where|what)\b/i.test(correctedTarget)) {
      return correctedTarget;
    }
    // Extract the leading intent frame from the prior search query (e.g. "latest news in", "current price of", "weather in")
    const frameMatch = lastQuery.match(
      /^(.*?\b(?:la(?:test|stes|tes)\s+news(?:\s+(?:in|about|from|on|for))?|breaking\s+news(?:\s+(?:in|about|from|on|for))?|current\s+news(?:\s+(?:in|about|from|on|for))?|recent\s+news(?:\s+(?:in|about|from|on|for))?|news(?:\s+(?:in|about|from|on|for))?|current\s+price\s+of|price\s+of|stock\s+price\s+of|current\s+weather\s+in|weather\s+in|temperature\s+in|forecast\s+(?:in|for)|who\s+is\s+the\s+(?:current\s+)?(?:ceo|president|prime\s+minister|leader|governor|mayor)\s+of))\b/i
    );
    if (frameMatch && frameMatch[1]) {
      const normalizedFrame = frameMatch[1].replace(/\b(?:lates|lastes|latets|lastest)\s+news\b/gi, 'latest news').trim();
      return `${normalizedFrame} ${correctedTarget}`.trim();
    }
    // Or preserve trailing intent keywords from the prior query (e.g. "bitcoin current price" -> "ethereum current price")
    const INTENT_WORDS = ['latest', 'breaking', 'current', 'news', 'price', 'stock', 'weather', 'forecast', 'temperature', 'score'];
    const priorIntents = lastQuery
      .split(/\s+/)
      .filter((w) => INTENT_WORDS.includes(w.toLowerCase()));
    if (priorIntents.length > 0) {
      return `${priorIntents.join(' ')} ${correctedTarget}`.trim();
    }
    return correctedTarget;
  }

  // Case 2: Drill-down follow-up question (e.g. "why did el salvador deploy those troops" after "latest news Haiti")
  const GENERIC_WORDS = new Set([
    'latest', 'lates', 'lastes', 'breaking', 'current', 'today', 'todays', 'recent', 'news', 'update', 'updates',
    'event', 'events', 'happening', 'situation', 'story', 'stories', 'headline', 'headlines',
    'what', 'whats', 'who', 'why', 'how', 'when', 'where', 'is', 'are', 'was', 'were', 'did', 'does',
    'the', 'for', 'about', 'in', 'of', 'on', 'to', 'and', 'or', 'from', 'with', 'price', 'weather',
    'tell', 'me', 'search', 'web', 'online', 'happened', 'going', 'right', 'now', 'this', 'that', 'these', 'those',
  ]);

  const lowerCleaned = cleaned.toLowerCase();
  const topicTokens = lastQuery
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w.toLowerCase()) && !lowerCleaned.includes(w.toLowerCase()));

  if (topicTokens.length === 0) return cleaned;
  return `${cleaned} ${topicTokens.slice(0, 3).join(' ')}`.trim();
}

/**
 * Detects when the user explicitly asks to end the call/chat or says goodbye
 * (e.g. "end the call", "end the chat", "hang up", "goodbye", "bye", "that's all for now").
 */
export function isEndCallQuery(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 140) return false;
  if (
    /\b(end\s+(?:the\s+)?(?:call|chat|session|conversation)|hang\s+up|stop\s+listening|exit\s+voice(?:\s+mode)?|turn\s+off\s+continuous)\b/i.test(trimmed)
  ) {
    return true;
  }
  if (
    /^(?:ok(?:ay)?[,.\s]+|alright[,.\s]+|well[,.\s]+|thank\s+you[,.\s]+|thanks[,.\s]+)*(?:good\s*bye|bye(?:\s*bye)?|see\s+you(?:\s+later)?|talk\s+to\s+you\s+later|have\s+a\s+(?:good|great)\s+(?:day|night|one)|that'?s\s+all(?:\s+for\s+now)?|i'?m\s+done(?:\s+for\s+now)?)(?:\s+morfeus)?[!.,?\s]*$/i.test(trimmed)
  ) {
    return true;
  }
  return false;
}

/**
 * Detects queries that strictly require real-time web grounding (`web_search`) before answering
 * to complement a local LLM's limited/static built-in world knowledge:
 * - Explicit requests to search the web / look up online / fact-check
 * - Live / current prices of Bitcoin, crypto, stocks, indices, or commodities
 * - Current weather, temperature, or forecast
 * - Breaking / latest / today's news, current events, sports scores/schedules
 * - Current officeholders, CEOs, leaders, net worth, release dates, software versions
 * - Geopolitical, military, government, court, crime, or real-world event questions
 * - Follow-up questions, corrections ("i meant to say haiti"), or topic switches in a conversation with prior web searches
 */
export function isMandatoryWebSearchQuery(text: string, hasPriorWebSearch = false): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 500) return false;
  if (isEndCallQuery(trimmed)) return false;
  if (isRemoteOrPastedLog(trimmed) || shouldEnableLocalFileToolsInFastChat(trimmed)) return false;
  if (/\[Attached (?:Document|File):/i.test(trimmed) || trimmed.includes('```')) return false;
  // Exclude coding/scripting/debugging/math/translation/quiz-proctoring requests
  if (/\b(write|create|build|implement|code|debug|fix|refactor|translate|summarize this|quiz me|test me|one question at a time)\b.*\b(script|function|code|app|program|component|class|bot|api|exam|test|questions)?\b/i.test(trimmed) &&
      /\b(script|function|code|app|program|component|class|bot|api|quiz me|test me|one question at a time)\b/i.test(trimmed)) {
    return false;
  }

  // Exclude study session continuations, exam answers, and requests to repeat / continue
  const isConversationalFlow =
    /\b(?:repeat|repeat the question|say that again|try again|please try again|continue|let'?s continue|contniue|keep going|next|next question|one by one|ask me|ask the next|another question|option\s+[a-d]|choice\s+[a-d]|\([a-d]\)|^[a-d][.)]?$|correct|incorrect|why is that|explain why)\b/i.test(trimmed);
  if (isConversationalFlow) {
    return false;
  }

  // 1. Explicit web search / online lookup / fact-check requests
  if (/\b(search the web|search online|look up online|web search|google this|search the internet|fact[- ]?check|check online|find online)\b/i.test(trimmed)) {
    return true;
  }

  // 2. Live / current financial, crypto, stock, index, or commodity prices
  const hasPriceWord = /\b(price|prices|value|worth|rate|quote|trading at|market cap|exchange rate|net worth)\b/i.test(trimmed);
  const hasTemporalLive = /\b(current|currently|live|spot|right now|today|today'?s|latest|at the moment|this week|this month|this year)\b/i.test(trimmed);
  const hasAsset = /\b(bitcoin|btc|ethereum|eth|solana|sol|dogecoin|doge|xrp|ripple|cardano|ada|bnb|litecoin|ltc|avax|polkadot|dot|chainlink|link|shib|uniswap|uni|xlm|atom|sui|apt|pepe|crypto|cryptocurrency|gold|silver|crude oil|s&p\s*500|sp500|nasdaq|dow jones|djia|nvda|nvidia|tsla|tesla|aapl|apple stock|msft|amzn|googl|meta|amd|nflx|pltr|coin|mstr|stock|stocks|share price)\b/i.test(trimmed);
  if ((hasPriceWord && hasTemporalLive) || (hasPriceWord && hasAsset) || /\bhow much is (?:1\s+|a\s+|an\s+)?(?:bitcoin|btc|ethereum|eth|solana|sol|dogecoin|doge|xrp|gold|silver)\b/i.test(trimmed)) {
    return true;
  }

  // 3. Current weather / temperature / forecast
  if (/\b(current weather|weather today|weather right now|weather forecast|weather in\s+\w+|what'?s the weather|how'?s the weather|temperature in\s+\w+)\b/i.test(trimmed)) {
    return true;
  }

  // 4. Breaking / latest / today's news (including common typos like "lates news" / "lastes news" / "happeing"), sports scores, schedules, & current events
  if (
    /\b(la(?:test|stes|tes|tets|stest)\s+news|breaking news|today'?s news|current news|recent news|what (?:happened|is\s+(?:happen(?:ing)?|happeing|hapening|going\s+on))|what'?s\s+(?:happen(?:ing)?|happeing|hapening|going\s+on)|top news|news (?:wise|about|in|from|on|for)|current events|who won the|score of the|standings|next game)\b/i.test(trimmed) ||
    /\b(?:happen(?:ing)?|happeing|hapening|going\s+on)\s+(?:in|with|to|at)\s+\w+/i.test(trimmed)
  ) {
    return true;
  }

  // 5. Current officeholders, CEOs, leaders, versions, release dates, & recent years (2024–2027)
  if (/\b(who is the current|who is the ceo of|who is the president of|who is the governor of|who is the mayor of|who is the prime minister of|latest version of|release date of|when does .* come out|in 202[4-9])\b/i.test(trimmed)) {
    return true;
  }

  // 6. Real-world regulatory, state law, DMV, licensing, or tax rules (when no local document is attached)
  if (/\b(what are the (?:rules|requirements|laws|regulations) for|dmv|driver'?s license|insurance (?:commissioner|regulation|requirement|licensing)|state law in|tax rate in)\b/i.test(trimmed)) {
    return true;
  }

  // 7. Geopolitical, military, government, court, crime, or real-world event questions (e.g. "why did el salvador deploy those troops")
  if (/\b(troops|military|soldiers|deploy(?:ed|ment)?|drone strike|gang(?:s)?|cartel|kidnap(?:ped|ping)?|supreme court|prime minister|president|election(?:s)?|sanctions|ceasefire|treaty|embassy|airstrike|hostage(?:s)?)\b/i.test(trimmed)) {
    return true;
  }

  // 8. In a conversation that has already used `web_search`, trigger follow-up web_search
  // if the user explicitly makes a correction ("i meant haiti", "sorry i meant ethereum"),
  // asks a question with temporal/live/news/price/weather keywords, or asks an explicit follow-up question ("what about ...?")
  if (hasPriorWebSearch) {
    if (extractCorrectionTarget(trimmed) !== null) {
      return true;
    }
    const hasTemporalOrSearch =
      /\b(?:search|look up|check online|what about|how about|happen(?:ed|ing)?|current|latest|today|price|weather|news|why did that|what caused)\b/i.test(trimmed);
    const isPureAcknowledgement =
      /^(?:thanks|thank\s+you|thx|ty|ok|okay|k|got\s+it|cool|great|awesome|perfect|nice|good|makes\s+sense|understood|bye|goodbye|hello|hi|hey|yes|no|yep|nope)(?:\s+(?:so\s+much|very\s+much|a\s+lot|for\s+(?:the\s+|that\s+|this\s+|your\s+)?(?:info(?:rmation)?|update|help|answer|explanation|details|clarification)|morfeus|buddy|friend|man))*[.!?\s]*$/i.test(trimmed);
    if (hasTemporalOrSearch && !isPureAcknowledgement && trimmed.length >= 3) {
      return true;
    }
  }

  return false;
}

/**
 * Determines whether a connected MCP server is relevant to the user's turn.
 * Gating prevents domain-specific servers (e.g. FreeCAD 3D CAD, PostgreSQL) from polluting general
 * web searches or casual chat, avoiding tool confusion like FreeCAD's `list_documents` firing for a DMV query.
 */
export function isMcpServerRelevant(
  server: { id: string; name?: string; category?: string },
  userText: string,
  hasPriorServerCalls = false
): boolean {
  if (hasPriorServerCalls) return true;
  if (!userText) return false;
  const text = userText.toLowerCase();
  const id = server.id.toLowerCase();
  const name = (server.name || '').toLowerCase();

  // Explicit mention of server id, name, or generic "mcp"
  if (text.includes(id) || (name && text.includes(name)) || /\b(mcp|integration|integrations)\b/i.test(text)) {
    return true;
  }

  // Domain-specific keyword matching based on server category/id
  if (id.includes('freecad') || id.includes('cad') || server.category === 'cad') {
    return /\b(freecad|cad|3d|mesh|stl|step|iges|obj|part|sketch|extrude|fillet|chamfer|loft|pocket|pad|parametric|solid|geometry|model(?:ing)?|render(?:ing)?)\b/i.test(text);
  }

  if (id.includes('postgres') || id.includes('sql') || id.includes('sqlite') || id.includes('db') || server.category === 'database') {
    return /\b(postgres|postgresql|mysql|sqlite|database|db|sql|query|schema|table|tables|rows|select|insert|update|delete|migration)\b/i.test(text);
  }

  if (id.includes('github') || id.includes('git') || server.category === 'git') {
    return /\b(github|repo|repository|pull request|pr|issue|issues|commit|commits|branch|branches|workflow|actions)\b/i.test(text);
  }

  if (id.includes('puppeteer') || id.includes('browser') || server.category === 'web') {
    return /\b(puppeteer|headless|navigate|screenshot|browser automation|scrape|playwright)\b/i.test(text);
  }

  // For other custom MCP servers, match on words in the server's name/id
  const keywords = [...id.split(/[-_]/), ...name.split(/\s+/)].filter(k => k.length >= 3);
  return keywords.some(k => text.includes(k.toLowerCase()));
}

// ── Agent Coder project context ──────────────────────────────────────────────
const IGNORED_TOP_LEVEL = new Set([
  'node_modules', 'target', 'dist', 'build', '.git', '.next', '.venv', 'venv', '__pycache__', '.DS_Store',
]);

/**
 * Build a compact description of the selected project (file tree, git state, project rules)
 * that is injected into the Agent Coder system prompt so the model knows where it is working.
 * Every step is best-effort; failures never block the chat.
 */
async function buildProjectContext(projectPath: string): Promise<string> {
  const sections: string[] = [];

  try {
    const entries = await tauriApi.listDirectory(projectPath);
    const visible = entries
      .filter((e) => !IGNORED_TOP_LEVEL.has(e.name))
      .sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name))
      .slice(0, 60);
    if (visible.length > 0) {
      sections.push(`Top-level files:\n${visible.map((e) => (e.is_dir ? `${e.name}/` : e.name)).join('\n')}`);
    }
  } catch { /* unreadable folder */ }

  try {
    const branch = await tauriApi.runTerminalCommand('git branch --show-current', projectPath);
    if (branch.success && branch.stdout.trim()) {
      const status = await tauriApi.runTerminalCommand('git status --short', projectPath);
      const changed = status.success ? status.stdout.split('\n').map((l) => l.trimEnd()).filter(Boolean) : [];
      const shown = changed.slice(0, 25);
      sections.push(
        `Git branch: ${branch.stdout.trim()}\n` +
        (changed.length === 0
          ? 'Working tree clean.'
          : `Uncommitted changes (${changed.length}):\n${shown.join('\n')}${changed.length > shown.length ? `\n… and ${changed.length - shown.length} more` : ''}`)
      );
    }
  } catch { /* not a git repo */ }

  try {
    const rules = await tauriApi.findProjectRules(projectPath);
    let budget = 6000;
    for (const rule of rules) {
      if (budget <= 0) break;
      const text = rule.content.slice(0, Math.min(3000, budget));
      budget -= text.length;
      sections.push(`Project rules (${rule.file_name}):\n${text}`);
    }
  } catch { /* no rules */ }

  return sections.join('\n\n');
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

/**
 * Fallback parser for text-formatted tool calls emitted by models like Nemotron, Qwen, or Mistral.
 * Handles both XML format (<tool_call><function=name><parameter=k>v</parameter></function></tool_call>)
 * and JSON format (<tool_call>{"name": "...", "arguments": {...}}</tool_call>).
 */
function parseTextToolCalls(content: string): { toolCalls: ToolCall[]; cleanedContent: string } {
  const toolCalls: ToolCall[] = [];
  let cleanedContent = content;

  // 1. Nemotron XML format
  const xmlRegex = /<tool_call>\s*<function=([a-zA-Z0-9_-]+)>(.*?)<\/function>\s*<\/tool_call>/gis;
  let match;
  while ((match = xmlRegex.exec(content)) !== null) {
    const fnName = match[1];
    const body = match[2];
    const args: Record<string, any> = {};
    const paramRegex = /<parameter=([a-zA-Z0-9_-]+)>\s*(.*?)\s*<\/parameter>/gis;
    let pMatch;
    while ((pMatch = paramRegex.exec(body)) !== null) {
      const pName = pMatch[1];
      let pVal: any = pMatch[2].trim();
      if (/^\d+$/.test(pVal)) pVal = parseInt(pVal, 10);
      else if (/^\d+\.\d+$/.test(pVal)) pVal = parseFloat(pVal);
      else if (pVal === 'true') pVal = true;
      else if (pVal === 'false') pVal = false;
      args[pName] = pVal;
    }
    toolCalls.push({
      id: generateId(),
      type: 'function',
      function: {
        name: fnName,
        arguments: JSON.stringify(args),
      },
    });
  }

  // 2. JSON format
  const jsonRegex = /<tool_call>\s*(\{.*?\})\s*<\/tool_call>/gis;
  while ((match = jsonRegex.exec(content)) !== null) {
    try {
      const obj = JSON.parse(match[1]);
      const fnName = obj.name || obj.function?.name;
      const fnArgs = obj.arguments || obj.function?.arguments || obj.parameters || {};
      if (fnName) {
        toolCalls.push({
          id: generateId(),
          type: 'function',
          function: {
            name: fnName,
            arguments: typeof fnArgs === 'string' ? fnArgs : JSON.stringify(fnArgs),
          },
        });
      }
    } catch {}
  }

  cleanedContent = cleanedContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim();

  return { toolCalls, cleanedContent };
}

// ── Send serialization (shared across every useChat() instance) ──────────────
let sendInFlight = false;
let lastSentText = '';
let lastSentAt = 0;
const DUPLICATE_SEND_WINDOW_MS = 1000;

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

  const sendMessageUnsafe = useCallback(
    async (content: string) => {
      if (!content.trim()) return;
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
        api_content: apiContent !== userDisplayContent ? apiContent : undefined,
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

        // ── Agent Coder project scope ──
        const convRecord = useChatStore.getState().conversations.find((c) => c.id === convId);
        const projectPath: string | null = !isFastMode
          ? (convRecord?.project_path ?? useProjectStore.getState().activeProjectPath ?? null)
          : null;

        // Resolve model-supplied paths: relative paths (and '.') are anchored to the project root.
        const resolvePath = (p?: string): string => {
          const raw = (p ?? '').trim();
          if (!projectPath) return raw;
          if (!raw || raw === '.') return projectPath;
          if (/^([a-zA-Z]:[\\/]|[\\/]|~)/.test(raw)) return raw;
          const sep = projectPath.includes('\\') && !projectPath.includes('/') ? '\\' : '/';
          return projectPath.replace(/[\\/]+$/, '') + sep + raw.replace(/^\.[\\/]/, '');
        };

        let projectBlock = '';
        if (projectPath) {
          const ctx = await buildProjectContext(projectPath);
          projectBlock = `PROJECT WORKSPACE:
You are working inside the project at: ${projectPath}
- Relative paths resolve against the project root. run_terminal_command executes with the project root as its working directory.
- grep_search and search_files default to the project root. Prefer grep_search → read_file_range → replace_in_file over reading or rewriting whole files.
- Do not read or modify files outside the project unless the user explicitly asks.
${ctx ? `\n${ctx}\n` : ''}
`;
        }

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

        // Auto Token Adjuster: Dynamic Token Headroom calculation
        // When max_tokens is 0 (Auto), compute the largest safe output allocation (up to 8,192).
        // If Think is enabled, ensure sufficient headroom so the model can both think and write.
        const effectiveContext = resolveEffectiveContextLength(resolvedModelId, currentSettings.context_length);
        const isAutoTokens = !currentSettings.max_tokens || currentSettings.max_tokens === 0;
        const maxAllowed = Math.max(1024, Math.floor(effectiveContext * 0.65));

        let effectiveMaxTokens: number;
        if (isAutoTokens) {
          effectiveMaxTokens = Math.min(8192, maxAllowed);
        } else {
          const userMax = Math.max(currentSettings.max_tokens, 1024);
          effectiveMaxTokens = Math.min(userMax, maxAllowed);
        }
        if (isThink) {
          const REASONING_HEADROOM = 4096;
          effectiveMaxTokens = Math.min(
            effectiveMaxTokens + REASONING_HEADROOM,
            Math.max(2048, Math.floor(effectiveContext * 0.75))
          );
        }

        const effectiveSettings: AppSettings = {
          ...currentSettings,
          base_url: effectiveBaseUrl,
          api_key: effectiveApiKey,
          model_id: resolvedModelId,
          context_length: effectiveContext,
          max_tokens: effectiveMaxTokens,
        };

        const isVoiceActive = useSettingsStore.getState().settings.tts_enabled;
        const voiceDirective = isVoiceActive
          ? `\n\nVOICE MODE DIRECTIVE: Your response will be spoken aloud to the user using text-to-speech. If the user asks for current prices (e.g. Bitcoin, crypto, stocks), breaking news, weather, or live facts, you MUST still call the \`web_search\` tool first before speaking your answer—never guess prices or facts from memory. Once you have the answer, keep spoken responses natural, direct, and concise (1 to 3 punchy sentences). Avoid long rambling introductions, bullet lists, or reading code out loud—provide the code in markdown and give a brief 1-sentence spoken summary. Display all source links and references at the very end under a "### Sources" heading so they are displayed visually but not spoken.`
          : '';

        // Qwen3-family models ignore the API-level think flag on OpenAI-compatible endpoints;
        // their documented soft switch is "/no_think" in the prompt.
        const isQwenModel = /qwen/i.test(resolvedModelId || '');
        const thinkDirective = !isThink
          ? `\n\nCRITICAL THINKING DIRECTIVE: Thinking mode is explicitly turned OFF by the user. Do NOT output internal reasoning scratchpads, thinking tokens, or <think> tags. Answer immediately, directly, and concisely.${isQwenModel ? '\n\n/no_think' : ''}`
          : '';

        const conversationMsgs = useChatStore.getState().messages.filter(m => m.conversation_id === convId);
        const activeMcpServers = useMcpStore.getState().servers.filter(s => s.status === 'connected' && s.enabled);
        
        // Filter MCP servers by relevance so domain-specific tools (e.g. FreeCAD 3D CAD, PostgreSQL)
        // do not hijack general web searches, casual conversation, or driving test queries.
        const relevantMcpServers = activeMcpServers.filter(srv => {
          const hasPriorCalls = conversationMsgs.some(m =>
            m.tool_calls?.some(tc => tc.function?.name?.startsWith(`mcp__${srv.id}__`))
          );
          return isMcpServerRelevant(srv, userDisplayContent, hasPriorCalls);
        });

        let mcpBlock = '';
        if (relevantMcpServers.length > 0) {
          const serverNames = relevantMcpServers.map(s => s.name || s.id).join(', ');
          mcpBlock = `\n\n[Connected integrations: ${serverNames}. Tools from these integrations are available via native function calling when relevant. Do NOT list, advertise, or recite these tools in casual conversation or greetings.]`;
        }

        let systemPrompt: string;

        if (isFastMode) {
          systemPrompt = `You are Morfeus, a helpful, intelligent, and versatile AI assistant.

Today's Date: ${dateStr}

DIRECTIVES:
1. NATURAL CONVERSATION & GREETINGS: When the user says "hi", "hey", "hello", or engages in casual chat, reply warmly, naturally, and concisely like a normal AI assistant. NEVER list your tools, active modes, capabilities, or connected MCP servers unless the user explicitly asks for them.
2. SPEED & CLARITY: Respond immediately and articulately without unnecessary conversational filler or throat-clearing.
3. CONCISE CODE OUTPUT: When asked for code or debugging help, provide clean, self-contained, working code directly. Let clean code speak for itself and conserve tokens. Do not add unsolicited line-by-line tutorials or filler.
4. LOCAL HOST VS REMOTE / PASTED CONTEXT (CRITICAL):
   - You run on the user's desktop computer. You DO NOT have access to the user's remote machines, Raspberry Pi, Docker containers, VMs, SSH hosts, or external servers.
   - When the user pastes logs, shell output, error messages, terminal sessions (e.g. "pi@pi:~$", "docker logs", "root@server:~$"), or code snippets containing file paths (e.g. "/config/...", "/data/...", "ia.ini", ".torrent"), DO NOT search for or read those files on the user's local computer. They do not exist on the user's local host!
   - Answer directly by analyzing the provided text and error messages. Provide the requested code, configuration, or shell commands for the user to run on their machine or container.
   - ONLY call local file tools if the user explicitly asks to find or read a file on their own computer (e.g. "find my resume", "read file at /path").
5. MANDATORY REAL-TIME WEB SEARCH & TOOL CALLING: You MUST call the \`web_search\` tool BEFORE answering ANY question about current/live prices (e.g. Bitcoin, crypto, stocks, gold), latest/today's news, weather, sports scores, current events, or real-time facts. NEVER guess or fabricate current prices, facts, or source URLs from training memory—even in Voice Mode or when Thinking is off. Never recite your tools unprompted in casual greetings.
6. WEB SEARCH, ARTICLES & GROUNDING: When searching the web or asked to read news stories or articles, provide a thorough, informative breakdown covering the key details (who, what, when, where, charges, facts, context). State the exact current date/time ("As of ${dateStr} at ${timeStr}...") and ALWAYS conclude with direct clickable Markdown source links formatted under a "### Sources" section at the very end: [Source Title](url) pointing ONLY to exact URLs returned by the \`web_search\` tool.
7. DIRECT QUIZ & EXAM PROCTORING: When the user asks to be quizzed, practice for an exam, or take a mock test (e.g. asking for "one question at a time"), act directly as the exam proctor. If a study guide or practice exam document is attached in the conversation, ALWAYS use the exact questions and exact A, B, C, D options from the attached document in sequential order. Immediately present the actual subject-matter question with its 4 specific multiple-choice options (A, B, C, D). NEVER reuse or repeat the same multiple-choice options from a previous question. NEVER ask meta-questions about the user's feelings, confidence level, or session goals. Wait for the user's answer before providing the answer key and moving to the next question.
8. CODING LIMITATION: Chat mode does not edit codebase files directly (inform the user to switch to "Agent Coder" mode if they need codebase editing).${mcpBlock}${voiceDirective}${thinkDirective}`;
        } else {
          const basePrompt = currentSettings.system_prompt || 'You are Morfeus, a powerful, articulate, and versatile desktop AI assistant and autonomous developer harness.';
          systemPrompt = `${basePrompt}

Today's Date: ${dateStr}

${projectBlock}CRITICAL DIRECTIVES:
1. NATURAL CONVERSATION & GREETINGS: When the user greets you or makes casual conversation (e.g. "hi", "hey", "hello"), respond naturally and concisely as a general AI assistant. NEVER list your tools, dev servers, or connected MCP integrations unless explicitly asked.
2. LOCAL WORKSPACE VS REMOTE / PASTED LOGS (CRITICAL):
   - You run on the user's desktop computer. You DO NOT have access to the user's remote machines, Raspberry Pis, Docker containers, VMs, or external servers unless explicitly commanded via ssh_execute.
   - When the user pastes error logs, shell snippets, or terminal output from a remote machine, Raspberry Pi, server, or Docker container (e.g. "pi@pi:~$", "docker logs", "/config/...", "/data/..."), DO NOT attempt to search for or read those files on the local machine. The local machine does NOT contain the remote container's filesystem.
   - Answer directly: diagnose the issue from the pasted output, explain the root cause, and provide the exact code, configuration, or commands the user needs to apply.
   - ONLY use local codebase tools (grep_search, read_file_range, replace_in_file, etc.) when working on files within the active local project workspace or when explicitly asked.
3. AUTONOMOUS ReAct LOOP (WHEN LOCAL CODING/TASKED): When tasked with solving a problem, debugging, or coding inside the active local project, operate autonomously in a continuous ReAct (Reason, Act, Observe) loop. Do not stop at the first step—inspect files, search, run code, observe outputs, and iterate until the objective is accomplished.
4. FULL DEVELOPER TOOL ACCESS: You have complete access to terminal commands (run_terminal_command), remote device execution over SSH (ssh_execute), background dev server & process management (spawn_background_process, read_process_logs, kill_background_process, list_background_processes), Python execution (run_python, run_python_file), package installation (install_python_packages), file creation and editing (write_to_file, delete_file), filesystem exploration, screen inspection (analyze_screen), and connected MCP integrations. Use them when relevant to solve tasks.
5. SURGICAL PRECISION: Always inspect files and read existing code before editing to preserve project conventions and architecture.
6. CONVERSATIONAL BALANCE: When the user asks general questions or explanations, answer directly, concisely, and articulately without invoking unnecessary tools.
7. WEB SEARCH, ARTICLES & GROUNDING: When searching the web or reading news/articles, synthesize comprehensive, verified information with key details and quotes. State the exact current date/time ("As of ${dateStr} at ${timeStr}...") and ALWAYS provide direct clickable markdown source links: [Source Title](url).
8. SUMMARY ON COMPLETION: When finishing a multi-step task, provide a clear, structured summary of what was accomplished (files read/modified, tools executed, results verified).
9. TOKEN CONSERVATION & ZERO-NOISE CODE DELIVERY:
   - NO PREAMBLE: Deliver code directly without conversational throat-clearing ("Here is the complete drop-in file...", "Sure, I can help with that...").
   - ZERO UNPROMPTED EXPLANATIONS: Do NOT append unsolicited line-by-line breakdowns ("What this does"), beginner tutorials ("To use it: save as file, press F5..."), or speculative advice ("If you want 3D printing..."). The user already knows how to run their tools.
   - NO CONVERSATIONAL TRAILERS: Do NOT end with unsolicited offers ("Want me to also add a filleted version... Just say the word."). Stop generating as soon as the code/task is delivered.
   - CODE OVER NOISE: Let well-structured code with concise inline comments explain the implementation. If the user explicitly asks for an explanation, keep it to 1–2 punchy bullets highlighting key architectural decisions.
10. NO REPEATED FILE READS (ANTI-LOOP DIRECTIVE):
   - Never call read_file_range or read_local_file repeatedly on the same file in overlapping or slightly shifted chunks. Once you have read a file, its complete contents are already in your conversation context above.
   - Do NOT loop. Synthesize what you have gathered and write your response.
11. WORKSPACE OVERVIEW PROTOCOL:
   - When asked to "read the workspace", "get familiar with the project", or "understand the application", inspect the key architecture/entry files ONCE, then immediately synthesize your findings into a comprehensive, structured architecture summary (Overview, Key Modules, Execution Flow, Configuration).
12. NATIVE FUNCTION CALLING ONLY:
   - Always invoke tools via native API function calling. NEVER output raw XML or pseudo-tags such as <tool_call>, <function=...>, or </tool_call> in plain text.${mcpBlock}${voiceDirective}${thinkDirective}`;
        }

        // ── Tool dedup + rate limiting: persists across all recursive depths for this turn ──
        const calledToolKeys = new Set<string>();
        const fileReadCounts = new Map<string, number>();
        let totalToolCalls = 0;       // hard cap: max tools total per user turn
        let consecutiveErrors = 0;    // if 2 errors in a row, stop and answer from what we know
        const MAX_TOTAL_TOOLS = 20;

        // Collect prior `web_search` queries from this conversation so follow-up questions
        // (e.g. "why did el salvador deploy those troops" after "latest news Haiti") inherit topic context.
        const priorWebSearchQueries: string[] = [];
        for (const msg of conversationMsgs) {
          if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
            for (const tc of msg.tool_calls) {
              if (tc.function?.name === 'web_search') {
                try {
                  const parsedArgs = typeof tc.function.arguments === 'string'
                    ? JSON.parse(tc.function.arguments)
                    : (tc.function.arguments || {});
                  if (typeof parsedArgs?.query === 'string' && parsedArgs.query.trim()) {
                    priorWebSearchQueries.push(parsedArgs.query.trim());
                  }
                } catch {
                  // ignore malformed args
                }
              }
            }
          }
        }
        const webSearchSourcesThisTurn: Array<{ title: string; url: string }> = [];

        // ── Build API-formatted message history ──
        const buildApiMessages = (isInitialTurn: boolean) => {
          const allMsgs = useChatStore.getState().messages.filter(
            m => m.conversation_id === convId
          );

          // Find the active user query for this current interaction
          const lastUserMsg = [...allMsgs].reverse().find(m => m.role === 'user');

          // Trim older turns to fit within context window while strictly preserving
          // the active turn (user query + tool calls + tool results).
          const fittedMsgs = trimHistoryToContext(allMsgs, {
            systemPrompt,
            contextLength: effectiveSettings.context_length || 16384,
            maxTokens: effectiveSettings.max_tokens || 2048,
          });

          const history: any[] = [];
          for (let i = 0; i < fittedMsgs.length; i++) {
            const msg = fittedMsgs[i];

            // Format each role correctly for the OpenAI API spec
            let apiMsg: any;
            if (msg.role === 'assistant') {
              apiMsg = msg.tool_calls?.length
                ? {
                    role: 'assistant',
                    content: msg.content ?? null,
                    tool_calls: msg.tool_calls.map((tc: any, idx: number) => ({
                      id: tc.id || `call_${idx}`,
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
              if (typeof msg.content === 'string' && msg.content.includes('data:image/')) {
                // Strip raw base64 payload from LLM context to prevent Ollama OOM / crash
                const cleanContent = msg.content
                  .replace(/!\[.*?\]\(data:image\/[^;]+;base64,[^)]+\)/g, '[Image displayed to user in chat UI]')
                  .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[Image base64 data omitted for efficiency]');
                apiMsg = {
                  role: 'tool',
                  tool_call_id: msg.tool_call_id || 'call_0',
                  content: capOutput(cleanContent),
                };
              } else {
                apiMsg = {
                  role: 'tool',
                  tool_call_id: msg.tool_call_id || 'call_0',
                  content: typeof msg.content === 'string' ? capOutput(msg.content) : (msg.content ?? ''),
                };
              }
            } else {
              apiMsg = { role: msg.role, content: msg.api_content || msg.content || '' };
            }

            // On the initial user turn, swap in the real apiContent (may include images)
            if (isInitialTurn && i === fittedMsgs.length - 1) {
              apiMsg.content = apiContent;
            }

            history.push(apiMsg);
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

          return [{ role: 'system', content: systemPrompt }, ...sanitizeHistory(history)];
        };

        // ── Execute tool call ──
        const executeTool = async (name: string, args: Record<string, any>, callId: string): Promise<string> => {
          let result: string;

          // Anchor model-supplied paths/roots to the selected project (Agent Coder only)
          if (projectPath) {
            if (['list_directory', 'read_local_file', 'read_file_range', 'run_python_file', 'write_to_file', 'replace_in_file', 'delete_file'].includes(name)) {
              args = { ...args, path: resolvePath(args.path) };
            } else if (name === 'search_files' || name === 'grep_search') {
              args = { ...args, root: args.root ? resolvePath(args.root) : projectPath };
            }
          }

          if (name === 'web_search') {
            let q = (args.query || '').trim();
            if (
              q &&
              !q.startsWith('http://') &&
              !q.startsWith('https://') &&
              priorWebSearchQueries.length > 0
            ) {
              // If the user turn was a correction ("i am sorry i meant to say haiti"), or the model passed
              // a bare 1-2 word entity ("haiti") or follow-up pronouns ("those troops"), construct the full contextual query
              const userCorrection = extractCorrectionTarget(userDisplayContent);
              const queryCorrection = extractCorrectionTarget(q);
              const isBareEntityWithoutIntent =
                q.split(/\s+/).length <= 2 &&
                !/\b(news|price|weather|stock|score|forecast|who|why|how|when|where|what)\b/i.test(q);
              const hasFollowUpPronouns =
                /\b(this|those|these|that|they|them|their|there|the troops|the gang|the strike)\b/i.test(q);

              if (userCorrection || queryCorrection) {
                q = buildContextualSearchQuery(userCorrection ? userDisplayContent : q, priorWebSearchQueries);
              } else if (isBareEntityWithoutIntent || hasFollowUpPronouns) {
                q = buildContextualSearchQuery(q, priorWebSearchQueries);
              }
              if (q !== (args.query || '').trim()) {
                useChatStore.setState((state) => ({
                  messages: state.messages.map((m) =>
                    m.conversation_id === convId && Array.isArray(m.tool_calls)
                      ? {
                          ...m,
                          tool_calls: m.tool_calls.map((tc) =>
                            tc.id === callId
                              ? { ...tc, function: { ...tc.function, arguments: JSON.stringify({ query: q }) } }
                              : tc
                          ),
                        }
                      : m
                  ),
                }));
              }
            }
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
                priorWebSearchQueries.push(q);
                for (const r of res.slice(0, 5)) {
                  const title = String(r?.title || '').trim();
                  const url = String(r?.url || '').trim();
                  if (
                    title &&
                    (url.startsWith('http://') || url.startsWith('https://')) &&
                    !webSearchSourcesThisTurn.some((s) => s.url === url)
                  ) {
                    webSearchSourcesThisTurn.push({ title, url });
                  }
                }

                // Auto-fetch top readable article content so the local LLM has deep context (like Gemini/Perplexity).
                // Skip bare publisher homepages (e.g. "https://www.reuters.com") and structured live-ticker endpoints
                // whose authoritative figures are already embedded in `[LIVE VERIFIED DATA]` snippets.
                let topArticleContent = '';
                const topResult = res[0];
                const isScrapeCandidate = (r: any): boolean => {
                  const u = String(r?.url || '');
                  if (!u.startsWith('http://') && !u.startsWith('https://')) return false;
                  if (String(r?.title || '').startsWith('[LIVE VERIFIED DATA]')) return false;
                  try {
                    const parsed = new URL(u);
                    // Skip bare root homepages (path is "/" or empty) which come from fallback RSS <source> tags
                    return parsed.pathname.length > 1;
                  } catch {
                    return false;
                  }
                };

                const scrapeTargets = res.filter(isScrapeCandidate).slice(0, 5);
                const scrapedResults = await Promise.allSettled(
                  scrapeTargets.map(async (target) => {
                    const pageText = await tauriApi.fetchWebpage(target.url);
                    if (pageText && !pageText.startsWith('[Webpage Notice]') && pageText.length > 120) {
                      const clippedPage = pageText.length > 2500 ? `${pageText.slice(0, 2500)}...` : pageText;
                      return `═══════════════════════════════════════════════════\nFULL ARTICLE CONTENT (From Source: "${target.title}" | ${target.url}):\n═══════════════════════════════════════════════════\n${clippedPage}\n═══════════════════════════════════════════════════`;
                    }
                    return null;
                  })
                );
                const scrapedBlocks = scrapedResults
                  .filter((r): r is PromiseFulfilledResult<string | null> => r.status === 'fulfilled' && r.value !== null)
                  .map((r) => r.value as string);
                if (scrapedBlocks.length > 0) {
                  topArticleContent = `\n\n${scrapedBlocks.join('\n\n')}`;
                }

                const searchSnippets = res.map((r, i) =>
                  `[Source ${i + 1}]: "${r.title}"\nURL: ${r.url}\nSnippet: ${r.snippet}`
                ).join('\n\n');

                const directive = `SYNTHESIS DIRECTIVE (FACTUAL GROUNDING): Synthesize a clear, accurate, and comprehensive response grounded directly in the verified search results and source material below. Address the user's specific request directly. Incorporate specific facts, laws, requirements, figures, and details from the sources. If a "[LIVE VERIFIED DATA]" entry is present, treat its exact figures as 100% authoritative. State the exact current date/time ("As of ${dateStr} at ${timeStr}...") and ALWAYS conclude with direct clickable markdown source links at the end: [${topResult?.title || 'Source'}](${topResult?.url || ''}).`;

                result = `${directive}\n\nSearch Results for query "${q}":\n\n${searchSnippets}${topArticleContent}\n\n${directive}`;
              } else {
                result = `No verified web search results matched the query "${q}". Please answer the user's request directly using your extensive pre-trained domain knowledge and state the current date/time ("As of ${dateStr} at ${timeStr}..."). Do NOT cite web sources or URLs that were not found.`;
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
              ? `No files found matching "${args.query}" on the local host. (Note: If this query was from pasted remote logs, Docker containers, or an external server, it does not exist locally. Please answer the user's question directly with the appropriate code or instructions).`
              : `Found ${found.length} result(s):\n${found.map(f => f.is_dir ? `📁 ${f.path}/` : `📄 ${f.path}`).join('\n')}`;
          } else if (name === 'grep_search') {
            const matches = await tauriApi.grepSearch(args.query, args.root, args.includes, args.case_insensitive);
            if (matches.length === 0) {
              result = `No code matches found for "${args.query}" in local workspace. (Note: If analyzing pasted logs or external code, do not continue searching locally; answer the user's question directly).`;
            } else {
              const formatted = matches.map(m => `${m.file}:${m.line_number}: ${m.line_content}`).join('\n');
              result = `Found ${matches.length} match(es) for "${args.query}":\n\`\`\`\n${formatted}\n\`\`\``;
            }
          } else if (name === 'read_file_range') {
            try {
              const rangeRes = await tauriApi.readFileRange(args.path, Number(args.start_line) || 1, Number(args.end_line) || 100);
              result = `File: ${rangeRes.path} (lines ${rangeRes.start_line}–${rangeRes.end_line} of ${rangeRes.total_lines}):\n\`\`\`\n${rangeRes.content}\`\`\``;
            } catch (err) {
              result = `Error reading file range for "${args.path}": ${String(err)}. (Note: If this path is from a remote machine, container, or external system, it cannot be read locally. Answer the user directly).`;
            }
          } else if (name === 'read_local_file') {
            try {
              result = await tauriApi.parseLocalFile(args.path);
            } catch (err) {
              result = `Error reading local file "${args.path}": ${String(err)}. (Note: If this file is on a remote machine or container, it does not exist on the local computer. Provide the code or solution directly to the user).`;
            }
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
            name === 'ssh_execute' ||
            name === 'spawn_background_process' ||
            name === 'kill_background_process' ||
            name === 'read_process_logs' ||
            name === 'list_background_processes' ||
            name === 'write_to_file' ||
            name === 'replace_in_file' ||
            name === 'delete_file' ||
            name === 'analyze_screen' ||
            name === 'mouse_click' ||
            name === 'type_text' ||
            name === 'press_key' ||
            name === 'mouse_move'
          ) {
            let needsApproval = false;
            
            // Require approval for sensitive or active OS / process tools
            if (
              name === 'delete_file' ||
              name === 'mouse_click' ||
              name === 'type_text' ||
              name === 'press_key' ||
              name === 'run_terminal_command' ||
              name === 'ssh_execute' ||
              name === 'spawn_background_process' ||
              name === 'kill_background_process'
            ) {
              needsApproval = true;
            }

            // Per-session auto-approve applies to terminal commands and SSH
            if (
              (name === 'run_terminal_command' || name === 'ssh_execute') &&
              useChatStore.getState().autoApprove
            ) {
              needsApproval = false;
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
              const res = await tauriApi.runTerminalCommand(args.command, projectPath);
              const status = res.success ? '✅ Success' : `❌ Failed (exit code ${res.exit_code})`;
              const out = res.stdout.trim();
              const err = res.stderr.trim();
              result = [
                `${status}`,
                out ? `\n**stdout:**\n\`\`\`\n${out}\n\`\`\`` : '',
                err ? `\n**stderr:**\n\`\`\`\n${err}\n\`\`\`` : '',
              ].filter(Boolean).join('\n');
            } else if (name === 'ssh_execute') {
              const res = await tauriApi.runSshCommand(args.host, args.command, {
                user: args.user,
                port: args.port ? Number(args.port) : undefined,
                key_path: args.key_path,
              });
              const targetStr = `${args.user ? args.user + '@' : ''}${args.host}${args.port ? ':' + args.port : ''}`;
              const status = res.success ? `✅ SSH Success (${targetStr})` : `❌ SSH Failed (${targetStr}, exit code ${res.exit_code})`;
              const out = res.stdout.trim();
              const err = res.stderr.trim();
              result = [
                `${status}`,
                out ? `\n**stdout:**\n\`\`\`\n${out}\n\`\`\`` : '',
                err ? `\n**stderr:**\n\`\`\`\n${err}\n\`\`\`` : '',
              ].filter(Boolean).join('\n');
            } else if (name === 'spawn_background_process') {
              const cwd = args.cwd || projectPath || null;
              const info = await tauriApi.spawnBackgroundProcess(args.id, args.command, cwd);
              result = `✅ Background process "${info.id}" started (PID: ${info.pid ?? 'unknown'}).\nCommand: \`${info.command}\`\nWorking Directory: \`${info.cwd || 'default'}\`\n\nUse \`read_process_logs\` with id="${info.id}" to inspect stdout/stderr.`;
            } else if (name === 'read_process_logs') {
              const logs = await tauriApi.readProcessLogs(args.id, args.tail ? Number(args.tail) : 50);
              const output = logs.lines.join('\n');
              result = `Process "${logs.id}" (${logs.running ? '🟢 Running' : '⚪ Stopped'}):\n\`\`\`\n${output || '(no output yet)'}\n\`\`\``;
            } else if (name === 'kill_background_process') {
              const stopped = await tauriApi.killBackgroundProcess(args.id);
              result = stopped
                ? `✅ Background process "${args.id}" terminated.`
                : `ℹ️ Background process "${args.id}" was not running or not found.`;
            } else if (name === 'list_background_processes') {
              const list = await tauriApi.listBackgroundProcesses();
              if (list.length === 0) {
                result = "No background processes currently registered.";
              } else {
                result = list
                  .map(
                    (p) =>
                      `- **${p.id}** (${p.running ? '🟢 running' : '⚪ stopped'}, PID ${p.pid ?? '?'}) -> \`${p.command}\` (started: ${new Date(p.started_at * 1000).toLocaleTimeString()})`
                  )
                  .join('\n');
              }
            } else if (name === 'write_to_file') {
              result = await tauriApi.writeToFile(args.path, args.content);
              // Live sync to Coder Canvas
              try {
                useCanvasStore.getState().openFileInCanvas(args.path, args.content);
              } catch {}
            } else if (name === 'replace_in_file') {
              const res = await tauriApi.replaceInFile(args.path, args.target_content, args.replacement_content, args.allow_multiple);
              result = `✅ ${res.message}`;
              // Live sync updated file to Coder Canvas
              try {
                const updatedContent = await tauriApi.parseLocalFile(args.path);
                useCanvasStore.getState().openFileInCanvas(args.path, updatedContent);
              } catch {}
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
          } else if (name === 'end_call') {
            const farewell =
              typeof args.farewell === 'string' && args.farewell.trim()
                ? args.farewell.trim()
                : 'Goodbye! Have a great rest of your day.';
            useSettingsStore.getState().updateSettings({ continuous_voice: false });
            useSettingsStore.getState().saveToBackend();
            tauriApi.setContinuousMode(false).catch(() => {});
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('morfeus-end-call'));
            }
            result = farewell;
          } else if (name.startsWith('mcp__')) {
            const parts = name.split('__');
            if (parts.length >= 3) {
              const serverId = parts[1];
              const toolName = parts.slice(2).join('__');
              const res = await tauriApi.mcpCallTool(serverId, toolName, args);

              if (res && typeof res === 'object') {
                if (Array.isArray(res.content)) {
                  const pieces: string[] = [];
                  for (const item of res.content) {
                    if (item.type === 'text' && item.text) {
                      pieces.push(item.text);
                    } else if (item.type === 'image' && item.data) {
                      const mime = item.mimeType || 'image/png';
                      pieces.push(`![${toolName}](data:${mime};base64,${item.data})\n[View rendered in chat UI]`);
                    } else {
                      pieces.push(JSON.stringify(item));
                    }
                  }
                  result = pieces.join('\n\n') || 'Tool executed successfully.';
                } else if (res.isError) {
                  result = `Tool Error: ${JSON.stringify(res)}`;
                } else {
                  result = JSON.stringify(res, null, 2);
                }
              } else if (typeof res === 'string') {
                result = res;
              } else {
                result = JSON.stringify(res, null, 2);
              }
            } else {
              result = `Error: Invalid MCP tool name format: ${name}`;
            }
          } else {
            result = `Error: Unknown tool "${name}"`;
          }

          if (result.includes('data:image/')) {
            return result; // Keep base64 image data URL intact for UI rendering
          }
          return capOutput(result);
        };

        // ── Main streaming loop (recursive for tool calls) ──
        // disableTools: set when tools should be omitted to force the model to write its final text response
        const executeChatLoop = async (isInitialTurn: boolean, depth: number, disableTools = false): Promise<void> => {
          if (controller.signal.aborted) return;

          // Re-arm speech queue for this turn so post-tool synthesis responses are spoken aloud
          const liveSettings = useSettingsStore.getState().settings;
          if (liveSettings.tts_enabled) {
            speechQueue.reset();
            speechQueue.setVoice(liveSettings.tts_voice || 'af_heart');
            speechQueue.setRate(liveSettings.tts_rate || 1.0);
          }

          const apiMessages = buildApiMessages(isInitialTurn);

          // At max depth, stop passing tools so model must respond with text
          const isFastMode = chatMode === 'fast';
          const maxDepth = isFastMode ? 5 : 25;
          const isMaxDepth = depth >= maxDepth;
          if (isMaxDepth || disableTools) {
            apiMessages.push({
              role: 'system',
              content: 'All requested tool actions are complete. DO NOT call any more tools. Provide your final comprehensive response to the user now using the information already gathered.',
            });
          }

          let availableTools: ToolDefinition[] = [];
          if (!isMaxDepth && !disableTools) {
            const mcpTools: ToolDefinition[] = [];
            for (const srv of relevantMcpServers) {
              if (srv.tools) {
                for (const tool of srv.tools) {
                  mcpTools.push({
                    type: 'function',
                    function: {
                      name: `mcp__${srv.id}__${tool.name}`,
                      description: `[MCP: ${srv.id}] ${tool.description ?? ''}`,
                      parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
                    },
                  });
                }
              }
            }

            if (isFastMode) {
              // Chat: lightweight read tools + connected MCP tools
              // If the user pasted remote logs or did not ask for local file operations, exclude local file tools
              const enableFileTools = shouldEnableLocalFileToolsInFastChat(userDisplayContent);
              const fastTools = enableFileTools
                ? FAST_CHAT_TOOLS
                : FAST_CHAT_TOOLS.filter((t) => !['search_files', 'list_directory', 'get_special_dirs', 'read_local_file'].includes(t.function.name));
              availableTools = [...fastTools, ...mcpTools];
            } else {
              // Agent Coder: full developer suite with all built-in tools + active MCP servers
              // If the user pasted remote logs (docker, pi@, etc.), exclude host file search so it doesn't search local disk
              const isRemote = isRemoteOrPastedLog(userDisplayContent);
              const coderTools = isRemote
                ? WEB_TOOLS.filter((t) => !['search_files', 'list_directory', 'get_special_dirs'].includes(t.function.name))
                : WEB_TOOLS;
              availableTools = [...coderTools, ...mcpTools];
            }
          }

          // ── Deterministic `end_call` fast-path when user says "end the call", "end the chat", "hang up", or "goodbye" ──
          const hasEndCallTool = availableTools.some((t) => t.function.name === 'end_call');
          if (
            isInitialTurn &&
            depth === 0 &&
            !disableTools &&
            hasEndCallTool &&
            isEndCallQuery(userDisplayContent)
          ) {
            const farewell = 'Goodbye! Have a great rest of your day.';
            const endCallId = `call_${generateId().slice(0, 8)}`;
            const endCallObj: ToolCall = {
              id: endCallId,
              type: 'function',
              function: {
                name: 'end_call',
                arguments: JSON.stringify({ farewell }),
              },
            };
            await executeTool('end_call', { farewell }, endCallId);
            addMessage({
              id: generateId(),
              conversation_id: convId!,
              role: 'assistant',
              content: farewell,
              tool_calls: [endCallObj],
              created_at: Date.now(),
            });
            addMessage({
              id: generateId(),
              conversation_id: convId!,
              role: 'tool',
              content: farewell,
              tool_call_id: endCallId,
              created_at: Date.now(),
            });
            const finalSettings = useSettingsStore.getState().settings;
            if (finalSettings.tts_enabled) {
              speechQueue.feedToken(farewell);
              speechQueue.flush();
            }
            return;
          }

          // ── Mandatory real-time web_search enforcement on depth 0 ──
          const hasWebSearchTool = availableTools.some((t) => t.function.name === 'web_search');
          const mustForceWebSearch =
            isInitialTurn &&
            depth === 0 &&
            !disableTools &&
            hasWebSearchTool &&
            isMandatoryWebSearchQuery(userDisplayContent, priorWebSearchQueries.length > 0);

          if (mustForceWebSearch) {
            const contextualQueryHint = buildContextualSearchQuery(userDisplayContent, priorWebSearchQueries);
            apiMessages.push({
              role: 'system',
              content: `MANDATORY TOOL CALL: The user is asking for real-time/current information ("${contextualQueryHint.slice(0, 140)}"). You MUST invoke the \`web_search\` tool right now before writing any answer. Do NOT guess prices, news, events, weather, or URLs from training memory.`,
            });
          }

          // ── Stream response ──
          let firstToken = false;
          const recentTokens: string[] = [];
          let totalChars = 0;
          let repetitionAborted = false;
          let sawToolCallDelta = false;
          let mandatoryPlainBuffer = '';

          const detectRepetition = (): boolean => {
            const len = recentTokens.length;

            // Pattern 1: same token 12 times in a row
            if (len >= 12) {
              const tail = recentTokens.slice(-12);
              if (tail.every(t => t === tail[0])) return true;
            }

            // Pattern 2: cycling pattern of token period 2–8 repeating 4 full cycles
            for (const period of [2, 3, 4, 5, 6, 7, 8]) {
              const needed = period * 4;
              if (len >= needed) {
                const window = recentTokens.slice(-needed);
                const cycle = window.slice(0, period);
                if (window.every((t, i) => t === cycle[i % period])) return true;
              }
            }

            // Pattern 3: Consecutive multi-word phrase repetition in streaming text (catches runaway phrase loops)
            const live = useChatStore.getState().streamingContent || '';
            if (live.length >= 100) {
              const tail = live.slice(-300);
              // Look for consecutive phrase repetitions of length 15-80 chars repeating at least 3 times
              for (let phraseLen = 15; phraseLen <= 80; phraseLen++) {
                const phrase = tail.slice(-phraseLen);
                // Ensure phrase has spaces and repeats consecutively at least 3 times
                if (phrase.includes(' ') && tail.endsWith(phrase.repeat(3))) {
                  return true;
                }
              }
            }

            // Pattern 4: character-level repetition in streaming text (catches runaway URLs / base64 cycles / punctuation)
            if (live.length >= 60) {
              const tailChars = live.slice(-200);
              for (let period = 3; period <= 24; period++) {
                const sub = tailChars.slice(-period);
                // Skip markdown horizontal rules (---, ===), spaces, and table formatting
                if (/^[\s\-_=|*]+$/.test(sub)) continue;
                if (tailChars.endsWith(sub.repeat(6))) return true;
              }
            }

            return false;
          };

          // Code is legitimately repetitive; never treat tokens inside a ``` fenced block as a loop.
          const insideCodeFence = (): boolean => {
            const soFar = useChatStore.getState().streamingContent || '';
            return ((soFar.match(/```/g) || []).length % 2) === 1;
          };

          let finishReason: string | null = null;
          let reasoningTriggeredSearch = false;
          const reasoningRequestsWebSearch = (rText: string): boolean =>
            /\b(?:i\s+(?:will|should|need\s+to|must|am\s+going\s+to)\s+(?:perform|do|run|use|call|conduct|make)\s+(?:a\s+)?web\s*search|i\s+(?:will|should|need\s+to)\s+search\s+the\s+web|i\s+should\s+check\s+(?:for\s+)?current\s+events|let(?:'s|\s+me)\s+(?:perform\s+a\s+web\s+search|search\s+the\s+web|use\s+web_search)|call(?:ing)?\s+`?web_search`?)\b/i.test(rText);

          // When `mustForceWebSearch` is true on depth 0, disable `think` for the initial tool-dispatch step
          // so local models (Gemma 4, Qwen, DeepSeek) in Ollama do not hallucinate inside `<think>` before
          // having search results or drop `tool_calls` after `</think>`. Once `web_search` completes,
          // `depth >= 1` uses the user's full `effectiveSettings` (with `think_enabled: true` when Think is ON)
          // so the model reasons over the verified web search results.
          const turnStreamSettings = mustForceWebSearch
            ? { ...effectiveSettings, think_enabled: false }
            : effectiveSettings;

          for await (const chunk of streamChat(turnStreamSettings, apiMessages, controller.signal, availableTools, disableTools)) {
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
              if (
                isInitialTurn &&
                depth === 0 &&
                !disableTools &&
                hasWebSearchTool &&
                !reasoningTriggeredSearch
              ) {
                const liveReasoning = useChatStore.getState().streamingReasoning || '';
                if (reasoningRequestsWebSearch(liveReasoning)) {
                  reasoningTriggeredSearch = true;
                }
              }
            }

            if (delta.content) {
              totalChars += delta.content.length;

              // If this turn strictly requires `web_search` on depth 0 (or the model's own `<think>` trace
              // stated it will perform a web search), do not feed ungrounded plain-text guesses to TTS or the UI
              // before `web_search` has been invoked.
              if ((mustForceWebSearch || reasoningTriggeredSearch) && !sawToolCallDelta) {
                mandatoryPlainBuffer += delta.content;
                const trimmedBuf = mandatoryPlainBuffer.trimStart();
                if (!trimmedBuf.startsWith('<tool_call>') && trimmedBuf.length > 24) {
                  console.warn('[WebSearchGate] Model attempted ungrounded plain-text reply on mandatory/reasoning real-time query — forcing web_search tool call');
                  tauriApi.appendSystemLog('info', 'Forcing mandatory web_search tool call for real-time query.');
                  break;
                }
                continue;
              }

              const trimmed = delta.content.trim();
              if (trimmed) {
                recentTokens.push(trimmed);
                if (recentTokens.length > 60) recentTokens.splice(0, recentTokens.length - 50);
                // Only run detection after 200 chars to avoid false positives.
                // Markdown tables / separators are legitimately repetitive (| --- | --- |), so skip them too.
                const liveText = useChatStore.getState().streamingContent || '';
                const lastLine = liveText.slice(liveText.lastIndexOf('\n') + 1).trimStart();
                const inTable = lastLine.startsWith('|') || /^[-=*_]{3,}\s*$/.test(lastLine);
                if (totalChars > 200 && !inTable && !insideCodeFence() && detectRepetition()) {
                  console.warn('[Repetition] Loop detected — aborting stream');
                  tauriApi.appendSystemLog('warn', 'Repetition loop detected. Auto-aborting.');
                  repetitionAborted = true;
                  // Trim output back to remove the looped repetition
                  const current = useChatStore.getState().streamingContent;
                  if (current) {
                    let cleanOutput = current;
                    for (let p = 3; p <= 80; p++) {
                      const pattern = current.slice(-p);
                      if (pattern.length >= 3 && current.endsWith(pattern.repeat(3))) {
                        cleanOutput = current.slice(0, current.length - pattern.length * 2).trimEnd();
                        break;
                      }
                    }
                    if (cleanOutput === current) {
                      cleanOutput = current.slice(0, Math.max(50, current.length - 80)).trimEnd();
                    }

                    useChatStore.setState({
                      streamingContent: cleanOutput,
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
              sawToolCallDelta = true;
              speechQueue.stop(); // Don't speak tool call JSON
              appendToolCallDelta(delta.tool_calls);
            }

            if (choice?.finish_reason) finishReason = choice.finish_reason;

            if (choice?.finish_reason === 'stop' || choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'length') {
              break;
            }
          }

          if (repetitionAborted) {
            const abortedMsg = finalizeStreamMessage(convId!);
            useChatStore.setState((state) => ({
              messages: state.messages.map((m) =>
                m.id === abortedMsg.id && m.content && m.content !== '[empty response]'
                  ? { ...m, content: `${m.content}\n\n> ⚠️ _Response stopped early: the model got stuck repeating itself. Try rephrasing, lowering Temperature, or raising Frequency Penalty in Params._` }
                  : m
              ),
            }));
            return;
          }

          // If `mustForceWebSearch` or `reasoningTriggeredSearch` buffered a text-based `<tool_call>` XML block, flush it so `parseTextToolCalls` can parse it
          if ((mustForceWebSearch || reasoningTriggeredSearch) && mandatoryPlainBuffer.includes('<tool_call>')) {
            appendStreamToken(mandatoryPlainBuffer);
          }

          const hadReasoning = !!useChatStore.getState().streamingReasoning;
          let finalMessage = finalizeStreamMessage(convId!);
          let hasToolCalls = Boolean(finalMessage.tool_calls && finalMessage.tool_calls.length > 0);

          // ── Fallback parser for text-based tool calls (Nemotron, Qwen, Mistral) ──
          if (!disableTools && !hasToolCalls && finalMessage.content && finalMessage.content.includes('<tool_call>')) {
            const { toolCalls: parsedCalls, cleanedContent } = parseTextToolCalls(finalMessage.content);
            if (parsedCalls.length > 0) {
              finalMessage = {
                ...finalMessage,
                tool_calls: parsedCalls,
                content: cleanedContent || undefined,
              };
              hasToolCalls = true;
              // Clean up in store so raw <tool_call> XML is never displayed in the chat bubble
              useChatStore.setState((state) => ({
                messages: state.messages.map((m) =>
                  m.id === finalMessage.id
                    ? { ...m, content: cleanedContent || undefined, tool_calls: parsedCalls }
                    : m
                ),
              }));
            } else {
              // Strip orphaned tags so raw XML is not displayed
              const stripped = finalMessage.content.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim();
              finalMessage = { ...finalMessage, content: stripped || undefined };
              useChatStore.setState((state) => ({
                messages: state.messages.map((m) =>
                  m.id === finalMessage.id ? { ...m, content: stripped || undefined } : m
                ),
              }));
            }
          }

          // ── Deterministic fallback: synthesize `web_search` if model skipped tool call on mandatory real-time query ──
          if ((mustForceWebSearch || reasoningTriggeredSearch) && !hasToolCalls && !controller.signal.aborted) {
            const cleanedQuery = buildContextualSearchQuery(userDisplayContent, priorWebSearchQueries);
            const syntheticCall: ToolCall = {
              id: `call_${generateId().slice(0, 8)}`,
              type: 'function',
              function: {
                name: 'web_search',
                arguments: JSON.stringify({ query: cleanedQuery }),
              },
            };
            speechQueue.stop();
            finalMessage = {
              ...finalMessage,
              content: undefined,
              reasoning: undefined,
              tool_calls: [syntheticCall],
            };
            hasToolCalls = true;
            useChatStore.setState((state) => ({
              messages: state.messages.map((m) =>
                m.id === finalMessage.id
                  ? { ...m, content: undefined, reasoning: undefined, tool_calls: [syntheticCall] }
                  : m
              ),
            }));
          }

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

          // ── Reply cut off by the token limit (not a thinking-only truncation) ──
          // Seamless multi-pass auto-continuation (up to 2 passes) so large mid-sentence cutoffs complete cleanly.
          if (finishReason === 'length' && !isEmptyContent && noToolCalls && !controller.signal.aborted) {
            let contFinishReason: string | null = 'length';
            let contPass = 0;
            const MAX_AUTO_CONT_PASSES = 2;

            while (contFinishReason === 'length' && contPass < MAX_AUTO_CONT_PASSES && !controller.signal.aborted) {
              contPass++;
              try {
                const contMessages = [
                  ...apiMessages,
                  { role: 'assistant', content: finalMessage.content ?? '' },
                  {
                    role: 'user',
                    content:
                      'Continue directly from the exact word or character where you left off. Do not repeat what you already wrote and do not add any preamble.',
                  },
                ];
                const fittedContMessages = trimHistoryToContext(contMessages, {
                  systemPrompt,
                  contextLength: effectiveSettings.context_length,
                  maxTokens: effectiveSettings.max_tokens || 4096,
                });
                let contText = '';
                for await (const contChunk of streamChat(effectiveSettings, fittedContMessages, controller.signal, [], true)) {
                  if (controller.signal.aborted) break;
                  const contChoice = contChunk?.choices?.[0];
                  const contDelta = contChoice?.delta?.content;
                  if (contDelta) {
                    contText += contDelta;
                    const liveTts = useSettingsStore.getState().settings.tts_enabled;
                    if (liveTts) speechQueue.feedToken(contDelta);
                    useChatStore.setState((state) => ({
                      messages: state.messages.map((m) =>
                        m.id === finalMessage.id ? { ...m, content: `${m.content ?? ''}${contDelta}` } : m
                      ),
                    }));
                  }
                  if (contChoice?.finish_reason) contFinishReason = contChoice.finish_reason;
                }
                if (contText) {
                  finalMessage = { ...finalMessage, content: `${finalMessage.content ?? ''}${contText}` };
                }
              } catch (contErr) {
                console.warn('[Chat] Auto-continue after finish_reason=length failed:', contErr);
                break;
              }
            }

            if (contFinishReason === 'length' && !controller.signal.aborted) {
              tauriApi.appendSystemLog('warn', 'Reply truncated: finish_reason=length after auto-continuation passes.');
              useChatStore.setState((state) => ({
                messages: state.messages.map((m) =>
                  m.id === finalMessage.id
                    ? { ...m, content: `${m.content ?? ''}\n\n> ⚠️ _Reply reached maximum continuous token capacity. Ask me to continue to proceed._` }
                    : m
                ),
              }));
            }
          }

          // ── Auto-retry without tools if model returned an empty response ──
          // This happens when GGUF/Ollama models don't support function calling:
          // they receive the tools array, get confused, and return nothing.
          // Retry once without the tools array so the model can respond normally.
          const isEmptyResponse = isEmptyContent;
          const hasNoToolCalls = noToolCalls;

          if (isEmptyResponse && hasNoToolCalls && depth <= 2 && !disableTools) {
            console.warn('[Chat] Empty response received — model may need tools omitted to write text. Retrying with tools disabled.');
            tauriApi.appendSystemLog('warn', 'Empty response from model — retrying with tools disabled to force text response.');
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

            let executedAnyNewTool = false;
            let encounteredDuplicate = false;

            // Execute at most 2 tool calls per depth to keep things fast
            for (const tc of finalMessage.tool_calls!.slice(0, 2)) {
              if (controller.signal.aborted) break;
              if (tc.type !== 'function') continue;

              // Hard cap: if we've already run MAX_TOTAL_TOOLS tool calls this turn, stop
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
                encounteredDuplicate = true;
                break;
              }

              const toolName = tc.function?.name ?? '';
              let toolArgs: Record<string, unknown> = {};
              try {
                toolArgs = typeof tc.function?.arguments === 'string'
                  ? JSON.parse(tc.function.arguments)
                  : (tc.function?.arguments || {});
              } catch {
                toolArgs = {};
              }
              const normalizedArgs = JSON.stringify(toolArgs, Object.keys(toolArgs).sort());
              const toolKey = `${toolName}::${normalizedArgs}`;

              // Cross-depth dedup: skip if this exact call already ran this turn
              if (calledToolKeys.has(toolKey)) {
                totalToolCalls++;
                encounteredDuplicate = true;
                console.log(`[Dedup] Blocked repeated tool call: ${toolKey}`);
                tauriApi.appendSystemLog('warn', `Duplicate blocked: ${toolName}. Forcing final response.`);
                addMessage({
                  id: generateId(),
                  conversation_id: convId!,
                  role: 'tool',
                  content: `[NOTICE]: "${toolName}" with these exact arguments was already executed. You already have its result. Stop calling tools and write your final response to the user now.`,
                  tool_call_id: tc.id,
                  created_at: Date.now(),
                });
                continue;
              }
              calledToolKeys.add(toolKey);

              // Per-file read throttling to prevent infinite reading loops
              if (toolName === 'read_file_range' || toolName === 'read_local_file') {
                const rawPath = String(toolArgs?.path || '').trim();
                if (rawPath) {
                  const normPath = rawPath.toLowerCase();
                  const count = fileReadCounts.get(normPath) || 0;
                  if (count >= 2) {
                    const fileName = rawPath.split(/[/\\]/).pop() || rawPath;
                    console.log(`[Throttling] Blocked repeated reads of ${fileName} (${count} prior reads)`);
                    tauriApi.appendSystemLog('warn', `Throttling repeated reads of ${fileName} (${count} prior reads)`);
                    totalToolCalls++;
                    encounteredDuplicate = true;
                    addMessage({
                      id: generateId(),
                      conversation_id: convId!,
                      role: 'tool',
                      content: `[NOTICE]: "${fileName}" has already been read in full (${count} times). You already have its entire contents in your context history above. DO NOT re-read this file. Synthesize what you have learned and write your response to the user now.`,
                      tool_call_id: tc.id,
                      created_at: Date.now(),
                    });
                    continue;
                  }
                  fileReadCounts.set(normPath, count + 1);
                }
              }

              totalToolCalls++;
              executedAnyNewTool = true;

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

              // If the model invoked `end_call`, finalize the farewell message and stop the session immediately
              if (toolName === 'end_call') {
                const farewellText = finalMessage.content?.trim() || result;
                useChatStore.setState((state) => ({
                  messages: state.messages.map((m) =>
                    m.id === finalMessage.id ? { ...m, content: farewellText } : m
                  ),
                }));
                const finalSettings = useSettingsStore.getState().settings;
                if (finalSettings.tts_enabled && !finalMessage.content?.trim()) {
                  speechQueue.feedToken(farewellText);
                  speechQueue.flush();
                } else if (finalSettings.tts_enabled) {
                  speechQueue.flush();
                }
                return;
              }
            }

            if (controller.signal.aborted) return;
            setChatStatus('thinking');
            clearStreamingContent();

            // Loop breaker: if no new tools were executed (all were duplicates/throttled)
            // or if tool budget is exhausted, immediately disable tools on the next iteration so the
            // model is forced to output its final answer rather than looping.
            const forceDisableTools = (!executedAnyNewTool && encounteredDuplicate) || (totalToolCalls >= MAX_TOTAL_TOOLS);

            try {
              await executeChatLoop(false, depth + 1, forceDisableTools);
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
            await executeChatLoop(false, depth + 1, true); // Force final answer without tools
            return;
          }

          // ── Deterministic post-stream compliance for web_search responses ──
          // Guarantee that every turn utilizing `web_search` includes the exact Current Date & Time
          // ("As of ...") and clickable Markdown source links (`[Source Title](url)`), even if a smaller
          // local LLM omits them during final synthesis.
          if (
            !hasToolCalls &&
            webSearchSourcesThisTurn.length > 0 &&
            finalMessage.content &&
            finalMessage.content !== '[empty response]' &&
            !controller.signal.aborted
          ) {
            let updatedContent = finalMessage.content;
            const hasTimestamp = /\bAs of\b/i.test(updatedContent) || updatedContent.includes(dateStr);
            const hasMarkdownSourceLinks = /\[[^\]]+\]\(https?:\/\/[^\s)]+\)/.test(updatedContent);

            if (!hasTimestamp) {
              updatedContent = `*As of ${dateStr} at ${timeStr}:*\n\n${updatedContent}`;
            }
            if (!hasMarkdownSourceLinks) {
              const sourceLines = webSearchSourcesThisTurn
                .slice(0, 4)
                .map((s) => `- [${s.title.replace(/[\[\]]/g, '')}](${s.url})`)
                .join('\n');
              updatedContent = `${updatedContent.trimEnd()}\n\n### Sources\n${sourceLines}`;
            }

            if (updatedContent !== finalMessage.content) {
              finalMessage = { ...finalMessage, content: updatedContent };
              useChatStore.setState((state) => ({
                messages: state.messages.map((m) =>
                  m.id === finalMessage.id ? { ...m, content: updatedContent } : m
                ),
              }));
            }
          }

          // ── Final response: Flush speechQueue if TTS enabled ──
          const finalSettings = useSettingsStore.getState().settings;
          if (finalSettings.tts_enabled && !hasToolCalls) {
            speechQueue.flush();
          } else if (!hasToolCalls && finalSettings.continuous_voice) {
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('speech-playback-complete'));
            }
          }
        };

        // ── Self-heal legacy attachment messages in this conversation that lacked persisted api_content ──
        try {
          const convMsgs = useChatStore.getState().messages.filter((m) => m.conversation_id === convId);
          for (const msg of convMsgs) {
            if (msg.role === 'user' && !msg.api_content && typeof msg.content === 'string' && msg.content.includes('📎 Attached:')) {
              const match = msg.content.match(/📎 Attached:\s*([^\n]+)/);
              if (match && match[1]) {
                const fileNames = match[1].split(',').map((s) => s.trim()).filter(Boolean);
                let recoveredContext = '';
                for (const fileName of fileNames) {
                  const found = await tauriApi.searchFiles(fileName);
                  if (found && found.length > 0) {
                    const parsed = await tauriApi.parseLocalFile(found[0].path);
                    if (parsed) {
                      const clipped = parsed.length > 45000 ? parsed.slice(0, 45000) + '\n[...truncated...]' : parsed;
                      recoveredContext += `\n--- File: ${fileName} ---\n${clipped}\n---\n`;
                    }
                  }
                }
                if (recoveredContext) {
                  const userBody = msg.content.replace(/^📎 Attached:\s*[^\n]+\s*/, '').trim() || 'Please analyze the attached file(s).';
                  const healedApiContent = `I have attached the following files for reference:${recoveredContext}\nUser Question/Message: ${userBody}`;
                  useChatStore.setState((state) => ({
                    messages: state.messages.map((m) =>
                      m.id === msg.id ? { ...m, api_content: healedApiContent } : m
                    ),
                  }));
                }
              }
            }
          }
        } catch (healErr) {
          console.warn('[Chat] Could not self-heal legacy attachment message:', healErr);
        }

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
          if (typeof window !== 'undefined' && activeSettings.continuous_voice) {
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

  /**
   * Public entry point. Serializes sends with a synchronous module-level lock (React state
   * closures are stale between renders, so `isStreaming` alone lets two near-simultaneous voice
   * transcripts start two parallel streams) and drops identical re-sends fired back-to-back.
   */
  const sendMessage = useCallback(
    async (content: string) => {
      const text = (content ?? '').trim();
      if (!text) return;

      const now = Date.now();
      if (sendInFlight || useChatStore.getState().isStreaming) {
        console.warn('[Chat] Ignored send: a response is already in progress.');
        return;
      }
      if (text === lastSentText && now - lastSentAt < DUPLICATE_SEND_WINDOW_MS) {
        console.warn('[Chat] Ignored duplicate send of identical text.');
        return;
      }

      sendInFlight = true;
      lastSentText = text;
      lastSentAt = now;
      try {
        await sendMessageUnsafe(content);
      } finally {
        sendInFlight = false;
        lastSentAt = Date.now();
      }
    },
    [sendMessageUnsafe]
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
