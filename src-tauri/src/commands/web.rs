use reqwest::Client;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct SearchResult {
    title: String,
    url: String,
    snippet: String,
}

fn make_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15")
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

#[tauri::command]
pub async fn search_duckduckgo(query: String) -> Result<Vec<SearchResult>, String> {
    let client = make_client()?;
    let mut results = Vec::new();

    // 1. Try DuckDuckGo HTML
    let html_url = "https://html.duckduckgo.com/html/";
    if let Ok(resp) = client.post(html_url).form(&[("q", query.as_str()), ("b", ""), ("kl", "us-en")]).send().await {
        if resp.status() == reqwest::StatusCode::OK {
            if let Ok(body) = resp.text().await {
                if !body.contains("anomaly-modal") {
                    let document = Html::parse_document(&body);
                    let result_selector = Selector::parse(".result").unwrap();
                    let title_selector = Selector::parse(".result__title .result__a, a.result__a").unwrap();
                    let snippet_selector = Selector::parse(".result__snippet, .result__body").unwrap();

                    for element in document.select(&result_selector).take(6) {
                        if let Some(title_el) = element.select(&title_selector).next() {
                            let title = title_el.text().collect::<Vec<_>>().join("").trim().to_string();
                            let href = title_el.value().attr("href").unwrap_or("").to_string();
                            
                            let mut url = href.clone();
                            if url.starts_with("//duckduckgo.com/l/?uddg=") {
                                if let Some(encoded) = url.split("uddg=").nth(1) {
                                    if let Some(clean) = encoded.split('&').next() {
                                        if let Ok(decoded) = urlencoding::decode(clean) {
                                            url = decoded.to_string();
                                        }
                                    }
                                }
                            } else if url.starts_with('/') {
                                url = format!("https://duckduckgo.com{}", url);
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
                }
            }
        }
    }

    // 2. Fallback to DuckDuckGo Lite if HTML gave 0 results
    if results.is_empty() {
        let lite_url = "https://lite.duckduckgo.com/lite/";
        if let Ok(resp) = client.post(lite_url).form(&[("q", query.as_str())]).send().await {
            if resp.status() == reqwest::StatusCode::OK {
                if let Ok(body) = resp.text().await {
                    if !body.contains("anomaly-modal") {
                        let document = Html::parse_document(&body);
                        let link_selector = Selector::parse("a.result-link").unwrap();
                        let snippet_selector = Selector::parse("td.result-snippet").unwrap();

                        let links: Vec<_> = document.select(&link_selector).collect();
                        let snippets: Vec<_> = document.select(&snippet_selector).collect();

                        for (i, link_el) in links.iter().take(6).enumerate() {
                            let title = link_el.text().collect::<Vec<_>>().join("").trim().to_string();
                            let url = link_el.value().attr("href").unwrap_or("").to_string();
                            let snippet = if i < snippets.len() {
                                snippets[i].text().collect::<Vec<_>>().join("").trim().to_string()
                            } else {
                                String::new()
                            };

                            if !title.is_empty() && !url.is_empty() {
                                results.push(SearchResult { title, url, snippet });
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Fallback to DuckDuckGo Instant Answer API if still empty
    if results.is_empty() {
        let api_url = format!("https://api.duckduckgo.com/?q={}&format=json&no_html=1", urlencoding::encode(&query));
        if let Ok(resp) = client.get(&api_url).send().await {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(abstract_text) = json.get("AbstractText").and_then(|v| v.as_str()) {
                    if !abstract_text.is_empty() {
                        let source_url = json.get("AbstractURL").and_then(|v| v.as_str()).unwrap_or("https://duckduckgo.com");
                        let source_title = json.get("Heading").and_then(|v| v.as_str()).unwrap_or("Search Result");
                        results.push(SearchResult {
                            title: source_title.to_string(),
                            url: source_url.to_string(),
                            snippet: abstract_text.to_string(),
                        });
                    }
                }
                if let Some(topics) = json.get("RelatedTopics").and_then(|v| v.as_array()) {
                    for topic in topics.iter().take(5) {
                        if let (Some(text), Some(url)) = (
                            topic.get("Text").and_then(|t| t.as_str()),
                            topic.get("FirstURL").and_then(|u| u.as_str()),
                        ) {
                            if !text.is_empty() && !url.is_empty() {
                                results.push(SearchResult {
                                    title: text.chars().take(80).collect::<String>(),
                                    url: url.to_string(),
                                    snippet: text.to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // 4. Fallback to Google News RSS if DuckDuckGo gave 0 results (e.g. anti-bot anomaly)
    if results.is_empty() {
        let news_url = format!("https://news.google.com/rss/search?q={}&hl=en-US&gl=US&ceid=US:en", urlencoding::encode(&query));
        if let Ok(resp) = client.get(&news_url).send().await {
            if resp.status().is_success() {
                if let Ok(body) = resp.text().await {
                    let doc = Html::parse_document(&body);
                    let item_selector = Selector::parse("item").unwrap();
                    let title_selector = Selector::parse("title").unwrap();
                    let desc_selector = Selector::parse("description").unwrap();

                    for item in doc.select(&item_selector).take(6) {
                        let title = item.select(&title_selector).next()
                            .map(|t| t.text().collect::<Vec<_>>().join("").trim().to_string())
                            .unwrap_or_default();

                        let item_str = item.inner_html();
                        let url = if let Some(start) = item_str.find("<link>") {
                            let rest = &item_str[start + 6..];
                            if let Some(end) = rest.find("</link>") {
                                rest[..end].trim().to_string()
                            } else if let Some(end) = rest.find('<') {
                                rest[..end].trim().to_string()
                            } else {
                                String::new()
                            }
                        } else {
                            String::new()
                        };

                        let snippet = item.select(&desc_selector).next()
                            .map(|d| {
                                let raw = d.text().collect::<Vec<_>>().join(" ");
                                let fragment = Html::parse_fragment(&raw);
                                fragment.root_element().text().collect::<Vec<_>>().join(" ").trim().to_string()
                            })
                            .unwrap_or_else(|| title.clone());

                        if !title.is_empty() && !url.is_empty() {
                            results.push(SearchResult { title, url, snippet });
                        }
                    }
                }
            }
        }
    }

    if results.is_empty() {
        return Err(format!("No search results found for query: '{}'. Please try a simpler search term.", query));
    }

    Ok(results)
}

#[tauri::command]
pub async fn fetch_webpage(url: String) -> Result<String, String> {
    let client = make_client()?;
    let resp = client.get(&url).send().await.map_err(|e| format!("Request failed: {}", e))?;
    
    if !resp.status().is_success() {
        return Ok(format!("[Webpage Notice]: Could not read full page at {} (HTTP {}). Please answer using the search snippets provided by web_search.", url, resp.status().as_u16()));
    }

    let body = resp.text().await.map_err(|e| e.to_string())?;
    let document = Html::parse_document(&body);
    
    // Extract page title
    let title_selector = Selector::parse("title").unwrap();
    let page_title = document
        .select(&title_selector)
        .next()
        .map(|t| t.text().collect::<Vec<_>>().join("").trim().to_string())
        .unwrap_or_default();

    // Select readable content blocks (paragraphs, headings, list items)
    // We avoid selecting container elements like 'article' or 'section' directly to prevent duplicate nested text
    let text_selectors = Selector::parse("h1, h2, h3, h4, p, li").unwrap();
    let mut extracted_text = String::new();
    let mut seen_snippets = std::collections::HashSet::new();

    if !page_title.is_empty() {
        extracted_text.push_str(&format!("Article Title: {}\n\n", page_title));
    }
    
    for element in document.select(&text_selectors) {
        // Skip elements that are likely navigation, headers, footers, ads, or cookie banners
        let class = element.value().attr("class").unwrap_or("").to_lowercase();
        let id = element.value().attr("id").unwrap_or("").to_lowercase();
        if class.contains("nav") || class.contains("footer") || class.contains("menu") || class.contains("header") ||
           class.contains("sidebar") || class.contains("comment") || class.contains("cookie") || class.contains("banner") ||
           class.contains("popup") || class.contains("modal") || class.contains("ad-") || class.contains("subscribe") ||
           id.contains("nav") || id.contains("footer") || id.contains("menu") || id.contains("header") ||
           id.contains("sidebar") || id.contains("comment") || id.contains("cookie") || id.contains("banner") {
            continue;
        }

        let text = element.text().collect::<Vec<_>>().join(" ");
        let cleaned = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if cleaned.len() > 30 {
            // Deduplicate lede/meta repetition
            let first_words = cleaned.chars().take(50).collect::<String>();
            if !seen_snippets.contains(&first_words) {
                seen_snippets.insert(first_words);
                extracted_text.push_str(&cleaned);
                extracted_text.push_str("\n\n");
            }
        }
        
        // Safety limit to prevent massive strings blowing up the LLM context (15,000 chars is ~3,750 tokens)
        if extracted_text.len() > 15000 {
            extracted_text.push_str("\n\n[Content truncated for length...]");
            break;
        }
    }

    if extracted_text.trim().is_empty() {
        return Err("No readable text found on the page.".into());
    }

    Ok(extracted_text.trim().to_string())
}
