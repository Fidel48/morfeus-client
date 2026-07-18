import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (days === 1) {
    return 'Yesterday';
  } else if (days < 7) {
    return date.toLocaleDateString([], { weekday: 'long' });
  } else {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}

export function groupConversationsByDate<T extends { updated_at: number }>(
  items: T[]
): { label: string; items: T[] }[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const lastWeek = new Date(today.getTime() - 7 * 86400000);
  const lastMonth = new Date(today.getTime() - 30 * 86400000);

  const groups: { label: string; items: T[] }[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Last 7 Days', items: [] },
    { label: 'Last 30 Days', items: [] },
    { label: 'Older', items: [] },
  ];

  for (const item of items) {
    const date = new Date(item.updated_at);
    if (date >= today) {
      groups[0].items.push(item);
    } else if (date >= yesterday) {
      groups[1].items.push(item);
    } else if (date >= lastWeek) {
      groups[2].items.push(item);
    } else if (date >= lastMonth) {
      groups[3].items.push(item);
    } else {
      groups[4].items.push(item);
    }
  }

  return groups.filter((g) => g.items.length > 0);
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '…';
}

export function extractTextContent(content: string | undefined): string {
  if (!content) return '';
  return content.replace(/```[\s\S]*?```/g, '[code block]').replace(/\n+/g, ' ').trim();
}

/** Convert raw bytes to a base64 string safely */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // Convert in chunks to avoid stack overflow for large files
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    // @ts-ignore
    binary += String.fromCharCode.apply(null, chunk);
  }
  return window.btoa(binary);
}

/** Check if a model ID suggests it supports vision/multimodal features */
export function isVisionModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return id.includes('vision') || 
         id.includes('llava') || 
         id.includes('-vl') || 
         id.includes('pixtral') || 
         id.includes('minicpm-v') ||
         id.includes('moondream') ||
         id.includes('gpt-4o') ||
         id.includes('claude-3') ||
         id.includes('gemini');
}
