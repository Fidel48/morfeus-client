use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavSpec, WavWriter};
use std::io::Cursor;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

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

/// Start recording audio from the default microphone.
/// Uses the device's native sample rate to avoid StreamConfigNotSupported.
#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    state: tauri::State<'_, RecordingBuffer>,
) -> Result<(), String> {
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

    let _ = app.emit("recording-started", ());

    std::thread::spawn(move || {
        let host = cpal::default_host();
        let device = match host.default_input_device() {
            Some(d) => d,
            None => {
                eprintln!("[morfeus] No audio input device found");
                return;
            }
        };

        // Use the device's native config — avoids StreamConfigNotSupported
        let supported = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[morfeus] No default input config: {}", e);
                return;
            }
        };

        let native_rate = supported.sample_rate().0;
        let channels = supported.channels() as usize;

        // Store actual sample rate so stop_recording can write the correct WAV header
        if let Ok(mut sr) = sample_rate_ref.lock() {
            *sr = native_rate;
        }

        let config: cpal::StreamConfig = supported.into();

        let samples_clone = Arc::clone(&samples_ref);
        let is_rec_clone = Arc::clone(&is_recording_ref);

        let stream = match device.build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if let Ok(rec) = is_rec_clone.lock() {
                    if !*rec { return; }
                }
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
            return;
        }

        loop {
            std::thread::sleep(std::time::Duration::from_millis(50));
            if let Ok(rec) = is_recording_ref.lock() {
                if !*rec { break; }
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
    Ok(host.default_input_device().is_some())
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
pub async fn speak_text(text: String, rate: Option<f64>) -> Result<(), String> {
    let rate_val = rate.unwrap_or(1.0);
    let wpm = (175.0 * rate_val) as i32;
    
    tokio::process::Command::new("say")
        .args(["-r", &wpm.to_string(), &text])
        .spawn()
        .map_err(|e| e.to_string())?;

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
    tokio::process::Command::new("killall")
        .arg("say")
        .spawn()
        .map_err(|e| e.to_string())?;
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
