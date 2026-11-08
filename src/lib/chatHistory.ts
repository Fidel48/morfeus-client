/**
 * Sanitizes the OpenAI-format message history before it is sent to the model.
 *
 * Why this exists: the stored chat timeline contains things that are NOT valid model history and
 * make local models (Ollama / LM Studio chat templates) behave badly:
 *  - our own UI error cards ("### ⚠️ Provider Error") and "[empty response]" placeholders, which the
 *    model then imitates or "apologizes" for;
 *  - assistant tool_calls whose tool result is missing (Stop pressed mid-tool, >2 parallel calls,
 *    aborted stream) -> HTTP 400 / template errors on the next turn;
 *  - tool results with no matching call (after context truncation);
 *  - consecutive same-role messages (after a failed turn) -> "roles must alternate" template errors.
 */

import type { ToolCall } from '@/types';

export type Msg = {
  role: string;
  content?: unknown;
  api_content?: unknown;
  tool_calls?: ToolCall[] | Array<{ id?: string; type?: string; function?: { name?: string; arguments?: unknown } }>;
  tool_call_id?: string;
};

export interface TrimContextOptions {
  systemPrompt: string;
  contextLength?: number;
  maxTokens?: number;
}

export function estimateTokenCount(text: unknown): number {
  if (text == null) return 0;
  if (typeof text === 'string') {
    if (text.includes('data:image/')) {
      let imageCount = 0;
      const stripped = text.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, () => {
        imageCount++;
        return '';
      });
      return Math.ceil(stripped.length / 4) + imageCount * 256;
    }
    return Math.ceil(text.length / 4);
  }
  if (Array.isArray(text)) {
    let total = 0;
    for (const part of text) {
      if (part && typeof part === 'object') {
        const p = part as { type?: string; text?: string };
        if (p.type === 'text' && typeof p.text === 'string') {
          total += estimateTokenCount(p.text);
        } else if (p.type === 'image_url') {
          // Vision models encode each image into a fixed patch token budget (~256 tokens),
          // NOT raw base64 character length / 4 (~150,000 tokens).
          total += 256;
        } else {
          total += Math.ceil(JSON.stringify(part).length / 4);
        }
      }
    }
    return total;
  }
  return Math.ceil(JSON.stringify(text).length / 4);
}

function isAttachmentMessage(msg: Msg): boolean {
  if (msg.role !== 'user') return false;
  if (msg.api_content != null) return true;
  if (Array.isArray(msg.content)) return true;
  if (typeof msg.content === 'string') {
    return (
      msg.content.includes('📎 Attached:') ||
      msg.content.includes('--- File:') ||
      msg.content.includes('I have attached the following files for reference:')
    );
  }
  return false;
}

/**
 * Strip runaway character-level repetition loops (e.g. corrupted base64 URLs like "Z3I2V2Z3I2V2...")
 * from historical assistant messages so a single glitched turn never poisons subsequent turns.
 */
export function stripRunawayRepetition(text: string): string {
  // 1. Replace any markdown link whose URL contains a runaway repeating alphanumeric cycle
  let cleaned = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]*?([A-Za-z0-9+/=%_-]{2,24})\3{5,}[^\s)]*)\)/g,
    '[$1](https://news.google.com)'
  );
  // 2. Collapse any remaining runaway alphanumeric token cycle (2-24 chars repeated 7+ times consecutively)
  cleaned = cleaned.replace(/(([A-Za-z0-9+/=%]{2,24}))\1{6,}/g, '$1');
  return cleaned;
}

/**
 * Trims message history to fit within the model's context budget while strictly
 * preserving the entire active interaction (the latest user prompt and any
 * assistant tool calls + tool results belonging to the current turn), as well as
 * pinning the latest attached document/file context so multi-turn study/exam sessions
 * never lose their reference document mid-session.
 */
export function trimHistoryToContext<T extends Msg>(
  allMsgs: T[],
  options: TrimContextOptions
): T[] {
  if (!allMsgs.length) return [];

  const maxContext = options.contextLength && options.contextLength > 0 ? options.contextLength : 8192;
  const requestedMax = options.maxTokens && options.maxTokens > 0 ? options.maxTokens : 2048;
  // Reserve at least 25% of context or the requested maxTokens (up to 35% of maxContext),
  // with a minimum of 256 tokens, so the model always has adequate generation space.
  const completionHeadroom = Math.min(
    requestedMax,
    Math.max(256, Math.floor(maxContext * 0.35))
  );
  // Cap the prompt token budget so prompt tokens never exceed 75% of maxContext,
  // preventing Ollama RoPE interpolation degradation and OOM prompt evaluation hangs.
  const safePromptCeiling = Math.min(
    maxContext - completionHeadroom,
    Math.floor(maxContext * 0.75)
  );
  const baseBudget = estimateTokenCount(options.systemPrompt);
  let budget = baseBudget;

  // Identify the start of the active turn (the latest user message)
  let activeTurnUserIdx = -1;
  for (let i = allMsgs.length - 1; i >= 0; i--) {
    if (allMsgs[i].role === 'user') {
      activeTurnUserIdx = i;
      break;
    }
  }

  let oldestFitIdx = 0;
  for (let i = allMsgs.length - 1; i >= 0; i--) {
    const msg = allMsgs[i];
    const isCurrentTurn = activeTurnUserIdx >= 0 ? i >= activeTurnUserIdx : i === allMsgs.length - 1;
    const tokCost = 20 + estimateTokenCount(msg.api_content || msg.content) + (msg.tool_calls ? 50 : 0);

    if (!isCurrentTurn && budget + tokCost > safePromptCeiling) {
      oldestFitIdx = i + 1;
      break;
    }
    budget += tokCost;
  }

  // Ensure oldestFitIdx never cuts into the active turn (user query, tool calls, tool results)
  if (activeTurnUserIdx >= 0 && oldestFitIdx > activeTurnUserIdx) {
    oldestFitIdx = activeTurnUserIdx;
  }

  // Find the most recent attachment message prior to the active turn
  let pinnedIdx = -1;
  const searchLimit = activeTurnUserIdx >= 0 ? activeTurnUserIdx : allMsgs.length - 1;
  for (let i = searchLimit - 1; i >= 0; i--) {
    if (isAttachmentMessage(allMsgs[i])) {
      pinnedIdx = i;
      break;
    }
  }

  // If normal trimming would drop the attached document, pin the attachment message at the start
  // and trim the oldest intermediate Q&A turns after it so the reference document stays in context.
  if (pinnedIdx >= 0 && oldestFitIdx > pinnedIdx) {
    const pinnedMsg = allMsgs[pinnedIdx];
    const pinCost = 20 + estimateTokenCount(pinnedMsg.api_content || pinnedMsg.content);
    if (pinCost <= Math.floor(safePromptCeiling * 0.7)) {
      let pinBudget = baseBudget + pinCost;
      let recentStartIdx = pinnedIdx + 1;
      for (let i = allMsgs.length - 1; i > pinnedIdx; i--) {
        const msg = allMsgs[i];
        const isCurrentTurn = activeTurnUserIdx >= 0 ? i >= activeTurnUserIdx : i === allMsgs.length - 1;
        const tokCost = 20 + estimateTokenCount(msg.api_content || msg.content) + (msg.tool_calls ? 50 : 0);
        if (!isCurrentTurn && pinBudget + tokCost > safePromptCeiling) {
          recentStartIdx = i + 1;
          break;
        }
        pinBudget += tokCost;
      }
      if (activeTurnUserIdx >= 0 && recentStartIdx > activeTurnUserIdx) {
        recentStartIdx = activeTurnUserIdx;
      }
      // Prefer starting the recent slice on an assistant response so roles alternate cleanly after the pinned user message
      if (recentStartIdx < activeTurnUserIdx && allMsgs[recentStartIdx]?.role === 'user') {
        recentStartIdx++;
      }
      return [pinnedMsg, ...allMsgs.slice(recentStartIdx)];
    }
  }

  // KV-Cache Prefix Alignment: Snap starting message index UP to a multiple of 4
  // (dropping older messages rather than adding overflow messages back in) to preserve
  // KV-cache prefix stability without exceeding the safe prompt budget.
  if (oldestFitIdx > 0 && activeTurnUserIdx > 0 && oldestFitIdx < activeTurnUserIdx) {
    const aligned = Math.ceil(oldestFitIdx / 4) * 4;
    if (aligned <= activeTurnUserIdx) {
      oldestFitIdx = aligned;
    }
  }

  return allMsgs.slice(oldestFitIdx);
}

const EMPTY_SENTINEL = '[empty response]';

export function isUiOnlyAssistantText(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  const t = content.trim();
  return t === EMPTY_SENTINEL || t.startsWith('### ⚠️') || t.startsWith('⚠️');
}

export function sanitizeHistory<T extends Msg>(history: T[]): T[] {
  // 0) Strip UI notices we append to assistant text (truncation / repetition notes) and
  //    runaway repetition tails so the model never sees them as its own words or gets poisoned.
  history = history.map((m) => {
    if (m.role === 'assistant' && typeof m.content === 'string') {
      let cleaned = m.content.includes('\n\n> ⚠️ _')
        ? m.content.replace(/\n\n> ⚠️ _[\s\S]*_\s*$/, '')
        : m.content;
      cleaned = stripRunawayRepetition(cleaned);
      return cleaned !== m.content ? ({ ...m, content: cleaned } as T) : m;
    }
    return m;
  });

  // 1) Drop UI-only assistant messages (errors / empty placeholders) that carry no tool calls.
  let msgs = history.filter(
    (m) => !(m.role === 'assistant' && !(m.tool_calls && m.tool_calls.length) && isUiOnlyAssistantText(m.content)),
  );

  // 2) Enforce tool_call <-> tool result pairing.
  const resultIds = new Set(msgs.filter((m) => m.role === 'tool' && m.tool_call_id).map((m) => m.tool_call_id as string));
  const paired: T[] = [];
  const openIds = new Set<string>();
  for (const m of msgs) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const kept = m.tool_calls.filter((tc) => tc.id && resultIds.has(tc.id));
      const hasText = typeof m.content === 'string' ? m.content.trim() !== '' : m.content != null;
      if (kept.length === 0) {
        if (hasText) paired.push({ ...m, tool_calls: undefined } as T);
        continue;
      }
      kept.forEach((tc) => openIds.add(tc.id as string));
      paired.push({ ...m, tool_calls: kept } as T);
    } else if (m.role === 'tool') {
      if (m.tool_call_id && openIds.has(m.tool_call_id)) paired.push(m);
    } else {
      paired.push(m);
    }
  }
  msgs = paired;

  // 3) Merge consecutive plain-text user/user or assistant/assistant messages.
  const merged: T[] = [];
  for (const m of msgs) {
    const prev = merged[merged.length - 1];
    const mergeable =
      prev &&
      prev.role === m.role &&
      (m.role === 'user' || (m.role === 'assistant' && !m.tool_calls && !prev.tool_calls)) &&
      typeof prev.content === 'string' &&
      typeof m.content === 'string';
    if (mergeable) {
      merged[merged.length - 1] = { ...prev, content: `${prev.content}\n\n${m.content}` } as T;
    } else {
      merged.push(m);
    }
  }
  return merged;
}
