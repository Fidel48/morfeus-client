import React from 'react';

/**
 * Recursively extract plain text from a React node tree.
 * Never coerces objects with String()/join(), which is what produced "[object Object]"
 * when syntax-highlighted <span> elements were stringified.
 */
export function extractTextFromChildren(children: React.ReactNode): string {
  if (children == null || typeof children === 'boolean') return '';
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractTextFromChildren).join('');
  if (React.isValidElement(children)) {
    return extractTextFromChildren((children.props as { children?: React.ReactNode })?.children);
  }
  return '';
}

/**
 * Normalize any message content (string, null, multimodal array, object) into a
 * renderable string so markdown rendering can never receive a non-string.
 */
export function toDisplayString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const p = part as { type?: string; text?: string; image_url?: { url?: string } };
          if (typeof p.text === 'string') return p.text;
          if (p.image_url?.url) return `![image](${p.image_url.url})`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  try {
    return '```json\n' + JSON.stringify(value, null, 2) + '\n```';
  } catch {
    return '';
  }
}

/** Any "[object Object]" leaking into text is a rendering bug; detect it for diagnostics. */
export function hasObjectLeak(text: string): boolean {
  return text.includes('[object Object]');
}
