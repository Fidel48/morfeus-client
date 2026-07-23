import React, { useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useVoiceStore } from '@/stores/voiceStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { tauriApi } from '@/lib/tauri';

interface VoiceButtonProps {
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

const getSpeechRecognition = () => {
  if (typeof window === 'undefined') return false;
  // macOS WebKit crashes if we try to use webkitSpeechRecognition directly.
  // We MUST use the native fallback via Rust + MediaRecorder.
  const isMacOS = /Mac|iPhone|iPad|iPod/.test(navigator.platform) || 
                  (navigator.userAgent.includes('Mac') && !navigator.userAgent.includes('Chrome'));
  if (isMacOS) return false;
  return window.SpeechRecognition || window.webkitSpeechRecognition;
};

export const VoiceButton: React.FC<VoiceButtonProps> = ({ onTranscript, onAutoSend, className }) => {
  const { status, setStatus, micAvailable, waveformData, updateWaveform } = useVoiceStore();
  const { settings } = useSettingsStore();

  const isRecording = status === 'recording';
  const isTranscribing = status === 'transcribing';

  const isHandlingClick = useRef(false);
  const recognitionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waveformIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const usingNativeRef = useRef(false);

  const onTranscriptRef = useRef(onTranscript);
  const onAutoSendRef = useRef(onAutoSend);
  React.useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  React.useEffect(() => { onAutoSendRef.current = onAutoSend; }, [onAutoSend]);

  // ─── Native Tauri recording (macOS fallback using MediaRecorder) ──────────
  const startNativeRecording = useCallback(async () => {
    if (!micAvailable || status !== 'idle') return;

    try {
      usingNativeRef.current = true;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.start();
      setStatus('recording');

      waveformIntervalRef.current = setInterval(() => {
        updateWaveform(Array.from({ length: 20 }, () => Math.random()));
      }, 80);
    } catch (err: any) {
      console.error('MediaRecorder failed to start:', err);
      usingNativeRef.current = false;
      setStatus('idle');
    }
  }, [micAvailable, status, setStatus, updateWaveform]);

  const stopNativeRecording = useCallback(async () => {
    if (status !== 'recording' || !mediaRecorderRef.current) return;

    if (waveformIntervalRef.current) clearInterval(waveformIntervalRef.current);
    updateWaveform(new Array(20).fill(0));

    setStatus('transcribing');

    try {
      const mediaRecorder = mediaRecorderRef.current;
      const audioDataPromise = new Promise<string>((resolve, reject) => {
        mediaRecorder.onstop = () => {
          const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType || 'audio/mp4' });
          const reader = new FileReader();
          reader.readAsDataURL(audioBlob);
          reader.onloadend = () => {
            const base64data = (reader.result as string).split(',')[1];
            resolve(base64data);
          };
          reader.onerror = reject;
        };
      });

      mediaRecorder.stop();
      mediaRecorder.stream.getTracks().forEach(t => t.stop());

      const base64Wav = await audioDataPromise;
      const text = await tauriApi.transcribeNative(base64Wav);

      if (text.trim()) {
        onTranscriptRef.current(text.trim());
        setTimeout(() => {
          onAutoSendRef.current?.();
        }, 80);
      }
    } catch (err: any) {
      console.error('Native transcription failed:', err);
      alert('Transcription error: ' + (err?.message || err));
    } finally {
      usingNativeRef.current = false;
      mediaRecorderRef.current = null;
      setStatus('idle');
    }
  }, [status, setStatus, updateWaveform]);

  // ─── Browser SpeechRecognition (Windows / Chromium) ───────────────────
  const startBrowserRecording = useCallback(() => {
    const SR = getSpeechRecognition();
    if (!SR || !micAvailable || status !== 'idle') return;

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';

    let fullTranscript = '';

    const resetSilenceTimer = () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => {
        if (recognitionRef.current) recognitionRef.current.stop();
      }, 3500);
    };

    rec.onstart = () => {
      setStatus('recording');
      resetSilenceTimer();
      waveformIntervalRef.current = setInterval(() => {
        updateWaveform(Array.from({ length: 20 }, () => Math.random()));
      }, 80);
    };

    rec.onresult = (event: any) => {
      resetSilenceTimer();
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }

      if (finalTranscript) fullTranscript += (fullTranscript ? ' ' : '') + finalTranscript;
      
      const currentText = fullTranscript + (interimTranscript ? ' ' + interimTranscript : '');
      onTranscriptRef.current(currentText.trim());
    };

    rec.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error);
    };

    rec.onend = () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (waveformIntervalRef.current) clearInterval(waveformIntervalRef.current);
      updateWaveform(new Array(20).fill(0));
      setStatus('idle');
      
      setTimeout(() => {
        if (fullTranscript.trim()) onAutoSendRef.current?.();
      }, 100);
    };

    try {
      rec.start();
      recognitionRef.current = rec;
      usingNativeRef.current = false;
    } catch (e) {
      console.error('Failed to start recognition:', e);
    }
  }, [micAvailable, status, setStatus, updateWaveform]);

  const stopBrowserRecording = useCallback(() => {
    if (status !== 'recording' || !recognitionRef.current) return;
    recognitionRef.current.stop();
  }, [status]);

  const startRecording = useCallback(() => {
    const SR = getSpeechRecognition();
    if (SR) startBrowserRecording();
    else startNativeRecording();
  }, [startBrowserRecording, startNativeRecording]);

  const stopRecording = useCallback(() => {
    if (status !== 'recording') return;
    if (usingNativeRef.current) stopNativeRecording();
    else stopBrowserRecording();
  }, [status, stopNativeRecording, stopBrowserRecording]);

  // ─── Interaction Handlers ──────────────────────────────────────────────


  // ─── Interaction Handlers ──────────────────────────────────────────────

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    console.log('[VoiceButton] handlePointerDown fired. ptt_mode:', settings.ptt_mode);
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
    console.log('[VoiceButton] handleClick fired. ptt_mode:', settings.ptt_mode, 'isRecording:', isRecording);
    // If we are in PTT mode, normal clicks are handled by Pointer events, 
    // but just in case they click super fast, we shouldn't start a permanent recording.
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
            ? 'Sending…'
            : (settings.ptt_mode ? 'Hold to record (PTT)' : 'Click to start recording')
        }
      >
        {isRecording ? <Square size={18} className="fill-red-400" /> : <Mic size={18} />}
      </motion.button>
    </div>
  );
};
