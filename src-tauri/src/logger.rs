use anyhow::Result;
use chrono::Local;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn get_log_dir(app: &AppHandle) -> Result<PathBuf> {
    let log_dir = app.path().app_data_dir()?.join("logs");
    if !log_dir.exists() {
        fs::create_dir_all(&log_dir)?;
    }
    Ok(log_dir)
}

fn get_log_file_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(get_log_dir(app)?.join("morfeus.log"))
}

pub fn log_to_file(app: &AppHandle, level: &str, message: &str) -> Result<()> {
    let log_file = get_log_file_path(app)?;

    // Check size limit: 5MB
    if log_file.exists() {
        if let Ok(metadata) = fs::metadata(&log_file) {
            if metadata.len() > 5 * 1024 * 1024 {
                let backup = get_log_dir(app)?.join("morfeus.log.old");
                let _ = fs::rename(&log_file, backup);
            }
        }
    }

    let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S");
    let line = format!("[{}] [{}] {}\n", timestamp, level.to_uppercase(), message);

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)?;

    file.write_all(line.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub async fn append_system_log(app: AppHandle, level: String, message: String) -> Result<(), String> {
    log_to_file(&app, &level, &message).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_system_logs(app: AppHandle) -> Result<Vec<String>, String> {
    let log_file = get_log_file_path(&app).map_err(|e| e.to_string())?;

    if !log_file.exists() {
        return Ok(vec!["No log file found yet.".to_string()]);
    }

    let file = fs::File::open(&log_file).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    let lines: Vec<String> = reader.lines().filter_map(|l| l.ok()).collect();
    
    // Return last 200 lines
    let start = if lines.len() > 200 { lines.len() - 200 } else { 0 };
    Ok(lines[start..].to_vec())
}

#[tauri::command]
pub async fn open_log_folder(app: AppHandle) -> Result<(), String> {
    let dir = get_log_dir(&app).map_err(|e| e.to_string())?;
    let path_str = dir.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path_str)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path_str)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path_str)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}
