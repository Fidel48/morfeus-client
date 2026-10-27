# Morfeus Client — Agents & Developer Guide

Welcome to **Morfeus Client**! This file serves as the unified operational guide, architectural overview, and current state tracker for AI agents and developer tools (Cursor, Windsurf, Claude Code, Antigravity, Copilot, Cline, Roo Code, etc.) picking up work on this repository.

---

## 1. Project Overview & Tech Stack

Morfeus Client is a local-first, privacy-focused desktop AI developer assistant built with Tauri v2.

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS + Vanilla CSS, Zustand (state management with `@tauri-apps/plugin-store` lazy persistence), Framer Motion, TanStack Query.
- **Backend / Desktop Layer**: Rust (Tauri v2), Tokio async runtime, `reqwest` (CORS bypass proxy for LLMs & web search), `cpal` + macOS native CoreAudio / Swift Speech API, `scraper` for HTML parsing, `tauri-plugin-opener`, `tauri-plugin-updater`.
- **LLM Connectivity**: Connects to local OpenAI-compatible endpoints (Ollama, LM Studio) and cloud endpoints (Gemini, OpenRouter, OpenAI, Groq). Supports vision models, multi-modal image inputs, and agentic tool-use loops.

---

## 2. Permanent Workspace Rules (CRITICAL — NEVER VIOLATE)

1. **Web Search Directives**:
   - Always render **ONLY ONE** single `web_search` badge per user turn in the chat UI. Intermediate duplicate badges must be suppressed from the chat timeline.
   - Every response utilizing `web_search` **MUST state the exact Current Date and Time** (e.g., *"As of Tuesday, October 13, 2026 at 10:15:00 PM..."*).
   - Every response utilizing `web_search` **MUST include direct clickable Markdown source links** (e.g. `[Source Title](url)`) pointing to exact URLs returned by the search tool.
   - **No Code Reversions**: DO NOT remove, overwrite, or simplify the multi-stage DuckDuckGo search engine (`html.duckduckgo.com` -> `lite.duckduckgo.com` -> `api.duckduckgo.com`) or the tool depth limit (max 5 turns).
2. **macOS Native Voice Architecture**:
   - On macOS, **NEVER** use browser `webkitSpeechRecognition` or JS `getUserMedia()` inside WKWebView — doing so causes a hard TCC process `SIGABRT` crash.
   - **ALWAYS** capture audio natively via Rust CoreAudio (`cpal`), invoke Objective-C `[AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio]` (`mac_audio.m`), and transcribe using Apple's built-in `SFSpeechRecognizer` (`mac_speech.swift`).
3. **Windows 11 Compatibility & Push-to-Talk**:
   - On Windows 11, preserve `webkitSpeechRecognition`. Maintain `latestText` preservation across interim and final speech events constructed directly from `event.results[0..N]` to prevent duplicate speech output.
   - The application is highly stable on Windows 11. Do NOT automatically rewrite, simplify, or modify Windows-specific code (`.cmd` resolutions, SAPI voices, Gatekeeper workarounds) unless explicitly requested.
4. **Git Push Rule**:
   - **NEVER** execute `git push` or push tags to GitHub without explicit, separate user authorization for that specific push.

---

## 3. Architecture & Key Directory Map

```text
morfeus/
├── src/
│   ├── App.tsx                     # Main desktop application shell & router
│   ├── components/
│   │   ├── chat/                   # Main conversation UI, attachments, mode toggles, instant trigger
│   │   │   ├── ChatWindow.tsx      # Core chat view & tool execution badges
│   │   │   ├── MessageBubble.tsx   # Markdown & syntax-highlighted code rendering
│   │   │   └── FloatingWidget.tsx  # In-chat agentic helper widget
│   │   ├── voice/                  # Push-to-Talk, voice buttons, silence detection
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx         # Conversations list and history
│   │   │   └── RightPanel.tsx      # Parameters, context, tool inspect, and future Coder Canvas
│   │   └── settings/               # Settings modals, API configuration, MCP Server settings
│   ├── hooks/
│   │   ├── useChat.ts              # Core streaming chat loop, agentic tool execution loop, tool approval
│   │   └── ...
│   ├── stores/
│   │   ├── chatStore.ts            # Zustand store persisted via Tauri store; tracks agentic/away mode
│   │   ├── settingsStore.ts        # App configuration, models, endpoints, MCP servers
│   │   └── voiceStore.ts           # Speech recognition & TTS status
│   └── lib/
│       ├── api.ts                  # OpenAI-compatible streaming API, DuckDuckGo tools, MCP registry
│       ├── tauri.ts                # Tauri IPC bridge (screen capture, audio, OS tools, MCP client)
│       └── ...
├── src-tauri/
│   ├── src/
│   │   ├── commands/
│   │   │   ├── audio.rs & voice.rs # Native CoreAudio & Speech recognition bindings
│   │   │   ├── files.rs            # Local file reading, listing, and search
│   │   │   ├── shell.rs            # Raw terminal execution and python runners
│   │   │   └── ...
│   │   ├── lsp.rs                  # Native Language Server Protocol (async-lsp)
│   │   ├── mcp.rs                  # Native Model Context Protocol (JSON-RPC stdio client)
│   │   ├── lib.rs                  # Tauri builder registration & plugin setup
│   │   └── main.rs                 # Tauri entry point
│   ├── tauri.conf.json             # Tauri configuration (permissions, windows, capabilities)
│   └── Cargo.toml
├── .agents/
│   └── AGENTS.md                   # Permanent behavioral rules
└── AGENTS.md                       # This file (Root Agent context guide)
```

---

## 4. Current State & Where We Left Off

### Recent Completed Milestones
- **v0.1.25**: Support for pasting images directly from the OS clipboard into chat.
- **v0.1.26**: Visual image attachment thumbnails in chat input and rendering inside user message bubbles.
- **v0.1.27**: Dual Fast Chat / Agent Coder modes, local Kokoro neural TTS, hands-free Continuous voice with voice toggle relocation, MCP server manager, and multiplatform CI matrix (Windows, macOS, Ubuntu Linux).
- **v0.1.29**: Multi-provider settings catalog (Ollama, LM Studio, OpenRouter, DeepSeek, OpenAI, Groq), selective model search picker, strict chat popover scoping to user-configured models, removal of hardcoded model assignments and defaults, enhanced web search synthesis with top-article auto-retrieval and Google News RSS fallback, speech interruption and cancellation fixes with default-off voice readout, markdown wrapping overflow fixes, human-readable error cards for upstream HTTP 429/402/401 rate limits and billing, native OS & HTML5 drag-and-drop file/image attachments with debounce deduplication, and ChatGPT/Gemini-style visual image rendering with interactive full-screen lightbox in user message bubbles.
- **v0.1.30**: Full 3-column VS Code + Cline Developer IDE Workspace:
  - **Left Explorer**: Interactive directory tree with lazy expansion, specialized file icons, and file/session switcher.
  - **Center Editor**: Multi-tab code editor with line gutter, modified indicators, breadcrumbs, ▶ Run / 💾 Save / Diff view actions, minimal VS Code watermark empty state, and collapsible execution output drawer.
  - **Right Panel**: Autonomous Agent Coder panel with collapsible drawer.
  - **Workspace & Storage**: Native project picker with recent projects, scratchpad launcher, and persistent disk storage via `@tauri-apps/plugin-store`.
  - **Surgical Tools & Resilience**: `grep_search`, `read_file_range`, `replace_in_file`, per-file read throttling (anti-loop protection), and fallback parsing for models emitting raw `<tool_call>` XML.

---

## 5. Development & Build Commands

```bash
# Install dependencies
npm install

# Run desktop app in development mode
npm run tauri dev

# Type check and build frontend
npm run build

# Build Rust backend separately (if testing native compilation)
cd src-tauri && cargo check
```

---

## 6. Developer Harness Roadmap & Live Execution Tracker

Our primary objective is evolving Morfeus into a **premium desktop developer harness & autonomous coding environment** (analogous to Cursor, Copilot Workspace, and Antigravity).

### Phased Roadmap

```text
Phase 1: MCP Server Manager UI (FreeCAD, GitHub, Postgres, Custom Stdio)
Phase 2: Surgical Code Editing & Codebase Search Tools (grep_search, replace_in_file, read_file_range)
Phase 3: Side-Panel Coder Canvas / IDE Scratchpad (in RightPanel with Run & Apply Diff)
Phase 4: Background Dev Server & Long-Running Process Runner
Phase 5: Language Server Protocol (LSP) Activation (Diagnostics & Auto-Fix)
```

### Live Task Tracker

| Phase | Milestone / Task | Status | Priority | Description |
| :--- | :--- | :---: | :---: | :--- |
| **P1** | MCP Server Data Model & Store | 🟢 Done | High | `McpServerConfig` in `types/index.ts`, persisted via `mcpStore.ts`. |
| **P1** | MCP Server Settings UI | 🟢 Done | High | "MCP Servers" tab in `SettingsModal.tsx` with presets, add/delete, status badges. |
| **P1** | MCP Tool Inspector Drawer | 🟢 Done | Medium | Expandable tool list showing discovered tools & parameters. |
| **P1** | Chat MCP Auto-Connect Tools | 🟢 Done | High | `connect_mcp_server` & `remove_mcp_server` in `useChat.ts`. |
| **P2** | `grep_search` Tool | 🟢 Done | High | Fast content/symbol search across workspace files. |
| **P2** | `read_file_range` Tool | 🟢 Done | High | Slice reading `[start..end]` with line numbers to avoid dumping whole files. |
| **P2** | `replace_in_file` Tool | 🟢 Done | High | Surgical search-and-replace block edits without file rewrites. |
| **P3** | Side-Panel Coder Canvas Tab | 🟢 Done | High | Dedicated Canvas tab in `RightPanel.tsx` with dynamic 560px width. |
| **P3** | Canvas Action Toolbar | 🟢 Done | High | "▶️ Run Code", "💾 Save", "📋 Copy", "Diff View", and console logs. |
| **P3** | Chat-to-Canvas Sync | 🟢 Done | Medium | "Canvas" button in code blocks and live file sync upon agent edits. |
| **P3** | Coder Workspace & Project Picker | 🟢 Done | High | Agent Coder swaps the layout for `components/coder/` (`ProjectPicker`, `CoderSidebar`, `CoderWorkspace`). Projects in `projectStore.ts`; conversations carry `mode` + `project_path` so Chat and Coder histories are separate. Project tree/git/rules injected into the prompt; terminal `cwd` + relative paths anchored to the project; per-session auto-approve (terminal only). |
| **P4** | Background Process Runner | ⚪ Backlog | Medium | Async `spawn_process`, `read_logs`, `kill_process` for dev servers. |
| **P5** | Expose LSP Diagnostics | ⚪ Backlog | Medium | Feed compiler errors back to agent for automatic self-repair. |
