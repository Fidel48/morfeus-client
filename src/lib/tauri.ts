import { AppSettings } from '@/types';

// Detect whether we're running inside the actual Tauri desktop app.
// When accessed via a browser (localhost:1420), window.__TAURI_INTERNALS__ is undefined.
const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;

function assertTauri(): void {
  if (!isTauri) {
    throw new Error(
      'This feature requires the Morfeus desktop app. ' +
      'You are currently accessing the app in a regular web browser (localhost:1420). ' +
      'Please use the Morfeus desktop window instead.'
    );
  }
}

// Lazy-loaded Tauri API functions — only imported when running inside Tauri
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  assertTauri();
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

async function tauriOpen(options: any): Promise<any> {
  assertTauri();
  const { open } = await import('@tauri-apps/plugin-dialog');
  return open(options);
}

async function tauriReadFile(path: string): Promise<Uint8Array> {
  assertTauri();
  const { readFile } = await import('@tauri-apps/plugin-fs');
  return readFile(path);
}

export const tauriApi = {
  async getSettings(): Promise<AppSettings> {
    return tauriInvoke<AppSettings>('get_settings');
  },

  async saveSettings(settings: AppSettings): Promise<void> {
    return tauriInvoke('save_settings', { settings });
  },

  async startRecording(): Promise<void> {
    return tauriInvoke('start_recording');
  },

  async stopRecording(): Promise<string> {
    return tauriInvoke<string>('stop_recording');
  },

  async checkMicrophone(): Promise<boolean> {
    return tauriInvoke<boolean>('check_microphone');
  },

  async getAudioDevices(): Promise<string[]> {
    return tauriInvoke<string[]>('get_audio_devices');
  },

  async transcribeNative(base64Wav: string): Promise<string> {
    return tauriInvoke<string>('transcribe_native', { base64Wav });
  },

  async speakText(text: string, rate: number = 1.0, voiceId?: string): Promise<void> {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = rate;
      
      if (voiceId) {
        const voices = window.speechSynthesis.getVoices();
        const selectedVoice = voices.find(v => v.name === voiceId);
        if (selectedVoice) {
          utterance.voice = selectedVoice;
        }
      }
      window.speechSynthesis.speak(utterance);
    } else {
      return tauriInvoke('speak_text', { text, rate });
    }
  },

  async getVoices(): Promise<string[]> {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      return new Promise(resolve => {
        let voices = window.speechSynthesis.getVoices();
        if (voices.length > 0) {
          resolve(voices.map(v => v.name));
        } else {
          // Chrome/Edge load voices asynchronously
          window.speechSynthesis.onvoiceschanged = () => {
            resolve(window.speechSynthesis.getVoices().map(v => v.name));
          };
          // Fallback if event never fires
          setTimeout(() => {
            resolve(window.speechSynthesis.getVoices().map(v => v.name));
          }, 1000);
        }
      });
    } else {
      return tauriInvoke<string[]>('get_voices');
    }
  },

  async stopSpeaking(): Promise<void> {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    } else {
      return tauriInvoke('stop_speaking');
    }
  },

  async webSearch(query: string): Promise<any[]> {
    return tauriInvoke<any[]>('search_duckduckgo', { query });
  },

  async fetchWebpage(url: string): Promise<string> {
    return tauriInvoke<string>('fetch_webpage', { url });
  },

  async openFileDialog(): Promise<string[] | null> {
    const selected = await tauriOpen({
      multiple: true,
      filters: [{
        name: 'Documents',
        extensions: ['pdf', 'txt', 'md', 'json', 'csv', 'rs', 'ts', 'js', 'html', 'css', 'xml', 'yaml', 'toml']
      }]
    });

    if (selected === null) return null;
    return Array.isArray(selected) ? selected : [selected];
  },

  async openImageDialog(): Promise<string[] | null> {
    const selected = await tauriOpen({
      multiple: true,
      filters: [{
        name: 'Images',
        extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif']
      }]
    });

    if (selected === null) return null;
    return Array.isArray(selected) ? selected : [selected];
  },

  /** Read any local file as raw bytes (needed for PDF parsing with pdfjs-dist) */
  async readFileBytes(path: string): Promise<Uint8Array> {
    return tauriReadFile(path);
  },

  /** Parse a plain text / code / csv file via Rust backend */
  async parseLocalFile(path: string): Promise<string> {
    return tauriInvoke<string>('parse_local_file', { path });
  },

  /** List the contents of a directory */
  async listDirectory(path: string): Promise<Array<{name: string, path: string, is_dir: boolean, size_bytes: number | null, extension: string | null}>> {
    return tauriInvoke('list_directory', { path });
  },

  /** Get platform-aware paths to Home, Downloads, Documents, Desktop */
  async getSpecialDirs(): Promise<{home: string | null, downloads: string | null, documents: string | null, desktop: string | null}> {
    return tauriInvoke('get_special_dirs');
  },

  /** Finds project level rules (.morfeusrules, .cursorrules) given a workspace path */
  async findProjectRules(workspacePath: string): Promise<Array<{ file_name: string, path: string, content: string }>> {
    return tauriInvoke('find_project_rules', { workspacePath });
  },

  /** Fetch the full transcript of a YouTube video by URL */
  async readYoutubeTranscript(url: string): Promise<string> {
    return tauriInvoke<string>('read_youtube_transcript', { url });
  },

  /** Start a native Language Server */
  async lspStartServer(languageId: string, command: string, args: string[], workspaceRoot?: string): Promise<void> {
    return tauriInvoke('lsp_start_server', { languageId, command, args, workspaceRoot });
  },

  /** Execute a Go To Definition request on an active LSP */
  async lspGotoDefinition(languageId: string, filePath: string, line: number, col: number): Promise<any> {
    return tauriInvoke('lsp_goto_definition', { languageId, filePath, line, col });
  },

  /** Start an MCP server */
  async mcpStartServer(id: string, command: string, args: string[], env: Record<string, string>): Promise<void> {
    return tauriInvoke('mcp_start_server', { id, command, args, env });
  },

  /** List tools from an MCP server */
  async mcpListTools(id: string): Promise<any> {
    return tauriInvoke('mcp_list_tools', { id });
  },

  /** Call a tool on an MCP server */
  async mcpCallTool(id: string, toolName: string, argumentsObj: any): Promise<any> {
    return tauriInvoke('mcp_call_tool', { id, toolName, arguments: argumentsObj });
  },

  /** Whether we're running inside the Tauri desktop app */
  isDesktopApp(): boolean {
    return isTauri;
  },
};
