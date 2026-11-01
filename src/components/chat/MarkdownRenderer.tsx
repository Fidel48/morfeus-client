import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { CodeBlock } from './CodeBlock';
import { extractTextFromChildren, toDisplayString } from '@/lib/reactText';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

// ignoreMissing: unknown ```lang fences must degrade to plain text instead of throwing.
// detect is off: auto-detection mis-colors shell/config snippets and costs CPU while streaming.
const REHYPE_PLUGINS: React.ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [
  [rehypeHighlight, { ignoreMissing: true, detect: false }],
];
const REMARK_PLUGINS = [remarkGfm];

/** Last-resort fallback: show the raw text so a message is never lost or blank. */
class MarkdownBoundary extends React.Component<
  { raw: string; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error('[Markdown] render failed, showing raw text:', error);
  }
  componentDidUpdate(prev: { raw: string }) {
    // Streaming content changes constantly; retry rich rendering once content moves on.
    if (this.state.failed && prev.raw !== this.props.raw) this.setState({ failed: false });
  }
  render() {
    if (this.state.failed) {
      return (
        <pre className="whitespace-pre-wrap break-words text-sm font-mono text-zinc-200">
          {this.props.raw}
        </pre>
      );
    }
    return this.props.children;
  }
}

const MarkdownBody: React.FC<{ text: string; className: string }> = React.memo(({ text, className }) => {
  return (
    <div className={`markdown-content break-words overflow-hidden min-w-0 max-w-full ${className}`}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={{
          code({ className, children, ...props }) {
            const match = /language-([\w+#.-]+)/.exec(className || '');
            const rawCode = extractTextFromChildren(children);
            const isBlock = match !== null || rawCode.includes('\n');

            if (isBlock) {
              return (
                <CodeBlock
                  language={match ? match[1] : ''}
                  code={rawCode.replace(/\n$/, '')}
                >
                  {children}
                </CodeBlock>
              );
            }
            return (
              <code
                className="px-1.5 py-0.5 rounded text-xs font-mono bg-white/10 text-violet-300 border border-white/10 break-all"
                {...props}
              >
                {children}
              </code>
            );
          },
          p({ children }) {
            return <p className="mb-3 last:mb-0 leading-relaxed break-words">{children}</p>;
          },
          h1({ children }) {
            return <h1 className="text-2xl font-bold mb-4 mt-6 first:mt-0 break-words">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="text-xl font-semibold mb-3 mt-5 first:mt-0 break-words">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="text-lg font-semibold mb-2 mt-4 first:mt-0 break-words">{children}</h3>;
          },
          ul({ children }) {
            return <ul className="list-disc list-inside mb-3 space-y-1 pl-2 break-words">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="list-decimal list-inside mb-3 space-y-1 pl-2 break-words">{children}</ol>;
          },
          li({ children }) {
            return <li className="leading-relaxed break-words">{children}</li>;
          },
          blockquote({ children }) {
            return (
              <blockquote className="border-l-2 border-violet-500 pl-4 my-3 text-zinc-400 italic break-words">
                {children}
              </blockquote>
            );
          },
          hr() {
            return <hr className="border-white/10 my-4" />;
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-violet-400 hover:text-violet-300 underline underline-offset-2 transition-colors break-words break-all"
              >
                {children}
              </a>
            );
          },
          img({ src, alt }) {
            return (
              <img
                src={src}
                alt={alt || 'Image'}
                className="max-h-72 max-w-full rounded-xl object-contain border border-white/10 my-2 shadow-md hover:scale-[1.01] transition-transform"
                loading="lazy"
              />
            );
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto my-3">
                <table className="w-full border-collapse text-sm">{children}</table>
              </div>
            );
          },
          th({ children }) {
            return (
              <th className="border border-white/10 px-3 py-2 text-left font-semibold bg-white/5">
                {children}
              </th>
            );
          },
          td({ children }) {
            return (
              <td className="border border-white/10 px-3 py-2">{children}</td>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
MarkdownBody.displayName = 'MarkdownBody';

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, className = '' }) => {
  const text = toDisplayString(content);
  return (
    <MarkdownBoundary raw={text}>
      <MarkdownBody text={text} className={className} />
    </MarkdownBoundary>
  );
};
