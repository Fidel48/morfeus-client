import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { SlidersHorizontal, FileText, Wrench, X } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { cn } from '@/lib/utils';
import type { AppSettings } from '@/types';

type PanelTab = 'parameters' | 'context' | 'tools';

export const RightPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<PanelTab>('parameters');
  const { settings, updateSettings } = useSettingsStore();
  const { rightPanelOpen, toggleRightPanel } = useChatStore();

  return (
    <AnimatePresence>
      {rightPanelOpen && (
        <motion.div
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 280, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeInOut' }}
          className="flex-shrink-0 bg-zinc-950/80 border-l border-white/8 overflow-hidden"
        >
          <div className="w-[280px] h-full flex flex-col">
            {/* Tab bar */}
            <div className="flex items-center gap-1 px-3 pt-3 pb-2 border-b border-white/8 flex-shrink-0">
              <TabButton
                icon={<SlidersHorizontal size={13} />}
                label="Params"
                active={activeTab === 'parameters'}
                onClick={() => setActiveTab('parameters')}
              />
              <TabButton
                icon={<FileText size={13} />}
                label="Context"
                active={activeTab === 'context'}
                onClick={() => setActiveTab('context')}
              />
              <TabButton
                icon={<Wrench size={13} />}
                label="Tools"
                active={activeTab === 'tools'}
                onClick={() => setActiveTab('tools')}
              />
              <button
                onClick={toggleRightPanel}
                className="ml-auto p-1 rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-white/8 transition-colors"
              >
                <X size={13} />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-3 space-y-4">
              {activeTab === 'parameters' && (
                <ParametersTab settings={settings} updateSettings={updateSettings} />
              )}
              {activeTab === 'context' && <ContextTab settings={settings} updateSettings={updateSettings} />}
              {activeTab === 'tools' && <ToolsTab />}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

const TabButton: React.FC<{
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}> = ({ icon, label, active, onClick }) => (
  <button
    onClick={onClick}
    className={cn(
      'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-all',
      active
        ? 'bg-violet-600/20 text-violet-300 border border-violet-500/30'
        : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
    )}
  >
    {icon}
    {label}
  </button>
);

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  description?: string;
}

const Slider: React.FC<SliderProps> = ({ label, value, min, max, step, onChange, description }) => (
  <div>
    <div className="flex items-center justify-between mb-1.5">
      <label className="text-xs text-zinc-400 font-medium">{label}</label>
      <span className="text-xs text-zinc-500 font-mono bg-white/5 px-1.5 py-0.5 rounded">
        {value.toFixed(step < 0.1 ? 2 : 1)}
      </span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-violet-500"
    />
    {description && <p className="text-[10px] text-zinc-700 mt-1">{description}</p>}
  </div>
);

const ParametersTab: React.FC<{ settings: AppSettings; updateSettings: (p: Partial<AppSettings>) => void }> = ({
  settings,
  updateSettings,
}) => (
  <div className="space-y-5">
    <div>
      <h3 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider mb-3">
        Generation Parameters
      </h3>
      <div className="space-y-4">
        <Slider
          label="Temperature"
          value={settings.temperature}
          min={0}
          max={2}
          step={0.05}
          onChange={(v) => updateSettings({ temperature: v })}
          description="Higher = more creative, lower = more deterministic"
        />
        <Slider
          label="Top-P"
          value={settings.top_p}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => updateSettings({ top_p: v })}
          description="Nucleus sampling probability mass"
        />
        <Slider
          label="Frequency Penalty"
          value={settings.frequency_penalty}
          min={-2}
          max={2}
          step={0.1}
          onChange={(v) => updateSettings({ frequency_penalty: v })}
          description="Penalize repeated tokens"
        />
      </div>
    </div>

    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs text-zinc-400 font-medium">Max Tokens</label>
        <span className="text-xs text-zinc-500 font-mono bg-white/5 px-1.5 py-0.5 rounded">
          {settings.max_tokens}
        </span>
      </div>
      <input
        type="range"
        min={128}
        max={8192}
        step={128}
        value={settings.max_tokens}
        onChange={(e) => updateSettings({ max_tokens: parseInt(e.target.value) })}
        className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-violet-500"
      />
    </div>
  </div>
);

const ContextTab: React.FC<{ settings: AppSettings; updateSettings: (p: Partial<AppSettings>) => void }> = ({
  settings,
  updateSettings,
}) => (
  <div className="space-y-4">
    <div>
      <h3 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider mb-2">
        System Prompt
      </h3>
      <textarea
        value={settings.system_prompt}
        onChange={(e) => updateSettings({ system_prompt: e.target.value })}
        rows={8}
        className="w-full px-3 py-2 text-xs bg-white/5 border border-white/10 rounded-lg text-zinc-300 placeholder-zinc-600 outline-none focus:border-violet-500/40 resize-none leading-relaxed font-mono"
        placeholder="You are a helpful AI assistant."
      />
    </div>
  </div>
);

const ToolsTab: React.FC = () => (
  <div className="space-y-3">
    <h3 className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider">
      Tool Outputs
    </h3>
    <div className="text-xs text-zinc-700 py-6 text-center">
      <Wrench size={16} className="mx-auto mb-2 text-zinc-800" />
      No tool calls in this conversation
    </div>
  </div>
);
