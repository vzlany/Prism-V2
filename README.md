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

## What Prism V2 has that Prism does not

A full comparison with the original [Prism](https://github.com/lithIV/prism) (1.5.0). Everything
here is in this repository; nothing else was removed.

### Running on the desktop app and on the phone

- **Also runs on Linux (Debian).** The same build serves a home server: Settings → Server
  picks the machine, and on Linux autostart is an XDG entry in `~/.config/autostart`, so the
  app (hidden in the tray) plus the web server and the Discord bot come up with the session.
  `prism server` (or `node tools/server.mjs`) runs the web UI and the bot headless with no
  window at all — one process, restart-on-crash — for a box without a desktop. A root
  password set in Settings → Server lets the agent run `sudo apt-get install -y …` itself:
  the app answers sudo's prompt through an askpass helper, and the password never reaches the
  model. Downloads: see the release assets (`Prism-V2-<version>-linux.tar.gz`).
- **Updates itself — or the agent does.** Settings → About checks GitHub at launch and every
  six hours, and with **Install automatically** on the new release is applied by itself while
  the app is idle: on Windows the Setup.exe replaces the install, on Linux the directory is
  swapped and the process comes back (systemd, or `prism server`, restarts it). The same
  works on the web and from Discord by asking the agent — "update Prism V2" runs the
  `update_prism` tool, which downloads, applies and restarts it. Releases are public, so no
  token is needed; a GitHub token can be set anyway for rate limits or a private fork.
- **The website runs its turns in the app.** When the desktop app is running, a message sent
  from `prism web` (the phone) is handed to the app through a small file bridge: the app runs
  the turn with its tools, browser, skills and keys, streams it in its own window, and the
  phone follows the same run live. Without the app, the web falls back to running turns
  itself, so a headless `prism web` still works.
- **Live mirror of the running turn.** The phone sees the same thing the app does while it
  works: the Thought box growing, the tool cards running (white snake included, same icon and
  title), and the answer being written — laid out exactly like the app's own message, not
  wrapped in an extra card, and replaced by the saved conversation when the turn ends.
- **Instant sync both ways.** The shared store is watched on both sides (index and every
  conversation file), so a project, a chat, a rename or a finished reply shows up in the other
  place right away, and an open thread refreshes the moment the other process writes it.
- **Windows tray icon** — open the app, open the web, quit; the tooltip says how many turns
  are working. Closing the window only hides it: Prism keeps running in the tray (web server
  and Discord bot included) until you press Quit.
- **Every message says where it came from** — a message written on the phone wears a
  "Website" tag on the desktop, a Discord message wears "Discord" everywhere, and a message
  never shows a tag in the place it was written.
- **Settings → Auto** — start with Windows, start hidden (straight into the tray), start
  the web server with the app on the port you choose (default 8787, reachable from your
  network), and start the **Discord bot** with the app so it is always online. On Windows
  the startup entry is a **Prism V2 shortcut in the Startup folder** with the app's own icon,
  so Task Manager's startup list says "Prism V2" instead of "electron.exe".

### Models, prices and effort

- **Several API keys per provider.** Each provider keeps a list of keys in Settings →
  Providers; add as many as you like, rename them, equip one, and every model call uses the
  equipped key. The old single key migrates into the list on first run.
- **Prompt settings.** Settings → Prompt holds a **global system prompt** for every model
  (toggleable, with Prism V2's built-in agent rules still in place) and a **per-model
  prompt**; the global one is shared through the store, so a prompt written on the phone is
  the prompt the desktop app runs delegated turns with.
- **Real brand icons, shipped with the app.** The model picker, the parallel list and the
  dashboard wear the same coloured brand marks ElysianAI uses (DeepSeek, Kimi, GLM, Qwen,
  MiniMax, LongCat, MiMo, Grok, GPT, Muse/Llama, Hunyuan, Claude, OpenCode, Gemma, Google,
  NVIDIA, Ollama), served from `app/brands/` so they appear instantly and offline.
- **OpenCode's own pricing** — the `~$` readout uses OpenCode's catalog
  (models.opencode.ai) with cache reads/writes, reasoning tokens and context tiers, cached
  locally with a fallback.
- **The model list keeps itself current** — the Go catalog is re-read in the background
  (6 h TTL, 30 min checks), so models OpenCode adds or retires appear and disappear on their
  own; free models wear a **Free** chip.
- **The same models everywhere** — the app shares its catalog through the store, so the phone
  offers every model and every thinking effort the app has, even though it holds no keys.
- **Run in parallel from the phone too** — the parallel button works on the web, hands each
  run to the app, and the Runs tab marks them completed as they finish. The panel shows the
  message about to be sent, and the button wears OpenCode's breathing-dots indicator.
- **Parallel runs are children in the list** — every run (and subagent) started from a
  conversation is drawn under it in the sidebar, indented, with its own busy ghost.

### Skills from GitHub

- **Settings → Skills** installs Claude-style skills straight from GitHub: paste a repository
  (or a folder inside one), and every folder holding a `SKILL.md` lands in `~/.claude/skills`,
  where the agent already lists and follows them. The page logs each one as
  **Loading a Skill: X** → **Loaded Skill: X**. Private repositories work if the URL is one
  the network can reach; installing replaces a skill of the same name.

### Dashboard

- **Dashboard row above Folders** — opens a themed panel with everything Prism V2 knows:
  conversations, messages, tokens and estimated spend, the peak context window, thinking
  time, memory facts, the models that did the most work (with their logos and share bars),
  the workspaces that hold the chats, first and last activity, the busiest day and the
  average messages per chat. It reads the newest conversations quietly in the background and
  reuses the numbers for a minute.

### Chat and interface

- **Sounds** — the chimes OpenCode ships (`alert-`, `bip-bop-`, `staplebops-`, `nope-`,
  `yup-`), chosen per event in Settings → Interface: task finished, question asked, errors.
- **The conversation gauge** — a ring right of the composer with the price so far spelled
  under it; pressing it opens tokens in/out, cache traffic, message count and the price. Once
  a chat has filled the window, the ring keeps its fill and gets deeper with every further
  window (spinning dashes) instead of resetting when the chat compacts; the panel shows the
  live size and the peak. It replaces Prism's thin status line.
- **Thinking that stays readable** — earlier Thought boxes from a multi-step turn stay on
  screen (with a gray 🧠), their clocks stop with the turn and survive a reload, and the box
  no longer scroll-jumps while the model writes. A Thought row folds away the moment a tool
  starts. Steps of one turn sit close together instead of leaving blank bands.
- **Tables fit** — long tables wrap inside the reply column instead of running off the edge.
- **File cards** — writes and edits show green `+N` / red `−M` line counts, carry Preview and
  Download on the card itself (one box per file), and **`attach_file`** lets the agent hand
  over any finished file — a build, an installer, an archive — as a chip with a real binary
  download (the desktop asks where to save; the web streams it).
- **Screen pictures** — two white snakes glide around a running tool card's frame at one
  constant speed, half a loop apart; the `screenshot` tool captures the whole screen or one
  window through Electron itself, so it works without ffmpeg and antivirus has no script to
  flag.
- **Copy that works everywhere** — including a phone on plain http, where the browser
  clipboard is unavailable; the fallback still copies and the buttons answer.
- **New Folder menu** — the last five workspaces, each forgettable with an ×, and a last entry
  that opens the folder picker. Choosing **Chat workspace** uses one shared
  `Documents\Prism V2\Chats` folder, so the list shows a single **Chats** section instead of
  a timestamped folder per chat.
- **Phone comfort** — older messages are prerendered in the background so scrolling up finds
  whole messages ready; model names wrap and shrink instead of being cut off; drafts autosave
  per chat and are restored after a reload; the web defaults to Full access.
- **Fast where it used to stutter** — the streamed answer is repainted at most ~30 times a
  second and each markdown block is patched in place, so a finished code block is never
  rebuilt for a word that arrives elsewhere; the per-word typing blur was dropped (opacity
  and rise only); the Thought box renders its markdown block-by-block on a timer, so code in
  a long thought no longer flashes or crawls. The window icon is a full multi-size `.ico`
  (16→256 px) instead of a single 32 px one.
- **Auto reconnect** — a dropped connection is retried a few times before the error and its
  Retry button appear.

### Under the hood

- **Prism V2 naming and data** — the product, installer, About page and prompts say Prism V2;
  data lives in `%APPDATA%\Prism V2` with a one-time copy of an existing Prism folder; the
  updater points at this repository; the old `prism` command may still point at an older
  install (run `node tools/prism-cli.mjs web …` from this folder, or fix that shim).

## What Prism already had

- **Memory** — the agent saves durable facts with its `memory_save` tool; Settings → Memory
  lists them and lets you add or forget. The tool is instructed to keep only facts that
  matter in other conversations (name, preferences, projects, what this computer has), and a
  fact that is already there is updated in place instead of saved a second time.
- **Profiles** — separate workspaces (chats, memory, keys, MCP config); `prism --profile work`.
- **Subagents** — the agent hands a self-contained job to a background copy of itself.
- **Plan & Build** — a composer switch that keeps the agent reading and proposing until you
  approve; the `ask_user` tool asks with lettered options.
- **Instruction files** — one instruction file per folder (AGENTS.md, CLAUDE.md, any `.md`),
  plus the workspace's `.prism` folder for instructions, skills and MCP notes.
- **Claude skills** — `SKILL.md` folders are listed to the agent and followed when a task
  matches.
- **Attachments, files and the built-in browser** — drag files in, preview and download what
  the agent writes, and let it drive Chromium inside the app.
- **MCP servers, Discord notifications, drag-to-sort, thinking effort, stop & steer, long
  chats that stay light, window that fits your screen, updates.**
- **`prism web`, `prism discord`, `prism import`** — the phone-facing web mode, the Discord
  bridge and the OpenCode chat importer.

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
ignored. It connects to the Discord gateway, so it shows **online with a status** that says
what it is doing (`💤 ready` when idle, and **dnd** with `🤔 thinking…`, `✍️ writing…` or the
tool name while it works), and it uses the equipped provider keys the app mirrors into the
shared store — the key you set in Settings works here without a second copy. Commands use
`!` (a leading `/` still works):

- `!chat` — list the conversations the bot keeps; `!chat 2` switches to one, `!chat <id>`
  switches by id, `!chat new [title]` starts one. Every conversation is a real Prism chat in
  the **-Discord** folder, visible and continuable in the app and on the web.
- `!seefull` — toggle **Full Display**: every finished thought is posted as small grey `-#`
  text and every action as its own box (`📦 **Running a command:** …` while it runs, edited
  to `📦 **Ran a command:** …` when it finishes); thoughts are only sent once the model has
  finished thinking.
- `!effort <level>` — change the thinking effort (`default`, `none`, `low`, `medium`,
  `high`, `xhigh`, `max`); `!effort` lists what the model takes.
- `!clear` — delete every message the bot sent in the DM.
- `!folder <path>`, `!model provider:id`, `!new`, `!status`, `!stop`, `!help`.

Replies are edited into one Discord message; long answers continue in follow-ups. Tools run
without asking — that is the point (you are the only allowed user), so keep the token
private and use `--no-tools` if you want chat only. Settings → **Discord** holds the token,
the bot autostart, the "DM me when done" switch and the conversation list; the app's
agent-mode menu also ends with a **DM me on Discord** switch for the same thing.

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

> Upgrading from an older Prism? Its installer may have put a `prism` command on PATH that
> still points at the **old** installation (and its own data folder) — `prism web` would then
> serve stale chats. Run the command from this folder instead
> (`node tools/prism-cli.mjs web …`), or point that shim at this checkout.

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
