/**
 * Integration tests for the Rex surface layer.
 *
 * These tests exercise real Rex operations: creating windows,
 * creating parent-anchored splits, sending commands, reading screen output,
 * verifying focus preservation, safe paste steering, and closing blocks.
 * No LLM calls — fast and free.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  createTrackedSurfaceSplit,
  getFocusedSurface,
  getSurfaceTab,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  sleep,
  uniqueId,
  waitForScreen,
  type TestEnv,
} from "./harness.ts";
import {
  getRexContext,
  queryBlockProcess,
  queryProgramStatus,
  sendMessage,
  getSurfaceHandle,
  rexJson,
  rexExec,
  rexBin,
  buildRexArgs,
  setRexExecutor,
  scheduleTabSizing,
  disposeRexSurfaces,
  pollForExit,
  __rexTest__,
} from "../../pi-extension/subagents/rex.ts";
import { planEqualShares } from "../../pi-extension/subagents/rex-sizing.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Deliberate top-level identities, independent of the test runner's ancestry.
function mainSurface(env: TestEnv, name: string): string {
  const savedName = process.env.PI_SUBAGENT_NAME;
  const savedTop = process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
  delete process.env.PI_SUBAGENT_NAME;
  delete process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
  try { return createTrackedSurface(env, name); }
  finally {
    if (savedName === undefined) delete process.env.PI_SUBAGENT_NAME;
    else process.env.PI_SUBAGENT_NAME = savedName;
    if (savedTop === undefined) delete process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
    else process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = savedTop;
  }
}

async function waitForBalanced(session: string, windowId: string): Promise<any> {
  const deadline = Date.now() + 5000;
  do {
    const view = rexJson(["session", "inspect", session, "--json"]);
    const window = view.windows.find((w: any) => w.window_id === windowId);
    const layout = window?.layers?.find((l: any) => l.kind === "tiled")?.layout;
    if (layout && planEqualShares(layout).length === 0 && __rexTest__.sizingPassCount() === 0) return window;
    await sleep(50);
  } while (Date.now() < deadline);
  assert.fail(`Timed out balancing ${windowId}`);
}

function layoutLeaves(node: any): any[] {
  return node?.split ? [...layoutLeaves(node.split.before), ...layoutLeaves(node.split.after)] : node?.block_id ? [node] : [];
}

const backends = getAvailableBackends();

if (backends.length === 0) {
  console.log("⚠️  Rex is not available — skipping rex-surface integration tests");
  console.log("   Run inside a Rex terminal to enable these tests.");
}

for (const backend of backends) {
  describe(`rex-surface [${backend}]`, { timeout: 60_000 }, () => {
    let env: TestEnv;

    before(() => {
      env = createTestEnv();
    });

    after(() => {
      cleanupTestEnv(env);
    });

    for (const mode of ["automatic", "disabled", "settings-override"] as const) {
      it(`source-loaded Pi uses native capabilities/status (${mode}), without model requests or config changes`, async () => {
        const initialFocus = getFocusedSurface();
        const dir = mkdtempSync(join(env.dir, "native-pi-"));
        const agentDir = join(dir, "agent");
        mkdirSync(agentDir);
        const disabled = mode === "settings-override";
        const settings = JSON.stringify({
          theme: "dark", tuiMode: "regular", quietStartup: true,
          lastChangelogVersion: execFileSync("pi", ["--version"], { encoding: "utf8" }).trim(),
          terminal: { hyperlinks: disabled ? false : "auto", images: disabled ? false : "auto", trueColor: disabled ? false : "auto" },
        });
        const settingsFile = join(agentDir, "settings.json");
        writeFileSync(settingsFile, settings);
        const source = fileURLToPath(new URL("../../pi-extension/subagents/index.ts", import.meta.url));
        const fixture = fileURLToPath(new URL("./fixtures/native-pi.ts", import.meta.url));
        const { shellEscape } = await import("../../pi-extension/subagents/rex.ts");
        const log = join(dir, "native-output.log");
        const surface = mainSurface(env, `native-pi-${mode}`);
        // Scrub inherited identities/overrides in this isolated fixture only. In
        // production, explicit user overrides are preserved by sendLongCommand.
        const unset = "unset PI_SUBAGENT_NAME PI_SUBAGENT_AUTO_EXIT PI_SUBAGENT_ALLOWED PI_SUBAGENT_AGENT PI_SUBAGENT_SESSION PI_SUBAGENT_ID PI_SUBAGENT_ACTIVITY_FILE PI_SUBAGENT_SURFACE PI_PROGRAM_STATUS PI_HYPERLINKS PI_IMAGE_PROTOCOL PI_TRUE_COLOR TMUX STY;";
        const overrides = mode === "disabled" ? "PI_PROGRAM_STATUS=0" : disabled ? "PI_HYPERLINKS=1 PI_IMAGE_PROTOCOL=kitty PI_TRUE_COLOR=1" : "";
        sendLongCommand(surface, `${unset}\nexec env PI_CODING_AGENT_DIR=${shellEscape(agentDir)} PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 PI_TUI_WRITE_LOG=${shellEscape(log)} ${overrides} pi -ne -e ${shellEscape(source)} -e ${shellEscape(fixture)} --no-skills --no-prompt-templates --no-themes --no-session`, {
          cwd: dir, scriptPath: join(dir, "launch.sh"),
        });
        const handle = getSurfaceHandle(surface)!;
        try {
          const stateFile = join(dir, "native-state.json");
          const deadline = Date.now() + 15_000;
          while (!existsSync(stateFile) && Date.now() < deadline) await sleep(100);
          assert.ok(existsSync(stateFile), `Pi startup failed: ${await readScreenAsync(surface, 60)}`);
          const state = JSON.parse(readFileSync(stateFile, "utf8"));
          assert.equal(state.termProgram, "rex", "must exercise real Rex environment detection");
          assert.ok(state.tools.includes("subagent"), "workspace source must be loaded");
          assert.deepEqual(state.capabilities, disabled
            ? { images: null, trueColor: false, hyperlinks: false }
            : { images: "kitty", trueColor: true, hyperlinks: true });
          assert.equal(state.programStatus, mode === "disabled" ? "0" : null);
          await waitForScreen(surface, /NATIVE_REX_COLOR/, 10_000);
          const stream = readFileSync(log, "utf8");
          if (disabled) {
            assert.doesNotMatch(stream, /\x1b\]8;;https:\/\/www\.superlogical\.com\/rex/);
            assert.doesNotMatch(stream, /\x1b_G/);
            assert.doesNotMatch(stream, /\x1b\[38;2;18;52;86m/);
          } else {
            assert.match(stream, /\x1b\]8;;https:\/\/www\.superlogical\.com\/rex/);
            assert.match(stream, /\x1b\[38;2;18;52;86m/);
            assert.match(stream, /\x1b_G[^\x1b]*a=T/, "Pi's Image component must transmit Kitty graphics");
            // Rex's own capture confirms the link/color reached its terminal model.
            const html = rexExec(["capture", "-s", handle.sessionId, "-b", handle.blockId!, "--format=html", "--trim"]);
            assert.match(html, /NATIVE_REX_LINK/);
            assert.match(html, /href="https:\/\/www\.superlogical\.com\/rex"/);
            assert.match(html, /(?:#123456|rgb\(18,\s*52,\s*86\))/i);
          }
          if (mode === "disabled") {
            assert.deepEqual(queryProgramStatus(handle.blockId!, handle.sessionId), []);
            assert.throws(() => sendMessage(surface, "/hotkeys"), /PI_PROGRAM_STATUS.*OSC 7501/);
            const processState = queryBlockProcess(handle.blockId!, handle.sessionId);
            assert.notEqual(processState, "not_found");
            assert.equal(processState !== "not_found" && processState.last_exit, null);
          } else {
            let records = queryProgramStatus(handle.blockId!, handle.sessionId);
            const statusDeadline = Date.now() + 5000;
            while (!records.some((record) => record.app === "pi" && record.state === "idle") && Date.now() < statusDeadline) {
              await sleep(100);
              records = queryProgramStatus(handle.blockId!, handle.sessionId);
            }
            assert.ok(records.some((record) => record.app === "pi" && record.state === "idle"), JSON.stringify(records));
            sendMessage(surface, "/hotkeys");
            await waitForScreen(surface, /Slash commands/, 10_000);
            if (mode === "automatic") {
              sendMessage(surface, "/native-smoke-dialog");
              let blockedRecords = queryProgramStatus(handle.blockId!, handle.sessionId);
              const blockedDeadline = Date.now() + 5000;
              while (!blockedRecords.some((record) => record.state === "blocked") && Date.now() < blockedDeadline) {
                await sleep(100);
                blockedRecords = queryProgramStatus(handle.blockId!, handle.sessionId);
              }
              assert.ok(blockedRecords.some((record) => record.state === "blocked"), JSON.stringify(blockedRecords));
              assert.throws(() => sendMessage(surface, "must not reach dialog"), /blocked on a .*dialog/);
            }
          }
          assert.equal(existsSync(join(dir, "unexpected-provider-request")), false);
          assert.equal(readFileSync(settingsFile, "utf8"), settings, "Pi choices must not be rewritten");
          assert.equal(getFocusedSurface(), initialFocus);
        } finally {
          closeSurface(surface);
        }
      });
    }

    it("keeps focus on the active surface while creating and targeting subagent surfaces", async () => {
      const initialFocus = getFocusedSurface();
      assert.ok(initialFocus, "expected to read currently focused block");

      const markerA = uniqueId();
      const markerB = uniqueId();

      const childA = createTrackedSurface(env, "focus-child-a");
      sendLongCommand(childA, `echo "FOCUS_A_${markerA}"`);

      const childB = createTrackedSurface(env, "focus-child-b");
      sendLongCommand(childB, `echo "FOCUS_B_${markerB}"`);

      await Promise.all([
        waitForScreen(childA, new RegExp(`FOCUS_A_${markerA}`), 10_000, 50),
        waitForScreen(childB, new RegExp(`FOCUS_B_${markerB}`), 10_000, 50),
      ]);

      assert.equal(getFocusedSurface(), initialFocus, "focus should remain on the initial block");
    });

    it("opens a new window for a main-session subagent and keeps a nested subagent in that window", async () => {
      const ctx = getRexContext();
      assert.ok(ctx.block, "expected REX_BLOCK");

      const savedTopLevel = process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
      const savedName = process.env.PI_SUBAGENT_NAME;
      delete process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
      delete process.env.PI_SUBAGENT_NAME;

      let top: string;
      try {
        top = createTrackedSurface(env, "tab-top-level");
      } finally {
        if (savedTopLevel !== undefined) process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = savedTopLevel;
        if (savedName !== undefined) process.env.PI_SUBAGENT_NAME = savedName;
      }

      const topHandle = (await import("../../pi-extension/subagents/rex.ts")).getSurfaceHandle(top);
      assert.equal(topHandle?.kind, "tab", "top-level handle must be a tab");

      const topMarker = uniqueId();
      sendLongCommand(top, `echo "TOP_${topMarker}"`);
      await waitForScreen(top, new RegExp(`TOP_${topMarker}`), 10_000, 20);

      const topTab = getSurfaceTab(top);
      assert.ok(topTab, "expected to read top surface window id");
      const labeled = rexJson(["block", "inspect", "-s", ctx.session!, topHandle!.blockId!, "--json"]);
      assert.equal(labeled.block.label, "tab-top-level", "the command pane must share the named tab's agent label");

      // Verify top-level window is different from the spawner's window
      const rexModule = await import("../../pi-extension/subagents/rex.ts");
      const spawnerWindow = (() => {
        const raw = rexModule.rexExec(["block", "inspect", "-s", ctx.session!, ctx.block!, "--json"]);
        return JSON.parse(raw)?.block?.window_id;
      })();
      if (spawnerWindow) {
        assert.notEqual(topTab, spawnerWindow, "top-level subagent must open a distinct window from its spawner");
      }

      // Spawning nested subagent with PI_SUBAGENT_NAME set
      const savedNestedName = process.env.PI_SUBAGENT_NAME;
      const savedBlock = process.env.REX_BLOCK;
      try {
        process.env.PI_SUBAGENT_NAME = "tab-top-level";
        // simulate nested spawner inside top surface's block
        assert.ok(topHandle?.blockId, "top handle should have a blockId");
        process.env.REX_BLOCK = topHandle.blockId;

        const nested = createTrackedSurface(env, "tab-nested-child");
        const nestedHandle = (await import("../../pi-extension/subagents/rex.ts")).getSurfaceHandle(nested);
        assert.equal(nestedHandle?.kind, "split", "nested subagent handle must be a split");

        const nestedMarker = uniqueId();
        sendLongCommand(nested, `echo "NESTED_${nestedMarker}"`);
        await waitForScreen(nested, new RegExp(`NESTED_${nestedMarker}`), 10_000, 20);

        const nestedTab = getSurfaceTab(nested);
        assert.equal(nestedTab, topTab, "nested child must share its parent's window");
      } finally {
        if (savedNestedName === undefined) delete process.env.PI_SUBAGENT_NAME;
        else process.env.PI_SUBAGENT_NAME = savedNestedName;
        if (savedBlock === undefined) delete process.env.REX_BLOCK;
        else process.env.REX_BLOCK = savedBlock;
      }
    });

    for (const label of ["-agent-name", "--dash-name"]) {
      it(`preserves the leading-dash label ${JSON.stringify(label)} on tabs and nested panes`, async () => {
        const initialFocus = getFocusedSurface();
        const top = mainSurface(env, label);
        let nested: string | undefined;
        try {
          sendLongCommand(top, 'echo "DASH_TOP_READY"');
          await waitForScreen(top, /DASH_TOP_READY/, 10_000, 20);
          const topHandle = getSurfaceHandle(top)!;
          assert.equal(topHandle.kind, "tab");
          assert.equal(topHandle.name, label);
          const view = rexJson(["session", "inspect", topHandle.sessionId, "--json"]);
          const tab = view.windows.find((w: any) => w.window_id === topHandle.windowId);
          assert.equal(tab?.label, label, "the temporary tab label must be replaced with the exact requested name");
          const pane = rexJson(["block", "inspect", "-s", topHandle.sessionId, topHandle.blockId!, "--json"]);
          assert.equal(pane.block.label, label, "the command pane must retain the leading dashes");

          nested = createTrackedSurfaceSplit(env, label, "right", top);
          sendLongCommand(nested, 'echo "DASH_NESTED_READY"');
          await waitForScreen(nested, /DASH_NESTED_READY/, 10_000, 20);
          const nestedHandle = getSurfaceHandle(nested)!;
          assert.equal(nestedHandle.kind, "split");
          assert.equal(nestedHandle.name, label);
          const nestedPane = rexJson(["block", "inspect", "-s", nestedHandle.sessionId, nestedHandle.blockId!, "--json"]);
          assert.equal(nestedPane.block.label, label, "split labels must also retain the leading dashes");
          assert.equal(nestedPane.block.window_id, topHandle.windowId);
          assert.equal(getFocusedSurface(), initialFocus, "labeling must not change focus");
        } finally {
          if (nested) closeSurface(nested);
          closeSurface(top);
        }
      });
    }

    it("launches command directly, reads output, queries process, and closes cleanly", async () => {
      const surface = createTrackedSurface(env, "exec-test");
      const marker = uniqueId();
      sendLongCommand(surface, `echo "RUN_MARKER_${marker}"`);

      const screen = await waitForScreen(surface, new RegExp(`RUN_MARKER_${marker}`), 10_000, 50);
      assert.match(screen, new RegExp(`RUN_MARKER_${marker}`));

      const handle = (await import("../../pi-extension/subagents/rex.ts")).getSurfaceHandle(surface);
      assert.ok(handle?.blockId);
      const proc = queryBlockProcess(handle.blockId, handle.sessionId);
      assert.notEqual(proc, "not_found");

      closeSurface(surface);
      await sleep(500);

      const procAfter = queryBlockProcess(handle.blockId, handle.sessionId);
      assert.equal(procAfter, "not_found", "closed block should not be found");
    });

    it("delivers literal paste steering input without executing as raw keystrokes", async () => {
      const surface = createTrackedSurface(env, "paste-test");
      // Keep a cat or bash process reading stdin
      sendLongCommand(surface, `cat`);
      await sleep(1000);

      const secretText = "literal 'quote' and \"double quote\" and `backticks` $VAR";
      const handle = (await import("../../pi-extension/subagents/rex.ts")).getSurfaceHandle(surface);
      assert.ok(handle?.blockId);
      // Rex sendPasteEvent directly sends paste input
      const { sendPasteEvent, sendEnterKeyEvent } = await import("../../pi-extension/subagents/rex.ts");
      sendPasteEvent(handle.blockId, handle.sessionId, secretText);
      sendEnterKeyEvent(handle.blockId, handle.sessionId);

      await waitForScreen(surface, /literal 'quote' and "double quote"/, 10_000, 20);
    });

    it("placement override forces top-level pane split instead of tab", async () => {
      const savedOverride = process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
      const savedName = process.env.PI_SUBAGENT_NAME;
      delete process.env.PI_SUBAGENT_NAME;
      process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = "pane";
      try {
        const topPane = createTrackedSurface(env, "top-pane-override");
        const handle = (await import("../../pi-extension/subagents/rex.ts")).getSurfaceHandle(topPane);
        assert.equal(handle?.kind, "split", "override should create split instead of tab");

        const marker = uniqueId();
        sendLongCommand(topPane, `echo "TOP_PANE_${marker}"`);
        await waitForScreen(topPane, new RegExp(`TOP_PANE_${marker}`), 10_000, 20);
      } finally {
        if (savedOverride === undefined) delete process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
        else process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = savedOverride;
        if (savedName === undefined) delete process.env.PI_SUBAGENT_NAME;
        else process.env.PI_SUBAGENT_NAME = savedName;
      }
    });

    it("launches command with special-character arguments and paths", async () => {
      const surface = createTrackedSurface(env, "special-chars");
      const specialArg = "arg with spaces and 'quotes' & $METACHARED";
      // Escape for inclusion in the wrapper script: printf '%s\n' 'arg with spaces and '\''quotes'\'' & $METACHARED'
      const { shellEscape } = await import("../../pi-extension/subagents/rex.ts");
      sendLongCommand(surface, `printf '%s\\n' ${shellEscape(specialArg)}`);

      const screen = await waitForScreen(surface, /arg with spaces and 'quotes' & \$METACHARED/, 10_000, 20);
      assert.match(screen, /arg with spaces and 'quotes' & \$METACHARED/, "exact literal argument must appear in screen output");
    });

    it("closing a parent tab surface preserves surviving nested child blocks in the same window", async () => {
      const savedTopLevel = process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
      const savedName = process.env.PI_SUBAGENT_NAME;
      delete process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
      delete process.env.PI_SUBAGENT_NAME;

      let top: string;
      try {
        top = createTrackedSurface(env, "parent-close-test");
      } finally {
        if (savedTopLevel !== undefined) process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = savedTopLevel;
        if (savedName !== undefined) process.env.PI_SUBAGENT_NAME = savedName;
      }

      const topHandle = (await import("../../pi-extension/subagents/rex.ts")).getSurfaceHandle(top);
      assert.ok(topHandle);
      assert.equal(topHandle.kind, "tab", "top surface must be a tab");

      sendLongCommand(top, `echo "PARENT_ALIVE"`);
      await waitForScreen(top, /PARENT_ALIVE/, 10_000, 20);

      const topWindowId = getSurfaceTab(top);
      assert.ok(topWindowId);
      assert.ok(topHandle.blockId);

      // Create child split off parent
      const savedNestedName = process.env.PI_SUBAGENT_NAME;
      const savedBlock = process.env.REX_BLOCK;
      let child: string;
      try {
        process.env.PI_SUBAGENT_NAME = "parent-close-test";
        process.env.REX_BLOCK = topHandle.blockId;
        child = createTrackedSurface(env, "child-survivor");
        sendLongCommand(child, `echo "CHILD_ALIVE"`);
        await waitForScreen(child, /CHILD_ALIVE/, 10_000, 20);
      } finally {
        if (savedNestedName === undefined) delete process.env.PI_SUBAGENT_NAME;
        else process.env.PI_SUBAGENT_NAME = savedNestedName;
        if (savedBlock === undefined) delete process.env.REX_BLOCK;
        else process.env.REX_BLOCK = savedBlock;
      }

      const childHandle = (await import("../../pi-extension/subagents/rex.ts")).getSurfaceHandle(child);
      assert.ok(childHandle?.blockId);
      assert.equal(childHandle.kind, "split", "nested child must be a split");

      // Close parent tab surface
      closeSurface(top);
      await sleep(500);

      // Verify that parent block is gone but child block survives
      const parentProc = queryBlockProcess(topHandle.blockId, topHandle.sessionId);
      assert.equal(parentProc, "not_found", "parent block should be closed");

      const childProc = queryBlockProcess(childHandle.blockId, childHandle.sessionId);
      assert.notEqual(childProc, "not_found", "child block must survive parent cleanup");
    });

    it("closing a lone tab surface closes the entire Rex window", async () => {
      // Ensure we simulate a top-level spawner so createSurface creates a tab
      const savedName = process.env.PI_SUBAGENT_NAME;
      const savedTopLevel = process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
      delete process.env.PI_SUBAGENT_NAME;
      delete process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
      let surface: string;
      try {
        surface = createTrackedSurface(env, "lone-tab-close");
        sendLongCommand(surface, `echo "LONE_TAB"`);
        await waitForScreen(surface, /LONE_TAB/, 10_000, 20);
      } finally {
        if (savedName !== undefined) process.env.PI_SUBAGENT_NAME = savedName;
        if (savedTopLevel !== undefined) process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = savedTopLevel;
      }

      const handle = (await import("../../pi-extension/subagents/rex.ts")).getSurfaceHandle(surface);
      assert.ok(handle?.blockId && handle?.windowId);
      assert.equal(handle.kind, "tab");
      const windowId = handle.windowId;

      closeSurface(surface);
      await sleep(500);

      // Both block and window should be gone
      const proc = queryBlockProcess(handle.blockId, handle.sessionId);
      assert.equal(proc, "not_found");

      const { rexExec } = await import("../../pi-extension/subagents/rex.ts");
      assert.throws(
        () => rexExec(["window", "inspect", "-s", handle.sessionId, windowId, "--json"]),
        /not found/,
      );
    });

    it("sendMessage exercises full safety check and delivery against running process", async () => {
      const surface = createTrackedSurface(env, "send-msg-test");
      // 1. In a raw bash process without OSC 7501 status, sendMessage must fail safety check
      sendLongCommand(surface, `cat`);
      await sleep(1000);

      assert.throws(
        () => sendMessage(surface, "echo HELLO_STEER"),
        /No program status records available|Cannot deliver message safely/,
        "sendMessage must refuse delivery when no trustworthy Pi status exists",
      );

      // 2. In a process that emits Pi program status (OSC 7501), sendMessage succeeds and delivers paste + enter
      const statusSurface = createTrackedSurface(env, "status-send-test");
      // Emit OSC 7501 status sequence for pi: \x1b]7501;state=working:app=pi\x1b\\
      sendLongCommand(statusSurface, `printf '\\033]7501;state=working:app=pi\\033\\\\'; cat`);
      await sleep(1000);

      sendMessage(statusSurface, "echo STATUS_VERIFIED");
      const screen = await waitForScreen(statusSurface, /echo STATUS_VERIFIED/, 10_000, 20);
      assert.match(screen, /echo STATUS_VERIFIED/);
    });

    it("launches command with special-character cwd and script path", async () => {
      const { mkdirSync, realpathSync } = await import("node:fs");
      const { join } = await import("node:path");

      const specialCwd = join(env.dir, "cwd with 'quotes' & spaces");
      mkdirSync(specialCwd, { recursive: true });
      const canonicalCwd = realpathSync(specialCwd);

      const surface = createTrackedSurface(env, "special-cwd");
      const specialScript = join(specialCwd, "test 'special' script.sh");

      sendLongCommand(surface, `pwd; echo "SPECIAL_CWD_OK"`, {
        cwd: specialCwd,
        scriptPath: specialScript,
      });

      const screen = await waitForScreen(surface, /SPECIAL_CWD_OK/, 10_000, 20);
      assert.match(screen, new RegExp(canonicalCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "screen must show exact cwd path");
    });

    it("cleans up reservations and resources on launch failure", async () => {
      const { getSurfaceHandle, sendLongCommand } = await import("../../pi-extension/subagents/rex.ts");
      const surface = createTrackedSurface(env, "launch-fail-test");
      const handle = getSurfaceHandle(surface);
      assert.ok(handle);
      assert.equal(handle.status, "reserved");

      // Attempt launch with an impossible script path (e.g. read-only uncreatable path)
      assert.throws(() => {
        sendLongCommand(surface, "echo fail", {
          scriptPath: "/proc/nonexistent/sub/fail.sh",
        });
      });

      // Handle should have been closed/cleaned up
      assert.equal(getSurfaceHandle(surface), undefined);
    });

    it("placement override forces right split direction", async () => {
      const savedOverride = process.env.PI_SUBAGENT_SPLIT_DIRECTION;
      const savedSurface = process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
      const savedName = process.env.PI_SUBAGENT_NAME;
      delete process.env.PI_SUBAGENT_NAME;
      process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = "pane";
      process.env.PI_SUBAGENT_SPLIT_DIRECTION = "right";

      const ctx = getRexContext();

      try {
        const splitSurface = createTrackedSurface(env, "split-right-dir");
        const handle = (await import("../../pi-extension/subagents/rex.ts")).getSurfaceHandle(splitSurface);
        assert.equal(handle?.direction, "right", "split direction should be right");

        sendLongCommand(splitSurface, `echo "SPLIT_RIGHT_OK"`);
        await waitForScreen(splitSurface, /SPLIT_RIGHT_OK/, 10_000, 20);

        // Inspect window layout rects: verify child block is to the right of anchor block (anchor.x < child.x)
        assert.ok(handle?.blockId);
        const { rexExec } = await import("../../pi-extension/subagents/rex.ts");
        const rawAnchor = rexExec(["block", "inspect", "-s", handle.sessionId, handle.anchorBlockId!, "--json"]);
        const windowId = JSON.parse(rawAnchor)?.block?.window_id;
        assert.ok(windowId);

        const rawWin = rexExec(["window", "inspect", "-s", handle.sessionId, windowId, "--json"]);
        const win = JSON.parse(rawWin);

        function findBlockRect(node: any, targetId: string): any {
          if (!node) return null;
          if (node.block_id === targetId) return node.rect;
          if (node.layout) return findBlockRect(node.layout, targetId);
          if (node.split) {
            return findBlockRect(node.split.before, targetId) || findBlockRect(node.split.after, targetId);
          }
          if (node.layers) {
            for (const layer of node.layers) {
              const r = findBlockRect(layer.layout, targetId);
              if (r) return r;
            }
          }
          return null;
        }

        const anchorRect = findBlockRect(win, handle.anchorBlockId!);
        const childRect = findBlockRect(win, handle.blockId);
        assert.ok(Array.isArray(anchorRect) && anchorRect.length >= 2, "anchorRect must be found");
        assert.ok(Array.isArray(childRect) && childRect.length >= 2, "childRect must be found");
        assert.ok(anchorRect[0] < childRect[0], `anchor x (${anchorRect[0]}) should be < child x (${childRect[0]}) for right split`);
      } finally {
        if (savedOverride === undefined) delete process.env.PI_SUBAGENT_SPLIT_DIRECTION;
        else process.env.PI_SUBAGENT_SPLIT_DIRECTION = savedOverride;
        if (savedSurface === undefined) delete process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
        else process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = savedSurface;
        if (savedName === undefined) delete process.env.PI_SUBAGENT_NAME;
        else process.env.PI_SUBAGENT_NAME = savedName;
      }
    });

    it("placement override forces down/below split direction", async () => {
      const savedOverride = process.env.PI_SUBAGENT_SPLIT_DIRECTION;
      const savedSurface = process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
      const savedName = process.env.PI_SUBAGENT_NAME;
      delete process.env.PI_SUBAGENT_NAME;
      process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = "pane";
      process.env.PI_SUBAGENT_SPLIT_DIRECTION = "down";

      try {
        const splitSurface = createTrackedSurface(env, "split-down-dir");
        const handle = (await import("../../pi-extension/subagents/rex.ts")).getSurfaceHandle(splitSurface);
        assert.equal(handle?.direction, "below", "split direction should map down to below");

        sendLongCommand(splitSurface, `echo "SPLIT_DOWN_OK"`);
        await waitForScreen(splitSurface, /SPLIT_DOWN_OK/, 10_000, 20);

        // Inspect window layout rects: verify child block is below anchor block (anchor.y < child.y)
        assert.ok(handle?.blockId);
        const { rexExec } = await import("../../pi-extension/subagents/rex.ts");
        const rawAnchor = rexExec(["block", "inspect", "-s", handle.sessionId, handle.anchorBlockId!, "--json"]);
        const windowId = JSON.parse(rawAnchor)?.block?.window_id;
        assert.ok(windowId);

        const rawWin = rexExec(["window", "inspect", "-s", handle.sessionId, windowId, "--json"]);
        const win = JSON.parse(rawWin);

        function findBlockRect(node: any, targetId: string): any {
          if (!node) return null;
          if (node.block_id === targetId) return node.rect;
          if (node.layout) return findBlockRect(node.layout, targetId);
          if (node.split) {
            return findBlockRect(node.split.before, targetId) || findBlockRect(node.split.after, targetId);
          }
          if (node.layers) {
            for (const layer of node.layers) {
              const r = findBlockRect(layer.layout, targetId);
              if (r) return r;
            }
          }
          return null;
        }

        const anchorRect = findBlockRect(win, handle.anchorBlockId!);
        const childRect = findBlockRect(win, handle.blockId);
        assert.ok(Array.isArray(anchorRect) && anchorRect.length >= 2, "anchorRect must be found");
        assert.ok(Array.isArray(childRect) && childRect.length >= 2, "childRect must be found");
        assert.ok(anchorRect[1] < childRect[1], `anchor y (${anchorRect[1]}) should be < child y (${childRect[1]}) for below/down split`);
      } finally {
        if (savedOverride === undefined) delete process.env.PI_SUBAGENT_SPLIT_DIRECTION;
        else process.env.PI_SUBAGENT_SPLIT_DIRECTION = savedOverride;
        if (savedSurface === undefined) delete process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
        else process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = savedSurface;
        if (savedName === undefined) delete process.env.PI_SUBAGENT_NAME;
        else process.env.PI_SUBAGENT_NAME = savedName;
      }
    });

    it("auto direction queries live anchor dimensions and matches geometry rule", async () => {
      const { queryBlockDimensions, chooseSplitDirection } = await import("../../pi-extension/subagents/rex.ts");
      const ctx = getRexContext();
      assert.ok(ctx.block && ctx.session);

      const liveDims = queryBlockDimensions(ctx.block, ctx.session);
      assert.ok(liveDims, "should query live anchor block dimensions");
      assert.ok(liveDims.columns > 0 && liveDims.rows > 0);

      const expectedDirection = liveDims.columns / liveDims.rows >= 2 ? "right" : "below";
      const actualDirection = chooseSplitDirection(liveDims, "auto");
      assert.equal(actualDirection, expectedDirection);

      // Launch an actual split with PI_SUBAGENT_SPLIT_DIRECTION = "auto"
      const savedOverride = process.env.PI_SUBAGENT_SPLIT_DIRECTION;
      const savedSurface = process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
      const savedName = process.env.PI_SUBAGENT_NAME;
      delete process.env.PI_SUBAGENT_NAME;
      process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = "pane";
      process.env.PI_SUBAGENT_SPLIT_DIRECTION = "auto";

      try {
        const splitSurface = createTrackedSurface(env, "split-auto-dir");
        const handle = (await import("../../pi-extension/subagents/rex.ts")).getSurfaceHandle(splitSurface);
        assert.ok(handle);
        assert.equal(handle.direction, expectedDirection, `handle.direction must match expectedDirection (${expectedDirection})`);

        sendLongCommand(splitSurface, `echo "SPLIT_AUTO_OK"`);
        await waitForScreen(splitSurface, /SPLIT_AUTO_OK/, 10_000, 20);

        assert.ok(handle.blockId, "handle.blockId must be assigned after launch");

        // Inspect window layout rects and verify coordinate ordering
        const { rexExec } = await import("../../pi-extension/subagents/rex.ts");
        const rawAnchor = rexExec(["block", "inspect", "-s", handle.sessionId, handle.anchorBlockId!, "--json"]);
        const windowId = JSON.parse(rawAnchor)?.block?.window_id;
        assert.ok(windowId);

        const rawWin = rexExec(["window", "inspect", "-s", handle.sessionId, windowId, "--json"]);
        const win = JSON.parse(rawWin);

        function findBlockRect(node: any, targetId: string): any {
          if (!node) return null;
          if (node.block_id === targetId) return node.rect;
          if (node.layout) return findBlockRect(node.layout, targetId);
          if (node.split) {
            return findBlockRect(node.split.before, targetId) || findBlockRect(node.split.after, targetId);
          }
          if (node.layers) {
            for (const layer of node.layers) {
              const r = findBlockRect(layer.layout, targetId);
              if (r) return r;
            }
          }
          return null;
        }

        const anchorRect = findBlockRect(win, handle.anchorBlockId!);
        const childRect = findBlockRect(win, handle.blockId);
        assert.ok(Array.isArray(anchorRect) && anchorRect.length >= 2, "anchorRect must be found");
        assert.ok(Array.isArray(childRect) && childRect.length >= 2, "childRect must be found");

        if (expectedDirection === "right") {
          assert.ok(anchorRect[0] < childRect[0], `anchor x (${anchorRect[0]}) should be < child x (${childRect[0]}) for right split`);
        } else {
          assert.ok(anchorRect[1] < childRect[1], `anchor y (${anchorRect[1]}) should be < child y (${childRect[1]}) for below split`);
        }
      } finally {
        if (savedOverride === undefined) delete process.env.PI_SUBAGENT_SPLIT_DIRECTION;
        else process.env.PI_SUBAGENT_SPLIT_DIRECTION = savedOverride;
        if (savedSurface === undefined) delete process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
        else process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = savedSurface;
        if (savedName === undefined) delete process.env.PI_SUBAGENT_NAME;
        else process.env.PI_SUBAGENT_NAME = savedName;
      }

      // Also verify pure edge cases
      assert.equal(chooseSplitDirection({ columns: 160, rows: 40 }, "auto"), "right");
      assert.equal(chooseSplitDirection({ columns: 50, rows: 40 }, "auto"), "below");
    });

    it("balances repeated splits and exits only in the affected tiled tab, preserving focus and floating layers", async () => {
      const top = mainSurface(env, "sizing-target");
      const other = mainSurface(env, "sizing-unrelated");
      sendLongCommand(top, "echo SIZING_PARENT");
      sendLongCommand(other, "echo SIZING_OTHER");
      const target = getSurfaceHandle(top)!;
      const unrelated = getSurfaceHandle(other)!;
      const session = target.sessionId;
      const windowId = getSurfaceTab(top)!;
      const otherWindowId = getSurfaceTab(other)!;
      const originalFocus = getFocusedSurface();
      const originalActive = rexJson(["session", "inspect", session, "--json"]).active_window_id;
      const otherChild = createTrackedSurfaceSplit(env, "unrelated-split", "right", other);
      sendLongCommand(otherChild, "echo OTHER_CHILD");
      await waitForBalanced(session, otherWindowId);
      // Deliberately leave the unrelated tab manually sized and unequal.
      rexExec(["api", "call", "session.resize_pane", JSON.stringify({
        session_id: session, direction: "horizontal", before_block_id: unrelated.blockId,
        after_block_id: getSurfaceHandle(otherChild)!.blockId, ratio: 0.73,
      })]);
      const otherBefore = rexJson(["window", "inspect", "-s", session, otherWindowId, "--json"]);
      const floating = rexJson(["api", "call", "session.new_layer", JSON.stringify({
        session_id: session, window_id: windowId, focus: false, bounds: [0.1, 0.1, 0.5, 0.5],
        layout: { split: { direction: "horizontal", ratio: 0.7,
          before: { block: { flavor: "com.superlogical.terminal.shell", label: "float-before" } },
          after: { block: { flavor: "com.superlogical.terminal.shell", label: "float-after" } },
        } },
      })]);
      try {
        const floatBefore = rexJson(["window", "inspect", "-s", session, windowId, "--json"])
          .layers.find((l: any) => l.layer_id === floating.layer_id);
        const children: string[] = [];
        // Repeatedly halve the same anchor, then let one debounced pass balance it.
        for (let i = 0; i < 3; i++) {
          const child = createTrackedSurfaceSplit(env, `sizing-child-${i}`, "right", top);
          children.push(child);
          sendLongCommand(child, `echo CHILD_${i}`);
        }
        let balanced = await waitForBalanced(session, windowId);
        const leaves = layoutLeaves(balanced.layers.find((l: any) => l.kind === "tiled").layout);
        assert.equal(leaves.length, 4);
        for (const leaf of leaves) assert.ok(Math.abs(leaf.rect[2] - 0.25) < 0.01, `expected quarter-width column: ${leaf.rect}`);
        // Process completion itself does not close panes: cleanup removes the owned resource.
        assert.equal((await pollForExit(children[1], new AbortController().signal, { interval: 25 })).exitCode, 0);
        closeSurface(children[1]);
        balanced = await waitForBalanced(session, windowId);
        const survivors = layoutLeaves(balanced.layers.find((l: any) => l.kind === "tiled").layout);
        assert.equal(survivors.length, 3);
        for (const leaf of survivors) assert.ok(Math.abs(leaf.rect[2] - 1 / 3) < 0.01);
        assert.deepEqual(balanced.layers.find((l: any) => l.layer_id === floating.layer_id), floatBefore);
        assert.deepEqual(rexJson(["window", "inspect", "-s", session, otherWindowId, "--json"]), otherBefore);
        const after = rexJson(["session", "inspect", session, "--json"]);
        assert.equal(after.active_window_id, originalActive);
        assert.equal(getFocusedSurface(), originalFocus);
      } finally {
        for (const block of floating.block_ids) {
          try { rexExec(["block", "close", "-s", session, block]); } catch {}
        }
      }
    });

    it("treats stale sizing layouts and resize failures as cosmetic during launch, exit, and cleanup", async () => {
      const top = mainSurface(env, "sizing-failure-target");
      sendLongCommand(top, "echo FAILURE_PARENT");
      const parent = getSurfaceHandle(top)!;
      const windowId = getSurfaceTab(top)!;
      let failedResizes = 0;
      // Delegate real surface operations, injecting only a cosmetic API failure.
      setRexExecutor((args) => {
        if (args[0] === "api" && args[2] === "session.resize_pane") {
          failedResizes++;
          throw new Error("bad_request: split changed since inspection");
        }
        return execFileSync(rexBin(), buildRexArgs(args), { encoding: "utf8", timeout: 5000 });
      });
      try {
        const first = createTrackedSurfaceSplit(env, "sizing-failure-first", "right", top);
        sendLongCommand(first, "echo FIRST_COMPLETE");
        const second = createTrackedSurfaceSplit(env, "sizing-failure-second", "right", top);
        sendLongCommand(second, "echo SECOND_COMPLETE");
        await sleep(250);
        assert.ok(failedResizes > 0);
        assert.equal((await pollForExit(second, new AbortController().signal, { interval: 25 })).reason, "done");
        assert.match(readScreen(second), /SECOND_COMPLETE/);
        closeSurface(second);
        // Close the fixture tab before its pending cosmetic inspection: stale tab is benign.
        closeSurface(first);
        closeSurface(top);
        scheduleTabSizing(parent.sessionId, windowId);
        await sleep(250);
        assert.equal(__rexTest__.sizingPassCount(), 0);
      } finally {
        disposeRexSurfaces();
        setRexExecutor(null);
      }
    });

    it("bounds large-output diagnostics without depending on scrollback for process completion", async () => {
      const surface = mainSurface(env, "large-output-fixture");
      sendLongCommand(surface, `for ((i=0;i<20000;i++)); do printf 'large-output-%08d abcdefghijklmnopqrstuvwxyz\\n' "$i"; done; echo LARGE_OUTPUT_TAIL`);
      const result = await pollForExit(surface, new AbortController().signal, { interval: 25 });
      assert.equal(result.reason, "done");
      const screen = await waitForScreen(surface, /LARGE_OUTPUT_TAIL/, 5000, 3);
      assert.ok(Buffer.byteLength(screen) <= 64 * 1024);
      assert.match(screen, /large-output-00019999/);
    });

    it("observes process completion, preserves real non-zero exit code, and handles interruption on closed pane", async () => {
      const { pollForExit, queryBlockProcess, closeSurface, getSurfaceHandle } = await import("../../pi-extension/subagents/rex.ts");

      // 1. Nonzero exit code propagation
      const failSurface = createTrackedSurface(env, "fail-exit");
      sendLongCommand(failSurface, "bash -c 'exit 42'");
      const failHandle = getSurfaceHandle(failSurface);
      assert.ok(failHandle?.blockId);

      const failResult = await pollForExit(failSurface, new AbortController().signal, { interval: 50 });
      assert.equal(failResult.reason, "error");
      assert.equal(failResult.exitCode, 42, "real non-zero exit code 42 must be preserved");

      // 2. Confirmed pane closure reports interruption
      const closeSurfaceTest = createTrackedSurface(env, "interrupt-test");
      sendLongCommand(closeSurfaceTest, "cat"); // Keep running
      const closeHandle = getSurfaceHandle(closeSurfaceTest);
      assert.ok(closeHandle?.blockId);

      // Verify running first
      await sleep(500);
      const procBefore = queryBlockProcess(closeHandle.blockId, closeHandle.sessionId);
      assert.notEqual(procBefore, "not_found");

      // Close the surface externally
      closeSurface(closeSurfaceTest);
      await sleep(500);

      const interruptResult = await pollForExit(closeSurfaceTest, new AbortController().signal, { interval: 50 });
      assert.equal(interruptResult.reason, "interrupted");
      assert.equal(interruptResult.exitCode, 1);
      assert.match(interruptResult.errorMessage ?? "", /closed externally/);
    });
  });
}
