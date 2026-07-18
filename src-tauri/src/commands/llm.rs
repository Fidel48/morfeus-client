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

/// Build a reqwest client that trusts all TLS certs (useful for self-signed/home servers)
fn make_client() -> reqwest::Client {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true) // allow self-signed certs on home servers
        .timeout(std::time::Duration::from_secs(300)) // 5 minute timeout for slow models
        .build()
        .expect("Failed to build HTTP client")
}

fn make_headers(api_key: &str) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("Content-Type", "application/json".parse().unwrap());
    if !api_key.is_empty() {
        if let Ok(val) = format!("Bearer {}", api_key).parse() {
            headers.insert("Authorization", val);
        }
    }
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
        Err(format!(
            "Server returned HTTP {} {}",
            resp.status().as_u16(),
            resp.status().canonical_reason().unwrap_or("")
        ))
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

    Err(format!("Could not parse model list from server. Raw response: {}", &body[..body.len().min(300)]))
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

    let resp = client
        .post(&url)
        .headers(make_headers(&api_key))
        .body(payload)
        .send()
        .await
        .map_err(|e| {
            let _ = app.emit("stream-error", serde_json::json!({ "id": stream_id, "error": e.to_string() }));
            format!("Request failed: {}", e)
        })?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        let msg = format!("HTTP {}: {}", status, body);
        let _ = app.emit("stream-error", serde_json::json!({ "id": stream_id, "error": msg }));
        return Err(msg);
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = match chunk_result {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit("stream-error", serde_json::json!({ "id": stream_id, "error": e.to_string() }));
                break;
            }
        };

        buffer.push_str(&String::from_utf8_lossy(&chunk));

        // Process complete SSE lines
        while let Some(newline_pos) = buffer.find('\n') {
            let line = buffer[..newline_pos].trim().to_string();
            buffer = buffer[newline_pos + 1..].to_string();

            if line.is_empty() || !line.starts_with("data: ") {
                continue;
            }

            let data = &line[6..];
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

    let _ = app.emit("stream-done", serde_json::json!({ "id": stream_id }));
    Ok(())
}
