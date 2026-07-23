use yt_transcript_rs::api::YouTubeTranscriptApi;

/// Extract video ID from a YouTube URL (handles youtu.be, watch?v=, etc.)
fn extract_video_id(url: &str) -> Option<String> {
    // Handle youtu.be/VIDEO_ID
    if let Some(pos) = url.find("youtu.be/") {
        let rest = &url[pos + 9..];
        let id = rest.split(&['?', '&', '#'][..]).next()?;
        if !id.is_empty() {
            return Some(id.to_string());
        }
    }

    // Handle youtube.com/watch?v=VIDEO_ID
    if url.contains("youtube.com") {
        if let Some(pos) = url.find("v=") {
            let rest = &url[pos + 2..];
            let id = rest.split(&['&', '#'][..]).next()?;
            if !id.is_empty() {
                return Some(id.to_string());
            }
        }
        // Handle youtube.com/embed/VIDEO_ID
        if let Some(pos) = url.find("/embed/") {
            let rest = &url[pos + 7..];
            let id = rest.split(&['?', '&', '#'][..]).next()?;
            if !id.is_empty() {
                return Some(id.to_string());
            }
        }
        // Handle youtube.com/shorts/VIDEO_ID
        if let Some(pos) = url.find("/shorts/") {
            let rest = &url[pos + 8..];
            let id = rest.split(&['?', '&', '#'][..]).next()?;
            if !id.is_empty() {
                return Some(id.to_string());
            }
        }
    }

    None
}

#[tauri::command]
pub async fn read_youtube_transcript(url: String) -> Result<String, String> {
    let video_id = extract_video_id(&url)
        .ok_or_else(|| format!("Could not extract a YouTube video ID from URL: {}", url))?;

    let api = YouTubeTranscriptApi::new(None, None, None)
        .map_err(|e| format!("Failed to initialize YouTube API: {}", e))?;

    // Try English first, then fall back to any available language
    let languages = &["en", "en-US", "en-GB"];
    let transcript = api
        .fetch_transcript(&video_id, languages, false)
        .await
        .map_err(|e| format!("Could not retrieve transcript: {}. The video may not have captions enabled.", e))?;

    // Combine all transcript snippets into a single readable text block
    let full_text = transcript.snippets
        .iter()
        .map(|s| s.text.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    if full_text.is_empty() {
        return Err("Transcript was found but contained no text.".to_string());
    }

    // Safety limit to avoid blowing up the context window
    let capped = if full_text.len() > 30_000 {
        format!("{}\n\n[Transcript truncated for length...]", &full_text[..30_000])
    } else {
        full_text
    };

    Ok(format!(
        "YouTube Video Transcript (ID: {}):\n\n{}",
        video_id, capped
    ))
}
