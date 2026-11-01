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

      const top = createTrackedSurface(env, "tab-top-level");
      const topMarker = uniqueId();
      sendLongCommand(top, `echo "TOP_${topMarker}"`);
      await waitForScreen(top, new RegExp(`TOP_${topMarker}`), 10_000, 20);

      const topTab = getSurfaceTab(top);
      assert.ok(topTab, "expected to read top surface window id");

      // Spawning nested subagent with PI_SUBAGENT_NAME set
      const savedName = process.env.PI_SUBAGENT_NAME;
      const savedBlock = process.env.REX_BLOCK;
      try {
        process.env.PI_SUBAGENT_NAME = "tab-top-level";
        // simulate nested spawner inside top surface's block
        const handle = (await import("../../pi-extension/subagents/rex.ts")).getSurfaceHandle(top);
        assert.ok(handle?.blockId, "top handle should have a blockId");
        process.env.REX_BLOCK = handle.blockId;

        const nested = createTrackedSurface(env, "tab-nested-child");
        const nestedMarker = uniqueId();
        sendLongCommand(nested, `echo "NESTED_${nestedMarker}"`);
        await waitForScreen(nested, new RegExp(`NESTED_${nestedMarker}`), 10_000, 20);

        const nestedTab = getSurfaceTab(nested);
        assert.equal(nestedTab, topTab, "nested child must share its parent's window");
      } finally {
        if (savedName === undefined) delete process.env.PI_SUBAGENT_NAME;
        else process.env.PI_SUBAGENT_NAME = savedName;
        process.env.REX_BLOCK = savedBlock;
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
      process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = "pane";
      try {
        const topPane = createTrackedSurface(env, "top-pane-override");
        const marker = uniqueId();
        sendLongCommand(topPane, `echo "TOP_PANE_${marker}"`);
        await waitForScreen(topPane, new RegExp(`TOP_PANE_${marker}`), 10_000, 20);

        const handle = (await import("../../pi-extension/subagents/rex.ts")).getSurfaceHandle(topPane);
        assert.equal(handle?.kind, "split", "override should create split instead of tab");
      } finally {
        if (savedOverride === undefined) delete process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
        else process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = savedOverride;
      }
    });

    it("launches command with special-character arguments and paths", async () => {
      const surface = createTrackedSurface(env, "special-chars");
      const specialArg = "arg with spaces and 'quotes' & $METACHARED";
      sendLongCommand(surface, `echo "SPECIAL: ${specialArg}"`);

      await waitForScreen(surface, /SPECIAL: arg with spaces and 'quotes'/, 10_000, 20);
    });
  });
}
