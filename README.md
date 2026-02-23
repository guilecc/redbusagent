# redbusagent

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D%2018.0.0-success)

> **The Autonomous, Self-Forging Node.js Agent with Embedded RAG and WhatsApp Control.**

Redbusagent is a next-generation AI agent framework designed to run independently as a headless daemon, equipped with terminal UI (TUI) capabilities, WhatsApp remote control, robust web browsing, and intelligent cognitive routing between local and cloud LLMs.

---

## 🚀 Features

* **Zero-Config Embedded Ollama (Tier 1)**: Native integration for local, privacy-first inference without cloud costs.
* **Smart Cloud Escalation (Tier 2)**: Dynamically routes complex queries to powerful cloud models (Claude, Gemini, OpenAI) based on cognitive load.
* **Encrypted Vault**: AES-256 encrypted local storage for API keys, user credentials, and WhatsApp session tokens.
* **WhatsApp Bridge (Owner-Only Firewall)**: Remote control your agent from your phone via WhatsApp, protected by strict owner-only authentication.
* **Playwright Headless Browsing**: Persistent browsing capabilities with session state, capable of navigating, scraping, searching, and engaging with dynamic web apps.
* **Self-Healing Code Forge**: Built-in coding capabilities to generate, iterate, and self-correct scripts in real time using the workspace context.

---

## 📦 Installation

To install `redbusagent` globally on your machine to use via the CLI, clone the repository and run:

```bash
npm install -g .
```

Alternatively, for local development, you can link the package:

```bash
npm link
```

*Ensure you are running **Node.js >= 18.0.0**.*

---

## 🛠 Usage Guide

The `redbusagent` is managed completely via its intuitive CLI. 

### 1. Initial Onboarding
To set up your AI providers, local vault, and WhatsApp Bridge, simply run:
```bash
redbus config
```
This will launch an interactive wizard to configure everything you need.

### 2. Start the Daemon
Once configured, you can fire up the background daemon to handle inference, vectors, web sessions, and incoming WhatsApp commands:
```bash
redbus start
```

### 3. Interactive TUI & Slash Commands
To chat with the agent locally via your terminal, simply open the TUI:
```bash
redbus
```

Within the TUI, you have access to **Slash Commands** for quick overrides. Type `/` in the input to explore options like:
* `/force-local` — Route the next message exclusively to the local Tier 1 model.
* `/switch-cloud` — Escalate to the Tier 2 provider.
* `/status` — View health, WhatsApp connection status, and active models.

---

## 🏗 Architecture Overview

Redbusagent relies on a **Decoupled Daemon/TUI Pattern**:

* **The Daemon (`@redbusagent/daemon`)**: The heavy lifter. A headless WebSocket server that orchestrates vector retrieval (RAG), runs Playwright browsers, connects to WhatsApp, and manages all tool logic and API interactions.
* **The TUI (`@redbusagent/tui`)**: The lightweight client. An interactive terminal UI (built with React/Ink) that connects to the daemon via WebSockets. It acts strictly as an interface, ensuring your primary terminal is never blocked by massive AI tasks or web scraping loops.

This architecture means the daemon can safely hum along in the background serving requests from WhatsApp, the TUI, or other clients without locking up the terminal.

---

## License

This project is licensed under the [MIT License](LICENSE).
