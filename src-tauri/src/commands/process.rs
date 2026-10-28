use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{command, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};
use serde::Serialize;
use std::process::Stdio;

const MAX_LOG_LINES: usize = 1000;

#[derive(Debug, Serialize, Clone)]
pub struct ProcessSummary {
    pub id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub running: bool,
    pub pid: Option<u32>,
    pub started_at: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct ProcessLogs {
    pub id: String,
    pub running: bool,
    pub lines: Vec<String>,
}

struct ActiveProcess {
    command: String,
    cwd: Option<String>,
    running: Arc<AtomicBool>,
    pid: Option<u32>,
    started_at: u64,
    logs: Arc<Mutex<Vec<String>>>,
    kill_tx: mpsc::Sender<()>,
}

#[derive(Clone, Default)]
pub struct ProcessState {
    processes: Arc<Mutex<HashMap<String, ActiveProcess>>>,
}

#[command]
pub async fn spawn_background_process(
    id: String,
    command: String,
    cwd: Option<String>,
    state: State<'_, ProcessState>,
) -> Result<ProcessSummary, String> {
    let mut procs = state.processes.lock().await;

    // If a process with this ID is already running, return an error
    if let Some(existing) = procs.get(&id) {
        if existing.running.load(Ordering::SeqCst) {
            return Err(format!("Process '{}' is already running (PID {:?}). Stop it first with kill_background_process.", id, existing.pid));
        }
    }

    #[cfg(target_os = "windows")]
    let mut cmd = Command::new("cmd");
    #[cfg(target_os = "windows")]
    cmd.arg("/C").arg(&command);

    #[cfg(not(target_os = "windows"))]
    let mut cmd = Command::new("sh");
    #[cfg(not(target_os = "windows"))]
    cmd.arg("-c").arg(&command);

    if let Some(ref dir) = cwd {
        if !dir.trim().is_empty() {
            if !std::path::Path::new(dir).is_dir() {
                return Err(format!("Working directory does not exist: {}", dir));
            }
            cmd.current_dir(dir);
        }
    }

    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn background process: {}", e))?;

    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let running = Arc::new(AtomicBool::new(true));
    let logs = Arc::new(Mutex::new(Vec::<String>::new()));
    let (kill_tx, mut kill_rx) = mpsc::channel::<()>(1);

    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let logs_clone = logs.clone();
    let running_clone = running.clone();
    let proc_id = id.clone();

    // Background task to read stdout, stderr, and monitor exit or kill signal
    tokio::spawn(async move {
        let stdout_reader = stdout.map(|s| BufReader::new(s).lines());
        let stderr_reader = stderr.map(|s| BufReader::new(s).lines());

        let logs_stdout = logs_clone.clone();
        if let Some(mut lines) = stdout_reader {
            let proc_id_c = proc_id.clone();
            tokio::spawn(async move {
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut lock = logs_stdout.lock().await;
                    if lock.len() >= MAX_LOG_LINES {
                        lock.remove(0);
                    }
                    lock.push(format!("[{}] {}", proc_id_c, line));
                }
            });
        }

        let logs_stderr = logs_clone.clone();
        if let Some(mut lines) = stderr_reader {
            let proc_id_c = proc_id.clone();
            tokio::spawn(async move {
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut lock = logs_stderr.lock().await;
                    if lock.len() >= MAX_LOG_LINES {
                        lock.remove(0);
                    }
                    lock.push(format!("[{}:err] {}", proc_id_c, line));
                }
            });
        }

        tokio::select! {
            res = child.wait() => {
                match res {
                    Ok(status) => {
                        let mut lock = logs_clone.lock().await;
                        lock.push(format!("--- Process exited with status: {} ---", status));
                    }
                    Err(e) => {
                        let mut lock = logs_clone.lock().await;
                        lock.push(format!("--- Process wait error: {} ---", e));
                    }
                }
                running_clone.store(false, Ordering::SeqCst);
            }
            _ = kill_rx.recv() => {
                let _ = child.kill().await;
                let mut lock = logs_clone.lock().await;
                lock.push("--- Process terminated by user ---".to_string());
                running_clone.store(false, Ordering::SeqCst);
            }
        }
    });

    let summary = ProcessSummary {
        id: id.clone(),
        command: command.clone(),
        cwd: cwd.clone(),
        running: true,
        pid,
        started_at,
    };

    procs.insert(
        id,
        ActiveProcess {
            command,
            cwd,
            running,
            pid,
            started_at,
            logs,
            kill_tx,
        },
    );

    Ok(summary)
}

#[command]
pub async fn read_process_logs(
    id: String,
    tail: Option<usize>,
    state: State<'_, ProcessState>,
) -> Result<ProcessLogs, String> {
    let procs = state.processes.lock().await;
    let proc = procs.get(&id).ok_or_else(|| format!("No process found with id '{}'", id))?;

    let is_running = proc.running.load(Ordering::SeqCst);
    let all_logs = proc.logs.lock().await;

    let count = tail.unwrap_or(100);
    let start_idx = if all_logs.len() > count {
        all_logs.len() - count
    } else {
        0
    };

    let lines = all_logs[start_idx..].to_vec();

    Ok(ProcessLogs {
        id,
        running: is_running,
        lines,
    })
}

#[command]
pub async fn kill_background_process(
    id: String,
    state: State<'_, ProcessState>,
) -> Result<bool, String> {
    let procs = state.processes.lock().await;
    if let Some(proc) = procs.get(&id) {
        if proc.running.load(Ordering::SeqCst) {
            let _ = proc.kill_tx.send(()).await;
            return Ok(true);
        }
        return Ok(false);
    }
    Err(format!("No process found with id '{}'", id))
}

#[command]
pub async fn list_background_processes(
    state: State<'_, ProcessState>,
) -> Result<Vec<ProcessSummary>, String> {
    let procs = state.processes.lock().await;
    let mut list = Vec::new();

    for (id, p) in procs.iter() {
        list.push(ProcessSummary {
            id: id.clone(),
            command: p.command.clone(),
            cwd: p.cwd.clone(),
            running: p.running.load(Ordering::SeqCst),
            pid: p.pid,
            started_at: p.started_at,
        });
    }

    Ok(list)
}
