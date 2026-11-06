import { describe, it, expect } from 'vitest';
import { sanitizeHistory, trimHistoryToContext } from '@/lib/chatHistory';

describe('sanitizeHistory', () => {
  it('drops error cards and empty placeholders', () => {
    const out = sanitizeHistory([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '### ⚠️ Provider Error\n\nboom' },
      { role: 'assistant', content: '[empty response]' },
      { role: 'user', content: 'again' },
    ]);
    expect(out).toEqual([{ role: 'user', content: 'hi\n\nagain' }]);
  });

  it('removes tool_calls that never got a result (aborted / >2 parallel)', () => {
    const out = sanitizeHistory([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      },
      { role: 'tool', tool_call_id: 'a', content: 'ra' },
      { role: 'tool', tool_call_id: 'b', content: 'rb' },
    ]);
    const asst = out.find((m) => m.role === 'assistant')!;
    expect(asst.tool_calls!.map((t) => t.id)).toEqual(['a', 'b']);
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('drops an assistant tool_calls message with no results at all', () => {
    const out = sanitizeHistory([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'x' }] },
      { role: 'user', content: 'next' },
    ]);
    expect(out).toEqual([{ role: 'user', content: 'go\n\nnext' }]);
  });

  it('drops orphan tool results', () => {
    const out = sanitizeHistory([
      { role: 'user', content: 'q' },
      { role: 'tool', tool_call_id: 'zzz', content: 'orphan' },
      { role: 'assistant', content: 'a' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('does not merge multimodal user messages', () => {
    const img = [{ type: 'text', text: 'x' }];
    const out = sanitizeHistory([
      { role: 'user', content: 'a' },
      { role: 'user', content: img },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('trimHistoryToContext', () => {
  const options = {
    systemPrompt: 'System instructions', // ~5 tokens
    contextLength: 1000,
    maxTokens: 500,
  };

  it('keeps all messages when history fits within budget', () => {
    const msgs = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'Can you search the web?' },
    ];
    const trimmed = trimHistoryToContext(msgs, options);
    expect(trimmed).toEqual(msgs);
  });

  it('never truncates active turn tool calls or tool results even when context budget is tight', () => {
    const largeToolResult = 'x'.repeat(2400); // ~600 tokens
    const msgs = [
      { role: 'user', content: 'Old question 1' },
      { role: 'assistant', content: 'Old answer 1' },
      { role: 'user', content: 'Old question 2' },
      { role: 'assistant', content: 'Old answer 2' },
      // Active turn starts here:
      { role: 'user', content: 'Can you confirm that by doing a simple web searching' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: 'web_search' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: largeToolResult },
    ];

    // Tight context: 800 tokens maxContext
    const trimmed = trimHistoryToContext(msgs, {
      systemPrompt: 'You are an AI assistant.',
      contextLength: 800,
      maxTokens: 256,
    });

    // Older questions must be trimmed, but the entire active turn (user, tool call, tool result) MUST be kept!
    expect(trimmed.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(trimmed[0].content).toBe('Can you confirm that by doing a simple web searching');
    expect(trimmed[1].tool_calls).toBeDefined();
    expect(trimmed[2].role).toBe('tool');
  });

  it('aligns to multiple of 4 for KV-cache prefix stability without encroaching on active turn', () => {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 16; i++) {
      msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i}` });
    }
    msgs.push({ role: 'user', content: 'Final question' });

    const trimmed = trimHistoryToContext(msgs, {
      systemPrompt: 'System',
      contextLength: 300,
      maxTokens: 100,
    });

    const activeUser = trimmed[trimmed.length - 1];
    expect(activeUser.content).toBe('Final question');
  });
});
