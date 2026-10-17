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
- **Commit `76530ca`**: Agentic UI overlay and vision/control using terminal fallback to prevent macOS TCC deadlock.

### Active Work-in-Progress (Uncommitted Changes)
1. **Local Kokoro TTS Integration**:
   - Local FastAPI server (`src-tauri/kokoro_server.py`) auto-spawned by Tauri async runtime on `http://127.0.0.1:8880`.
   - Native audio playback via macOS `afplay` in `src-tauri/src/commands/voice.rs`.
   - High-fidelity voice selection settings UI with live previews for 22 voices (`af_heart` default).
2. **Dual Chat Modes (Fast Chat vs. Agent Coder)**:
   - Replaced Away Mode with a modern segmented header pill: `[⚡ Fast Chat | 🤖 Agent Coder]`.
   - **⚡ Fast Chat Mode**: Minimal tool overhead (only 6 lightweight read-only tools: `web_search`, `read_webpage`, `get_special_dirs`, `search_files`, `list_directory`, `read_local_file`) and lean system prompt for lightning-fast response times matching Ollama CLI speeds.
   - **🤖 Agent Coder Mode**: Full IDE developer harness with access to all built-in tools (Python runners, terminal commands, file write/delete, screen vision, keyboard/mouse automation) and dynamic MCP servers.

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
| **P2** | `grep_search` Tool | ⚪ Backlog | High | Fast ripgrep/content search across workspace files. |
| **P2** | `read_file_range` Tool | ⚪ Backlog | High | Slice reading `[start..end]` to avoid dumping whole files. |
| **P2** | `replace_in_file` Tool | ⚪ Backlog | High | Surgical search-and-replace block edits without file rewrites. |
| **P3** | Side-Panel Coder Canvas Tab | ⚪ Backlog | High | Dedicated Code tab in `RightPanel.tsx` with syntax highlighting. |
| **P3** | Canvas Action Toolbar | ⚪ Backlog | High | "▶️ Run Code", "💾 Apply to Workspace", and "Diff View". |
| **P3** | Chat-to-Canvas Sync | ⚪ Backlog | Medium | Button in message code blocks to open and inspect in side canvas. |
| **P4** | Background Process Runner | ⚪ Backlog | Medium | Async `spawn_process`, `read_logs`, `kill_process` for dev servers. |
| **P5** | Expose LSP Diagnostics | ⚪ Backlog | Medium | Feed compiler errors back to agent for automatic self-repair. |
