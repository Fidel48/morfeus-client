use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavSpec, WavWriter};
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

static SPEECH_GENERATION: AtomicU64 = AtomicU64::new(0);
pub static IS_CONTINUOUS_MODE: AtomicBool = AtomicBool::new(false);
pub static IS_AI_SPEAKING: AtomicBool = AtomicBool::new(false);
pub static BARGE_IN_THRESHOLD: AtomicU32 = AtomicU32::new(45); // RMS 0.045

/// Shared recording buffer managed as Tauri app state
pub struct RecordingBuffer {
    pub samples: Arc<Mutex<Vec<f32>>>,
    pub is_recording: Arc<Mutex<bool>>,
    pub sample_rate: Arc<Mutex<u32>>,
}

impl Default for RecordingBuffer {
    fn default() -> Self {
        Self {
            samples: Arc::new(Mutex::new(Vec::new())),
            is_recording: Arc::new(Mutex::new(false)),
            sample_rate: Arc::new(Mutex::new(16000)),
        }
    }
}

#[cfg(target_os = "macos")]
extern "C" {
    fn check_and_request_mic_permission() -> i32;
}

/// Start recording audio from the default microphone.
/// Uses the device's native sample rate to avoid StreamConfigNotSupported.
#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    state: tauri::State<'_, RecordingBuffer>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = unsafe { check_and_request_mic_permission() };
        if status == 2 {
            return Err("Microphone permission denied. Please allow microphone access in macOS System Settings → Privacy & Security → Microphone.".to_string());
        }
    }

    // Halt any active speech output when recording starts so microphone doesn't capture it
    if IS_AI_SPEAKING.load(Ordering::SeqCst) {
        SPEECH_GENERATION.fetch_add(1, Ordering::SeqCst);
        IS_AI_SPEAKING.store(false, Ordering::SeqCst);
        #[cfg(target_os = "macos")]
        {
            let _ = tokio::process::Command::new("killall").arg("afplay").output().await;
            let _ = tokio::process::Command::new("killall").arg("say").output().await;
        }
    }

    {
        let mut is_recording = state.is_recording.lock().map_err(|e| e.to_string())?;
        if *is_recording {
            return Ok(());
        }
        *is_recording = true;
    }
    {
        let mut samples = state.samples.lock().map_err(|e| e.to_string())?;
        samples.clear();
    }

    let samples_ref = Arc::clone(&state.samples);
    let is_recording_ref = Arc::clone(&state.is_recording);
    let sample_rate_ref = Arc::clone(&state.sample_rate);
    let app_handle = app.clone();

    let _ = app.emit("recording-started", ());

    std::thread::spawn(move || {
        let speech_detected = Arc::new(Mutex::new(false));
        let last_speech_time = Arc::new(Mutex::new(None::<std::time::Instant>));
        let speech_detected_cb = Arc::clone(&speech_detected);
        let last_speech_cb = Arc::clone(&last_speech_time);

        let host = cpal::default_host();
        let mut device_opt = host.default_input_device();
        
        #[cfg(target_os = "macos")]
        if device_opt.is_none() {
            if let Ok(mut devices) = host.input_devices() {
                device_opt = devices.next();
            }
        }

        let device = match device_opt {
            Some(d) => d,
            None => {
                eprintln!("[morfeus] No audio input device found");
                if let Ok(mut rec) = is_recording_ref.lock() { *rec = false; }
                return;
            }
        };

        let (native_rate, channels, config) = match device.default_input_config() {
            Ok(c) => (c.sample_rate().0, c.channels() as usize, c.into()),
            Err(e) => {
                eprintln!("[morfeus] No default input config: {}. Forcing generic config to trigger macOS permission prompt.", e);
                (16000, 1, cpal::StreamConfig {
                    channels: 1,
                    sample_rate: cpal::SampleRate(16000),
                    buffer_size: cpal::BufferSize::Default,
                })
            }
        };
        if let Ok(mut sr) = sample_rate_ref.lock() {
            *sr = native_rate;
        }

        let samples_clone = Arc::clone(&samples_ref);
        let is_rec_clone = Arc::clone(&is_recording_ref);

        let stream = match device.build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if let Ok(rec) = is_rec_clone.lock() {
                    if !*rec { return; }
                }

                // If AI is actively vocalizing through speakers, suppress mic processing
                // to prevent acoustic feedback loop (the assistant hearing herself).
                if IS_AI_SPEAKING.load(Ordering::SeqCst) {
                    return;
                }

                // Voice Activity Detection (RMS energy)
                let sum_sq: f32 = data.iter().map(|&x| x * x).sum();
                let rms = (sum_sq / data.len().max(1) as f32).sqrt();

                // Standard recording path (user speaking alone)
                if let Ok(mut buf) = samples_clone.lock() {
                    // Mix down to mono
                    if channels == 1 {
                        buf.extend_from_slice(data);
                    } else {
                        for frame in data.chunks(channels) {
                            buf.push(frame.iter().sum::<f32>() / channels as f32);
                        }
                    }
                }

                if rms > 0.010 {
                    if let Ok(mut sd) = speech_detected_cb.lock() {
                        *sd = true;
                    }
                    if let Ok(mut lst) = last_speech_cb.lock() {
                        *lst = Some(std::time::Instant::now());
                    }
                }
            },
            |err| eprintln!("[morfeus] Stream error: {}", err),
            None,
        ) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[morfeus] Failed to build stream: {}", e);
                if let Ok(mut rec) = is_recording_ref.lock() { *rec = false; }
                return;
            }
        };

        if let Err(e) = stream.play() {
            eprintln!("[morfeus] Failed to play stream: {}", e);
            // Bug #9: reset is_recording so the user can retry without restarting the app
            if let Ok(mut rec) = is_recording_ref.lock() { *rec = false; }
            return;
        }

        let mut start_time = std::time::Instant::now();
        let mut silence_emitted = false;

        loop {
            std::thread::sleep(std::time::Duration::from_millis(50));
            if let Ok(rec) = is_recording_ref.lock() {
                if !*rec { break; }
            }

            let is_continuous = IS_CONTINUOUS_MODE.load(Ordering::SeqCst);
            let is_ai_speaking = IS_AI_SPEAKING.load(Ordering::SeqCst);
            let has_spoken = speech_detected.lock().map(|g| *g).unwrap_or(false);

            // If AI is speaking in continuous mode and user has not barged in yet,
            // refresh start_time so the 14s idle safety timeout doesn't fire during long AI responses
            if is_continuous && is_ai_speaking && !has_spoken {
                start_time = std::time::Instant::now();
                continue;
            }

            // Check if speech was detected followed by silence (850ms in continuous mode for snappy back-and-forth)
            if has_spoken && !silence_emitted {
                let last_time = last_speech_time.lock().map(|g| *g).unwrap_or(None);
                if let Some(t) = last_time {
                    let silence_threshold = if is_continuous { 850 } else { 1200 };
                    if t.elapsed() >= std::time::Duration::from_millis(silence_threshold) {
                        silence_emitted = true;
                        let _ = app_handle.emit("voice-silence-detected", ());
                    }
                }
            }

            // Idle safety timeout: if mic stays open with no speech for 14s, auto-stop
            if !has_spoken && !silence_emitted && start_time.elapsed() >= std::time::Duration::from_secs(14) {
                silence_emitted = true;
                let _ = app_handle.emit("voice-silence-detected", ());
            }
        }
    });

    Ok(())
}

/// Stop recording and return base64-encoded PCM WAV at the device's native sample rate
#[tauri::command]
pub async fn stop_recording(
    app: AppHandle,
    state: tauri::State<'_, RecordingBuffer>,
) -> Result<String, String> {
    {
        let mut is_recording = state.is_recording.lock().map_err(|e| e.to_string())?;
        *is_recording = false;
    }

    tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

    let samples = state.samples.lock().map_err(|e| e.to_string())?;
    let sample_rate = *state.sample_rate.lock().map_err(|e| e.to_string())?;

    if samples.is_empty() {
        let _ = app.emit("recording-stopped", ());
        return Err("No audio captured".to_string());
    }

    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut wav_buf: Vec<u8> = Vec::new();
    {
        let cursor = Cursor::new(&mut wav_buf);
        let mut writer = WavWriter::new(cursor, spec).map_err(|e| e.to_string())?;
        for &sample in samples.iter() {
            let pcm = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            writer.write_sample(pcm).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;
    }

    let _ = app.emit("recording-stopped", ());
    Ok(base64_encode(&wav_buf))
}

/// Check whether a default microphone is available
#[tauri::command]
pub async fn check_microphone() -> Result<bool, String> {
    let host = cpal::default_host();
    
    // Check default input device first
    if host.default_input_device().is_some() {
        return Ok(true);
    }
    
    #[cfg(target_os = "macos")]
    {
        // Fallback: check if ANY input device is available (macOS specific behavior workaround)
        if let Ok(mut devices) = host.input_devices() {
            if devices.next().is_some() {
                return Ok(true);
            }
        }
    }
    
    Ok(false)
}

/// List available audio input device names
#[tauri::command]
pub async fn get_audio_devices() -> Result<Vec<String>, String> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|e| e.to_string())?
        .filter_map(|d| d.name().ok())
        .collect();
    Ok(devices)
}

/// Cross-platform native transcription wrapper.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn transcribe_native(base64_wav: String) -> Result<String, String> {
    let wav_bytes = base64_decode(&base64_wav).map_err(|e| format!("Base64 decode error: {}", e))?;
    
    if wav_bytes.len() < 100 {
        return Err("Audio sample too short or empty.".to_string());
    }

    tokio::task::spawn_blocking(move || {
        let temp_dir = std::env::temp_dir();
        let file_id = uuid::Uuid::new_v4().to_string();
        let temp_wav = temp_dir.join(format!("morfeus_audio_{}.wav", file_id));
        
        std::fs::write(&temp_wav, &wav_bytes).map_err(|e| format!("Failed to save temp WAV: {}", e))?;

        let mac_speech_bin = env!("MAC_SPEECH_BIN");
        let output = std::process::Command::new(mac_speech_bin)
            .arg(&temp_wav)
            .output()
            .map_err(|e| format!("Failed to execute Apple Speech recognizer: {}", e))?;

        let _ = std::fs::remove_file(&temp_wav);

        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if !err.is_empty() && !err.contains("timed out") {
                return Err(format!("Apple Speech error: {}", err));
            }
        }

        Ok(text)
    }).await.map_err(|e| e.to_string())?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn transcribe_native(base64_wav: String) -> Result<String, String> {
    let wav_bytes = base64_decode(&base64_wav).map_err(|e| format!("Base64 decode error: {}", e))?;
    if wav_bytes.len() < 100 {
        return Err("Audio sample too short or empty.".to_string());
    }
    Ok(String::new())
}



// ─── Cross-Platform TTS ──────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn speak_text(text: String, rate: Option<f64>) -> Result<(), String> {
    let rate_val = rate.unwrap_or(1.0);
    let safe_text = text.replace('\'', "''");
    let rate_int = ((rate_val - 1.0) * 5.0).clamp(-10.0, 10.0) as i32;

    let script = format!(
        r#"Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = {}; $s.Speak('{}')"#,
        rate_int, safe_text
    );

    tokio::process::Command::new("powershell")
        .args(["-WindowStyle", "Hidden", "-Command", &script])
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command]
#[allow(non_snake_case)]
pub async fn speak_text(text: String, rate: Option<f64>, voiceId: Option<String>) -> Result<(), String> {
    let rate_val = rate.unwrap_or(1.0);
    let wpm = (175.0 * rate_val) as i32;
    
    let mut cmd = tokio::process::Command::new("say");
    cmd.args(["-r", &wpm.to_string()]);

    if let Some(ref voice) = voiceId {
        if !voice.trim().is_empty() {
            cmd.args(["-v", voice]);
        }
    }

    IS_AI_SPEAKING.store(true, Ordering::SeqCst);
    let _ = cmd.arg(&text)
        .status()
        .await;
    IS_AI_SPEAKING.store(false, Ordering::SeqCst);

    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn get_voices() -> Result<Vec<String>, String> {
    let script = r#"Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }"#;

    let output = tokio::process::Command::new("powershell")
        .args(["-WindowStyle", "Hidden", "-Command", script])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let voices: Vec<String> = stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    Ok(voices)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn get_voices() -> Result<Vec<String>, String> {
    let output = tokio::process::Command::new("say")
        .arg("-v")
        .arg("?")
        .output()
        .await
        .map_err(|e| e.to_string())?;
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    let voices: Vec<String> = stdout
        .lines()
        .filter_map(|line| line.split_whitespace().next().map(|s| s.to_string()))
        .collect();
        
    Ok(voices)
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn stop_speaking() -> Result<(), String> {
    SPEECH_GENERATION.fetch_add(1, Ordering::SeqCst);
    IS_AI_SPEAKING.store(false, Ordering::SeqCst);
    tokio::process::Command::new("powershell")
        .args([
            "-WindowStyle",
            "Hidden",
            "-Command",
            r#"Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SpeakAsyncCancelAll()"#,
        ])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn stop_speaking() -> Result<(), String> {
    SPEECH_GENERATION.fetch_add(1, Ordering::SeqCst);
    IS_AI_SPEAKING.store(false, Ordering::SeqCst);
    let _ = tokio::process::Command::new("killall").arg("afplay").output().await;
    let _ = tokio::process::Command::new("killall").arg("say").output().await;
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
#[tauri::command]
pub async fn speak_text(text: String, _rate: Option<f64>, _voice_id: Option<String>) -> Result<(), String> {
    let _ = tokio::process::Command::new("spd-say")
        .arg(&text)
        .spawn();
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
#[tauri::command]
pub async fn get_voices() -> Result<Vec<String>, String> {
    Ok(vec!["default".to_string()])
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
#[tauri::command]
pub async fn stop_speaking() -> Result<(), String> {
    SPEECH_GENERATION.fetch_add(1, Ordering::SeqCst);
    IS_AI_SPEAKING.store(false, Ordering::SeqCst);
    let _ = tokio::process::Command::new("killall").arg("aplay").output().await;
    let _ = tokio::process::Command::new("spd-say").arg("-S").output().await;
    Ok(())
}

// ─── Kokoro Neural TTS Server & Playback ──────────────────────────────────────

#[tauri::command]
pub async fn is_kokoro_running() -> bool {
    reqwest::Client::new()
        .get("http://127.0.0.1:8880/health")
        .timeout(std::time::Duration::from_millis(500))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn start_kokoro_server() -> Result<bool, String> {
    if is_kokoro_running().await {
        return Ok(true);
    }

    let uv_path = if std::path::Path::new("/opt/homebrew/bin/uv").exists() {
        "/opt/homebrew/bin/uv"
    } else {
        "uv"
    };

    let script_candidates = [
        "src-tauri/kokoro_server.py",
        "kokoro_server.py",
        "../src-tauri/kokoro_server.py",
    ];

    let mut script_path = None;
    for candidate in &script_candidates {
        if std::path::Path::new(candidate).exists() {
            script_path = Some(candidate.to_string());
            break;
        }
    }

    let script = match script_path {
        Some(s) => s,
        None => return Err("kokoro_server.py not found".to_string()),
    };

    let mut cmd = tokio::process::Command::new(uv_path);
    cmd.args([
        "run",
        "--with", "kokoro-onnx",
        "--with", "soundfile",
        "--with", "fastapi",
        "--with", "uvicorn",
        "python3",
        &script,
    ]);

    cmd.spawn().map_err(|e| format!("Failed to spawn Kokoro server: {}", e))?;

    // Wait up to 6 seconds for server to be healthy
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if is_kokoro_running().await {
            return Ok(true);
        }
    }

    Ok(false)
}

#[tauri::command]
pub async fn kokoro_speak_native(
    text: String,
    voice: Option<String>,
    speed: Option<f64>,
) -> Result<(), String> {
    let gen = SPEECH_GENERATION.load(Ordering::SeqCst);
    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "input": text,
        "voice": voice.unwrap_or_else(|| "af_heart".to_string()),
        "speed": speed.unwrap_or(1.0)
    });

    let resp = client
        .post("http://127.0.0.1:8880/v1/audio/speech")
        .json(&payload)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Kokoro request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Kokoro returned status {}", resp.status()));
    }

    if SPEECH_GENERATION.load(Ordering::SeqCst) != gen {
        return Ok(());
    }

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;

    if SPEECH_GENERATION.load(Ordering::SeqCst) != gen {
        return Ok(());
    }

    let temp_file_name = format!("morfeus_tts_{}.wav", uuid::Uuid::new_v4());
    let temp_path = std::env::temp_dir().join(temp_file_name);
    tokio::fs::write(&temp_path, &bytes)
        .await
        .map_err(|e| e.to_string())?;

    if SPEECH_GENERATION.load(Ordering::SeqCst) != gen {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        IS_AI_SPEAKING.store(true, Ordering::SeqCst);
        let _ = tokio::process::Command::new("afplay")
            .arg(&temp_path)
            .status()
            .await;
        IS_AI_SPEAKING.store(false, Ordering::SeqCst);
        let _ = tokio::fs::remove_file(&temp_path).await;
    }

    #[cfg(target_os = "windows")]
    {
        IS_AI_SPEAKING.store(true, Ordering::SeqCst);
        let script = format!(
            r#"(New-Object Media.SoundPlayer '{}').PlaySync()"#,
            temp_path.to_string_lossy().replace('\'', "''")
        );
        let _ = tokio::process::Command::new("powershell")
            .args(["-WindowStyle", "Hidden", "-Command", &script])
            .status()
            .await;
        IS_AI_SPEAKING.store(false, Ordering::SeqCst);
        let _ = tokio::fs::remove_file(&temp_path).await;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        IS_AI_SPEAKING.store(true, Ordering::SeqCst);
        let _ = tokio::process::Command::new("aplay")
            .arg(&temp_path)
            .status()
            .await;
        IS_AI_SPEAKING.store(false, Ordering::SeqCst);
        let _ = tokio::fs::remove_file(&temp_path).await;
    }

    Ok(())
}

#[tauri::command]
pub fn set_continuous_mode(enabled: bool) {
    IS_CONTINUOUS_MODE.store(enabled, Ordering::SeqCst);
}

#[tauri::command]
pub fn set_ai_speaking(
    speaking: bool,
    state: tauri::State<'_, RecordingBuffer>,
) -> Result<(), String> {
    IS_AI_SPEAKING.store(speaking, Ordering::SeqCst);
    if !speaking {
        if let Ok(mut samples) = state.samples.lock() {
            samples.clear();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn clear_recording_buffer(state: tauri::State<'_, RecordingBuffer>) -> Result<(), String> {
    if let Ok(mut samples) = state.samples.lock() {
        samples.clear();
    }
    Ok(())
}

#[tauri::command]
pub async fn kokoro_preview_native(
    voice: String,
    speed: Option<f64>,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "voice": voice,
        "speed": speed.unwrap_or(1.0)
    });

    let resp = client
        .post("http://127.0.0.1:8880/preview")
        .json(&payload)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Kokoro preview failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Kokoro returned status {}", resp.status()));
    }

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;

    let temp_path = std::env::temp_dir().join("morfeus_preview.wav");
    tokio::fs::write(&temp_path, &bytes)
        .await
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    {
        let _ = tokio::process::Command::new("killall").arg("afplay").output().await;
        tokio::process::Command::new("afplay")
            .arg(&temp_path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        let script = format!(
            r#"(New-Object Media.SoundPlayer '{}').Play()"#,
            temp_path.to_string_lossy().replace('\'', "''")
        );
        let _ = tokio::process::Command::new("powershell")
            .args(["-WindowStyle", "Hidden", "-Command", &script])
            .spawn();
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = tokio::process::Command::new("killall").arg("aplay").output().await;
        let _ = tokio::process::Command::new("aplay")
            .arg(&temp_path)
            .spawn();
    }

    Ok(())
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
        out.push(CHARS[b0 >> 2] as char);
        out.push(CHARS[((b0 & 0x3) << 4) | (b1 >> 4)] as char);
        out.push(if chunk.len() > 1 { CHARS[((b1 & 0xf) << 2) | (b2 >> 6)] as char } else { '=' });
        out.push(if chunk.len() > 2 { CHARS[b2 & 0x3f] as char } else { '=' });
    }
    out
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const DECODE: [u8; 128] = {
        let mut table = [255u8; 128];
        let chars = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut i = 0;
        while i < 64 {
            table[chars[i] as usize] = i as u8;
            i += 1;
        }
        table
    };

    let input = input.trim();
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let bytes: Vec<u8> = input.bytes().filter(|&b| b != b'=' && b != b'\n' && b != b'\r').collect();

    for chunk in bytes.chunks(4) {
        if chunk.len() < 2 { break; }
        let b0 = *DECODE.get(chunk[0] as usize).unwrap_or(&255);
        let b1 = *DECODE.get(chunk[1] as usize).unwrap_or(&255);
        if b0 == 255 || b1 == 255 { return Err("Invalid base64".to_string()); }
        out.push((b0 << 2) | (b1 >> 4));
        if chunk.len() > 2 {
            let b2 = *DECODE.get(chunk[2] as usize).unwrap_or(&255);
            if b2 == 255 { return Err("Invalid base64".to_string()); }
            out.push((b1 << 4) | (b2 >> 2));
            if chunk.len() > 3 {
                let b3 = *DECODE.get(chunk[3] as usize).unwrap_or(&255);
                if b3 == 255 { return Err("Invalid base64".to_string()); }
                out.push((b2 << 6) | b3);
            }
        }
    }
    Ok(out)
}
