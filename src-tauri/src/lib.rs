pub mod models;
pub mod commands;

use commands::voice::RecordingBuffer;
use commands::db::get_migrations;
use tauri_plugin_sql::Builder as SqlBuilder;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            SqlBuilder::default()
                .add_migrations(
                    "sqlite:morfeus.db",
                    get_migrations(),
                )
                .build(),
        )
        .manage(RecordingBuffer::default())
        .invoke_handler(tauri::generate_handler![
            // Settings
            commands::settings::get_settings,
            commands::settings::save_settings,
            // LLM proxy (bypasses CORS — all API calls go through Rust)
            commands::llm::proxy_test_connection,
            commands::llm::proxy_fetch_models,
            commands::llm::proxy_stream_chat,
            // Voice / STT
            commands::voice::start_recording,
            commands::voice::stop_recording,
            commands::voice::check_microphone,
            commands::voice::get_audio_devices,
            commands::voice::speak_text,
            commands::voice::get_voices,
            commands::voice::stop_speaking,
            // Web Tools
            commands::web::search_duckduckgo,
            commands::web::fetch_webpage,
            // Files
            commands::files::parse_local_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Morfeus");
}
