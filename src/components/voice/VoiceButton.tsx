import React, { useCallback, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, Square, Infinity as InfinityIcon } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { cn } from '@/lib/utils';
import { useVoiceStore } from '@/stores/voiceStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { tauriApi } from '@/lib/tauri';
import { interruptAiSpeech } from '@/lib/kokoroTts';

interface VoiceButtonProps {
  currentInput?: string;
  onTranscript: (text: string) => void;
  onAutoSend?: (text?: string) => void;
  className?: string;
}

declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

// ─── Platform detection ───────────────────────────────────────────────────────
const isMacOS = typeof navigator !== 'undefined' &&
  /Mac/i.test(navigator.platform || navigator.userAgent) &&
  !/iPhone|iPad/i.test(navigator.userAgent);

const getSupportedMimeType = () => {
  if (typeof MediaRecorder === 'undefined') return '';
  const types = ['audio/mp4', 'audio/m4a', 'audio/aac', 'audio/wav', 'audio/webm;codecs=opus', 'audio/webm'];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
};

const getSpeechRecognition = () => {
  if (typeof window === 'undefined') return false;
  return window.SpeechRecognition || window.webkitSpeechRecognition;
};

export const VoiceButton: React.FC<VoiceButtonProps> = ({ currentInput = '', onTranscript, onAutoSend, className }) => {
  const { status, setStatus, micAvailable, setMicAvailable, waveformData, updateWaveform, isSpeaking } = useVoiceStore();
  const { settings, updateSettings } = useSettingsStore();

  const isContinuousActive = Boolean(settings.continuous_voice);
  const isPttMode = settings.ptt_mode && !isContinuousActive;

  const isRecording = status === 'recording';
  const isTranscribing = status === 'transcribing';

  const isHandlingClick = useRef(false);
  const isStartingRef = useRef(false);
  const recognitionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waveformIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const usingNativeRef = useRef(false);
  const currentInputRef = useRef(currentInput);

  const onTranscriptRef = useRef(onTranscript);
  const onAutoSendRef = useRef(onAutoSend);
  useEffect(() => { currentInputRef.current = currentInput; }, [currentInput]);
  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  useEffect(() => { onAutoSendRef.current = onAutoSend; }, [onAutoSend]);

  useEffect(() => {
    setMicAvailable(true);
  }, [setMicAvailable]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (waveformIntervalRef.current) clearInterval(waveformIntervalRef.current);
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch {}
        recognitionRef.current = null;
      }
    };
  }, []);

  // ─── Waveform helpers ─────────────────────────────────────────────────────
  const startWaveform = useCallback(() => {
    if (waveformIntervalRef.current) clearInterval(waveformIntervalRef.current);
    waveformIntervalRef.current = setInterval(() => {
      updateWaveform(Array.from({ length: 20 }, () => Math.random()));
    }, 80);
  }, [updateWaveform]);

  const stopWaveform = useCallback(() => {
    if (waveformIntervalRef.current) clearInterval(waveformIntervalRef.current);
    waveformIntervalRef.current = null;
    updateWaveform(new Array(20).fill(0));
  }, [updateWaveform]);

  // ─── macOS Path: Native Rust CoreAudio + Apple SFSpeechRecognizer ────────
  const startMacRecording = useCallback(async () => {
    if (isStartingRef.current || status === 'recording' || status === 'transcribing') return;
    isStartingRef.current = true;

    try {
      usingNativeRef.current = true;
      await tauriApi.startRecording();
      setStatus('recording');
      startWaveform();
    } catch (err: any) {
      console.error('[VoiceButton/Mac] Native recording start error:', err);
      tauriApi.appendSystemLog('error', `Mac recording start error: ${err?.message || err}`);
      stopWaveform();
      usingNativeRef.current = false;
      setStatus('idle');
    } finally {
      isStartingRef.current = false;
    }
  }, [status, setStatus, startWaveform, stopWaveform]);

  const stopMacRecording = useCallback(async () => {
    stopWaveform();
    setStatus('transcribing');

    try {
      const base64Wav = await tauriApi.stopRecording();
      if (base64Wav) {
        const text = await tauriApi.transcribeNative(base64Wav);
        const trimmed = text ? text.trim() : '';
        if (trimmed) {
          onTranscriptRef.current(trimmed);
          onAutoSendRef.current?.(trimmed);
          // In Full-Duplex Continuous Mode:
          // Immediately re-arm recording so mic is actively listening for VAD barge-in while AI streams & speaks
          if (isContinuousActiveRef.current) {
            setTimeout(() => {
              if (isContinuousActiveRef.current && statusRef.current === 'idle') {
                startRecordingRef.current();
              }
            }, 300);
          }
        } else if (isContinuousActiveRef.current) {
          setTimeout(() => {
            if (isContinuousActiveRef.current && statusRef.current === 'idle') {
              startRecordingRef.current();
            }
          }, 300);
        }
      } else if (isContinuousActiveRef.current) {
        setTimeout(() => {
          if (isContinuousActiveRef.current && statusRef.current === 'idle') {
            startRecordingRef.current();
          }
        }, 300);
      }
    } catch (err: any) {
      console.error('[VoiceButton/Mac] Native STT error:', err);
      tauriApi.appendSystemLog('error', `Mac STT error: ${err?.message || err}`);
    } finally {
      setStatus('idle');
      usingNativeRef.current = false;
    }
  }, [setStatus, stopWaveform]);

  // ─── Windows Path: Browser SpeechRecognition (Chromium / Edge) ───────────
  const startBrowserRecording = useCallback(() => {
    const SR = getSpeechRecognition();
    if (!SR || status !== 'idle') return;

    try {
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = 'en-US';

      let latestText = '';
      let initialInput = '';

      const resetSilenceTimer = () => {
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = setTimeout(() => {
          if (recognitionRef.current) recognitionRef.current.stop();
        }, 1800);
      };

      rec.onstart = () => {
        initialInput = currentInputRef.current.trim();
        setStatus('recording');
        resetSilenceTimer();
        startWaveform();
      };

      rec.onresult = (event: any) => {
        resetSilenceTimer();

        // Full-Duplex VAD Barge-in in Continuous Mode (Windows 11)
        if (isContinuousActiveRef.current && useVoiceStore.getState().isSpeaking) {
          console.log('[VoiceButton/Browser] ⚡ Full-Duplex Barge-in triggered!');
          interruptAiSpeech(true);
        }

        let finalTranscript = '';
        let interimTranscript = '';

        for (let i = 0; i < event.results.length; ++i) {
          const res = event.results[i];
          if (res.isFinal) {
            finalTranscript += (finalTranscript ? ' ' : '') + res[0].transcript.trim();
          } else {
            interimTranscript += (interimTranscript ? ' ' : '') + res[0].transcript.trim();
          }
        }

        const sessionText = (finalTranscript + (interimTranscript ? ' ' + interimTranscript : '')).trim();
        latestText = initialInput ? `${initialInput} ${sessionText}` : sessionText;
        onTranscriptRef.current(latestText);
      };

      rec.onerror = (event: any) => {
        console.error('[VoiceButton] SpeechRecognition error:', event.error);
        tauriApi.appendSystemLog('warn', `SpeechRecognition error: ${event.error}`);

        if (event.error === 'not-allowed') {
          stopWaveform();
          setStatus('idle');
          onTranscriptRef.current('⚠️ Microphone access denied. Please allow microphone access in your system settings.');
        }
      };

      rec.onend = () => {
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        stopWaveform();
        setStatus('idle');

        const textToSend = latestText.trim();
        if (textToSend) {
          onTranscriptRef.current(textToSend);
          onAutoSendRef.current?.(textToSend);
          if (isContinuousActiveRef.current) {
            setTimeout(() => {
              if (isContinuousActiveRef.current && statusRef.current === 'idle') {
                startRecordingRef.current();
              }
            }, 300);
          }
        } else if (isContinuousActiveRef.current) {
          setTimeout(() => {
            if (isContinuousActiveRef.current && statusRef.current === 'idle') {
              startRecordingRef.current();
            }
          }, 300);
        }
      };

      rec.start();
      recognitionRef.current = rec;
      usingNativeRef.current = false;
    } catch (e: any) {
      console.error('[VoiceButton] Failed to start SpeechRecognition:', e);
      tauriApi.appendSystemLog('error', `SpeechRecognition failed to launch: ${e?.message || e}`);
      stopWaveform();
      setStatus('idle');
    }
  }, [status, setStatus, startWaveform, stopWaveform]);

  const stopBrowserRecording = useCallback(() => {
    if (status !== 'recording' || !recognitionRef.current) return;
    recognitionRef.current.stop();
  }, [status]);

  // ─── Fallback MediaRecorder ───────────────────────────────────────────────
  const startNativeRecording = useCallback(async () => {
    if (isStartingRef.current || status === 'recording' || status === 'transcribing') return;
    isStartingRef.current = true;

    try {
      usingNativeRef.current = true;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const mimeType = getSupportedMimeType();
      const mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => setStatus('idle');

      mediaRecorder.start(100);
      setStatus('recording');
      startWaveform();
    } catch (err: any) {
      console.error('[VoiceButton] Microphone access error:', err);
      tauriApi.appendSystemLog('error', `Microphone error: ${err?.message || err}`);
      stopWaveform();
      usingNativeRef.current = false;
      mediaRecorderRef.current = null;
      setStatus('idle');
    } finally {
      isStartingRef.current = false;
    }
  }, [status, setStatus, startWaveform, stopWaveform]);

  const stopNativeRecording = useCallback(async () => {
    stopWaveform();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      try {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
      } catch (e) {
        console.error('[VoiceButton] Error stopping MediaRecorder:', e);
        setStatus('idle');
      }
    } else {
      setStatus('idle');
    }
    mediaRecorderRef.current = null;
    usingNativeRef.current = false;
  }, [setStatus, stopWaveform]);

  // ─── Unified start/stop dispatch ─────────────────────────────────────────
  const startRecording = useCallback(() => {
    // Barge-in: immediately silence the AI if it is speaking
    interruptAiSpeech(false);

    if (isMacOS) {
      startMacRecording();
    } else {
      const SR = getSpeechRecognition();
      if (SR) startBrowserRecording();
      else startNativeRecording();
    }
  }, [startMacRecording, startBrowserRecording, startNativeRecording]);

  const stopRecording = useCallback(() => {
    if (status !== 'recording') return;
    if (isMacOS) {
      stopMacRecording();
    } else if (usingNativeRef.current) {
      stopNativeRecording();
    } else {
      stopBrowserRecording();
    }
  }, [status, stopMacRecording, stopNativeRecording, stopBrowserRecording]);

  // ─── Refs for event listeners ─────────────────────────────────────────────
  const startRecordingRef = useRef(startRecording);
  const stopRecordingRef = useRef(stopRecording);
  const statusRef = useRef(status);
  const isContinuousActiveRef = useRef(isContinuousActive);

  useEffect(() => { startRecordingRef.current = startRecording; }, [startRecording]);
  useEffect(() => { stopRecordingRef.current = stopRecording; }, [stopRecording]);
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { isContinuousActiveRef.current = isContinuousActive; }, [isContinuousActive]);

  // ─── Listen for hardware silence detection from Rust CPAL (macOS) ─────────
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('voice-silence-detected', () => {
      if (statusRef.current === 'recording') {
        stopRecordingRef.current();
      }
    }).then((fn) => { unlisten = fn; }).catch(() => {});

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // ─── Listen for Full-Duplex VAD Barge-in from Rust CPAL (Continuous Mode only) ─
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('voice-barge-in-detected', () => {
      // Full-Duplex VAD Barge-in applies strictly in Continuous Mode
      if (!isContinuousActiveRef.current) return;
      console.log('[VoiceButton] ⚡ Full-Duplex VAD Barge-in triggered!');
      // 1. Immediately abort AI speech playback & chat stream
      interruptAiSpeech(true);
      // 2. Ensure recording state & visual waveform stay active
      setStatus('recording');
      startWaveform();
    }).then((fn) => { unlisten = fn; }).catch(() => {});

    return () => {
      if (unlisten) unlisten();
    };
  }, [setStatus, startWaveform]);

  // ─── Keep Rust aware of Continuous Mode state ─────────────────────────────
  useEffect(() => {
    tauriApi.setContinuousMode(isContinuousActive).catch(() => {});
  }, [isContinuousActive]);

  // ─── Listen for AI speech playback complete for Continuous Hands-Free ──────
  useEffect(() => {
    const handlePlaybackComplete = () => {
      if (isContinuousActiveRef.current) {
        tauriApi.setAiSpeaking(false).catch(() => {});
        // If mic is idle, re-open for the user's turn
        if (statusRef.current === 'idle') {
          setTimeout(() => {
            if (isContinuousActiveRef.current && statusRef.current === 'idle') {
              startRecordingRef.current();
            }
          }, 300);
        }
      }
    };

    window.addEventListener('speech-playback-complete', handlePlaybackComplete);
    return () => {
      window.removeEventListener('speech-playback-complete', handlePlaybackComplete);
    };
  }, []);

  // ─── If voice readout is turned off, disengage Continuous Mode and stop mic ─
  useEffect(() => {
    if (!settings.tts_enabled && isContinuousActive) {
      updateSettings({ continuous_voice: false });
      tauriApi.setContinuousMode(false).catch(() => {});
      if (statusRef.current === 'recording') {
        stopRecordingRef.current();
      }
    }
  }, [settings.tts_enabled, isContinuousActive, updateSettings]);

  // ─── Interaction Handlers ─────────────────────────────────────────────────

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!isPttMode) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);

    if (isHandlingClick.current) return;
    isHandlingClick.current = true;
    setTimeout(() => { isHandlingClick.current = false; }, 300);

    startRecording();
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!isPttMode) return;
    e.preventDefault();
    e.currentTarget.releasePointerCapture(e.pointerId);
    stopRecording();
  };

  const handleClick = (e: React.MouseEvent) => {
    if (isPttMode) return;
    e.preventDefault();

    if (isHandlingClick.current) return;
    isHandlingClick.current = true;
    setTimeout(() => { isHandlingClick.current = false; }, 300);

    // If AI is currently speaking, clicking the voice button immediately silences it
    if (useVoiceStore.getState().isSpeaking) {
      interruptAiSpeech(false);
      return;
    }

    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  const handleToggleContinuous = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const nextVal = !isContinuousActive;
    updateSettings({
      continuous_voice: nextVal,
      ...(nextVal ? { tts_enabled: true } : {})
    });
    tauriApi.setContinuousMode(nextVal).catch(() => {});

    if (nextVal) {
      if (status === 'idle') {
        setTimeout(() => {
          startRecording();
        }, 100);
      }
    } else {
      if (status === 'recording') {
        stopRecording();
      }
    }
  };

  if (!micAvailable) {
    return (
      <button
        disabled
        className={cn('p-2.5 rounded-xl text-zinc-600 cursor-not-allowed', className)}
        title="Microphone not available"
      >
        <MicOff size={18} />
      </button>
    );
  }

  return (
    <div className={cn('relative flex items-center gap-1.5', className)}>
      <AnimatePresence>
        {isRecording && (
          <motion.div
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: 'auto' }}
            exit={{ opacity: 0, width: 0 }}
            className="flex items-center gap-0.5 mr-1 overflow-hidden"
          >
            {waveformData.slice(0, 12).map((val, i) => (
              <motion.div
                key={i}
                animate={{ height: `${Math.max(4, val * 20)}px` }}
                transition={{ duration: 0.08 }}
                className={cn("w-0.5 rounded-full", isContinuousActive && isSpeaking ? "bg-amber-400" : "bg-violet-400")}
                style={{ minHeight: 4, maxHeight: 20 }}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Mic Toggle Button */}
      <motion.button
        type="button"
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={handleClick}
        whileTap={{ scale: 0.92 }}
        className={cn(
          'p-2 rounded-xl transition-all duration-150',
          isRecording
            ? (isContinuousActive && isSpeaking
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-[0_0_12px_rgba(245,158,11,0.25)] animate-pulse'
                : 'bg-red-500/20 text-red-400 border border-red-500/40 shadow-[0_0_12px_rgba(239,68,68,0.3)] animate-pulse')
            : isTranscribing
            ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40 animate-pulse-slow'
            : isContinuousActive
            ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/30'
            : 'text-zinc-400 hover:text-white hover:bg-white/8 border border-transparent'
        )}
        title={
          isRecording
            ? (isContinuousActive && isSpeaking
                ? 'Continuous Mode (Full-Duplex): AI is speaking... Speak into your mic to Barge-in & interrupt AI'
                : (isPttMode ? 'Release to send' : 'Listening... Click to finish speaking & send'))
            : isTranscribing
            ? 'Transcribing speech…'
            : isContinuousActive
            ? 'Continuous Voice ON: Click to talk / Click to stop'
            : (isPttMode ? 'Hold to record (PTT)' : 'Click to start recording')
        }
      >
        {isRecording
          ? <Square size={17} className={cn(isContinuousActive && isSpeaking ? "fill-amber-300" : "fill-red-400")} />
          : isTranscribing
          ? <Mic size={17} className="animate-pulse text-violet-400" />
          : <Mic size={17} />
        }
      </motion.button>

      {/* Continuous Hands-Free Conversation Toggle Pill */}
      <motion.button
        type="button"
        whileTap={{ scale: 0.94 }}
        onClick={handleToggleContinuous}
        className={cn(
          'hidden sm:flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all select-none',
          isContinuousActive
            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/35 shadow-[0_0_8px_rgba(16,185,129,0.2)] hover:bg-emerald-500/20'
            : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5 border border-white/5'
        )}
        title={
          isContinuousActive
            ? 'Continuous Hands-Free + Full-Duplex VAD Barge-in is ACTIVE: You can speak at any time, even while Morfeus is speaking, to instantly barge in and interrupt. Click to turn off.'
            : 'Click to enable Continuous Hands-Free Conversation with Full-Duplex VAD Barge-in'
        }
      >
        <InfinityIcon size={13} className={cn(isContinuousActive && 'text-emerald-400 animate-pulse')} />
        <span>Continuous</span>
      </motion.button>
    </div>
  );
};
