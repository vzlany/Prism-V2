# Prism V2

A desktop agent for Windows: **Prism V2** is the V2 fork of [Prism](https://github.com/lithIV/prism),
which itself is a fork of [OpenGhost](https://github.com/ANDRETRIPOL/OpenGhost) (MIT). It runs
commands, edits files, keeps git, works on the web, and draws what can be drawn: charts, diagrams
and tables next to the answer.

This is a **personal, non-commercial build**. The OpenGhost ghost character is kept —
the license allows the excluded materials (name, logo, animations, visual design) for
non-commercial use, as long as the copyright notice stays in place and the copy is not
presented as the official OpenGhost. This fork is named Prism V2 and is not affiliated.
For a public or commercial build, strip the ghost art and restyle first.

What V2 adds on top of Prism:

- **Sounds** — the chimes OpenCode ships (`alert-`, `bip-bop-`, `staplebops-`, `nope-`,
  `yup-`), chosen per event in Settings → Interface: task finished, question asked, errors.
- **The conversation gauge** — a ring right of the composer shows how much of the model's
  context this chat has used, with the price so far spelled under it; pressing it opens
  tokens in/out, cache traffic, message count and the price. It replaces the thin status
  line under the composer.
- **Live runs everywhere** — `prism web` publishes which conversations are working, so a
  phone shows the same busy ghost as the desktop, the reply appears when it lands, and a
  small meter left of the composer counts the parallel runs that are alive.
- **OpenCode prices and models** — the `~$` readout is priced from OpenCode's catalog
  (models.opencode.ai), with cache reads/writes and context tiers, cached locally. The
  model list re-reads the Go catalog in the background, so models OpenCode adds or retires
  appear and disappear on their own, and free ones wear a **Free** chip.
- **Auto reconnect** — a dropped connection is retried a few times before the error and its
  Retry button appear.
- **Thinking that stays readable** — earlier Thought boxes from a multi-step turn stay on
  screen (with a small 🧠), their clocks stop with the turn, and the box no longer
  scroll-jumps while the model is still writing. Steps of one turn sit close together
  instead of leaving blank bands between them.
- **Screen pictures** — two white snakes glide around a running tool card's frame at one
  constant speed, half a loop apart; file writes and edits show green `+N` / red `−M` line
  counts and carry Preview and Download on the card itself (one box per file, no second
  chip), and the `screenshot` tool captures the whole screen or one window through
  Electron itself, so it works without ffmpeg and antivirus has no script to flag.
- **Copy that works everywhere** — including a phone on plain http, where the browser
  clipboard is unavailable; the fallback still copies and the buttons answer.

## MCP servers

Prism V2 runs MCP servers in the background and hands their tools to the agent. On first
run the servers from an existing OpenCode install (global `opencode.json`/`opencode.jsonc`)
are imported into `mcp.json` inside the app data folder
(`%APPDATA%\Prism V2\mcp.json` on Windows). Edit that file to add or remove servers:

```json
{
  "servers": {
    "my-server": { "type": "local", "command": ["node", "C:\\path\\to\\server.js"], "enabled": true },
    "remote-one": { "type": "remote", "url": "https://example.com/mcp" }
  }
}
```

The settings dialog shows every server with its state and tool count, and a **Reload**
button re-reads the file. Tools appear to the agent as `<server>_<tool>` (for example
`Roblox_Studio_execute_luau`) and follow the permission mode: in Ask and Auto they wait
for your approval like commands and edits; in Full they run freely. Failures stay
visible in the settings row, with the server's last error.

## What else is in the box

- **Memory** — the agent saves durable facts (your name, preferences, projects) with its
  `memory_save` tool; they're fed back into every chat and listed in Settings → Memory,
  oldest first with new ones landing at the bottom, where you can add or forget them too.
- **Profiles** — separate workspaces (chats, memory, keys, MCP config) for different
  accounts. Switch in Settings → Interface → Profile, or launch with `prism --profile work`.
- **Subagents** — the agent can hand a self-contained job to a background copy of itself
  (`subagent` tool) and use the report when it comes back; several run side by side.
- **Plan & Build** — the composer switch keeps the agent in Plan (it reads, asks, proposes,
  never writes) until you approve the plan; the `ask_user` tool puts a small
  multiple-choice question right in the chat, marks one option **Recommended** and picks it
  after three minutes if nobody answers.
- **Instruction files** — the pill beside the folder button attaches one instruction file
  per folder (AGENTS.md, CLAUDE.md, any `.md`; READMEs and licenses are left out). Its menu
  also has **Open instructions folder**, which keeps a workspace's agent files together in
  `<workspace>/.prism` (instructions, skills, MCP notes — created on first use).
- **Claude skills** — folders under `~/.claude/skills`, `<project>/.claude/skills` and
  `<project>/.prism/skills` with a `SKILL.md` are listed to the agent, which reads and
  follows them when a task matches.
- **File attachments** — files the agent writes show up under its reply with **Preview**
  (markdown renders, code shows as code) and **Download** under the same name.
- **Discord notifications** — optional: paste a bot token and your user id and a bot DMs
  you when a chat finishes, with the outcome and a short summary. Settings → Interface.
- **More tools** — the agent can look at your screen (`screenshot`), read and write the
  clipboard, send full HTTP requests with method, headers and body, open files and folders
  for you, show a desktop notification, and wait between checks. A screenshot needs a model
  that can see pictures (GPT, Grok, Muse Spark, Qwen3.8 Flash, DeepSeek V4 Flash Vision).
- **`prism discord`** — the same bot also answers DMs, so you can talk to Prism V2 from your
  phone on any network; see below.
- **Long chats stay light** — a chat opens with only its newest part drawn; older messages
  load in batches as you scroll up, and off-screen messages are skipped by the browser.
- **Parallel runs** — the two-column button in the composer sends one prompt to several
  models at once; the Runs tab in the right panel watches them (running / completed /
  failed / error) and opens any of them as a normal chat.
- **Notifications** — when a chat finishes while the app is not in front, a Windows
  notification shows the chat's name with *completed*, *failed* or *error*, under the app icon.
- **Drag to sort** — reorder chats and folders by dragging them. Newest first until you do.
- **Thinking effort** — Default, Instant, Low, High, Max and Extra high, per model, with the
  level's name above the track growing as the level rises.
- **Thinking boxes** — two styles in Settings → Interface: the collapsible **Thought** rows,
  or **Extended**, an always-open reasoning box with no header to fold.
- **Stop & steer** — while a reply streams, an empty composer turns the send button into
  **stop**, and anything you type steers the running reply. Select text in one of your older
  prompts to **Steer**: the chat rewinds to that message and its words go back into the
  composer for editing.
- **Window that fits your screen** — the app opens sized to your monitor, the sidebar's edge
  can be dragged to resize (double-click it to reset), and the chat column widens on big screens.
- **Updates** — on launch Prism V2 checks this repository's releases and offers to download and
  install a newer version when there is one.
- **`prism web`** — see below.

## prism web

```sh
prism web       # serves Prism V2 to the browser, logs activity in the terminal
prism web --host 0.0.0.0 --port 8787 --profile work   # for a server or another device
prism import    # bring OpenCode chats over
```

The installer puts the `prism` command on PATH by itself on first launch (a small shim in
the per-user WindowsApps folder; an existing `prism` on PATH is never touched). Working from
a checkout instead, `npm link` does the same.

The web mode reuses the desktop engines behind an Electron stand-in: tools, models, MCP
servers and memory all work. Caveats: there is no built-in browser panel (webviews need
Electron), ChatGPT sign-in is desktop-only, and the Go key is entered per browser profile.
Anyone who can reach the port can run tools on that computer, so leave it on `127.0.0.1`
unless you mean it.

## prism discord

```sh
prism discord                  # listen for DMs (the bot from Settings -> Discord)
prism discord --no-tools       # chat only, nothing runs on this computer
prism discord --once "hi"      # one turn in the terminal, prints the reply
```

The bot only answers the user id in Settings → Discord, so DMs from anyone else are
ignored. It keeps one conversation with history (`/new` resets it), and commands:
`/folder <path>` sets where tools work, `/model provider:id` switches model, `/status`,
`/stop`, `/help`. Replies are edited into one Discord message; long answers continue in
follow-ups. Tools run without asking — that is the point (you are the only allowed user),
so keep the token private and use `--no-tools` if you want chat only.

## The full UI on your phone, across networks

`prism web` serves the whole app to a browser, but only on your network. To reach it from
a phone on a different Wi-Fi without port forwarding, put both devices on a private mesh
VPN — [Tailscale](https://tailscale.com) is free and takes minutes:

1. Install Tailscale on the PC and on the phone, sign in to the same account.
2. On the PC: `prism web --host 0.0.0.0 --port 8787`
3. On the phone: open `http://<the PC's Tailscale IP>:8787` (the IP shows in the
   Tailscale app or with `tailscale ip -4`).

Nothing is exposed to the public internet; the port only answers inside your tailnet.
`prism discord` is the lighter alternative: no VPN app, but chat without the UI.

## OpenCode Go

The reason for this fork: **OpenCode Go** is the first provider in Settings.
One key from [opencode.ai/console](https://opencode.ai/console) unlocks the whole
curated catalog — DeepSeek, Kimi, GLM, Qwen, MiniMax, LongCat, MiMo, Hy, Grok, GPT
and Muse Spark — billed by OpenCode instead of per provider.

Behind the scenes the provider routes each model by how it is served:

- Chat Completions — most of the catalog (DeepSeek, Kimi, GLM, LongCat, MiMo, Hy, …)
- Responses API — Grok, GPT, Muse Spark
- Messages API — MiniMax, Qwen

The three paths reuse the app's existing OpenAI, ChatGPT and Anthropic engines with
the Go base URL, so streaming, reasoning, tool calls and usage all behave like the
native providers. The key is kept on this machine.

## Run it

```sh
npm install
npm start
```

The app keeps its data in `%APPDATA%\Prism V2`. A machine that already ran Prism has that
folder copied over once on first launch, so chats, keys and memory carry on here.

In **Settings → OpenCode Go**, paste the key — the model picker then offers the Go
catalog (per-chat model choice, reasoning effort, and the group label "OpenCode Go"
in the model stage).

## Layout

- `app/` — the renderer: the window's HTML, CSS, sounds and every browser-side module
- `desktop/` — the Electron main process: providers, MCP, memory, notifications, Discord
- `tools/` — the `prism` CLI, the web server behind `prism web`, and the OpenCode chat importer

## Build an installer

```sh
npm run dist
```

Produces an NSIS setup under `dist/` (`Prism-V2-<version>-Setup.exe`).

## Notice

This is a modified fork of OpenGhost, via Prism. The OpenGhost **code** is MIT (see LICENSE);
the name, ghost logo, animations and visual design are used here
only under the license's non-commercial allowance. Internal identifiers
(`window.openghost` bridge, storage prefixes, the OpenAI `originator` header) keep
their original names so the upstream engines keep working.

The sound files under `app/sounds/` come from the [OpenCode](https://github.com/anomalyco/opencode)
repository (MIT), and the prices behind the `~$` readout come from OpenCode's model catalog
(`models.opencode.ai`). Thanks to both projects.
