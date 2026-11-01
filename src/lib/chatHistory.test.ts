import { describe, it, expect } from 'vitest';
import { sanitizeHistory } from '@/lib/chatHistory';

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
