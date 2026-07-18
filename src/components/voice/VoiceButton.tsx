import React, { useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useVoiceStore } from '@/stores/voiceStore';
import { useSettingsStore } from '@/stores/settingsStore';

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

const getSpeechRecognition = () =>
  typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

export const VoiceButton: React.FC<VoiceButtonProps> = ({ onTranscript, onAutoSend, className }) => {
  const { status, setStatus, micAvailable, waveformData, updateWaveform } = useVoiceStore();
  const { settings } = useSettingsStore();

  const isRecording = status === 'recording';
  const isTranscribing = status === 'transcribing';

  const isHandlingClick = useRef(false);
  const recognitionRef = useRef<any>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waveformIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Use refs to always have the latest callbacks — avoids stale closures entirely
  const onTranscriptRef = useRef(onTranscript);
  const onAutoSendRef = useRef(onAutoSend);
  React.useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  React.useEffect(() => { onAutoSendRef.current = onAutoSend; }, [onAutoSend]);

  const startRecording = useCallback(() => {
    const SR = getSpeechRecognition();
    if (!SR) {
      alert('Your browser does not support speech recognition.');
      return;
    }
    if (!micAvailable || status !== 'idle') return;

    // ── Create a FRESH instance every session — no stale closures ──────────
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';

    let fullTranscript = '';

    // Silence detection: stop automatically after 3.5s of no speech
    const resetSilenceTimer = () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => {
        rec.stop();
      }, 3500);
    };

    rec.onstart = () => {
      resetSilenceTimer();
    };

    rec.onresult = (event: any) => {
      // Reset silence timer on every new word
      resetSilenceTimer();
      // Accumulate the entire transcript across all result chunks
      fullTranscript = Array.from(event.results as SpeechRecognitionResultList)
        .map((r: SpeechRecognitionResult) => r[0].transcript)
        .join('');
    };

    // onend is the ONLY place we dispatch the transcript — guaranteed to fire
    rec.onend = () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (waveformIntervalRef.current) clearInterval(waveformIntervalRef.current);
      updateWaveform(new Array(20).fill(0));

      const text = fullTranscript.trim();
      if (text) {
        // 1. Put text into the input box
        onTranscriptRef.current(text);
        // 2. Wait 80ms for React state to update, then auto-send
        setTimeout(() => {
          onAutoSendRef.current?.();
        }, 80);
      }

      setStatus('idle');
    };

    rec.onerror = (e: any) => {
      console.error('Speech recognition error:', e.error);
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (waveformIntervalRef.current) clearInterval(waveformIntervalRef.current);
      updateWaveform(new Array(20).fill(0));
      setStatus('idle');
    };

    // Store ref and start
    recognitionRef.current = rec;
    rec.start();

    setStatus('recording');

    // Animate the waveform bars while recording
    waveformIntervalRef.current = setInterval(() => {
      updateWaveform(Array.from({ length: 20 }, () => Math.random()));
    }, 80);
  }, [micAvailable, status, setStatus, updateWaveform]);

  const stopRecording = useCallback(() => {
    if (status !== 'recording') return;
    // Stopping rec fires onend, which handles transcript dispatch
    recognitionRef.current?.stop();
  }, [status]);

  // ─── Interaction Handlers ──────────────────────────────────────────────

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
