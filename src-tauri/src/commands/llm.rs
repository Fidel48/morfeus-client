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

/// Query Ollama for a model's active or configured context window (num_ctx).
/// Checks live /api/ps first, then falls back to /api/show Modelfile parameters.
#[tauri::command]
pub async fn proxy_get_ollama_context(
    base_url: String,
    model_name: String,
) -> Result<Option<u32>, String> {
    let trimmed_url = base_url.trim_end_matches('/');
    let origin = trimmed_url.strip_suffix("/v1").unwrap_or(trimmed_url);
    let client = make_client();

    // 1. Check live active models in /api/ps
    let ps_url = format!("{}/api/ps", origin);
    if let Ok(resp) = client.get(&ps_url).send().await {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(models) = json.get("models").and_then(|m| m.as_array()) {
                    for m in models {
                        let name = m.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        let matches = name == model_name
                            || name.starts_with(&format!("{}:", model_name))
                            || model_name.starts_with(&format!("{}:", name));
                        if matches {
                            if let Some(ctx) = m.get("context_length").and_then(|c| c.as_u64()) {
                                if ctx >= 1024 {
                                    return Ok(Some(ctx as u32));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Check Modelfile parameters in /api/show
    let show_url = format!("{}/api/show", origin);
    let body = serde_json::json!({ "name": model_name });

    if let Ok(resp) = client.post(&show_url).json(&body).send().await {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(params) = json.get("parameters").and_then(|p| p.as_str()) {
                    for line in params.lines() {
                        let trimmed = line.trim();
                        if trimmed.starts_with("num_ctx") {
                            if let Some(val_str) = trimmed.split_whitespace().nth(1) {
                                if let Ok(val) = val_str.parse::<u32>() {
                                    return Ok(Some(val));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(None)
}

/// Helper: Prepares an OpenAI-compatible chat completion payload for Ollama's native `/api/chat` endpoint.
/// Ollama's `/v1/chat/completions` translation adapter discards `options.num_ctx` and reloads models with
/// a hardcoded 2048/4096 VRAM context ceiling. Routing directly to `/api/chat` with explicit `options.num_ctx`
/// guarantees that Ollama allocates and preserves the exact context window requested by the user.
fn transform_for_ollama(payload: &str) -> (serde_json::Value, u64) {
    let mut val: serde_json::Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(_) => return (serde_json::Value::Null, 16384),
    };

    let num_ctx = val.pointer("/options/num_ctx")
        .and_then(|v| v.as_u64())
        .or_else(|| val.get("num_ctx").and_then(|v| v.as_u64()))
        .unwrap_or(16384);

    let temperature = val.get("temperature").cloned();
    let top_p = val.get("top_p").cloned();
    let max_tokens = val.get("max_tokens").cloned();
    let repeat_penalty = val.pointer("/options/repeat_penalty").cloned();

    // Transform messages: Ollama's /api/chat expects message.content to be a string.
    // If it's an array of multimodal parts (text + image_url), extract text and images.
    // Additionally, Ollama native /api/chat requires:
    // 1. Assistant message tool_calls arguments MUST be a native JSON object, NOT a serialized string.
    // 2. Tool response messages (role: "tool") MUST have tool_name matching the function name.
    let mut tool_name_map = std::collections::HashMap::new();

    if let Some(messages) = val.get_mut("messages").and_then(|m| m.as_array_mut()) {
        for msg in messages.iter_mut() {
            // Normalize content (prevent null content from breaking Ollama)
            if msg.get("content").map_or(true, |c| c.is_null()) {
                msg["content"] = serde_json::Value::String(String::new());
            } else if let Some(parts) = msg.get("content").and_then(|c| c.as_array()) {
                let mut text_buf = String::new();
                let mut images_arr = Vec::new();

                for p in parts {
                    if let Some(typ) = p.get("type").and_then(|t| t.as_str()) {
                        if typ == "text" {
                            if let Some(txt) = p.get("text").and_then(|t| t.as_str()) {
                                text_buf.push_str(txt);
                            }
                        } else if typ == "image_url" {
                            if let Some(url_str) = p.pointer("/image_url/url").and_then(|u| u.as_str()) {
                                let b64 = if let Some(comma_pos) = url_str.find(',') {
                                    &url_str[comma_pos + 1..]
                                } else {
                                    url_str
                                };
                                images_arr.push(serde_json::Value::String(b64.to_string()));
                            }
                        }
                    }
                }

                msg["content"] = serde_json::Value::String(text_buf);
                if !images_arr.is_empty() {
                    msg["images"] = serde_json::Value::Array(images_arr);
                }
            }

            // Convert assistant tool_calls arguments from serialized JSON string to native JSON object
            if let Some(tool_calls) = msg.get_mut("tool_calls").and_then(|tc| tc.as_array_mut()) {
                for tc in tool_calls {
                    let tc_id = tc.get("id").and_then(|id| id.as_str()).unwrap_or("").to_string();
                    let func_name = tc.pointer("/function/name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                    if !tc_id.is_empty() && !func_name.is_empty() {
                        tool_name_map.insert(tc_id, func_name);
                    }

                    if let Some(func) = tc.get_mut("function") {
                        let parsed_args = match func.get("arguments") {
                            Some(serde_json::Value::String(s)) => {
                                match serde_json::from_str::<serde_json::Value>(s) {
                                    Ok(v) if v.is_object() => v,
                                    _ => serde_json::json!({}),
                                }
                            }
                            Some(serde_json::Value::Object(obj)) => serde_json::Value::Object(obj.clone()),
                            _ => serde_json::json!({}),
                        };
                        func["arguments"] = parsed_args;
                    }
                }
            }

            // For role: "tool" messages, ensure tool_name / name is populated for Ollama native /api/chat
            if msg.get("role").and_then(|r| r.as_str()) == Some("tool") {
                let tool_call_id = msg.get("tool_call_id").and_then(|id| id.as_str()).unwrap_or("");
                let matched_name = if let Some(n) = msg.get("tool_name").and_then(|n| n.as_str()) {
                    Some(n.to_string())
                } else if let Some(n) = msg.get("name").and_then(|n| n.as_str()) {
                    Some(n.to_string())
                } else if !tool_call_id.is_empty() {
                    tool_name_map.get(tool_call_id).cloned()
                } else {
                    None
                };

                if let Some(name) = matched_name {
                    msg["tool_name"] = serde_json::Value::String(name.clone());
                    msg["name"] = serde_json::Value::String(name);
                }
            }
        }
    }

    // Build options map for Ollama
    let mut options = serde_json::Map::new();
    options.insert("num_ctx".to_string(), serde_json::json!(num_ctx));
    if let Some(t) = temperature {
        options.insert("temperature".to_string(), t);
    }
    if let Some(p) = top_p {
        options.insert("top_p".to_string(), p);
    }
    if let Some(m) = max_tokens {
        options.insert("num_predict".to_string(), m);
    }
    if let Some(rp) = repeat_penalty {
        options.insert("repeat_penalty".to_string(), rp);
    } else {
        options.insert("repeat_penalty".to_string(), serde_json::json!(1.1));
    }
    val["options"] = serde_json::Value::Object(options);
    val["stream"] = serde_json::json!(true);

    (val, num_ctx)
}

/// Helper: Translates an Ollama `/api/chat` ndjson streaming chunk into an OpenAI-compatible SSE chunk.
fn ollama_chunk_to_openai_sse(stream_id: &str, line: &str) -> Result<Option<(String, bool)>, String> {
    let val: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };

    if let Some(err) = val.get("error").and_then(|e| e.as_str()) {
        return Err(err.to_string());
    }

    let model = val.get("model").and_then(|m| m.as_str()).unwrap_or("ollama");
    let done = val.get("done").and_then(|d| d.as_bool()).unwrap_or(false);
    let done_reason = val.get("done_reason").and_then(|r| r.as_str()).unwrap_or("stop");

    let message = val.get("message");
    let content = message.and_then(|m| m.get("content")).and_then(|c| c.as_str()).unwrap_or("");
    let thinking = message.and_then(|m| m.get("thinking")).and_then(|t| t.as_str()).unwrap_or("");

    let mut delta = serde_json::Map::new();
    delta.insert("role".to_string(), serde_json::json!("assistant"));
    if !content.is_empty() {
        delta.insert("content".to_string(), serde_json::json!(content));
    }
    if !thinking.is_empty() {
        delta.insert("reasoning_content".to_string(), serde_json::json!(thinking));
    }

    if let Some(tool_calls) = message.and_then(|m| m.get("tool_calls")).and_then(|tc| tc.as_array()) {
        let mut converted_tc = Vec::new();
        for (idx, tc) in tool_calls.iter().enumerate() {
            let tc_id = tc.get("id").and_then(|id| id.as_str()).unwrap_or("call_ollama");
            let func_name = tc.pointer("/function/name").and_then(|n| n.as_str()).unwrap_or("");
            let func_args = tc.pointer("/function/arguments");
            let args_str = match func_args {
                Some(serde_json::Value::String(s)) => s.clone(),
                Some(obj) => serde_json::to_string(obj).unwrap_or_default(),
                None => String::new(),
            };
            converted_tc.push(serde_json::json!({
                "index": idx,
                "id": tc_id,
                "type": "function",
                "function": {
                    "name": func_name,
                    "arguments": args_str
                }
            }));
        }
        if !converted_tc.is_empty() {
            delta.insert("tool_calls".to_string(), serde_json::Value::Array(converted_tc));
        }
    }

    let finish_reason = if done {
        serde_json::json!(done_reason)
    } else {
        serde_json::Value::Null
    };

    let openai_chunk = serde_json::json!({
        "id": stream_id,
        "object": "chat.completion.chunk",
        "created": 0,
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": delta,
                "finish_reason": finish_reason
            }
        ]
    });

    let sse_data = serde_json::to_string(&openai_chunk).map_err(|e| e.to_string())?;
    Ok(Some((sse_data, done)))
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

    // Ollama's OpenAI-compatible /v1/chat/completions endpoint does not respect per-request
    // context window parameters (num_ctx), resetting loaded models to 2048/4096 VRAM limit.
    // For Ollama connections, route directly to Ollama's native /api/chat with full options support.
    let is_ollama = base_url.contains(":11434") || base_url.contains("ollama");
    let (url, request_payload) = if is_ollama {
        let trimmed_url = base_url.trim_end_matches('/');
        let origin = trimmed_url.strip_suffix("/v1").unwrap_or(trimmed_url);
        let (val, _num_ctx) = transform_for_ollama(&payload);
        let final_body = if val.is_null() {
            payload
        } else {
            serde_json::to_string(&val).unwrap_or(payload)
        };
        (format!("{}/api/chat", origin), final_body)
    } else {
        (format!("{}/chat/completions", base_url.trim_end_matches('/')), payload)
    };

    let send_fut = client
        .post(&url)
        .headers(make_stream_headers(&api_key)) // includes X-Accel-Buffering: no for Cloudflare
        .body(request_payload)
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

        if is_ollama {
            // Process complete Ollama ndjson lines
            while let Some(newline_pos) = buffer.iter().position(|&b| b == b'\n') {
                let raw: Vec<u8> = buffer.drain(..=newline_pos).collect();
                let line = String::from_utf8_lossy(&raw[..raw.len() - 1]).trim().to_string();

                if line.is_empty() {
                    continue;
                }

                match ollama_chunk_to_openai_sse(&stream_id, &line) {
                    Ok(Some((sse_data, done))) => {
                        let _ = app.emit("stream-token", serde_json::json!({
                            "id": stream_id,
                            "data": sse_data
                        }));
                        if done {
                            let _ = app.emit("stream-done", serde_json::json!({ "id": stream_id }));
                            return Ok(());
                        }
                    }
                    Ok(None) => {}
                    Err(err_msg) => {
                        let _ = app.emit("stream-error", serde_json::json!({ "id": stream_id, "error": err_msg }));
                        return Err(err_msg);
                    }
                }
            }
        } else {
            // Process complete OpenAI SSE lines
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
    }

    let _ = app.emit("stream-done", serde_json::json!({ "id": stream_id }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_transform_for_ollama_basic() {
        let input = serde_json::json!({
            "model": "qwen3.5:9b",
            "messages": [
                { "role": "system", "content": "You are helpful." },
                { "role": "user", "content": "Hello!" }
            ],
            "temperature": 0.7,
            "max_tokens": 4096,
            "options": {
                "num_ctx": 32768
            },
            "think": false
        });

        let (transformed, num_ctx) = transform_for_ollama(&input.to_string());
        assert_eq!(num_ctx, 32768);
        assert_eq!(transformed["model"], "qwen3.5:9b");
        assert_eq!(transformed["stream"], true);
        assert_eq!(transformed["options"]["num_ctx"], 32768);
        assert_eq!(transformed["options"]["temperature"], 0.7);
        assert_eq!(transformed["options"]["num_predict"], 4096);
        assert_eq!(transformed["options"]["repeat_penalty"], 1.1);
        assert_eq!(transformed["think"], false);
    }

    #[test]
    fn test_transform_for_ollama_multimodal() {
        let input = serde_json::json!({
            "model": "qwen3.5:9b",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        { "type": "text", "text": "Describe this image: " },
                        { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" } }
                    ]
                }
            ],
            "options": {
                "num_ctx": 16384
            }
        });

        let (transformed, num_ctx) = transform_for_ollama(&input.to_string());
        assert_eq!(num_ctx, 16384);
        let msg = &transformed["messages"][0];
        assert_eq!(msg["content"], "Describe this image: ");
        assert_eq!(msg["images"][0], "iVBORw0KGgoAAAANSUhEUg==");
    }

    #[test]
    fn test_ollama_chunk_to_openai_sse_text_and_thinking() {
        let stream_id = "test-stream-123";

        // 1. Thinking chunk
        let thinking_line = r#"{"model":"qwen3.5:9b","message":{"role":"assistant","content":"","thinking":"Hmm let me think"},"done":false}"#;
        let res = ollama_chunk_to_openai_sse(stream_id, thinking_line).unwrap();
        assert!(res.is_some());
        let (sse, done) = res.unwrap();
        assert!(!done);
        let val: serde_json::Value = serde_json::from_str(&sse).unwrap();
        assert_eq!(val["id"], stream_id);
        assert_eq!(val["choices"][0]["delta"]["reasoning_content"], "Hmm let me think");
        assert!(val["choices"][0]["finish_reason"].is_null());

        // 2. Content chunk
        let content_line = r#"{"model":"qwen3.5:9b","message":{"role":"assistant","content":"Answer is B."},"done":false}"#;
        let res2 = ollama_chunk_to_openai_sse(stream_id, content_line).unwrap();
        assert!(res2.is_some());
        let (sse2, done2) = res2.unwrap();
        assert!(!done2);
        let val2: serde_json::Value = serde_json::from_str(&sse2).unwrap();
        assert_eq!(val2["choices"][0]["delta"]["content"], "Answer is B.");

        // 3. Done chunk
        let done_line = r#"{"model":"qwen3.5:9b","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}"#;
        let res3 = ollama_chunk_to_openai_sse(stream_id, done_line).unwrap();
        assert!(res3.is_some());
        let (sse3, done3) = res3.unwrap();
        assert!(done3);
        let val3: serde_json::Value = serde_json::from_str(&sse3).unwrap();
        assert_eq!(val3["choices"][0]["finish_reason"], "stop");
    }

    #[test]
    fn test_ollama_chunk_to_openai_sse_tool_calls() {
        let stream_id = "test-stream-456";
        let tool_line = r#"{"model":"qwen3.5:9b","message":{"role":"assistant","content":"","tool_calls":[{"id":"call_abc","function":{"name":"search","arguments":{"query":"NC law"}}}]},"done":false}"#;
        let res = ollama_chunk_to_openai_sse(stream_id, tool_line).unwrap();
        assert!(res.is_some());
        let (sse, done) = res.unwrap();
        assert!(!done);
        let val: serde_json::Value = serde_json::from_str(&sse).unwrap();
        let tc = &val["choices"][0]["delta"]["tool_calls"][0];
        assert_eq!(tc["id"], "call_abc");
        assert_eq!(tc["function"]["name"], "search");
        // Arguments must be serialized to string for OpenAI format
        assert_eq!(tc["function"]["arguments"], r#"{"query":"NC law"}"#);
    }

    #[test]
    fn test_transform_for_ollama_tool_calls_and_results() {
        let openai_payload = r#"{
            "model": "qwen3.5:9b",
            "messages": [
                {
                    "role": "user",
                    "content": "can you list the files i have on my dowload folders"
                },
                {
                    "role": "assistant",
                    "content": "I'll check your Downloads folder for you.",
                    "tool_calls": [
                        {
                            "id": "call_123",
                            "type": "function",
                            "function": {
                                "name": "get_special_dirs",
                                "arguments": "{}"
                            }
                        }
                    ]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_123",
                    "content": "{\"downloads\": \"/Users/admin/Downloads\"}"
                }
            ],
            "options": {
                "num_ctx": 32768
            }
        }"#;

        let (val, num_ctx) = transform_for_ollama(openai_payload);
        assert_eq!(num_ctx, 32768);

        // Assistant message tool_calls arguments must be parsed into an object, NOT a string
        let asst_tc = &val["messages"][1]["tool_calls"][0];
        assert_eq!(asst_tc["id"], "call_123");
        assert_eq!(asst_tc["function"]["name"], "get_special_dirs");
        assert!(asst_tc["function"]["arguments"].is_object(), "arguments must be a JSON object, not a string");
        assert_eq!(asst_tc["function"]["arguments"], serde_json::json!({}));

        // Tool message must have tool_name and name matching the function
        let tool_msg = &val["messages"][2];
        assert_eq!(tool_msg["role"], "tool");
        assert_eq!(tool_msg["tool_name"], "get_special_dirs");
        assert_eq!(tool_msg["name"], "get_special_dirs");
    }
}
