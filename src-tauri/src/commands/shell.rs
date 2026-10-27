use std::process::Command;
use std::io::Write;
use tempfile::NamedTempFile;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct RunResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub success: bool,
}

/// Detect the Python binary available on this system (python3 first, then python).
fn find_python() -> Option<String> {
    for candidate in &["python3", "python"] {
        if let Ok(output) = Command::new(candidate).arg("--version").output() {
            if output.status.success() || !output.stderr.is_empty() {
                return Some(candidate.to_string());
            }
        }
    }
    None
}

/// Install one or more Python packages via pip.
/// packages is a space-separated list like "requests pandas lxml".
#[tauri::command]
pub async fn install_python_packages(packages: String) -> Result<RunResult, String> {
    let python = find_python()
        .ok_or_else(|| "Python is not installed or not found on PATH.".to_string())?;

    // Use python -m pip to ensure we use the pip tied to the detected Python binary
    let pkg_list: Vec<&str> = packages.split_whitespace().collect();
    if pkg_list.is_empty() {
        return Err("No packages specified.".to_string());
    }

    let mut cmd = Command::new(&python);
    cmd.arg("-m").arg("pip").arg("install");
    for pkg in &pkg_list {
        cmd.arg(pkg);
    }

    let output = cmd.output()
        .map_err(|e| format!("Failed to run pip: {}", e))?;

    Ok(RunResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
        success: output.status.success(),
    })
}


/// Run an inline Python code snippet.
/// The code is written to a temporary .py file and executed.
/// Returns stdout, stderr, and exit code.
#[tauri::command]
pub async fn run_python_code(code: String) -> Result<RunResult, String> {
    let python = find_python()
        .ok_or_else(|| "Python is not installed or not found on PATH. Please install Python 3 from https://www.python.org/downloads/".to_string())?;

    // Write code to a named temp file
    let mut tmp = NamedTempFile::with_suffix(".py")
        .map_err(|e| format!("Failed to create temp file: {}", e))?;
    tmp.write_all(code.as_bytes())
        .map_err(|e| format!("Failed to write temp script: {}", e))?;
    tmp.flush().map_err(|e| format!("Failed to flush temp file: {}", e))?;

    let path = tmp.path().to_string_lossy().to_string();

    run_python_file_inner(&python, &path).await
}

/// Run a Python script at a given absolute file path.
#[tauri::command]
pub async fn run_python_file(path: String) -> Result<RunResult, String> {
    let python = find_python()
        .ok_or_else(|| "Python is not installed or not found on PATH. Please install Python 3 from https://www.python.org/downloads/".to_string())?;

    run_python_file_inner(&python, &path).await
}

async fn run_python_file_inner(python: &str, path: &str) -> Result<RunResult, String> {
    let output = Command::new(python)
        .arg(path)
        .output()
        .map_err(|e| format!("Failed to execute Python: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code().unwrap_or(-1);
    let success = output.status.success();

    Ok(RunResult {
        stdout,
        stderr,
        exit_code,
        success,
    })
}

/// Execute a raw terminal command.
/// Uses `sh -c` on Unix and `cmd.exe /c` on Windows.
/// If `cwd` is provided (and non-empty), the command runs in that directory
/// (used by Agent Coder to run inside the selected project).
#[tauri::command]
pub async fn run_terminal_command(command: String, cwd: Option<String>) -> Result<RunResult, String> {
    #[cfg(target_os = "windows")]
    let mut cmd = Command::new("cmd");
    #[cfg(target_os = "windows")]
    cmd.arg("/C").arg(&command);

    #[cfg(not(target_os = "windows"))]
    let mut cmd = Command::new("sh");
    #[cfg(not(target_os = "windows"))]
    cmd.arg("-c").arg(&command);

    if let Some(dir) = cwd.as_deref().filter(|d| !d.trim().is_empty()) {
        if !std::path::Path::new(dir).is_dir() {
            return Err(format!("Working directory does not exist: {}", dir));
        }
        cmd.current_dir(dir);
    }

    let output = cmd.output()
        .map_err(|e| format!("Failed to execute command: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code().unwrap_or(-1);
    let success = output.status.success();

    Ok(RunResult {
        stdout,
        stderr,
        exit_code,
        success,
    })
}
