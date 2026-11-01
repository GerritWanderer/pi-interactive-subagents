# Spec Delta

## Purpose

Provide Rex terminal surfaces for interactive subagents while preserving asynchronous orchestration, safe user interaction, reliable results, and readable agent layouts on Linux/macOS hosts.

## ADDED Requirements

### Requirement: Rex runtime targeting

The extension SHALL operate in a Rex terminal on Linux/macOS using the spawning terminal's session and pane identity. Missing prerequisites or stale identities SHALL produce an actionable error rather than target an unrelated pane or fall back to Herdr.

#### Scenario: Spawn from a valid Rex terminal
- **WHEN** a user requests a subagent from a Rex terminal with a reachable server and valid session and pane identities
- **THEN** the subagent is created in that Rex session

#### Scenario: Missing Rex prerequisites
- **WHEN** the user requests a subagent outside Rex or without a usable Rex CLI
- **THEN** the extension explains the missing prerequisites without creating a terminal

#### Scenario: Stale spawning pane
- **WHEN** the supplied spawning pane no longer exists
- **THEN** the extension reports a targeting error rather than using the user's focused pane as a substitute

### Requirement: Named top-level tabs

By default, the extension SHALL create one named Rex tab for each top-level subagent and label its pane with that agent's display name.

#### Scenario: Top-level agent launch
- **WHEN** a main Pi session spawns a subagent with a display name
- **THEN** the child opens in a new tab named for that subagent
- **AND** its pane has the corresponding label

### Requirement: Parent-anchored nested splits

The extension SHALL place nested subagents in splits anchored to their spawning agent's pane, keeping the lineage in its existing tab regardless of the user's current focus.

#### Scenario: Nested launch while focus is elsewhere
- **WHEN** a subagent spawns a child while the user views another tab or pane
- **THEN** the child is split beside its spawning agent in that agent's tab

### Requirement: Focus preservation

Creating, launching, messaging, sizing, and cleaning up background subagents SHALL NOT move focus away from an unrelated tab or pane the user is viewing.

#### Scenario: Background agent operations
- **WHEN** the extension creates and operates on a subagent while the user works in another pane
- **THEN** the user's active tab and focused pane remain unchanged

### Requirement: Placement overrides

The extension SHALL preserve the top-level tab-or-pane override and the right, down, or automatic split-direction override. Automatic direction SHALL choose right for wide panes and down for narrow or tall panes, with a documented fallback when dimensions cannot be read.

#### Scenario: Top-level pane override
- **WHEN** a main session spawns with the top-level surface override set to pane
- **THEN** the child splits the spawning pane instead of creating a tab

#### Scenario: Forced downward split
- **WHEN** the split-direction override requests down
- **THEN** a split child appears below its anchor

#### Scenario: Automatic direction
- **WHEN** a split is requested with automatic direction
- **THEN** the selected direction follows the spawning pane's dimensions rather than the dimensions of the user's focused pane

### Requirement: Reliable command launch

Subagents SHALL start without depending on an interactive shell prompt becoming ready. Launch SHALL honor the requested working directory and resolved agent loadout, preserve literal paths and arguments, and use the host's documented login environment.

#### Scenario: Slow interactive shell setup
- **WHEN** the host has slow interactive shell startup configuration
- **THEN** the subagent command is launched without typing it into an initializing shell or waiting a fixed shell-ready delay

#### Scenario: Paths and arguments containing special characters
- **WHEN** a launch uses a working directory or artifact path containing spaces, apostrophes, or shell metacharacters
- **THEN** the intended program receives the intended arguments and runs in the requested directory

### Requirement: Asynchronous result delivery

A successful spawn or finished-session follow-up SHALL return a launch acknowledgement without waiting for completion. The parent SHALL receive one terminal result when the run ends, including its final available summary and an accurate success, failure, or interruption outcome.

#### Scenario: Autonomous completion
- **WHEN** an autonomous subagent completes its task
- **THEN** its parent receives the final summary automatically without needing to poll
- **AND** the run is removed from live status tracking

#### Scenario: Program failure
- **WHEN** the launched agent exits unsuccessfully
- **THEN** the parent receives a failure outcome reflecting the agent's exit rather than a successful shell-wrapper exit

### Requirement: Literal steering messages

A message addressed to a running subagent SHALL arrive as one logical submitted message without shell interpretation. Message delivery SHALL target that subagent without moving focus.

#### Scenario: Steering contains special characters and newlines
- **WHEN** the parent sends a message containing quotes, metacharacters, or newlines
- **THEN** the child receives one message with the existing newline-normalization behavior
- **AND** the text is not executed as a shell command or split into multiple submissions

### Requirement: Blocked-dialog protection

The extension SHALL refuse steering that would type over a reported permission, question, or authentication dialog. If the required safety status cannot be read, delivery SHALL fail explicitly rather than blindly submit input.

#### Scenario: Child is blocked on a dialog
- **WHEN** the parent sends a message while Rex reports that the child is blocked on a dialog
- **THEN** the parent receives a blocked-delivery error
- **AND** no input is submitted to the dialog

#### Scenario: Safety status unavailable
- **WHEN** the extension cannot query the child's safety status
- **THEN** the parent receives a delivery error without submitting input

### Requirement: Interactive and pending-work lifetime

Finishing a response or reporting a done status SHALL NOT by itself close a running interactive agent. Existing auto-exit policy SHALL keep agents open while an orchestrator answer or child-agent result is pending.

#### Scenario: Interactive response completes
- **WHEN** an agent configured not to auto-exit finishes a response and its process remains alive
- **THEN** its pane stays open for further conversation

#### Scenario: Agent awaits an orchestrator reply
- **WHEN** a subagent asks its orchestrator a question and finishes that response
- **THEN** it remains open and its question is delivered to the parent
- **AND** a reply to this waiting agent is not rejected merely because the agent is waiting for ordinary input

#### Scenario: Agent awaits its children
- **WHEN** an auto-exit agent ends a response while its own child agents are still running
- **THEN** it remains open to receive their results

### Requirement: Completion cleanup

After a run ends, the extension SHALL collect its result before removing its pane. Cleanup SHALL be safe when the pane is already absent and SHALL preserve unrelated panes and tabs. Cleanup failures SHALL NOT erase an already collected result.

#### Scenario: Interactive agent exits cleanly
- **WHEN** the user exits Pi inside an interactive subagent pane
- **THEN** the final available summary is collected and returned to the parent
- **AND** the completed pane is removed

#### Scenario: Pane already removed during cleanup
- **WHEN** cleanup encounters a pane that has already disappeared
- **THEN** the completed run is not reported as a new provider failure because cleanup found no pane

### Requirement: Externally closed pane interruption

If a running subagent pane is externally closed, the extension SHALL end tracking and notify the parent of interruption rather than wait indefinitely. The result SHALL distinguish pane closure from a provider failure and retain available session data for follow-up.

#### Scenario: User closes a running pane
- **WHEN** the user closes a Rex pane before its subagent process completes
- **THEN** the parent receives an interrupted-run result
- **AND** the extension stops watching the missing pane
- **AND** the saved session remains available for a name-based follow-up

### Requirement: Name-based follow-up restrictions

Following up with a finished subagent by name SHALL open a new Rex surface using the existing saved session and recorded tool, model, identity, working-directory, and spawn restrictions. Existing refusal of unsafe resume without a loadout snapshot SHALL be preserved.

#### Scenario: Follow up after completion
- **WHEN** the parent messages a registered finished subagent with a valid session and loadout snapshot
- **THEN** that session resumes in a new surface using its recorded restrictions
- **AND** the follow-up completes asynchronously under the existing autonomous-resume policy

#### Scenario: Missing loadout snapshot
- **WHEN** a finished subagent lacks the snapshot required for restricted resume
- **THEN** the extension refuses to relaunch it with an unrestricted loadout

### Requirement: Automatic pane sizing

After split creation or pane cleanup, the extension SHALL automatically balance the affected tab's tiled panes into equal column and row shares for their split structure. Sizing SHALL be best-effort, preserve focus, and leave other tabs unchanged.

#### Scenario: Repeated nested splits
- **WHEN** several nested children are created in an agent tab
- **THEN** automatic sizing balances the corresponding columns and rows rather than leaving repeated halvings to shrink later panes indefinitely

#### Scenario: Child pane closes
- **WHEN** a child pane is removed from a tab that still has multiple tiled panes
- **THEN** the surviving layout is rebalanced within that tab
- **AND** layouts in other tabs remain unchanged

#### Scenario: Resizing fails
- **WHEN** a resize request fails or the affected layout disappears
- **THEN** launching, watching, result delivery, and cleanup continue without failing solely because sizing failed

### Requirement: Activity display continuity

The extension SHALL retain its existing activity widget and autonomous-versus-interactive notification policy. Rex terminal status used for safe input SHALL NOT replace the activity information used for the parent widget.

#### Scenario: Interactive agent waits between prompts
- **WHEN** an interactive agent is waiting for input
- **THEN** its activity state remains visible to the parent
- **AND** ordinary waiting does not become a provider failure or an unwanted autonomous stall notification
