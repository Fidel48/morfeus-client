import { create } from 'zustand';
import { VoiceStatus } from '@/types';

interface VoiceStore {
  status: VoiceStatus;
  transcript: string;
  isAutoSpeak: boolean;
  availableVoices: string[];
  selectedVoice: string;
  ttsRate: number;
  micAvailable: boolean;
  waveformData: number[];

  setStatus: (status: VoiceStatus) => void;
  setTranscript: (transcript: string) => void;
  setAutoSpeak: (enabled: boolean) => void;
  setAvailableVoices: (voices: string[]) => void;
  setSelectedVoice: (voice: string) => void;
  setTtsRate: (rate: number) => void;
  setMicAvailable: (available: boolean) => void;
  updateWaveform: (data: number[]) => void;
  clearTranscript: () => void;
}

export const useVoiceStore = create<VoiceStore>((set) => ({
  status: 'idle',
  transcript: '',
  isAutoSpeak: false,
  availableVoices: [],
  selectedVoice: '',
  ttsRate: 1.0,
  micAvailable: false,
  waveformData: new Array(20).fill(0),

  setStatus: (status) => set({ status }),
  setTranscript: (transcript) => set({ transcript }),
  setAutoSpeak: (isAutoSpeak) => set({ isAutoSpeak }),
  setAvailableVoices: (availableVoices) => set({ availableVoices }),
  setSelectedVoice: (selectedVoice) => set({ selectedVoice }),
  setTtsRate: (ttsRate) => set({ ttsRate }),
  setMicAvailable: (micAvailable) => set({ micAvailable }),
  updateWaveform: (waveformData) => set({ waveformData }),
  clearTranscript: () => set({ transcript: '' }),
}));
