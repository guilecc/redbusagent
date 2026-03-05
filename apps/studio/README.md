# Redbus Studio

Redbus Studio is the Electron desktop client for Redbus. It is designed for operators who want a desktop surface for connecting to a Redbus daemon over SSH, monitoring activity, and handling blocking approvals without living in the terminal full-time.

## What ships today

- SSH-backed connection flow to a remote Redbus daemon
- Saved connection profiles persisted in local Studio settings
- Route mode controls: `auto`, `live`, and `cloud`
- Separate chat, operator activity, and thought stream surfaces
- Request-status control and tunnel/session feedback
- Blocking yield modal for approvals and questions

## Current boundaries

- Studio connects to an existing remote daemon; it does **not** start the remote daemon for you.
- Route control is currently mode-based only; there is no model picker beyond `auto` / `live` / `cloud`.
- The Forge panel is a read-only status surface, not a full local editor workflow.

## Prerequisites

From the repository root:

```bash
npm install
```

You need all of the following before a Studio session will connect cleanly:

- Node.js 18+
- a reachable remote machine with Redbus installed
- the remote daemon already running (`redbus daemon` on the target host)
- SSH authentication via either a private key path in Studio or a locally available `SSH_AUTH_SOCK`

## Local Studio commands

Run these from the repository root:

```bash
npm run dev:studio
npm run typecheck --workspace=@redbusagent/studio
npm run build --workspace=@redbusagent/studio
npm run dist --workspace=@redbusagent/studio -- --dir
```

Useful support scripts for native Electron dependencies:

```bash
npm run install:app-deps --workspace=@redbusagent/studio
npm run rebuild --workspace=@redbusagent/studio
```

Notes:

- `dev:studio` launches the Electron + renderer development workflow.
- `typecheck` validates both the Electron/node and renderer TypeScript configs.
- `build` produces the packaged app sources under `apps/studio/out`.
- `dist -- --dir` is the fastest local packaging check and writes unpacked artifacts under `apps/studio/dist`.

## Remote daemon prep

On the remote machine you plan to connect to:

```bash
redbus config
redbus daemon
```

If you also want the terminal client on that machine, use:

```bash
redbus start
```

Studio itself only needs the daemon to be up and reachable through SSH port forwarding.

## Connection profile fields

Studio stores profiles locally and lets you either connect with the saved profile or use the current form values without saving.

| Field | Meaning |
| --- | --- |
| Profile name | Label used in the saved-profile picker |
| Host | Remote SSH host or IP |
| SSH port | SSH port for the remote machine, default 22 |
| Username | SSH username |
| Private key path | Optional path to the SSH private key used for auth |
| Passphrase | Optional key passphrase; used for the current session and not saved |
| Daemon WS port | Remote Redbus daemon WebSocket port, default 6600 |
| Daemon API port | Remote daemon API port, default 8765 |
| Local WS/API ports | Optional fixed local forwarded ports if you do not want auto-assigned ports |

Profiles, the last selected profile, and the default route mode are persisted in Studio's local `studio-settings.json` file under Electron's user-data directory.

## Daily workflow

1. Start Studio with `npm run dev:studio`.
2. Pick a saved profile or enter ad-hoc connection values.
3. Click **Connect saved** or **Connect with current values**.
4. Confirm the status bar shows connected session/tunnel/daemon states.
5. Choose the default route mode:
  - `Auto-route` lets the daemon decide.
  - `Live` pins outgoing chat requests to the live tier.
  - `Cloud` pins outgoing chat requests to the cloud tier.
6. Use **Request status** when you want a fresh daemon status event in the activity surface.
7. Chat in the center panel while monitoring:
  - **Operator Activity** for tunnel events, status responses, and session feedback
  - **Thought Stream** for the agent's thought/tool timeline
  - **Forge** for current Forge status, active file, and tool summary
8. If the daemon blocks on approval or a question, respond in the yield modal to continue the run.
9. Use **Disconnect** to close the active Studio session.

## Troubleshooting

- If connect fails immediately with an SSH auth error, provide a valid `Private key path` or make sure `SSH_AUTH_SOCK` is available in the environment that launched Studio.
- If Studio opens but Electron native modules are out of sync after dependency changes, run `npm run install:app-deps --workspace=@redbusagent/studio` or `npm run rebuild --workspace=@redbusagent/studio`.
- If packaging succeeds but installers are not production-ready, that is expected for now: local packaging is verified, while signing, notarization, and icon polish remain outside this documentation wave.