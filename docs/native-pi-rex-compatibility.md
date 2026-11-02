# Native Pi / Rex compatibility evidence

## Scope and sources

Milestone 5 of `port-subagents-to-rex` reuses Pi's native rendering and OSC 7501 reporter. The adapter only preserves explicit native environment choices in server-launched wrappers and consumes status before steering. Global configuration and the live server's keymap were inspected in read-only mode; no user/global Pi/Rex settings or keyboard bindings were modified, applied, or reloaded. The installed subagent implementation was neither modified nor consulted.

Canonical Pi inputs were read from the installed **1.4.0** distribution (`pi/docs/terminal-setup.md`, `environment-variables.md`, `settings.md`, `configuration.md`, `keybindings.md`, `extensions.md`, `tui.md`, plus `CHANGELOG.md`). Changelog entries identify Rex hyperlinks/truecolor/images in **1.4.0**, and program status in **1.1.0**. See the [README capability and configuration guidance](../README.md#native-pi-capabilities--safe-steering) for supported override names and precedence. `PI_TERMINAL_STATUS` / `PI_IMAGE_SUPPORT` are not the documented 1.4.0 names.

Superlogical MCP's canonical pages were retrieved during design; the coordinator confirmed their configuration and shortcut excerpts for this milestone. They were cross-checked against the connected public CLI help, without requiring MCP in the extension:

- [Configuration](https://www.superlogical.com/rex/docs/customize/config): server-side path precedence, no file watcher, explicit local reload and validation.
- [Keyboard shortcuts](https://www.superlogical.com/rex/docs/customize/keyboard-shortcuts#how-shortcuts-are-resolved): client-recorded > server configuration > client defaults.
- [Key sequences](https://www.superlogical.com/rex/docs/customize/key-sequences#binding-vs-sequence-conflict): prefixes consume keys.
- [Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status): query-based detection, multiple records, record lifetime distinct from process lifetime.

## Observed automated checks

Host: **Linux**. `pi --version`: **1.4.0**. `rex version` and connected `rex whoami --json` agree on **0.0.1793420730-g6d0d9a**, API revision **9**. This records a tested capability set, not an invented minimum Rex version.

Run from the workspace inside a Rex terminal:

```bash
npm test
npm run test:surface
npx tsc --noEmit
# Focused no-model native Pi cases, if diagnosing just this milestone:
node --test --test-name-pattern='source-loaded Pi' test/integration/rex-surface.test.ts
```

The native smoke loads **workspace** `pi-extension/subagents/index.ts` with `pi -ne -e <absolute-source>`, and explicitly loads `test/integration/fixtures/native-pi.ts`. Each case uses a temporary cwd and `PI_CODING_AGENT_DIR`, no saved session, no discovered extensions/skills/prompts/themes, no task prompt, offline automatic-network settings, and no user auth file. It invokes only known slash commands, checks for unexpected provider-request hooks, and performs **no model requests**. The fixture uses Pi's built-in Markdown/Text/Image components and `ctx.ui.confirm`, not raw escape-sequence rendering or a synthetic OSC reporter. Only owned panes/temp files are removed, and focus is asserted unchanged.

| Case | Observed behavior (not merely a documentation claim) |
| --- | --- |
| Automatic, no native overrides | Real Rex environment reports `TERM_PROGRAM=rex`; Pi detects hyperlinks and truecolor plus Kitty images. Native Markdown's URL is retained as an HTML `href` by Rex; exact RGB `#123456` is retained in Rex capture. A checkerboard PNG is transmitted as native Kitty graphics in Pi's terminal write log. |
| Automatic OSC 7501 | Live `program_status` returns Pi `idle` after native negotiation with no `PI_PROGRAM_STATUS=1`. Pasting `/hotkeys` through the workspace guard produces Pi's shortcut table. A real `ctx.ui.confirm` dialog produces native `blocked`, and subsequent steering is refused. |
| Explicit `PI_PROGRAM_STATUS=0` | Pi emits no status records; steering `/hotkeys` is refused with `PI_PROGRAM_STATUS`/OSC 7501/manual-interaction guidance. The Pi process stays alive. No automatic enabling or input submission occurs. |
| Conflicting render env/settings | Environment forces hyperlinks/images/truecolor on, but `terminal.hyperlinks/images/trueColor=false` wins. No link target, Kitty transmission, or test RGB truecolor sequence appears in the write log; native fallback text is rendered. OSC status and `/hotkeys` still work independently. |
| Configuration integrity | The isolated settings file remains byte-for-byte unchanged in all three cases. Its initial changelog version is supplied to avoid Pi's own unrelated first-start changelog bookkeeping. No real user configuration is opened for writing. |

Unit cases in `test/test.ts` also exercise Pi's own `detectCapabilities`, capability overrides from `SettingsManager.inMemory`, environment disablement and `auto`, settings-over-environment precedence, explicit override preservation/quoting in generated wrappers, and automatic/disabled/forced-but-unavailable/query-failed/native-report status cases. Missing status refuses input even if the parent's environment says `1`; a trustworthy child report is accepted even if the parent says `0`. The adapter neither treats environment values as safety evidence nor changes them/settings in response to a refusal.

**Observation boundary:** the image smoke observes native PNG transmission into a live Rex pane, not GUI pixels. No automated click-through/hover behavior, visual image fidelity, or native macOS-host run is claimed. Those remain distinct operator/final-acceptance checks. A macOS GUI connected to this Linux server would not establish macOS-host coverage. The alternate `cli: claude` path has no Pi-compatible status reporter supplied here and is not certified for safe steering.

## Configuration diagnostics actually checked

The following contracts were inspected through current help:

```bash
rex config check --help
rex config reload --help
rex keymap --help
```

Read-only `rex config check --json` reported the local account's `~/.config/rex/init.lua` exists, with 13 bindings, 6 removals, and no diagnostics. `rex keymap --json` reported the running server's configuration layer had no loaded file/bindings (generation 1). This difference is **not** evidence of broken config or GUI shortcuts: local validation loads the current file using the CLI, whereas keymap queries the live server and bare requests supply no GUI default/recorded layers. No reload was performed to reconcile them. CLI/server/environment/version differences and unapplied edits must be diagnosed explicitly.

`rex config check` loads trusted Lua without installing its bindings or applying them to the live server; it is not a sandbox for arbitrary scripts. `rex config reload` changes live state and notifies clients, advances generation even on failed reads, retains last-good bindings on failure, and requires the server's local socket. It was **documented, not executed**. No actual GUI `client.keymap` request was supplied; the effective GUI shortcut stack is therefore **not** claimed verified.

Pi's real `/hotkeys` command was exercised by the source-loaded smoke. Its keybindings documentation was checked for context-sensitive cancel/clear/exit, newline, follow-up, and tool-expansion keys; the extension's own Ctrl+Alt+O shortcut is documented separately. Configuration/load-time Lua is not used to launch agents.

## Optional operator visual check

On a separately approved host/client, use an isolated settings directory and explicitly load the workspace extension and native fixture (fixture cwd must be disposable). Do not send a model prompt. Confirm the native `NATIVE_REX_LINK` target, the colored `NATIVE_REX_COLOR` text, and the red/blue checkerboard visually; record host OS, Pi/Rex CLI/server/client versions, terminal path, overrides, and exact observations. Compare `/hotkeys` with the actual GUI shortcut settings or its full `client.keymap` request. Exit/close only that owned test pane. Do not edit/reload user configuration as part of this check.
