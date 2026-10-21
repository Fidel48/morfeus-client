import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { AppSettings, Model, ModelCatalogItem, ModelProviderConfig, ProviderType } from '@/types';
import { tauriApi } from '@/lib/tauri';
import { fetchModels, testConnection } from '@/lib/api';

export const DEFAULT_PROVIDERS: ModelProviderConfig[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'deepseek',
    base_url: 'https://api.deepseek.com/v1',
    api_key: '',
    enabled: true,
    is_custom: false,
    models: [],
    status: 'untested',
  },
  {
    id: 'openrouter',
    name: 'openrouter',
    type: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    api_key: '',
    enabled: true,
    is_custom: false,
    models: [],
    status: 'untested',
  },
  {
    id: 'ollama',
    name: 'ollama',
    type: 'ollama',
    base_url: 'http://localhost:11434/v1',
    api_key: '',
    enabled: true,
    is_custom: true,
    models: [],
    status: 'untested',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    type: 'lmstudio',
    base_url: 'http://localhost:1234/v1',
    api_key: '',
    enabled: true,
    is_custom: true,
    models: [],
    status: 'untested',
  },
];

export const PROVIDER_PRESETS: Array<{
  type: ProviderType;
  name: string;
  base_url: string;
  defaultModels: ModelCatalogItem[];
  is_custom: boolean;
}> = [
  {
    type: 'openrouter',
    name: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    defaultModels: [],
    is_custom: false,
  },
  {
    type: 'deepseek',
    name: 'DeepSeek',
    base_url: 'https://api.deepseek.com/v1',
    defaultModels: [],
    is_custom: false,
  },
  {
    type: 'ollama',
    name: 'ollama',
    base_url: 'http://localhost:11434/v1',
    defaultModels: [],
    is_custom: true,
  },
  {
    type: 'lmstudio',
    name: 'LM Studio',
    base_url: 'http://localhost:1234/v1',
    defaultModels: [],
    is_custom: true,
  },
  {
    type: 'openai',
    name: 'OpenAI',
    base_url: 'https://api.openai.com/v1',
    defaultModels: [],
    is_custom: false,
  },
  {
    type: 'groq',
    name: 'Groq',
    base_url: 'https://api.groq.com/openai/v1',
    defaultModels: [],
    is_custom: false,
  },
  {
    type: 'custom',
    name: 'Custom Provider',
    base_url: 'http://localhost:8000/v1',
    defaultModels: [],
    is_custom: true,
  },
];

/**
 * Unselected dummy models that were previously hardcoded in DEFAULT_PROVIDERS.
 * Used to clean up previously persisted state so unselected models don't pollute the UI.
 */
const UNSELECTED_DUMMY_MODEL_IDS = new Set([
  'nvidia/nemotron-3-super-120b-a1',
  'nvidia/nemotron-3-ultra-550b-a5',
  'meta-llama/llama-3.3-70b-instruct',
  'anthropic/claude-3.5-sonnet',
  'deepseek/deepseek-r1',
  'deepseek-chat',
  'deepseek-reasoner',
  'llama3:latest',
  'qwen2.5-coder:latest',
  'deepseek-r1:latest',
  'mistral:latest',
  'local-model',
  'custom-model',
]);

export function sanitizeStoredProviders(providers: ModelProviderConfig[]): ModelProviderConfig[] {
  if (!Array.isArray(providers) || providers.length === 0) {
    return DEFAULT_PROVIDERS;
  }

  return providers.map((prov) => {
    // If a cloud provider has no API key configured, clear its models list
    const isLocal = prov.type === 'ollama' || prov.type === 'lmstudio' || prov.is_custom;
    if (!isLocal && (!prov.api_key || prov.api_key.trim() === '')) {
      return { ...prov, models: [] };
    }

    // Prune the unselected dummy models that were previously seeded by default
    if (prov.models && prov.models.length > 0) {
      const cleaned = prov.models.filter((m) => !UNSELECTED_DUMMY_MODEL_IDS.has(m.id));
      return { ...prov, models: cleaned };
    }

    return prov;
  });
}

export function sanitizeAppSettings(settings: AppSettings): AppSettings {
  const sanitizedProviders = sanitizeStoredProviders(settings.providers || DEFAULT_PROVIDERS);

  const configuredModelIds = new Set<string>();
  for (const prov of sanitizedProviders) {
    for (const m of prov.models || []) {
      if (m.id) configuredModelIds.add(m.id);
    }
  }

  // Clear hardcoded model IDs if they were defaults or not present in configured models
  let fastChatModelId = settings.fast_chat_model_id || '';
  let fastChatProviderId = settings.fast_chat_provider_id || '';
  if (
    fastChatModelId === 'llama3:latest' ||
    fastChatModelId === 'deepseek-r1:latest' ||
    (fastChatModelId && !configuredModelIds.has(fastChatModelId))
  ) {
    fastChatModelId = '';
    fastChatProviderId = '';
  }

  let agentCoderModelId = settings.agent_coder_model_id || '';
  let agentCoderProviderId = settings.agent_coder_provider_id || '';
  if (
    agentCoderModelId === 'llama3:latest' ||
    agentCoderModelId === 'deepseek-r1:latest' ||
    (agentCoderModelId && !configuredModelIds.has(agentCoderModelId))
  ) {
    agentCoderModelId = '';
    agentCoderProviderId = '';
  }

  let modelId = settings.model_id || '';
  if (modelId === 'llama3:latest' || (modelId && !configuredModelIds.has(modelId))) {
    modelId = '';
  }

  return {
    ...settings,
    model_id: modelId,
    fast_chat_model_id: fastChatModelId,
    fast_chat_provider_id: fastChatProviderId,
    agent_coder_model_id: agentCoderModelId,
    agent_coder_provider_id: agentCoderProviderId,
    providers: sanitizedProviders,
  };
}

const DEFAULT_SETTINGS: AppSettings = {
  base_url: 'http://localhost:11434/v1',
  api_key: '',
  model_id: '',
  fast_chat_model_id: '',
  fast_chat_provider_id: '',
  agent_coder_model_id: '',
  agent_coder_provider_id: '',
  providers: DEFAULT_PROVIDERS,
  temperature: 0.7,
  top_p: 1.0,
  max_tokens: 2048,
  context_length: 8192,
  frequency_penalty: 0.3,
  system_prompt: 'You are a helpful AI assistant.',
  tts_enabled: false,
  tts_voice: 'af_heart', // Kokoro default — Heart voice
  tts_rate: 1.0,
  tts_volume: 1.0,
  stt_model_path: '',
  ptt_mode: false,
  continuous_voice: false,
  think_enabled: true,
  debug_mode: false,
};

export interface ConfiguredModelOption {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  isOnline: boolean;
}

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

  // Multi-provider actions
  addProvider: (provider: ModelProviderConfig) => void;
  updateProvider: (id: string, patch: Partial<ModelProviderConfig>) => void;
  updateProviderRuntime: (id: string, patch: Partial<ModelProviderConfig>) => void;
  deleteProvider: (id: string) => void;
  testProviderConnection: (id: string) => Promise<{ success: boolean; message: string }>;
  fetchProviderModels: (id: string) => Promise<ModelCatalogItem[]>;
  restoreProviderDefaults: (id: string) => void;
  testAllProviders: () => Promise<void>;
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

      addProvider: (newProvider) => {
        set((state) => {
          const existing = state.settings.providers || [];
          return {
            settings: {
              ...state.settings,
              providers: [...existing, newProvider],
            },
          };
        });
        get().saveToBackend().catch(() => {});
        get().testProviderConnection(newProvider.id).catch(() => {});
      },

      updateProvider: (id, patch) => {
        set((state) => {
          const providers = (state.settings.providers || DEFAULT_PROVIDERS).map((p) =>
            p.id === id ? { ...p, ...patch } : p
          );
          // If updating active provider, sync base_url/api_key
          let syncedBaseUrl = state.settings.base_url;
          let syncedApiKey = state.settings.api_key;
          const activeFastProvider = providers.find((p) => p.id === state.settings.fast_chat_provider_id);
          if (activeFastProvider && activeFastProvider.id === id) {
            syncedBaseUrl = patch.base_url ?? activeFastProvider.base_url;
            if (patch.api_key !== undefined) syncedApiKey = patch.api_key;
          }
          return {
            settings: {
              ...state.settings,
              providers,
              base_url: syncedBaseUrl,
              api_key: syncedApiKey,
            },
          };
        });
        get().saveToBackend().catch(() => {});
      },

      updateProviderRuntime: (id, patch) => {
        set((state) => ({
          settings: {
            ...state.settings,
            providers: (state.settings.providers || DEFAULT_PROVIDERS).map((p) =>
              p.id === id ? { ...p, ...patch } : p
            ),
          },
        }));
      },

      deleteProvider: (id) => {
        set((state) => {
          const providers = (state.settings.providers || DEFAULT_PROVIDERS).filter((p) => p.id !== id);
          return {
            settings: {
              ...state.settings,
              providers,
            },
          };
        });
        get().saveToBackend().catch(() => {});
      },

      testProviderConnection: async (id) => {
        const provider = (get().settings.providers || []).find((p) => p.id === id);
        if (!provider) return { success: false, message: 'Provider not found' };

        get().updateProviderRuntime(id, { status: 'testing' });
        const result = await testConnection(provider.base_url, provider.api_key || '');
        get().updateProviderRuntime(id, {
          status: result.success ? 'online' : 'offline',
          status_message: result.message,
        });
        return result;
      },

      fetchProviderModels: async (id) => {
        const provider = (get().settings.providers || []).find((p) => p.id === id);
        if (!provider) return [];

        get().updateProviderRuntime(id, { status: 'testing' });
        try {
          const fetched = await fetchModels(provider.base_url, provider.api_key || '');
          const existingIds = new Set(provider.models.map((m) => m.id));
          const newModels = [...provider.models];

          for (const m of fetched) {
            if (!existingIds.has(m.id)) {
              newModels.push({ id: m.id, name: m.id });
              existingIds.add(m.id);
            }
          }

          get().updateProvider(id, {
            models: newModels,
            status: 'online',
            status_message: `Fetched ${fetched.length} model${fetched.length !== 1 ? 's' : ''}`,
          });
          return newModels;
        } catch (e) {
          const errorMsg = (e as Error).message || 'Failed to fetch models';
          get().updateProviderRuntime(id, {
            status: 'offline',
            status_message: errorMsg,
          });
          throw e;
        }
      },

      restoreProviderDefaults: (id) => {
        const provider = (get().settings.providers || []).find((p) => p.id === id);
        if (!provider) return;

        const preset = PROVIDER_PRESETS.find((p) => p.type === provider.type || p.name.toLowerCase() === provider.name.toLowerCase());
        if (preset) {
          get().updateProvider(id, {
            models: [...preset.defaultModels],
            base_url: preset.base_url,
          });
        }
      },

      testAllProviders: async () => {
        const providers = get().settings.providers || [];
        await Promise.allSettled(
          providers.filter((p) => p.enabled !== false).map((p) => get().testProviderConnection(p.id))
        );
      },

      loadFromBackend: async () => {
        try {
          const backendSettings = await tauriApi.getSettings();
          const merged: AppSettings = sanitizeAppSettings({
            ...DEFAULT_SETTINGS,
            ...backendSettings,
          });

          set({ settings: merged, isLoaded: true });
        } catch {
          set((state) => ({
            settings: sanitizeAppSettings(state.settings),
            isLoaded: true,
          }));
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

      openSettings: () => {
        set({ isSettingsOpen: true });
        get().testAllProviders().catch(() => {});
      },
      closeSettings: () => set({ isSettingsOpen: false }),
    }),
    {
      name: 'morfeus-settings',
      partialize: (state) => ({ settings: state.settings }),
      onRehydrateStorage: () => (state) => {
        if (state && state.settings) {
          state.settings = sanitizeAppSettings(state.settings);
        }
      },
    }
  )
);
