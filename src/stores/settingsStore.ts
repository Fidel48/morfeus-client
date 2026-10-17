import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { AppSettings, Model } from '@/types';
import { tauriApi } from '@/lib/tauri';
import { fetchModels } from '@/lib/api';

const DEFAULT_SETTINGS: AppSettings = {
  base_url: 'http://localhost:1234/v1',
  api_key: '',
  model_id: '',
  fast_chat_model_id: '',
  agent_coder_model_id: '',
  temperature: 0.7,
  top_p: 1.0,
  max_tokens: 2048,
  context_length: 8192,
  frequency_penalty: 0.3,
  system_prompt: 'You are a helpful AI assistant.',
  tts_enabled: true,
  tts_voice: 'af_heart',   // Kokoro default — Heart voice
  tts_rate: 1.0,
  tts_volume: 1.0,
  stt_model_path: '',
  ptt_mode: false,
  continuous_voice: false,
  think_enabled: true,
  debug_mode: false,
};

interface SettingsStore {
  settings: AppSettings;
  isLoaded: boolean;
  isSettingsOpen: boolean;
  availableModels: Model[];
  isLoadingModels: boolean;
  updateSettings: (partial: Partial<AppSettings>) => void;
  loadFromBackend: () => Promise<void>;
  saveToBackend: () => Promise<void>;
  openSettings: () => void;
  closeSettings: () => void;
  setAvailableModels: (models: Model[]) => void;
  fetchAvailableModels: () => Promise<Model[]>;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      isLoaded: false,
      isSettingsOpen: false,
      availableModels: [],
      isLoadingModels: false,

      updateSettings: (partial) => {
        set((state) => ({
          settings: { ...state.settings, ...partial },
        }));
      },

      setAvailableModels: (models) => set({ availableModels: models }),

      fetchAvailableModels: async () => {
        const { settings } = get();
        if (!settings.base_url) return [];
        set({ isLoadingModels: true });
        try {
          const models = await fetchModels(settings.base_url, settings.api_key);
          set({ availableModels: models, isLoadingModels: false });
          return models;
        } catch (e) {
          console.warn('[SettingsStore] Failed to fetch models:', e);
          set({ isLoadingModels: false });
          return [];
        }
      },

      loadFromBackend: async () => {
        try {
          const settings = await tauriApi.getSettings();
          set({ settings, isLoaded: true });
          // Pre-fetch models on settings load
          get().fetchAvailableModels().catch(() => {});
        } catch {
          set({ isLoaded: true });
          get().fetchAvailableModels().catch(() => {});
        }
      },

      saveToBackend: async () => {
        const { settings } = get();
        try {
          await tauriApi.saveSettings(settings);
          get().fetchAvailableModels().catch(() => {});
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
