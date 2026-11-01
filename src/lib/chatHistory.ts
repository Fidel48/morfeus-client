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

type Msg = {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; [k: string]: unknown }>;
  tool_call_id?: string;
  [k: string]: unknown;
};

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
