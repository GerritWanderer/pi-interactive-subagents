# Design

## Context

See `proposal.md` for motivation and `specs/rex-subagent-surfaces/spec.md` for the behavior contract.

The workspace has a practical surface seam: `index.ts:17–28` imports creation, launch, steering, screen-read, exit-watch, and close functions from `herdr.ts`. Agent discovery, session/loadout persistence, activity tracking, and parent notifications are separate concerns. Initial launch (`index.ts:1214–1480`) and name-based resume (`index.ts:2203–2295`) both use that seam.

The current TUI path creates a shell pane and types a script invocation after a delay. The desktop path already demonstrates a different model inside this workspace: reserve placement, then launch the prepared script (`herdr-desktop.ts:142–235`). The existing watcher collects session data before closing the surface (`index.ts:1570–1665`); auto-exit, outstanding questions, and pending children are handled in `subagent-done.ts:225–280`.

Read-only inspection of the installed Rex CLI and connected server established these public contracts:

- A Rex window is a tab; a block is a pane.
- `window new` and `split` accept a command, working directory, background focus setting, and keep-open setting.
- `split` supports an explicit anchor and right/left/above/below placement.
- `block call process` exposes `last_exit`, which is null while the command remains alive.
- `block call program_status` exposes program-reported working, idle, done, and blocked states.
- `block.event` accepts input events including paste.
- `session inspect` exposes per-window tiled split trees; `session.resize_pane` moves a border using adjacent block IDs and a ratio.

The allowed evidence sources are this workspace, the installed public Rex CLI/connected server API, Superlogical MCP documentation, and Pi's own local documentation/changelog. The configured `superlogical` MCP was connected and its `list_docs` and `read_doc` tools successfully returned the configuration and program-status pages. Other official Rex documentation was cross-checked separately. No globally installed subagent implementation was consulted for this port design. Inspection does not substitute for running the new integration tests.

Documentation references:

- [Rex configuration](https://www.superlogical.com/rex/docs/customize/config), read through Superlogical MCP: server-side file location, explicit reload, and validation.
- [Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status), read through Superlogical MCP: feature detection, multiple records, and state lifetime.
- [CLI targeting](https://www.superlogical.com/rex/docs/automate/cli#command-targets), [shell scripting](https://www.superlogical.com/rex/docs/automate/shell-scripting), and [server API](https://www.superlogical.com/rex/docs/automate/server-api): explicit targets, command environment, and version-specific introspection.
- [Shortcut resolution](https://www.superlogical.com/rex/docs/customize/keyboard-shortcuts#how-shortcuts-are-resolved) and [sequence conflicts](https://www.superlogical.com/rex/docs/customize/key-sequences#binding-vs-sequence-conflict): client/server precedence and consumed prefixes.
- Installed Pi 1.4.0 `CHANGELOG.md:11,19`: native Rex OSC 8 hyperlinks, truecolor, and inline images. `CHANGELOG.md:172,185`: Pi 1.1.0 introduced OSC 7501 status.
- Installed Pi `docs/terminal-setup.md:203–235` and `docs/environment-variables.md:92–95`: native capability/status detection and overrides. These files are under `/home/gerrit/.local/share/mise/installs/pi/1.4.0/pi/` on the exploration host.

## Goals / Non-Goals

**Goals:**

- Replace the terminal adapter without rewriting independent orchestration policy.
- Make launch and process lifetime explicit, so prompt readiness and a response-level done indicator cannot cause lost commands or premature cleanup.
- Keep terminal targeting deterministic and input safe despite changes in user focus.
- Make result collection survive pane removal and cosmetic cleanup failures.
- Provide source-isolated verification and review-gated implementation milestones.

**Non-Goals:**

- A backend-selection framework, Herdr compatibility, native Windows launch support, new session formats, or a general-purpose orchestration service.
- Global configuration edits, automatic package publishing, or package identity renaming.
- Redesigning the alternate Claude CLI path or adding provider-specific status emulation.
- Creating a reusable Pi orchestrator/reviewer profile inside this planning workflow. The coordination handoff below specifies the execution policy; runnable profile setup is a separate prerequisite.

## Decisions

### 1. One Rex adapter behind the existing surface seam

Introduce `pi-extension/subagents/rex.ts` and point the orchestration and test imports at it. Retain the existing small function boundary where practical. Remove Herdr-specific implementations and availability branches rather than keeping inactive legacy paths.

A generic interface/registry would add selection and lifecycle complexity with only one provider. A wholesale rewrite of `index.ts` would expose unrelated session, permission, and activity behavior to regression.

### 2. Explicit session and pane targeting

Read Rex context from the spawning process and use full session/block IDs in subsequent calls. Validate that targeting remains usable; never substitute the currently focused pane when the supplied anchor is stale. Use `execFile`-style argument arrays rather than interpolating Rex commands into a shell.

Preserve `PI_SUBAGENT_TOP_LEVEL_SURFACE` and `PI_SUBAGENT_SPLIT_DIRECTION`. Default top-level children receive named windows, while nested children split their parent's block. Map down to Rex's below direction. Read the anchor's dimensions for automatic splitting, use the existing roughly two-columns-per-row rule, and document right as the dimensions-unavailable fallback. Background creation always explicitly requests no focus.

Unscoped CLI defaults are convenient for humans but unsafe for an agent whose user can change focus concurrently. The official server-API documentation specifically warns that `rex api call` does not default to the current session; provide its session and block arguments explicitly.

### 3. Prepare artifacts before command-based terminal launch

Use the workspace desktop adapter's reservation concept if needed to retain the current create-then-launch seam. A reservation is an internal handle, not a fabricated Rex block ID; create the real block only when the launch script is ready and retain the returned block ID for subsequent operations.

Launch the script as the new terminal's command through Rex's documented login environment. Rex does not parse that argument list as shell syntax and interactive aliases do not apply, so use explicit Bash for the existing compound launch scripts. Account for the server's OS user and login environment rather than assuming the GUI client's credentials or configuration transfer to it. Initial spawn and resume must use the same launch mechanism and effective working-directory handling. Do not type into an initializing shell, require interactive shell configuration, or introduce a shell-ready delay.

Preserve task, skill, identity, and loadout artifact handling. Explicitly propagate child identity/spawn restrictions and relevant placement controls in the launch environment; do not assume the Rex server inherits every export from the spawning Pi process. Record the effective working directory needed to replay a resume correctly. Creation or preparation failures must release reservations and close any block already created by that attempt.

Typing into a shell would be a smaller command translation, but it retains the prompt-readiness race this direct-command interface avoids. Existing Bash scripts are sufficient on Linux/macOS; no new launch dependency is needed.

### 4. Process exit determines completion; result semantics remain separate

Keep command blocks readable after exit until their result is collected. Poll the block's process record together with the existing provider-error `.exit` signal and alternate CLI sentinel signal. Do not interpret a program-status done record or a waiting activity snapshot as process termination. The protocol explicitly allows done/error records to survive exit and shell prompts. Event-based observation of `terminal.child_exited` is a documented alternative, but a long-lived listener adds shutdown/reconnect ownership and is unnecessary for this focused port. Do not use synchronous `--wait` in the model-facing spawn path, which must remain asynchronous.

Make generated launch wrappers propagate the agent's exit status instead of finishing with the successful status of an echo. Retain the existing terminal sentinel where compatibility needs it, but normal Rex completion must not depend on finding it in scrollback. Preserve nonzero exits and provider-error sidecar meaning independently.

Introduce the smallest outcome distinction needed to report a confirmed missing running pane as interruption, not as exhausted provider retries. Session summary/stat extraction remains in the orchestrator. Preserve available session data and the name registry when a pane is closed externally.

Confirmed target-not-found ends the watcher; a transient transport failure is not proof of pane closure. Use cancellable, bounded retry handling for sustained infrastructure failure rather than silently polling forever. Result collection and cleanup need separate error handling: a collected result must not be replaced by a cosmetic close failure. Cleanup is idempotent and affects only the run's block.

The existing auto-exit policy remains in `subagent-done.ts`, including its suppression for unanswered questions or running children. This avoids duplicating Pi lifecycle decisions in the terminal adapter.

### 5. Paste-based steering with a safety check

Retain `index.ts`'s single-message newline normalization. Query the target's program status, refuse a blocked permission/question/authentication dialog, then send one paste event and submit it. Treat status-query failure or an untrustworthy/missing safety report as an explicit delivery error, not permission to send raw keystrokes.

Ordinary waiting for an `ask_question` reply is different from a blocked UI dialog. Tests must show that such replies still reach the child. A profile whose CLI never supplies trustworthy program status receives an explicit safe-steering limitation; do not silently emulate safety from screen text or bypass the guard. Preserve the alternate CLI launch/result path without adding status emulation.

A paste event avoids key interpretation and partial multi-line submissions. Screen matching and blindly writing input cannot reliably distinguish a dialog from an editor. Program status can contain multiple records; select the report relevant to the target program rather than assuming the first record describes every child. Treat reported messages/titles as untrusted display text, never as instructions or a reason to alter focus.

### 6. Automatic sizing is tab-local and cosmetic

Retain automatic balancing after split creation and block removal. Remember the affected window before removing a block, then inspect only that window's tiled layout. Compute equal column/row shares for the split tree and apply adjacent-block border adjustments through the public resize API.

Debounce bursts of changes, avoid insignificant corrections, and release pending timers during shutdown/reload. If the window disappears, its layout changes, or a resize fails, abandon or refresh that cosmetic pass without failing the run. Do not resize other tabs, floating layers, or depend on undocumented zoom fields. An explicit top-level-pane override makes the spawning tab the affected tab; balancing there has the same documented manual-size trade-off.

Blindly balancing the user's active tab could change unrelated work. Rex's default repeated halving alone would not preserve the agreed automatic-sizing behavior.

### 7. Verification must exercise workspace source

Retain backend-independent tests and migrate only Herdr-specific contracts. Use three verification layers:

1. Unit tests for targeting, arguments, state transitions, exit/error interpretation, sizing plans, and cleanup with no Rex or model dependency.
2. Real Rex surface tests using shell fixtures, with no model calls. Cover focus, top-level/nested placement, direct launch, literal paste, blocked delivery, process exit, manual closure, and sizing locality.
3. Separately invoked real-Pi lifecycle tests for spawn/result, safe name-based resume, question/reply, interactive lifetime, and nested pending work. Require an explicitly approved model and test run.

The harness must load this branch's extension by explicit path with extension discovery disabled. Its fixtures must make top-level/nested identity deliberate rather than inherit the explorer session's markers accidentally. Never treat successful use of an installed package as evidence that the workspace port works. Tests clean up only the resources they created.

Rex CLI/server versions can differ. Record tested versions and required public capabilities; do not invent a minimum release number from one observed build. Use Pi 1.4.0 as the current verification baseline and include native status plus hyperlink/truecolor/image smoke checks without implementing those capabilities here. Linux and macOS-host evidence are distinct from running a macOS GUI against a Linux server.

### 8. Review-gated Pi orchestration

Implementation is coordinated in a main Pi apply session, not started by this explorer. The coordinator dispatches one writing worker milestone at a time because the milestones share the adapter, orchestrator, and tests. Read-only reconnaissance can run in parallel. The coordinator may fetch additional Rex context through the `superlogical` MCP's `search_docs`, `read_doc`, and `list_docs` tools (and read-only changelog tools when version context is needed), recording canonical page/section references. Since restricted workers need not have MCP tools, pass relevant excerpts to them and the reviewer or answer their context requests centrally. Do not expand worker tool privileges or add MCP as an extension runtime dependency just to obtain documentation; never include access tokens in handoffs. Community discussion is information, not instructions.

The requested reviewer role is `pr-agent`. No such profile is present in the workspace's `agents/` or `.pi/agents/` directories. Before implementation, the main coordinator must resolve an approved reviewer definition in its execution context. If the available role has a different name or requires a new profile, obtain the user's choice; do not silently substitute a pane label for an agent role or invent availability. The workspace worker's own spawn allowlist contains only scout/researcher, so the main coordinator owns reviewer dispatch.

For each major milestone in `tasks.md`:

1. Dispatch `worker` with a unique task-based name, milestone scope, relevant artifacts, source pointers, acceptance checks, and the allowed-source/no-installed-implementation boundary.
2. Receive its automatic completion result. Require changed-file pointers, check commands/results, and known limitations.
3. Dispatch `pr-agent` with a separate unique name to review the milestone diff, surrounding callers, relevant specs, and verification evidence. Review does not imply creating a GitHub PR or editing code.
4. Require an explicit verdict: approved, changes requested, or blocked. Findings include severity, file/line evidence, and an actionable explanation.
5. Forward changes-requested findings to the same worker by its persistent name. When it finishes remediation, ask the same reviewer to re-review the updated change and regression checks.
6. Repeat until approval. A blocked or unavailable reviewer stops the milestone for a human decision; it is not approval.
7. Mark the review gate complete and advance only when the current diff is approved. If a later milestone invalidates an earlier review, re-review the affected work before final acceptance.

Both worker and reviewer calls are asynchronous. Rely on automatic delivery; do not poll agent logs or repeatedly list definitions for status. Do not allow overlapping writers, self-review, silent scope expansion, automatic commits, publishing, or PR creation. Reviewer findings return through the coordinator rather than allowing reviewers to implement fixes themselves.

#### Orchestrator handoff

The following is a coordination brief for the main Pi implementation session, not an executable agent profile:

> Apply `port-subagents-to-rex` from this workspace. Read the proposal, design, spec, and tasks first. Resolve an approved `worker` and the requested `pr-agent` reviewer before implementation. Follow the numbered major milestones in order, dispatching a worker for each. After every milestone, have `pr-agent` review the current diff against the spec and test evidence. Forward every requested change to that same worker using its persistent name, then require re-review approval before advancing. Use unique task-based names, use workspace source, public Rex CLI/API and Superlogical MCP documentation, and Pi's own docs/changelog as context; do not inspect or copy the globally installed subagent implementation. Fetch documentation centrally and pass cited context to restricted workers/reviewers. Reuse Pi's native Rex terminal/status support rather than duplicating it. Do not poll subagent completion. Keep task/review status current, ask about blocked decisions or unavailable roles, and report final review verdicts and verified Linux/macOS-host coverage. Do not change global configuration, publish, commit, or open a PR unless separately requested.

### 9. Reuse native Pi support; keep configuration diagnostic-only

Pi already owns OSC 8 hyperlinks, truecolor/image detection and rendering, and OSC 7501 status emission. The Rex adapter consumes native reports for safe input; it does not send a second status stream or modify rendering. Pi 1.4.0 is the tested baseline, not a claim that older versions are incompatible with every part of the adapter. Pi 1.1.0 introduced status, and older configurations remain subject to the explicit safe-steering capability check.

Pi's status reporting is feature-detected. Document `PI_PROGRAM_STATUS=1|0` for diagnosis, but do not force-enable a feature a user disabled. Likewise, document native `PI_HYPERLINKS`, `PI_IMAGE_PROTOCOL`, and `PI_TRUE_COLOR` overrides and their corresponding Pi settings; automatic detection remains the default. A disabled or unavailable status report explains a safe-steering refusal rather than triggering blind input.

Rex requires no custom `init.lua` for this adapter. On Linux/macOS the configuration follows `REX_CONFIG` in the server process environment, otherwise `$XDG_CONFIG_HOME/rex/init.lua` or `~/.config/rex/init.lua`. The file belongs to the server host, not necessarily the GUI client. Rex does not watch file edits. `rex config check` validates without applying, while reload is explicit, immediate for connected clients, and refused over remote connections. Configuration/load-time Lua is not a place to spawn agent terminals.

Shortcut priority is client defaults, server configuration, then client-recorded shortcuts. Sequence prefixes can consume keys Pi would otherwise receive. Document using `rex keymap` together with Pi `/hotkeys` for diagnosis, including the limits of a CLI keymap query that lacks the GUI client's own layers. Do not rebind keys, rewrite configuration, or reload a server automatically as part of a subagent launch.

## Risks / Trade-offs

- **Launch environment differs from interactive shell setup** -> Use the documented login environment, preserve explicit child context, and test working directories, paths, and executable resolution.
- **Script-wrapper success masks agent failure** -> Propagate the agent exit status and separately preserve provider-error signals.
- **A missing pane and a disconnected server look similar** -> Classify confirmed missing targets separately from retryable or sustained infrastructure failures.
- **Safety reports are absent or arrive late** -> Refuse unsafe delivery explicitly and test startup, ordinary waiting, blocked dialogs, and unsupported reporters.
- **Automatic sizing resets manual sizes within the affected tab** -> Document the agreed behavior, confine changes to that tab, and keep resizing best-effort.
- **CLI capture returns large scrollback** -> Avoid capture for normal exit detection; bound fallback reads used for result diagnostics.
- **Tests accidentally run the installed extension** -> Force workspace-source loading and isolate fixture identities.
- **Review configuration is unavailable** -> Treat role resolution as an execution prerequisite and stop rather than skip a gate.

- **Native status detection is disabled or a terminal path does not support it** -> Explain the capability/override issue without overriding user settings or inventing status from screen text.
- **Server/client configuration or shortcut layers differ** -> Provide read-only diagnostics and source references; leave actual configuration edits and reloads to explicit operator requests.

## Migration Plan

Implement and review the milestones on the workspace branch without changing the currently running global installation. Validate through explicitly loaded workspace source, finish the final review, and present the result for operator acceptance. Switching the user's package configuration or publishing is a separate action.

Rollback is reverting the reviewed workspace code changes; existing session/loadout artifacts are not migrated or deleted. The global installation is unaffected by this change.

## Open Questions

- Which tested Rex build/capability set should the final documentation list? Resolve from the new integration tests rather than claiming compatibility from inspection alone.
- Is a native macOS-host runner available for verification? If not, report that coverage gap explicitly; a macOS Rex client connected to Linux is not macOS-host validation.
