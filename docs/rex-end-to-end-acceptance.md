# Rex end-to-end acceptance — Milestone 6

Verification date: **2026-11-02 UTC**. Workspace branch: `port-subagents-to-rex-m6`; review base: `port-subagents-to-rex-m5`. This records task 6.1–6.3 execution, **not** final review approval or operator acceptance (6.4–6.5).

## Tested environment

| Component | Observed value |
| --- | --- |
| Execution / Rex server host | Linux `7.2.8-9-omarchy`, `x86_64` (`uname -srm`) |
| Node / npm | `v26.13.0` / `11.20.0` |
| Pi | `1.4.0` (`pi --version`) |
| Rex CLI | `0.0.1793420730-g6d0d9a` (`rex version`) |
| CLI commit / build | `6d0d9a3625e0944272c35cb172331e5230ca7890` / `2026-10-31T04:25:30Z` |
| Rex API | revision **9**, advertised support **0–9** |
| Connected server | `rex whoami --json`: same `rex_version`, local Unix transport, reached at `unix:///run/user/1000/rex/server.sock` |
| Approved real-model run | `github-copilot/gemini-3.8-flash`, authentication readiness confirmed without printing credentials |

The initially configured default, `anthropic/claude-haiku-4-5`, had no credentials. The coordinator explicitly approved using the authenticated model above. `PI_TEST_MODEL` now applies to parent Pi and all copied agent profiles; those profiles and parents use thinking `off`. No installed subagent implementation was inspected or used as the code under test.

## Exact final verification commands and results

Run in the workspace from a valid Rex terminal:

```bash
npx tsc --noEmit
npm test
npm run test:surface
PI_TEST_MODEL=github-copilot/gemini-3.8-flash PI_TEST_TIMEOUT=240000 npm run test:integration
git diff --check
```

| Check | Final result |
| --- | --- |
| TypeScript | zero errors |
| Unit suite | **228 passed**, 45 suites, no failures/cancellations/skips |
| Separate no-model Rex surface suite | **21 passed**, no failures/cancellations/skips |
| Combined integration command | **30 passed**: 21 no-model surface cases + **9 real-Pi lifecycle cases**, no failures/cancellations/skips |
| Combined integration elapsed time | **717258.809728 ms** (about 12 minutes) |
| Whitespace / patch check | clean |

The unit and separate surface commands were rerun successfully after the full clean integration run. The separate surface command makes no model requests, including its native Pi smoke fixtures. The model-using command is opt-in and was run only after approval. Final raw console output was retained locally under `/tmp/rex-m6-evidence/` (`unit.log`, `surface.log`, `integration.log`); this document is the durable evidence summary, not a dependency on those temporary files.

## Workspace-source and ownership evidence

- Parent launch uses an explicit saved transcript and `pi -ne -e <workspace>/pi-extension/subagents/index.ts`, with MCP, skills, prompt-template and context-file discovery disabled for the parent fixture.
- Restricted child profiles load `subagent-done.ts` and tool-backing extensions from this workspace with `--no-extensions`; nested coordinator spawning loads this workspace's `index.ts` explicitly. The initial child transcript verifies the actual provider/model, rather than only checking the requested CLI model.
- Tests parse Pi `message` and `custom_message` journal entries. A successful launch requires a real tool acknowledgement with `details.status=started`; completion requires a separately persisted `subagent_result` with the expected name, outcome, exit status, saved session and summary. Parent assistant turns after delivery are also checked. Prompt echoes cannot satisfy these assertions.
- Each lifecycle test creates a **dedicated Rex session** via `rex new --json`, saves its exact session/block IDs, and deliberately clears inherited subagent identities. Server-side parent launch also clears `PI_SUBAGENT_*` markers. This prevents a worker's spawn allowlist or auto-exit settings from becoming the test parent's identity.
- Teardown closes tracked surfaces and kills only the exact session returned by that case's creation call, including any descendants left after a failed assertion. Every case asserts that its session is absent afterwards and that the invoking, unrelated pane remains present. Temporary project directories/parent transcripts are removed. Normal saved child-session history remains in Pi's standard session storage, and saved history/loadout availability is verified before cleanup.
- A final `rex ls --json` check showed exactly the original four sessions and **no `pi-lifecycle-*` sessions** remaining. No other session was killed; the surface suite separately verifies locality and focus preservation.

## Real-Pi lifecycle cases observed

| Case | Assertions that passed |
| --- | --- |
| Asynchronous spawn/result | Launch acknowledgement arrives while the task is still pending; one successful terminal result contains the actual child summary/session; parent resumes after delivery; child pane is removed. |
| Long active tool / watchdog | A 90-second Bash call still has `active` / `tool` / `bash` activity after 65 seconds; no false stalled notification; eventual parent result succeeds. |
| Parallel agents | Both launch acknowledgements arrive before either result; both pane processes are live simultaneously; both expected marker files and distinct parent results arrive exactly once. |
| Restricted name-based resume | Two terminal results reference the same saved session; resume returns asynchronously; original special-character cwd is used; model, tool allowlist and byte-identical loadout persist; resumed script disables extension discovery. |
| Question/reply | The parent receives a real `subagent_question`; `subagent_message` reports `steered`, not a relaunch; child writes the supplied answer and completes. An ordinary orchestrator question is not mistaken for a blocked UI dialog. |
| Interactive lifetime / literal steering / clean exit | A completed response leaves Pi alive and sends no premature terminal result; parent tool safely submits quotes, shell metacharacters and normalized multiline input literally; no injected file is created; targeted `Ctrl+D` exits idle Pi; the parent receives one successful result with its final available summary and the pane is removed. |
| Nested pending work | Coordinator remains alive after ending its response with a running child; nested pane is in the coordinator's tab; nested result reaches the coordinator before outer completion; outer parent receives the final summary; both child panes disappear. |
| Manual closure / recovery | Closing the exact live child block yields one `interrupted` result with nonzero exit, not a provider failure; original session/loadout remain available; name-based follow-up reuses the saved session and completes successfully. |
| Profile fork / discovery / identity | Project-local profile is discovered; fork header points to the actual parent transcript; `system-prompt: append` identity is present in the real Pi system prompt and saved loadout; task and parent result complete. |

## Capability evidence and acceptance fixes

Read-only public CLI/schema checks:

```bash
rex version
rex whoami --json
rex window new --help
rex split --help
rex block rename --help
rex block inspect -s "$REX_SESSION" "$REX_BLOCK" --json
rex api describe session.new_window --json
rex api describe session.new_split --json
rex api describe session.view --json
rex api describe session.resize_pane --json
rex api describe block.event --json
```

- Explicit full session/block targeting, direct command argv, cwd/login environment, `--focus=false` and `--keep-open` are supported and exercised by the surface/lifecycle tests.
- Terminal inspection advertises `process` and `program_status`. Live tests use `process.last_exit` for lifetime, native Pi OSC 7501 for input safety, and distinguish confirmed missing blocks from transport failures. Native blocked/missing-status refusal remains covered by unit/surface tests; no duplicate status emitter or text-based safety bypass was added.
- `block.event` exposes literal paste events and key submission. The real interactive case verifies delivery through the actual parent `subagent_message` tool.
- `session.view` exposes tiled split trees; `session.resize_pane` accepts explicit adjacent block IDs and ratio without moving focus. Surface tests verify tab-local balancing, unchanged unrelated/floating layouts, and cosmetic failure handling.
- Native smoke cases observe Pi's hyperlink target and exact RGB color in Rex capture, Kitty image transmission in Pi's write log, automatic native status detection, blocked dialog status, explicit status disablement and settings-over-env precedence. GUI pixels/click-through are **not** claimed; see [native compatibility evidence](native-pi-rex-compatibility.md).
- Acceptance uncovered a runtime defect: `rex window new LABEL` named only the tab, not its command pane. The adapter now explicitly renames the returned block using the full session/block IDs. Two unit regressions cover literal labels and preserving the launched command with a warning if rename fails; live surface and lifecycle checks verify the label. This is the only runtime implementation change in Milestone 6.
- Acceptance also replaced stale lifecycle fixtures that used removed `fork` / `systemPrompt` tool parameters and `caller_ping`, weak optional session checks and prompt-matching success patterns. Tests now exercise profile-selected fork/identity, `ask_question`, persisted results, explicit fixture identities, model overrides, safe steering/resume, pending children and owned-session cleanup.
- Early runs failed on the missing pane label, too-short waits for actual model latency, a suite-wide timeout and a fixture frontmatter typo. Those were diagnosed and corrected; the final combined run above is wholly passing. No exception, skip or weakened safety check was used to obtain that result.

## Native macOS-host availability — explicit gap (task 6.3)

Actual checks on this machine:

```bash
uname -srm
rex hosts list --json
```

`uname` reports Linux x86_64. `rex hosts list --json` reports a reached local home (`this_machine: true`), **`hosts: []`**, and no warnings. No native macOS-host runner was supplied by the coordinator. The repository's `.github/workflows/ci.yaml` also has only `ubuntu-latest` jobs, not a macOS acceptance runner.

**Native macOS-host behavior has not been tested.** This is an operator coverage decision: either provide a native macOS Rex server/runner and repeat the commands above there (with approved credentials/model budget), or explicitly accept/defer that coverage gap at final acceptance. A macOS GUI connected to this Linux server would not close the gap. Task 6.3 records runner checking and this disclosure, not a claim of macOS conformance.

## Boundaries and remaining gates

No global Pi/Rex configuration edits, configuration reloads, package publishing/identity changes, or PR creation were performed by the acceptance verification run. Protected untracked `review.md` and `improve.md` were not touched. Standard model authentication was used without emitting credentials. Task 6.4 (coordinator dispatch of `pr-agent` for the integrated diff and prior-milestone interactions) and 6.5 (consolidated final acceptance/reconciliation) remain unchecked. This report does not replace either gate.
