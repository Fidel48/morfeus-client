import React, { useState } from 'react';
import { Check, Copy, Code2 } from 'lucide-react';
import { useCanvasStore } from '@/stores/canvasStore';
import { useChatStore } from '@/stores/chatStore';

interface CodeBlockProps {
  language: string;
  code: string;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({ language, code }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard not available
    }
  };

  const handleOpenInCanvas = () => {
    useCanvasStore.getState().loadCodeSnippet(code, language);
    useChatStore.getState().openRightPanelTab('code');
  };

  return (
    <div className="group relative my-3 rounded-lg overflow-hidden border border-white/10 bg-zinc-900/80">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-white/5 border-b border-white/10">
        <span className="text-xs font-mono text-zinc-400 uppercase tracking-wider">
          {language || 'plaintext'}
        </span>
        <div className="flex items-center gap-2.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={handleOpenInCanvas}
            className="flex items-center gap-1 text-xs text-zinc-400 hover:text-violet-300 transition-colors"
            title="Inspect & run in side Coder Canvas (Ctrl+\)"
          >
            <Code2 size={12} className="text-violet-400" />
            <span>Canvas</span>
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-xs text-zinc-400 hover:text-white transition-colors"
            title="Copy code"
          >
            {copied ? (
              <>
                <Check size={12} className="text-emerald-400" />
                <span className="text-emerald-400">Copied!</span>
              </>
            ) : (
              <>
                <Copy size={12} />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Code */}
      <pre className="overflow-x-auto p-4 text-sm leading-relaxed">
        <code className={language ? `language-${language}` : ''}>{code}</code>
      </pre>
    </div>
  );
};
