<div align="center">
  <img src="app-icon.svg" width="128" height="128" alt="Morfeus Logo">
  <h1>Morfeus Client</h1>
  <p><strong>The Ultimate Local-First AI Assistant</strong></p>
  <p>⚠️ <em>Note: This application is currently in Beta / Work In Progress. Features and stability may vary!</em></p>
</div>

---

## 1. Introduction
**Morfeus Client** is a modern, lightweight, and incredibly powerful desktop AI assistant built on the **Tauri framework** (Rust backend + React frontend). Unlike cloud-based behemoths, Morfeus Client is designed from the ground up for **100% privacy, local execution, and zero recurring API costs.**

## 2. Key Differentiators

Most local AI interfaces (like LM Studio's built-in chat or basic web UIs) are rigid, lack native desktop integrations, and crash when context windows overflow. Morfeus Client stands out through:

* **Zero-Cost Privacy (Local LLM Integration):** Directly hooks into local inference engines like **Ollama** and **LM Studio**. Your data never leaves your machine. 
* **True Agentic Capabilities:** It's not just a chatbot. Morfeus Client is an autonomous agent capable of using tools (e.g., executing native Web Searches via the Rust backend, bypassing browser CORS restrictions entirely). It can scrape websites, read the data, and formulate answers automatically.
* **Intelligent Context Management:** The most common issue with local LLMs is silent crashes due to overloaded Context Windows. Morfeus Client includes a custom **Auto-Pruning engine**. It dynamically tracks token usage and truncates outdated history before sending the payload to the local API, ensuring your LLM never crashes from memory overflow.
* **Frictionless Voice Interface:** Moving away from the keyboard, Morfeus Client implements a pristine, native Web Speech API integration. It features both **Push-to-Talk (PTT)** and a **Smart Silence Timeout** that automatically sends your voice query when you stop speaking, creating a fluid, human-like conversational experience.
* **Premium Desktop Aesthetics:** Built with a stunning dark-mode glassmorphic UI, fluid micro-animations (Framer Motion), and a highly responsive design that feels like a native OS application.

## 3. Core Features Showcase

### 🎙️ Advanced Voice System
* **Continuous Conversation:** Speak naturally. The system automatically detects when you finish your sentence (via silence timeouts) and dispatches the query to the AI.
* **Push-to-Talk (PTT) Mode:** For noisy environments, users can toggle a traditional hold-to-talk mode that perfectly tracks pointer captures so recordings never accidentally cancel.
* **Text-to-Speech (TTS):** Morfeus Client automatically reads responses back to you using native Neural Voices. Includes a quick "Stop Speaking" action button to interrupt massive walls of text.

### 🧠 Agentic Tool Use
* **Live Web Searching:** Morfeus Client is connected to the live internet. If you ask about current events, the LLM calls the `web_search` tool, the Rust backend natively queries DuckDuckGo, and the results are injected back to the LLM—completely autonomously.
* **Anti-Hallucination & Temporal Awareness:** The system prompt dynamically injects the exact current date and time. It strictly enforces that the AI cites exact URL links from its web searches, effectively eliminating hallucinations for factual data.

### ⚙️ Deep Hardware Control
* **The "Parameters" Hub:** Users have total control over their local models directly from the UI. You can tweak the `Temperature`, `Max Output Tokens`, and precisely set the `Context Window Length` to match your PC's exact RAM capabilities.

## 4. Technical Stack
* **Frontend:** React (TypeScript), Vite, Tailwind CSS, Zustand (State Management), Framer Motion (Animations).
* **Backend:** Rust (Tauri). Handles heavy lifting, bypasses browser networking restrictions (CORS), and interfaces closely with the OS for file system and system settings.
* **AI Protocol:** OpenAI-compatible REST streaming. Connects flawlessly to local inference servers.
* **CI/CD Automation:** Fully automated GitHub Actions pipeline builds the `.exe` and `.msi` installers and publishes Over-The-Air (OTA) updates using Tauri Auto-Updater.

## 5. Getting Started

### 🍎 Installing on macOS
Because Morfeus Client is not signed with a paid Apple Developer certificate, macOS Gatekeeper may display a warning that the app is "damaged" and cannot be opened. This is a standard Apple security measure for free open-source apps. To bypass this:

1. Drag **Morfeus Client.app** from the `.dmg` into your Mac's **Applications** folder.
2. Open the **Terminal** app on your Mac (`Command + Space` and type "Terminal").
3. Copy and paste this exact command and press Enter:
   ```bash
   xattr -cr "/Applications/Morfeus Client.app"
   ```
4. Now, double-click Morfeus Client in your Applications folder and it will open perfectly!

### Recommended IDE Setup
- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

### Running Locally
1. Install [Node.js](https://nodejs.org/) (v20+) and [Rust](https://rustup.rs/).
2. Clone the repository:
   ```bash
   git clone https://github.com/Fidel48/morfeus-client.git
   cd morfeus-client
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Run the desktop app in development mode:
   ```bash
   npm run tauri dev
   ```

---
*Morfeus Client isn't just a wrapper for an API; it is a dedicated, agentic desktop environment optimized to make running open-source AI models locally feel as premium, frictionless, and powerful as enterprise cloud solutions.*
