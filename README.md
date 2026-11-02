# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in [Rex](https://www.superlogical.com/rex) terminals. Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

**Rex port.** Supports Linux and macOS hosts.

## Installation

```bash
pi install npm:@jordyvanvorselen/pi-interactive-subagents
```

Add `-l` to install for the current project only (`.pi/settings.json`). Update later with `pi update`.

## How it works

`subagent()` returns immediately. The sub-agent runs in its own Rex surface, created with `--focus=false` so it never steals keyboard focus:

- **Spawned by the main session** — a new tab (Rex window), labelled with the sub-agent's name. One tab per sub-agent keeps the tab bar readable as a list of what is running.
- **Spawned by another sub-agent** — a split off the parent's pane (`$REX_BLOCK`), so a whole lineage stays inside one tab.

The pane carries the same name in the Rex window and block list. Set `PI_SUBAGENT_TOP_LEVEL_SURFACE=pane` to put top-level sub-agents in split panes instead of tabs (the default setting is `tab` in `pi-extension/subagents/rex.ts`). A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  map-auth-flow    active · bash 7m           │
│ 00:45  research-oauth   waiting 2m                 │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

Split direction follows the anchor block's geometry: a wide parent pane (columns / rows >= 2) splits right, a narrow or tall one splits below. Force one direction with `PI_SUBAGENT_SPLIT_DIRECTION=right|down|auto` (default `auto`; down maps to Rex's `below`). If dimensions cannot be read, automatic direction falls back to right.

### Automatic sizing & placement overrides

After a split launches or an owned pane is cleaned up, the extension balances **only the affected tab's tiled layout**. Bursts are debounced by 100 ms. Columns and rows receive equal shares for their split structure: stacked panes count as one column, and side-by-side panes count as one row. Other tabs and floating layers are left untouched; no operation selects the active tab or changes keyboard focus.

**Manual sizes within that tab can be reset** at the next creation/cleanup. With the top-level `pane` override, this includes your spawning tab's tiled panes, not just agent-owned panes. A new top-level tab needs no balancing until it gains splits. Corrections smaller than 0.005 of a split's ratio are ignored. Sizing is cosmetic: stale layouts, disappeared tabs, and resize failures never fail a launch or replace a collected result. Pending sizing work and unlaunched reservations are disposed on shutdown/reload.

| Environment variable | Values | Default | Scope |
| --- | --- | --- | --- |
| `PI_SUBAGENT_TOP_LEVEL_SURFACE` | `tab`, `pane` | `tab` | Main-session spawns; nested agents always split their parent |
| `PI_SUBAGENT_SPLIT_DIRECTION` | `right`, `down`, `auto` | `auto` | Splits use the spawning anchor, never the focused pane |
| `REX_BIN_PATH` | Executable path | `rex` in PATH | Explicit CLI override; alternatively `REX_BIN_DIR` locates `rex` in a directory |

Unknown placement values use the defaults. Launch runs the prepared script as the new terminal command through Rex's login environment, with explicit cwd and background focus. No interactive prompt-readiness delay is needed; the retired `PI_SUBAGENT_SHELL_READY_DELAY_MS` setting has no effect. Completion uses process state and sidecars, not scrollback. Fallback screen diagnostics use at most two bounded public `format`/`blob_read` replies (64 KiB of JSON-encoded text each). Large scrollback is sampled from its final 32 KiB, reserving room for JSON escaping; very long or heavily escaped diagnostics may still be truncated.

Steering a running sub-agent queries program status first to verify input safety: steering is refused if the subagent is blocked on a permission, question, or authentication dialog, or if trustworthy status cannot be read. Input is submitted using a targeted Rex paste event followed by an Enter key event.

## Prerequisites & Supported Hosts

- [pi](https://github.com/badlogic/pi-mono) (1.4.0+ recommended)
- [Rex](https://www.superlogical.com/rex) running on Linux or macOS (native Windows host is deferred)
- Rex CLI (`rex`) available in `PATH`
- Start pi inside a Rex session where `REX_SESSION` and `REX_BLOCK` are exported into the terminal environment.

```bash
# Verify Rex environment
rex whoami
# Start pi
pi
```

Running pi outside Rex disables the `subagent` tools with a clear diagnostic hint.

## Native Pi capabilities & safe steering

**Pi 1.4.0 is the verification baseline.** It added native Rex OSC 8 hyperlinks, truecolor, and inline images (Kitty graphics). Pi—not this extension—detects and renders those capabilities. Pi 1.1.0 introduced native **OSC 7501 program status**; this adapter consumes those reports but does not emit another status stream. Older Pi versions are not categorically rejected, but safe steering requires a trustworthy Pi status record from the target.

Automatic detection is the default. For diagnosis, Pi 1.4.0 documents these overrides:

| Capability | Environment override | Pi setting in `settings.json` |
| --- | --- | --- |
| OSC 8 hyperlinks | `PI_HYPERLINKS=1\|0\|auto` | `terminal.hyperlinks: true\|false\|"auto"` |
| Inline image protocol | `PI_IMAGE_PROTOCOL=kitty\|iterm2\|none\|auto` | `terminal.images: "kitty"\|"iterm2"\|false\|"auto"` |
| Truecolor | `PI_TRUE_COLOR=1\|0\|auto` | `terminal.trueColor: true\|false\|"auto"` |
| OSC 7501 program status | `PI_PROGRAM_STATUS=1\|0` | No corresponding Pi 1.4.0 setting documented |

For rendering capabilities, **Pi settings take precedence over environment variables**. Unset/`auto` values defer to native detection. User settings live at `<agent-dir>/settings.json` (default `~/.pi/agent`, overridden by `PI_CODING_AGENT_DIR`); trusted project `.pi/settings.json` overrides user settings. `terminal.showImages: false` independently hides inline images; it is not the protocol selector. The extension's own `config.json` `status.enabled` controls its activity widget, **not** native OSC 7501 reporting. Names such as `PI_TERMINAL_STATUS` and `PI_IMAGE_SUPPORT` are not the documented Pi 1.4.0 overrides—use the names above.

The launch wrapper carries explicitly set native overrides from the spawning Pi into Rex's server-side command environment, including `0`/`none`. It leaves unset values unset in the wrapper so Pi's own settings/detection and Rex's login environment apply. It never rewrites Pi settings or force-enables reporting, and does not infer a child's status from the parent's environment. Only force a capability manually if the **entire terminal path** supports it; escape sequences sent to an unsupported proxy can corrupt rendering.

### OSC 7501 troubleshooting

Pi normally queries terminal support first and reports only after confirmation. `PI_PROGRAM_STATUS=1` skips the query; `PI_PROGRAM_STATUS=0` disables reporting. tmux and screen do not forward this protocol. In native Pi, `working` means a run/compaction is active, `blocked` means a dialog/login is open, `done`/`error` describe a settled run, and `idle` covers startup/cancellation. Reports contain session names, dialog titles, or the first error line, never prompts or model output. A `done` record does **not** mean the Pi process exited.

If `subagent_message` refuses delivery because no trustworthy status exists:

1. Let child startup/negotiation finish, then inspect the explicit target:
   ```bash
   rex block call -s "$REX_SESSION" -b CHILD_BLOCK_ID program_status
   ```
2. Check **the child Pi's** environment for `PI_PROGRAM_STATUS=0`, and whether a terminal proxy or unsupported reporter prevents OSC 7501. A parent's variable or a forced `1` is not proof of child safety. Check Rex connectivity if the query itself failed.
3. Respect an intentional disablement. Interact with the child manually rather than bypassing the safety guard. The alternate `cli: claude` path has no Pi reporter supplied by this extension; steering is refused without trustworthy Pi status.
4. If a blocked dialog is reported, resolve it in the child's pane. Ordinary editor waiting (including an orchestrator's `ask_question` reply) is not a blocked UI dialog and remains steerable.

A refusal sends no paste/Enter and makes no configuration changes. There is no screen-text safety fallback or automatic status-enabling fix.

### Compatibility evidence

`npm run test:surface` includes source-loaded, **no-model** Pi smoke cases: native automatic detection, explicit status disablement, and conflicting rendering environment/settings. It loads `pi -ne -e <workspace>/pi-extension/subagents/index.ts` plus a test-only fixture composed of Pi's native Markdown/Text/Image widgets and a real Pi dialog. No custom renderer or OSC reporter is added to the runtime.

On the tested Linux host with Pi **1.4.0** and Rex CLI/server **0.0.1793420730-g6d0d9a** (API revision **9**), observed checks include automatic Rex detection, link targets and exact RGB color retained in Rex HTML capture, a native PNG Kitty-graphics transmission in Pi's terminal write log, native `idle`/`blocked` reports after negotiation, and safe refusal with reporting disabled. Settings remained byte-for-byte unchanged. These are protocol/render-path observations, **not** a GUI pixel inspection, click-through test, or native macOS-host certification. See [the detailed evidence and operator checklist](docs/native-pi-rex-compatibility.md).

Sources: Pi 1.4.0's [terminal setup](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/terminal-setup.md), [environment variables](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/environment-variables.md), and [settings](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/settings.md); [Rex Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status).

## Rex configuration & keyboard diagnostics

**No custom `init.lua` is required.** Configuration belongs to the **Rex server host and its OS account**, not necessarily the machine running the GUI client. Linux and macOS resolve the file in this order:

1. `REX_CONFIG`, if set in the **server process environment**;
2. `$XDG_CONFIG_HOME/rex/init.lua`, if `XDG_CONFIG_HOME` is set;
3. otherwise `~/.config/rex/init.lua`.

Changing a variable in a Pi shell does not change an already-running server's environment. Rex does not watch file edits, and this extension does not edit configuration, rebind keys, reload the server, or spawn agent terminals from config-load Lua.

Read-only diagnostics (no application of bindings):

```bash
rex config check --json           # local account's file, loaded by this CLI version
rex config check /path/to/init.lua --json
rex keymap --json                 # running server's config layer ONLY without --request
```

`config check` reports the resolved path, existence, bindings/removals/modes/actions, and diagnostics; errors return exit status 1. It **loads Lua**, so validate only trusted files, not arbitrary scripts with side effects. It does not reload the live server and cannot fully validate client-specific action names/unbindings. A different CLI/server version, environment, or unapplied edit can explain different results from `check` and `keymap`.

**Only after an explicit operator decision**, on the server's own machine via its local socket, apply an edit with `rex config reload`. It notifies connected clients immediately; remote reload is refused. Generation advances even on a failed read, which retains the last successfully loaded bindings. Do not treat this as a startup step or run it merely to diagnose a problem.

### Avoid stealing Pi's keys

Rex resolves shortcut layers with highest priority first: **client-recorded shortcuts > server `init.lua` bindings > client-shipped defaults**. Key modes and sequence prefixes can consume the first key before Pi ever receives it, even if a longer sequence is never completed.

Compare Pi's **`/hotkeys`** (active application/editor shortcuts) with Rex's bindings. On Linux/macOS, watch especially `Escape` (abort/cancel), `Ctrl+C` (copy/clear/exit depending on context), `Ctrl+D` (exit on an empty editor), `Shift+Enter`/`Ctrl+J` (newline), `Alt+Enter` (follow-up), `Ctrl+O` (tool expansion), and this extension's `Ctrl+Alt+O` (subagent tools widget). User/platform bindings can differ; `/hotkeys` is authoritative for the running Pi. Avoid assigning these keys as Rex actions or sequence prefixes unless intentionally intercepting them.

**A bare `rex keymap` is not the GUI's full effective keymap**, and `-C` alone does not supply the GUI layers. If you have the actual client's `client.keymap` request, use `rex keymap --request client.json --json` (or `--request -`) to resolve its shipped defaults, declared actions, and recorded shortcuts with the server configuration. Bindings are listed top-of-stack first, mode-qualified where applicable. Otherwise inspect the GUI client's shortcut settings as well; do not conclude that a key reaches Pi just because a bare CLI query omits it. Make any rebinding/reload a separate explicit operator action.

Sources: [Rex configuration](https://www.superlogical.com/rex/docs/customize/config), [shortcut resolution](https://www.superlogical.com/rex/docs/customize/keyboard-shortcuts#how-shortcuts-are-resolved), [sequence conflicts](https://www.superlogical.com/rex/docs/customize/key-sequences#binding-vs-sequence-conflict), current `rex config check --help`, `rex config reload --help`, `rex keymap --help`, and Pi [keybindings](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/keybindings.md). Superlogical MCP is a documentation source, not a runtime dependency.

## Explicit Workspace-Source Startup

To test or run the extension directly from workspace source with extension auto-discovery disabled:

```bash
pi -ne -e <path-to-workspace>/pi-extension/subagents/index.ts
```

This guarantees that local edits are evaluated without conflict or interference from any globally installed package.

## Workspace-Source Testing & Verification

Integration tests exercise the code directly from workspace source rather than any installed package:

```bash
# Run unit tests
npm test

# Run no-model Rex surface integration tests (fast & free, exercises Rex CLI/API directly)
npm run test:surface
```

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated Rex tab (or pane, when nested) (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Short descriptive label for the tab/pane and widget, e.g. `auth-token-refactor`. Always set it. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | agent's model | Override the model for this spawn |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is validated against the child's live program status and pasted into the live pane (newlines flattened to spaces) followed by Enter submission, without stealing focus. The call returns an immediate acknowledgement; the eventual completion still arrives as a steer message.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

### Acknowledgement & Result Semantics

- **Launch Acknowledgement**: Tool calls (`subagent`, `subagent_message`) return an immediate acknowledgement containing the subagent's name and initial status (`started` or `resumed`). They do NOT wait for agent completion.
- **Terminal Result**: When the subagent run completes, the parent automatically receives a single terminal result steered into the conversation as a `subagent_result` message that triggers a new turn. The result carries:
  - `outcome`: `"success"`, `"failure"`, or `"interrupted"`.
  - `summary`: Final assistant response, error message, or interruption diagnostic.
  - `exitCode`: Real agent exit status (synthetic `1` is assigned for interruption and observation failure).
  - `sessionFile` / `sessionId`: Linkage for subsequent follow-up.
- **Safe-Steering Limitations**:
  - Program status (`OSC 7501`) is checked before submitting input. If the child is blocked on a permission, question, or authentication dialog, delivery is refused with an actionable error and NO input is sent.
  - If program status is missing, unreadable, or untrustworthy, delivery fails fast rather than blindly sending raw keystrokes.
  - Ordinary waiting for input (e.g. `ask_question` reply) is distinguished from a blocked dialog and permits safe message delivery.
- **Provider Failure vs. Interrupted Pane Closure vs. Observation Failure**:
  - *Provider / Agent Failure*: If an agent encounters an error or exhausts provider retries (e.g., Anthropic 529 overload), the failure is detected via the `.exit` sidecar or process exit code and reported as a provider/agent failure with `outcome: "failure"`.
  - *Externally Closed Pane*: If a human or external action closes a subagent pane while it is running, process observation detects the missing block (`not_found`) and reports `outcome: "interrupted"`. The session file and name registry are preserved so the work can be resumed.
  - *Observation Failure*: If sustained multiplexer infrastructure errors prevent process observation, the pane is kept open to avoid terminating an active agent. A persistent `.lost-observation` marker is written beside the session file. To prevent concurrent corruption, name-based resume through `subagent_message` is refused until the process is confirmed ended (`confirmProcessEnded`). In-flight child counts also treat unresolved lost-observation sessions as pending children, suppressing premature auto-exit of nested parent sessions.
- **Exiting Pi vs. Closing a Pane**:
  - In interactive subagent panes, exiting Pi normally (e.g., `/exit` or Ctrl+D) completes the session cleanly and triggers normal summary collection.
  - Closing the Rex pane/window externally halts the process abruptly and is classified as an interruption rather than a successful run or an internal provider crash.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original sandbox.** At spawn time the fully-resolved loadout — tool allowlist, backing extensions, model, thinking level, system prompt, spawn whitelist, cwd — is snapshotted to `<session>.loadout.json`. Resume rebuilds the exact same restricted process from that snapshot rather than relaunching unrestricted.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the pane stays open until a human closes it. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | `openrouter/z-ai/glm-5.3` | `read`, `grep`, `find`, `ls` | Fast read-only codebase recon |
| **researcher** | `openrouter/z-ai/glm-5.3` | `web_search`, `web_fetch`, `safe_bash` | Web research, synthesized into a sourced brief |
| **worker** | `openrouter/z-ai/glm-5.3` | `read`, `write`, `edit`, `bash`, `web_search`, `web_fetch` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`).

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: openrouter/z-ai/glm-5.3
thinking: medium
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model |
| `thinking` | string | `minimal`, `low`, `medium`, or `high` |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `web_fetch`, `safe_bash`, `video_extract`, `youtube_search`, `google_image_search`. Only the extensions backing the listed tools are loaded into the child |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `claude` runs the agent via the Claude Code CLI instead of pi |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that pane — the widget still updates). Set explicitly to override.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are loaded back in explicitly. There is no default toolset and no deny-list — an agent gets exactly what its frontmatter lists. The restriction survives resume via the loadout snapshot.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true }
}
```

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture, the multi-multiplexer surface layer, and the status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/). The direct ancestor is the tmux-only fork [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents).

## License

MIT
