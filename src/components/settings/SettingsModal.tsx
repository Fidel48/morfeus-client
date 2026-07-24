import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, Server, Mic, Volume2, Check, AlertCircle,
  Loader2, RefreshCw, ChevronDown, Zap, Bug, FolderOpen, Terminal, Copy, FileText,
} from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useVoiceStore } from '@/stores/voiceStore';
import { testConnection, fetchModels } from '@/lib/api';
import { tauriApi } from '@/lib/tauri';
import { cn } from '@/lib/utils';
import { Model, AppSettings } from '@/types';

type SettingsTab = 'connection' | 'parameters' | 'voice' | 'developer';

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

      // Auto-select first model if none is set
      if (!settings.model_id && m.length > 0) {
        updateSettings({ model_id: m[0].id });
      }
    } catch (e) {
      setTestStatus('error');
      setTestMessage((e as Error).message || 'Connection failed');
    } finally {
      setLoadingModels(false);
    }
  }, [settings.base_url, settings.api_key, settings.model_id, updateSettings]);

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
              <div className="flex gap-1 px-5 pt-3">
                <TabBtn icon={<Server size={13} />} label="Connection" active={tab === 'connection'} onClick={() => setTab('connection')} />
                <TabBtn icon={<Zap size={13} />} label="Parameters" active={tab === 'parameters'} onClick={() => setTab('parameters')} />
                <TabBtn icon={<Mic size={13} />} label="Voice" active={tab === 'voice'} onClick={() => setTab('voice')} />
                <TabBtn icon={<Bug size={13} />} label="Developer" active={tab === 'developer'} onClick={() => setTab('developer')} />
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

      {/* Model selection */}
      <Field label="Model">
        <div className="space-y-2">
          {/* Text input — always editable, works even without dropdown */}
          <div className="relative">
            <Input
              type="text"
              value={settings.model_id}
              onChange={(e) => updateSettings({ model_id: e.target.value })}
              placeholder={
                models.length > 0
                  ? 'Select below or type a model ID…'
                  : 'Connect to server first, then select a model'
              }
            />
          </div>

          {/* Dropdown populated from server */}
          {models.length > 0 && (
            <div className="relative">
              <select
                value={settings.model_id}
                onChange={(e) => updateSettings({ model_id: e.target.value })}
                className="w-full px-3 py-2 text-xs bg-white/5 border border-white/10 rounded-lg text-zinc-300 outline-none focus:border-violet-500/50 appearance-none cursor-pointer"
              >
                <option value="" className="bg-zinc-900">— pick from {models.length} loaded model{models.length !== 1 ? 's' : ''} —</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id} className="bg-zinc-900 text-sm">{m.id}</option>
                ))}
              </select>
              <ChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600 pointer-events-none" />
            </div>
          )}

          {/* Reload models button */}
          {isConnected && (
            <button
              onClick={onConnectAndLoad}
              disabled={loadingModels}
              className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <RefreshCw size={11} className={cn(loadingModels && 'animate-spin')} />
              Reload model list
            </button>
          )}
        </div>
      </Field>

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

    <Field label="Context Window Length" hint="Max tokens allocated for history + new prompt. High values require more RAM.">
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
  </div>
);

const VoiceTab: React.FC<{
  settings: AppSettings;
  updateSettings: (p: Partial<AppSettings>) => void;
  availableVoices: string[];
}> = ({ settings, updateSettings, availableVoices }) => (
  <div className="space-y-4">
    {/* TTS Toggle */}
    <div className="flex items-center justify-between p-3 bg-white/3 rounded-xl border border-white/8">
      <div>
        <p className="text-xs text-zinc-300 font-medium">Text-to-Speech</p>
        <p className="text-[10px] text-zinc-600">Auto-read AI responses aloud</p>
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

    <Field label="Voice">
      <div className="relative">
        <select
          value={settings.tts_voice}
          onChange={(e) => updateSettings({ tts_voice: e.target.value })}
          className="w-full px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-lg text-zinc-200 outline-none focus:border-violet-500/50 appearance-none cursor-pointer"
        >
          <option value="" className="bg-zinc-900">System default</option>
          {availableVoices.map((v) => (
            <option key={v} value={v} className="bg-zinc-900">{v}</option>
          ))}
        </select>
        <ChevronDown size={12} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600 pointer-events-none" />
      </div>
    </Field>

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

      <div className="flex items-center justify-between mt-3 p-3 bg-white/3 rounded-xl border border-white/8">
        <div>
          <p className="text-xs text-zinc-300 font-medium">Push-to-Talk Mode</p>
          <p className="text-[10px] text-zinc-600">Hold mic button to record</p>
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
