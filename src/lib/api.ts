/**
 * api.ts
 *
 * All LLM API calls are routed through the Rust backend via Tauri commands.
 * This completely eliminates CORS issues — Rust's reqwest has no origin restrictions.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AppSettings, ChatRequest, Model, StreamChunk, ToolDefinition } from '@/types';

export class LLMApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string
  ) {
    super(message);
    this.name = 'LLMApiError';
  }
}

export const WEB_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web using DuckDuckGo to find current information, news, or facts.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_webpage',
      description: 'Read the text content of a specific URL (website, article, documentation).',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full HTTP/HTTPS URL of the webpage to read.',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_youtube_video',
      description: 'Fetch the full spoken transcript of a YouTube video by its URL. Use this whenever the user pastes a YouTube link and wants a summary, key facts, or any information about the video content.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full YouTube video URL (e.g. https://www.youtube.com/watch?v=XXXXX or https://youtu.be/XXXXX)',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: "List the files and folders inside a directory on the user's local computer. Use this to browse the filesystem, explore folders like Downloads or Documents, and find files by name. Always call get_special_dirs first if you need to find standard folders like Home, Downloads, or Documents.",
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: "The absolute path to the directory to list (e.g. /Users/john/Downloads on macOS or C:\\Users\\john\\Downloads on Windows).",
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_special_dirs',
      description: "Get the absolute paths to the user's standard directories: Home, Downloads, Documents, and Desktop. Always call this first before trying to browse the filesystem so you know the correct paths for this user's operating system.",
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: "Recursively search for files or folders by name anywhere inside the user's home directory. Use this when the user asks to 'find', 'look for', or 'locate' a file by name. Much faster than browsing folder by folder. After finding a file, use read_local_file to read its content (supports .txt, .md, .pdf, .docx, .csv, .json, code files, etc.).",
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The filename or partial name to search for (case-insensitive). E.g. "resume", "fidel", "report 2024".',
          },
          root: {
            type: 'string',
            description: 'Optional: absolute path to start searching from. Defaults to the user home directory if not provided.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_local_file',
      description: "Read the text content of a file on the user's local computer by its absolute path. Supports text files, code files, Markdown, PDF, DOCX, CSV, JSON, etc. Use this after finding a file path with search_files or list_directory, or when given a file path.",
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: "The absolute path to the local file to read (e.g. /Users/admin/Documents/resume/Fidel Ruiz Resume.pdf).",
          },
        },
        required: ['path'],
      },
    },
  },
];

// ─── Model list ──────────────────────────────────────────────────────────────

/** Fetch available models via Rust backend (no CORS) */
export async function fetchModels(baseUrl: string, apiKey: string): Promise<Model[]> {
  try {
    const models = await invoke<Array<{ id: string; object?: string }>>('proxy_fetch_models', {
      baseUrl,
      apiKey,
    });
    return models.map((m) => ({ id: m.id, object: m.object ?? '' }));
  } catch (e) {
    throw new LLMApiError(String(e));
  }
}

// ─── Connection test ─────────────────────────────────────────────────────────

/** Test connection via Rust backend (no CORS) */
export async function testConnection(
  baseUrl: string,
  apiKey: string
): Promise<{ success: boolean; message: string }> {
  try {
    const message = await invoke<string>('proxy_test_connection', { baseUrl, apiKey });
    return { success: true, message };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

// ─── Streaming chat ──────────────────────────────────────────────────────────

/** Generate a unique stream ID */
function genStreamId() {
  return `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Stream a chat completion via the Rust backend.
 * Rust opens the SSE connection to the LLM server and emits Tauri events for each token.
 * This yields StreamChunk objects just like the old fetch-based version.
 */
export async function* streamChat(
  settings: AppSettings,
  messages: ChatRequest['messages'],
  signal?: AbortSignal,
  extraTools?: ToolDefinition[]
): AsyncGenerator<StreamChunk, void, unknown> {
  const streamId = genStreamId();

  const body: ChatRequest & { num_ctx?: number; repetition_penalty?: number } = {
    model: settings.model_id,
    messages,
    temperature: settings.temperature,
    top_p: settings.top_p,
    max_tokens: settings.max_tokens,
    frequency_penalty: settings.frequency_penalty,
    repetition_penalty: 1.1, // Ollama/vLLM/llama.cpp — penalizes any repeated tokens
    stream: true,
    tools: extraTools ? [...WEB_TOOLS, ...extraTools] : WEB_TOOLS,
    num_ctx: settings.context_length,
  };

  // Chunk queue + resolver for async push/pull
  let resolver: ((value: { chunk?: StreamChunk; done: boolean; error?: string }) => void) | null = null;
  const queue: Array<{ chunk?: StreamChunk; done: boolean; error?: string }> = [];

  function push(item: { chunk?: StreamChunk; done: boolean; error?: string }) {
    if (resolver) {
      const r = resolver;
      resolver = null;
      r(item);
    } else {
      queue.push(item);
    }
  }

  // Subscribe to Tauri events from the Rust stream
  const unlistenToken = await listen<{ id: string; data: string }>('stream-token', (evt) => {
    if (evt.payload.id !== streamId) return;
    try {
      const chunk: StreamChunk = JSON.parse(evt.payload.data);
      push({ chunk, done: false });
    } catch {
      // Skip malformed SSE data
    }
  });

  const unlistenDone = await listen<{ id: string }>('stream-done', (evt) => {
    if (evt.payload.id !== streamId) return;
    push({ done: true });
  });

  const unlistenError = await listen<{ id: string; error: string }>('stream-error', (evt) => {
    if (evt.payload.id !== streamId) return;
    push({ done: true, error: evt.payload.error });
  });

  let streamDone = false;

  const cleanup = () => {
    streamDone = true;
    unlistenToken();
    unlistenDone();
    unlistenError();
    if (signal && abortHandler) {
      signal.removeEventListener('abort', abortHandler);
    }
    if (watchdogTimer) clearTimeout(watchdogTimer);
  };

  // Handle abort — store handler so it can be removed on cleanup (bug #1)
  let abortHandler: (() => void) | null = null;
  if (signal) {
    abortHandler = () => { if (!streamDone) push({ done: true, error: 'Aborted' }); };
    signal.addEventListener('abort', abortHandler);
  }

  // Watchdog: if Rust panics without emitting stream-done/stream-error, unblock after 60s (bug #17)
  let watchdogTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    if (!streamDone) push({ done: true, error: 'Stream timeout: no response from backend after 60s.' });
  }, 60000);

  // Fire the Rust command (non-awaited — it streams back via events)
  invoke('proxy_stream_chat', {
    baseUrl: settings.base_url,
    apiKey: settings.api_key,
    payload: JSON.stringify(body),
    streamId,
  }).catch((e: unknown) => {
    // Only push if stream not already terminated (bug #10)
    if (!streamDone) push({ done: true, error: String(e) });
  });

  // Yield chunks as they arrive
  try {
    while (true) {
      let item: { chunk?: StreamChunk; done: boolean; error?: string };

      if (queue.length > 0) {
        item = queue.shift()!;
      } else {
        item = await new Promise((resolve) => { resolver = resolve; });
      }

      if (item.error && item.error !== 'Aborted') {
        throw new LLMApiError(item.error);
      }
      if (item.done) break;
      if (item.chunk) yield item.chunk;
    }
  } finally {
    cleanup();
  }
}

// ─── Audio Transcription ─────────────────────────────────────────────────────

/**
 * Transcribe base64 audio via standard fetch to the /audio/transcriptions endpoint.
 * (Compatible with OpenAI API and local servers like LM Studio)
 */
export async function transcribeAudio(base64Wav: string, settings: AppSettings): Promise<string> {
  const baseUrl = settings.base_url.replace(/\/$/, '');
  const url = `${baseUrl}/audio/transcriptions`;
  
  // Convert base64 to Blob
  const byteCharacters = atob(base64Wav);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: 'audio/wav' });

  return _postAudioBlob(url, blob, 'recording.wav', settings);
}

/**
 * Transcribe a raw audio Blob via the /audio/transcriptions endpoint.
 * Used by the macOS MediaRecorder path — avoids base64 round-tripping.
 * Signature: transcribeAudio(settings, blob, mimeType)
 */
export async function transcribeAudioBlob(settings: AppSettings, blob: Blob, mimeType: string): Promise<string> {
  const baseUrl = settings.base_url.replace(/\/$/, '');
  const url = `${baseUrl}/audio/transcriptions`;
  // Pick a sensible file extension from the mime type
  const ext = mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a'
    : mimeType.includes('wav') ? 'wav'
    : 'webm';
  return _postAudioBlob(url, blob, `recording.${ext}`, settings);
}

async function _postAudioBlob(url: string, blob: Blob, filename: string, settings: AppSettings): Promise<string> {
  const formData = new FormData();
  formData.append('file', blob, filename);
  formData.append('model', settings.stt_model_path || settings.model_id || 'whisper-1');

  const headers: Record<string, string> = {};
  if (settings.api_key) {
    headers['Authorization'] = `Bearer ${settings.api_key}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: formData
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Transcription failed (${res.status}): ${errorText}`);
  }

  const data = await res.json();
  return data.text || '';
}
