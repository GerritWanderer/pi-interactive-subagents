/**
 * Rex surface layer for pi-interactive-subagents.
 *
 * Provides primitives to create named Rex windows/splits, launch subagent
 * commands, deliver safe steering paste events, query process state, and
 * close blocks/windows.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability & Context ──

export interface RexContext {
  server?: string;
  session?: string;
  block?: string;
}

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    if (process.platform === "win32") {
      execFileSync("where.exe", [command], { stdio: "ignore" });
    } else {
      execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    }
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

export function rexBin(): string {
  return process.env.REX_BIN_PATH || (process.env.REX_BIN_DIR ? join(process.env.REX_BIN_DIR, "rex") : "rex");
}

export function getRexContext(): RexContext {
  return {
    server: process.env.REX_SERVER?.trim() || undefined,
    session: process.env.REX_SESSION?.trim() || undefined,
    block: process.env.REX_BLOCK?.trim() || undefined,
  };
}

export function isMuxAvailable(): boolean {
  if (process.platform === "win32") {
    // Windows native host deferred per spec
    return false;
  }
  const ctx = getRexContext();
  if (!ctx.session || !ctx.block) {
    return false;
  }
  return hasCommand(rexBin());
}

export function isRexAvailable(): boolean {
  if (!isMuxAvailable()) {
    return false;
  }
  const ctx = getRexContext();
  // Validate that the session and anchor block exist
  try {
    const raw = rexExec(["block", "inspect", ctx.block!, "-s", ctx.session!, "--json"]);
    const parsed = JSON.parse(raw);
    if (!parsed || (parsed.error && parsed.error.code)) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
}

export function validateAnchorBlock(blockId: string, session: string): void {
  try {
    const raw = rexExec(["block", "inspect", blockId, "-s", session, "--json"]);
    const parsed = JSON.parse(raw);
    if (!parsed || (parsed.error && parsed.error.code)) {
      throw new Error(`Stale or invalid Rex block: ${blockId}`);
    }
  } catch (error: any) {
    throw new Error(`Target Rex block "${blockId}" does not exist in session "${session}": ${error?.message || String(error)}`);
  }
}

export function muxSetupHint(): string {
  if (process.platform === "win32") {
    return "Rex subagent surfaces are supported on Linux and macOS hosts. Windows native host is deferred.";
  }
  return "Start pi in a Rex terminal session with REX_SESSION and REX_BLOCK set, and ensure `rex` CLI is in PATH.";
}

function requireMux(): void {
  if (!isMuxAvailable()) {
    throw new Error(`Rex terminal environment is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell Quoting & Script Resolution ──

export function needsShellReadyDelay(): boolean {
  return true;
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function resolveBash(): string {
  return "bash";
}

export function sendCommand(surface: string, command: string): void {
  sendMessage(surface, command);
}

// ── CLI & API Execution Helpers ──

export interface RexExecOptions {
  timeoutMs?: number;
}

export function buildRexArgs(subcommandArgs: string[], server?: string): string[] {
  const s = server ?? getRexContext().server;
  if (s) {
    return ["-S", s, ...subcommandArgs];
  }
  return [...subcommandArgs];
}

export function rexExec(args: string[], options?: RexExecOptions): string {
  const fullArgs = buildRexArgs(args);
  try {
    return execFileSync(rexBin(), fullArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options?.timeoutMs ?? 15000,
    });
  } catch (error: any) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const msg = stderr || error?.message || String(error);
    throw new Error(`rex ${args.join(" ")} failed: ${msg}`);
  }
}

export async function rexExecAsync(args: string[], options?: RexExecOptions): Promise<string> {
  const fullArgs = buildRexArgs(args);
  try {
    const { stdout } = await execFileAsync(rexBin(), fullArgs, {
      encoding: "utf8",
      timeout: options?.timeoutMs ?? 15000,
    });
    return stdout;
  } catch (error: any) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const msg = stderr || error?.message || String(error);
    throw new Error(`rex ${args.join(" ")} failed: ${msg}`);
  }
}

export function rexJson(args: string[], options?: RexExecOptions): any {
  const raw = rexExec(args, options).trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function rexJsonAsync(args: string[], options?: RexExecOptions): Promise<any> {
  const raw = (await rexExecAsync(args, options)).trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

// ── Layout & Placement Helpers ──

export type SplitDirectionSetting = "right" | "down" | "auto";
export type TopLevelSurfaceSetting = "tab" | "pane";

export function splitDirectionSetting(): SplitDirectionSetting {
  const raw = process.env.PI_SUBAGENT_SPLIT_DIRECTION?.trim();
  return raw === "right" || raw === "down" || raw === "auto" ? raw : "auto";
}

export function topLevelSurfaceSetting(): TopLevelSurfaceSetting {
  const raw = process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE?.trim();
  return raw === "tab" || raw === "pane" ? raw : "tab";
}

export function isNestedSpawner(): boolean {
  return !!process.env.PI_SUBAGENT_NAME?.trim();
}

export function chooseSurfaceKind(
  nested: boolean = isNestedSpawner(),
  setting: TopLevelSurfaceSetting = topLevelSurfaceSetting(),
): TopLevelSurfaceSetting {
  return !nested && setting === "tab" ? "tab" : "pane";
}

export interface PaneDimensions {
  columns: number;
  rows: number;
}

export function chooseSplitDirection(
  dimensions: PaneDimensions | undefined,
  setting: SplitDirectionSetting = splitDirectionSetting(),
): "right" | "below" {
  if (setting === "right") return "right";
  if (setting === "down") return "below";
  if (!dimensions || dimensions.rows <= 0) return "right";
  // Rex cells are ~2:1 (height:width). If columns / rows >= 2 it's wide -> right, else below.
  return dimensions.columns / dimensions.rows >= 2 ? "right" : "below";
}

export function queryBlockDimensions(blockId: string, session?: string): PaneDimensions | undefined {
  try {
    const ctx = getRexContext();
    const s = session ?? ctx.session;
    const args = ["block", "call", "-b", blockId];
    if (s) args.push("-s", s);
    args.push("size");
    const res = rexJson(args);
    if (typeof res?.columns === "number" && typeof res?.rows === "number") {
      return { columns: res.columns, rows: res.rows };
    }
  } catch {}
  return undefined;
}

// ── Surface Handle & Reservation ──

export interface RexSurfaceHandle {
  id: string; // surface identifier string, e.g. "rex-surface:tab:..." or "rex-surface:split:..."
  kind: "tab" | "split";
  name: string;
  windowId?: string;
  blockId?: string;
  sessionId: string;
  anchorBlockId?: string;
  direction?: "right" | "below";
  status: "reserved" | "launched" | "closed";
}

const activeSurfaces = new Map<string, RexSurfaceHandle>();

export function getSurfaceHandle(surface: string): RexSurfaceHandle | undefined {
  return activeSurfaces.get(surface);
}

export function registerSurfaceHandle(handle: RexSurfaceHandle): void {
  activeSurfaces.set(handle.id, handle);
}

export function unregisterSurfaceHandle(surface: string): void {
  activeSurfaces.delete(surface);
}

// ── Creation & Reservation Primitives ──

/**
 * Creates a surface reservation for the given subagent name.
 * Real Rex resource creation happens when launchSubagent / sendLongCommand prepares the command script,
 * or immediate reservation handle is returned.
 */
export function createSurface(name: string): string {
  requireMux();
  const ctx = getRexContext();
  const sessionId = ctx.session!;
  const parentBlock = ctx.block!;
  validateAnchorBlock(parentBlock, sessionId);
  const kind = chooseSurfaceKind();

  const handleId = `rex-surface:${name}-${Math.random().toString(16).slice(2, 10)}`;

  let direction: "right" | "below" = "right";
  if (kind === "pane") {
    const dims = queryBlockDimensions(parentBlock, sessionId);
    direction = chooseSplitDirection(dims);
  }

  const handle: RexSurfaceHandle = {
    id: handleId,
    kind: kind === "tab" ? "tab" : "split",
    name,
    sessionId,
    anchorBlockId: parentBlock,
    direction,
    status: "reserved",
  };

  registerSurfaceHandle(handle);
  return handleId;
}

export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down" | "below",
  fromSurface?: string,
  options?: { focus?: boolean; cwd?: string },
): string {
  requireMux();
  const ctx = getRexContext();
  const sessionId = ctx.session!;
  const anchorBlock = fromSurface ?? ctx.block!;
  validateAnchorBlock(anchorBlock, sessionId);

  const dir: "right" | "below" =
    direction === "below" || direction === "down" ? "below" : "right";

  const handleId = `rex-surface:${name}-${Math.random().toString(16).slice(2, 10)}`;
  const handle: RexSurfaceHandle = {
    id: handleId,
    kind: "split",
    name,
    sessionId,
    anchorBlockId: anchorBlock,
    direction: dir,
    status: "reserved",
  };

  registerSurfaceHandle(handle);
  return handleId;
}

// ── Command Launch ──

export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string; cwd?: string },
): string {
  requireMux();
  const handle = getSurfaceHandle(surface);
  if (!handle) {
    throw new Error(`Unknown surface handle: ${surface}`);
  }

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

  try {
    launchRexSurface(handle, scriptPath, options?.cwd);
  } catch (err) {
    // Release reservation on failure
    closeSurface(surface);
    throw err;
  }

  return scriptPath;
}

function launchRexSurface(handle: RexSurfaceHandle, scriptPath: string, cwd?: string): void {
  const sessionId = handle.sessionId;
  const label = handle.name;

  if (handle.kind === "tab") {
    // rex window new [-s SESSION] [LABEL] [-- COMMAND...] --focus=false --keep-open --json
    const args = ["window", "new", "-s", sessionId, label, "--focus=false", "--keep-open", "--json"];
    if (cwd) {
      args.push("-c", cwd);
    }
    args.push("--", "bash", "-l", scriptPath);

    const res = rexJson(args);
    const windowId = res?.window_id;
    const blockIds = res?.block_ids;
    if (!windowId || !Array.isArray(blockIds) || blockIds.length === 0) {
      throw new Error(`Failed to create Rex window for subagent: unexpected output ${JSON.stringify(res)}`);
    }

    handle.windowId = windowId;
    handle.blockId = blockIds[0];
    handle.status = "launched";
  } else {
    // rex split -s SESSION -b ANCHOR --split=DIRECTION --label=LABEL --focus=false --keep-open --json -- COMMAND...
    const anchor = handle.anchorBlockId;
    if (!anchor) {
      throw new Error(`Cannot split without an anchor block for surface ${handle.id}`);
    }

    const args = [
      "split",
      "-s", sessionId,
      "-b", anchor,
      `--split=${handle.direction ?? "right"}`,
      "--label", label,
      "--focus=false",
      "--keep-open",
      "--json",
    ];
    if (cwd) {
      args.push("-c", cwd);
    }
    args.push("--", "bash", "-l", scriptPath);

    const res = rexJson(args);
    const blockIds = res?.block_ids;
    if (!Array.isArray(blockIds) || blockIds.length === 0) {
      throw new Error(`Failed to split Rex block for subagent: unexpected output ${JSON.stringify(res)}`);
    }

    handle.blockId = blockIds[0];
    handle.status = "launched";
  }
}

// ── Steering & Message Input ──

export interface ProgramStatusRecord {
  id?: string;
  state: string; // 'idle' | 'working' | 'done' | 'blocked' | 'error'
  kind?: string; // 'permission' | 'question' | 'auth'
  app?: string;
  msg?: string;
  title?: string;
  updated_at: string;
}

export function queryProgramStatus(blockId: string, session: string): ProgramStatusRecord[] {
  try {
    const res = rexJson(["block", "call", "-b", blockId, "-s", session, "program_status"]);
    return Array.isArray(res?.records) ? res.records : [];
  } catch (error: any) {
    throw new Error(`Failed to query program status: ${error?.message || String(error)}`);
  }
}

export function isBlockedDialog(records: ProgramStatusRecord[]): boolean {
  return records.some((r) => r.state === "blocked" && (r.kind === "permission" || r.kind === "question" || r.kind === "auth"));
}

export function sendPasteEvent(blockId: string, session: string, text: string): void {
  const payload = JSON.stringify({
    session_id: session,
    block_id: blockId,
    event: {
      type: "paste",
      payload: {
        text,
      },
    },
  });

  const res = rexJson(["api", "call", "block.event", payload]);
  if (res && res.error) {
    throw new Error(`block.event paste error: ${res.error.message || JSON.stringify(res.error)}`);
  }
}

export function sendEnterKeyEvent(blockId: string, session: string): void {
  const payload = JSON.stringify({
    session_id: session,
    block_id: blockId,
    event: {
      type: "key",
      payload: {
        action: "press",
        key: "enter",
        mods: "",
        consumed_mods: "",
        text: "\r",
        unshifted_codepoint: 13,
        composing: false,
      },
    },
  });

  const res = rexJson(["api", "call", "block.event", payload]);
  if (res && res.error) {
    throw new Error(`block.event enter key error: ${res.error.message || JSON.stringify(res.error)}`);
  }
}

export function validateTrustworthyProgramStatus(
  records: ProgramStatusRecord[],
  expectedApp?: string,
): { ok: true; targetRecord: ProgramStatusRecord } | { ok: false; error: string } {
  if (!Array.isArray(records) || records.length === 0) {
    return {
      ok: false,
      error: "No program status records available; cannot verify safety before steering.",
    };
  }

  // Find relevant target record: if expectedApp is given, look for matching app / effective_app, or root record
  const matching = records.filter((r) => {
    if (!r || typeof r.state !== "string" || !r.updated_at) return false;
    if (expectedApp) {
      return (r as any).effective_app === expectedApp || r.app === expectedApp;
    }
    return true;
  });

  if (matching.length === 0) {
    return {
      ok: false,
      error: `No trustworthy program status found matching application ${expectedApp ?? "target"}.`,
    };
  }

  // Check if any matching record is blocked on dialog or in error state
  const problematic = matching.find(
    (r) => r.state === "blocked" || r.state === "error",
  );

  if (problematic) {
    if (problematic.state === "blocked") {
      return {
        ok: false,
        error: `Subagent is blocked on a ${problematic.kind ?? "dialog"} dialog (${problematic.msg || problematic.state}). Steering refused.`,
      };
    }
    return {
      ok: false,
      error: `Subagent is in an error state (${problematic.msg || problematic.state}). Steering refused.`,
    };
  }

  return { ok: true, targetRecord: matching[0] };
}

export function sendMessage(surface: string, message: string): void {
  requireMux();
  const handle = getSurfaceHandle(surface);
  if (!handle || !handle.blockId) {
    throw new Error(`Surface ${surface} is not currently running a Rex block`);
  }

  // Safety check: query program status
  let records: ProgramStatusRecord[];
  try {
    records = queryProgramStatus(handle.blockId, handle.sessionId);
  } catch (error: any) {
    throw new Error(`Cannot deliver message safely: unable to query program status (${error?.message})`);
  }

  const safety = validateTrustworthyProgramStatus(records, "pi");
  if (!safety.ok) {
    throw new Error(`Cannot deliver message safely: ${safety.error}`);
  }

  // 1. Paste normalized text without trailing newline
  const normalizedText = message.trimEnd();
  sendPasteEvent(handle.blockId, handle.sessionId, normalizedText);

  // 2. Send separate targeted Enter/Return key submission event
  sendEnterKeyEvent(handle.blockId, handle.sessionId);
}

// ── Screen Capture & Observation Primitives ──

export function readScreen(surface: string, lines = 50): string {
  requireMux();
  const handle = getSurfaceHandle(surface);
  if (!handle || !handle.blockId) {
    return "";
  }
  try {
    const stdout = rexExec(["capture", "-b", handle.blockId, "-s", handle.sessionId, "--trim", "--unwrap"]);
    const allLines = stdout.split("\n");
    return allLines.slice(-Math.max(1, lines)).join("\n");
  } catch (error: any) {
    throw new Error(`rex capture failed: ${error?.message || String(error)}`);
  }
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireMux();
  const handle = getSurfaceHandle(surface);
  if (!handle || !handle.blockId) {
    return "";
  }
  try {
    const stdout = await rexExecAsync(["capture", "-b", handle.blockId, "-s", handle.sessionId, "--trim", "--unwrap"]);
    const allLines = stdout.split("\n");
    return allLines.slice(-Math.max(1, lines)).join("\n");
  } catch (error: any) {
    throw new Error(`rex capture failed: ${error?.message || String(error)}`);
  }
}

export function getSurfaceTab(surface: string): string | null {
  const handle = getSurfaceHandle(surface);
  if (handle?.windowId) return handle.windowId;
  if (!handle?.blockId) return null;

  try {
    const raw = rexExec(["block", "inspect", "-s", handle.sessionId, handle.blockId, "--json"]);
    const parsed = JSON.parse(raw);
    const windowId = parsed?.block?.window_id || parsed?.window || parsed?.window_id || null;
    if (windowId && !handle.windowId) {
      handle.windowId = windowId;
    }
    return windowId;
  } catch {
    return null;
  }
}

export function getFocusedSurface(fromSurface?: string): string | null {
  try {
    const ctx = getRexContext();
    const session = ctx.session;
    if (!session) return null;
    const raw = rexExec(["session", "inspect", session, "--json"]);
    const parsed = JSON.parse(raw);
    const activeWindowId = parsed?.active_window_id;
    const window = parsed?.windows?.find((w: any) => w.window_id === activeWindowId);
    return window?.focused_block_id || null;
  } catch {
    return null;
  }
}

// ── Close & Cleanup ──

export function closeSurface(surface: string): void {
  const handle = getSurfaceHandle(surface);
  if (!handle) return;

  try {
    if (handle.kind === "tab" && handle.windowId) {
      // Check if other blocks still exist in this window before closing the whole window
      let windowHasOtherBlocks = false;
      try {
        const raw = rexExec(["window", "inspect", "-s", handle.sessionId, handle.windowId, "--json"]);
        const win = JSON.parse(raw);
        const layers = Array.isArray(win?.layers) ? win.layers : [];
        const blocks = layers.flatMap((l: any) => (Array.isArray(l?.blocks) ? l.blocks : []));
        if (blocks.length > 1) {
          windowHasOtherBlocks = true;
        }
      } catch {}

      if (windowHasOtherBlocks && handle.blockId) {
        rexExec(["block", "close", "-s", handle.sessionId, handle.blockId]);
      } else {
        rexExec(["window", "close", "-s", handle.sessionId, handle.windowId]);
      }
    } else if (handle.blockId) {
      rexExec(["block", "close", "-s", handle.sessionId, handle.blockId]);
    }
  } catch {
    // Already gone or cannot close; idempotent cleanup
  } finally {
    handle.status = "closed";
    unregisterSurfaceHandle(surface);
  }
}

// ── Exit Polling & Process State ──

export interface PollResult {
  reason: "done" | "sentinel" | "error" | "interrupted";
  exitCode: number;
  errorMessage?: string;
}

export interface RexProcessOutput {
  last_exit: { exit_code: number; error?: string } | null;
  child?: { pid: number; name: string };
}

export function queryBlockProcess(blockId: string, session: string): RexProcessOutput | "not_found" {
  try {
    const res = rexJson(["block", "call", "-b", blockId, "-s", session, "process"]);
    return res as RexProcessOutput;
  } catch (error: any) {
    const msg = error?.message || String(error);
    if (/not found/i.test(msg)) {
      return "not_found";
    }
    throw error;
  }
}

function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const handle = getSurfaceHandle(surface);
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // 1. Check sidecar .exit file
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // 2. Check sentinel file (e.g. Claude)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // 3. Query Rex block process
    if (handle?.blockId) {
      try {
        const proc = queryBlockProcess(handle.blockId, handle.sessionId);
        if (proc === "not_found") {
          return {
            reason: "interrupted",
            exitCode: 1,
            errorMessage: "Subagent Rex pane was closed externally before completion.",
          };
        }
        if (proc.last_exit !== null && proc.last_exit !== undefined) {
          const code = proc.last_exit.exit_code;
          return {
            reason: code === 0 ? "done" : "error",
            exitCode: code,
            ...(proc.last_exit.error ? { errorMessage: proc.last_exit.error } : {}),
          };
        }
      } catch (err: any) {
        // Transient error or process query failed
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

export const __rexTest__ = {
  buildRexArgs,
  chooseSplitDirection,
  chooseSurfaceKind,
  interpretExitSidecar,
  isBlockedDialog,
  validateTrustworthyProgramStatus,
  validateAnchorBlock,
};
