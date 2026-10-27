import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import { LazyStore } from '@tauri-apps/plugin-store';
import { tauriApi } from '@/lib/tauri';

export interface RecentProject {
  path: string;
  name: string;
  last_opened: number;
}

interface ProjectStore {
  recentProjects: RecentProject[];
  /** Projects explicitly deleted or dismissed by the user (won't be re-added by auto-discovery) */
  dismissedPaths: string[];
  /** The project Agent Coder is currently working in (null = show the project picker). */
  activeProjectPath: string | null;
  isDiscovering: boolean;

  openProject: (path: string) => void;
  closeProject: () => void;
  removeProject: (path: string) => void;
  clearAllRecent: () => void;
  pickAndOpenProject: () => Promise<boolean>;
  discoverLocalProjects: () => Promise<void>;
}

const MAX_RECENT = 20;

export function projectNameFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed || path;
}

export function formatDisplayPath(path: string): string {
  // Replace user's home directory with ~
  const home = typeof window !== 'undefined' && (window as any).__USER_HOME__;
  if (home && path.startsWith(home)) {
    return '~' + path.slice(home.length);
  }
  // Fallback for typical mac/linux /Users/username or /home/username
  return path.replace(/^\/(Users|home)\/[^/]+/, '~');
}

// Persistent JSON store on desktop disk (bypasses browser localStorage wiping)
const tauriStore = new LazyStore('project-storage.json');

const tauriStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      let val = await tauriStore.get<string>(name);
      if (!val) {
        // Fallback to localStorage for migration
        const localVal = typeof localStorage !== 'undefined' ? localStorage.getItem(name) : null;
        if (localVal) {
          val = localVal;
          await tauriStore.set(name, localVal);
          await tauriStore.save();
        }
      }
      return val || null;
    } catch {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(name) : null;
    }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    try {
      await tauriStore.set(name, value);
      await tauriStore.save();
    } catch {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(name, value);
      }
    }
  },
  removeItem: async (name: string): Promise<void> => {
    try {
      await tauriStore.delete(name);
      await tauriStore.save();
    } catch {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(name);
      }
    }
  },
};

export const useProjectStore = create<ProjectStore>()(
  persist(
    (set, get) => ({
      recentProjects: [],
      dismissedPaths: [],
      activeProjectPath: null,
      isDiscovering: false,

      openProject: (path) => {
        const clean = path.length > 1 ? path.replace(/[\\/]+$/, '') : path;
        const entry: RecentProject = {
          path: clean,
          name: projectNameFromPath(clean),
          last_opened: Date.now(),
        };
        set((state) => ({
          activeProjectPath: clean,
          // Re-opening un-dismisses the project
          dismissedPaths: state.dismissedPaths.filter((p) => p !== clean),
          recentProjects: [entry, ...state.recentProjects.filter((p) => p.path !== clean)].slice(0, MAX_RECENT),
        }));
      },

      closeProject: () => set({ activeProjectPath: null }),

      removeProject: (path) =>
        set((state) => ({
          recentProjects: state.recentProjects.filter((p) => p.path !== path),
          dismissedPaths: state.dismissedPaths.includes(path) ? state.dismissedPaths : [...state.dismissedPaths, path],
          activeProjectPath: state.activeProjectPath === path ? null : state.activeProjectPath,
        })),

      clearAllRecent: () =>
        set((state) => ({
          dismissedPaths: Array.from(new Set([...state.dismissedPaths, ...state.recentProjects.map((p) => p.path)])),
          recentProjects: [],
        })),

      pickAndOpenProject: async () => {
        try {
          const folder = await tauriApi.pickFolder();
          if (!folder) return false;
          get().openProject(folder);
          return true;
        } catch (e) {
          console.error('Failed to pick project folder:', e);
          return false;
        }
      },

      discoverLocalProjects: async () => {
        set({ isDiscovering: true });
        try {
          const specialDirs = await tauriApi.getSpecialDirs();
          const candidateRoots: string[] = [];

          if (specialDirs.documents) {
            candidateRoots.push(`${specialDirs.documents}/projects`);
            candidateRoots.push(`${specialDirs.documents}/Projects`);
            candidateRoots.push(`${specialDirs.documents}`);
          }
          if (specialDirs.home) {
            candidateRoots.push(`${specialDirs.home}/projects`);
            candidateRoots.push(`${specialDirs.home}/Projects`);
            candidateRoots.push(`${specialDirs.home}/Developer`);
          }

          const discovered: RecentProject[] = [];
          const currentPaths = new Set(get().recentProjects.map((p) => p.path));
          const dismissed = new Set(get().dismissedPaths);

          for (const root of candidateRoots) {
            try {
              const entries = await tauriApi.listDirectory(root, false);
              for (const entry of entries) {
                if (
                  entry.is_dir &&
                  !entry.name.startsWith('.') &&
                  !currentPaths.has(entry.path) &&
                  !dismissed.has(entry.path)
                ) {
                  currentPaths.add(entry.path);
                  discovered.push({
                    path: entry.path,
                    name: entry.name,
                    last_opened: Date.now() - 86400000,
                  });
                }
              }
            } catch {
              // Root folder doesn't exist, ignore
            }
          }

          if (discovered.length > 0) {
            set((state) => ({
              recentProjects: [...state.recentProjects, ...discovered].slice(0, MAX_RECENT),
              isDiscovering: false,
            }));
          } else {
            set({ isDiscovering: false });
          }
        } catch (err) {
          console.error('Project discovery error:', err);
          set({ isDiscovering: false });
        }
      },
    }),
    {
      name: 'morfeus-projects-v2',
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({
        recentProjects: state.recentProjects,
        dismissedPaths: state.dismissedPaths,
        activeProjectPath: state.activeProjectPath,
      }),
    }
  )
);
