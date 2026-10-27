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
    if (isTauri) {
      return tauriInvoke('speak_text', { text, rate, voiceId });
    }
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
    }
  },

  async getVoices(): Promise<string[]> {
    if (isTauri) {
      return tauriInvoke<string[]>('get_voices');
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      return new Promise(resolve => {
        let voices = window.speechSynthesis.getVoices();
        if (voices.length > 0) {
          resolve(voices.map(v => v.name));
        } else {
          window.speechSynthesis.onvoiceschanged = () => {
            resolve(window.speechSynthesis.getVoices().map(v => v.name));
          };
          setTimeout(() => {
            resolve(window.speechSynthesis.getVoices().map(v => v.name));
          }, 1000);
        }
      });
    }
    return [];
  },

  async stopSpeaking(): Promise<void> {
    if (isTauri) {
      return tauriInvoke('stop_speaking');
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  },

  /** Check if local Kokoro neural TTS server is running */
  async isKokoroRunning(): Promise<boolean> {
    if (isTauri) {
      return tauriInvoke<boolean>('is_kokoro_running');
    }
    return false;
  },

  /** Launch or ensure Kokoro neural TTS server is running */
  async startKokoroServer(): Promise<boolean> {
    if (isTauri) {
      return tauriInvoke<boolean>('start_kokoro_server');
    }
    return false;
  },

  /** Synthesize and speak text using local Kokoro neural TTS (afplay native audio) */
  async kokoroSpeak(text: string, voice?: string, speed?: number): Promise<void> {
    if (isTauri) {
      return tauriInvoke('kokoro_speak_native', { text, voice: voice ?? null, speed: speed ?? null });
    }
    return this.speakText(text, speed, voice);
  },

  /** Play a short preview phrase using the chosen Kokoro voice */
  async kokoroPreview(voice: string, speed?: number): Promise<void> {
    if (isTauri) {
      return tauriInvoke('kokoro_preview_native', { voice, speed: speed ?? null });
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

  /** Native folder picker (used to choose an Agent Coder project) */
  async pickFolder(): Promise<string | null> {
    const selected = await tauriOpen({ directory: true, multiple: false });
    if (selected === null || selected === undefined) return null;
    return Array.isArray(selected) ? (selected[0] ?? null) : selected;
  },

  /** Read any local file as raw bytes (needed for PDF parsing with pdfjs-dist) */
  async readFileBytes(path: string): Promise<Uint8Array> {
    return tauriReadFile(path);
  },

  /** Parse a plain text / code / csv file via Rust backend */
  async parseLocalFile(path: string): Promise<string> {
    return tauriInvoke<string>('parse_local_file', { path });
  },

  /** Read a text / code file verbatim without cleaning or truncation (for the editor) */
  async readTextFile(path: string): Promise<{ path: string; content: string; size_bytes: number }> {
    return tauriInvoke('read_text_file', { path });
  },

  /** List the contents of a directory. includeHidden defaults to false */
  async listDirectory(path: string, includeHidden?: boolean): Promise<Array<{name: string, path: string, is_dir: boolean, size_bytes: number | null, extension: string | null}>> {
    return tauriInvoke('list_directory', { path, includeHidden: includeHidden ?? false });
  },

  /** Get platform-aware paths to Home, Downloads, Documents, Desktop */
  async getSpecialDirs(): Promise<{home: string | null, downloads: string | null, documents: string | null, desktop: string | null}> {
    return tauriInvoke('get_special_dirs');
  },

  /** Recursively search for files/folders by name within the user's home directory */
  async searchFiles(query: string, root?: string): Promise<Array<{name: string, path: string, is_dir: boolean}>> {
    return tauriInvoke('search_files', { query, root: root ?? null });
  },

  /** Finds project level rules (.morfeusrules, .cursorrules) given a workspace path */
  async findProjectRules(workspacePath: string): Promise<Array<{ file_name: string, path: string, content: string }>> {
    return tauriInvoke('find_project_rules', { workspacePath });
  },

  /** Fetch the full transcript of a YouTube video by URL */
  async readYoutubeTranscript(url: string): Promise<string> {
    return tauriInvoke<string>('read_youtube_transcript', { url });
  },

  /** Log an event to the system log file */
  async appendSystemLog(level: string, message: string): Promise<void> {
    if (!isTauri) {
      console.log(`[${level.toUpperCase()}] ${message}`);
      return;
    }
    return tauriInvoke('append_system_log', { level, message });
  },

  /** Get last 200 lines of system logs */
  async getSystemLogs(): Promise<string[]> {
    if (!isTauri) return ['Web mode: logs are output to browser console.'];
    return tauriInvoke<string[]>('get_system_logs');
  },

  /** Open the native log folder in Finder/Explorer */
  async openLogFolder(): Promise<void> {
    if (!isTauri) return;
    return tauriInvoke('open_log_folder');
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

  /** Stop / disconnect an active MCP server process */
  async mcpStopServer(id: string): Promise<void> {
    return tauriInvoke('mcp_stop_server', { id });
  },

  /** List IDs of all currently active (spawned) MCP server processes */
  async mcpListActiveServers(): Promise<string[]> {
    return tauriInvoke<string[]>('mcp_list_active_servers');
  },

  /** Run an inline Python code snippet. Returns stdout, stderr, exit_code, success. */
  async runPythonCode(code: string): Promise<{ stdout: string; stderr: string; exit_code: number; success: boolean }> {
    return tauriInvoke('run_python_code', { code });
  },

  /** Run a Python script at a given absolute file path. Returns stdout, stderr, exit_code, success. */
  async runPythonFile(path: string): Promise<{ stdout: string; stderr: string; exit_code: number; success: boolean }> {
    return tauriInvoke('run_python_file', { path });
  },

  /** Install Python packages via pip (space-separated: "requests pandas lxml"). */
  async installPythonPackages(packages: string): Promise<{ stdout: string; stderr: string; exit_code: number; success: boolean }> {
    return tauriInvoke('install_python_packages', { packages });
  },

  /** Run a raw terminal command (sh -c or cmd.exe /c). Optional cwd runs it inside a project folder. Returns stdout, stderr, exit_code, success. */
  async runTerminalCommand(command: string, cwd?: string | null): Promise<{ stdout: string; stderr: string; exit_code: number; success: boolean }> {
    return tauriInvoke('run_terminal_command', { command, cwd: cwd ?? null });
  },

  /** Write content to an absolute file path. Creates directories if they don't exist. */
  async writeToFile(path: string, content: string): Promise<string> {
    return tauriInvoke('write_to_file', { path, content });
  },

  /** Delete a file at the given absolute path. */
  async deleteFile(path: string): Promise<string> {
    return tauriInvoke('delete_file', { path });
  },

  /** Fast codebase search for matching lines/symbols across workspace files */
  async grepSearch(query: string, root?: string, includes?: string[], case_insensitive?: boolean): Promise<Array<{ file: string; line_number: number; line_content: string }>> {
    return tauriInvoke('grep_search', { query, root: root ?? null, includes: includes ?? null, caseInsensitive: case_insensitive ?? null });
  },

  /** Slice-read a file with line-number prefixing */
  async readFileRange(path: string, start_line: number, end_line: number): Promise<{ path: string; start_line: number; end_line: number; total_lines: number; content: string }> {
    return tauriInvoke('read_file_range', { path, startLine: start_line, endLine: end_line });
  },

  /** Surgically replace an exact code block in a file without rewriting the whole file */
  async replaceInFile(path: string, target_content: string, replacement_content: string, allow_multiple?: boolean): Promise<{ path: string; occurrences_replaced: number; message: string }> {
    return tauriInvoke('replace_in_file', { path, targetContent: target_content, replacementContent: replacement_content, allowMultiple: allow_multiple ?? null });
  },

  // ── Vision & Control (Violoop Architecture) ──

  /** Capture the primary screen and return it as a Base64 PNG. */
  async captureScreen(): Promise<string> {
    const tempFile = '/tmp/morfeus_screen.png';
    const res = await tauriInvoke<any>('run_terminal_command', { command: `screencapture -x ${tempFile}` });
    if (!res.success) throw new Error("Failed to capture screen: " + res.stderr);
    
    const bytes = await this.readFileBytes(tempFile);
    
    // Convert Uint8Array to base64 properly
    const chunk = 8192;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    const b64 = btoa(binary);
    
    // Delete temp file
    await tauriInvoke('run_terminal_command', { command: `rm -f ${tempFile}` });
    return `data:image/png;base64,${b64}`;
  },

  /** Move the mouse to absolute coordinates (x, y). */
  async mouseMove(x: number, y: number): Promise<void> {
    const pyCode = `import Quartz; Quartz.CGWarpMouseCursorPosition((${x}, ${y}))`;
    await tauriInvoke('run_terminal_command', { command: `python3 -c "${pyCode}"` });
  },

  /** Click the mouse button ('left', 'right', 'middle'). */
  async mouseClick(button: string): Promise<void> {
    const pyCode = `
import Quartz, time
btn = Quartz.kCGMouseButtonLeft
evt_down = Quartz.kCGEventLeftMouseDown
evt_up = Quartz.kCGEventLeftMouseUp
if '${button}' == 'right':
    btn = Quartz.kCGMouseButtonRight
    evt_down = Quartz.kCGEventRightMouseDown
    evt_up = Quartz.kCGEventRightMouseUp
e = Quartz.CGEventCreate(None)
pos = Quartz.CGEventGetLocation(e)
d = Quartz.CGEventCreateMouseEvent(None, evt_down, pos, btn)
u = Quartz.CGEventCreateMouseEvent(None, evt_up, pos, btn)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, d)
time.sleep(0.05)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, u)
`.trim().replace(/\n/g, '\\n');
    await tauriInvoke('run_terminal_command', { command: `python3 -c "${pyCode}"` });
  },

  /** Type the given text string. */
  async typeText(text: string): Promise<void> {
    // Escape quotes and backslashes for AppleScript
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await tauriInvoke('run_terminal_command', { command: `osascript -e 'tell application "System Events" to keystroke "${escaped}"'` });
  },

  /** Press a specific key (e.g., 'enter', 'tab', 'escape', 'a'). */
  async pressKey(key: string): Promise<void> {
    let script = '';
    const k = key.toLowerCase();
    if (k === 'enter' || k === 'return') script = 'key code 36';
    else if (k === 'tab') script = 'key code 48';
    else if (k === 'space') script = 'key code 49';
    else if (k === 'escape' || k === 'esc') script = 'key code 53';
    else if (k === 'backspace' || k === 'delete') script = 'key code 51';
    else if (k === 'up') script = 'key code 126';
    else if (k === 'down') script = 'key code 125';
    else if (k === 'left') script = 'key code 123';
    else if (k === 'right') script = 'key code 124';
    else script = `keystroke "${k.charAt(0)}"`;
    
    await tauriInvoke('run_terminal_command', { command: `osascript -e 'tell application "System Events" to ${script}'` });
  },

  /** Whether we're running inside the Tauri desktop app */
  isDesktopApp(): boolean {
    return isTauri;
  },
};
