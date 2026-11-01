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
} from "../../pi-extension/subagents/rex.ts";

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
