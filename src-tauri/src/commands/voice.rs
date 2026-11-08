use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavSpec, WavWriter};
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

static SPEECH_GENERATION: AtomicU64 = AtomicU64::new(0);
static RECORDING_SESSION_ID: AtomicU64 = AtomicU64::new(0);
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

/// Embedded compiled `mac_speech` Mach-O binary so installed `.app` / `.dmg` bundles
/// built on remote CI runners (where compile-time `OUT_DIR` does not exist on the user's Mac)
/// always have the native Apple `SFSpeechRecognizer` helper available.
#[cfg(target_os = "macos")]
const MAC_SPEECH_EMBEDDED: &[u8] = include_bytes!(env!("MAC_SPEECH_BIN"));

#[cfg(target_os = "macos")]
fn resolve_mac_speech_bin() -> Result<std::path::PathBuf, String> {
    let compiled_path = std::path::Path::new(env!("MAC_SPEECH_BIN"));
    if compiled_path.exists() {
        return Ok(compiled_path.to_path_buf());
    }

    let target_path = std::env::temp_dir().join("morfeus_mac_speech_bin");
    let needs_extract = match std::fs::metadata(&target_path) {
        Ok(meta) => meta.len() != MAC_SPEECH_EMBEDDED.len() as u64,
        Err(_) => true,
    };

    if needs_extract {
        use std::os::unix::fs::PermissionsExt;
        let stage_path = std::env::temp_dir().join(format!(
            "morfeus_mac_speech_stage_{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&stage_path, MAC_SPEECH_EMBEDDED)
            .map_err(|e| format!("Failed to extract Apple Speech binary: {}", e))?;
        let perms = std::fs::Permissions::from_mode(0o755);
        std::fs::set_permissions(&stage_path, perms)
            .map_err(|e| format!("Failed to set permissions on Apple Speech binary: {}", e))?;
        let _ = std::fs::remove_file(&target_path);
        std::fs::rename(&stage_path, &target_path)
            .map_err(|e| format!("Failed to finalize Apple Speech binary: {}", e))?;
    }

    Ok(target_path)
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

    // If a previous recording thread was left open (e.g. after HMR reload or missed event),
    // terminate it first so start_recording always begins a fresh VAD session.
    let was_already_recording = {
        let mut is_recording = state.is_recording.lock().map_err(|e| e.to_string())?;
        let prev = *is_recording;
        *is_recording = false;
        prev
    };
    if was_already_recording {
        tokio::time::sleep(tokio::time::Duration::from_millis(60)).await;
    }

    let session_id = RECORDING_SESSION_ID.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut is_recording = state.is_recording.lock().map_err(|e| e.to_string())?;
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
    let app_handle_cb = app.clone();

    let _ = app.emit("recording-started", ());

    std::thread::spawn(move || {
        let speech_detected = Arc::new(Mutex::new(false));
        let last_speech_time = Arc::new(Mutex::new(None::<std::time::Instant>));
        let speech_onset_samples = Arc::new(Mutex::new(0usize));
        let speech_detected_cb = Arc::clone(&speech_detected);
        let last_speech_cb = Arc::clone(&last_speech_time);
        let speech_onset_cb = Arc::clone(&speech_onset_samples);
        let stream_opened_at = std::time::Instant::now();

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
        // Require ~35ms of cumulative voice energy before flipping `speech_detected = true`
        // so tiny transients/clicks are ignored while normal conversational speech is caught immediately.
        let min_onset_samples = ((native_rate as usize) * 35) / 1000;

        let stream = match device.build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if let Ok(rec) = is_rec_clone.lock() {
                    if !*rec { return; }
                }

                let is_continuous = IS_CONTINUOUS_MODE.load(Ordering::SeqCst);
                let is_ai_speaking = IS_AI_SPEAKING.load(Ordering::SeqCst);

                // Voice Activity Detection (RMS energy + Peak amplitude)
                let mut peak = 0.0f32;
                let mut sum_sq = 0.0f32;
                for &x in data {
                    let a = x.abs();
                    if a > peak { peak = a; }
                    sum_sq += a * a;
                }
                let rms = (sum_sq / data.len().max(1) as f32).sqrt();

                // If AI is actively vocalizing through speakers:
                if is_ai_speaking {
                    let barge_thresh = BARGE_IN_THRESHOLD.load(Ordering::SeqCst) as f32 / 1000.0;
                    if is_continuous && rms > barge_thresh {
                        // User barged in with voice louder than speaker output!
                        eprintln!("[morfeus] ⚡ Full-Duplex VAD Barge-in detected! (rms: {:.4} > {:.4})", rms, barge_thresh);
                        IS_AI_SPEAKING.store(false, Ordering::SeqCst);
                        SPEECH_GENERATION.fetch_add(1, Ordering::SeqCst);
                        let _ = app_handle_cb.emit("voice-barge-in-detected", ());
                        #[cfg(target_os = "macos")]
                        {
                            let _ = std::process::Command::new("killall").arg("afplay").output();
                            let _ = std::process::Command::new("killall").arg("say").output();
                        }
                    } else {
                        // Suppress speaker audio echo from being recorded into samples
                        return;
                    }
                }

                let mono_frames = data.len() / channels.max(1);

                // Standard recording path (user speaking)
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

                // VAD with hysteresis + peak detection calibrated for macOS laptop/headset hardware:
                // Ambient fan/mic noise floor measures up to 0.0077 RMS / 0.013 Peak.
                // True voice articulation onset requires energy cleanly above the room noise:
                let is_voice = (rms > 0.0115 && peak > 0.022) || peak > 0.038;
                // Sustaining active syllables requires voice energy distinctly above ambient noise floor:
                let is_sustain = rms > 0.0098 || peak > 0.020;

                if stream_opened_at.elapsed() >= std::time::Duration::from_millis(80) {
                    if let Ok(mut sd) = speech_detected_cb.lock() {
                        if *sd {
                            if is_sustain {
                                if let Ok(mut lst) = last_speech_cb.lock() {
                                    *lst = Some(std::time::Instant::now());
                                }
                            }
                        } else if is_voice {
                            if let Ok(mut onset) = speech_onset_cb.lock() {
                                *onset += mono_frames;
                                if *onset >= min_onset_samples {
                                    *sd = true;
                                    let _ = crate::logger::log_to_file(
                                        &app_handle_cb,
                                        "info",
                                        &format!("🎤 Voice onset detected (rms: {:.4}, peak: {:.4})", rms, peak),
                                    );
                                    if let Ok(mut lst) = last_speech_cb.lock() {
                                        *lst = Some(std::time::Instant::now());
                                    }
                                }
                            }
                        } else if let Ok(mut onset) = speech_onset_cb.lock() {
                            *onset = onset.saturating_sub(mono_frames / 2);
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
            // Bug #9: reset is_recording so the user can retry without restarting the app
            if let Ok(mut rec) = is_recording_ref.lock() { *rec = false; }
            return;
        }

        let mut start_time = std::time::Instant::now();
        let mut silence_emitted_at: Option<std::time::Instant> = None;

        loop {
            std::thread::sleep(std::time::Duration::from_millis(50));
            if RECORDING_SESSION_ID.load(Ordering::SeqCst) != session_id {
                break;
            }
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

            // If silence was already emitted but frontend didn't stop within 1.5s, re-emit so it never deadlocks
            if let Some(emitted_time) = silence_emitted_at {
                if emitted_time.elapsed() >= std::time::Duration::from_millis(1500) {
                    silence_emitted_at = Some(std::time::Instant::now());
                    let _ = app_handle.emit("voice-silence-detected", ());
                }
                continue;
            }

            // Check if speech was detected followed by natural conversational silence (1100ms threshold)
            // Allows natural thinking and breathing pauses without abruptly cutting the user off
            if has_spoken {
                let last_time = last_speech_time.lock().map(|g| *g).unwrap_or(None);
                if let Some(t) = last_time {
                    let silence_threshold = if is_continuous { 1100 } else { 1350 };
                    if t.elapsed() >= std::time::Duration::from_millis(silence_threshold) {
                        silence_emitted_at = Some(std::time::Instant::now());
                        let _ = crate::logger::log_to_file(
                            &app_handle,
                            "info",
                            &format!("Silence detected after speech ({}ms) -> emitting voice-silence-detected", silence_threshold),
                        );
                        let _ = app_handle.emit("voice-silence-detected", ());
                    }
                }
            }

            // In Continuous Mode, while waiting for the user to speak (`!has_spoken`),
            // maintain a rolling 1.5-second pre-roll buffer so memory stays bounded and the
            // microphone stays steadily open without blinking off/on every 14 seconds.
            if is_continuous && !has_spoken {
                let onset_active = speech_onset_samples.lock().map(|g| *g > 0).unwrap_or(false);
                if !onset_active {
                    if let Ok(mut buf) = samples_ref.lock() {
                        let max_preroll = ((native_rate as usize) * 15) / 10;
                        if buf.len() > max_preroll * 2 {
                            let drain_count = buf.len() - max_preroll;
                            buf.drain(0..drain_count);
                        }
                    }
                }
                start_time = std::time::Instant::now();
                continue;
            }

            // Idle safety timeout (manual one-shot mode only): if mic stays open with no speech for 14s, auto-stop
            if !has_spoken && start_time.elapsed() >= std::time::Duration::from_secs(14) {
                silence_emitted_at = Some(std::time::Instant::now());
                let _ = app_handle.emit("voice-silence-detected", ());
            }
        }
    });

    Ok(())
}

/// Stop recording and transcribe directly in Rust, avoiding multi-megabyte base64 IPC roundtrips
#[tauri::command]
pub async fn stop_and_transcribe(
    app: AppHandle,
    state: tauri::State<'_, RecordingBuffer>,
) -> Result<String, String> {
    {
        let mut is_recording = state.is_recording.lock().map_err(|e| e.to_string())?;
        *is_recording = false;
    }

    tokio::time::sleep(tokio::time::Duration::from_millis(150)).await;

    let samples = {
        let mut s = state.samples.lock().map_err(|e| e.to_string())?;
        std::mem::take(&mut *s)
    };
    let sample_rate = *state.sample_rate.lock().map_err(|e| e.to_string())?;

    let _ = app.emit("recording-stopped", ());

    if samples.is_empty() {
        return Ok(String::new());
    }

    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(move || {
            let spec = WavSpec {
                channels: 1,
                sample_rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };

            // Calculate peak amplitude and compute auto-gain scaling so quiet speech is clear and loud
            let mut max_peak = 0.0f32;
            for &s in samples.iter() {
                let abs = s.abs();
                if abs > max_peak {
                    max_peak = abs;
                }
            }
            let gain = if max_peak > 0.005 {
                (0.85 / max_peak).clamp(1.0, 8.0)
            } else {
                1.0
            };

            let temp_dir = std::env::temp_dir();
            let file_id = uuid::Uuid::new_v4().to_string();
            let temp_wav = temp_dir.join(format!("morfeus_audio_{}.wav", file_id));

            {
                let mut writer = WavWriter::create(&temp_wav, spec).map_err(|e| e.to_string())?;
                for &sample in samples.iter() {
                    let normalized = (sample * gain).clamp(-1.0, 1.0);
                    let pcm = (normalized * i16::MAX as f32) as i16;
                    writer.write_sample(pcm).map_err(|e| e.to_string())?;
                }
                writer.finalize().map_err(|e| e.to_string())?;
            }

            let mac_speech_bin = resolve_mac_speech_bin()?;
            let output = std::process::Command::new(&mac_speech_bin)
                .arg(&temp_wav)
                .output()
                .map_err(|e| format!("Failed to execute Apple Speech recognizer: {}", e))?;

            let _ = std::fs::remove_file(&temp_wav);

            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let _ = crate::logger::log_to_file(
                &app,
                "info",
                &format!("Apple Speech transcribed: '{}' (stderr: '{}')", text, String::from_utf8_lossy(&output.stderr).trim()),
            );
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
    {
        Ok(String::new())
    }
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

    // Calculate peak amplitude and compute auto-gain scaling so quiet speech is clear and loud
    let mut max_peak = 0.0f32;
    for &s in samples.iter() {
        let abs = s.abs();
        if abs > max_peak {
            max_peak = abs;
        }
    }
    let gain = if max_peak > 0.01 {
        (0.85 / max_peak).clamp(1.0, 3.5)
    } else {
        1.0
    };

    let mut wav_buf: Vec<u8> = Vec::new();
    {
        let cursor = Cursor::new(&mut wav_buf);
        let mut writer = WavWriter::new(cursor, spec).map_err(|e| e.to_string())?;
        for &sample in samples.iter() {
            let normalized = (sample * gain).clamp(-1.0, 1.0);
            let pcm = (normalized * i16::MAX as f32) as i16;
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

        let mac_speech_bin = resolve_mac_speech_bin()?;
        let output = std::process::Command::new(&mac_speech_bin)
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

const KOKORO_SERVER_SCRIPT: &str = include_str!("../../kokoro_server.py");

static KOKORO_STARTING: AtomicBool = AtomicBool::new(false);

struct KokoroStartGuard;
impl Drop for KokoroStartGuard {
    fn drop(&mut self) {
        KOKORO_STARTING.store(false, Ordering::SeqCst);
    }
}

fn is_kokoro_port_in_use() -> bool {
    std::net::TcpListener::bind("127.0.0.1:8880").is_err()
}

fn ensure_kokoro_server_script() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let morfeus_dir = std::path::PathBuf::from(home).join(".morfeus");
    let _ = std::fs::create_dir_all(&morfeus_dir);
    let target = morfeus_dir.join("kokoro_server.py");
    let _ = std::fs::write(&target, KOKORO_SERVER_SCRIPT);
    Ok(target)
}

fn resolve_uv_binary() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        "/opt/homebrew/bin/uv".to_string(),
        "/usr/local/bin/uv".to_string(),
        format!("{}/.local/bin/uv", home),
        format!("{}/.cargo/bin/uv", home),
        "C:\\Users\\Default\\.cargo\\bin\\uv.exe".to_string(),
    ];

    for c in &candidates {
        let p = std::path::Path::new(c);
        if p.exists() {
            return Some(p.to_path_buf());
        }
    }

    if let Ok(output) = std::process::Command::new("which").arg("uv").output() {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path_str.is_empty() && std::path::Path::new(&path_str).exists() {
                return Some(std::path::PathBuf::from(path_str));
            }
        }
    }

    if let Ok(output) = std::process::Command::new("uv").arg("--version").output() {
        if output.status.success() {
            return Some(std::path::PathBuf::from("uv"));
        }
    }

    None
}

fn resolve_python3_binary() -> Option<std::path::PathBuf> {
    let candidates = [
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
        "python3",
    ];

    for c in candidates {
        let p = std::path::Path::new(c);
        if p.exists() {
            return Some(p.to_path_buf());
        }
    }

    None
}

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

    // If another task is already starting Kokoro, wait for it instead of double-spawning
    if KOKORO_STARTING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        for _ in 0..40 {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            if is_kokoro_running().await {
                return Ok(true);
            }
            if !KOKORO_STARTING.load(Ordering::SeqCst) {
                break;
            }
        }
        return Ok(is_kokoro_running().await);
    }

    let _guard = KokoroStartGuard;

    // Re-check health or port binding after acquiring the startup lock
    if is_kokoro_running().await {
        return Ok(true);
    }
    if is_kokoro_port_in_use() {
        for _ in 0..20 {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            if is_kokoro_running().await {
                return Ok(true);
            }
        }
        return Ok(is_kokoro_running().await);
    }

    // Always ensure the embedded python server script exists in ~/.morfeus/kokoro_server.py
    let script_path = ensure_kokoro_server_script()?;

    let home = std::env::var("HOME").unwrap_or_default();
    let model_dir_candidates = [
        format!("{}/.morfeus/models/kokoro", home),
        "models/kokoro".to_string(),
        "../models/kokoro".to_string(),
        format!("{}/Documents/projects/morfeus/models/kokoro", home),
    ];
    let mut resolved_model_dir = None;
    for cand in &model_dir_candidates {
        let p = std::path::Path::new(cand);
        if p.join("kokoro-v1.0.onnx").exists() && p.join("voices-v1.0.bin").exists() {
            resolved_model_dir = Some(cand.clone());
            break;
        }
    }

    let uv_opt = resolve_uv_binary();
    let log_file_path = std::path::PathBuf::from(&home).join(".morfeus/kokoro_server.log");
    let log_out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file_path)
        .ok();
    let log_err = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file_path)
        .ok();

    if let Some(uv_path) = uv_opt {
        let mut cmd = tokio::process::Command::new(uv_path);
        cmd.args([
            "run",
            "--with", "kokoro-onnx",
            "--with", "soundfile",
            "--with", "fastapi",
            "--with", "uvicorn",
            "python3",
            script_path.to_str().unwrap(),
        ]);
        if let Some(ref m_dir) = resolved_model_dir {
            cmd.env("MORFEUS_KOKORO_MODEL_DIR", m_dir);
        }
        if let Some(out) = log_out {
            cmd.stdout(out);
        }
        if let Some(err) = log_err {
            cmd.stderr(err);
        }
        cmd.spawn().map_err(|e| format!("Failed to spawn Kokoro server with uv: {}", e))?;
    } else if let Some(py3) = resolve_python3_binary() {
        let mut cmd = tokio::process::Command::new(py3);
        cmd.arg(script_path.to_str().unwrap());
        if let Some(ref m_dir) = resolved_model_dir {
            cmd.env("MORFEUS_KOKORO_MODEL_DIR", m_dir);
        }
        if let Some(out) = log_out {
            cmd.stdout(out);
        }
        if let Some(err) = log_err {
            cmd.stderr(err);
        }
        cmd.spawn().map_err(|e| format!("Failed to spawn Kokoro server with python3: {}", e))?;
    } else {
        return Err("Neither uv nor python3 was found to run Kokoro Neural TTS.".to_string());
    }

    // Wait up to 15 seconds for server to initialize model and pass /health check
    for _ in 0..75 {
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
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn test_embedded_mac_speech_extraction_and_execution() {
        assert!(
            MAC_SPEECH_EMBEDDED.len() > 10_000,
            "Embedded mac_speech binary must be non-empty"
        );
        let bin_path = resolve_mac_speech_bin().expect("Should resolve mac_speech binary");
        assert!(bin_path.exists(), "Resolved mac_speech binary must exist");

        // Also test forced extraction (simulating an installed .app on another Mac where OUT_DIR does not exist)
        use std::os::unix::fs::PermissionsExt;
        let extracted_path = std::env::temp_dir().join("morfeus_mac_speech_extracted_test");
        let _ = std::fs::remove_file(&extracted_path);
        std::fs::write(&extracted_path, MAC_SPEECH_EMBEDDED).expect("Write embedded bytes");
        std::fs::set_permissions(&extracted_path, std::fs::Permissions::from_mode(0o755))
            .expect("Set executable permissions");

        let aiff_path = std::env::temp_dir().join("morfeus_test_stt.aiff");
        let wav_path = std::env::temp_dir().join("morfeus_test_stt.wav");
        let _ = std::process::Command::new("say")
            .args(["-o", aiff_path.to_str().unwrap(), "Hello Morfeus continuous voice test"])
            .status();
        let _ = std::process::Command::new("afconvert")
            .args([
                "-f",
                "WAVE",
                "-d",
                "LEI16@16000",
                "-c",
                "1",
                aiff_path.to_str().unwrap(),
                wav_path.to_str().unwrap(),
            ])
            .status();

        if wav_path.exists() {
            let output = std::process::Command::new(&extracted_path)
                .arg(&wav_path)
                .output()
                .expect("Execute extracted mac_speech binary");
            let stdout = String::from_utf8_lossy(&output.stdout).to_lowercase();
            assert!(
                stdout.contains("hello") || stdout.contains("voice"),
                "Expected transcription from extracted mac_speech binary, got stdout={:?} stderr={:?}",
                stdout,
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let _ = std::fs::remove_file(&aiff_path);
        let _ = std::fs::remove_file(&wav_path);
        let _ = std::fs::remove_file(&extracted_path);
    }

    #[test]
    fn test_ambient_noise_level() {
        let host = cpal::default_host();
        let device = match host.default_input_device() {
            Some(d) => d,
            None => {
                println!("No default input device found");
                return;
            }
        };

        let config = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                println!("No default input config: {}", e);
                return;
            }
        };

        let stats = Arc::new(Mutex::new((0.0f32, 0.0f32, 0usize))); // max_rms, max_peak, count
        let stats_cb = Arc::clone(&stats);

        let stream = match device.build_input_stream(
            &config.into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                let mut peak = 0.0f32;
                let mut sum_sq = 0.0f32;
                for &x in data {
                    let a = x.abs();
                    if a > peak { peak = a; }
                    sum_sq += a * a;
                }
                let rms = (sum_sq / data.len().max(1) as f32).sqrt();
                if let Ok(mut s) = stats_cb.lock() {
                    if rms > s.0 { s.0 = rms; }
                    if peak > s.1 { s.1 = peak; }
                    s.2 += 1;
                }
            },
            |err| eprintln!("Stream error: {}", err),
            None,
        ) {
            Ok(s) => s,
            Err(e) => {
                println!("Failed to build stream: {}", e);
                return;
            }
        };

        let _ = stream.play();
        std::thread::sleep(std::time::Duration::from_millis(1500));
        drop(stream);

        let (max_rms, max_peak, count) = {
            let s = stats.lock().unwrap();
            (s.0, s.1, s.2)
        };

        println!(
            "\n====== AMBIENT MIC MEASUREMENT ======\nMax RMS: {:.6}\nMax Peak: {:.6}\nBuffer chunks: {}\n=====================================",
            max_rms, max_peak, count
        );
    }
}
