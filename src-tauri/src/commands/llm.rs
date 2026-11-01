use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelInfo {
    pub id: String,
    pub object: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ModelsResponse {
    data: Option<Vec<ModelInfo>>,
}

/// Build a reqwest client compatible with both direct LAN connections and Cloudflare-proxied URLs.
/// Key settings:
///  - danger_accept_invalid_certs: handles self-signed certs on home servers
///  - tcp_keepalive: keeps the connection alive through Cloudflare's idle timeout detection
///  - No overall .timeout(): streaming responses are arbitrarily long; JS watchdog handles inactivity
fn make_client() -> reqwest::Client {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .connect_timeout(std::time::Duration::from_secs(30))
        .tcp_keepalive(std::time::Duration::from_secs(15)) // send TCP keepalive every 15s
        .http2_keep_alive_interval(std::time::Duration::from_secs(15)) // send HTTP/2 keepalive PING every 15s to keep Cloudflare streams alive
        .build()
        .expect("Failed to build HTTP client")
}

fn make_headers(api_key: &str) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("Content-Type", "application/json".parse().unwrap());
    headers.insert("HTTP-Referer", "https://morfeus.app".parse().unwrap());
    headers.insert("X-Title", "Morfeus Client".parse().unwrap());
    if !api_key.is_empty() {
        if let Ok(val) = format!("Bearer {}", api_key).parse() {
            headers.insert("Authorization", val);
        }
    }
    headers
}

/// Headers specifically for SSE/streaming requests.
/// - Accept: text/event-stream → tells Cloudflare Proxy that this is an SSE stream, enabling instant chunk forwarding
/// - X-Accel-Buffering: no    → tells Cloudflare and Nginx NOT to buffer response bytes
/// - Cache-Control: no-cache   → prevents proxy caching and buffering
/// - Connection: keep-alive    → keeps the HTTP connection open across chunks
fn make_stream_headers(api_key: &str) -> reqwest::header::HeaderMap {
    let mut headers = make_headers(api_key);
    headers.insert("Accept", "text/event-stream".parse().unwrap());
    headers.insert("X-Accel-Buffering", "no".parse().unwrap());
    headers.insert("Cache-Control", "no-cache".parse().unwrap());
    headers.insert("Connection", "keep-alive".parse().unwrap());
    headers
}

/// Test connection to the LLM server — runs in Rust to avoid CORS
#[tauri::command]
pub async fn proxy_test_connection(
    base_url: String,
    api_key: String,
) -> Result<String, String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let client = make_client();

    let resp = client
        .get(&url)
        .headers(make_headers(&api_key))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if resp.status().is_success() {
        let models_resp: ModelsResponse = resp
            .json()
            .await
            .map_err(|e| format!("Invalid response from server: {}", e))?;
        let count = models_resp.data.as_ref().map(|d| d.len()).unwrap_or(0);
        Ok(format!("Connected — {} model{} available", count, if count != 1 { "s" } else { "" }))
    } else {
        let status = resp.status().as_u16();
        let err = match status {
            524 => "HTTP 524: Cloudflare timeout — your URL is behind a Cloudflare proxy. Use the direct local IP instead (e.g. http://192.168.1.x:1234 or http://localhost:11434).".to_string(),
            523 => "HTTP 523: Cloudflare cannot reach your LLM server. Make sure the server is running and the URL/tunnel is correct.".to_string(),
            401 | 403 => format!("HTTP {}: Authentication failed — check your API key in Settings.", status),
            404 => "HTTP 404: Endpoint not found — check your Base URL (e.g. http://localhost:1234 for LM Studio).".to_string(),
            503 => "HTTP 503: LLM server is starting up or loading the model — wait a moment then try again.".to_string(),
            _ => format!("HTTP {} {}", status, resp.status().canonical_reason().unwrap_or("")),
        };
        Err(err)
    }
}

/// Fetch model list from the LLM server — runs in Rust to avoid CORS
#[tauri::command]
pub async fn proxy_fetch_models(
    base_url: String,
    api_key: String,
) -> Result<Vec<ModelInfo>, String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let client = make_client();

    let resp = client
        .get(&url)
        .headers(make_headers(&api_key))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Server error: HTTP {}. Check that your LLM server is running and the URL is correct.",
            resp.status().as_u16()
        ));
    }

    let body = resp.text().await.map_err(|e| e.to_string())?;

    // Try to parse as { data: [...] }
    if let Ok(parsed) = serde_json::from_str::<ModelsResponse>(&body) {
        if let Some(models) = parsed.data {
            return Ok(models);
        }
    }

    // Fallback: try parsing as a plain array
    if let Ok(arr) = serde_json::from_str::<Vec<ModelInfo>>(&body) {
        return Ok(arr);
    }

    // Last resort: extract IDs from raw JSON
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
        if let Some(arr) = val.get("data").and_then(|d| d.as_array()) {
            let models: Vec<ModelInfo> = arr
                .iter()
                .filter_map(|m| {
                    m.get("id")
                        .and_then(|id| id.as_str())
                        .map(|id| ModelInfo { id: id.to_string(), object: None })
                })
                .collect();
            if !models.is_empty() {
                return Ok(models);
            }
        }
    }

    Err(format!("Could not parse model list from server. Raw response: {}", body.chars().take(300).collect::<String>()))
}

/// Registry of in-flight streams so the frontend can cancel them. Dropping the HTTP response
/// closes the connection, which makes Ollama / LM Studio stop generating immediately instead of
/// burning GPU on an answer nobody will read (and queueing the next request behind it).
fn stream_registry() -> &'static std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Notify>>> {
    static REG: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Notify>>>> =
        std::sync::OnceLock::new();
    REG.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn stream_cancel_handle(stream_id: &str) -> std::sync::Arc<tokio::sync::Notify> {
    let mut reg = stream_registry().lock().unwrap();
    reg.entry(stream_id.to_string())
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Notify::new()))
        .clone()
}

/// Cancel an in-flight stream. Safe to call before the stream has registered (the permit is stored).
#[tauri::command]
pub async fn proxy_cancel_stream(stream_id: String) -> Result<(), String> {
    stream_cancel_handle(&stream_id).notify_one();
    Ok(())
}

/// Stream a chat completion through the Rust backend, emitting SSE tokens as Tauri events.
/// This completely bypasses CORS restrictions.
#[tauri::command]
pub async fn proxy_stream_chat(
    app: AppHandle,
    base_url: String,
    api_key: String,
    payload: String, // pre-serialised JSON request body
    stream_id: String, // unique ID so frontend can match this stream's events
) -> Result<(), String> {
    use tauri::Emitter;
    use futures_util::StreamExt;

    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let client = make_client();
    let cancel = stream_cancel_handle(&stream_id);
    // Always unregister when this stream ends, whatever the exit path.
    struct Unregister(String);
    impl Drop for Unregister {
        fn drop(&mut self) {
            if let Ok(mut reg) = stream_registry().lock() {
                reg.remove(&self.0);
            }
        }
    }
    let _unregister = Unregister(stream_id.clone());

    let send_fut = client
        .post(&url)
        .headers(make_stream_headers(&api_key)) // includes X-Accel-Buffering: no for Cloudflare
        .body(payload)
        .send();

    let resp = tokio::select! {
        _ = cancel.notified() => return Ok(()),
        r = send_fut => r.map_err(|e| {
            let _ = app.emit("stream-error", serde_json::json!({ "id": stream_id, "error": e.to_string() }));
            format!("Request failed: {}", e)
        })?,
    };

    if !resp.status().is_success() {
        let status_code = resp.status();
        let status = status_code.as_u16();
        let canonical_reason = status_code.canonical_reason().unwrap_or("").to_string();
        let body = resp.text().await.unwrap_or_default();

        // Extract human-readable error detail if body is JSON
        let parsed_detail = if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
            json.pointer("/error/metadata/raw")
                .and_then(|v| v.as_str())
                .or_else(|| json.pointer("/error/message").and_then(|v| v.as_str()))
                .or_else(|| json.get("message").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
        } else {
            None
        };

        // Provide specific, actionable messages for common failure codes
        let msg = match status {
            524 => concat!(
                "HTTP 524: Cloudflare connection timeout.\n\n",
                "Your LLM server URL is behind a Cloudflare proxy, which cuts connections after ~100 seconds — ",
                "before the model has time to respond.\n\n",
                "Fix: In Settings, change your Base URL to the direct local IP of your LLM server ",
                "(e.g. http://192.168.1.x:1234 for LM Studio, or http://localhost:11434 for Ollama). ",
                "Avoid Cloudflare tunnel URLs for local model inference."
            ).to_string(),
            523 => format!(
                "HTTP 523: Cloudflare cannot reach your LLM server (Origin Unreachable). \
                Check that your LLM server is running and the tunnel/URL in Settings is correct. \
                Body: {}", body
            ),
            429 => {
                let detail = parsed_detail.unwrap_or_else(|| body.clone());
                format!("HTTP 429: {}", detail)
            }
            402 => {
                let detail = parsed_detail.unwrap_or_else(|| body.clone());
                format!("HTTP 402: {}", detail)
            }
            401 | 403 => {
                let detail = parsed_detail.unwrap_or_else(|| body.clone());
                format!("HTTP {}: {}", status, detail)
            }
            404 => {
                let detail = parsed_detail.unwrap_or_else(|| body.clone());
                format!("HTTP 404: {}", detail)
            }
            503 => {
                let detail = parsed_detail.unwrap_or_else(|| body.clone());
                format!("HTTP 503: {}", detail)
            }
            _ => {
                if let Some(detail) = parsed_detail {
                    format!("HTTP {}: {}", status, detail)
                } else if body.is_empty() {
                    format!("HTTP {} {}", status, canonical_reason)
                } else {
                    format!("HTTP {}: {}", status, body)
                }
            }
        };

        let _ = app.emit("stream-error", serde_json::json!({ "id": stream_id, "error": msg }));
        return Err(msg);
    }

    let mut stream = resp.bytes_stream();
    // Buffer RAW BYTES and only decode complete lines. Decoding each network chunk separately
    // (from_utf8_lossy) turned any multi-byte character split across two chunks (emoji, accents,
    // CJK, box-drawing) into permanent "�" garbage in the model's output.
    let mut buffer: Vec<u8> = Vec::new();

    loop {
        let chunk_result = tokio::select! {
            _ = cancel.notified() => return Ok(()), // dropping `stream` closes the connection
            next = stream.next() => match next {
                Some(r) => r,
                None => break,
            },
        };
        let chunk = match chunk_result {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit("stream-error", serde_json::json!({ "id": stream_id, "error": e.to_string() }));
                break;
            }
        };

        buffer.extend_from_slice(&chunk);

        // Process complete SSE lines
        while let Some(newline_pos) = buffer.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = buffer.drain(..=newline_pos).collect();
            let line = String::from_utf8_lossy(&raw[..raw.len() - 1]).trim().to_string();

            if line.is_empty() {
                continue;
            }

            if let Some(rest) = line.strip_prefix("data:") {
                let data = rest.trim();
                if data.is_empty() {
                    continue;
                }

                if data == "[DONE]" {
                    let _ = app.emit("stream-done", serde_json::json!({ "id": stream_id }));
                    return Ok(());
                }

                // Emit raw JSON chunk to frontend
                let _ = app.emit("stream-token", serde_json::json!({
                    "id": stream_id,
                    "data": data
                }));
            }
        }
    }

    let _ = app.emit("stream-done", serde_json::json!({ "id": stream_id }));
    Ok(())
}
