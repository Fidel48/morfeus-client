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
      name: 'lsp_start_server',
      description: 'Start a native Language Server for a specific project/language.',
      parameters: {
        type: 'object',
        properties: {
          languageId: { type: 'string', description: 'The language identifier (e.g., "rust", "typescript", "python")' },
          command: { type: 'string', description: 'The binary name to launch (e.g., "rust-analyzer", "npx", "pyright")' },
          args: { type: 'array', items: { type: 'string' }, description: 'Command line arguments for the LSP server (e.g., ["typescript-language-server", "--stdio"])' },
          workspaceRoot: { type: 'string', description: 'The absolute path to the project root directory' }
        },
        required: ['languageId', 'command', 'args']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lsp_goto_definition',
      description: 'Execute a Go To Definition request on an active LSP server. Returns an array of file locations.',
      parameters: {
        type: 'object',
        properties: {
          languageId: { type: 'string', description: 'The language identifier of the active LSP server (e.g., "rust")' },
          filePath: { type: 'string', description: 'The absolute path to the source file' },
          line: { type: 'number', description: 'The 0-indexed line number where the cursor is' },
          col: { type: 'number', description: 'The 0-indexed column number where the cursor is' }
        },
        required: ['languageId', 'filePath', 'line', 'col']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mcp_start_server',
      description: 'Start a Model Context Protocol (MCP) server to access third-party tools (like sqlite, github, postgres).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'A unique identifier you choose for this MCP connection (e.g. "sqlite")' },
          command: { type: 'string', description: 'The binary name to launch (e.g. "npx")' },
          args: { type: 'array', items: { type: 'string' }, description: 'Command line arguments (e.g. ["-y", "@modelcontextprotocol/server-sqlite", "--db", "test.db"])' },
          env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional environment variables' }
        },
        required: ['id', 'command', 'args']
      }
    }
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

  const body: ChatRequest & { num_ctx?: number } = {
    model: settings.model_id,
    messages,
    temperature: settings.temperature,
    top_p: settings.top_p,
    max_tokens: settings.max_tokens,
    frequency_penalty: settings.frequency_penalty,
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

  const cleanup = () => {
    unlistenToken();
    unlistenDone();
    unlistenError();
  };

  // Handle abort
  if (signal) {
    signal.addEventListener('abort', () => {
      push({ done: true, error: 'Aborted' });
    });
  }

  // Fire the Rust command (non-awaited — it streams back via events)
  invoke('proxy_stream_chat', {
    baseUrl: settings.base_url,
    apiKey: settings.api_key,
    payload: JSON.stringify(body),
    streamId,
  }).catch((e: unknown) => {
    push({ done: true, error: String(e) });
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

  const formData = new FormData();
  formData.append('file', blob, 'recording.wav');
  formData.append('model', settings.model_id || 'whisper-1');

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
