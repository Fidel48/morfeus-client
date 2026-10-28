/**
 * kokoroTts.ts
 *
 * Kokoro Neural TTS client for Morfeus.
 * Communicates with the local Kokoro neural TTS server running on port 8880.
 * Audio is synthesized with ONNX v1.0 weights and played natively via afplay on macOS.
 *
 * ⚠️ DO NOT modify the STT (speech-to-text) pipeline — this only handles TTS output.
 */

import { tauriApi } from './tauri';
import { useVoiceStore } from '@/stores/voiceStore';

// ── Voice registry ─────────────────────────────────────────────────────────────

export interface KokoroVoice {
  id: string;          // e.g. "af_heart"
  label: string;       // Display name e.g. "Heart"
  gender: 'female' | 'male';
  accent: 'American' | 'British';
  emoji?: string;
}

export const KOKORO_VOICES: KokoroVoice[] = [
  { id: 'af_heart',   label: 'Heart',   gender: 'female', accent: 'American', emoji: '❤️' },
  { id: 'af_bella',   label: 'Bella',   gender: 'female', accent: 'American', emoji: '🌸' },
  { id: 'af_nicole',  label: 'Nicole',  gender: 'female', accent: 'American', emoji: '✨' },
  { id: 'af_sarah',   label: 'Sarah',   gender: 'female', accent: 'American', emoji: '🌿' },
  { id: 'af_sky',     label: 'Sky',     gender: 'female', accent: 'American', emoji: '🌤️' },
  { id: 'af_aoede',   label: 'Aoede',   gender: 'female', accent: 'American', emoji: '🎵' },
  { id: 'af_jessica', label: 'Jessica', gender: 'female', accent: 'American', emoji: '💫' },
  { id: 'af_kore',    label: 'Kore',    gender: 'female', accent: 'American', emoji: '🌙' },
  { id: 'af_river',   label: 'River',   gender: 'female', accent: 'American', emoji: '🏞️' },
  { id: 'am_adam',    label: 'Adam',    gender: 'male',   accent: 'American', emoji: '🎙️' },
  { id: 'am_echo',    label: 'Echo',    gender: 'male',   accent: 'American', emoji: '📡' },
  { id: 'am_eric',    label: 'Eric',    gender: 'male',   accent: 'American', emoji: '🔵' },
  { id: 'am_fenrir',  label: 'Fenrir',  gender: 'male',   accent: 'American', emoji: '🐺' },
  { id: 'am_liam',    label: 'Liam',    gender: 'male',   accent: 'American', emoji: '🧊' },
  { id: 'am_michael', label: 'Michael', gender: 'male',   accent: 'American', emoji: '🎧' },
  { id: 'am_onyx',    label: 'Onyx',    gender: 'male',   accent: 'American', emoji: '🖤' },
  { id: 'bf_emma',    label: 'Emma',    gender: 'female', accent: 'British',  emoji: '🫖' },
  { id: 'bf_alice',   label: 'Alice',   gender: 'female', accent: 'British',  emoji: '🌹' },
  { id: 'bf_isabella',label: 'Isabella',gender: 'female', accent: 'British',  emoji: '💜' },
  { id: 'bf_lily',    label: 'Lily',    gender: 'female', accent: 'British',  emoji: '🌷' },
  { id: 'bm_george',  label: 'George',  gender: 'male',   accent: 'British',  emoji: '🏰' },
  { id: 'bm_lewis',   label: 'Lewis',   gender: 'male',   accent: 'British',  emoji: '🎩' },
];

export const DEFAULT_KOKORO_VOICE = 'af_heart';

export type EngineState = 'idle' | 'loading' | 'ready' | 'error';

let _engineState: EngineState = 'idle';
let _engineError: string | null = null;
let _onStateChange: ((state: EngineState, err?: string) => void) | null = null;

export function setEngineStateCallback(cb: (state: EngineState, err?: string) => void) {
  _onStateChange = cb;
}

function notifyState(state: EngineState, err?: string) {
  _engineState = state;
  _engineError = err ?? null;
  _onStateChange?.(state, err);
}

export function getEngineState(): { state: EngineState; error: string | null } {
  return { state: _engineState, error: _engineError };
}

/**
 * Check if the Kokoro server is running, or launch it.
 */
export async function ensureKokoroServer(): Promise<boolean> {
  try {
    notifyState('loading');
    const running = await tauriApi.isKokoroRunning();
    if (running) {
      notifyState('ready');
      return true;
    }
    const started = await tauriApi.startKokoroServer();
    if (started) {
      notifyState('ready');
      return true;
    }
    notifyState('error', 'Server starting...');
    return false;
  } catch (err: any) {
    notifyState('error', String(err?.message ?? err));
    return false;
  }
}

/**
 * Clean markdown symbols from text so it reads naturally.
 */
function cleanTextForSpeech(text: string): string {
  // If the text is purely a Sources / Resources heading or bullet point, skip speaking
  if (/^(?:#+\s*)?(?:Sources|Resources|References|Source Links|Citations)[\s:]*$/i.test(text.trim())) {
    return '';
  }
  // If text is a source list entry like "1. [Title](url)" or "- [Title](url)" or purely a URL, skip speaking
  if (/^[-*0-9.]+\s*\[[^\]]+\]\(https?:\/\/[^)]+\)/i.test(text.trim()) || /^https?:\/\/\S+$/i.test(text.trim())) {
    return '';
  }

  let cleaned = text
    .replace(/```[\s\S]*?```/g, '') // Remove code blocks
    .replace(/`[^`]+`/g, '')        // Remove inline code
    .replace(/https?:\/\/\S+/gi, '') // Strip raw URLs so they are not spoken aloud
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Links → title text only
    .replace(/\*\*([^*]+)\*\*/g, '$1') // Bold → plain
    .replace(/\*([^*]+)\*/g, '$1')    // Italic → plain
    .replace(/#+\s/g, '')            // Headings → plain
    .replace(/>\s/g, '')             // Blockquotes
    .replace(/[-*+]\s/g, '')         // List bullets
    .replace(/\n{2,}/g, '. ')        // Double newlines → pause
    .replace(/\n/g, ' ')
    .trim();

  // If after stripping URLs nothing or only punctuation/numbers remain, skip
  if (/^[\s\d.,:;!?()[\]{}"'\\/-]*$/.test(cleaned)) {
    return '';
  }

  return cleaned;
}

/**
 * Speak text using Kokoro Neural TTS.
 * Falls back to native OS speech (say / SAPI) if the Kokoro server is not yet ready.
 */
export async function kokoroSpeak(
  text: string,
  voiceId: string = DEFAULT_KOKORO_VOICE,
  rate: number = 1.0
): Promise<void> {
  const clean = cleanTextForSpeech(text);
  if (!clean) return;

  try {
    useVoiceStore.getState().setIsSpeaking(true);
    tauriApi.setAiSpeaking(true).catch(() => {});
    // Try native Kokoro server first
    await tauriApi.kokoroSpeak(clean, voiceId, rate);
    notifyState('ready');
  } catch (err) {
    console.warn('[Kokoro TTS] Local server not reachable, falling back to OS speech:', err);
    notifyState('error', 'Using system voice fallback');
    // Graceful fallback to OS TTS
    await tauriApi.speakText(clean, rate, voiceId);
  } finally {
    useVoiceStore.getState().setIsSpeaking(false);
    tauriApi.setAiSpeaking(false).catch(() => {});
  }
}

/**
 * Play a voice preview sample.
 */
export async function kokoroPreview(
  voiceId: string = DEFAULT_KOKORO_VOICE,
  rate: number = 1.0
): Promise<void> {
  try {
    await tauriApi.kokoroPreview(voiceId, rate);
  } catch (err) {
    console.warn('[Kokoro Preview] Fallback preview:', err);
    const voice = KOKORO_VOICES.find(v => v.id === voiceId);
    const phrase = `Hi, I'm ${voice?.label ?? 'your assistant'}. How can I help you today?`;
    await tauriApi.speakText(phrase, rate, voiceId);
  }
}

/**
 * Stop any currently playing audio immediately.
 */
export function kokoroStop(): void {
  speechQueue.stop();
  tauriApi.stopSpeaking().catch(() => {});
  tauriApi.setAiSpeaking(false).catch(() => {});
  try {
    useVoiceStore.getState().setIsSpeaking(false);
  } catch {}
}

/**
 * Global interruption helper: instantly stops all audio playback,
 * purges queued speech sentences, and updates global voice store.
 * If abortChat is true, notifies chat to cancel streaming.
 */
export function interruptAiSpeech(abortChat = false): void {
  speechQueue.stop();
  tauriApi.stopSpeaking().catch(() => {});
  tauriApi.setAiSpeaking(false).catch(() => {});
  try {
    useVoiceStore.getState().setIsSpeaking(false);
  } catch {}
  if (abortChat && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('morfeus-interrupt-chat'));
  }
}

/**
 * Pre-warm the server on app boot.
 */
export function preloadKokoroEngine(): void {
  ensureKokoroServer().catch(() => {});
}

/**
 * Sentence-streaming speech queue for near-zero latency voice playback.
 * Synthesizes and plays sentence by sentence as tokens arrive from the LLM.
 */
export class SpeechQueue {
  private queue: string[] = [];
  private isProcessing = false;
  private voice: string;
  private rate: number;
  private aborted = false;
  private textBuffer = '';
  private isFlushed = false;
  private reachedResources = false;
  private generation = 0;

  constructor(voice: string = DEFAULT_KOKORO_VOICE, rate: number = 1.0) {
    this.voice = voice;
    this.rate = rate;
  }

  public setVoice(voice: string) {
    this.voice = voice;
  }

  public setRate(rate: number) {
    this.rate = rate;
  }

  /**
   * Feed streaming tokens as they arrive from the LLM.
   * Extracts completed sentences and queues them for immediate playback.
   */
  public feedToken(token: string) {
    if (this.aborted || this.reachedResources) return;
    this.isFlushed = false;
    this.textBuffer += token;

    // Detect if model transitioned into the Sources/Resources/References section
    const resourcesIndex = this.textBuffer.search(/\n(?:\s*[-*#]+\s*)?(?:Sources|Resources|References|Source Links|Citations):?/i);
    if (resourcesIndex !== -1) {
      // Discard text from sources onwards for speech
      this.textBuffer = this.textBuffer.slice(0, resourcesIndex);
      this.reachedResources = true;
      this.extractSentences(true);
      return;
    }

    this.extractSentences(false);
  }

  /**
   * Flush remaining text at the end of LLM generation.
   */
  public flush() {
    if (this.aborted) {
      this.notifyPlaybackComplete();
      return;
    }
    this.isFlushed = true;
    this.extractSentences(true);

    if (!this.isProcessing && this.queue.length === 0) {
      this.isFlushed = false;
      this.notifyPlaybackComplete();
    }
  }

  private notifyPlaybackComplete() {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('speech-playback-complete'));
    }
  }

  private extractSentences(flushAll: boolean) {
    // Strip completed code blocks immediately from the audio speech buffer
    this.textBuffer = this.textBuffer.replace(/```[\s\S]*?```/g, ' ');

    if (flushAll) {
      // Strip any unclosed trailing code block
      const remaining = this.textBuffer.replace(/```[\s\S]*/g, ' ').trim();
      if (remaining.length > 0) {
        this.push(remaining);
      }
      this.textBuffer = '';
      return;
    }

    // Check if we are currently inside an open markdown code block
    const codeBlockCount = (this.textBuffer.match(/```/g) || []).length;
    const isInsideCodeBlock = codeBlockCount % 2 !== 0;

    if (isInsideCodeBlock) {
      // Don't extract sentences while code block is still generating
      return;
    }

    // Split on sentence boundaries: [.!?] followed by whitespace or newline, or double newline
    const sentenceRegex = /([.!?]+(?:\s+|\n+)|(?:\n\n+))/g;
    let match: RegExpExecArray | null;
    let lastIndex = 0;

    while ((match = sentenceRegex.exec(this.textBuffer)) !== null) {
      const candidate = this.textBuffer.slice(lastIndex, match.index + match[0].length).trim();
      
      // Basic abbreviation guard: avoid splitting on "e.g.", "i.e.", "v0.", etc.
      if (candidate.length >= 3 && !/\b(?:e\.g|i\.e|mr|mrs|dr|vs|v0|v1)\.$/i.test(candidate)) {
        this.push(candidate);
        lastIndex = match.index + match[0].length;
      }
    }

    if (lastIndex > 0) {
      this.textBuffer = this.textBuffer.slice(lastIndex);
    }
  }

  public push(text: string) {
    if (this.aborted) return;
    const clean = cleanTextForSpeech(text);
    if (!clean || clean.length < 2) return;
    this.queue.push(clean);
    if (!this.isProcessing) {
      this.processQueue();
    }
  }

  private async processQueue() {
    if (this.isProcessing || this.aborted) return;
    this.isProcessing = true;
    const currentGen = this.generation;
    try {
      useVoiceStore.getState().setIsSpeaking(true);
      tauriApi.setAiSpeaking(true).catch(() => {});
    } catch {}

    while (this.queue.length > 0 && !this.aborted && this.generation === currentGen) {
      const sentence = this.queue.shift();
      if (!sentence) continue;

      try {
        await tauriApi.kokoroSpeak(sentence, this.voice, this.rate);
      } catch (err) {
        if (this.aborted || this.generation !== currentGen) return;
        console.warn('[SpeechQueue] Kokoro speak failed, fallback to native:', err);
        try {
          await tauriApi.speakText(sentence, this.rate, this.voice);
        } catch { /* ignore */ }
      }

      if (this.aborted || this.generation !== currentGen) break;
    }

    if (this.generation === currentGen) {
      this.isProcessing = false;
      try {
        useVoiceStore.getState().setIsSpeaking(false);
        tauriApi.setAiSpeaking(false).catch(() => {});
      } catch {}
    }

    if (this.isFlushed && this.queue.length === 0 && !this.aborted && this.generation === currentGen) {
      this.isFlushed = false;
      this.notifyPlaybackComplete();
    }
  }

  public stop() {
    this.generation++;
    this.aborted = true;
    this.isFlushed = false;
    this.reachedResources = false;
    this.queue = [];
    this.textBuffer = '';
    this.isProcessing = false;
    try {
      useVoiceStore.getState().setIsSpeaking(false);
      tauriApi.setAiSpeaking(false).catch(() => {});
    } catch {}
    tauriApi.stopSpeaking().catch(() => {});
  }

  public reset() {
    this.generation++;
    this.aborted = false;
    this.isFlushed = false;
    this.reachedResources = false;
    this.queue = [];
    this.textBuffer = '';
    this.isProcessing = false;
  }
}

export const speechQueue = new SpeechQueue();
