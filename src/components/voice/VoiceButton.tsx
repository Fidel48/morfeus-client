import React, { useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useVoiceStore } from '@/stores/voiceStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { tauriApi } from '@/lib/tauri';

interface VoiceButtonProps {
  currentInput?: string;
  onTranscript: (text: string) => void;
  onAutoSend?: () => void;
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
  const { status, setStatus, micAvailable, setMicAvailable, waveformData, updateWaveform } = useVoiceStore();
  const { settings } = useSettingsStore();

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
  React.useEffect(() => { currentInputRef.current = currentInput; }, [currentInput]);
  React.useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  React.useEffect(() => { onAutoSendRef.current = onAutoSend; }, [onAutoSend]);

  React.useEffect(() => {
    setMicAvailable(true);
  }, [setMicAvailable]);

  // Cleanup on unmount
  React.useEffect(() => {
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
  // On macOS WKWebView, browser webkitSpeechRecognition crashes WKWebView.
  // Instead, we capture audio natively via Rust (cpal) and transcribe it using
  // Apple's built-in macOS SFSpeechRecognizer Swift engine. 100% native, zero crash.
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
        if (text && text.trim()) {
          onTranscriptRef.current(text.trim());
          setTimeout(() => {
            onAutoSendRef.current?.();
          }, 100);
        }
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
        }, 3500);
      };

      rec.onstart = () => {
        initialInput = currentInputRef.current.trim();
        setStatus('recording');
        resetSilenceTimer();
        startWaveform();
      };

      rec.onresult = (event: any) => {
        resetSilenceTimer();
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
          setTimeout(() => {
            onAutoSendRef.current?.();
          }, 100);
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

  // ─── Interaction Handlers ─────────────────────────────────────────────────

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!settings.ptt_mode) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);

    if (isHandlingClick.current) return;
    isHandlingClick.current = true;
    setTimeout(() => { isHandlingClick.current = false; }, 300);

    startRecording();
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!settings.ptt_mode) return;
    e.preventDefault();
    e.currentTarget.releasePointerCapture(e.pointerId);
    stopRecording();
  };

  const handleClick = (e: React.MouseEvent) => {
    if (settings.ptt_mode) return;
    e.preventDefault();

    if (isHandlingClick.current) return;
    isHandlingClick.current = true;
    setTimeout(() => { isHandlingClick.current = false; }, 300);

    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
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
    <div className={cn('relative flex items-center', className)}>
      <AnimatePresence>
        {isRecording && (
          <motion.div
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: 'auto' }}
            exit={{ opacity: 0, width: 0 }}
            className="flex items-center gap-0.5 mr-2 overflow-hidden"
          >
            {waveformData.slice(0, 12).map((val, i) => (
              <motion.div
                key={i}
                animate={{ height: `${Math.max(4, val * 20)}px` }}
                transition={{ duration: 0.08 }}
                className="w-0.5 bg-violet-400 rounded-full"
                style={{ minHeight: 4, maxHeight: 20 }}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={handleClick}
        whileTap={{ scale: 0.92 }}
        className={cn(
          'p-2.5 rounded-xl transition-all duration-150',
          isRecording
            ? 'bg-red-500/20 text-red-400 border border-red-500/40 shadow-[0_0_12px_rgba(239,68,68,0.3)]'
            : isTranscribing
            ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40 animate-pulse-slow'
            : 'text-zinc-400 hover:text-white hover:bg-white/8 border border-transparent'
        )}
        title={
          isRecording
            ? (settings.ptt_mode ? 'Release to send' : 'Click to stop & send')
            : isTranscribing
            ? 'Transcribing with Apple Speech…'
            : (settings.ptt_mode ? 'Hold to record (PTT)' : 'Click to start recording')
        }
      >
        {isRecording
          ? <Square size={18} className="fill-red-400" />
          : isTranscribing
          ? <Mic size={18} className="animate-pulse text-violet-400" />
          : <Mic size={18} />
        }
      </motion.button>
    </div>
  );
};
