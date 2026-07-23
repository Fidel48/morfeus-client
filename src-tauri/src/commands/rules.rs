use std::fs;
use std::path::Path;
use tauri::command;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct ProjectRule {
    pub file_name: String,
    pub path: String,
    pub content: String,
}

/// Scans a workspace folder or file parent folder for project-level rules (.morfeusrules, .cursorrules, .morfeus/rules/*.md, .cursor/rules/*.md)
#[command]
pub async fn find_project_rules(workspace_path: String) -> Result<Vec<ProjectRule>, String> {
    let target_path = Path::new(&workspace_path);
    if !target_path.exists() {
        return Ok(vec![]);
    }

    let mut current = if target_path.is_file() {
        target_path.parent().unwrap_or(target_path)
    } else {
        target_path
    };

    // Traverse upwards up to 5 levels to find the project root (e.g. where .git or .cursorrules is)
    let mut root = current;
    for _ in 0..5 {
        if current.join(".git").exists() 
            || current.join(".cursorrules").exists() 
            || current.join(".morfeusrules").exists()
            || current.join("package.json").exists()
            || current.join("Cargo.toml").exists() 
        {
            root = current;
            break;
        }
        if let Some(parent) = current.parent() {
            current = parent;
        } else {
            break;
        }
    }

    let mut rules = Vec::new();

    // Single-file rule names
    let rule_filenames = [".morfeusrules", ".cursorrules", "morfeusrules.md", "cursorrules.md"];
    for filename in &rule_filenames {
        let rule_path = root.join(filename);
        if rule_path.is_file() {
            if let Ok(content) = fs::read_to_string(&rule_path) {
                if !content.trim().is_empty() {
                    rules.push(ProjectRule {
                        file_name: filename.to_string(),
                        path: rule_path.to_string_lossy().to_string(),
                        content,
                    });
                }
            }
        }
    }

    // Directory-based rules: .morfeus/rules/ and .cursor/rules/
    let rule_dirs = [root.join(".morfeus").join("rules"), root.join(".cursor").join("rules")];
    for dir in &rule_dirs {
        if dir.is_dir() {
            if let Ok(entries) = fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        let is_md = path.extension().and_then(|ext| ext.to_str()) == Some("md")
                            || path.extension().and_then(|ext| ext.to_str()) == Some("txt");
                        if is_md {
                            if let Ok(content) = fs::read_to_string(&path) {
                                if !content.trim().is_empty() {
                                    rules.push(ProjectRule {
                                        file_name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                                        path: path.to_string_lossy().to_string(),
                                        content,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(rules)
}
