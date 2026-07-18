import React, { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { CodeBlock } from './CodeBlock';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  className = '',
}) => {
  return (
    <div className={`markdown-content ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const isBlock = match !== null || String(children).includes('\n');

            if (isBlock) {
              return (
                <CodeBlock
                  language={match ? match[1] : ''}
                  code={String(children).replace(/\n$/, '')}
                />
              );
            }
            return (
              <code
                className="px-1.5 py-0.5 rounded text-xs font-mono bg-white/10 text-violet-300 border border-white/10"
                {...props}
              >
                {children}
              </code>
            );
          },
          p({ children }) {
            return <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>;
          },
          h1({ children }) {
            return <h1 className="text-2xl font-bold mb-4 mt-6 first:mt-0">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="text-xl font-semibold mb-3 mt-5 first:mt-0">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="text-lg font-semibold mb-2 mt-4 first:mt-0">{children}</h3>;
          },
          ul({ children }) {
            return <ul className="list-disc list-inside mb-3 space-y-1 pl-2">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="list-decimal list-inside mb-3 space-y-1 pl-2">{children}</ol>;
          },
          li({ children }) {
            return <li className="leading-relaxed">{children}</li>;
          },
          blockquote({ children }) {
            return (
              <blockquote className="border-l-2 border-violet-500 pl-4 my-3 text-zinc-400 italic">
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
                className="text-violet-400 hover:text-violet-300 underline underline-offset-2 transition-colors"
              >
                {children}
              </a>
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
        {content}
      </ReactMarkdown>
    </div>
  );
};
