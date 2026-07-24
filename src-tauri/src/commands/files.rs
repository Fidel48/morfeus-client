use std::fs;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
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

// ─── Directory Entry ──────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size_bytes: Option<u64>,
    pub extension: Option<String>,
}

/// List the contents of a directory. Returns entries sorted: folders first, then files.
#[command]
pub async fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let dir = Path::new(&path);

    if !dir.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !dir.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let read_dir = fs::read_dir(dir).map_err(|e| format!("Cannot read directory: {}", e))?;

    let mut entries: Vec<DirEntry> = read_dir
        .filter_map(|res| res.ok())
        .filter_map(|entry| {
            let file_name = entry.file_name().to_string_lossy().to_string();
            // Skip hidden files (start with .)
            if file_name.starts_with('.') {
                return None;
            }
            let full_path = entry.path().to_string_lossy().to_string();
            let is_dir = entry.path().is_dir();
            let metadata = entry.metadata().ok();
            let size_bytes = metadata.as_ref().map(|m| m.len());
            let extension = if !is_dir {
                entry.path()
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|s| s.to_lowercase())
            } else {
                None
            };

            Some(DirEntry {
                name: file_name,
                path: full_path,
                is_dir,
                size_bytes,
                extension,
            })
        })
        .collect();

    // Sort: directories first, then alphabetical
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    // Safety cap: don't send 10,000 entries to the LLM
    if entries.len() > 200 {
        entries.truncate(200);
    }

    Ok(entries)
}

// ─── Special directories ──────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug)]
pub struct SpecialDirs {
    pub home: Option<String>,
    pub downloads: Option<String>,
    pub documents: Option<String>,
    pub desktop: Option<String>,
}

/// Returns platform-aware paths to common user directories (Home, Downloads, etc.)
/// Works cross-platform on macOS and Windows.
#[command]
pub async fn get_special_dirs() -> SpecialDirs {
    let home = home_dir_path();

    let to_str = |p: Option<PathBuf>| p.map(|pb| pb.to_string_lossy().to_string());

    SpecialDirs {
        downloads: to_str(home.as_ref().map(|h| h.join("Downloads"))
            .filter(|p| p.exists())),
        documents: to_str(home.as_ref().map(|h| h.join("Documents"))
            .filter(|p| p.exists())),
        desktop: to_str(home.as_ref().map(|h| h.join("Desktop"))
            .filter(|p| p.exists())),
        home: to_str(home),
    }
}

fn home_dir_path() -> Option<PathBuf> {
    // USERPROFILE on Windows, HOME on macOS/Linux
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(PathBuf::from)
}
