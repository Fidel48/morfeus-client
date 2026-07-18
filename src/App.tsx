import React, { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from '@/components/layout/Sidebar';
import { ChatWindow } from '@/components/chat/ChatWindow';
import { RightPanel } from '@/components/layout/RightPanel';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { useSettingsStore } from '@/stores/settingsStore';
import { useVoiceStore } from '@/stores/voiceStore';
import { tauriApi } from '@/lib/tauri';
import { check } from '@tauri-apps/plugin-updater';
import { ask } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30000,
    },
  },
});

const AppContent: React.FC = () => {
  const { loadFromBackend } = useSettingsStore();
  const { setMicAvailable, setAvailableVoices } = useVoiceStore();

  useEffect(() => {
    // Load settings from Tauri backend on startup
    loadFromBackend();

    // Check mic availability
    tauriApi.checkMicrophone()
      .then(setMicAvailable)
      .catch(() => setMicAvailable(false));

    // Load available voices
    tauriApi.getVoices()
      .then(setAvailableVoices)
      .catch(() => {});

    // Check for OTA updates automatically
    if (tauriApi.isDesktopApp()) {
      check().then(async (update) => {
        if (update) {
          const yes = await ask(
            `Update v${update.version} is available! (Released: ${update.date})\n\nRelease notes:\n${update.body}\n\nWould you like to install it now?`,
            { title: 'Update Available', kind: 'info' }
          );
          
          if (yes) {
            await update.downloadAndInstall();
            await relaunch();
          }
        }
      }).catch(console.error);
    }

    // Keyboard shortcut: Ctrl+\ to toggle right panel
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '\\') {
        e.preventDefault();
        // toggleRightPanel is called from within the component
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [loadFromBackend, setMicAvailable, setAvailableVoices]);

  const isDesktop = tauriApi.isDesktopApp();

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* Browser warning banner — only shown when NOT in the Tauri desktop window */}
      {!isDesktop && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-500/15 border-b border-amber-500/30 text-amber-300 text-sm flex-shrink-0">
          <span className="text-base">⚠️</span>
          <span>
            <strong>Browser mode detected.</strong> You are viewing this in a web browser ({window.location.href}).
            Morfeus requires the <strong>native desktop window</strong> to connect to your LLM.
            Please close this browser tab and use the Morfeus app window instead.
          </span>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar */}
        <div className="w-60 flex-shrink-0">
          <Sidebar />
        </div>

        {/* Main Chat Area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <ChatWindow />
        </div>

        {/* Right Panel */}
        <RightPanel />
      </div>

      {/* Settings Modal */}
      <SettingsModal />
    </div>
  );
};

class ErrorBoundary extends React.Component<{children: React.ReactNode}, {hasError: boolean, error: Error | null}> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-start justify-center h-screen w-full bg-zinc-950 p-10 text-red-400 font-mono overflow-auto">
          <h1 className="text-2xl font-bold mb-4 text-white">App crashed!</h1>
          <p className="text-sm mb-4">Something went wrong during rendering. This is usually caused by corrupted chat history state.</p>
          <pre className="text-xs bg-red-950/40 p-4 rounded-xl border border-red-900 w-full max-w-4xl whitespace-pre-wrap">
            {this.state.error?.stack || this.state.error?.message}
          </pre>
          <button 
            onClick={() => { localStorage.clear(); window.location.reload(); }} 
            className="mt-6 px-6 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl font-bold shadow-lg"
          >
            Nuke State & Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <AppContent />
      </ErrorBoundary>
    </QueryClientProvider>
  );
}

export default App;
