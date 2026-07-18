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

export interface AppSettings {
  base_url: string;
  api_key: string;
  model_id: string;
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
