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
pub struct ModelCatalogItem {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelProviderConfig {
    pub id: String,
    pub name: String,
    #[serde(rename = "type", default)]
    pub provider_type: Option<String>,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub is_custom: bool,
    #[serde(default)]
    pub models: Vec<ModelCatalogItem>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub base_url: String,
    pub api_key: String,
    pub model_id: String,
    #[serde(default)]
    pub fast_chat_model_id: Option<String>,
    #[serde(default)]
    pub fast_chat_provider_id: Option<String>,
    #[serde(default)]
    pub agent_coder_model_id: Option<String>,
    #[serde(default)]
    pub agent_coder_provider_id: Option<String>,
    #[serde(default)]
    pub providers: Vec<ModelProviderConfig>,
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
    #[serde(default)]
    pub think_enabled: Option<bool>,
    #[serde(default)]
    pub debug_mode: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            base_url: "http://localhost:1234/v1".to_string(),
            api_key: String::new(),
            model_id: String::new(),
            fast_chat_model_id: None,
            fast_chat_provider_id: None,
            agent_coder_model_id: None,
            agent_coder_provider_id: None,
            providers: Vec::new(),
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
            think_enabled: Some(true),
            debug_mode: false,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecordingState {
    pub is_recording: bool,
}
