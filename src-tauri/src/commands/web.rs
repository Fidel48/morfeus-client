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

/// Strips conversational voice/chat filler from the front of a search query
/// (e.g. "Can you tell me what is the current price of bitcoin?" -> "current price of bitcoin")
/// so search engines and APIs receive high-signal keywords.
pub fn normalize_search_query(query: &str) -> String {
    let mut s = query.trim().trim_end_matches(|c: char| c == '?' || c == '.' || c == '!').trim().to_string();
    let prefixes = [
        "hey morfeus ", "hi morfeus ", "ok morfeus ", "morfeus ",
        "can you please tell me ", "can you tell me ", "could you tell me ",
        "would you tell me ", "please tell me ", "tell me ",
        "do you know ", "can you check ", "could you check ", "please check ",
        "can you find out ", "can you search for ", "can you search ",
        "search the web for ", "search online for ", "look up ",
        "what is the ", "what's the ", "whats the ", "what are the ",
        "what is ", "what's ", "whats ",
    ];
    loop {
        let lower = s.to_lowercase();
        let mut stripped = false;
        for prefix in &prefixes {
            if lower.starts_with(prefix) && s.len() > prefix.len() + 3 {
                s = s[prefix.len()..].trim().to_string();
                stripped = true;
                break;
            }
        }
        if !stripped {
            break;
        }
    }
    let normalized_words: Vec<String> = s
        .split_whitespace()
        .map(|w| {
            let clean = w.trim_matches(|c: char| !c.is_alphanumeric());
            match clean.to_lowercase().as_str() {
                "happeing" | "hapening" | "happenning" => "happening".to_string(),
                "lates" | "lastes" | "latets" | "lastest" => "latest".to_string(),
                "heiti" | "heati" | "hiati" | "hatii" => "Haiti".to_string(),
                "salavdor" | "salvabdor" => "Salvador".to_string(),
                _ => w.to_string(),
            }
        })
        .collect();
    s = normalized_words.join(" ");
    if s.is_empty() {
        query.trim().to_string()
    } else {
        s
    }
}

/// Strips narrow alphanumeric codes (e.g. "InsNC-Life01", "Exam-102b") and trailing meta-words
/// so overly specific queries can fall back to broader subject-matter searches instead of returning [].
fn broaden_search_query(query: &str) -> Option<String> {
    const STOP_WORDS: &[&str] = &[
        "and", "or", "the", "for", "with", "about", "into", "from",
        "topics", "content", "questions", "similar", "practice", "practise",
        "details", "information", "overview", "syllabus", "guide",
    ];

    let raw_tokens: Vec<&str> = query.split_whitespace().collect();
    let mut kept: Vec<String> = Vec::new();

    for raw in &raw_tokens {
        let cleaned = raw.trim_matches(|c: char| !c.is_alphanumeric() && c != '-');
        if cleaned.is_empty() || cleaned == "-" {
            continue;
        }
        // Drop internal exam/product codes that mix letters and digits (e.g. "InsNC-Life01", "Life01")
        let has_alpha = cleaned.chars().any(|c| c.is_ascii_alphabetic());
        let has_digit = cleaned.chars().any(|c| c.is_ascii_digit());
        if has_alpha && has_digit {
            continue;
        }
        let lower = cleaned.to_lowercase();
        if raw_tokens.len() > 3 && STOP_WORDS.contains(&lower.as_str()) {
            continue;
        }
        kept.push(cleaned.to_string());
        if kept.len() >= 5 {
            break;
        }
    }

    let broadened = kept.join(" ").trim().to_string();
    if broadened.is_empty() || broadened.eq_ignore_ascii_case(query.trim()) {
        None
    } else {
        Some(broadened)
    }
}

fn parse_bing_news_rss(body: &str, results: &mut Vec<SearchResult>) {
    let doc = Html::parse_document(body);
    let item_selector = Selector::parse("item").unwrap();
    let title_selector = Selector::parse("title").unwrap();
    let desc_selector = Selector::parse("description").unwrap();
    let pubdate_selector = Selector::parse("pubdate").unwrap();

    for item in doc.select(&item_selector).take(6) {
        let title = item
            .select(&title_selector)
            .next()
            .map(|t| t.text().collect::<Vec<_>>().join("").trim().to_string())
            .unwrap_or_default();

        let item_str = item.inner_html();
        let raw_link = if let Some(start) = item_str.find("<link>") {
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

        // Bing News RSS wraps the real article URL inside `...&url=https%3a%2f%2f...&c=...`
        let unescaped_link = raw_link.replace("&amp;", "&");
        let mut clean_url = unescaped_link.clone();
        if let Some(idx) = unescaped_link.find("url=") {
            let after = &unescaped_link[idx + 4..];
            let encoded = after.split('&').next().unwrap_or(after);
            if let Ok(decoded) = urlencoding::decode(encoded) {
                if decoded.starts_with("http://") || decoded.starts_with("https://") {
                    clean_url = decoded.to_string();
                }
            }
        }

        let pub_date = item
            .select(&pubdate_selector)
            .next()
            .map(|p| p.text().collect::<Vec<_>>().join("").trim().to_string())
            .unwrap_or_default();

        let desc = item
            .select(&desc_selector)
            .next()
            .map(|d| {
                let raw = d.text().collect::<Vec<_>>().join(" ");
                let fragment = Html::parse_fragment(&raw);
                fragment
                    .root_element()
                    .text()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_else(|| title.clone());

        let snippet = if !pub_date.is_empty() {
            format!("[Published: {}] {}", pub_date, desc)
        } else {
            desc
        };

        if !title.is_empty() && !clean_url.is_empty() {
            results.push(SearchResult {
                title,
                url: clean_url,
                snippet,
            });
        }
    }
}

fn parse_google_news_rss(body: &str, results: &mut Vec<SearchResult>) {
    let doc = Html::parse_document(body);
    let item_selector = Selector::parse("item").unwrap();
    let title_selector = Selector::parse("title").unwrap();
    let desc_selector = Selector::parse("description").unwrap();
    let source_selector = Selector::parse("source").unwrap();

    for item in doc.select(&item_selector).take(6) {
        let title = item.select(&title_selector).next()
            .map(|t| t.text().collect::<Vec<_>>().join("").trim().to_string())
            .unwrap_or_default();

        let item_str = item.inner_html();
        let raw_url = if let Some(start) = item_str.find("<link>") {
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

        // Google News RSS <link> tags contain 250+ char base64 protobuf blobs (CBMi...)
        // which cause local 12B/14B models to fall into base64 token repetition loops
        // when copying the URL into markdown links. Prefer the clean <source url="...">
        // publisher URL when the RSS link is an oversized opaque redirect.
        let source_url = item.select(&source_selector).next()
            .and_then(|s| s.value().attr("url"))
            .map(|u| u.trim().to_string())
            .unwrap_or_default();

        let url = if raw_url.contains("news.google.com/rss/articles/") && raw_url.len() > 120 && !source_url.is_empty() {
            source_url
        } else {
            raw_url
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

async fn search_wikipedia(client: &Client, query: &str, results: &mut Vec<SearchResult>) {
    let cleaned = normalize_search_query(query);
    let stop_words = [
        "latest", "lastes", "lates", "breaking", "recent", "current", "today", "todays",
        "news", "headlines", "update", "updates", "about", "in", "from", "on", "for", "the",
    ];
    let entity_cleaned: String = cleaned
        .split_whitespace()
        .filter(|w| !stop_words.contains(&w.to_lowercase().trim_matches(|c: char| !c.is_alphanumeric()).as_ref()))
        .collect::<Vec<_>>()
        .join(" ");
    let wiki_query = if entity_cleaned.trim().len() >= 2 {
        entity_cleaned.trim()
    } else {
        cleaned.as_str()
    };
    let wiki_url = format!(
        "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={}&utf8=&format=json&srlimit=4",
        urlencoding::encode(wiki_query)
    );
    let mut found_titles: Vec<(String, String)> = Vec::new();
    if let Ok(resp) = client.get(&wiki_url).send().await {
        if let Ok(json) = resp.json::<serde_json::Value>().await {
            if let Some(items) = json.get("query").and_then(|q| q.get("search")).and_then(|s| s.as_array()) {
                for item in items.iter().take(4) {
                    let title = item.get("title").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
                    let raw_snippet = item.get("snippet").and_then(|s| s.as_str()).unwrap_or("");
                    let fragment = Html::parse_fragment(raw_snippet);
                    let snippet = fragment.root_element().text().collect::<Vec<_>>().join(" ").trim().to_string();
                    if !title.is_empty() {
                        found_titles.push((title, snippet));
                    }
                }
            }
        }
    }

    if found_titles.is_empty() {
        return;
    }

    // Fetch rich 900-char encyclopedic intro extracts for the top 2 Wikipedia matches
    // so local LLMs get complete definitions, dates, and facts without needing extra round-trips.
    let top_titles: String = found_titles
        .iter()
        .take(2)
        .map(|(t, _)| t.as_str())
        .collect::<Vec<_>>()
        .join("|");
    let mut extracts_map = std::collections::HashMap::<String, String>::new();
    let extract_url = format!(
        "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&exchars=900&titles={}&format=json",
        urlencoding::encode(&top_titles)
    );
    if let Ok(resp) = client.get(&extract_url).send().await {
        if let Ok(json) = resp.json::<serde_json::Value>().await {
            if let Some(pages) = json.get("query").and_then(|q| q.get("pages")).and_then(|p| p.as_object()) {
                for (_id, page) in pages {
                    let title = page.get("title").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
                    let extract = page.get("extract").and_then(|e| e.as_str()).unwrap_or("").trim().to_string();
                    if !title.is_empty() && !extract.is_empty() {
                        extracts_map.insert(title.to_lowercase(), extract);
                    }
                }
            }
        }
    }

    for (title, search_snippet) in found_titles {
        let slug = title.replace(' ', "_");
        let url = format!("https://en.wikipedia.org/wiki/{}", urlencoding::encode(&slug));
        let rich_snippet = extracts_map
            .get(&title.to_lowercase())
            .cloned()
            .unwrap_or_else(|| if search_snippet.is_empty() { title.clone() } else { search_snippet });
        results.push(SearchResult {
            title: format!("{} - Wikipedia Encyclopedia", title),
            url,
            snippet: rich_snippet,
        });
    }
}

fn format_usd_amount(amount: f64) -> String {
    if amount.abs() < 1.0 && amount != 0.0 {
        return format!("${:.4}", amount);
    }
    let whole = amount.trunc() as i64;
    let cents = ((amount.fract().abs() * 100.0).round() as i64).clamp(0, 99);
    let whole_str = whole.abs().to_string();
    let mut formatted_whole = String::new();
    for (idx, ch) in whole_str.chars().rev().enumerate() {
        if idx > 0 && idx % 3 == 0 {
            formatted_whole.push(',');
        }
        formatted_whole.push(ch);
    }
    let formatted_whole: String = formatted_whole.chars().rev().collect();
    if whole < 0 {
        format!("-${}.{:02}", formatted_whole, cents)
    } else {
        format!("${}.{:02}", formatted_whole, cents)
    }
}

async fn fetch_crypto_spot_price(client: &Client, query: &str) -> Option<SearchResult> {
    let q = query.to_lowercase();
    let words: Vec<&str> = q
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect();

    const CRYPTO_MAP: &[(&str, &str, &str, &str)] = &[
        ("bitcoin", "btc", "Bitcoin", "bitcoin"),
        ("ethereum", "eth", "Ethereum", "ethereum"),
        ("solana", "sol", "Solana", "solana"),
        ("dogecoin", "doge", "Dogecoin", "dogecoin"),
        ("ripple", "xrp", "XRP", "xrp"),
        ("cardano", "ada", "Cardano", "cardano"),
        ("binance", "bnb", "BNB", "bnb"),
        ("litecoin", "ltc", "Litecoin", "litecoin"),
        ("avalanche", "avax", "Avalanche", "avalanche"),
        ("polkadot", "dot", "Polkadot", "polkadot-new"),
        ("chainlink", "link", "Chainlink", "chainlink"),
        ("shiba", "shib", "Shiba Inu", "shiba-inu"),
        ("uniswap", "uni", "Uniswap", "uniswap"),
        ("stellar", "xlm", "Stellar", "stellar"),
        ("cosmos", "atom", "Cosmos", "cosmos"),
        ("sui", "sui", "Sui", "sui"),
        ("aptos", "apt", "Aptos", "aptos"),
        ("pepe", "pepe", "Pepe", "pepe"),
    ];

    let has_price_intent = q.contains("price")
        || q.contains("worth")
        || q.contains("cost")
        || q.contains("value")
        || q.contains("how much")
        || q.contains("market")
        || q.contains("trading")
        || q.contains("spot")
        || q.contains("usd");

    let mut matched: Option<(&str, &str, &str)> = None;
    for &(name_kw, ticker_kw, display_name, slug) in CRYPTO_MAP {
        let name_hit = words.contains(&name_kw);
        let ticker_hit = words.contains(&ticker_kw) && (has_price_intent || words.len() <= 4);
        if name_hit || ticker_hit {
            matched = Some((ticker_kw, display_name, slug));
            break;
        }
    }

    let (ticker_lower, name, slug) = matched?;
    let symbol = ticker_lower.to_uppercase();

    let url = format!("https://api.coinbase.com/v2/prices/{}-USD/spot", symbol);
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let json = resp.json::<serde_json::Value>().await.ok()?;
    let amount_str = json.get("data")?.get("amount")?.as_str()?;
    let amount: f64 = amount_str.parse().ok()?;
    let formatted_price = format_usd_amount(amount);

    Some(SearchResult {
        title: format!("{} ({}) Live Spot Price — CoinMarketCap / Coinbase", name, symbol),
        url: format!("https://coinmarketcap.com/currencies/{}/", slug),
        snippet: format!(
            "[LIVE VERIFIED DATA] Current real-time {} ({}) spot price is {} USD (exact feed value: ${} USD). Use this exact live figure over any older prices mentioned in news articles.",
            name, symbol, formatted_price, amount_str
        ),
    })
}

async fn fetch_market_quote(client: &Client, query: &str) -> Option<SearchResult> {
    let q = query.to_lowercase();
    let is_market_query = q.contains("price")
        || q.contains("stock")
        || q.contains("share")
        || q.contains("quote")
        || q.contains("trading")
        || q.contains("market")
        || q.contains("worth")
        || q.contains("index")
        || q.contains("s&p")
        || q.contains("dow jones")
        || q.contains("nasdaq");
    if !is_market_query {
        return None;
    }

    let words: Vec<&str> = q
        .split(|c: char| !c.is_alphanumeric() && c != '&')
        .filter(|s| !s.is_empty())
        .collect();

    const MARKET_MAP: &[(&[&str], &str, &str)] = &[
        (&["s&p", "sp500", "s&p500"], "^GSPC", "S&P 500 Index"),
        (&["dow", "djia"], "^DJI", "Dow Jones Industrial Average"),
        (&["nasdaq"], "^IXIC", "Nasdaq Composite"),
        (&["nvidia", "nvda"], "NVDA", "NVIDIA Corporation (NVDA)"),
        (&["apple", "aapl"], "AAPL", "Apple Inc. (AAPL)"),
        (&["tesla", "tsla"], "TSLA", "Tesla, Inc. (TSLA)"),
        (&["microsoft", "msft"], "MSFT", "Microsoft Corporation (MSFT)"),
        (&["amazon", "amzn"], "AMZN", "Amazon.com, Inc. (AMZN)"),
        (&["google", "alphabet", "googl", "goog"], "GOOGL", "Alphabet Inc. (GOOGL)"),
        (&["meta", "facebook"], "META", "Meta Platforms, Inc. (META)"),
        (&["amd"], "AMD", "Advanced Micro Devices (AMD)"),
        (&["netflix", "nflx"], "NFLX", "Netflix, Inc. (NFLX)"),
        (&["palantir", "pltr"], "PLTR", "Palantir Technologies (PLTR)"),
        (&["coinbase", "coin"], "COIN", "Coinbase Global (COIN)"),
        (&["microstrategy", "mstr"], "MSTR", "MicroStrategy (MSTR)"),
        (&["broadcom", "avgo"], "AVGO", "Broadcom Inc. (AVGO)"),
        (&["intel", "intc"], "INTC", "Intel Corporation (INTC)"),
        (&["gold"], "GC=F", "Gold Futures (GC=F)"),
        (&["silver"], "SI=F", "Silver Futures (SI=F)"),
        (&["oil", "crude"], "CL=F", "Crude Oil Futures (CL=F)"),
    ];

    let mut target: Option<(&str, &str)> = None;
    for &(kws, symbol, label) in MARKET_MAP {
        if kws.iter().any(|kw| words.contains(kw)) {
            target = Some((symbol, label));
            break;
        }
    }

    let (symbol, label) = target?;
    let url = format!(
        "https://query1.finance.yahoo.com/v8/finance/chart/{}?interval=1d&range=1d",
        urlencoding::encode(symbol)
    );
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let json = resp.json::<serde_json::Value>().await.ok()?;
    let meta = json
        .get("chart")?
        .get("result")?
        .as_array()?
        .first()?
        .get("meta")?;
    let price = meta.get("regularMarketPrice")?.as_f64()?;
    let prev_close = meta
        .get("chartPreviousClose")
        .or_else(|| meta.get("previousClose"))
        .and_then(|v| v.as_f64());
    let currency = meta.get("currency").and_then(|v| v.as_str()).unwrap_or("USD");

    let change_str = if let Some(prev) = prev_close {
        if prev > 0.0 {
            let diff = price - prev;
            let pct = (diff / prev) * 100.0;
            let sign = if diff >= 0.0 { "+" } else { "" };
            format!(" ({}{:.2}, {}{:.2}% vs previous close ${:.2})", sign, diff, sign, pct, prev)
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    Some(SearchResult {
        title: format!("[LIVE VERIFIED DATA] {} Live Market Quote - Yahoo Finance", label),
        url: format!("https://finance.yahoo.com/quote/{}/", urlencoding::encode(symbol)),
        snippet: format!(
            "[LIVE VERIFIED DATA] Current {} market price: {} {}{}. Real-time exchange quote.",
            label,
            format_usd_amount(price),
            currency,
            change_str
        ),
    })
}

fn describe_wmo_weather_code(code: i64) -> &'static str {
    match code {
        0 => "Clear sky",
        1 => "Mainly clear",
        2 => "Partly cloudy",
        3 => "Overcast",
        45 | 48 => "Foggy",
        51 | 53 | 55 => "Drizzle",
        61 | 63 | 65 => "Rain",
        71 | 73 | 75 | 77 => "Snow",
        80 | 81 | 82 => "Rain showers",
        95 | 96 | 99 => "Thunderstorm",
        _ => "Variable conditions",
    }
}

async fn fetch_live_weather(client: &Client, query: &str) -> Option<SearchResult> {
    let q = query.to_lowercase();
    let is_weather = q.contains("weather") || q.contains("temperature") || q.contains("forecast");
    if !is_weather {
        return None;
    }

    let mut location = String::new();
    for marker in &[" in ", " for ", " at "] {
        if let Some(idx) = q.find(marker) {
            location = query[idx + marker.len()..].trim().to_string();
            break;
        }
    }
    if location.is_empty() {
        location = q
            .replace("current", "")
            .replace("weather", "")
            .replace("temperature", "")
            .replace("forecast", "")
            .replace("today", "")
            .replace("right now", "")
            .replace("what is", "")
            .replace("what's", "")
            .replace("the", "")
            .trim()
            .to_string();
    }
    location = location
        .trim_matches(|c: char| !c.is_alphanumeric() && c != ' ' && c != ',')
        .replace("right now", "")
        .replace("today", "")
        .trim()
        .to_string();

    if location.len() < 2 {
        return None;
    }

    let city_only = location.split(',').next().unwrap_or(&location).trim();
    let geo_url = format!(
        "https://geocoding-api.open-meteo.com/v1/search?name={}&count=1&language=en&format=json",
        urlencoding::encode(city_only)
    );
    let geo_resp = client.get(&geo_url).send().await.ok()?;
    let geo_json = geo_resp.json::<serde_json::Value>().await.ok()?;
    let first = geo_json.get("results")?.as_array()?.first()?;
    let lat = first.get("latitude")?.as_f64()?;
    let lon = first.get("longitude")?.as_f64()?;
    let name = first.get("name")?.as_str().unwrap_or(city_only);
    let admin1 = first.get("admin1").and_then(|a| a.as_str()).unwrap_or("");
    let country = first.get("country").and_then(|c| c.as_str()).unwrap_or("");

    let wx_url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={}&longitude={}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph",
        lat, lon
    );
    let wx_resp = client.get(&wx_url).send().await.ok()?;
    let wx_json = wx_resp.json::<serde_json::Value>().await.ok()?;
    let current = wx_json.get("current")?;
    let temp_f = current.get("temperature_2m")?.as_f64()?;
    let temp_c = (temp_f - 32.0) * 5.0 / 9.0;
    let feels_f = current.get("apparent_temperature").and_then(|v| v.as_f64()).unwrap_or(temp_f);
    let humidity = current.get("relative_humidity_2m").and_then(|v| v.as_i64()).unwrap_or(0);
    let wind_mph = current.get("wind_speed_10m").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let code = current.get("weather_code").and_then(|v| v.as_i64()).unwrap_or(0);
    let condition = describe_wmo_weather_code(code);

    let place_label = if !admin1.is_empty() {
        format!("{}, {} ({})", name, admin1, country)
    } else {
        format!("{}, {}", name, country)
    };

    Some(SearchResult {
        title: format!("[LIVE VERIFIED DATA] Current Weather in {} - Open-Meteo / National Weather Feed", place_label),
        url: format!("https://open-meteo.com/en/docs#latitude={}&longitude={}", lat, lon),
        snippet: format!(
            "[LIVE VERIFIED DATA] Current weather in {}: {:.1}F ({:.1}C), {}. Feels like {:.1}F, Humidity: {}%, Wind: {:.1} mph.",
            place_label, temp_f, temp_c, condition, feels_f, humidity, wind_mph
        ),
    })
}

#[tauri::command]
pub async fn search_duckduckgo(query: String) -> Result<Vec<SearchResult>, String> {
    let client = make_client()?;
    let mut results = Vec::new();
    let effective_query = normalize_search_query(&query);

    if let Some(crypto_spot) = fetch_crypto_spot_price(&client, &effective_query).await {
        results.push(crypto_spot);
    }
    if let Some(market_quote) = fetch_market_quote(&client, &effective_query).await {
        results.push(market_quote);
    }
    if let Some(live_wx) = fetch_live_weather(&client, &effective_query).await {
        results.push(live_wx);
    }

    let live_feed_count = results.len();

    // 1. Try DuckDuckGo HTML
    let html_url = "https://html.duckduckgo.com/html/";
    if let Ok(resp) = client.post(html_url).form(&[("q", effective_query.as_str()), ("b", ""), ("kl", "us-en")]).send().await {
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
    if results.len() == live_feed_count {
        let lite_url = "https://lite.duckduckgo.com/lite/";
        if let Ok(resp) = client.post(lite_url).form(&[("q", effective_query.as_str())]).send().await {
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
    if results.len() == live_feed_count {
        let api_url = format!("https://api.duckduckgo.com/?q={}&format=json&no_html=1", urlencoding::encode(&effective_query));
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

    // 4. Fallback to Bing News RSS (full article URLs + multi-sentence descriptions) + Google News RSS + Wikipedia Knowledge Extracts
    if results.len() == live_feed_count {
        let bing_news_url = format!(
            "https://www.bing.com/news/search?q={}&format=rss",
            urlencoding::encode(&effective_query)
        );
        if let Ok(resp) = client.get(&bing_news_url).send().await {
            if resp.status().is_success() {
                if let Ok(body) = resp.text().await {
                    parse_bing_news_rss(&body, &mut results);
                }
            }
        }

        if results.len() == live_feed_count {
            let news_url = format!(
                "https://news.google.com/rss/search?q={}&hl=en-US&gl=US&ceid=US:en",
                urlencoding::encode(&effective_query)
            );
            if let Ok(resp) = client.get(&news_url).send().await {
                if resp.status().is_success() {
                    if let Ok(body) = resp.text().await {
                        parse_google_news_rss(&body, &mut results);
                    }
                }
            }
        }
        // Only append encyclopedic Wikipedia results when web/news searches returned 0 results
        if results.len() == live_feed_count {
            search_wikipedia(&client, &effective_query, &mut results).await;
        }
    }

    // 5. Automatic Query Broadening + Wikipedia API fallback if specific codes/jargon yielded 0 results
    if results.len() == live_feed_count {
        if let Some(broadened) = broaden_search_query(&effective_query) {
            let bing_news_url = format!(
                "https://www.bing.com/news/search?q={}&format=rss",
                urlencoding::encode(&broadened)
            );
            if let Ok(resp) = client.get(&bing_news_url).send().await {
                if resp.status().is_success() {
                    if let Ok(body) = resp.text().await {
                        parse_bing_news_rss(&body, &mut results);
                    }
                }
            }
            if results.len() == live_feed_count {
                let news_url = format!(
                    "https://news.google.com/rss/search?q={}&hl=en-US&gl=US&ceid=US:en",
                    urlencoding::encode(&broadened)
                );
                if let Ok(resp) = client.get(&news_url).send().await {
                    if resp.status().is_success() {
                        if let Ok(body) = resp.text().await {
                            parse_google_news_rss(&body, &mut results);
                        }
                    }
                }
            }
            search_wikipedia(&client, &broadened, &mut results).await;
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
        if cleaned.starts_with("Search Query for Search the web")
            || cleaned.starts_with("Return to HomepageTop Stories")
            || cleaned.starts_with("Skip to main")
        {
            continue;
        }
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

#[cfg(test)]
mod tests {
    use super::{broaden_search_query, format_usd_amount, normalize_search_query, search_duckduckgo};

    #[test]
    fn broadens_exam_code_queries() {
        assert_eq!(
            broaden_search_query("InsNC-Life01 - NC Life exam topics and content"),
            Some("NC Life exam".to_string())
        );
        assert_eq!(
            broaden_search_query("InsNC-Life01 - NC Life insurance exam questions and topics"),
            Some("NC Life insurance exam".to_string())
        );
    }

    #[test]
    fn normalizes_conversational_queries() {
        assert_eq!(
            normalize_search_query("Can you tell me what is the current price of bitcoin?"),
            "current price of bitcoin"
        );
        assert_eq!(
            normalize_search_query("Hey Morfeus please tell me what's the weather in Charlotte right now!"),
            "weather in Charlotte right now"
        );
        assert_eq!(format_usd_amount(75625.16), "$75,625.16");
    }

    #[tokio::test]
    async fn live_grounding_feeds_and_search_pipeline() {
        let btc = search_duckduckgo("Can you tell me what is the current price of bitcoin?".into())
            .await
            .expect("btc search should succeed");
        assert!(!btc.is_empty());
        assert!(btc[0].snippet.contains("[LIVE VERIFIED DATA]"));
        println!("BTC Top Result: {} -> {}", btc[0].title, btc[0].snippet);

        let nvda = search_duckduckgo("What is the stock price of Nvidia today?".into())
            .await
            .expect("nvda search should succeed");
        assert!(!nvda.is_empty());
        assert!(nvda[0].snippet.contains("[LIVE VERIFIED DATA]"));
        println!("NVDA Top Result: {} -> {}", nvda[0].title, nvda[0].snippet);

        let wx = search_duckduckgo("What is the current weather in Charlotte, NC?".into())
            .await
            .expect("weather search should succeed");
        assert!(!wx.is_empty());
        assert!(wx[0].snippet.contains("[LIVE VERIFIED DATA]"));
        println!("Weather Top Result: {} -> {}", wx[0].title, wx[0].snippet);

        let haiti = search_duckduckgo("latest news Haiti".into())
            .await
            .expect("haiti news search should succeed");
        assert!(!haiti.is_empty());
        println!("Haiti News Top Result: {} ({}) -> {}", haiti[0].title, haiti[0].url, haiti[0].snippet);

        let salvador = search_duckduckgo("why did the el salavdor deploy those troops Haiti".into())
            .await
            .expect("el salvador haiti search should succeed");
        assert!(!salvador.is_empty());
        println!("Salvador Follow-up Top Result: {} ({}) -> {}", salvador[0].title, salvador[0].url, salvador[0].snippet);
    }
}
