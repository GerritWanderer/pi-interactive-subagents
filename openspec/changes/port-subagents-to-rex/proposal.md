# Proposal

## Why

This workspace can launch interactive subagents only through Herdr, so its own extension cannot operate in the Rex terminals used for this workflow. A workspace-owned Rex integration is needed, developed from this repository, Rex's public CLI/API and Superlogical MCP documentation, and Pi's own documentation/changelog rather than consulting or copying a globally installed subagent implementation.

## What Changes

- **BREAKING**: Replace Herdr TUI and desktop (`hc`) support with Rex-only surface operations. Support Linux/macOS hosts; defer native Windows hosts.
- Preserve the subagent tool API, agent profiles, session/loadout restrictions, name-based follow-ups, question/reply handling, and status widget.
- Open named Rex tabs for top-level agents and parent-anchored splits for nested agents, without moving user focus. Preserve placement overrides and automatic sizing within the affected tab.
- Launch prepared scripts as pane commands instead of typing into a shell; use process exit to distinguish completion from an interactive agent finishing a response.
- Deliver steering messages safely as paste input, with blocked-dialog protection using Pi's native program-status reporting.
- Collect final results and clean up completed panes. Keep interactive agents open until Pi exits, and report an externally closed running pane as interrupted rather than wait indefinitely.
- Replace backend-specific tests and documentation. Keep no-model Rex surface checks separate from opt-in real-Pi lifecycle checks, and force those checks to load this workspace's extension.
- Account for Pi's native Rex support: Pi 1.4.0 added hyperlinks, truecolor, and inline images; Pi 1.1.0 introduced OSC 7501 status. Validate these integration assumptions without duplicating terminal rendering or status emission.
- Execute implementation in major milestones coordinated by a Pi orchestrator. After each milestone, `pr-agent` reviews the worker's changes; findings return to that worker, and the milestone advances only after re-review approval. The orchestrator can retrieve Rex context through Superlogical MCP and pass it to restricted workers/reviewers. This is an implementation workflow, not a new extension feature.

## Capabilities

### New Capabilities

- `rex-subagent-surfaces`: Rex runtime targeting, background placement and launch, safe steering, pane lifetime and cleanup, and automatic sizing for interactive subagents.

### Modified Capabilities

None. This workspace currently has no main capability specs.

## Impact

- Replace `pi-extension/subagents/herdr.ts` and remove `herdr-desktop.ts`; adapt the small surface seam used by `index.ts`.
- Update backend assumptions in `test/test.ts`, `test/integration/harness.ts`, surface tests, and lifecycle tests. Retain backend-independent session, loadout, question, and activity coverage.
- Update `README.md`, package descriptions, and test commands to describe Rex, supported hosts, native Pi capabilities, and configuration diagnostics. No new runtime library dependency is expected; Rex's CLI is required. Superlogical MCP is a development/documentation source, not a runtime dependency.
- Do not change global Pi/Rex configuration, consult the globally installed subagent source, publish packages, rename package identity, or redesign the alternate Claude CLI path in this change.
- A main Pi implementation session must provide workers and the requested `pr-agent` reviewer. Neither a reusable orchestrator profile nor a `pr-agent` profile is currently defined in this workspace; profile setup must be resolved before implementation starts.
