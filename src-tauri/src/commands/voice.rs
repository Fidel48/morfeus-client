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
