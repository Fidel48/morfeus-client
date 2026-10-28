/**
 * mcpStore.ts
 *
 * Manages MCP server configurations and their runtime status.
 * - Configurations (command, args, env, enabled) are persisted to localStorage.
 * - Runtime state (status, tools, errorMessage) is ephemeral and reset on each launch.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { McpServerConfig, McpServerStatus, McpToolInfo } from '@/types';
import { tauriApi } from '@/lib/tauri';

// ── Helpers ──────────────────────────────────────────────────────────────────

function stripRuntime(config: McpServerConfig): McpServerConfig {
  const { status: _s, tools: _t, errorMessage: _e, ...rest } = config;
  return rest;
}

// ── Store Interface ───────────────────────────────────────────────────────────

interface McpStore {
  servers: McpServerConfig[];
  isManagerOpen: boolean;

  // ── Config mutations ──
  addServer: (config: Omit<McpServerConfig, 'status' | 'tools' | 'errorMessage'>) => void;
  removeServer: (id: string) => Promise<void>;
  updateServer: (id: string, patch: Partial<McpServerConfig>) => void;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;

  // ── Runtime lifecycle ──
  connectServer: (id: string) => Promise<void>;
  disconnectServer: (id: string) => Promise<void>;
  refreshServerTools: (id: string) => Promise<void>;
  initAllServers: () => Promise<void>;

  // ── UI helpers ──
  openManager: () => void;
  closeManager: () => void;
  getActiveTools: () => Array<{ serverId: string; tool: McpToolInfo }>;
  importFromClaudeDesktop: () => Promise<{ imported: number; skipped: number; names: string[] }>;

  // ── Internal runtime update (not exposed as persisted state) ──
  _setServerRuntime: (id: string, status: McpServerStatus, tools?: McpToolInfo[], errorMessage?: string) => void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useMcpStore = create<McpStore>()(
  persist(
    (set, get) => ({
      servers: [],
      isManagerOpen: false,

      importFromClaudeDesktop: async () => {
        const discovered = await tauriApi.mcpImportClaudeDesktop();
        let imported = 0;
        let skipped = 0;
        const names: string[] = [];

        for (const item of discovered) {
          const exists = get().servers.some((s) => s.id === item.id);
          if (exists) {
            skipped++;
            continue;
          }
          get().addServer({
            id: item.id,
            name: item.name,
            command: item.command,
            args: item.args,
            env: item.env,
            enabled: true,
          });
          imported++;
          names.push(item.id);
        }

        return { imported, skipped, names };
      },

      addServer: (config) => {
        const full: McpServerConfig = {
          ...config,
          enabled: config.enabled ?? true,
          status: 'disabled',
          tools: [],
        };
        set((s) => ({ servers: [...s.servers, full] }));
        if (full.enabled) {
          setTimeout(() => get().connectServer(full.id), 50);
        }
      },

      removeServer: async (id) => {
        try { await tauriApi.mcpStopServer(id); } catch { /* ignore */ }
        set((s) => ({ servers: s.servers.filter((srv) => srv.id !== id) }));
      },

      updateServer: (id, patch) => {
        set((s) => ({
          servers: s.servers.map((srv) =>
            srv.id === id ? { ...srv, ...patch } : srv
          ),
        }));
      },

      setEnabled: async (id, enabled) => {
        get().updateServer(id, { enabled });
        if (enabled) {
          await get().connectServer(id);
        } else {
          await get().disconnectServer(id);
        }
      },

      connectServer: async (id) => {
        const srv = get().servers.find((s) => s.id === id);
        if (!srv) return;

        get()._setServerRuntime(id, 'connecting');
        try {
          await tauriApi.mcpStartServer(id, srv.command, srv.args, srv.env ?? {});
          const res = await Promise.race([
            tauriApi.mcpListTools(id),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), 10_000)
            ),
          ]);
          const tools: McpToolInfo[] = res?.tools ?? [];
          get()._setServerRuntime(id, 'connected', tools);
        } catch (err: any) {
          get()._setServerRuntime(id, 'error', [], String(err?.message ?? err));
        }
      },

      disconnectServer: async (id) => {
        try { await tauriApi.mcpStopServer(id); } catch { /* ignore */ }
        get()._setServerRuntime(id, 'disabled', []);
      },

      refreshServerTools: async (id) => {
        try {
          const res = await tauriApi.mcpListTools(id);
          const tools: McpToolInfo[] = res?.tools ?? [];
          get().updateServer(id, { tools });
        } catch (err: any) {
          get().updateServer(id, { errorMessage: String(err?.message ?? err) });
        }
      },

      initAllServers: async () => {
        const enabledServers = get().servers.filter((s) => s.enabled);
        set((s) => ({
          servers: s.servers.map((srv) => ({
            ...srv,
            status: srv.enabled ? ('connecting' as McpServerStatus) : ('disabled' as McpServerStatus),
            tools: [],
            errorMessage: undefined,
          })),
        }));
        await Promise.allSettled(enabledServers.map((s) => get().connectServer(s.id)));
      },

      openManager: () => set({ isManagerOpen: true }),
      closeManager: () => set({ isManagerOpen: false }),

      getActiveTools: () => {
        const result: Array<{ serverId: string; tool: McpToolInfo }> = [];
        for (const srv of get().servers) {
          if (srv.status === 'connected' && srv.tools) {
            for (const tool of srv.tools) {
              result.push({ serverId: srv.id, tool });
            }
          }
        }
        return result;
      },

      _setServerRuntime: (id, status, tools, errorMessage) => {
        set((s) => ({
          servers: s.servers.map((srv) =>
            srv.id === id ? { ...srv, status, tools: tools ?? srv.tools, errorMessage } : srv
          ),
        }));
      },
    }),
    {
      name: 'morfeus-mcp-servers',
      partialize: (state) => ({
        servers: state.servers.map(stripRuntime),
      }),
    }
  )
);
