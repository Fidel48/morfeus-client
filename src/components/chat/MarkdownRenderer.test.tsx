import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// CodeBlock pulls in Tauri-backed stores; they are irrelevant to rendering correctness.
vi.mock('@/stores/canvasStore', () => ({ useCanvasStore: { getState: () => ({ loadCodeSnippet: () => {} }) } }));
vi.mock('@/stores/chatStore', () => ({ useChatStore: { getState: () => ({ openRightPanelTab: () => {} }) } }));

import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { extractTextFromChildren, toDisplayString } from '@/lib/reactText';

const render = (md: unknown) => renderToStaticMarkup(<MarkdownRenderer content={md as string} />);
const decode = (html: string) =>
  html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

describe('markdown rendering never corrupts content', () => {
  it('keeps the exact docker/curl commands that previously became [object Object]', () => {
    const md = [
      '```bash',
      'curl -I --header "authorization: LOW KEY:SECRET" https://s3.us.archive.org',
      'docker exec -it rgsx_downloader mkdir -p /root/.config',
      'docker exec -it rgsx_downloader cat /root/.config/ia.ini',
      '```',
    ].join('\n');
    const out = decode(render(md));
    expect(out).not.toContain('[object Object]');
    expect(out).toContain('docker exec -it rgsx_downloader mkdir -p /root/.config');
    expect(out).toContain('cat /root/.config/ia.ini');
    expect(out).not.toMatch(/docker ,/);
  });

  it.each(['bash', 'sh', 'python', 'typescript', 'rust', 'json', 'yaml', 'dockerfile', 'ini', 'c++', 'totally-unknown-lang', ''])(
    'renders ```%s fences without throwing or leaking objects',
    (lang) => {
      const out = decode(render('```' + lang + '\nconst a = "x";\nexec("y");\n```'));
      expect(out).not.toContain('[object Object]');
      expect(out).toContain('exec("y");');
    },
  );

  it('survives unclosed fences (mid-stream)', () => {
    const out = decode(render('Here:\n```bash\ndocker exec -it x'));
    expect(out).toContain('docker exec -it x');
    expect(out).not.toContain('[object Object]');
  });

  it('never receives or emits non-string garbage', () => {
    for (const bad of [null, undefined, 42, { a: 1 }, [{ type: 'text', text: 'hello' }]]) {
      expect(decode(render(bad))).not.toContain('[object Object]');
    }
    expect(decode(render([{ type: 'text', text: 'hello' }]))).toContain('hello');
  });

  it('inline code and tables render intact', () => {
    const out = decode(render('Use `docker exec` now\n\n| a | b |\n|---|---|\n| 1 | 2 |'));
    expect(out).toContain('docker exec');
    expect(out).not.toContain('[object Object]');
  });
});

describe('reactText helpers', () => {
  it('extracts nested element text with no commas or object coercion', () => {
    const tree = [
      'docker ',
      React.createElement('span', { key: 1 }, 'exec'),
      ' -it ',
      React.createElement('span', { key: 2 }, [React.createElement('b', { key: 3 }, 'rgsx')]),
    ];
    expect(extractTextFromChildren(tree)).toBe('docker exec -it rgsx');
  });

  it('toDisplayString handles objects safely', () => {
    expect(toDisplayString({ a: 1 })).toContain('"a": 1');
    expect(toDisplayString(null)).toBe('');
  });
});
