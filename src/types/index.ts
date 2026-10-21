export interface Conversation {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  model_id?: string;
  system_prompt?: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string;
  reasoning?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  created_at: number;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface Model {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
}

export type ProviderType = 'ollama' | 'lmstudio' | 'openrouter' | 'deepseek' | 'openai' | 'groq' | 'custom';

export interface ModelCatalogItem {
  id: string;
  name?: string;
}

export interface ModelProviderConfig {
  id: string;
  name: string;
  type?: ProviderType;
  base_url: string;
  api_key?: string;
  enabled?: boolean;
  is_custom?: boolean;
  models: ModelCatalogItem[];
  status?: 'online' | 'offline' | 'untested' | 'testing';
  status_message?: string;
}

export interface AppSettings {
  base_url: string;
  api_key: string;
  model_id: string;
  fast_chat_model_id?: string;
  fast_chat_provider_id?: string;
  agent_coder_model_id?: string;
  agent_coder_provider_id?: string;
  providers?: ModelProviderConfig[];
  temperature: number;
  top_p: number;
  max_tokens: number;
  context_length: number;
  frequency_penalty: number;
  system_prompt: string;
  tts_enabled: boolean;
  tts_voice: string;
  tts_rate: number;
  tts_volume: number;
  stt_model_path: string;
  ptt_mode: boolean;
  continuous_voice?: boolean;
  think_enabled?: boolean;
  debug_mode?: boolean;
}

// ── MCP Server Management ─────────────────────────────────────────────────────

/** Runtime connection status of an MCP server. */
export type McpServerStatus = 'connected' | 'connecting' | 'error' | 'disabled';

/** A discovered tool schema returned by an MCP server. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Persistent configuration for one MCP server.
 * Stored in settingsStore and persisted via @tauri-apps/plugin-store.
 */
export interface McpServerConfig {
  id: string;                        // Unique slug, e.g. "freecad", "github"
  name: string;                      // Display name, e.g. "FreeCAD MCP"
  transport?: 'stdio' | 'sse';       // Transport type (default stdio)
  command: string;                   // Process executable, e.g. "python" or "npx"
  args: string[];                    // CLI arguments, e.g. ["-m", "freecad_mcp"]
  env: Record<string, string>;       // Optional environment variables
  url?: string;                      // SSE URL if transport is sse
  enabled: boolean;                  // Toggle on/off
  // ── Runtime state (NOT persisted) ──
  status?: McpServerStatus;
  tools?: McpToolInfo[];
  errorMessage?: string;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason: string | null;
  }>;
}

export interface ChatRequest {
  model: string;
  messages: Array<{
    role: string;
    content: string | ContentPart[] | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
  }>;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  stream: boolean;
  tools?: ToolDefinition[];
}

/** A single part of a multimodal message (text or image) */
export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string; // data:image/jpeg;base64,<...>
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type VoiceStatus = 'idle' | 'recording' | 'transcribing' | 'speaking';
export type ChatStatus = 'idle' | 'thinking' | 'streaming' | 'calling-tool' | 'tool-result';
export type ChatMode = 'fast' | 'agent';
