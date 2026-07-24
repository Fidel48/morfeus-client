pub mod models;
pub mod commands;
pub mod lsp;
pub mod mcp;

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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            SqlBuilder::default()
                .add_migrations(
                    "sqlite:morfeus.db",
                    get_migrations(),
                )
                .build(),
        )
        .manage(RecordingBuffer::default())
        .manage(lsp::LspState::default())
        .manage(mcp::McpState::default())
        .invoke_handler(tauri::generate_handler![
            // MCP
            mcp::mcp_start_server,
            mcp::mcp_list_tools,
            mcp::mcp_call_tool,
            // LSP
            lsp::lsp_start_server,
            lsp::lsp_goto_definition,
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
            commands::voice::transcribe_native,
            commands::voice::speak_text,
            commands::voice::get_voices,
            commands::voice::stop_speaking,
            // Web Tools
            commands::web::search_duckduckgo,
            commands::web::fetch_webpage,
            // Files
            commands::files::parse_local_file,
            commands::files::list_directory,
            commands::files::get_special_dirs,
            commands::rules::find_project_rules,
            // YouTube
            commands::youtube::read_youtube_transcript,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Morfeus");
}
