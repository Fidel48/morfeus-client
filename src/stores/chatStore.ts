import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import { LazyStore } from '@tauri-apps/plugin-store';
import { Conversation, Message, ChatStatus, ToolCall, ToolCallDelta, ChatMode } from '@/types';
import { generateId } from '@/lib/utils';
import { speechQueue } from '@/lib/kokoroTts';
import { tauriApi } from '@/lib/tauri';
import { useSettingsStore } from './settingsStore';
import { useProjectStore } from './projectStore';

export interface PendingToolApproval {
  toolName: string;
  args: any;
  resolve: (approved: boolean) => void;
}

// Initialize filesystem store to bypass the 5MB localStorage limit
const tauriStore = new LazyStore('chat-storage.json');

const tauriStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    let val = await tauriStore.get<string>(name);
    if (!val) {
       // Fallback to localStorage for migration
       const localVal = localStorage.getItem(name);
       if (localVal) {
          val = localVal;
          // Migrate it silently
          await tauriStore.set(name, localVal);
          await tauriStore.save();
       }
    }
    return val || null;
  },
  setItem: async (name: string, value: string): Promise<void> => {
    await tauriStore.set(name, value);
    await tauriStore.save();
  },
  removeItem: async (name: string): Promise<void> => {
    await tauriStore.delete(name);
    await tauriStore.save();
  },
};

interface ChatStore {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Message[];
  streamingContent: string;
  streamingReasoning: string;
  streamingToolCalls: ToolCallDelta[];
  isStreaming: boolean;
  chatStatus: ChatStatus;
  abortController: AbortController | null;
  rightPanelOpen: boolean;
  rightPanelTab: 'code' | 'parameters' | 'context' | 'tools';
  activeMcpServers: string[];
  isAgenticMode: boolean;
  chatMode: ChatMode;
  pendingApproval: PendingToolApproval | null;
  /** Per-session: auto-approve terminal commands without asking (reset when the session changes). */
  autoApprove: boolean;

  // Actions
  setConversations: (conversations: Conversation[]) => void;
  addConversation: (conversation: Conversation) => void;
  updateConversation: (id: string, partial: Partial<Conversation>) => void;
  deleteConversation: (id: string) => void;
  setActiveConversation: (id: string | null) => void;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  appendStreamToken: (token: string) => void;
  appendReasoningToken: (token: string) => void;
  appendToolCallDelta: (toolCallsDelta: ToolCallDelta[]) => void;
  finalizeStreamMessage: (conversationId: string) => Message;
  clearStreamingContent: () => void;
  setIsStreaming: (streaming: boolean) => void;
  setChatStatus: (status: ChatStatus) => void;
  setAbortController: (ctrl: AbortController | null) => void;
  stopStreaming: () => void;
  newConversation: () => Conversation;
  toggleRightPanel: () => void;
  setRightPanelTab: (tab: 'code' | 'parameters' | 'context' | 'tools') => void;
  openRightPanelTab: (tab: 'code' | 'parameters' | 'context' | 'tools') => void;
  addMcpServer: (id: string) => void;
  setIsAgenticMode: (isAgentic: boolean) => void;
  setChatMode: (mode: ChatMode) => void;
  setPendingApproval: (approval: PendingToolApproval | null) => void;
  setAutoApprove: (value: boolean) => void;
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => ({
      conversations: [],
      activeConversationId: null,
      messages: [],
      streamingContent: '',
      streamingReasoning: '',
      streamingToolCalls: [],
      isStreaming: false,
      chatStatus: 'idle',
      abortController: null,
      rightPanelOpen: false,
      rightPanelTab: 'code',
      activeMcpServers: [],
      isAgenticMode: false,
      chatMode: 'fast',
      pendingApproval: null,
      autoApprove: false,

      setConversations: (conversations) => set({ conversations }),
      
      addConversation: (conversation) =>
        set((state) => ({
          conversations: [conversation, ...state.conversations],
        })),

      updateConversation: (id, partial) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, ...partial } : c
          ),
        })),

      deleteConversation: (id) => {
        const state = get();
        const isActive = state.activeConversationId === id;
        if (isActive) {
          if (state.abortController) {
            state.abortController.abort();
          }
          speechQueue.stop();
          tauriApi.stopSpeaking().catch(() => {});
        }
        set((prevState) => ({
          conversations: prevState.conversations.filter((c) => c.id !== id),
          activeConversationId:
            prevState.activeConversationId === id ? null : prevState.activeConversationId,
          messages: prevState.messages.filter((m) => m.conversation_id !== id),
          ...(isActive
            ? {
                isStreaming: false,
                abortController: null,
                streamingContent: '',
                streamingReasoning: '',
                streamingToolCalls: [],
                chatStatus: 'idle',
              }
            : {}),
        }));
      },

      setActiveConversation: (id) => {
        if (get().activeConversationId !== id) {
          const { abortController, isStreaming } = get();
          if (abortController || isStreaming) {
            abortController?.abort();
            speechQueue.stop();
            tauriApi.stopSpeaking().catch(() => {});
          }
          // Default voice readout to OFF when switching/opening a conversation
          useSettingsStore.getState().updateSettings({ tts_enabled: false, continuous_voice: false });
          set({
            activeConversationId: id,
            isStreaming: false,
            abortController: null,
            streamingContent: '',
            streamingReasoning: '',
            streamingToolCalls: [],
            chatStatus: 'idle',
            autoApprove: false,
          });
        }
      },

      setMessages: (messages) => set({ messages }),

      addMessage: (message) =>
        set((state) => ({ messages: [...state.messages, message] })),

      appendStreamToken: (token) =>
        set((state) => ({ streamingContent: state.streamingContent + token })),

      appendReasoningToken: (token) =>
        set((state) => ({ streamingReasoning: state.streamingReasoning + token })),

      appendToolCallDelta: (toolCallsDelta) =>
        set((state) => {
          const current = [...state.streamingToolCalls];
          
          toolCallsDelta.forEach((delta) => {
            const index = delta.index ?? 0;
            if (!current[index]) {
              current[index] = {
                index,
                id: delta.id || `call_${Date.now()}_${index}`,
                type: delta.type || 'function',
                function: {
                  name: delta.function?.name || '',
                  arguments: delta.function?.arguments || '',
                },
              };
            } else {
              if (delta.id) current[index].id = delta.id;
              if (!current[index].id) current[index].id = `call_${Date.now()}_${index}`;
              if (delta.type) current[index].type = delta.type;
              if (!current[index].type) current[index].type = 'function';
              if (delta.function) {
                if (!current[index].function) {
                  current[index].function = { name: '', arguments: '' };
                }
                if (delta.function.name) current[index].function!.name = (current[index].function!.name || '') + delta.function.name;
                if (delta.function.arguments) current[index].function!.arguments = (current[index].function!.arguments || '') + delta.function.arguments;
              }
            }
          });
          
          return { streamingToolCalls: current };
        }),

      finalizeStreamMessage: (conversationId) => {
        const { streamingContent, streamingReasoning, streamingToolCalls } = get();
        
        // Convert Partial<ToolCall>[] to ToolCall[] if they are complete enough
        const tool_calls = streamingToolCalls.length > 0 
          ? (streamingToolCalls as ToolCall[]) 
          : undefined;

        // Bug #14: guard against fully empty messages (no content, no tool calls)
        const content = streamingContent || (tool_calls ? undefined : '[empty response]');

        const message: Message = {
          id: generateId(),
          conversation_id: conversationId,
          role: 'assistant',
          content,
          reasoning: streamingReasoning || undefined,
          tool_calls,
          created_at: Date.now(),
        };
        set((state) => ({
          messages: [...state.messages, message],
          streamingContent: '',
          streamingReasoning: '',
          streamingToolCalls: [],
        }));
        return message;
      },

      clearStreamingContent: () => set({ streamingContent: '', streamingReasoning: '', streamingToolCalls: [] }),

      setIsStreaming: (isStreaming) => set({ isStreaming }),

      setChatStatus: (chatStatus) => set({ chatStatus }),

      setAbortController: (abortController) => set({ abortController }),

      stopStreaming: () => {
        const { abortController } = get();
        if (abortController) {
          abortController.abort();
        }
        speechQueue.stop();
        tauriApi.stopSpeaking().catch(() => {});
        set({
          isStreaming: false,
          chatStatus: 'idle',
          abortController: null,
        });
      },

      newConversation: () => {
        const { abortController, isStreaming } = get();
        if (abortController || isStreaming) {
          abortController?.abort();
          speechQueue.stop();
          tauriApi.stopSpeaking().catch(() => {});
        }
        // Default voice readout to OFF when opening a new chat
        useSettingsStore.getState().updateSettings({ tts_enabled: false, continuous_voice: false });

        const isAgent = get().chatMode === 'agent';
        const projectPath = isAgent ? useProjectStore.getState().activeProjectPath : null;
        const conversation: Conversation = {
          id: generateId(),
          title: isAgent ? 'New Session' : 'New Chat',
          created_at: Date.now(),
          updated_at: Date.now(),
          mode: isAgent ? 'agent' : 'fast',
          ...(projectPath ? { project_path: projectPath } : {}),
        };
        set({
          conversations: [conversation, ...get().conversations],
          activeConversationId: conversation.id,
          streamingContent: '',
          streamingReasoning: '',
          streamingToolCalls: [],
          isStreaming: false,
          abortController: null,
          chatStatus: 'idle',
          autoApprove: false,
        });
        return conversation;
      },

      toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
      setRightPanelTab: (rightPanelTab) => set({ rightPanelTab }),
      openRightPanelTab: (tab) => set({ rightPanelOpen: true, rightPanelTab: tab }),
      addMcpServer: (id) =>
        set((state) => ({
          activeMcpServers: state.activeMcpServers.includes(id)
            ? state.activeMcpServers
            : [...state.activeMcpServers, id],
        })),

      // Switching between Chat and Agent Coder swaps to a separate conversation space:
      // the active conversation is cleared if it belongs to the other mode (empty drafts are dropped).
      setIsAgenticMode: (isAgenticMode) => get().setChatMode(isAgenticMode ? 'agent' : 'fast'),
      setChatMode: (chatMode) => {
        const state = get();
        const active = state.conversations.find((c) => c.id === state.activeConversationId);
        const activeMode = active?.mode ?? 'fast';

        if (active && activeMode !== chatMode) {
          state.abortController?.abort();
          speechQueue.stop();
          const isEmptyDraft = !state.messages.some((m) => m.conversation_id === active.id);
          set({
            chatMode,
            isAgenticMode: chatMode === 'agent',
            activeConversationId: null,
            conversations: isEmptyDraft
              ? state.conversations.filter((c) => c.id !== active.id)
              : state.conversations,
            isStreaming: false,
            abortController: null,
            streamingContent: '',
            streamingReasoning: '',
            streamingToolCalls: [],
            chatStatus: 'idle',
            autoApprove: false,
          });
          return;
        }
        set({ chatMode, isAgenticMode: chatMode === 'agent' });
      },
      setPendingApproval: (pendingApproval) => set({ pendingApproval }),
      setAutoApprove: (autoApprove) => set({ autoApprove }),
    }),
    {
      name: 'morfeus-chat-storage',
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({
        conversations: state.conversations,
        messages: state.messages.map(m => {
          if (m.role === 'tool' && m.content && m.content.startsWith('![Screenshot](data:image/png;base64,')) {
            return { ...m, content: '![Screenshot](image_removed_from_storage)' };
          }
          return m;
        }),
        activeConversationId: state.activeConversationId,
        rightPanelOpen: state.rightPanelOpen,
        chatMode: state.chatMode,
      }),
    }
  )
);
