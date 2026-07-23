use async_lsp::lsp_types::{
    InitializeParams, InitializedParams, Position, GotoDefinitionParams,
    TextDocumentIdentifier, GotoDefinitionResponse, Url, ClientCapabilities
};
use async_lsp::LanguageServer;
use std::process::Stdio;
use tokio::process::Command;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use std::ops::ControlFlow;

pub struct LspClient {
    pub server_socket: async_lsp::ServerSocket,
}

impl LspClient {
    pub async fn start(command: &str, args: &[&str], workspace_root: Option<&str>) -> Result<Self, String> {
        let mut child = Command::new(command)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn LSP: {}", e))?;

        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();

        let (main_loop, mut server) = async_lsp::MainLoop::new_client(|_server| {
            let mut router = async_lsp::router::Router::new(());
            router.unhandled_notification(|_, _| ControlFlow::Continue(()));
            router
        });

        tokio::spawn(async move {
            let _ = main_loop.run_buffered(stdout.compat(), stdin.compat_write()).await;
        });

        let root_uri = workspace_root.and_then(|p| Url::from_file_path(p).ok());
        
        #[allow(deprecated)]
        let init_params = InitializeParams {
            process_id: Some(std::process::id()),
            root_uri,
            capabilities: ClientCapabilities::default(),
            ..Default::default()
        };

        let init_future = server.initialize(init_params);
        tokio::time::timeout(std::time::Duration::from_secs(10), init_future)
            .await
            .map_err(|_| "LSP initialization timed out (10s). The command might have hung (e.g. npx prompting for install) or the binary is not a valid LSP server.")?
            .map_err(|e| format!("Init failed: {}", e))?;
            
        server.initialized(InitializedParams {}).map_err(|e| format!("Initialized failed: {}", e))?;

        Ok(Self {
            server_socket: server,
        })
    }

    pub async fn goto_definition(&mut self, file_path: &str, line: u32, col: u32) -> Result<GotoDefinitionResponse, String> {
        let uri = Url::from_file_path(file_path).map_err(|_| "Invalid path")?;
        let params = GotoDefinitionParams {
            text_document_position_params: async_lsp::lsp_types::TextDocumentPositionParams {
                text_document: TextDocumentIdentifier { uri },
                position: Position { line, character: col },
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        };

        let response = self.server_socket.definition(params).await.map_err(|e| e.to_string())?;
        Ok(response.unwrap_or(GotoDefinitionResponse::Array(vec![])))
    }
}

// ─── Tauri State & Commands ───────────────────────────────────────────────

use std::collections::HashMap;
use tokio::sync::Mutex;
use tauri::{State, command};

#[derive(Default)]
pub struct LspState {
    pub clients: Mutex<HashMap<String, LspClient>>,
}

#[command]
pub async fn lsp_start_server(
    language_id: String,
    command: String,
    args: Vec<String>,
    workspace_root: Option<String>,
    state: State<'_, LspState>,
) -> Result<(), String> {
    let args_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let root_ref = workspace_root.as_deref();
    
    let client = LspClient::start(&command, &args_refs, root_ref).await?;
    let mut clients = state.clients.lock().await;
    clients.insert(language_id, client);
    Ok(())
}

#[command]
pub async fn lsp_goto_definition(
    language_id: String,
    file_path: String,
    line: u32,
    col: u32,
    state: State<'_, LspState>,
) -> Result<GotoDefinitionResponse, String> {
    let mut clients = state.clients.lock().await;
    if let Some(client) = clients.get_mut(&language_id) {
        client.goto_definition(&file_path, line, col).await
    } else {
        Err(format!("No active LSP server for language: {}", language_id))
    }
}

