import { create } from 'zustand';
import { tauriApi } from '@/lib/tauri';

export interface CanvasState {
  code: string;
  filePath: string | null;
  language: string;
  originalCode: string | null;
  isModified: boolean;
  showDiff: boolean;
  consoleOutput: string | null;
  isExecuting: boolean;

  // Actions
  setCode: (code: string) => void;
  openFileInCanvas: (filePath: string, content: string, language?: string) => void;
  loadCodeSnippet: (code: string, language?: string, filePath?: string) => void;
  setShowDiff: (show: boolean) => void;
  toggleDiff: () => void;
  setConsoleOutput: (output: string | null) => void;
  clearConsole: () => void;
  setIsExecuting: (executing: boolean) => void;
  saveCurrentFile: () => Promise<{ success: boolean; message: string }>;
  runCurrentCode: () => Promise<void>;
  resetCanvas: () => void;
}

export function detectLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    rs: 'rust',
    py: 'python',
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    scad: 'openscad',
    html: 'html',
    css: 'css',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    md: 'markdown',
    toml: 'toml',
    yaml: 'yaml',
    yml: 'yaml',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    swift: 'swift',
    go: 'go',
  };
  return map[ext] || 'plaintext';
}

const DEFAULT_SAMPLE_CODE = `// Morfeus Coder Canvas
// Paste, write, or click "Open in Canvas" on any code block in chat.

fn main() {
    println!("Hello from Morfeus Developer Harness!");
}
`;

export const useCanvasStore = create<CanvasState>((set, get) => ({
  code: DEFAULT_SAMPLE_CODE,
  filePath: null,
  language: 'rust',
  originalCode: DEFAULT_SAMPLE_CODE,
  isModified: false,
  showDiff: false,
  consoleOutput: null,
  isExecuting: false,

  setCode: (code: string) => {
    const { originalCode } = get();
    set({
      code,
      isModified: originalCode !== null && code !== originalCode,
    });
  },

  openFileInCanvas: (filePath: string, content: string, language?: string) => {
    const lang = language || detectLanguageFromPath(filePath);
    set({
      code: content,
      filePath,
      language: lang,
      originalCode: content,
      isModified: false,
      showDiff: false,
      consoleOutput: null,
    });
  },

  loadCodeSnippet: (code: string, language?: string, filePath?: string) => {
    const lang = language || (filePath ? detectLanguageFromPath(filePath) : 'plaintext');
    set({
      code,
      filePath: filePath || null,
      language: lang,
      originalCode: code,
      isModified: false,
      showDiff: false,
      consoleOutput: null,
    });
  },

  setShowDiff: (show: boolean) => set({ showDiff: show }),

  toggleDiff: () => set((state) => ({ showDiff: !state.showDiff })),

  setConsoleOutput: (output: string | null) => set({ consoleOutput: output }),

  clearConsole: () => set({ consoleOutput: null }),

  setIsExecuting: (isExecuting: boolean) => set({ isExecuting }),

  saveCurrentFile: async () => {
    const { filePath, code } = get();
    if (!filePath) {
      return { success: false, message: 'No file path set. This is a scratchpad buffer.' };
    }
    try {
      await tauriApi.writeToFile(filePath, code);
      set({ originalCode: code, isModified: false });
      return { success: true, message: `Successfully saved ${filePath}` };
    } catch (err) {
      return { success: false, message: `Failed to save: ${String(err)}` };
    }
  },

  runCurrentCode: async () => {
    const { code, language, filePath } = get();
    set({ isExecuting: true, consoleOutput: 'Executing...' });

    try {
      let output = '';

      if (language === 'python') {
        const res = await tauriApi.runPythonCode(code);
        const header = res.success ? '✅ Execution finished' : `❌ Failed (exit code ${res.exit_code})`;
        const out = res.stdout ? `\n--- stdout ---\n${res.stdout}` : '';
        const err = res.stderr ? `\n--- stderr ---\n${res.stderr}` : '';
        output = `${header}${out}${err}`;
      } else if (language === 'bash' || language === 'sh') {
        const res = await tauriApi.runTerminalCommand(code);
        const header = res.success ? '✅ Command finished' : `❌ Failed (exit code ${res.exit_code})`;
        const out = res.stdout ? `\n--- stdout ---\n${res.stdout}` : '';
        const err = res.stderr ? `\n--- stderr ---\n${res.stderr}` : '';
        output = `${header}${out}${err}`;
      } else if (language === 'openscad' && filePath) {
        // Run OpenSCAD CLI to render / export if available
        const res = await tauriApi.runTerminalCommand(`openscad -o /tmp/morfeus_preview.png --preview "${filePath}" 2>&1 || openscad "${filePath}"`);
        output = res.stdout || res.stderr || 'OpenSCAD launched.';
      } else if (filePath) {
        // Fallback: check if we can run it via shell
        output = `Running file: ${filePath}...\n`;
        const res = await tauriApi.runTerminalCommand(`cat "${filePath}" | head -n 50`);
        output += res.stdout || res.stderr;
      } else {
        // Generic execution info
        output = `Language '${language}' scratchpad cannot be auto-executed directly without a file path or compiler.\nUse Python, Bash, or specify a project file to run.`;
      }

      set({ consoleOutput: output, isExecuting: false });
    } catch (err) {
      set({ consoleOutput: `Error during execution: ${String(err)}`, isExecuting: false });
    }
  },

  resetCanvas: () => {
    set({
      code: DEFAULT_SAMPLE_CODE,
      filePath: null,
      language: 'rust',
      originalCode: DEFAULT_SAMPLE_CODE,
      isModified: false,
      showDiff: false,
      consoleOutput: null,
      isExecuting: false,
    });
  },
}));
