# redbusagent

![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)

![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D%2018.0.0-success)

> The Autonomous, Self-Forging Node.js Agent with Embedded RAG and WhatsApp Control.

Redbusagent is a next-generation AI agent framework designed to run independently as a headless daemon, equipped with terminal UI (TUI) capabilities, WhatsApp remote control, robust web browsing, and intelligent cognitive routing between local and cloud LLMs.

## 🚀 Features

- **Zero-Config Embedded Ollama (Tier 1)**: Native integration for local, privacy-first inference without cloud costs.
- **Smart Cloud Escalation (Tier 2)**: Dynamically routes complex queries to powerful cloud models (Claude, Gemini, OpenAI) based on cognitive load.
- **Universal MCP Client**: Turn the agent into an AI Operating System by connecting dynamically to any standard Model Context Protocol (MCP) server.
- **Encrypted Vault**: AES-256 encrypted local storage for API keys, user credentials, and WhatsApp session tokens.
- **WhatsApp Bridge (Owner-Only Firewall)**: Remote control your agent from your phone via WhatsApp, protected by strict owner-only authentication.
- **Playwright Headless Browsing**: Persistent browsing capabilities with session state, capable of navigating, scraping, searching, and engaging with dynamic web apps.
- **Multimodal Vision Control**: Takes full-page Base64 screenshots during web sessions to enable Tier 2 models to visually debug and interact with the screen.
- **Knowledge Distillation Mechanism**: Captures brilliant outputs from Cloud models and stores them to provide on-the-fly few-shot learning directly into the local Tier 1 model.
- **Dynamic Persona System**: Fully customizable agent identities and behaviors injected at runtime instead of hardcoded prompts.
- **Self-Healing Code Forge**: Built-in coding capabilities to generate, iterate, and self-correct scripts in real time using the workspace context.

## 📦 Installation

For repository development, install workspace dependencies from the repo root:

```bash
npm install
```

If you want the `redbus` command available globally from this checkout, link it locally:

```bash
npm link
```

You can also install the current checkout globally:

```bash
npm install -g .
```

*Ensure you are running ****Node.js >= 18.0.0****.*

## 🛠 CLI Quick Start

The repository ships a command router under `redbus`. The current command flow is:

### 1. Inspect available commands

```bash
redbus --help
```

Running `redbus` with no command also prints the help screen.

### 2. Run onboarding

Configure providers, vault data, and optional channels:

```bash
redbus config
```

### 3. Start the daemon

This starts the background daemon service only:

```bash
redbus daemon
```

### 4. Open the TUI client

This connects the terminal UI to the running daemon:

```bash
redbus start
```

### 5. Stop the daemon

```bash
redbus stop
```

### 6. Install MCP extensions

```bash
redbus mcp install <name-or-cmd>
```

Within the TUI, you have access to slash commands such as `/force-local`, `/switch-cloud`, `/mcp install`, and `/status`.

## 🖥 Redbus Studio

Redbus Studio is the Electron desktop client under `apps/studio`. It adds a desktop operator surface on top of the existing daemon flow with:

- saved SSH/daemon connection profiles
- route mode controls (`auto`, `live`, `cloud`)
- request-status and operator activity surfaces
- a dedicated yield/approval modal
- separate chat, thought stream, and Forge panels

Common Studio commands from the repo root:

```bash
npm run dev:studio
npm run typecheck --workspace=@redbusagent/studio
npm run build --workspace=@redbusagent/studio
npm run dist --workspace=@redbusagent/studio -- --dir
```

For setup details, connection fields, and current workflow notes, see `apps/studio/README.md`.

## 🏗 Architecture Overview

Redbusagent relies on a decoupled client/server model:

- **The Daemon (**`@redbusagent/daemon`**)**: the headless runtime that handles orchestration, tools, browsing, channels, and background work.
- **The TUI (**`@redbusagent/tui`**)**: the terminal client that connects to a running daemon.
- **Redbus Studio (**`@redbusagent/studio`**)**: the Electron desktop client for SSH-tunneled remote daemon sessions and operator-oriented monitoring.

That split lets the daemon keep running in the background while multiple clients attach to it when needed.

## License

This project is licensed under the [GPL-3.0 License](LICENSE).