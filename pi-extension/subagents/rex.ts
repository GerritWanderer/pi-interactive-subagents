/**
 * Rex surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type into it, read its screen, close it, and poll
 * for exit. Keeping the rex calls isolated here means index.ts stays testable
 * without a multiplexer running. All calls go through the `rex` CLI, scoped to
 * the caller's session (`$REX_SESSION`); the CLI finds the server itself.
 *
 * Rex vocabulary: a *window* is a tab, a *block* is a pane. Block ids look
 * like `block:01a1…`.
 *
 * Placement mirrors the Herdr fork:
 *   - a subagent spawned by the main session gets its own window (tab),
 *     labelled with the subagent's name;
 *   - a subagent spawned by another subagent splits its parent's block
 *     (`$REX_BLOCK`), so a whole lineage stays inside one tab.
 * Nothing takes focus (`--focus=false`).
 *
 * Launching never types into a shell. createSurface only reserves a handle;
 * sendLongCommand then starts the block directly on the launch script
 * (`rex split|window new -- bash <script>`), which Rex runs with the login
 * shell's environment. So there is no shell-ready delay, and nothing can be
 * dropped while a prompt starts. Blocks are created with `--keep-open`, so
 * the program's exit status stays readable (`block call process` →
 * `last_exit`) until closeSurface removes the block.
 *
 * Messages to a running child are delivered as a paste event (bracketed paste
 * in the child) followed by Enter, but only after the child's Program Status
 * Protocol (OSC 7501) report confirms it is safe. pi emits that report
 * natively. Missing or unreadable status refuses the message rather than
 * typing into something unknown.
 *
 * Completion comes from the block's process record and the `.exit` sidecar,
 * never from scrollback.
 */
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/** Path to the rex binary. Override with PI_SUBAGENT_REX_BIN. */
function rexBin(): string {
  return process.env.PI_SUBAGENT_REX_BIN?.trim() || "rex";
}

function rexSession(): string {
  return process.env.REX_SESSION?.trim() ?? "";
}

/**
 * True when running inside a Rex terminal with the rex binary reachable.
 * Rex exports `REX_SESSION` and `REX_BLOCK` into every terminal it opens.
 */
export function isRexAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.REX_SESSION?.trim() && !!env.REX_BLOCK?.trim() && hasCommand(rexBin());
}

export function isMuxAvailable(): boolean {
  return isRexAvailable();
}

export function muxSetupHint(): string {
  return "Start pi in a Rex terminal (any Rex tab or pane), with `rex` on your PATH.";
}

/**
 * Whether a freshly created surface needs a pause for its shell to start
 * before the launch command is typed. Rex blocks start directly on the
 * launch script, so there is never anything to wait for.
 */
export function needsShellReadyDelay(): boolean {
  return false;
}

function requireRex(): void {
  if (!isRexAvailable()) {
    throw new Error(`Rex is required for subagents. ${muxSetupHint()}`);
  }
}

// ── CLI helpers ──

function rexErrorMessage(error: any): string {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  if (stderr) return stderr.replace(/^Error:\s*/, "");
  return error?.message ?? String(error);
}

/** Upper bound for one process/status query, so a stuck CLI counts as a failure. */
const REX_QUERY_TIMEOUT_MS = 15_000;

/** Run a rex command scoped to the caller's session; returns stdout. */
function rex(args: string[], options?: { timeoutMs?: number }): string {
  try {
    return execFileSync(rexBin(), args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });
  } catch (error: any) {
    throw new Error(`rex ${args[0]} ${args[1] ?? ""} failed: ${rexErrorMessage(error)}`);
  }
}

async function rexAsync(args: string[], options?: { timeoutMs?: number }): Promise<string> {
  try {
    const { stdout } = await execFileAsync(rexBin(), args, {
      encoding: "utf8",
      ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });
    return stdout;
  } catch (error: any) {
    throw new Error(`rex ${args[0]} ${args[1] ?? ""} failed: ${rexErrorMessage(error)}`);
  }
}

function parseJson(stdout: string): any {
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

/** `rex api call METHOD ARGS` in the caller's session. */
function rexApi(method: string, args: Record<string, unknown>): any {
  return parseJson(rex(["api", "call", "-s", rexSession(), method, JSON.stringify(args)]));
}

/** `rex block call -b BLOCK METHOD` in the caller's session. */
function blockCall(block: string, method: string, timeoutMs?: number): any {
  return parseJson(rex(["block", "call", "-s", rexSession(), "-b", block, method], { timeoutMs }));
}

async function blockCallAsync(block: string, method: string): Promise<any> {
  return parseJson(
    await rexAsync(["block", "call", "-s", rexSession(), "-b", block, method], {
      timeoutMs: REX_QUERY_TIMEOUT_MS,
    }),
  );
}

/**
 * True only when Rex says the block itself is gone. A missing binary or a
 * transport failure must not look like a closed pane.
 */
function isNotFoundError(error: any): boolean {
  return /block target .* not found/i.test(error?.message ?? String(error));
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Placement settings ──

type SplitDirection = "left" | "right" | "up" | "down";

/**
 * Where a new subagent pane goes, relative to the parent pi block.
 * "right" and "down" always split that way. "auto" splits a wide block to the
 * right and a narrow or tall block down. Override with PI_SUBAGENT_SPLIT_DIRECTION.
 */
const SUBAGENT_SPLIT_DIRECTION: "right" | "down" | "auto" = "auto";

function splitDirectionSetting(): "right" | "down" | "auto" {
  const raw = process.env.PI_SUBAGENT_SPLIT_DIRECTION?.trim();
  return raw === "right" || raw === "down" || raw === "auto" ? raw : SUBAGENT_SPLIT_DIRECTION;
}

/**
 * Which surface a top-level subagent gets. "tab" gives every subagent of the
 * main session its own window, so the tab bar reads as a list of running
 * subagents. "pane" splits the main session's block instead.
 * Override with PI_SUBAGENT_TOP_LEVEL_SURFACE.
 */
const SUBAGENT_TOP_LEVEL_SURFACE: "tab" | "pane" = "tab";

function topLevelSurfaceSetting(): "tab" | "pane" {
  const raw = process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE?.trim();
  return raw === "tab" || raw === "pane" ? raw : SUBAGENT_TOP_LEVEL_SURFACE;
}

/**
 * True when this pi is itself a subagent, i.e. it was launched by another pi
 * with PI_SUBAGENT_NAME exported into its environment. Its children split its
 * block instead of opening a window.
 */
export function isNestedSpawner(): boolean {
  return !!process.env.PI_SUBAGENT_NAME?.trim();
}

/**
 * Decide where a new subagent surface goes: a window for the main session, a
 * split for a subagent spawning its own children.
 */
export function chooseSurfaceKind(
  nested: boolean = isNestedSpawner(),
  setting: "tab" | "pane" = topLevelSurfaceSetting(),
): "tab" | "pane" {
  return !nested && setting === "tab" ? "tab" : "pane";
}

export interface TerminalSize {
  columns: number;
  rows: number;
}

/**
 * Pick the split direction for a new block off a parent of `size`. Terminal
 * cells are roughly twice as tall as wide, so a block is "wide" when it has at
 * least two columns per row. Falls back to "right" when the size is unknown.
 */
export function chooseSplitDirection(
  size: TerminalSize | undefined,
  setting: "right" | "down" | "auto" = splitDirectionSetting(),
): "right" | "down" {
  if (setting !== "auto") return setting;
  if (!size || !(size.rows > 0) || !(size.columns > 0)) return "right";
  return size.columns / size.rows >= 2 ? "right" : "down";
}

/** The `--split` value rex expects for a direction. */
export function rexSplitDirection(direction: SplitDirection): "right" | "left" | "above" | "below" {
  if (direction === "up") return "above";
  if (direction === "down") return "below";
  return direction;
}

function readSize(block: string): TerminalSize | undefined {
  try {
    const size = blockCall(block, "size");
    return typeof size?.columns === "number" && typeof size?.rows === "number"
      ? { columns: size.columns, rows: size.rows }
      : undefined;
  } catch {
    return undefined;
  }
}

// ── Layout balancing ──

/** A node of a window's tiled layout, as `rex session inspect --json` reports it. */
export interface LayoutNode {
  rect?: number[];
  block_id?: string;
  split?: {
    split_id: string;
    direction: "horizontal" | "vertical";
    ratio: number;
    before: LayoutNode;
    after: LayoutNode;
  };
}

/** One `session.resize_pane` call: move the border between two adjacent blocks. */
export interface ResizeStep {
  direction: "horizontal" | "vertical";
  beforeBlock: string;
  afterBlock: string;
  ratio: number;
}

/**
 * How many equal shares a subtree needs along `direction`: panes side by side
 * add up, panes stacked across the other axis count as one.
 */
function shareCount(node: LayoutNode, direction: "horizontal" | "vertical"): number {
  const split = node.split;
  if (!split) return 1;
  const before = shareCount(split.before, direction);
  const after = shareCount(split.after, direction);
  return split.direction === direction ? before + after : Math.max(before, after);
}

/**
 * The block of `node` that touches a border along `direction`: the last block
 * when the node sits before the border, the first when it sits after it.
 */
function edgeBlock(
  node: LayoutNode,
  direction: "horizontal" | "vertical",
  side: "before" | "after",
): string | null {
  if (node.block_id) return node.block_id;
  const split = node.split;
  if (!split) return null;
  if (split.direction === direction) {
    return edgeBlock(side === "before" ? split.after : split.before, direction, side);
  }
  return edgeBlock(split.before, direction, side);
}

/**
 * Resize steps that give every column (and every row inside a column) an
 * equal share of its split. Rex has no named layouts, so this is the
 * equivalent of tmux's `even-horizontal`. Splits within 1% of even are left
 * alone so a balanced window costs no calls.
 */
export function planEvenSplits(layout: LayoutNode | null | undefined): ResizeStep[] {
  const steps: ResizeStep[] = [];
  const visit = (node: LayoutNode | undefined) => {
    const split = node?.split;
    if (!split) return;
    const before = shareCount(split.before, split.direction);
    const after = shareCount(split.after, split.direction);
    const target = before / (before + after);
    if (Math.abs(split.ratio - target) >= 0.01) {
      const beforeBlock = edgeBlock(split.before, split.direction, "before");
      const afterBlock = edgeBlock(split.after, split.direction, "after");
      if (beforeBlock && afterBlock) {
        steps.push({ direction: split.direction, beforeBlock, afterBlock, ratio: target });
      }
    }
    visit(split.before);
    visit(split.after);
  };
  visit(layout ?? undefined);
  return steps;
}

function layoutContains(node: LayoutNode | undefined, block: string): boolean {
  if (!node) return false;
  if (node.block_id === block) return true;
  return layoutContains(node.split?.before, block) || layoutContains(node.split?.after, block);
}

/** The id and tiled layout of the window holding `block`, from a session view. */
export function findWindowOfBlock(
  view: any,
  block: string,
): { windowId: string; layout: LayoutNode } | null {
  for (const window of view?.windows ?? []) {
    for (const layer of window?.layers ?? []) {
      if (layer?.kind === "tiled" && layoutContains(layer.layout, block)) {
        return { windowId: window.window_id, layout: layer.layout };
      }
    }
  }
  return null;
}

function findLayoutOfWindow(view: any, windowId: string): LayoutNode | null {
  const window = (view?.windows ?? []).find((w: any) => w?.window_id === windowId);
  return window?.layers?.find((l: any) => l?.kind === "tiled")?.layout ?? null;
}

function readSessionView(): any {
  return parseJson(rex(["session", "inspect", rexSession(), "--json"]));
}

const pendingRebalance = new Set<string>();
let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Even out the blocks of a window so repeated splits don't leave them
 * lopsided. Debounced so a burst of parallel spawns or staggered exits
 * collapses into one pass, and non-fatal: a cosmetic resize must never break
 * spawning or watching.
 */
function rebalanceWindow(windowId: string | null | undefined): void {
  if (!windowId) return;
  pendingRebalance.add(windowId);
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    const windows = [...pendingRebalance];
    pendingRebalance.clear();
    try {
      const view = readSessionView();
      for (const id of windows) {
        for (const step of planEvenSplits(findLayoutOfWindow(view, id))) {
          rexApi("session.resize_pane", {
            direction: step.direction,
            before_block_id: step.beforeBlock,
            after_block_id: step.afterBlock,
            ratio: step.ratio,
          });
        }
      }
    } catch {
      // Window may be gone; balancing is best-effort.
    }
  }, 120);
  rebalanceTimer.unref?.();
}

function windowOf(block: string): string | null {
  try {
    return findWindowOfBlock(readSessionView(), block)?.windowId ?? null;
  } catch {
    return null;
  }
}

// ── Surface handles ──

/**
 * A surface handed out by createSurface whose block does not exist yet. It
 * becomes a block when sendLongCommand starts it on the launch script, or
 * when something types into it first (it then starts as a plain shell).
 */
interface PendingSurface {
  name: string;
  kind: "tab" | "pane";
  anchor?: string;
  direction: SplitDirection;
  cwd: string;
}

const pending = new Map<string, PendingSurface>();
/** Handles that have been started, mapped to their block ids. */
const launched = new Map<string, string>();
/** Blocks started directly on a launch script (no interactive shell around it). */
const directLaunch = new Set<string>();

export function isPendingSurface(surface: string): boolean {
  return pending.has(surface);
}

/** A handle that cannot be mistaken for a block id. */
export function surfaceHandle(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `rex-surface:${slug || "subagent"}-${randomBytes(4).toString("hex")}`;
}

/** The block behind a surface, starting a pending one as a shell if needed. */
function resolveBlock(surface: string): string {
  const block = launched.get(surface);
  if (block) return block;
  if (pending.has(surface)) return startPending(surface);
  return surface;
}

/**
 * The block id behind a surface handle. A reservation that has not started
 * yet starts now, as a plain shell.
 */
export function surfaceBlock(surface: string): string {
  return resolveBlock(surface);
}

/** The `rex` arguments that create a subagent block. Exported for tests. */
export function createArgs(options: {
  session: string;
  kind: "tab" | "pane";
  label: string;
  cwd: string;
  anchor?: string;
  direction?: SplitDirection;
  focus?: boolean;
  argv?: string[];
}): string[] {
  const focus = options.focus ? "--focus=true" : "--focus=false";
  const args =
    options.kind === "tab"
      ? ["window", "new", "-s", options.session, options.label]
      : [
          "split",
          "-s",
          options.session,
          ...(options.anchor ? ["-b", options.anchor] : []),
          "--split",
          rexSplitDirection(options.direction ?? "right"),
          "--label",
          options.label,
        ];
  args.push(focus, "--keep-open", "-c", options.cwd, "--json");
  if (options.argv?.length) args.push("--", ...options.argv);
  return args;
}

function createBlock(options: {
  kind: "tab" | "pane";
  name: string;
  cwd: string;
  anchor?: string;
  direction?: SplitDirection;
  focus?: boolean;
  argv?: string[];
}): { block: string; windowId: string | null } {
  requireRex();
  const label = options.name.trim() || "subagent";
  const result = parseJson(rex(createArgs({ ...options, label, session: rexSession() })));
  const block = result?.block_ids?.[0];
  if (typeof block !== "string" || block.trim() === "") {
    throw new Error(`Unexpected rex output while creating a block: ${JSON.stringify(result)}`);
  }

  // `window new LABEL` names the tab; give its block the same label.
  if (options.kind === "tab") labelSurface(block, label);

  const windowId =
    typeof result?.window_id === "string" ? result.window_id : windowOf(block);
  if (options.kind === "pane") rebalanceWindow(windowId);
  return { block, windowId };
}

function startPending(surface: string, argv?: string[]): string {
  const spec = pending.get(surface);
  if (!spec) throw new Error(`No pending subagent surface "${surface}"`);
  pending.delete(surface);
  const { block } = createBlock({ ...spec, argv });
  launched.set(surface, block);
  if (argv) directLaunch.add(block);
  return block;
}

// ── Surface primitives ──

/**
 * Reserve the surface a subagent runs in and return its handle. The block is
 * created when the launch script is ready (see sendLongCommand).
 *
 * The main session opens a new window per subagent. A subagent spawning its
 * own children splits its block instead, which keeps a whole lineage inside
 * one tab, with the direction taken from the parent block's shape (see
 * SUBAGENT_SPLIT_DIRECTION).
 */
export function createSurface(name: string): string {
  requireRex();
  const kind = chooseSurfaceKind();
  const anchor = process.env.REX_BLOCK?.trim() || undefined;
  const direction =
    kind === "pane" ? chooseSplitDirection(anchor ? readSize(anchor) : undefined) : "right";
  const handle = surfaceHandle(name);
  pending.set(handle, { name, kind, anchor, direction, cwd: process.cwd() });
  return handle;
}

/**
 * Create a new split running a shell, in the given direction from an optional
 * source block (default: this pi's block). Does not take focus unless
 * `options.focus` is set. Returns the new block id.
 */
export function createSurfaceSplit(
  name: string,
  direction: SplitDirection,
  fromSurface?: string,
  options?: { focus?: boolean; cwd?: string },
): string {
  const anchor = fromSurface
    ? resolveBlock(fromSurface)
    : process.env.REX_BLOCK?.trim() || undefined;
  return createBlock({
    kind: "pane",
    name,
    cwd: options?.cwd ?? process.cwd(),
    anchor,
    direction,
    focus: options?.focus,
  }).block;
}

/**
 * Create a new window running a shell, labelled `name`. Does not take focus
 * unless `options.focus` is set. Returns its block id.
 */
export function createSurfaceTab(name: string, options?: { focus?: boolean; cwd?: string }): string {
  return createBlock({
    kind: "tab",
    name,
    cwd: options?.cwd ?? process.cwd(),
    focus: options?.focus,
  }).block;
}

/** Label a block. Cosmetic and best-effort. */
export function labelSurface(surface: string, label: string): void {
  const trimmed = label.trim();
  if (!trimmed) return;
  try {
    rex(["block", "rename", "-s", rexSession(), resolveBlock(surface), trimmed]);
  } catch {
    // A missing label must never break spawning.
  }
}

/** The window (tab) a block lives in, or null when it can't be read. */
export function getSurfaceTab(surface: string): string | null {
  try {
    const info = parseJson(
      rex(["block", "inspect", "-s", rexSession(), resolveBlock(surface), "--json"]),
    );
    const window = info?.block?.window_id;
    return typeof window === "string" && window.trim() !== "" ? window : null;
  } catch {
    return null;
  }
}

/** The block focused in the session's active window, or null when unreadable. */
export function getFocusedSurface(): string | null {
  try {
    const view = readSessionView();
    const active = (view?.windows ?? []).find((w: any) => w?.window_id === view?.active_window_id);
    return typeof active?.focused_block_id === "string" ? active.focused_block_id : null;
  } catch {
    return null;
  }
}

/**
 * Type a command into a block and press Enter. `rex send` enters the text
 * literally, so special characters are never interpreted as keys.
 */
export function sendCommand(surface: string, command: string): void {
  requireRex();
  const block = resolveBlock(surface);
  rex(["send", "-s", rexSession(), "-b", block, "--", command]);
  rex(["send-key", "-s", rexSession(), "-b", block, "enter"]);
}

export interface ProgramStatusRecord {
  id?: string;
  state?: string;
  kind?: string;
  app?: string;
  effective_app?: string;
  msg?: string;
  updated_at?: string;
}

/**
 * Programs whose status report vouches for the agent in a block. `pi` reports
 * natively; Claude Code reports `claude-code` when Rex's hook is installed.
 */
const STEERABLE_APPS = new Set(["pi", "claude-code"]);

const STATUS_HINT =
  "Check the child's PI_PROGRAM_STATUS (0 disables reports), let it finish starting up, " +
  "and verify OSC 7501 reaches the terminal. Otherwise interact with the child in its pane; no input was sent.";

/**
 * Decide from a block's OSC 7501 records whether a message can be delivered.
 * A blocked or failed agent refuses it, and so does the absence of a current
 * record from a known agent. Records another program attributes to itself
 * don't speak for the agent, so they neither block nor approve it.
 */
export function checkSteeringSafety(records: unknown): { ok: true } | { ok: false; error: string } {
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, error: `no program status is available. ${STATUS_HINT}` };
  }
  const appOf = (record: ProgramStatusRecord) => record?.effective_app ?? record?.app;
  const speaksForAgent = (record: ProgramStatusRecord) => {
    const app = appOf(record);
    return !app || STEERABLE_APPS.has(app);
  };

  for (const record of records as ProgramStatusRecord[]) {
    if (!record || !speaksForAgent(record)) continue;
    const detail = record.msg ? `: ${record.msg}` : "";
    if (record.state === "blocked") {
      const kind = record.kind ? `${record.kind} ` : "";
      return { ok: false, error: `agent_blocked: the subagent is waiting on a ${kind}dialog${detail}` };
    }
    if (record.state === "error") {
      return { ok: false, error: `the subagent reports an error state${detail}` };
    }
  }

  const healthy = (records as ProgramStatusRecord[]).some((record) => {
    const app = record ? appOf(record) : undefined;
    return (
      !!app &&
      STEERABLE_APPS.has(app) &&
      (record.state === "working" || record.state === "idle" || record.state === "done")
    );
  });
  return healthy
    ? { ok: true }
    : { ok: false, error: `no current status confirms an agent is running. ${STATUS_HINT}` };
}

/**
 * Deliver a message to the agent running in a block: a paste event, so the
 * child sees one bracketed paste rather than keystrokes, then Enter. Refused
 * unless the child's OSC 7501 status confirms it is safe (see
 * checkSteeringSafety), so it never types over a dialog or into an unknown
 * program. Nothing is sent when it throws.
 */
export function sendMessage(surface: string, message: string): void {
  requireRex();
  if (pending.has(surface)) {
    throw new Error(`Cannot deliver message: surface "${surface}" has not started yet.`);
  }
  const block = launched.get(surface) ?? surface;

  let records: unknown;
  try {
    records = blockCall(block, "program_status", REX_QUERY_TIMEOUT_MS)?.records;
  } catch (error: any) {
    throw new Error(
      `Cannot deliver message: unable to read program status (${error?.message ?? String(error)}). ${STATUS_HINT}`,
    );
  }
  const safety = checkSteeringSafety(records);
  if (!safety.ok) throw new Error(`Cannot deliver message: ${safety.error}`);

  rexApi("block.event", { block_id: block, event: { type: "paste", payload: { text: message } } });
  rex(["send-key", "-s", rexSession(), "-b", block, "enter"]);
}

/**
 * Write a long command to a script file and run it in a surface. A pending
 * surface starts directly on the script; an existing block gets
 * `bash <script>` typed into its shell. Writing a script avoids line-wrapping
 * and quoting trouble with long commands.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });

  if (pending.has(surface)) {
    startPending(surface, ["bash", scriptPath]);
    return scriptPath;
  }

  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/** The last `lines` lines of captured text, without trailing blank lines. */
export function lastLines(text: string, lines: number): string {
  const all = text.replace(/\s+$/, "").split("\n");
  return all.slice(-Math.max(1, lines)).join("\n") + "\n";
}

function captureArgs(block: string): string[] {
  return ["capture", "-s", rexSession(), "-b", block, "--trim", "--unwrap"];
}

/** Read the last `lines` lines of a block's screen and scrollback (sync). */
export function readScreen(surface: string, lines = 50): string {
  requireRex();
  return lastLines(rex(captureArgs(resolveBlock(surface))), lines);
}

/** Read the last `lines` lines of a block's screen and scrollback (async). */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireRex();
  const block = launched.get(surface) ?? surface;
  if (pending.has(surface)) return "";
  return lastLines(await rexAsync(captureArgs(block)), lines);
}

/** Close a surface's block (or drop a reservation that never started). */
export function closeSurface(surface: string): void {
  if (pending.delete(surface)) return;
  requireRex();
  const block = launched.get(surface) ?? surface;
  launched.delete(surface);
  directLaunch.delete(block);
  const windowId = windowOf(block);
  try {
    rex(["block", "close", "-s", rexSession(), block]);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  rebalanceWindow(windowId);
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error" | "interrupted";
  /** The process's exit code. 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected from the block's exit instead. An unrecognized
 * payload is reported as a failure rather than a success.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  if (data?.type === "done") return { reason: "done", exitCode: 0 };
  return {
    reason: "error",
    exitCode: 1,
    errorMessage: `Unrecognized subagent exit sidecar payload: ${JSON.stringify(data)}`,
  };
}

/** Repeated failures to observe a block, as opposed to the subagent failing. */
export class RexInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RexInfrastructureError";
  }
}

export function isRexInfrastructureError(error: unknown): boolean {
  return error instanceof RexInfrastructureError;
}

/** Consecutive failed observations before pollForExit gives up. */
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 10;

/**
 * Whether a block's program has ended, from `block call process`. Rex reports
 * `last_exit: null` while the program runs and `{exit_code}` once it ended;
 * a block kept open with `--keep-open` keeps that record until closed.
 */
export function exitStateOf(
  record: any,
): { finished: false } | { finished: true; exitCode: number } {
  const last = record?.last_exit;
  if (last === null) return { finished: false };
  if (!last || typeof last !== "object" || typeof last.exit_code !== "number") {
    throw new Error(`Malformed Rex process record: ${JSON.stringify(record)}`);
  }
  return { finished: true, exitCode: last.exit_code >= 0 ? last.exit_code : 1 };
}

const SENTINEL = /__SUBAGENT_DONE_(\d+)__/;

export const __pollForExitTest__ = { interpretExitSidecar };
export const __layoutTest__ = {
  planEvenSplits,
  chooseSplitDirection,
  chooseSurfaceKind,
  findWindowOfBlock,
};

function readExitSidecar(sessionFile: string | undefined): PollResult | null {
  if (!sessionFile) return null;
  try {
    const exitFile = `${sessionFile}.exit`;
    if (existsSync(exitFile)) {
      const data = JSON.parse(readFileSync(exitFile, "utf-8"));
      rmSync(exitFile, { force: true });
      return interpretExitSidecar(data);
    }
  } catch {}
  return null;
}

/**
 * Poll until the subagent exits, from the block's process record. An `.exit`
 * sidecar (the error path) supplies the failure message, but the run ends only
 * once the process has too, keeping a non-zero exit code. The Claude sentinel
 * returns straight away, because Claude stays open after its Stop hook.
 *
 * A block that disappears ends the run as `interrupted`. Repeated failures to
 * observe it throw RexInfrastructureError instead of polling forever; the
 * process may still be running then.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
    maxConsecutiveErrors?: number;
  },
): Promise<PollResult> {
  const start = Date.now();
  const maxErrors = options.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;
  let consecutiveErrors = 0;
  let sidecar: PollResult | null = null;

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    sidecar ??= readExitSidecar(options.sessionFile);

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    if (pending.has(surface)) {
      return {
        reason: "interrupted",
        exitCode: 1,
        errorMessage: "The subagent's Rex pane was never started.",
      };
    }

    const block = launched.get(surface) ?? surface;
    try {
      const state = exitStateOf(await blockCallAsync(block, "process"));
      consecutiveErrors = 0;
      if (state.finished) {
        sidecar ??= readExitSidecar(options.sessionFile);
        if (sidecar) {
          return state.exitCode !== 0 ? { ...sidecar, exitCode: state.exitCode } : sidecar;
        }
        return { reason: state.exitCode === 0 ? "done" : "error", exitCode: state.exitCode };
      }
      // A script typed into an interactive shell ends without ending the
      // shell, so only the screen sentinel tells.
      if (!directLaunch.has(block)) {
        const match = (await readScreenAsync(surface, 5)).match(SENTINEL);
        if (match) return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch (error: any) {
      if (isNotFoundError(error)) {
        return (
          sidecar ??
          readExitSidecar(options.sessionFile) ?? {
            reason: "interrupted",
            exitCode: 1,
            errorMessage: "The subagent's Rex pane was closed before the subagent finished.",
          }
        );
      }
      consecutiveErrors++;
      if (consecutiveErrors >= maxErrors) {
        throw new RexInfrastructureError(
          `Lost contact with Rex while watching block ${block} ` +
            `(${consecutiveErrors} failed checks): ${error?.message ?? String(error)}`,
        );
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
