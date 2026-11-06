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
  if (typeof text === 'string') {
    return Math.ceil(text.length / 4);
  }
  if (text == null) return 0;
  return Math.ceil(JSON.stringify(text).length / 4);
}

/**
 * Trims message history to fit within the model's context budget while strictly
 * preserving the entire active interaction (the latest user prompt and any
 * assistant tool calls + tool results belonging to the current turn).
 */
export function trimHistoryToContext<T extends Msg>(
  allMsgs: T[],
  options: TrimContextOptions
): T[] {
  if (!allMsgs.length) return [];

  const maxContext = options.contextLength && options.contextLength > 0 ? options.contextLength : 8192;
  const completionHeadroom = Math.min(
    options.maxTokens && options.maxTokens > 0 ? options.maxTokens : 2048,
    Math.max(128, Math.floor(maxContext * 0.25)),
    1024
  );
  let budget = estimateTokenCount(options.systemPrompt) + completionHeadroom;

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

    if (!isCurrentTurn && budget + tokCost > maxContext) {
      oldestFitIdx = i + 1;
      break;
    }
    budget += tokCost;
  }

  // Ensure oldestFitIdx never cuts into the active turn (user query, tool calls, tool results)
  if (activeTurnUserIdx >= 0 && oldestFitIdx > activeTurnUserIdx) {
    oldestFitIdx = activeTurnUserIdx;
  }

  // KV-Cache Prefix Alignment: Snap starting message index down to a multiple of 4
  // so that consecutive turns share the exact same leading message prefix instead of
  // shifting by 1 on every turn and invalidating the entire LLM prompt cache.
  if (oldestFitIdx > 0 && activeTurnUserIdx > 0 && oldestFitIdx < activeTurnUserIdx) {
    oldestFitIdx = Math.max(0, Math.floor(oldestFitIdx / 4) * 4);
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
  // 0) Strip UI notices we append to assistant text (truncation / repetition notes) so the model
  //    never sees them as its own words.
  history = history.map((m) =>
    m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('\n\n> ⚠️ _')
      ? ({ ...m, content: m.content.replace(/\n\n> ⚠️ _[\s\S]*_\s*$/, '') } as T)
      : m,
  );

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
