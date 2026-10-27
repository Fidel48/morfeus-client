import { create } from 'zustand';
import { tauriApi } from '@/lib/tauri';

export interface EditorTab {
  path: string;
  name: string;
}

export interface CanvasState {
  code: string;
  filePath: string | null;
  language: string;
  originalCode: string | null;
  isModified: boolean;
  showDiff: boolean;
  consoleOutput: string | null;
  isExecuting: boolean;
  openTabs: EditorTab[];

  // Actions
  setCode: (code: string) => void;
  openFileInCanvas: (filePath: string, content: string, language?: string) => void;
  openFileFromDisk: (filePath: string) => Promise<boolean>;
  loadCodeSnippet: (code: string, language?: string, filePath?: string) => void;
  closeTab: (filePath: string) => void;
  switchTab: (filePath: string) => Promise<void>;
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

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  code: '',
  filePath: null,
  language: 'plaintext',
  originalCode: null,
  isModified: false,
  showDiff: false,
  consoleOutput: null,
  isExecuting: false,
  openTabs: [],

  setCode: (code: string) => {
    const { originalCode } = get();
    set({
      code,
      isModified: originalCode !== null && code !== originalCode,
    });
  },

  openFileInCanvas: (filePath: string, content: string, language?: string) => {
    const lang = language || detectLanguageFromPath(filePath);
    const name = fileNameFromPath(filePath);
    const existingTabs = get().openTabs;
    const tabExists = existingTabs.some((t) => t.path === filePath);
    const updatedTabs = tabExists ? existingTabs : [...existingTabs, { path: filePath, name }];

    set({
      code: content,
      filePath,
      language: lang,
      originalCode: content,
      isModified: false,
      showDiff: false,
      consoleOutput: null,
      openTabs: updatedTabs,
    });
  },

  openFileFromDisk: async (filePath: string) => {
    try {
      let content = '';
      try {
        const res = await tauriApi.readTextFile(filePath);
        content = res.content;
      } catch {
        content = await tauriApi.parseLocalFile(filePath);
      }

      get().openFileInCanvas(filePath, content);
      return true;
    } catch (err) {
      console.error('Failed to open file from disk:', err);
      return false;
    }
  },

  loadCodeSnippet: (code: string, language?: string, filePath?: string) => {
    const lang = language || (filePath ? detectLanguageFromPath(filePath) : 'plaintext');
    const path = filePath || null;
    let updatedTabs = get().openTabs;

    if (path) {
      const name = fileNameFromPath(path);
      if (!updatedTabs.some((t) => t.path === path)) {
        updatedTabs = [...updatedTabs, { path, name }];
      }
    }

    set({
      code,
      filePath: path,
      language: lang,
      originalCode: code,
      isModified: false,
      showDiff: false,
      consoleOutput: null,
      openTabs: updatedTabs,
    });
  },

  closeTab: (tabPath: string) => {
    const { openTabs, filePath } = get();
    const remaining = openTabs.filter((t) => t.path !== tabPath);

    if (filePath === tabPath) {
      if (remaining.length > 0) {
        const next = remaining[remaining.length - 1];
        get().switchTab(next.path);
      } else {
        set({
          code: '',
          filePath: null,
          language: 'plaintext',
          originalCode: null,
          isModified: false,
          showDiff: false,
          consoleOutput: null,
          openTabs: [],
        });
      }
    } else {
      set({ openTabs: remaining });
    }
  },

  switchTab: async (tabPath: string) => {
    await get().openFileFromDisk(tabPath);
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
        const res = await tauriApi.runTerminalCommand(`openscad -o /tmp/morfeus_preview.png --preview "${filePath}" 2>&1 || openscad "${filePath}"`);
        output = res.stdout || res.stderr || 'OpenSCAD launched.';
      } else if (filePath) {
        output = `Running file: ${filePath}...\n`;
        const res = await tauriApi.runTerminalCommand(`cat "${filePath}" | head -n 50`);
        output += res.stdout || res.stderr;
      } else {
        output = `Language '${language}' scratchpad cannot be auto-executed directly without a file path or compiler.\nUse Python, Bash, or specify a project file to run.`;
      }

      set({ consoleOutput: output, isExecuting: false });
    } catch (err) {
      set({ consoleOutput: `Error during execution: ${String(err)}`, isExecuting: false });
    }
  },

  resetCanvas: () => {
    set({
      code: '',
      filePath: null,
      language: 'plaintext',
      originalCode: null,
      isModified: false,
      showDiff: false,
      consoleOutput: null,
      isExecuting: false,
      openTabs: [],
    });
  },
}));
