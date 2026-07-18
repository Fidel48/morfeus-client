use std::fs;
use std::path::Path;
use tauri::command;

#[command]
pub async fn parse_local_file(path: String) -> Result<String, String> {
    let file_path = Path::new(&path);
    
    if !file_path.exists() {
        return Err("File does not exist".into());
    }

    let extension = file_path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mut content = String::new();

    if extension == "pdf" {
        // Use pdf-extract
        match pdf_extract::extract_text(&path) {
            Ok(text) => {
                content = text;
            }
            Err(e) => {
                return Err(format!("Failed to parse PDF: {}", e));
            }
        }
    } else {
        // Attempt to read as UTF-8 string
        match fs::read_to_string(&path) {
            Ok(text) => {
                content = text;
            }
            Err(e) => {
                return Err(format!("Failed to read file (might be binary or unsupported format): {}", e));
            }
        }
    }

    // Clean up whitespace a bit to save context
    let cleaned_content = content.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n");

    if cleaned_content.is_empty() {
        return Err("File contains no readable text. If this is a PDF, it might be a scanned image or lack a text layer (OCR is not yet supported).".into());
    }

    // Truncate if too long (safety limit, ~15k chars for local LLMs)
    if cleaned_content.len() > 15000 {
        let mut truncated = cleaned_content.chars().take(15000).collect::<String>();
        truncated.push_str("\n\n[...Content truncated due to size limits...]");
        Ok(truncated)
    } else {
        Ok(cleaned_content)
    }
}
