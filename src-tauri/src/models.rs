use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub model_id: Option<String>,
    pub system_prompt: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: Option<String>,
    pub tool_calls: Option<String>,
    pub tool_call_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub base_url: String,
    pub api_key: String,
    pub model_id: String,
    pub temperature: f64,
    pub top_p: f64,
    pub max_tokens: i64,
    pub context_length: i64,
    pub frequency_penalty: f64,
    pub system_prompt: String,
    pub tts_enabled: bool,
    pub tts_voice: String,
    pub tts_rate: f64,
    pub tts_volume: f64,
    pub stt_model_path: String,
    pub ptt_mode: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            base_url: "http://localhost:1234/v1".to_string(),
            api_key: String::new(),
            model_id: String::new(),
            temperature: 0.7,
            top_p: 1.0,
            max_tokens: 2048,
            context_length: 8192,
            frequency_penalty: 0.0,
            system_prompt: "You are a helpful AI assistant.".to_string(),
            tts_enabled: false,
            tts_voice: String::new(),
            tts_rate: 1.0,
            tts_volume: 1.0,
            stt_model_path: String::new(),
            ptt_mode: true,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecordingState {
    pub is_recording: bool,
}
