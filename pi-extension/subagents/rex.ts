/**
 * Rex surface layer for pi-interactive-subagents.
 *
 * Provides primitives to create named Rex windows/splits, launch subagent
 * commands, deliver safe steering paste events, query process state, and
 * close blocks/windows.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { planEqualShares } from "./rex-sizing.ts";

const execFileAsync = promisify(execFile);

// ── Availability & Context ──

export interface RexContext {
  server?: string;
  session?: string;
  block?: string;
}

const commandAvailability = new Map<string, boolean>();
let commandAvailabilityOverride: boolean | null | undefined = undefined;

export function setCommandAvailabilityOverride(override: boolean | null | undefined): void {
  commandAvailabilityOverride = override;
}

function hasCommand(command: string): boolean {
  if (commandAvailabilityOverride !== undefined && commandAvailabilityOverride !== null) {
    return commandAvailabilityOverride;
  }
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    // If command contains path separators, check executable access directly without shell interpolation
    if (command.includes("/")) {
      accessSync(command, constants.X_OK);
      available = true;
    } else {
      execFileSync("sh", ["-c", 'command -v "$1"', "_", command], { stdio: "ignore" });
      available = true;
    }
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

export function rexBin(): string {
  return process.env.REX_BIN_PATH || (process.env.REX_BIN_DIR ? join(process.env.REX_BIN_DIR, "rex") : "rex");
}

let customContextOverride: RexContext | null | undefined = undefined;

export function setRexContextOverride(ctx: RexContext | null | undefined): void {
  customContextOverride = ctx;
}

export function getRexContext(): RexContext {
  if (customContextOverride !== undefined && customContextOverride !== null) {
    return customContextOverride;
  }
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
  signal?: AbortSignal;
  // null explicitly selects the local server, rather than a later environment value.
  server?: string | null;
}

export type RexExecutor = (args: string[], options?: RexExecOptions) => string;

let customExecutor: RexExecutor | null = null;

export function setRexExecutor(fn: RexExecutor | null): void {
  customExecutor = fn;
}

export function buildRexArgs(subcommandArgs: string[], server?: string | null): string[] {
  const s = server === undefined ? getRexContext().server : server;
  if (s) {
    return ["-S", s, ...subcommandArgs];
  }
  return [...subcommandArgs];
}

export function rexExec(args: string[], options?: RexExecOptions): string {
  if (customExecutor) {
    return customExecutor(args, options);
  }
  const fullArgs = buildRexArgs(args, options?.server);
  try {
    return execFileSync(rexBin(), fullArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options?.timeoutMs ?? 15000,
    });
  } catch (error: any) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
    const msg = stderr || error?.message || String(error);
    const err = new Error(`rex ${args.join(" ")} failed: ${msg}`);
    (err as any).stdout = stdout;
    (err as any).stderr = stderr;
    throw err;
  }
}

export async function rexExecAsync(args: string[], options?: RexExecOptions): Promise<string> {
  if (options?.signal?.aborted) throw new Error("Rex request aborted");
  if (customExecutor) return customExecutor(args, options);
  const fullArgs = buildRexArgs(args, options?.server);
  try {
    const { stdout } = await execFileAsync(rexBin(), fullArgs, {
      encoding: "utf8",
      timeout: options?.timeoutMs ?? 15000,
      signal: options?.signal,
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

// ── Tab-local Cosmetic Sizing ──

export const SIZING_DEBOUNCE_MS = 100;
interface SizingPass {
  timer?: ReturnType<typeof setTimeout>;
  controller: AbortController;
}
const sizingPasses = new Map<string, SizingPass>();

/** A fresh snapshot is read after each burst; no active-window or focus fallback. */
export function scheduleTabSizing(session: string, windowId: string): void {
  const server = getRexContext().server ?? null;
  const key = JSON.stringify([server, session, windowId]);
  const prior = sizingPasses.get(key);
  if (prior?.timer) clearTimeout(prior.timer);
  prior?.controller.abort();
  const pass: SizingPass = { controller: new AbortController() };
  sizingPasses.set(key, pass);
  pass.timer = setTimeout(async () => {
    pass.timer = undefined;
    const options: RexExecOptions = { server, signal: pass.controller.signal, timeoutMs: 3000 };
    try {
      const view = await rexJsonAsync(["session", "inspect", session, "--json"], options);
      if (pass.controller.signal.aborted) return;
      const window = view?.windows?.find((w: any) => w.window_id === windowId);
      const tiled = window?.layers?.find((l: any) => l.kind === "tiled");
      for (const step of planEqualShares(tiled?.layout)) {
        if (pass.controller.signal.aborted) return;
        await rexJsonAsync(["api", "call", "session.resize_pane", JSON.stringify({
          session_id: session, ...step,
        })], options);
      }
    } catch {
      // A stale layout, vanished tab, or failed border adjustment is cosmetic.
      // Abandon this pass; the next creation/removal reads a fresh layout.
    } finally {
      if (sizingPasses.get(key) === pass) sizingPasses.delete(key);
    }
  }, SIZING_DEBOUNCE_MS);
  pass.timer.unref();
}

/** Does not terminate live agents, including runs whose observation was lost. */
export function disposeRexSurfaces(): void {
  for (const pass of sizingPasses.values()) {
    if (pass.timer) clearTimeout(pass.timer);
    pass.controller.abort();
  }
  sizingPasses.clear();
  for (const [id, handle] of activeSurfaces) {
    if (handle.status === "reserved") activeSurfaces.delete(id);
  }
}

// Reload can replace this module without the previous closures disappearing.
const DISPOSE_KEY = Symbol.for("pi-subagents/rex-dispose");
(globalThis as any)[DISPOSE_KEY]?.();
(globalThis as any)[DISPOSE_KEY] = disposeRexSurfaces;

// ── Surface Handle & Reservation ──

export interface RexSurfaceHandle {
  id: string; // surface identifier string, e.g. "rex-surface:tab:..." or "rex-surface:split:..."
  kind: "tab" | "split";
  name: string;
  windowId?: string;
  /** Pre-close refresh result, retained across close retries (null means unavailable). */
  closingWindowId?: string | null;
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
  let sessionId = ctx.session!;
  let resolvedAnchor: string;

  if (fromSurface) {
    if (fromSurface.startsWith("rex-surface:") || getSurfaceHandle(fromSurface)) {
      const parentHandle = getSurfaceHandle(fromSurface);
      if (!parentHandle) {
        throw new Error(`Target surface handle "${fromSurface}" not found`);
      }
      if (!parentHandle.blockId) {
        throw new Error(`Target surface "${fromSurface}" has not been launched yet; no block ID available to split`);
      }
      resolvedAnchor = parentHandle.blockId;
      sessionId = parentHandle.sessionId;
    } else {
      resolvedAnchor = fromSurface;
    }
  } else {
    resolvedAnchor = ctx.block!;
  }

  validateAnchorBlock(resolvedAnchor, sessionId);

  const dir: "right" | "below" =
    direction === "below" || direction === "down" ? "below" : "right";

  const handleId = `rex-surface:${name}-${Math.random().toString(16).slice(2, 10)}`;
  const handle: RexSurfaceHandle = {
    id: handleId,
    kind: "split",
    name,
    sessionId,
    anchorBlockId: resolvedAnchor,
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

  try {
    mkdirSync(dirname(scriptPath), { recursive: true });

    const scriptParts = ["#!/bin/bash"];
    if (options?.scriptPreamble) {
      scriptParts.push(options.scriptPreamble.trimEnd());
    }
    scriptParts.push(command);

    writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
      mode: 0o755,
    });

    launchRexSurface(handle, scriptPath, options?.cwd);
  } catch (err) {
    // Release reservation on failure without masking original error
    try {
      closeSurface(surface);
    } catch {}
    throw err;
  }

  return scriptPath;
}

function extractResourceIdsFromError(err: any): { windowId?: string; blockId?: string } {
  // Inspect err.stdout independently first
  if (typeof err?.stdout === "string" && err.stdout.trim()) {
    try {
      const match = err.stdout.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        const windowId = typeof parsed?.window_id === "string" ? parsed.window_id : undefined;
        const blockId = Array.isArray(parsed?.block_ids) && parsed.block_ids.length > 0 ? parsed.block_ids[0] : undefined;
        if (windowId || blockId) {
          return { windowId, blockId };
        }
      }
    } catch {}
  }

  // Only if stdout yields nothing, inspect err.message
  if (typeof err?.message === "string" && err.message.trim()) {
    try {
      const match = err.message.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        const windowId = typeof parsed?.window_id === "string" ? parsed.window_id : undefined;
        const blockId = Array.isArray(parsed?.block_ids) && parsed.block_ids.length > 0 ? parsed.block_ids[0] : undefined;
        return { windowId, blockId };
      }
    } catch {}
  }

  return {};
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

    let res: any;
    try {
      res = rexJson(args);
    } catch (err: any) {
      const extracted = extractResourceIdsFromError(err);
      if (extracted.windowId) handle.windowId = extracted.windowId;
      if (extracted.blockId) handle.blockId = extracted.blockId;
      throw err;
    }

    const windowId = res?.window_id;
    const blockIds = res?.block_ids;
    if (windowId) handle.windowId = windowId;
    if (Array.isArray(blockIds) && blockIds.length > 0) handle.blockId = blockIds[0];

    if (!windowId || !Array.isArray(blockIds) || blockIds.length === 0) {
      throw new Error(`Failed to create Rex window for subagent: unexpected output ${JSON.stringify(res)}`);
    }

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

    let res: any;
    try {
      res = rexJson(args);
    } catch (err: any) {
      const extracted = extractResourceIdsFromError(err);
      if (extracted.blockId) handle.blockId = extracted.blockId;
      throw err;
    }

    const blockIds = res?.block_ids;
    if (Array.isArray(blockIds) && blockIds.length > 0) handle.blockId = blockIds[0];

    if (!Array.isArray(blockIds) || blockIds.length === 0) {
      throw new Error(`Failed to split Rex block for subagent: unexpected output ${JSON.stringify(res)}`);
    }

    handle.status = "launched";
    // Bound this cosmetic lookup so sizing cannot stall an otherwise successful launch.
    const windowId = getSurfaceTab(handle.id, false, 3000);
    if (windowId) scheduleTabSizing(sessionId, windowId);
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
  expectedApp = "pi",
): { ok: true; targetRecord: ProgramStatusRecord } | { ok: false; error: string } {
  if (!Array.isArray(records) || records.length === 0) {
    return {
      ok: false,
      error: "No program status records available; cannot verify safety before steering.",
    };
  }

  // 1. Check for any blocked dialog (attributed to expectedApp or unattributed), or error attributed to expectedApp or unattributed
  for (const r of records) {
    if (!r) continue;
    const app = (r as any).effective_app ?? r.app;
    if (r.state === "blocked") {
      // Reject blocked records only if attributed to expectedApp or unattributed.
      // If a blocked record is explicitly attributed to another application (app !== expectedApp),
      // do not let it block a healthy expectedApp process.
      if (!app || app === expectedApp) {
        const dialogKind = r.kind ? `${r.kind} ` : "";
        return {
          ok: false,
          error: `Subagent is blocked on a ${dialogKind}dialog (${r.msg || r.state}). Steering refused.`,
        };
      }
    }
    if (r.state === "error") {
      // Refuse steering if the error is attributed to expectedApp or unattributed.
      // If specifically attributed to another app, do not block unless expectedApp itself has no healthy status.
      if (!app || app === expectedApp) {
        return {
          ok: false,
          error: `Subagent is in an error state (${r.msg || r.state}). Steering refused.`,
        };
      }
    }
  }

  // 2. Positively verify that a valid, non-blocked target record (e.g. pi) exists
  const validTarget = records.find((r) => {
    if (!r || typeof r.state !== "string" || !r.updated_at) return false;
    const app = (r as any).effective_app ?? r.app;
    return app === expectedApp && (r.state === "working" || r.state === "idle" || r.state === "done");
  });

  if (!validTarget) {
    return {
      ok: false,
      error: `No trustworthy program status found confirming ${expectedApp} is running. Steering refused.`,
    };
  }

  return { ok: true, targetRecord: validTarget };
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

// Never let fallback diagnostics download the CLI's entire (up to 64 MiB)
// scrollback. Public format/blob_read cap each reply; at most two reads are used.
export const DIAGNOSTIC_MAX_BYTES = 64 * 1024;
const diagnosticOptions: RexExecOptions = { timeoutMs: 3000 };
function diagnosticArgs(handle: RexSurfaceHandle, method: string, args: object): string[] {
  return ["block", "call", "-b", handle.blockId!, "-s", handle.sessionId, method, JSON.stringify(args)];
}
function tailRequest(result: any): object | undefined {
  if (!Number.isInteger(result?.id) || !Number.isSafeInteger(result?.total) || result.total <= 0) return;
  // max_bytes counts JSON-encoded bytes. Read up to 32 KiB of tail text,
  // reserving half the 64 KiB reply budget for escaping without a third read.
  return { id: result.id, offset: Math.max(0, result.total - Math.floor(DIAGNOSTIC_MAX_BYTES / 2)), max_bytes: DIAGNOSTIC_MAX_BYTES };
}
function diagnosticLines(text: unknown, lines: number): string {
  if (typeof text !== "string") return "";
  const count = Number.isFinite(lines) ? Math.max(1, Math.floor(lines)) : 50;
  return text.slice(-DIAGNOSTIC_MAX_BYTES).trimEnd().split("\n").slice(-count).join("\n");
}

export function readScreen(surface: string, lines = 50): string {
  requireMux();
  const handle = getSurfaceHandle(surface);
  if (!handle?.blockId) return "";
  const result = rexJson(diagnosticArgs(handle, "format", {
    format: "text", trim: true, unwrap: true, max_bytes: DIAGNOSTIC_MAX_BYTES,
  }), diagnosticOptions);
  const tail = tailRequest(result);
  const text = tail ? rexJson(diagnosticArgs(handle, "blob_read", tail), diagnosticOptions)?.data : result?.content;
  return diagnosticLines(text, lines);
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireMux();
  const handle = getSurfaceHandle(surface);
  if (!handle?.blockId) return "";
  const result = await rexJsonAsync(diagnosticArgs(handle, "format", {
    format: "text", trim: true, unwrap: true, max_bytes: DIAGNOSTIC_MAX_BYTES,
  }), diagnosticOptions);
  const tail = tailRequest(result);
  const text = tail ? (await rexJsonAsync(diagnosticArgs(handle, "blob_read", tail), diagnosticOptions))?.data : result?.content;
  return diagnosticLines(text, lines);
}

export function getSurfaceTab(surface: string, refresh = false, timeoutMs?: number): string | null {
  const handle = getSurfaceHandle(surface);
  if (handle?.windowId && (!refresh || !handle.blockId)) return handle.windowId;
  if (!handle?.blockId) return null;

  try {
    const raw = rexExec(["block", "inspect", "-s", handle.sessionId, handle.blockId, "--json"], { timeoutMs });
    const parsed = JSON.parse(raw);
    const windowId = parsed?.block?.window_id || parsed?.window || parsed?.window_id || null;
    if (windowId) handle.windowId = windowId;
    return windowId;
  } catch (error: any) {
    // An externally removed pane still needs its last known tab balanced.
    // A transport failure is not proof of absence: skip sizing rather than guess.
    if (/block .*not found|block not found/i.test(`${error?.message}\n${error?.stderr}`)) {
      return handle.windowId ?? null;
    }
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

  // Refresh once before close: a vanished block can no longer tell us its
  // window. Bound this cosmetic lookup and reuse it across cleanup retries.
  const affectedWindow = handle.closingWindowId !== undefined
    ? handle.closingWindowId
    : (handle.closingWindowId = getSurfaceTab(surface, true, 3000));
  try {
    if (handle.kind === "tab" && handle.windowId) {
      if (handle.blockId) {
        // Normal tab with known block:
        // Default to safe behavior: close window ONLY if inspection explicitly succeeds,
        // layers is a non-empty array, and extracting all blocks across all layers results
        // in an array containing EXACTLY ONE block whose block_id matches handle.blockId.
        // In ALL OTHER CASES (missing layers, empty layers, 0 blocks found, > 1 blocks found,
        // any other block_id present, or inspection thrown/failed), close ONLY handle.blockId!
        let canCloseWindowSafely = false;
        try {
          const raw = rexExec(["window", "inspect", "-s", handle.sessionId, handle.windowId, "--json"]);
          const win = JSON.parse(raw);
          if (Array.isArray(win?.layers) && win.layers.length > 0) {
            const blocks = win.layers.flatMap((l: any) => (Array.isArray(l?.blocks) ? l.blocks : []));
            if (blocks.length === 1 && blocks[0]?.block_id === handle.blockId) {
              canCloseWindowSafely = true;
            }
          }
        } catch {
          // Inspection failed or window target not found; do NOT close the entire window
          canCloseWindowSafely = false;
        }

        if (canCloseWindowSafely) {
          rexExec(["window", "close", "-s", handle.sessionId, handle.windowId]);
        } else {
          rexExec(["block", "close", "-s", handle.sessionId, handle.blockId]);
        }
      } else {
        // Partial tab creation failure (windowId exists, blockId absent):
        // Inspect the window. If the window has zero or one block, close the window.
        let canClosePartialWindow = false;
        try {
          const raw = rexExec(["window", "inspect", "-s", handle.sessionId, handle.windowId, "--json"]);
          const win = JSON.parse(raw);
          if (Array.isArray(win?.layers)) {
            const blocks = win.layers.flatMap((l: any) => (Array.isArray(l?.blocks) ? l.blocks : []));
            if (blocks.length <= 1) {
              canClosePartialWindow = true;
            }
          }
        } catch {
          canClosePartialWindow = false;
        }

        if (canClosePartialWindow) {
          rexExec(["window", "close", "-s", handle.sessionId, handle.windowId]);
        }
      }
    } else if (handle.blockId) {
      rexExec(["block", "close", "-s", handle.sessionId, handle.blockId]);
    }
    handle.status = "closed";
    unregisterSurfaceHandle(surface);
  } catch (closeError: any) {
    const msg = closeError?.message || String(closeError);
    const stderr = closeError?.stderr || "";
    if (/not found/i.test(msg) || /not found/i.test(stderr) || /already closed/i.test(msg) || /already gone/i.test(msg)) {
      // Target is confirmed already gone; safe idempotent cleanup
      handle.status = "closed";
      unregisterSurfaceHandle(surface);
    } else {
      // Transient transport failure: do not drop tracking silently
      throw closeError;
    }
  } finally {
    if (affectedWindow) scheduleTabSizing(handle.sessionId, affectedWindow);
  }
}

// ── Exit Polling & Process State ──

export class RexInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RexInfrastructureError";
  }
}

export function isRexInfrastructureError(err: any): boolean {
  return (
    err instanceof RexInfrastructureError ||
    (err && typeof err.message === "string" && err.message.startsWith("Sustained infrastructure failure"))
  );
}

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
    const stderr = error?.stderr || "";
    const combined = `${msg}\n${stderr}`;
    const escapedBlockId = blockId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const blockNotFoundPattern = new RegExp(`block\\s+.*${escapedBlockId}.*\\s+not found|block target .* not found|block not found`, "i");
    if (blockNotFoundPattern.test(combined)) {
      return "not_found";
    }
    throw error;
  }
}

function interpretExitSidecar(data: any): PollResult {
  if (data && typeof data === "object") {
    if (data.type === "error") {
      const errorMessage =
        typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
          ? data.errorMessage
          : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
      return { reason: "error", exitCode: 1, errorMessage };
    }
    if (data.type === "done") {
      return { reason: "done", exitCode: 0 };
    }
  }
  // Unrecognized or corrupt payload - do not report success
  return {
    reason: "error",
    exitCode: 1,
    errorMessage: `Unrecognized or corrupt subagent exit sidecar payload: ${JSON.stringify(data)}`,
  };
}

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
  const handle = getSurfaceHandle(surface);
  const blockId = handle?.blockId;
  const sessionId = handle?.sessionId;
  const start = Date.now();
  let consecutiveErrors = 0;
  const maxErrors = options.maxConsecutiveErrors ?? 10;
  let cachedSidecarResult: PollResult | null = null;
  let cachedSentinel = false;

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // 1. Check sidecar .exit file (record payload, wait for process termination before returning)
    if (options.sessionFile && !cachedSidecarResult) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          cachedSidecarResult = interpretExitSidecar(data);
        }
      } catch {}
    }

    // 2. Check sentinel file (e.g. Claude)
    if (options.sentinelFile && !cachedSentinel) {
      try {
        if (existsSync(options.sentinelFile)) {
          cachedSentinel = true;
        }
      } catch {}
    }

    // 3. Query Rex block process
    const currentBlockId = handle?.blockId ?? blockId;
    const currentSessionId = handle?.sessionId ?? sessionId;
    if (currentBlockId && currentSessionId) {
      try {
        const proc = queryBlockProcess(currentBlockId, currentSessionId);
        if (proc === "not_found") {
          return {
            reason: "interrupted",
            exitCode: 1,
            errorMessage: "Subagent Rex pane was closed externally before completion.",
          };
        }
        const isValidProc =
          proc &&
          typeof proc === "object" &&
          (proc.last_exit === null ||
            (proc.last_exit && typeof proc.last_exit === "object" && typeof proc.last_exit.exit_code === "number"));
        if (!isValidProc) {
          throw new Error(`Malformed process response for block ${currentBlockId}: ${JSON.stringify(proc)}`);
        }
        consecutiveErrors = 0; // reset only on valid process response
        if (proc.last_exit !== null && proc.last_exit !== undefined) {
          // Late-sidecar discovery path: check if .exit sidecar was written while Rex query was running
          if (options.sessionFile && !cachedSidecarResult) {
            try {
              const exitFile = `${options.sessionFile}.exit`;
              if (existsSync(exitFile)) {
                const data = JSON.parse(readFileSync(exitFile, "utf-8"));
                rmSync(exitFile, { force: true });
                cachedSidecarResult = interpretExitSidecar(data);
              }
            } catch {}
          }

          if (cachedSidecarResult) {
            // If process exited with a non-zero code, preserve the real exit code
            // while retaining the sidecar's error message/reason
            if (proc.last_exit.exit_code !== 0) {
              return {
                reason: "error",
                exitCode: proc.last_exit.exit_code,
                errorMessage: cachedSidecarResult.errorMessage || proc.last_exit.error,
              };
            }
            return cachedSidecarResult;
          }
          if (cachedSentinel) {
            return {
              reason: "sentinel",
              exitCode: proc.last_exit.exit_code,
              ...(proc.last_exit.error ? { errorMessage: proc.last_exit.error } : {}),
            };
          }
          const code = proc.last_exit.exit_code;
          return {
            reason: code === 0 ? "done" : "error",
            exitCode: code,
            ...(proc.last_exit.error ? { errorMessage: proc.last_exit.error } : {}),
          };
        }
      } catch (err: any) {
        // Transient error or process query failed
        consecutiveErrors++;
        if (consecutiveErrors >= maxErrors) {
          throw new RexInfrastructureError(
            `Sustained infrastructure failure observing Rex block ${currentBlockId}: ${err?.message || String(err)}`,
          );
        }
      }
    } else {
      // Surface was closed or unmapped without a block ID
      return {
        reason: "interrupted",
        exitCode: 1,
        errorMessage: "Subagent Rex pane was closed externally before completion.",
      };
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
  setRexExecutor,
  setRexContextOverride,
  setCommandAvailabilityOverride,
  hasCommand,
  queryBlockProcess,
  pollForExit,
  RexInfrastructureError,
  isRexInfrastructureError,
  sizingPassCount: () => sizingPasses.size,
};
