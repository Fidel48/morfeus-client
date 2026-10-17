import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Server, Mic, Volume2, Check, AlertCircle,
  Loader2, RefreshCw, ChevronDown, Zap, Bug, FolderOpen, Terminal, Copy, FileText,
  Plug, Plus, Trash2, PlugZap, ChevronRight, WifiOff, Play, Square, Atom,
} from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMcpStore } from '@/stores/mcpStore';
import { useVoiceStore } from '@/stores/voiceStore';
import { testConnection, fetchModels } from '@/lib/api';
import { tauriApi } from '@/lib/tauri';
import { cn } from '@/lib/utils';
import { KOKORO_VOICES, DEFAULT_KOKORO_VOICE, kokoroSpeak, kokoroPreview, kokoroStop, getEngineState } from '@/lib/kokoroTts';
import { Model, AppSettings, McpServerConfig } from '@/types';

type SettingsTab = 'connection' | 'parameters' | 'voice' | 'developer' | 'mcp';

const isDeepSeekR1Model = (id?: string) => {
  if (!id) return false;
  const s = id.toLowerCase();
  return s.includes('deepseek-r1') || s.includes('deepseek_r1') || (s.includes('deepseek') && s.includes('r1'));
};

export const SettingsModal: React.FC = () => {
  const { settings, isSettingsOpen, updateSettings, saveToBackend, closeSettings } = useSettingsStore();
  const { availableVoices, setAvailableVoices } = useVoiceStore();

  const [tab, setTab] = useState<SettingsTab>('connection');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [showLogsModal, setShowLogsModal] = useState(false);

  // Load voices when modal opens
  useEffect(() => {
    if (isSettingsOpen && availableVoices.length === 0) {
      tauriApi.getVoices().then(setAvailableVoices).catch(console.error);
    }
  }, [isSettingsOpen, availableVoices.length, setAvailableVoices]);

  // Auto-load models if we already have a working URL saved
  useEffect(() => {
    if (isSettingsOpen && settings.base_url && models.length === 0) {
      handleConnectAndLoad();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSettingsOpen]);

  const handleConnectAndLoad = useCallback(async () => {
    if (!settings.base_url) return;
    setTestStatus('testing');
    setTestMessage('');
    setLoadingModels(true);

    try {
      // Test connection
      const result = await testConnection(settings.base_url, settings.api_key);
      if (!result.success) {
        setTestStatus('error');
        setTestMessage(result.message);
        return;
      }
      setTestStatus('ok');

      // Immediately load model list
      const m = await fetchModels(settings.base_url, settings.api_key);
      setModels(m);
      setTestMessage(`Connected — ${m.length} model${m.length !== 1 ? 's' : ''} available`);

      // Auto-select models for Fast Chat and Agent Coder
      const firstNonR1 = m.find((item) => !isDeepSeekR1Model(item.id));
      const firstR1 = m.find((item) => isDeepSeekR1Model(item.id));
      const updates: Partial<AppSettings> = {};

      if (!settings.model_id && m.length > 0) {
        updates.model_id = firstNonR1?.id || m[0].id;
      }
      if (!settings.fast_chat_model_id && firstNonR1) {
        updates.fast_chat_model_id = firstNonR1.id;
      }
      if (!settings.agent_coder_model_id) {
        updates.agent_coder_model_id = firstR1?.id || m[0].id;
      }
      if (Object.keys(updates).length > 0) {
        updateSettings(updates);
      }
    } catch (e) {
      setTestStatus('error');
      setTestMessage((e as Error).message || 'Connection failed');
    } finally {
      setLoadingModels(false);
    }
  }, [settings.base_url, settings.api_key, settings.model_id, settings.fast_chat_model_id, settings.agent_coder_model_id, updateSettings]);

  const handleSave = async () => {
    await saveToBackend();
    closeSettings();
  };

  return (
    <AnimatePresence>
      {isSettingsOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeSettings}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 flex items-center justify-center z-50 p-4"
          >
            <div className="w-full max-w-lg bg-zinc-950 border border-white/10 rounded-2xl shadow-2xl shadow-black/60 overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-white/8">
                <div>
                  <h2 className="text-sm font-semibold text-white">Settings</h2>
                  <p className="text-xs text-zinc-600 mt-0.5">Configure your LLM connection and voice</p>
                </div>
                <button
                  onClick={closeSettings}
                  className="p-1.5 rounded-lg text-zinc-600 hover:text-white hover:bg-white/8 transition-colors"
                >
                  <X size={15} />
                </button>
              </div>

              {/* Tabs */}
              <div className="flex gap-1 px-5 pt-3 flex-wrap">
                <TabBtn icon={<Server size={13} />} label="Connection" active={tab === 'connection'} onClick={() => setTab('connection')} />
                <TabBtn icon={<Zap size={13} />} label="Parameters" active={tab === 'parameters'} onClick={() => setTab('parameters')} />
                <TabBtn icon={<Mic size={13} />} label="Voice" active={tab === 'voice'} onClick={() => setTab('voice')} />
                <TabBtn icon={<Bug size={13} />} label="Developer" active={tab === 'developer'} onClick={() => setTab('developer')} />
                <TabBtn icon={<Plug size={13} />} label="MCP Servers" active={tab === 'mcp'} onClick={() => setTab('mcp')} />
              </div>

              {/* Content */}
              <div className="px-5 py-4 space-y-4 max-h-[480px] overflow-y-auto">
                {tab === 'connection' && (
                  <ConnectionTab
                    settings={settings}
                    updateSettings={updateSettings}
                    testStatus={testStatus}
                    testMessage={testMessage}
                    onConnectAndLoad={handleConnectAndLoad}
                    loadingModels={loadingModels}
                    models={models}
                  />
                )}
                {tab === 'parameters' && (
                  <ParametersTab
                    settings={settings}
                    updateSettings={updateSettings}
                  />
                )}
                {tab === 'voice' && (
                  <VoiceTab
                    settings={settings}
                    updateSettings={updateSettings}
                    availableVoices={availableVoices}
                  />
                )}
                {tab === 'developer' && (
                  <DeveloperTab
                    settings={settings}
                    updateSettings={updateSettings}
                    onOpenLogsModal={() => setShowLogsModal(true)}
                  />
                )}
                {tab === 'mcp' && <McpTab />}
              </div>

              {/* Footer */}
              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/8">
                <button
                  onClick={closeSettings}
                  className="px-4 py-2 text-xs text-zinc-400 hover:text-white hover:bg-white/8 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  className="px-4 py-2 text-xs bg-violet-600 hover:bg-violet-500 text-white rounded-lg transition-colors font-medium shadow-[0_0_12px_rgba(124,58,237,0.3)]"
                >
                  Save & Close
                </button>
              </div>
            </div>
          </motion.div>

          <LogViewerModal isOpen={showLogsModal} onClose={() => setShowLogsModal(false)} />
        </>
      )}
    </AnimatePresence>
  );
};

// ─── Sub-components ──────────────────────────────────────────────────────────

const TabBtn: React.FC<{ icon: React.ReactNode; label: string; active: boolean; onClick: () => void }> = ({
  icon, label, active, onClick
}) => (
  <button
    onClick={onClick}
    className={cn(
      'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all',
      active ? 'bg-violet-600/20 text-violet-300 border border-violet-500/30' : 'text-zinc-500 hover:text-zinc-300'
    )}
  >
    {icon}{label}
  </button>
);

const Field: React.FC<{ label: string; children: React.ReactNode; hint?: string }> = ({ label, children, hint }) => (
  <div>
    <label className="block text-xs text-zinc-400 font-medium mb-1.5">{label}</label>
    {children}
    {hint && <p className="text-[10px] text-zinc-600 mt-1">{hint}</p>}
  </div>
);

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  (props, ref) => (
    <input
      ref={ref}
      {...props}
      className={cn(
        "w-full px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-violet-500/50 focus:bg-white/8 transition-colors",
        props.className
      )}
    />
  )
);
Input.displayName = 'Input';

const ConnectionTab: React.FC<{
  settings: AppSettings;
  updateSettings: (p: Partial<AppSettings>) => void;
  testStatus: string;
  testMessage: string;
  onConnectAndLoad: () => void;
  loadingModels: boolean;
  models: Model[];
}> = ({ settings, updateSettings, testStatus, testMessage, onConnectAndLoad, loadingModels, models }) => {
  const isConnected = testStatus === 'ok';
  const isTesting = testStatus === 'testing' || loadingModels;

  return (
    <div className="space-y-4">
      {/* Base URL */}
      <Field
        label="Server URL"
        hint="Your LM Studio or Ollama base URL. Include /v1 for LM Studio."
      >
        <div className="flex gap-2">
          <Input
            type="text"
            value={settings.base_url}
            onChange={(e) => updateSettings({ base_url: e.target.value })}
            placeholder="http://192.168.1.100:1234/v1"
            onKeyDown={(e) => e.key === 'Enter' && onConnectAndLoad()}
          />
          <button
            onClick={onConnectAndLoad}
            disabled={isTesting || !settings.base_url}
            title="Connect and load models"
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg font-medium transition-all whitespace-nowrap',
              isConnected
                ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30'
                : 'bg-violet-600/20 text-violet-300 border border-violet-500/30 hover:bg-violet-600/30 disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            {isTesting ? (
              <Loader2 size={12} className="animate-spin" />
            ) : isConnected ? (
              <Check size={12} />
            ) : (
              <Zap size={12} />
            )}
            {isTesting ? 'Connecting…' : isConnected ? 'Connected' : 'Connect'}
          </button>
        </div>

        {/* Status message */}
        {testMessage && (
          <div className={cn(
            'flex items-center gap-1.5 mt-2 text-xs px-2 py-1.5 rounded-lg',
            testStatus === 'ok'
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              : 'bg-red-500/10 text-red-400 border border-red-500/20'
          )}>
            {testStatus === 'ok' ? <Check size={11} /> : <AlertCircle size={11} />}
            {testMessage}
            {testStatus === 'error' && settings.base_url.includes('localhost') && (
              <span className="ml-1 text-zinc-600">· Is your LLM server running?</span>
            )}
          </div>
        )}
      </Field>

      {/* API Key */}
      <Field label="API Key" hint="Optional. Required for some hosted servers.">
        <Input
          type="password"
          value={settings.api_key}
          onChange={(e) => updateSettings({ api_key: e.target.value })}
          placeholder="sk-… (leave empty for LM Studio / Ollama)"
        />
      </Field>

      {/* ── Mode-Specific Model Configuration ── */}
      <div className="pt-2 border-t border-white/8 space-y-4">
        <div>
          <h4 className="text-xs font-semibold text-zinc-200 mb-0.5">Model Configuration by Mode</h4>
          <p className="text-[11px] text-zinc-500">
            Set dedicated models for Fast Chat and Agent Coder. DeepSeek-R1 is strictly reserved for Agent Coder.
          </p>
        </div>

        {/* ⚡ Fast Chat Model */}
        <Field
          label="⚡ Fast Chat Model (Normal Chat)"
          hint="Model for daily conversations, web searches, and file summarization."
        >
          <div className="space-y-1.5">
            {models.length > 0 ? (
              <div className="relative">
                <select
                  value={settings.fast_chat_model_id || settings.model_id}
                  onChange={(e) => {
                    const val = e.target.value;
                    updateSettings({ fast_chat_model_id: val, model_id: val });
                  }}
                  className="w-full px-3 py-2 text-xs bg-white/5 border border-white/10 rounded-lg text-zinc-300 outline-none focus:border-violet-500/50 appearance-none cursor-pointer"
                >
                  <option value="" className="bg-zinc-900">— select fast chat model —</option>
                  {models.map((m) => {
                    const isR1 = isDeepSeekR1Model(m.id);
                    return (
                      <option
                        key={m.id}
                        value={m.id}
                        className="bg-zinc-900 text-zinc-200"
                      >
                        {isR1 ? `🧠 ${m.id} (Reasoning)` : `⚡ ${m.id}`}
                      </option>
                    );
                  })}
                </select>
                <ChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600 pointer-events-none" />
              </div>
            ) : (
              <Input
                type="text"
                value={settings.fast_chat_model_id || settings.model_id}
                onChange={(e) => {
                  updateSettings({ fast_chat_model_id: e.target.value, model_id: e.target.value });
                }}
                placeholder="e.g. llama3, mistral, gemma, etc."
              />
            )}
          </div>
        </Field>

        {/* 🤖 Agent Coder Model */}
        <Field
          label="🤖 Agent Coder Model (IDE Developer Mode)"
          hint="Heavy-duty coding model for terminal execution, autonomous coding loops, and MCP tools."
        >
          <div className="space-y-1.5">
            {models.length > 0 ? (
              <div className="relative">
                <select
                  value={settings.agent_coder_model_id || settings.model_id}
                  onChange={(e) => updateSettings({ agent_coder_model_id: e.target.value })}
                  className="w-full px-3 py-2 text-xs bg-white/5 border border-white/10 rounded-lg text-zinc-300 outline-none focus:border-violet-500/50 appearance-none cursor-pointer"
                >
                  <option value="" className="bg-zinc-900">— select agent coder model —</option>
                  {models.map((m) => {
                    const isR1 = isDeepSeekR1Model(m.id);
                    return (
                      <option key={m.id} value={m.id} className="bg-zinc-900 text-zinc-200">
                        {isR1 ? `🧠 ${m.id} (Reasoning Model)` : `💻 ${m.id}`}
                      </option>
                    );
                  })}
                </select>
                <ChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600 pointer-events-none" />
              </div>
            ) : (
              <Input
                type="text"
                value={settings.agent_coder_model_id || settings.model_id}
                onChange={(e) => updateSettings({ agent_coder_model_id: e.target.value })}
                placeholder="e.g. deepseek-r1, qwen-coder, etc."
              />
            )}
          </div>
        </Field>

        {/* Reload models button */}
        {isConnected && (
          <div className="flex items-center justify-between pt-1">
            <button
              onClick={onConnectAndLoad}
              disabled={loadingModels}
              className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <RefreshCw size={11} className={cn(loadingModels && 'animate-spin')} />
              Reload model list ({models.length} loaded)
            </button>
          </div>
        )}
      </div>

      {/* Helpful tips */}
      {testStatus === 'idle' && (
        <div className="text-xs text-zinc-700 bg-white/3 border border-white/8 rounded-lg px-3 py-2.5 space-y-1">
          <p className="font-medium text-zinc-600">Quick start:</p>
          <p>• <span className="text-zinc-500">LM Studio:</span> Start local server → use <code className="bg-white/8 px-1 rounded">http://localhost:1234/v1</code></p>
          <p>• <span className="text-zinc-500">Ollama:</span> Run <code className="bg-white/8 px-1 rounded">ollama serve</code> → use <code className="bg-white/8 px-1 rounded">http://localhost:11434/v1</code></p>
          <p>• <span className="text-zinc-500">Remote:</span> Replace localhost with your server's IP address</p>
        </div>
      )}
    </div>
  );
};

const ParametersTab: React.FC<{
  settings: AppSettings;
  updateSettings: (p: Partial<AppSettings>) => void;
}> = ({ settings, updateSettings }) => (
  <div className="space-y-4">
    <Field label="System Prompt" hint="The core instructions given to the model.">
      <textarea
        value={settings.system_prompt}
        onChange={(e) => updateSettings({ system_prompt: e.target.value })}
        className="w-full px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-violet-500/50 focus:bg-white/8 transition-colors resize-y min-h-[80px]"
      />
    </Field>
    
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs text-zinc-400 font-medium">Temperature</label>
        <span className="text-xs text-zinc-500 font-mono">{settings.temperature.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={0}
        max={2}
        step={0.05}
        value={settings.temperature}
        onChange={(e) => updateSettings({ temperature: parseFloat(e.target.value) })}
        className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-violet-500"
      />
    </div>

    <Field label="Context Window Length" hint="Max tokens allocated for history + new prompt. Lower values (4K-8K) respond faster and use far less VRAM/RAM.">
      <div className="space-y-2">
        <Input
          type="number"
          value={settings.context_length || ''}
          onChange={(e) => updateSettings({ context_length: parseInt(e.target.value) || 0 })}
          placeholder="8192"
          onBlur={(e) => {
            if (!settings.context_length || settings.context_length < 1024) {
              updateSettings({ context_length: 8192 });
            }
          }}
        />
        {/* Quick Context Presets */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {[
            { label: '4K (Fastest)', value: 4096 },
            { label: '8K (Balanced)', value: 8192 },
            { label: '16K (Long Context)', value: 16384 },
            { label: '32K (Deep Coding)', value: 32768 },
          ].map((preset) => (
            <button
              key={preset.value}
              type="button"
              onClick={() => updateSettings({ context_length: preset.value })}
              className={cn(
                'px-2.5 py-1 text-[11px] rounded-md transition-all cursor-pointer border',
                settings.context_length === preset.value
                  ? 'bg-violet-600/25 text-violet-300 border-violet-500/40 font-medium'
                  : 'bg-white/5 text-zinc-400 hover:text-zinc-200 border-white/8 hover:bg-white/8'
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>
    </Field>

    <Field label="Max Output Tokens" hint="Maximum tokens the model is allowed to generate per response.">
      <Input
        type="number"
        value={settings.max_tokens || ''}
        onChange={(e) => updateSettings({ max_tokens: parseInt(e.target.value) || 0 })}
        placeholder="2048"
        onBlur={(e) => {
          if (!settings.max_tokens || settings.max_tokens < 256) {
            updateSettings({ max_tokens: 2048 });
          }
        }}
      />
    </Field>

    {/* Thinking Mode Toggle */}
    <div className="flex items-center justify-between p-3 bg-white/5 border border-white/8 rounded-xl">
      <div className="space-y-0.5 pr-4">
        <div className="flex items-center gap-2">
          <Atom size={14} className="text-violet-400" />
          <span className="text-xs text-zinc-200 font-medium">Thinking / Reasoning Mode</span>
        </div>
        <p className="text-[10px] text-zinc-500 leading-relaxed">
          Show internal reasoning scratchpad (<code className="text-zinc-400">&lt;think&gt;</code> tokens). Turn OFF to eliminate response delays and reduce token consumption across all models.
        </p>
      </div>
      <button
        type="button"
        onClick={() => updateSettings({ think_enabled: !(settings.think_enabled ?? true) })}
        className={cn(
          'w-11 h-6 rounded-full transition-colors relative flex items-center px-0.5 flex-shrink-0 cursor-pointer',
          (settings.think_enabled ?? true) ? 'bg-violet-600' : 'bg-zinc-800'
        )}
      >
        <span
          className={cn(
            'w-5 h-5 rounded-full bg-white transition-transform shadow-md',
            (settings.think_enabled ?? true) ? 'translate-x-5' : 'translate-x-0'
          )}
        />
      </button>
    </div>
  </div>
);

const VoiceTab: React.FC<{
  settings: AppSettings;
  updateSettings: (p: Partial<AppSettings>) => void;
  availableVoices: string[];
}> = ({ settings, updateSettings }) => {
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [engineStatus, setEngineStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    getEngineState().state
  );

  useEffect(() => {
    tauriApi.isKokoroRunning().then((running) => {
      if (running) {
        setEngineStatus('ready');
      } else {
        setEngineStatus('loading');
        tauriApi.startKokoroServer().then((ok) => {
          setEngineStatus(ok ? 'ready' : 'error');
        }).catch(() => setEngineStatus('error'));
      }
    });
  }, []);

  const activeVoice = settings.tts_voice || DEFAULT_KOKORO_VOICE;

  const handlePreview = async (voiceId: string) => {
    if (previewingId) {
      kokoroStop();
      setPreviewingId(null);
      return;
    }
    setPreviewingId(voiceId);
    try {
      await kokoroPreview(voiceId, settings.tts_rate);
    } finally {
      setPreviewingId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* TTS Enable Toggle */}
      <div className="flex items-center justify-between p-3 bg-white/3 rounded-xl border border-white/8">
        <div>
          <p className="text-xs text-zinc-300 font-medium">Text-to-Speech</p>
          <p className="text-[10px] text-zinc-600">AI reads responses aloud using Kokoro neural voices</p>
        </div>
        <button
          onClick={() => updateSettings({ tts_enabled: !settings.tts_enabled })}
          className={cn(
            'w-10 h-6 rounded-full transition-all relative flex-shrink-0',
            settings.tts_enabled ? 'bg-violet-600' : 'bg-zinc-800 border border-white/10'
          )}
        >
          <div className={cn(
            'absolute top-1 w-4 h-4 rounded-full bg-white transition-all shadow',
            settings.tts_enabled ? 'left-5' : 'left-1'
          )} />
        </button>
      </div>

      {/* Kokoro Engine Card */}
      <div className="rounded-xl border border-white/10 bg-white/3 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 p-3 border-b border-white/8">
          <div className="w-9 h-9 rounded-full bg-violet-600/20 border border-violet-500/30 flex items-center justify-center text-lg flex-shrink-0">
            🔊
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-white">Kokoro</p>
            <p className="text-[10px] font-semibold text-violet-400 uppercase tracking-wide">Best Quality</p>
            <p className="text-[10px] text-zinc-500 mt-0.5">22 voices · 330 MB · ~650 MB RAM</p>
          </div>
          <div className="flex items-center gap-2">
            {engineStatus === 'loading' && (
              <div className="flex items-center gap-1.5 text-[10px] text-amber-400">
                <Loader2 size={10} className="animate-spin" />
                Loading…
              </div>
            )}
            {engineStatus === 'ready' && (
              <div className="flex items-center gap-1 text-[10px] text-emerald-400">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                Ready
              </div>
            )}
            {engineStatus === 'error' && (
              <div className="flex items-center gap-1 text-[10px] text-red-400">
                <AlertCircle size={10} />
                Error
              </div>
            )}
          </div>
        </div>

        <p className="text-[10px] text-zinc-600 px-3 pt-2 pb-1">Some voices may not work on all devices.</p>

        {/* Voice List */}
        <div className="divide-y divide-white/5">
          {KOKORO_VOICES.map((voice) => {
            const isActive = activeVoice === voice.id;
            const isPreviewing = previewingId === voice.id;
            return (
              <div
                key={voice.id}
                onClick={() => updateSettings({ tts_voice: voice.id })}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors',
                  isActive ? 'bg-violet-600/10' : 'hover:bg-white/4'
                )}
              >
                {/* Radio */}
                <div className={cn(
                  'w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors',
                  isActive ? 'border-violet-500 bg-violet-500' : 'border-zinc-600'
                )}>
                  {isActive && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                </div>

                {/* Label */}
                <span className={cn(
                  'flex-1 text-sm font-medium',
                  isActive ? 'text-white' : 'text-zinc-400'
                )}>
                  {voice.label}
                  {voice.accent === 'British' && (
                    <span className="ml-1.5 text-[9px] text-zinc-600 font-normal">🇬🇧</span>
                  )}
                  {voice.gender === 'male' && (
                    <span className="ml-1.5 text-[9px] text-zinc-600 font-normal">♂</span>
                  )}
                </span>

                {/* Preview Play Button */}
                <button
                  onClick={(e) => { e.stopPropagation(); handlePreview(voice.id); }}
                  className={cn(
                    'w-6 h-6 rounded-full flex items-center justify-center transition-all flex-shrink-0',
                    isPreviewing
                      ? 'bg-violet-500 text-white'
                      : 'text-zinc-600 hover:text-violet-400 hover:bg-violet-500/10'
                  )}
                  title={isPreviewing ? 'Stop preview' : 'Preview voice'}
                >
                  {isPreviewing
                    ? <Square size={9} fill="currentColor" />
                    : <Play size={9} fill="currentColor" />}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Speaking Rate */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs text-zinc-400 font-medium flex items-center gap-1.5">
            <Volume2 size={12} />
            Speaking Rate
          </label>
          <span className="text-xs text-zinc-500 font-mono">{settings.tts_rate.toFixed(1)}x</span>
        </div>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.1}
          value={settings.tts_rate}
          onChange={(e) => updateSettings({ tts_rate: parseFloat(e.target.value) })}
          className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-violet-500"
        />
      </div>

      {/* STT Section */}
      <div className="border-t border-white/8 pt-4">
        <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider mb-3">Speech-to-Text (STT)</p>
        <Field
          label="Whisper Model Path"
          hint="Optional: path to a GGML Whisper model file for local, offline transcription."
        >
          <Input
            type="text"
            value={settings.stt_model_path}
            onChange={(e) => updateSettings({ stt_model_path: e.target.value })}
            placeholder="C:\models\ggml-base.bin  (leave empty to disable)"
          />
        </Field>

        {/* Continuous Conversation (Hands-Free) */}
        <div className="flex items-center justify-between mt-3 p-3 bg-white/3 rounded-xl border border-white/8">
          <div>
            <p className="text-xs text-zinc-300 font-medium">Continuous Conversation (Hands-Free)</p>
            <p className="text-[10px] text-zinc-500">Automatically re-opens mic after AI speaks for continuous back-and-forth</p>
          </div>
          <button
            onClick={() => updateSettings({ continuous_voice: !(settings.continuous_voice ?? true) })}
            className={cn(
              'w-10 h-6 rounded-full transition-all relative flex-shrink-0',
              (settings.continuous_voice ?? true) ? 'bg-emerald-600' : 'bg-zinc-800 border border-white/10'
            )}
          >
            <div className={cn(
              'absolute top-1 w-4 h-4 rounded-full bg-white transition-all shadow',
              (settings.continuous_voice ?? true) ? 'left-5' : 'left-1'
            )} />
          </button>
        </div>

        {/* Push-to-Talk Mode */}
        <div className="flex items-center justify-between mt-3 p-3 bg-white/3 rounded-xl border border-white/8">
          <div>
            <p className="text-xs text-zinc-300 font-medium">Push-to-Talk Mode</p>
            <p className="text-[10px] text-zinc-500">Hold mic button to record (off = click to toggle on/off)</p>
          </div>
          <button
            onClick={() => updateSettings({ ptt_mode: !settings.ptt_mode })}
            className={cn(
              'w-10 h-6 rounded-full transition-all relative flex-shrink-0',
              settings.ptt_mode ? 'bg-violet-600' : 'bg-zinc-800 border border-white/10'
            )}
          >
            <div className={cn(
              'absolute top-1 w-4 h-4 rounded-full bg-white transition-all shadow',
              settings.ptt_mode ? 'left-5' : 'left-1'
            )} />
          </button>
        </div>
      </div>
    </div>
  );
};


const DeveloperTab: React.FC<{
  settings: AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
  onOpenLogsModal: () => void;
}> = ({ settings, updateSettings, onOpenLogsModal }) => (
  <div className="space-y-4">
    <div className="flex items-center justify-between p-3 bg-white/3 rounded-xl border border-white/8">
      <div>
        <p className="text-xs text-zinc-200 font-medium">Developer Debug Mode</p>
        <p className="text-[10px] text-zinc-500 mt-0.5">
          Show step-by-step tool execution badges in the chat timeline (useful for inspecting tool calls and args).
        </p>
      </div>
      <button
        onClick={() => updateSettings({ debug_mode: !settings.debug_mode })}
        className={cn(
          'w-10 h-6 rounded-full transition-all relative flex-shrink-0 ml-3',
          settings.debug_mode ? 'bg-violet-600' : 'bg-zinc-800 border border-white/10'
        )}
      >
        <div className={cn(
          'absolute top-1 w-4 h-4 rounded-full bg-white transition-all shadow',
          settings.debug_mode ? 'left-5' : 'left-1'
        )} />
      </button>
    </div>

    <div className="border-t border-white/8 pt-4">
      <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider mb-2">Native Diagnostics & Logging</p>
      <p className="text-xs text-zinc-400 leading-relaxed mb-3">
        Morfeus logs tool executions, system events, and errors to a lightweight local file (<code className="text-violet-300 font-mono text-[11px]">morfeus.log</code>) capped at 5MB.
      </p>

      <div className="flex gap-2">
        <button
          onClick={onOpenLogsModal}
          className="flex items-center gap-1.5 px-3 py-2 text-xs bg-zinc-900 hover:bg-zinc-800 border border-white/10 rounded-lg text-zinc-200 transition-colors"
        >
          <FileText size={13} className="text-violet-400" />
          View System Logs
        </button>
        <button
          onClick={() => tauriApi.openLogFolder()}
          className="flex items-center gap-1.5 px-3 py-2 text-xs bg-zinc-900 hover:bg-zinc-800 border border-white/10 rounded-lg text-zinc-200 transition-colors"
        >
          <FolderOpen size={13} className="text-violet-400" />
          Open Logs Folder
        </button>
      </div>
    </div>
  </div>
);

const LogViewerModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const [logs, setLogs] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      tauriApi.getSystemLogs()
        .then(setLogs)
        .catch((e) => setLogs([`Error reading logs: ${e}`]))
        .finally(() => setLoading(false));
    }
  }, [isOpen]);

  const handleCopy = () => {
    navigator.clipboard.writeText(logs.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[60] flex items-center justify-center p-4">
      <div className="bg-zinc-950 border border-white/10 rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/8">
          <div className="flex items-center gap-2">
            <Terminal size={15} className="text-violet-400" />
            <h3 className="text-sm font-semibold text-white">System Logs</h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-white px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 transition-colors"
            >
              <Copy size={12} />
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button onClick={onClose} className="p-1 text-zinc-500 hover:text-white">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="p-4 flex-1 overflow-y-auto font-mono text-xs text-zinc-300 bg-black/60 leading-relaxed space-y-1">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-zinc-500">Loading logs...</div>
          ) : logs.length === 0 ? (
            <div className="text-zinc-600 italic">No logs recorded yet.</div>
          ) : (
            logs.map((line, i) => (
              <div key={i} className={cn(
                'whitespace-pre-wrap break-all',
                line.includes('[ERROR]') ? 'text-red-400' : line.includes('[WARN]') ? 'text-amber-400' : 'text-zinc-300'
              )}>
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

// ─── MCP Server Manager Tab ──────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  connected: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  connecting: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
  error: 'bg-red-500/15 text-red-400 border-red-500/25',
  disabled: 'bg-zinc-800/60 text-zinc-500 border-zinc-700/40',
};

const StatusDot: React.FC<{ status?: string }> = ({ status = 'disabled' }) => (
  <span className={cn(
    'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border capitalize',
    STATUS_STYLES[status] ?? STATUS_STYLES.disabled
  )}>
    {status === 'connecting' && <Loader2 size={9} className="animate-spin" />}
    {status === 'connected' && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
    {status === 'error' && <span className="w-1.5 h-1.5 rounded-full bg-red-400" />}
    {status === 'disabled' && <WifiOff size={9} />}
    {status}
  </span>
);

const McpTab: React.FC = () => {
  const { servers, addServer, removeServer, setEnabled, connectServer, disconnectServer, refreshServerTools } = useMcpStore();

  const [showAdd, setShowAdd] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // ── Add-server form state ──
  const [form, setForm] = useState({
    name: '',
    id: '',
    command: '',
    args: '',     // space-separated
    envRaw: '',   // KEY=VALUE,KEY2=VALUE2
  });
  const [addError, setAddError] = useState('');

  const handleAdd = () => {
    setAddError('');
    const id = form.id.trim() || form.name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!id || !form.command.trim()) {
      setAddError('Name and Command are required.');
      return;
    }
    if (servers.find((s) => s.id === id)) {
      setAddError(`A server with ID "${id}" already exists.`);
      return;
    }

    const args = form.args.trim() ? form.args.trim().split(/\s+/) : [];
    const env: Record<string, string> = {};
    for (const pair of form.envRaw.split(',')) {
      const [k, ...vs] = pair.split('=');
      if (k?.trim()) env[k.trim()] = vs.join('=').trim();
    }

    addServer({ id, name: form.name.trim() || id, command: form.command.trim(), args, env, enabled: true });
    setForm({ name: '', id: '', command: '', args: '', envRaw: '' });
    setShowAdd(false);
  };

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold text-zinc-200">MCP Server Manager</p>
          <p className="text-[10px] text-zinc-600 mt-0.5">
            {servers.filter((s) => s.status === 'connected').length} of {servers.length} servers connected
          </p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-violet-600/20 text-violet-300 border border-violet-500/30 hover:bg-violet-600/30 transition-colors"
        >
          <Plus size={12} />
          Add Server
        </button>
      </div>

      {/* Add-server form */}
      <AnimatePresence>
        {showAdd && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-2 p-3 bg-white/3 rounded-xl border border-white/8">
              <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">New MCP Server</p>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] text-zinc-500 mb-1">Display Name *</label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="FreeCAD MCP"
                    className="w-full px-2.5 py-1.5 text-xs bg-white/5 border border-white/10 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-violet-500/50"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-zinc-500 mb-1">ID (auto from name)</label>
                  <input
                    value={form.id}
                    onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
                    placeholder="freecad"
                    className="w-full px-2.5 py-1.5 text-xs bg-white/5 border border-white/10 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-violet-500/50"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] text-zinc-500 mb-1">Command *</label>
                <input
                  value={form.command}
                  onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                  placeholder="python  or  npx  or  node"
                  className="w-full px-2.5 py-1.5 text-xs bg-white/5 border border-white/10 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-violet-500/50"
                />
              </div>

              <div>
                <label className="block text-[10px] text-zinc-500 mb-1">Arguments (space-separated)</label>
                <input
                  value={form.args}
                  onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                  placeholder="-m freecad_mcp  or  -y @modelcontextprotocol/server-github"
                  className="w-full px-2.5 py-1.5 text-xs bg-white/5 border border-white/10 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-violet-500/50"
                />
              </div>

              <div>
                <label className="block text-[10px] text-zinc-500 mb-1">Env Variables (KEY=VALUE, comma-separated)</label>
                <input
                  value={form.envRaw}
                  onChange={(e) => setForm((f) => ({ ...f, envRaw: e.target.value }))}
                  placeholder="GITHUB_TOKEN=ghp_xxx, API_KEY=..."
                  className="w-full px-2.5 py-1.5 text-xs bg-white/5 border border-white/10 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-violet-500/50"
                />
              </div>

              {addError && (
                <p className="text-[10px] text-red-400 flex items-center gap-1">
                  <AlertCircle size={10} /> {addError}
                </p>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleAdd}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-violet-600 hover:bg-violet-500 text-white rounded-lg transition-colors font-medium"
                >
                  <PlugZap size={12} />
                  Connect & Save
                </button>
                <button
                  onClick={() => { setShowAdd(false); setAddError(''); }}
                  className="px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Server list */}
      {servers.length === 0 ? (
        <div className="text-center py-8 text-zinc-600">
          <Plug size={28} className="mx-auto mb-2 opacity-40" />
          <p className="text-xs">No MCP servers configured.</p>
          <p className="text-[10px] mt-1">Click "Add Server" to connect your first MCP.</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {servers.map((srv) => (
            <div key={srv.id} className="bg-white/3 border border-white/8 rounded-xl overflow-hidden">
              {/* Server row */}
              <div className="flex items-center gap-3 px-3 py-2.5">
                {/* Expand toggle */}
                <button
                  onClick={() => setExpandedId(expandedId === srv.id ? null : srv.id)}
                  className="text-zinc-600 hover:text-zinc-300 transition-colors flex-shrink-0"
                >
                  <ChevronRight size={13} className={cn('transition-transform', expandedId === srv.id && 'rotate-90')} />
                </button>

                {/* Name + status */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-200 font-medium truncate">{srv.name}</span>
                    <StatusDot status={srv.status} />
                  </div>
                  <p className="text-[10px] text-zinc-600 font-mono truncate mt-0.5">
                    {srv.command} {srv.args.join(' ')}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {/* Enable/disable toggle */}
                  <button
                    onClick={() => setEnabled(srv.id, !srv.enabled)}
                    title={srv.enabled ? 'Disable' : 'Enable'}
                    className={cn(
                      'w-8 h-4.5 rounded-full transition-all relative flex-shrink-0',
                      srv.enabled ? 'bg-violet-600' : 'bg-zinc-800 border border-white/10'
                    )}
                    style={{ height: '18px', width: '30px' }}
                  >
                    <div className={cn(
                      'absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all shadow',
                      srv.enabled ? 'left-3.5' : 'left-0.5'
                    )} />
                  </button>

                  {/* Reconnect */}
                  {srv.enabled && (
                    <button
                      onClick={() => connectServer(srv.id)}
                      title="Reconnect"
                      className="p-1 rounded text-zinc-600 hover:text-violet-300 transition-colors"
                    >
                      <RefreshCw size={11} className={cn(srv.status === 'connecting' && 'animate-spin')} />
                    </button>
                  )}

                  {/* Remove */}
                  <button
                    onClick={() => removeServer(srv.id)}
                    title="Remove"
                    className="p-1 rounded text-zinc-700 hover:text-red-400 transition-colors"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>

              {/* Expanded tool inspector */}
              <AnimatePresence>
                {expandedId === srv.id && (
                  <motion.div
                    initial={{ height: 0 }}
                    animate={{ height: 'auto' }}
                    exit={{ height: 0 }}
                    className="overflow-hidden border-t border-white/6"
                  >
                    <div className="px-3 py-2.5 space-y-2">
                      {/* Error */}
                      {srv.errorMessage && (
                        <div className="flex items-start gap-1.5 text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-2 py-1.5">
                          <AlertCircle size={11} className="mt-0.5 flex-shrink-0" />
                          <span className="break-all">{srv.errorMessage}</span>
                        </div>
                      )}

                      {/* Tool list */}
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
                            {srv.tools?.length ?? 0} tool{(srv.tools?.length ?? 0) !== 1 ? 's' : ''} available
                          </p>
                          {srv.status === 'connected' && (
                            <button
                              onClick={() => refreshServerTools(srv.id)}
                              className="text-[10px] text-zinc-600 hover:text-violet-300 flex items-center gap-1"
                            >
                              <RefreshCw size={9} /> Refresh
                            </button>
                          )}
                        </div>
                        {srv.tools && srv.tools.length > 0 ? (
                          <div className="space-y-1">
                            {srv.tools.map((tool) => (
                              <div key={tool.name} className="flex items-start gap-2 px-2 py-1.5 bg-black/30 rounded-lg">
                                <Zap size={10} className="text-violet-400 mt-0.5 flex-shrink-0" />
                                <div className="min-w-0">
                                  <p className="text-[10px] font-mono text-violet-300 truncate">{tool.name}</p>
                                  {tool.description && (
                                    <p className="text-[10px] text-zinc-600 leading-relaxed line-clamp-2">{tool.description}</p>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-[10px] text-zinc-700 italic">
                            {srv.status === 'connected' ? 'No tools reported.' : 'Connect server to inspect tools.'}
                          </p>
                        )}
                      </div>

                      {/* Config summary */}
                      <div className="pt-1 border-t border-white/6">
                        <p className="text-[10px] font-mono text-zinc-700 break-all">
                          {srv.command} {srv.args.join(' ')}
                        </p>
                        {Object.keys(srv.env ?? {}).length > 0 && (
                          <p className="text-[10px] text-zinc-700 mt-0.5">
                            ENV: {Object.keys(srv.env).join(', ')}
                          </p>
                        )}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
