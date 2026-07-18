use reqwest::Client;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct SearchResult {
    title: String,
    url: String,
    snippet: String,
}

fn make_client() -> Client {
    Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("Failed to build HTTP client")
}

#[tauri::command]
pub async fn search_duckduckgo(query: String) -> Result<Vec<SearchResult>, String> {
    let client = make_client();
    let url = "https://html.duckduckgo.com/html/";
    
    let resp = client.post(url)
        .form(&[("q", query.as_str())])
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("DuckDuckGo returned HTTP {}", resp.status().as_u16()));
    }

    let body = resp.text().await.map_err(|e| e.to_string())?;
    let document = Html::parse_document(&body);
    
    // DuckDuckGo lite selectors
    let result_selector = Selector::parse(".result").unwrap();
    let title_selector = Selector::parse(".result__title .result__a").unwrap();
    let snippet_selector = Selector::parse(".result__snippet").unwrap();

    let mut results = Vec::new();

    for element in document.select(&result_selector).take(5) {
        if let Some(title_el) = element.select(&title_selector).next() {
            let title = title_el.text().collect::<Vec<_>>().join("").trim().to_string();
            let href = title_el.value().attr("href").unwrap_or("").to_string();
            
            // Clean up duckduckgo redirect URL
            let mut url = href.clone();
            if url.starts_with("//duckduckgo.com/l/?uddg=") {
                if let Some(encoded) = url.split("uddg=").nth(1) {
                    if let Some(clean) = encoded.split('&').next() {
                        if let Ok(decoded) = urlencoding::decode(clean) {
                            url = decoded.to_string();
                        }
                    }
                }
            }

            let snippet = if let Some(snippet_el) = element.select(&snippet_selector).next() {
                snippet_el.text().collect::<Vec<_>>().join("").trim().to_string()
            } else {
                String::new()
            };

            if !title.is_empty() && !url.is_empty() {
                results.push(SearchResult { title, url, snippet });
            }
        }
    }

    Ok(results)
}

#[tauri::command]
pub async fn fetch_webpage(url: String) -> Result<String, String> {
    let client = make_client();
    let resp = client.get(&url).send().await.map_err(|e| format!("Request failed: {}", e))?;
    
    if !resp.status().is_success() {
        return Err(format!("Server returned HTTP {}", resp.status().as_u16()));
    }

    let body = resp.text().await.map_err(|e| e.to_string())?;
    let document = Html::parse_document(&body);
    
    // Select readable blocks
    let text_selectors = Selector::parse("p, h1, h2, h3, h4, h5, h6, li, article, section").unwrap();
    let mut extracted_text = String::new();
    
    for element in document.select(&text_selectors) {
        // Skip elements that are likely navigation, headers or footers
        let class = element.value().attr("class").unwrap_or("").to_lowercase();
        let id = element.value().attr("id").unwrap_or("").to_lowercase();
        if class.contains("nav") || class.contains("footer") || class.contains("menu") || class.contains("header") ||
           id.contains("nav") || id.contains("footer") || id.contains("menu") || id.contains("header") {
            continue;
        }

        let text = element.text().collect::<Vec<_>>().join(" ");
        let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if cleaned.len() > 30 {
            extracted_text.push_str(&cleaned);
            extracted_text.push_str("\n\n");
        }
        
        // Safety limit to prevent massive strings blowing up the LLM context
        if extracted_text.len() > 20000 {
            extracted_text.push_str("\n\n[Content truncated for length...]");
            break;
        }
    }

    if extracted_text.trim().is_empty() {
        return Err("No readable text found on the page.".into());
    }

    Ok(extracted_text.trim().to_string())
}
