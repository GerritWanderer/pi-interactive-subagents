/**
 * Integration tests for the Rex surface layer.
 *
 * These tests exercise real Rex operations: reserving and starting blocks,
 * typing into them, pasting messages, reading their screens, polling for
 * exit, and closing them. No LLM calls — fast and free.
 *
 * Run from a shell inside a Rex terminal:
 *   npm run test:integration
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  getFocusedSurface,
  getSurfaceTab,
  surfaceBlock,
  untrackSurface,
  sendCommand,
  sendLongCommand,
  sendMessage,
  pollForExit,
  readScreen,
  readScreenAsync,
  closeSurface,
  sleep,
  uniqueId,
  waitForFile,
  waitForScreen,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();

if (backends.length === 0) {
  console.log("⚠️  Rex is not available — skipping rex-surface integration tests");
  console.log("   Run inside a Rex terminal to enable these tests.");
}

function poll(surface: string, timeoutMs = 20_000) {
  return pollForExit(surface, AbortSignal.timeout(timeoutMs), { interval: 200 });
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

    it("leaves focus where it was while creating and targeting subagent surfaces", async () => {
      const focusedBefore = getFocusedSurface();
      assert.ok(focusedBefore, "expected to read the focused block");

      const childA = createTrackedSurface(env, "focus-child-a");
      const childB = createTrackedSurface(env, "focus-child-b");

      const markerA = uniqueId();
      const markerB = uniqueId();
      sendCommand(childA, `echo "FOCUS_A_${markerA}"`);
      sendCommand(childB, `echo "FOCUS_B_${markerB}"`);

      await Promise.all([
        waitForScreen(childA, new RegExp(`FOCUS_A_${markerA}`), 20_000, 50),
        waitForScreen(childB, new RegExp(`FOCUS_B_${markerB}`), 20_000, 50),
      ]);
      assert.equal(getFocusedSurface(), focusedBefore);
    });

    it("opens a tab for a main-session subagent and keeps a nested subagent's child in that tab", async () => {
      const parentBlock = process.env.REX_BLOCK!;
      const parentTab = getSurfaceTab(parentBlock);
      assert.ok(parentTab, "expected to read the parent block's tab");

      const top = createTrackedSurface(env, "tab-top-level");
      const topTab = getSurfaceTab(top);
      assert.ok(topTab, "expected to read the new surface's tab");
      assert.notEqual(topTab, parentTab, "a main-session subagent must get its own tab");

      // A subagent spawning its own child is marked by PI_SUBAGENT_NAME and
      // splits its own block, so a lineage stays in one tab.
      const savedName = process.env.PI_SUBAGENT_NAME;
      const savedBlock = process.env.REX_BLOCK;
      try {
        process.env.PI_SUBAGENT_NAME = "tab-top-level";
        process.env.REX_BLOCK = surfaceBlock(top);
        const nested = createTrackedSurface(env, "tab-nested-child");
        assert.equal(getSurfaceTab(nested), topTab, "a nested subagent must stay in its parent's tab");
      } finally {
        if (savedName === undefined) delete process.env.PI_SUBAGENT_NAME;
        else process.env.PI_SUBAGENT_NAME = savedName;
        process.env.REX_BLOCK = savedBlock;
      }
    });

    it("starts a reserved surface directly on its launch script and reports pi's exit code", async () => {
      const surface = createTrackedSurface(env, "direct-launch");
      const marker = uniqueId();
      // The extension's launch scripts end with this sentinel; the script
      // itself exits 0 (the echo's status), so the code must come from it.
      sendLongCommand(surface, `echo "DIRECT_${marker}"; (exit 5); echo '__SUBAGENT_DONE_'$?'__'`);

      const result = await poll(surface);
      assert.deepEqual(result, { reason: "sentinel", exitCode: 5 });
      assert.match(readScreen(surface, 20), new RegExp(`DIRECT_${marker}`), "the block stays readable after exit");
    });

    it("falls back to the block's exit status when there is no sentinel", async () => {
      const surface = createTrackedSurface(env, "exit-status");
      sendLongCommand(surface, "exit 7");
      assert.deepEqual(await poll(surface), { reason: "sentinel", exitCode: 7 });
    });

    it("ends the run with an error when the block is closed by hand", async () => {
      const surface = createTrackedSurface(env, "closed-by-hand");
      sendLongCommand(surface, "sleep 30");
      const block = surfaceBlock(surface);
      await sleep(300);
      closeSurface(block); // what a person closing the pane does
      const result = await poll(surface);
      assert.equal(result.reason, "error");
      assert.match(result.errorMessage ?? "", /closed/);
      untrackSurface(env, surface);
    });

    it("delivers a message as one paste and refuses while the child reports blocked", async () => {
      const surface = createTrackedSurface(env, "paste-test");
      const script = join(env.dir, `child-${uniqueId()}.sh`);
      writeFileSync(
        script,
        [
          "st() { printf '\\e]7501;state=%s:app=pi-test\\e\\\\' \"$1\"; }",
          "st blocked",
          "IFS= read -r line",
          "echo \"GOT[$line]\"",
          "st working",
          "IFS= read -r line",
          "echo \"GOT[$line]\"",
          "sleep 30",
        ].join("\n") + "\n",
      );
      sendLongCommand(surface, `bash ${JSON.stringify(script)}`);
      await sleep(800);

      assert.throws(() => sendMessage(surface, "too early"), /agent_blocked/);
      // Unblock the child the way a person would: answer its prompt.
      sendCommand(surface, "answered");
      await waitForScreen(surface, /GOT\[answered\]/, 10_000, 20);

      const message = `use v2; it's "current" & $HOME stays literal`;
      sendMessage(surface, message);
      await waitForScreen(surface, /GOT\[use v2;/, 10_000, 20);
      assert.ok(readScreen(surface, 20).includes(`GOT[${message}]`), "the paste must arrive intact");
    });

    it("creates a surface, sends a command, reads output, and closes it", async () => {
      const surface = createTrackedSurface(env, "echo-test");
      await sleep(1000);

      const marker = uniqueId();
      sendCommand(surface, `echo "MARKER_${marker}"`);
      await sleep(1500);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`MARKER_${marker}`),
        `Expected screen to contain MARKER_${marker}. Got:\n${screen}`,
      );

      closeSurface(surface);
      untrackSurface(env, surface);
    });

    it("preserves shell special characters in echo output", async () => {
      const surface = createTrackedSurface(env, "escape-test");
      await sleep(1000);

      const marker = uniqueId();
      // Single-quoted string — $ and " are literal inside single quotes
      sendCommand(surface, `echo 'SPEC_${marker}_$HOME_"quotes"_done'`);
      await sleep(1500);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`SPEC_${marker}`),
        `Expected special-char output. Got:\n${screen}`,
      );
      // $ should be literal inside single quotes
      assert.ok(
        screen.includes("$HOME"),
        `Expected literal $HOME in output. Got:\n${screen}`,
      );
    });

    it("sends a long command via script file without truncation", async () => {
      const surface = createTrackedSurface(env, "long-cmd-test");
      await sleep(1000);

      const marker = uniqueId();
      const longValue = "X".repeat(500);
      const command = `echo "LONG_${marker}_${longValue}_END"`;

      sendLongCommand(surface, command);
      await sleep(2000);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`LONG_${marker}`),
        `Expected long command output. Got:\n${screen.slice(0, 300)}...`,
      );
      assert.ok(
        screen.includes("_END"),
        `Expected full output (not truncated). Got:\n${screen.slice(-300)}`,
      );
    });

    it("reads screen asynchronously", async () => {
      const surface = createTrackedSurface(env, "async-read-test");
      await sleep(1000);

      const marker = uniqueId();
      sendCommand(surface, `echo "ASYNC_${marker}"`);
      await sleep(1500);

      const screen = await readScreenAsync(surface, 50);
      assert.ok(
        screen.includes(`ASYNC_${marker}`),
        `Async read should find marker. Got:\n${screen}`,
      );
    });

    it("manages multiple surfaces concurrently", async () => {
      const s1 = createTrackedSurface(env, "multi-1");
      const s2 = createTrackedSurface(env, "multi-2");
      await sleep(1500);

      const m1 = uniqueId();
      const m2 = uniqueId();
      sendCommand(s1, `echo "S1_${m1}"`);
      sendCommand(s2, `echo "S2_${m2}"`);
      await sleep(1500);

      const screen1 = readScreen(s1, 50);
      const screen2 = readScreen(s2, 50);

      assert.ok(screen1.includes(`S1_${m1}`), `Surface 1 missing marker. Got:\n${screen1}`);
      assert.ok(screen2.includes(`S2_${m2}`), `Surface 2 missing marker. Got:\n${screen2}`);
    });

    it("writes output to a file and verifies via surface", async () => {
      const surface = createTrackedSurface(env, "file-test");
      await sleep(1000);

      const marker = uniqueId();
      const filePath = `/tmp/pi-rex-test-${marker}.txt`;

      sendCommand(surface, `echo "FILE_${marker}" > ${filePath} && echo "WRITTEN_${marker}"`);

      await waitForScreen(surface, new RegExp(`WRITTEN_${marker}`), 10_000, 50);
      const content = await waitForFile(filePath, 10_000, new RegExp(`FILE_${marker}`));
      assert.ok(content.includes(`FILE_${marker}`), `File content wrong. Got: ${content}`);

      // Clean up
      try {
        unlinkSync(filePath);
      } catch {}
    });
  });
}
