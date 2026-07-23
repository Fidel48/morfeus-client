use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{command, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{mpsc, Mutex, oneshot};
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ─── JSON-RPC Types ─────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}

// ─── MCP Client ─────────────────────────────────────────────────────────────

pub struct McpClient {
    request_tx: mpsc::Sender<(JsonRpcRequest, oneshot::Sender<Result<Value, String>>)>,
    next_id: Arc<Mutex<u64>>,
}

impl McpClient {
    pub async fn start(command: &str, args: &[&str], envs: HashMap<String, String>) -> Result<Self, String> {
        let mut child = Command::new(command)
            .args(args)
            .envs(envs)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Failed to spawn MCP server: {}", e))?;

        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();

        // Channel for outgoing requests
        let (request_tx, mut request_rx) = mpsc::channel::<(JsonRpcRequest, oneshot::Sender<Result<Value, String>>)>(32);
        
        // Track pending requests
        let pending_requests: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>> = Arc::new(Mutex::new(HashMap::new()));
        let pending_requests_reader = pending_requests.clone();

        // Write loop
        tokio::spawn(async move {
            while let Some((req, reply_tx)) = request_rx.recv().await {
                if let Some(id) = req.id {
                    pending_requests.lock().await.insert(id, reply_tx);
                }
                
                let json = serde_json::to_string(&req).unwrap();
                let payload = format!("Content-Length: {}\r\n\r\n{}", json.len(), json);
                if stdin.write_all(payload.as_bytes()).await.is_err() {
                    break;
                }
            }
        });

        // Read loop
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header).await.unwrap_or(0) == 0 {
                    break;
                }
                
                if header.starts_with("Content-Length: ") {
                    let len_str = header.trim_start_matches("Content-Length: ").trim();
                    if let Ok(len) = len_str.parse::<usize>() {
                        // Consume the \r\n
                        let mut empty_line = String::new();
                        reader.read_line(&mut empty_line).await.unwrap_or(0);
                        
                        let mut buf = vec![0; len];
                        if reader.read_exact(&mut buf).await.is_ok() {
                            if let Ok(resp) = serde_json::from_slice::<JsonRpcResponse>(&buf) {
                                if let Some(reply_tx) = pending_requests_reader.lock().await.remove(&resp.id) {
                                    if let Some(err) = resp.error {
                                        let _ = reply_tx.send(Err(err.to_string()));
                                    } else {
                                        let _ = reply_tx.send(Ok(resp.result.unwrap_or(Value::Null)));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });

        // Initialize MCP connection (protocol requires "initialize" method first)
        let client = Self {
            request_tx: request_tx.clone(),
            next_id: Arc::new(Mutex::new(1)),
        };

        // Send initialization request
        let init_params = serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "Morfeus",
                "version": "1.0.0"
            }
        });

        match tokio::time::timeout(
            std::time::Duration::from_secs(10),
            client.send_request("initialize", Some(init_params))
        ).await {
            Ok(Ok(_)) => {
                // Send initialized notification
                let _ = client.send_notification("notifications/initialized", None).await;
                Ok(client)
            },
            Ok(Err(e)) => Err(format!("MCP initialization failed: {}", e)),
            Err(_) => Err("MCP initialization timed out after 10s. The server might have hung.".to_string()),
        }
    }

    pub async fn send_request(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        let mut id_guard = self.next_id.lock().await;
        let id = *id_guard;
        *id_guard += 1;
        drop(id_guard);

        let req = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: Some(id),
            method: method.to_string(),
            params,
        };

        let (reply_tx, reply_rx) = oneshot::channel();
        self.request_tx.send((req, reply_tx)).await.map_err(|_| "Failed to send request")?;
        
        reply_rx.await.map_err(|_| "Failed to receive response")?.map_err(|e| e)
    }

    pub async fn send_notification(&self, method: &str, params: Option<Value>) -> Result<(), String> {
        let req = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: None,
            method: method.to_string(),
            params,
        };
        let (reply_tx, _) = oneshot::channel();
        self.request_tx.send((req, reply_tx)).await.map_err(|_| "Failed to send notification")?;
        Ok(())
    }
}

// ─── Tauri State & Commands ──────────────────────────────────────────────────

#[derive(Default)]
pub struct McpState {
    pub clients: Mutex<HashMap<String, McpClient>>,
}

#[command]
pub async fn mcp_start_server(
    id: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    state: State<'_, McpState>,
) -> Result<(), String> {
    let args_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    
    let client = McpClient::start(&command, &args_refs, env).await?;
    let mut clients = state.clients.lock().await;
    clients.insert(id, client);
    Ok(())
}

#[command]
pub async fn mcp_list_tools(
    id: String,
    state: State<'_, McpState>,
) -> Result<Value, String> {
    let clients = state.clients.lock().await;
    if let Some(client) = clients.get(&id) {
        client.send_request("tools/list", None).await
    } else {
        Err(format!("No active MCP server for id: {}", id))
    }
}

#[command]
pub async fn mcp_call_tool(
    id: String,
    tool_name: String,
    arguments: Value,
    state: State<'_, McpState>,
) -> Result<Value, String> {
    let clients = state.clients.lock().await;
    if let Some(client) = clients.get(&id) {
        let params = serde_json::json!({
            "name": tool_name,
            "arguments": arguments
        });
        client.send_request("tools/call", Some(params)).await
    } else {
        Err(format!("No active MCP server for id: {}", id))
    }
}
