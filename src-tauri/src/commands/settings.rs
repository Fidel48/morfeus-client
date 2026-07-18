use anyhow::Result;
use tauri::{AppHandle, Manager};
use crate::models::AppSettings;

fn load_settings(app: &AppHandle) -> Result<AppSettings> {
    let store_path = app.path().app_data_dir()?.join("morfeus_settings.json");

    if store_path.exists() {
        let content = std::fs::read_to_string(&store_path)?;
        let settings: AppSettings = serde_json::from_str(&content)
            .unwrap_or_default();
        Ok(settings)
    } else {
        Ok(AppSettings::default())
    }
}

fn save_settings_to_disk(app: &AppHandle, settings: &AppSettings) -> Result<()> {
    let app_data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&app_data_dir)?;
    let store_path = app_data_dir.join("morfeus_settings.json");
    let content = serde_json::to_string_pretty(settings)?;
    std::fs::write(&store_path, content)?;
    Ok(())
}

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> Result<AppSettings, String> {
    load_settings(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    save_settings_to_disk(&app, &settings).map_err(|e| e.to_string())
}
