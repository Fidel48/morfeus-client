use std::fs;
use std::io::{Read, Cursor};
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tauri::command;

/// Extract plain text from a .docx file (which is a ZIP of XML files).
fn extract_docx_text(path: &str) -> Result<String, String> {
    let data = fs::read(path).map_err(|e| format!("Cannot read file: {}", e))?;
    let cursor = Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| format!("Not a valid .docx file: {}", e))?;

    let mut xml_content = String::new();
    {
        let mut doc = archive.by_name("word/document.xml")
            .map_err(|_| "Could not find word/document.xml inside the .docx file.".to_string())?;
        doc.read_to_string(&mut xml_content)
            .map_err(|e| format!("Failed to read document XML: {}", e))?;
    }

    // Extract text content by reading XML events
    let mut text = String::new();
    let mut reader = quick_xml::Reader::from_str(&xml_content);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(quick_xml::events::Event::End(ref e)) => {
                if e.name().as_ref() == b"w:p" {
                    text.push('\n');
                }
            }
            Ok(quick_xml::events::Event::Text(ref e)) => {
                if let Ok(s) = std::str::from_utf8(e.as_ref()) {
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        text.push_str(trimmed);
                        text.push(' ');
                    }
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(text.trim().to_string())
}

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

    let content = if extension == "pdf" {
        pdf_extract::extract_text(&path)
            .map_err(|e| format!("Failed to parse PDF: {}", e))?
    } else if extension == "docx" {
        extract_docx_text(&path)?
    } else {
        fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read file (might be binary): {}", e))?
    };

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

// ─── File search ────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug)]
pub struct SearchMatch {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// Recursively search for files/folders matching a name pattern inside a root directory.
/// Returns up to 50 matches. Case-insensitive.
#[command]
pub async fn search_files(query: String, root: Option<String>) -> Result<Vec<SearchMatch>, String> {
    let search_root = if let Some(r) = root {
        PathBuf::from(r)
    } else {
        home_dir_path().ok_or("Cannot determine home directory".to_string())?
    };

    if !search_root.exists() {
        return Err(format!("Root path does not exist: {}", search_root.display()));
    }

    let query_lower = query.to_lowercase();
    let mut matches = Vec::new();

    walk_dir(&search_root, &query_lower, &mut matches, 0);

    Ok(matches)
}

fn walk_dir(dir: &Path, query: &str, matches: &mut Vec<SearchMatch>, depth: usize) {
    // Cap recursion depth and result count
    if depth > 5 || matches.len() >= 50 {
        return;
    }

    let read_dir = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };

    for entry in read_dir.filter_map(|e| e.ok()) {
        let file_name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden dirs (but don't skip hidden files that match)
        let is_dir = entry.path().is_dir();
        if is_dir && file_name.starts_with('.') {
            continue;
        }

        // Check for match
        if file_name.to_lowercase().contains(query) {
            matches.push(SearchMatch {
                name: file_name.clone(),
                path: entry.path().to_string_lossy().to_string(),
                is_dir,
            });
        }

        // Recurse into directories
        if is_dir && matches.len() < 50 {
            walk_dir(&entry.path(), query, matches, depth + 1);
        }
    }
}
