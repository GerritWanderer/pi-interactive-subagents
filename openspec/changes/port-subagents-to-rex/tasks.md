# Tasks

Execute this checklist from a main Pi apply session, not from explore mode. Sections 2–5 are major implementation milestones; section 6 is final acceptance. Use one writing worker at a time. After each milestone, dispatch the requested `pr-agent`, send requested changes back to the same worker by its persistent name, and require re-review approval before advancing. Reviewers do not implement fixes. Record verdicts and verification evidence in the relevant milestone's report; an unavailable or blocked reviewer is not approval.

Allowed context: workspace source, Rex's public CLI/connected-server API, Superlogical MCP/official Rex documentation, and Pi's own documentation/changelog. Do not inspect or copy the globally installed subagent implementation, change global configuration, publish, commit, or create a PR without a separate request. The coordinator retrieves and forwards cited documentation when restricted workers/reviewers lack MCP access.

## 1. Execution readiness

- [ ] 1.1 Read the planning artifacts and resolve approved `worker` and `pr-agent` roles in the main session; verify actual role availability and spawn permissions, obtaining a user decision if the reviewer needs a new profile or differently named alias.
- [ ] 1.2 Confirm the installed Pi/Rex CLI and connected server's required capabilities using version output, CLI help, and API descriptions; verify the context report includes host platform, explicit session/block targeting, command launch, process/status queries, paste input, and pane resizing, without relying on an installed extension working.
- [ ] 1.3 Refresh relevant Rex context through Superlogical MCP as needed and check Pi's local changelog/docs; verify the coordinator's brief records canonical sources, Pi 1.4.0 native terminal features and Pi 1.1.0 status introduction, the approved model/test budget, and available Linux/macOS-host runners without exposing credentials.

## 2. Major milestone: Rex surface integration

- [x] 2.1 Add the Rex surface module with safe CLI argument construction, runtime availability checks, explicit context targeting, and parsed returned resource IDs; verify unit tests cover missing tools/context, stale anchors, malformed responses, and no fallback to a focused or unrelated pane.
- [x] 2.2 Implement named top-level windows and parent-anchored nested splits, including placement overrides and anchor-based automatic direction; verify unit cases and no-model Rex surface tests cover names, tab lineage, wide/tall dimensions, right/down overrides, and focus preservation.
- [x] 2.3 Launch prepared scripts as new terminal commands with correct cwd/login environment and no prompt-ready delay; verify shell fixtures cover slow interactive startup, special-character paths/arguments, child context propagation, and release of reservations/resources after launch failure.
- [x] 2.4 Provide the targeted capture, process observation, safe paste/input, and close primitives required by the existing surface seam; verify unit and no-model fixtures cover literal input, readable completed commands, explicit IDs, blocked/unavailable-status refusal, and already-absent cleanup.
- [x] 2.5 Wire initial spawn and name-based resume in `index.ts` to the new surface module while preserving task/skill/identity/loadout handling; verify typechecking and focused regression tests pass and the supported runtime no longer dispatches to Herdr.
- [x] 2.6 Adapt the integration harness and add Rex surface tests, separating the no-model surface command from opt-in lifecycle runs; verify the no-model command starts no model requests, fixtures deliberately set top-level/nested identities, and spawned Pi tests explicitly load workspace source with extension discovery disabled.
- [x] 2.7 Document Rex prerequisites, supported hosts, explicit workspace-source startup, command launch, names, and placement controls alongside this milestone; verify examples against CLI help and the completed surface checks rather than advertising the installed package as the code under test.
- [ ] 2.8 Dispatch `pr-agent` for this milestone's current diff and verification evidence; send every requested change to the same worker and repeat review until an explicit approval is delivered, then record the verdict before proceeding.

## 3. Major milestone: Lifecycle and steering correctness

- [ ] 3.1 Make all generated launch wrappers preserve the agent's real exit status and provider-error signals; verify shell/unit tests cover success, nonzero exit, signal termination, provider-error sidecars, and the alternate CLI sentinel path without relying on an echo's success code.
- [ ] 3.2 Implement cancellable process-based completion observation with distinct interruption/infrastructure outcomes; verify tests cover a live process with a done report, confirmed pane closure, transient transport failure, sustained failure without endless polling, and one terminal result per run.
- [ ] 3.3 Separate result collection from idempotent resource cleanup, including preparation failures and shutdown/reload; verify tests show close failures do not replace collected summaries, missing panes stop tracking, and unrelated resources remain intact.
- [ ] 3.4 Preserve single-message normalization and guard native paste submission using the target's program-status report; verify literal quotes/metacharacters, blocked permission/question/auth dialogs, missing/query-failed status, relevant multi-record handling, and ordinary waiting for an orchestrator reply.
- [ ] 3.5 Preserve restricted name-based resume and replay its effective cwd/agent context; verify session/loadout tests cover tool/model/identity/spawn restrictions, original working-directory replay, and refusal when the snapshot is absent.
- [ ] 3.6 Preserve interactive and pending-work auto-exit policy plus activity-widget behavior; verify lifecycle fixtures cover interactive response completion, unanswered questions, running children, user abort, and clean Pi exit without interpreting OSC status as process termination.
- [ ] 3.7 Document acknowledgement/result semantics, safe-steering limitations, provider failure versus interrupted pane closure, and exiting Pi versus closing a pane; verify each documented outcome maps to a passing regression scenario from this milestone.
- [ ] 3.8 Dispatch `pr-agent` to review lifecycle, input safety, result classification, and restrictions; forward findings to the same worker, require re-review of fixes and regression evidence, and record explicit approval before proceeding.

## 4. Major milestone: Automatic sizing and legacy removal

- [ ] 4.1 Implement equal-share sizing for Rex tiled split trees; verify pure tests cover uneven columns, stacked rows, mixed axes, a single pane, and insignificant corrections using documented layout data.
- [ ] 4.2 Apply debounced resize plans only to the tab affected by creation/removal, remembering its identity before close; verify no-model Rex tests cover repeated spawns/exits, unchanged focus, other tabs/floating layers remaining untouched, and benign stale-layout/resize failures.
- [ ] 4.3 Dispose sizing timers/reservations during shutdown/reload and bound fallback diagnostic reads; verify lifecycle and large-output fixtures show no leaked background work and no dependency on scrollback for normal completion.
- [ ] 4.4 Remove Herdr TUI/desktop files, obsolete backend-specific Windows handling, and retired tests/imports after their replacement coverage exists; verify repository searches find no active Herdr/hc runtime or test dependency and typecheck/unit/surface checks still pass, retaining unrelated platform-independent tests.
- [ ] 4.5 Update sizing/override documentation and descriptive package metadata without changing package identity or publishing; verify docs explain affected-tab scope and manual-size resets, and documented options match the passing Rex tests.
- [ ] 4.6 Dispatch `pr-agent` for sizing locality, cleanup, legacy removal, and documentation; send findings back to the same worker and repeat review until approval, recording the approved diff and checks before proceeding.

## 5. Major milestone: Native Pi and configuration compatibility

- [ ] 5.1 Document and exercise Pi 1.4.0's native Rex hyperlinks, truecolor, and inline images, and its native OSC 7501 reporting; verify a source-loaded Pi/Rex smoke check or recorded operator check confirms the capabilities without adding a duplicate renderer/status emitter, distinguishing documented claims from observed behavior.
- [ ] 5.2 Document native capability/status overrides and preserve user choices rather than forcing reporting on; verify environment/configuration cases cover automatic detection, explicitly disabled status, actionable steering refusal, and no automatic modification of Pi settings.
- [ ] 5.3 Document server-side Rex configuration, file-location precedence, explicit local reload, read-only validation, shortcut-layer precedence, and Pi key collisions; verify guidance against Superlogical MCP sources, `rex config check`/`rex keymap` contracts, and Pi `/hotkeys`, without applying configuration or claiming a bare CLI query includes GUI-client layers.
- [ ] 5.4 Dispatch `pr-agent` to review native-feature boundaries, configuration guidance, and compatibility evidence; forward requested corrections to the same worker and require re-review approval, explicitly identifying any unsupported reporter or unverified host coverage.

## 6. Final major milestone: End-to-end acceptance

- [ ] 6.1 Run typechecking, the full unit suite, and the separate no-model Rex surface suite against workspace source; verify all pass and record the exact commands, Pi/Rex CLI/server versions, host platforms, and capability evidence.
- [ ] 6.2 With explicit model/test-run approval, run real-Pi lifecycle cases for asynchronous spawn/result, parallel agents, safe follow-up/resume, question/reply, interactive clean exit, nested pending work, and manually closed pane interruption; verify the parent receives the expected results from the workspace extension and test cleanup removes only owned resources.
- [ ] 6.3 Verify native macOS-host behavior where a runner is available; record actual host-side checks, or explicitly report the gap for an operator decision without substituting a macOS client connected to Linux as macOS-host evidence.
- [ ] 6.4 Have `pr-agent` review the complete integrated diff and final spec/check evidence, including interactions with previously approved milestones; return findings to the responsible worker, repeat re-review until approval, and record the final verdict without opening a PR automatically.
- [ ] 6.5 Present a consolidated implementation report and reconcile task completion with evidence; verify every completed milestone has reviewer approval, every unchecked or unverified item is disclosed, and no global configuration, package publishing, or unrelated implementation changes were made.
