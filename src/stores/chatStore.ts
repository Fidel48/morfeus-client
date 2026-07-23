import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Conversation, Message, ChatStatus, ToolCall, ToolCallDelta } from '@/types';
import { generateId } from '@/lib/utils';

interface ChatStore {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Message[];
  streamingContent: string;
  streamingToolCalls: ToolCallDelta[];
  isStreaming: boolean;
  chatStatus: ChatStatus;
  abortController: AbortController | null;
  rightPanelOpen: boolean;
  activeMcpServers: string[];

  // Actions
  setConversations: (conversations: Conversation[]) => void;
  addConversation: (conversation: Conversation) => void;
  updateConversation: (id: string, partial: Partial<Conversation>) => void;
  deleteConversation: (id: string) => void;
  setActiveConversation: (id: string | null) => void;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  appendStreamToken: (token: string) => void;
  appendToolCallDelta: (toolCallsDelta: ToolCallDelta[]) => void;
  finalizeStreamMessage: (conversationId: string) => Message;
  clearStreamingContent: () => void;
  setIsStreaming: (streaming: boolean) => void;
  setChatStatus: (status: ChatStatus) => void;
  setAbortController: (ctrl: AbortController | null) => void;
  stopStreaming: () => void;
  newConversation: () => Conversation;
  toggleRightPanel: () => void;
  addMcpServer: (id: string) => void;
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => ({
      conversations: [],
      activeConversationId: null,
      messages: [],
      streamingContent: '',
      streamingToolCalls: [],
      isStreaming: false,
      chatStatus: 'idle',
      abortController: null,
      rightPanelOpen: false,
      activeMcpServers: [],

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

      deleteConversation: (id) =>
        set((state) => ({
          conversations: state.conversations.filter((c) => c.id !== id),
          activeConversationId:
            state.activeConversationId === id ? null : state.activeConversationId,
          messages: state.messages.filter((m) => m.conversation_id !== id),
        })),

      setActiveConversation: (id) => set({ activeConversationId: id }),

      setMessages: (messages) => set({ messages }),

      addMessage: (message) =>
        set((state) => ({ messages: [...state.messages, message] })),

      appendStreamToken: (token) =>
        set((state) => ({ streamingContent: state.streamingContent + token })),

      appendToolCallDelta: (toolCallsDelta) =>
        set((state) => {
          const current = [...state.streamingToolCalls];
          
          toolCallsDelta.forEach((delta) => {
            const index = delta.index ?? 0;
            if (!current[index]) {
              current[index] = { ...delta };
              if (current[index].function) {
                current[index].function = { ...delta.function };
              }
            } else {
              if (delta.id) current[index].id = delta.id;
              if (delta.type) current[index].type = delta.type;
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
        const { streamingContent, streamingToolCalls } = get();
        
        // Convert Partial<ToolCall>[] to ToolCall[] if they are complete enough
        const tool_calls = streamingToolCalls.length > 0 
          ? (streamingToolCalls as ToolCall[]) 
          : undefined;

        const message: Message = {
          id: generateId(),
          conversation_id: conversationId,
          role: 'assistant',
          content: streamingContent || undefined,
          tool_calls,
          created_at: Date.now(),
        };
        set((state) => ({
          messages: [...state.messages, message],
          streamingContent: '',
          streamingToolCalls: [],
        }));
        return message;
      },

      clearStreamingContent: () => set({ streamingContent: '', streamingToolCalls: [] }),

      setIsStreaming: (isStreaming) => set({ isStreaming }),

      setChatStatus: (chatStatus) => set({ chatStatus }),

      setAbortController: (abortController) => set({ abortController }),

      stopStreaming: () => {
        const { abortController } = get();
        if (abortController) {
          abortController.abort();
        }
        set({
          isStreaming: false,
          chatStatus: 'idle',
          abortController: null,
        });
      },

      newConversation: () => {
        const conversation: Conversation = {
          id: generateId(),
          title: 'New Chat',
          created_at: Date.now(),
          updated_at: Date.now(),
        };
        set({
          conversations: [conversation, ...get().conversations],
          activeConversationId: conversation.id,
          streamingContent: '',
          streamingToolCalls: [],
          chatStatus: 'idle',
        });
        return conversation;
      },

      toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
      addMcpServer: (id) => set((state) => ({ 
        activeMcpServers: state.activeMcpServers.includes(id) ? state.activeMcpServers : [...state.activeMcpServers, id] 
      })),
    }),
    {
      name: 'morfeus-chat-storage',
      partialize: (state) => ({
        conversations: state.conversations,
        messages: state.messages,
        activeConversationId: state.activeConversationId,
        rightPanelOpen: state.rightPanelOpen,
      }),
    }
  )
);
