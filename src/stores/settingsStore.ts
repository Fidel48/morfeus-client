import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { AppSettings } from '@/types';
import { tauriApi } from '@/lib/tauri';

const DEFAULT_SETTINGS: AppSettings = {
  base_url: 'http://localhost:1234/v1',
  api_key: '',
  model_id: '',
  temperature: 0.7,
  top_p: 1.0,
  max_tokens: 2048,
  context_length: 8192,
  frequency_penalty: 0.0,
  system_prompt: 'You are a helpful AI assistant.',
  tts_enabled: false,
  tts_voice: '',
  tts_rate: 1.0,
  tts_volume: 1.0,
  stt_model_path: '',
  ptt_mode: true,
};

interface SettingsStore {
  settings: AppSettings;
  isLoaded: boolean;
  isSettingsOpen: boolean;
  updateSettings: (partial: Partial<AppSettings>) => void;
  loadFromBackend: () => Promise<void>;
  saveToBackend: () => Promise<void>;
  openSettings: () => void;
  closeSettings: () => void;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      isLoaded: false,
      isSettingsOpen: false,

      updateSettings: (partial) => {
        set((state) => ({
          settings: { ...state.settings, ...partial },
        }));
      },

      loadFromBackend: async () => {
        try {
          const settings = await tauriApi.getSettings();
          set({ settings, isLoaded: true });
        } catch {
          set({ isLoaded: true });
        }
      },

      saveToBackend: async () => {
        const { settings } = get();
        try {
          await tauriApi.saveSettings(settings);
        } catch (e) {
          console.error('Failed to save settings:', e);
        }
      },

      openSettings: () => set({ isSettingsOpen: true }),
      closeSettings: () => set({ isSettingsOpen: false }),
    }),
    {
      name: 'morfeus-settings',
      partialize: (state) => ({ settings: state.settings }),
    }
  )
);
