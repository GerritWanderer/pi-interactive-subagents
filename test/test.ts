import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  visibleWidth, detectCapabilities, getCapabilities, setCapabilityOverrides,
  resetCapabilitiesCache, getTerminalColorMode, hyperlink,
} from "@earendil-works/pi-tui";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

import {
  getLeafId,
  getNewEntries,
  countSessionEntryLines,
  getSessionId,
  readNameRegistry,
  readSubagentLoadout,
  registerName,
  resolveNameInRegistry,
  nameRegistryPath,
  writeSubagentLoadout,
  loadoutSidecarPath,
  type SubagentLoadout,
  resetSessionIndexCache,
  resolveSessionFileById,
  findLastAssistantMessage,
  appendBranchSummary,
  copySessionFile,
  mergeNewEntries,
  seedSubagentSessionFile,
  summarizeSessionStats,
} from "../pi-extension/subagents/session.ts";

import {
  shellEscape, __rexTest__, disposeRexSurfaces, registerSurfaceHandle, unregisterSurfaceHandle,
} from "../pi-extension/subagents/rex.ts";
import { planEqualShares, type RexLayoutNode } from "../pi-extension/subagents/rex-sizing.ts";
import { createTestEnv, cleanupTestEnv, TEST_MODEL } from "./integration/harness.ts";

// A cosmetic timer from one fixture must not run with the next fixture's executor.
afterEach(() => disposeRexSurfaces());
import {
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatStatusLine,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
  parseStatusConfig,
} from "../pi-extension/subagents/status.ts";
import {
  createSubagentActivityRecorder,
  getSubagentActivityFile,
  readSubagentActivityFile,
} from "../pi-extension/subagents/activity.ts";
import {
  shouldMarkUserTookOver,
  shouldAutoExitOnAgentEnd,
  findLatestAssistantError,
  runningChildrenCount,
} from "../pi-extension/subagents/subagent-done.ts";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import safeBashExtension from "../pi-extension/subagents/tools/safe-bash.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

function withTempDir(run: (dir: string) => void) {
  const dir = createTestDir();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const registeredCommands: Array<any> = [];
  const registeredMessageRenderers: Array<any> = [];
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    sentUserMessages,
    sentMessages,
    api: {
      on() {},
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerShortcut() {},
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options });
      },
      getAllTools() {
        return [];
      },
    } as any,
  };
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function withMockedNow<T>(now: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSubagentAllowed = process.env.PI_SUBAGENT_ALLOWED;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;
  delete process.env.PI_SUBAGENT_ALLOWED;

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
    restoreEnvVar("PI_SUBAGENT_ALLOWED", previousSubagentAllowed);
    rmSync(root, { recursive: true, force: true });
  }
}
const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });

    it("countSessionEntryLines matches getNewEntries(0).length without parsing", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(countSessionEntryLines(file), getNewEntries(file, 0).length);
      assert.equal(countSessionEntryLines(file), 4);
    });

    it("countSessionEntryLines ignores blank lines and returns 0 for missing files", () => {
      const file = join(dir, "blanks.jsonl");
      writeFileSync(file, JSON.stringify({ type: "session", id: "x" }) + "\n\n\n");
      assert.equal(countSessionEntryLines(file), 1);
      assert.equal(countSessionEntryLines(join(dir, "does-not-exist.jsonl")), 0);
    });
  });

  describe("getSessionId / resolveSessionFileById", () => {
    function writeSession(d: string, fname: string, id: string): string {
      const p = join(d, fname);
      writeFileSync(p, JSON.stringify({ type: "session", id, version: 3 }) + "\n");
      return p;
    }

    // The resolver caches an id→file index per root; reset it so each test
    // builds a fresh index from the current on-disk state.
    beforeEach(() => {
      resetSessionIndexCache();
    });

    it("reads the header id from a session file", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG]);
      assert.equal(getSessionId(file), "sess-001");
    });

    it("returns null for a file without a session header", () => {
      const file = createSessionFile(dir, [USER_MSG]);
      assert.equal(getSessionId(file), null);
    });

    it("resolves a session file by exact id under the root", () => {
      const a = writeSession(dir, "a.jsonl", "019f-aaaa");
      writeSession(dir, "b.jsonl", "019f-bbbb");
      assert.equal(resolveSessionFileById("019f-aaaa", dir), a);
    });

    it("resolves a session file by id prefix", () => {
      const a = writeSession(dir, "p.jsonl", "019f-prefix-match");
      assert.equal(resolveSessionFileById("019f-prefix", dir), a);
    });

    it("returns null when no session matches", () => {
      writeSession(dir, "c.jsonl", "abc");
      assert.equal(resolveSessionFileById("zzz", dir), null);
    });

    it("picks up newly added sessions on repeat calls without a reset", () => {
      // Prime the index (first call builds it).
      writeSession(dir, "first.jsonl", "id-first");
      assert.equal(resolveSessionFileById("id-first", dir) !== null, true);
      // Add a new session AFTER the index was built — no reset. The resolver's
      // cheap refresh should index it.
      const b = writeSession(dir, "second.jsonl", "id-second");
      assert.equal(resolveSessionFileById("id-second", dir), b);
    });
  });

  describe("subagent loadout snapshot", () => {
    const sample: SubagentLoadout = {
      agent: "worker",
      toolAllowlist: "read,write,edit,safe_bash,web_search,subagent,ask_question",
      model: "openrouter/z-ai/glm-5.2",
      thinking: "medium",
      systemPromptMode: "append",
      identity: "You are a worker agent.",
      spawnable: ["scout", "researcher"],
      autoExit: true,
      cwd: "/work/dir",
      agentDir: "/home/u/.pi/agent",
    };

    it("writes the sidecar next to the session file", () => {
      const sf = join(dir, "s1.jsonl");
      writeSubagentLoadout(sf, sample);
      assert.equal(loadoutSidecarPath(sf), sf + ".loadout.json");
      assert.ok(existsSync(sf + ".loadout.json"));
    });

    it("round-trips the full loadout", () => {
      const sf = join(dir, "s2.jsonl");
      writeSubagentLoadout(sf, sample);
      assert.deepEqual(readSubagentLoadout(sf), sample);
    });

    it("returns null when the sidecar is absent", () => {
      assert.equal(readSubagentLoadout(join(dir, "missing.jsonl")), null);
    });

    it("returns null when the sidecar is corrupt", () => {
      const sf = join(dir, "s3.jsonl");
      writeFileSync(sf + ".loadout.json", "not json{", "utf8");
      assert.equal(readSubagentLoadout(sf), null);
    });
  });

  describe("subagent name registry", () => {
    it("registers and resolves a name to its session file", () => {
      const adir = join(dir, "art-1");
      registerName(adir, "worker", { sessionFile: "/s/worker.jsonl", sessionId: "id-worker" });
      const entry = resolveNameInRegistry(adir, "worker");
      assert.deepEqual(entry, { sessionFile: "/s/worker.jsonl", sessionId: "id-worker" });
      assert.ok(existsSync(nameRegistryPath(adir)));
    });

    it("accumulates multiple names and overwrites on re-register", () => {
      const adir = join(dir, "art-2");
      registerName(adir, "scout", { sessionFile: "/s/scout.jsonl", sessionId: "id-scout" });
      registerName(adir, "scout-2", { sessionFile: "/s/scout2.jsonl", sessionId: "id-scout2" });
      const reg = readNameRegistry(adir);
      assert.deepEqual(Object.keys(reg).sort(), ["scout", "scout-2"]);
      // Overwrite scout with a new session file.
      registerName(adir, "scout", { sessionFile: "/s/scout-new.jsonl", sessionId: "id-scout-new" });
      assert.equal(resolveNameInRegistry(adir, "scout")!.sessionFile, "/s/scout-new.jsonl");
    });

    it("returns null for unknown names and {} for a missing/corrupt registry", () => {
      const adir = join(dir, "art-3");
      assert.equal(resolveNameInRegistry(adir, "nope"), null);
      assert.deepEqual(readNameRegistry(adir), {});
      mkdirSync(adir, { recursive: true });
      writeFileSync(nameRegistryPath(adir), "not json{", "utf8");
      assert.deepEqual(readNameRegistry(adir), {});
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });

    it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
      // Reproduces the overload-exhaustion case: an earlier turn looked
      // normal, then the provider went 529 and auto-retry gave up. Without
      // the errorMessage fallback we'd return the stale earlier summary and
      // the orchestrator would believe the subagent completed.
      const earlierGood = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Investigating the bug..." }],
        },
      };
      const overloadError = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Anthropic 529 Overloaded after 3 retries",
        },
      };
      const entries = [earlierGood, overloadError] as any[];
      assert.equal(
        findLastAssistantMessage(entries),
        "Subagent error: Anthropic 529 Overloaded after 3 retries",
      );
    });

    it("prefers text content even when an error stopReason is set", () => {
      // If the model produced text before the error (rare but possible), we
      // prefer the actual content over the synthetic error fallback.
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is partial output." }],
          stopReason: "error",
          errorMessage: "stream interrupted",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), "Here is partial output.");
    });

    it("does not invent a summary for a stop=error message with no errorMessage", () => {
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), null);
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("seedSubagentSessionFile", () => {
    it("creates a lineage-only child session with parent linkage and no copied turns", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "lineage-child.jsonl");

      seedSubagentSessionFile({
        mode: "lineage-only",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/child-cwd",
      });

      const lines = readFileSync(childFile, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);

      const header = JSON.parse(lines[0]);
      assert.equal(header.type, "session");
      assert.equal(header.parentSession, parentFile);
      assert.equal(header.cwd, "/tmp/child-cwd");
    });

    it("creates a forked child session with copied context before the triggering user turn", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "fork-child.jsonl");

      seedSubagentSessionFile({
        mode: "fork",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/fork-child-cwd",
      });

      const entries = readFileSync(childFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries.length, 2);
      assert.equal(entries[0].type, "session");
      assert.equal(entries[0].parentSession, parentFile);
      assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
      assert.equal(entries[1].type, "model_change");
      assert.equal(entries.some((entry) => entry.type === "session" && entry.parentSession !== parentFile), false);
      assert.equal(entries.some((entry) => entry.type === "message"), false);
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        [SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      writeFileSync(
        targetFile,
        [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });

  describe("summarizeSessionStats", () => {
    const asstWithUsage = (id: string, opts: {
      model?: string;
      tools?: string[];
      usage?: Record<string, unknown>;
    }) => ({
      type: "message",
      id,
      parentId: "user-001",
      message: {
        role: "assistant",
        ...(opts.model ? { model: opts.model } : {}),
        content: [
          { type: "text", text: "ok" },
          ...(opts.tools ?? []).map((name, i) => ({ type: "toolCall", name, id: `${id}-tc${i}` })),
        ],
        ...(opts.usage ? { usage: opts.usage } : {}),
      },
    });

    it("aggregates tokens/cost cumulatively and tracks last context size", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        { type: "model_change", id: "mc-001", parentId: null, modelId: "claude-sonnet-4-6" },
        USER_MSG,
        asstWithUsage("a1", {
          tools: ["read", "grep"],
          usage: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200, totalTokens: 1350, cost: { total: 0.01 } },
        }),
        asstWithUsage("a2", {
          tools: ["write"],
          usage: { input: 30, output: 70, cacheRead: 2000, cacheWrite: 0, totalTokens: 3500, cost: { total: 0.02 } },
        }),
      ]);
      const stats = summarizeSessionStats(file)!;
      assert.equal(stats.model, "claude-sonnet-4-6");
      assert.equal(stats.toolCount, 3);
      assert.equal(stats.inputTokens, 130);
      assert.equal(stats.outputTokens, 120);
      assert.equal(stats.cacheReadTokens, 3000);
      assert.equal(stats.cacheWriteTokens, 200);
      // contextTokens is the LAST assistant turn's totalTokens, not the sum.
      assert.equal(stats.contextTokens, 3500);
      assert.ok(Math.abs(stats.cost - 0.03) < 1e-9);
    });

    it("prefers per-message model over model_change", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        { type: "model_change", id: "mc-001", parentId: null, modelId: "claude-haiku-4-5" },
        asstWithUsage("a1", { model: "claude-sonnet-4-6", usage: { totalTokens: 10, cost: { total: 0 } } }),
      ]);
      assert.equal(summarizeSessionStats(file)!.model, "claude-sonnet-4-6");
    });

    it("handles missing usage gracefully", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const stats = summarizeSessionStats(file)!;
      assert.equal(stats.toolCount, 0);
      assert.equal(stats.inputTokens, 0);
      assert.equal(stats.cost, 0);
      assert.equal(stats.contextTokens, 0);
    });

    it("returns null for an unreadable file", () => {
      assert.equal(summarizeSessionStats(join(dir, "does-not-exist.jsonl")), null);
    });
  });
});

describe("status.ts", () => {
  it("parses strict config objects", () => {
    const disabled = parseStatusConfig({ status: { enabled: false } });

    assert.deepEqual(disabled, {
      enabled: false,
      lineLimit: 4,
    });
  });

  it("loads a valid config file", () => {
    const examplePath = fileURLToPath(new URL("../config.json.example", import.meta.url));
    const config = loadStatusConfig(examplePath);

    assert.deepEqual(config, {
      enabled: true,
      lineLimit: 4,
    });
  });

  it("loads the shared example when local config is absent", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      const config = loadStatusConfig(join(dir, "config.json"), examplePath);

      assert.deepEqual(config, {
        enabled: true,
        lineLimit: 4,
      });
    });
  });

  it("fails fast for invalid config shapes", () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: "false" } }),
      /status\.enabled must be a boolean/,
    );
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true, defaultCadenceSeconds: 60 } }),
      /status has unsupported key\(s\): defaultCadenceSeconds/,
    );
  });

  it("reports when neither local nor shared config exists", () => {
    withTempDir((dir) => {
      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), join(dir, "config.json.example")),
        /Missing subagent status config\. Expected .*config\.json.*or.*config\.json\.example/,
      );
    });
  });

  it("reports invalid JSON from the shared example path", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, "{\n");

      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), examplePath),
        /Invalid JSON in subagent config .*config\.json\.example/,
      );
    });
  });

  it("fails on invalid local config instead of falling back to the shared example", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(configPath, "{\n");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      assert.throws(
        () => loadStatusConfig(configPath, examplePath),
        /Invalid JSON in subagent config .*config\.json/,
      );
    });
  });

  it("keeps a missing snapshot as starting until the fixed watchdog threshold", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    assert.equal(classifyStatus(state, 60_999).kind, "starting");
    const stalled = classifyStatus(state, 61_000);
    assert.equal(stalled.kind, "stalled");
    assert.equal(stalled.statusLabel, null);
  });

  it("classifies active snapshots without aging into stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
      latestEvent: "tool_execution_start",
    }, 5_000);

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.activityLabel, "bash");
    assert.equal(snapshot.activeDurationText, "3m");
  });

  it("classifies waiting snapshots as healthy idle without becoming stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_000);

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.waitingDurationText, "3m");
  });

  it("uses elapsed-only fallback for claude-backed subagents", () => {
    const state = createStatusState({ source: "claude", startTimeMs: 0 });
    const snapshot = classifyStatus(state, 125_000);

    assert.equal(snapshot.kind, "running");
    assert.equal(snapshot.elapsedText, "2m");
  });

  it("detects stalled transitions and recovery", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    let advanced = advanceStatusState(state, 95_000);
    assert.equal(advanced.transition, "stalled");
    assert.equal(advanced.snapshot.kind, "stalled");

    state = observeStatus(advanced.nextState, {
      snapshot: "present",
      updatedAt: 96_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 96_000,
      latestEvent: "agent_end",
    }, 96_000);
    advanced = advanceStatusState(state, 97_000);
    assert.equal(advanced.transition, "recovered");
    assert.equal(advanced.snapshot.kind, "waiting");
  });

  it("keeps the last healthy kind during transient snapshot loss", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 5_000,
    }, 5_000);
    state = advanceStatusState(state, 6_000).nextState;
    state = observeStatus(state, { snapshot: "missing" }, 10_000);

    const snapshot = classifyStatus(state, 20_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("forces an active state to waiting after interrupt", () => {
    const now = 20_000;
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);

    assert.equal(classifyStatus(state, now).kind, "active");

    const forced = forceStatusAfterInterrupt(state, now);
    const snapshot = classifyStatus(forced, now);

    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");
    assert.equal(snapshot.waitingDurationText, "0s");
    assert.equal(forced.activeNow, false);
  });

  it("orders same-millisecond snapshots by sequence", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 10_000,
      activityLabel: "bash",
    }, 10_000);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 3,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_001);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.latestEvent, "agent_end");
  });

  it("recovers from a transient snapshot read failure with the same valid snapshot", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = observeStatus(state, { snapshot: "missing" }, 10_000);
    assert.equal(classifyStatus(state, 10_000).statusLabel, null);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 11_000);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("ignores stale and exact old snapshots after interrupt and accepts newer snapshots", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = forceStatusAfterInterrupt(state, 20_000);

    const stale = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 21_000);
    let snapshot = classifyStatus(stale, 21_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const sameTimestamp = observeStatus(stale, {
      snapshot: "present",
      updatedAt: 20_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 20_000,
      activityLabel: "bash",
    }, 22_000);
    snapshot = classifyStatus(sameTimestamp, 22_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const resumed = observeStatus(sameTimestamp, {
      snapshot: "present",
      sequence: 2,
      updatedAt: 25_000,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 25_000,
      activityLabel: "streaming",
    }, 25_000);
    snapshot = classifyStatus(resumed, 25_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(resumed.activeScope, "streaming");
  });

  it("normalizes and truncates long newline-heavy names", () => {
    const longName = `Worker\n\n${"very-long-name-".repeat(12)}`;
    const stalledState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "missing" },
      1_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 299_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 299_000,
        activityLabel: "write",
      },
      299_000,
    );
    const line = formatStatusLine(longName, classifyStatus(stalledState, 240_000));
    const recovered = formatTransitionLine(longName, classifyStatus(activeState, 300_000), "recovered");

    assert.doesNotMatch(line, /\n/);
    assert.doesNotMatch(recovered, /\n/);
    assert.ok(line.length <= 120, `expected bounded line length, got ${line.length}`);
    assert.ok(recovered.length <= 120, `expected bounded line length, got ${recovered.length}`);
  });

  it("caps visible status lines and reports overflow consistently", () => {
    const waitingState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "present", updatedAt: 180_000, sequence: 1, phase: "waiting", waitingSince: 180_000 },
      180_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 419_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 419_000,
        activityLabel: "bash",
      },
      419_000,
    );
    const waitingLine = formatStatusLine("Worker", classifyStatus(waitingState, 300_000));
    const recoveredLine = formatTransitionLine("Worker", classifyStatus(activeState, 420_000), "recovered");
    const lines = [waitingLine, recoveredLine, "Scout running 2m.", "Reviewer running 4m.", "Planner running 6m."];
    const capped = capStatusLines(lines, 3);
    const aggregate = formatStatusAggregate(lines, 3);

    assert.equal(waitingLine, "Worker running 5m, waiting 2m.");
    assert.equal(recoveredLine, "Worker running 7m, recovered; active (bash 1s).");
    assert.deepEqual(capped.visibleLines, [waitingLine, recoveredLine, "Scout running 2m."]);
    assert.equal(capped.overflow, 2);
    assert.match(aggregate, /^Subagent status:/);
    assert.match(aggregate, /\+2 more running\./);
    assert.doesNotMatch(aggregate, /\/tmp|\.jsonl/);
  });
});

describe("subagent discovery", () => {
  const testApi = (subagentsModule as any).__test__;

  it("loads session-mode from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "lineage-mode-test-agent",
        [
          "name: lineage-mode-test-agent",
          "model: anthropic/test-lineage",
          "session-mode: lineage-only",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, "lineage-only");
    });
  });

  it("loads explicit interactive flag from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-true-test-agent",
        [
          "name: interactive-true-test-agent",
          "model: anthropic/test-interactive-true",
          "interactive: true",
        ].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "interactive-false-test-agent",
        [
          "name: interactive-false-test-agent",
          "model: anthropic/test-interactive-false",
          "interactive: false",
        ].join("\n"),
      );

      const loadedTrue = testApi.loadAgentDefaults("interactive-true-test-agent");
      assert.equal(loadedTrue?.interactive, true);

      const loadedFalse = testApi.loadAgentDefaults("interactive-false-test-agent");
      assert.equal(loadedFalse?.interactive, false);
    });
  });

  it("leaves interactive undefined when not set in frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-unset-test-agent",
        [
          "name: interactive-unset-test-agent",
          "model: anthropic/test-interactive-unset",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("interactive-unset-test-agent");
      assert.equal(loaded?.interactive, undefined);
    });
  });

  it("resolveEffectiveInteractive defaults to the inverse of auto-exit", () => {
    // Autonomous agents (auto-exit: true) are NOT interactive — parent gets stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: true }),
      false,
    );
    // Agents without auto-exit ARE interactive — parent does not receive status transition pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: false }),
      true,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, {}),
      true,
    );
    // Bare spawn with no agent defs (e.g. /iterate fork) is interactive by default.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, null),
      true,
    );
  });

  it("resolveEffectiveInteractive honors explicit frontmatter over the auto-exit default", () => {
    // Autonomous agent that still wants to be treated as interactive.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { autoExit: true, interactive: true },
      ),
      true,
    );
    // Non-auto-exit agent that opts back into stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { interactive: false },
      ),
      false,
    );
  });

  it("bundled scout/researcher/worker all resolve as non-interactive (auto-exit)", () => {
    for (const name of ["scout", "researcher", "worker"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(
        testApi.resolveEffectiveInteractive({ name, task: "" }, defs),
        false,
        `${name} should resolve as non-interactive (autonomous, auto-exit)`,
      );
    }
  });

  it("worker is granted the spawning toolset restricted to scout and researcher", () => {
    const worker = testApi.loadAgentDefaults("worker");
    assert.ok(worker, "expected bundled worker to be discoverable");
    assert.deepEqual(worker.subagentAgents, ["scout", "researcher"]);

    const allowlist = testApi.buildSubagentToolAllowlist(worker.tools, { grantSpawning: true });
    assert.ok(allowlist, "expected an allowlist");
    const tools = new Set(allowlist!.split(","));
    for (const t of ["subagent", "subagent_message", "subagents_list"]) {
      assert.ok(tools.has(t), `expected spawning tool ${t} in worker allowlist`);
    }
    assert.ok(tools.has("bash"), "expected worker to keep bash");
  });

  it("scout and researcher are not granted spawning tools", () => {
    for (const name of ["scout", "researcher"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(defs.subagentAgents, undefined, `${name} should not declare subagent_agents`);
    }
  });

  it("getToolExtensionPath maps custom tools and skips built-ins", async () => {
    await withIsolatedAgentEnv(({ globalDir }) => {
      const webSearchDir = join(globalDir, "extensions", "web-search");
      mkdirSync(webSearchDir, { recursive: true });
      writeFileSync(join(webSearchDir, "index.ts"), "");

      assert.equal(testApi.getToolExtensionPath("read"), undefined);
      assert.equal(testApi.getToolExtensionPath("bash"), undefined);
      assert.ok(testApi.getToolExtensionPath("web_search")?.endsWith("web-search/index.ts"));
      assert.ok(testApi.getToolExtensionPath("safe_bash")?.endsWith("tools/safe-bash.ts"));
      // Spawning tools are registered by this extension itself.
      assert.ok(testApi.getToolExtensionPath("subagent")?.endsWith("index.ts"));
    });
  });

  it("ignores invalid session-mode values", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "invalid-mode-test-agent",
        [
          "name: invalid-mode-test-agent",
          "model: anthropic/test-invalid",
          "session-mode: sideways",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, undefined);
    });
  });

  it("resolves session mode from frontmatter (standalone default)", () => {
    assert.equal(testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, null), "standalone");
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      "lineage-only",
    );
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "fork" }),
      "fork",
    );
  });

  it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
    assert.deepEqual(testApi.resolveLaunchBehavior({ name: "A", task: "T" }, null), {
      sessionMode: "standalone",
      seededSessionMode: null,
      inheritsConversationContext: false,
      taskDelivery: "artifact",
    });
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      {
        sessionMode: "lineage-only",
        seededSessionMode: "lineage-only",
        inheritsConversationContext: false,
        taskDelivery: "artifact",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "fork" }),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
  });

  it("buildSubagentToolAllowlist preserves requested tools and adds child control tools", () => {
    assert.equal(
      testApi.buildSubagentToolAllowlist("read,bash,web_search"),
      "read,bash,web_search,ask_question",
    );
  });

  it("buildSubagentToolAllowlist returns null without an explicit tool restriction", () => {
    assert.equal(testApi.buildSubagentToolAllowlist(undefined), null);
    assert.equal(testApi.buildSubagentToolAllowlist(""), null);
  });

  it("applySandboxToParts replays model, identity, and default-deny tool restriction", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: "worker",
          toolAllowlist: "read,write,safe_bash",
          model: "openrouter/z-ai/glm-5.2",
          thinking: "medium",
          systemPromptMode: "append",
          identity: "You are a worker.",
          spawnable: ["scout"],
          autoExit: true,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "worker" },
      );
      const joined = parts.join(" ");
      // Model with thinking suffix.
      assert.ok(joined.includes("--model"), "expected --model");
      assert.ok(joined.includes("openrouter/z-ai/glm-5.2:medium"), "expected model:thinking");
      // Identity written to a file and appended.
      assert.ok(joined.includes("--append-system-prompt"), "expected --append-system-prompt");
      // Default-deny restriction.
      assert.ok(parts.includes("--no-extensions"), "expected --no-extensions");
      const toolsIdx = parts.indexOf("--tools");
      assert.ok(toolsIdx >= 0, "expected --tools");
      // The value is shell-escaped (single-quoted) before joining.
      assert.ok(
        parts[toolsIdx + 1].includes("read,write,safe_bash"),
        "expected the tool allowlist as the --tools value",
      );
    });
  });

  // `--no-extensions` re-enables only extensions that back a whitelisted tool.
  // pi-anthropic-auth backs none: it wraps the Anthropic transport so a Claude
  // Pro/Max OAuth token bills against the subscription. Left out, an anthropic/
  // child dies on its first provider request with "You're out of extra usage".
  function withAnthropicAuthConfigDir(
    credentials: unknown,
    run: (authExtPath: string) => void,
    opts: { installed?: boolean } = {},
  ) {
    withTempDir((dir) => {
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = dir;
      const authExtPath = join(dir, "npm", "node_modules", "@gotgenes", "pi-anthropic-auth", "src", "index.ts");
      if (opts.installed !== false) {
        mkdirSync(dirname(authExtPath), { recursive: true });
        writeFileSync(authExtPath, "export default () => {};", "utf8");
      }
      writeFileSync(join(dir, "auth.json"), JSON.stringify(credentials), "utf8");
      try {
        run(authExtPath);
      } finally {
        restoreEnvVar("PI_CODING_AGENT_DIR", previous);
      }
    });
  }

  function sandboxPartsForModel(model: string, artifactDir: string): string[] {
    const parts: string[] = [];
    testApi.applySandboxToParts(
      parts,
      {
        agent: "worker",
        toolAllowlist: "read,write",
        model,
        thinking: "high",
        systemPromptMode: "append",
        identity: "You are a worker.",
        spawnable: null,
        autoExit: true,
        cwd: null,
        agentDir: null,
      },
      { artifactDir, name: "worker" },
    );
    return parts;
  }

  it("applySandboxToParts loads pi-anthropic-auth for an Anthropic OAuth child", () => {
    withAnthropicAuthConfigDir({ anthropic: { type: "oauth", access: "sk-ant-oat01-token" } }, (authExtPath) => {
      withTempDir((artifactDir) => {
        const parts = sandboxPartsForModel("anthropic/claude-opus-5", artifactDir);
        assert.ok(
          parts.join(" ").includes(authExtPath),
          "expected the subscription auth extension to be passed with -e, without it the child 400s on extra usage",
        );
      });
    });
  });

  it("applySandboxToParts leaves non-Anthropic children untouched", () => {
    withAnthropicAuthConfigDir({ anthropic: { type: "oauth", access: "sk-ant-oat01-token" } }, (authExtPath) => {
      withTempDir((artifactDir) => {
        const parts = sandboxPartsForModel("openrouter/z-ai/glm-5.3", artifactDir);
        assert.ok(
          !parts.join(" ").includes(authExtPath),
          "expected no Anthropic auth extension for a non-Anthropic provider",
        );
      });
    });
  });

  it("applySandboxToParts skips pi-anthropic-auth when the Anthropic credential is an API key", () => {
    withAnthropicAuthConfigDir({ anthropic: { type: "api", access: "sk-ant-api03-key" } }, (authExtPath) => {
      withTempDir((artifactDir) => {
        const parts = sandboxPartsForModel("anthropic/claude-opus-5", artifactDir);
        assert.ok(
          !parts.join(" ").includes(authExtPath),
          "expected API-key traffic to stay on pi's normal path, the extension only shapes OAuth",
        );
      });
    });
  });

  it("applySandboxToParts still launches when pi-anthropic-auth is not installed", () => {
    withAnthropicAuthConfigDir(
      { anthropic: { type: "oauth", access: "sk-ant-oat01-token" } },
      (authExtPath) => {
        withTempDir((artifactDir) => {
          const parts = sandboxPartsForModel("anthropic/claude-opus-5", artifactDir);
          assert.ok(!parts.join(" ").includes(authExtPath), "expected no -e for an absent package");
          assert.ok(parts.includes("--no-extensions"), "expected the sandbox to be built regardless");
        });
      },
      { installed: false },
    );
  });

  it("applySandboxToParts omits restriction flags when the loadout was unrestricted", () => {
    withTempDir((d) => {
      const parts: string[] = [];
      testApi.applySandboxToParts(
        parts,
        {
          agent: null,
          toolAllowlist: null,
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          autoExit: false,
          cwd: null,
          agentDir: null,
        },
        { artifactDir: d, name: "fork" },
      );
      assert.deepEqual(parts, []);
    });
  });

  it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review,lint", taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["", "/skill:review", "/skill:lint", "@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: undefined, taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for direct launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review", taskDelivery: "direct", taskArg: "do the task" }),
      ["/skill:review", "do the task"],
    );
  });

  it("lists visible agents from discovery", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "visible-discovery-test-agent",
        [
          "name: visible-discovery-test-agent",
          "description: Visible test agent",
          "model: anthropic/test-visible",
        ].join("\n"),
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.ok(agents.some((agent: any) => agent.name === "visible-discovery-test-agent"));
      assert.match(result.content[0].text, /visible-discovery-test-agent/);
    });
  });

  it("hides disable-model-invocation agents from listings but keeps direct loading", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "hidden-discovery-test-agent",
        [
          "name: hidden-discovery-test-agent",
          "description: Hidden test agent",
          "model: anthropic/test-hidden",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "hidden-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /hidden-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
      assert.ok(loaded, "expected hidden agent to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-hidden");
      assert.equal(loaded.body, "You are the hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("lets a hidden project agent shadow a visible global agent", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Global visible agent",
          "model: anthropic/test-global",
        ].join("\n"),
        "You are the global visible agent.",
      );
      writeAgentFile(
        projectAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Project hidden agent",
          "model: anthropic/test-project",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the project hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "shadowed-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /shadowed-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("shadowed-discovery-test-agent");
      assert.ok(loaded, "expected project override to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-project");
      assert.equal(loaded.body, "You are the project hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });
});
describe("subagent-done.ts", () => {
  describe("shouldMarkUserTookOver", () => {
    it("ignores the initial injected task before the first agent run", () => {
      assert.equal(shouldMarkUserTookOver(false), false);
    });

    it("treats later input as manual takeover", () => {
      assert.equal(shouldMarkUserTookOver(true), true);
    });
  });

  describe("shouldAutoExitOnAgentEnd", () => {
    it("auto-exits after normal completion when there was no takeover", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });

    it("auto-exits after normal completion even when the user sent the prompt", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(true, messages), true);
    });

    it("stays open after Escape aborts the run", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
    });

    it("still exits when the latest turn ended with stopReason=error", () => {
      // Auto-exit subagents must shut down on retry-exhaustion errors so the
      // parent is woken. The error sidecar (written separately) carries the
      // failure detail; staying open would just strand the worker.
      const messages = [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });
  });

  describe("findLatestAssistantError", () => {
    it("returns the error info from a stopReason=error message", () => {
      const messages = [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
        { role: "toolResult", content: [] },
        { role: "assistant", stopReason: "error", errorMessage: "Anthropic 529 Overloaded" },
      ];
      assert.deepEqual(findLatestAssistantError(messages), {
        errorMessage: "Anthropic 529 Overloaded",
        stopReason: "error",
      });
    });

    it("returns null when the latest assistant turn completed normally", () => {
      const messages = [
        { role: "assistant", stopReason: "error", errorMessage: "old failure" },
        { role: "user", content: [] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("returns null when the latest assistant turn was aborted by the user", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
      const messages = [{ role: "assistant", stopReason: "error" }];
      const info = findLatestAssistantError(messages);
      assert.ok(info);
      assert.equal(info!.stopReason, "error");
      assert.match(info!.errorMessage, /stopReason=error/);
    });

    it("returns null when messages is undefined or empty", () => {
      assert.equal(findLatestAssistantError(undefined), null);
      assert.equal(findLatestAssistantError([]), null);
    });
  });

  describe("runningChildrenCount", () => {
    const KEY = Symbol.for("pi-subagents/running-children-count");
    function withGlobal(value: unknown, run: () => void) {
      const prev = (globalThis as any)[KEY];
      (globalThis as any)[KEY] = value;
      try {
        run();
      } finally {
        (globalThis as any)[KEY] = prev;
      }
    }

    it("returns 0 when the spawning tools aren't loaded (no global)", () => {
      withGlobal(undefined, () => {
        assert.equal(runningChildrenCount(), 0);
      });
    });

    it("reflects the live child count published by index.ts", () => {
      withGlobal(() => 3, () => {
        assert.equal(runningChildrenCount(), 3);
      });
    });

    it("includes unresolved lost-observation sessions in the child count from index.ts", async () => {
      const testApi = (subagentsModule as any).__test__;
      const countKey = Symbol.for("pi-subagents/running-children-count");
      const indexCountGetter = (globalThis as any)[countKey];
      assert.equal(typeof indexCountGetter, "function", "index.ts must register running-children-count getter");

      const savedRunning = new Map(testApi.runningSubagents);
      const savedLost = new Set(testApi.lostObservationSessions);
      try {
        testApi.runningSubagents.clear();
        testApi.lostObservationSessions.clear();
        assert.equal(runningChildrenCount(), 0);

        testApi.runningSubagents.set("run-1", { id: "run-1" } as any);
        assert.equal(runningChildrenCount(), 1);

        testApi.lostObservationSessions.add("/path/to/lost-session.jsonl");
        assert.equal(runningChildrenCount(), 2);

        testApi.runningSubagents.clear();
        assert.equal(runningChildrenCount(), 1, "lost-observation sessions must keep pending count > 0");
      } finally {
        testApi.runningSubagents.clear();
        for (const [k, v] of savedRunning) testApi.runningSubagents.set(k, v);
        testApi.lostObservationSessions.clear();
        for (const item of savedLost) testApi.lostObservationSessions.add(item);
      }
    });

    it("treats zero/negative/non-number/throwing getters as 0", () => {
      withGlobal(() => 0, () => assert.equal(runningChildrenCount(), 0));
      withGlobal(() => -1, () => assert.equal(runningChildrenCount(), 0));
      withGlobal(() => "two", () => assert.equal(runningChildrenCount(), 0));
      withGlobal(() => { throw new Error("boom"); }, () => assert.equal(runningChildrenCount(), 0));
    });
  });

  describe("ask_question tool", () => {
    function setupSubagentExtension(sessionFile: string) {
      const saved = {
        session: process.env.PI_SUBAGENT_SESSION,
        name: process.env.PI_SUBAGENT_NAME,
        agent: process.env.PI_SUBAGENT_AGENT,
        autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
      };
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      process.env.PI_SUBAGENT_NAME = "scout-2";
      process.env.PI_SUBAGENT_AGENT = "scout";
      process.env.PI_SUBAGENT_AUTO_EXIT = "1";
      const mock = createMockExtensionApi();
      subagentDoneExtension(mock.api);
      const restore = () => {
        restoreEnvVar("PI_SUBAGENT_SESSION", saved.session);
        restoreEnvVar("PI_SUBAGENT_NAME", saved.name);
        restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", saved.autoExit);
      };
      return { mock, restore };
    }

    it("registers ask_question (and no caller_ping) with a single freeform question param", () => {
      const dir = createTestDir();
      const { mock, restore } = setupSubagentExtension(join(dir, "s.jsonl"));
      try {
        const names = mock.registeredTools.map((t) => t.name);
        assert.ok(names.includes("ask_question"));
        assert.ok(!names.includes("caller_ping"));
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        assert.deepEqual(Object.keys(tool.parameters.properties), ["question"]);
        assert.match(tool.description, /orchestrator/i);
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("writes a .ask signal with name/agent/question and does NOT shut the session down", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "s.jsonl");
      const { mock, restore } = setupSubagentExtension(sessionFile);
      try {
        const tool = mock.registeredTools.find((t) => t.name === "ask_question");
        let shutdownCalled = false;
        const ctx = { shutdown() { shutdownCalled = true; } } as any;
        const out = await tool.execute("call-1", { question: "Which API base URL?" }, undefined, undefined, ctx);

        assert.equal(shutdownCalled, false, "ask_question must keep the session open");
        assert.match(out.content[0].text, /wait/i);

        const askFile = `${sessionFile}.ask`;
        assert.ok(existsSync(askFile), ".ask signal file should be written");
        const payload = JSON.parse(readFileSync(askFile, "utf-8"));
        assert.equal(payload.question, "Which API base URL?");
        assert.equal(payload.name, "scout-2");
        assert.equal(payload.agent, "scout");
        // No .exit sidecar — the session is not exiting.
        assert.ok(!existsSync(`${sessionFile}.exit`));
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // Regression tests for the mid-run reply race: a reply steered in while the
    // asking run is still open fires `input` but NOT `agent_start`, so the flag
    // must be cleared on `input` or the session parks forever.
    function setupCapturingExtension(sessionFile: string) {
      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      const tools: any[] = [];
      const api = {
        on(event: string, handler: (...args: any[]) => void) {
          if (!handlers.has(event)) handlers.set(event, []);
          handlers.get(event)!.push(handler);
        },
        registerTool(t: any) { tools.push(t); },
        registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
        sendUserMessage() {}, sendMessage() {}, getAllTools() { return []; },
      } as any;
      const saved = {
        session: process.env.PI_SUBAGENT_SESSION,
        name: process.env.PI_SUBAGENT_NAME,
        agent: process.env.PI_SUBAGENT_AGENT,
        autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
      };
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      process.env.PI_SUBAGENT_NAME = "scout-2";
      process.env.PI_SUBAGENT_AGENT = "scout";
      process.env.PI_SUBAGENT_AUTO_EXIT = "1";
      subagentDoneExtension(api);
      const emit = (event: string, ...args: any[]) =>
        (handlers.get(event) ?? []).forEach((h) => h(...args));
      const restore = () => {
        restoreEnvVar("PI_SUBAGENT_SESSION", saved.session);
        restoreEnvVar("PI_SUBAGENT_NAME", saved.name);
        restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", saved.autoExit);
      };
      const ask = async () => {
        const tool = tools.find((t) => t.name === "ask_question");
        await tool.execute("c1", { question: "v1 or v2?" }, undefined, undefined, { shutdown() {} });
      };
      return { emit, ask, restore };
    }

    it("exits (does not park) when the reply arrives mid-run via input", async () => {
      const dir = createTestDir();
      const { emit, ask, restore } = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        await ask(); // sets awaitingAnswer mid-run
        // Reply arrives MID-RUN as a steer: input fires, no new agent_start.
        emit("input");
        let shutdown = false;
        emit("agent_end", { messages: [] }, { shutdown() { shutdown = true; } });
        assert.equal(shutdown, true, "reply consumed mid-run → agent_end should exit, not park");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("parks as waiting at agent_end while the reply is still pending (no input yet)", async () => {
      const dir = createTestDir();
      const { emit, ask, restore } = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        await ask();
        // No input yet — the orchestrator has not replied.
        let shutdown = false;
        emit("agent_end", { messages: [] }, { shutdown() { shutdown = true; } });
        assert.equal(shutdown, false, "pending question with no reply must park, not exit");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("exits when the reply arrives as a new turn (agent_start also clears the flag)", async () => {
      const dir = createTestDir();
      const { emit, ask, restore } = setupCapturingExtension(join(dir, "s.jsonl"));
      try {
        emit("agent_start");
        await ask();
        let shutdown1 = false;
        emit("agent_end", { messages: [] }, { shutdown() { shutdown1 = true; } });
        assert.equal(shutdown1, false, "parks while waiting");
        // Reply arrives as a fresh turn after the subagent had parked.
        emit("input");
        emit("agent_start");
        let shutdown2 = false;
        emit("agent_end", { messages: [] }, { shutdown() { shutdown2 = true; } });
        assert.equal(shutdown2, true, "after the reply turn, agent_end should exit");
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("rex.ts interpretExitSidecar", () => {
  const { interpretExitSidecar } = __rexTest__;

  it("rejects obsolete ping payloads (ask_question uses .ask, not .exit)", () => {
    assert.equal(interpretExitSidecar({ type: "ping" }).reason, "error");
  });

  it("decodes done payloads", () => {
    assert.deepEqual(interpretExitSidecar({ type: "done" }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("decodes error payloads and propagates the message with a non-zero exit code", () => {
    assert.deepEqual(
      interpretExitSidecar({
        type: "error",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
        stopReason: "error",
      }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
    );
  });

  it("falls back to a placeholder when error payload has no errorMessage", () => {
    const result = interpretExitSidecar({ type: "error" });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /no errorMessage/);
  });

  it("rejects unknown payload shapes instead of claiming success", () => {
    for (const payload of [{}, null]) {
      const result = interpretExitSidecar(payload);
      assert.equal(result.reason, "error");
      assert.equal(result.exitCode, 1);
      assert.match(result.errorMessage!, /Unrecognized or corrupt/);
    }
  });
});
describe("commands", () => {
  it("/subagent emits a spawn tool call for a known agent", () => {
    const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    const subagent = registeredCommands.find((command) => command.name === "subagent");
    assert.ok(subagent, "expected /subagent to be registered");

    subagent.handler("scout map the auth code", {
      ui: { notify() {} },
    });

    assert.equal(sentUserMessages.length, 1);
    assert.match(sentUserMessages[0], /agent: "scout"/);
    assert.match(sentUserMessages[0], /map the auth code/);
  });

  it("does not register the removed /iterate or /plan commands", () => {
    const { api, registeredCommands } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    assert.equal(registeredCommands.find((c) => c.name === "iterate"), undefined);
    assert.equal(registeredCommands.find((c) => c.name === "plan"), undefined);
  });
});

describe("tool registration", () => {
  it("always resumes subagents as autonomous (auto-exit, non-interactive tracking)", () => {
    const testApi = (subagentsModule as any).__test__;

    assert.deepEqual(testApi.resolveResumeLaunchBehavior(), {
      autoExit: true,
      interactive: false,
    });
  });


  it("rejects a top-level spawn with no agent and no fork", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const result = await subagentTool.execute("call-1", { name: "x", task: "do it" });
    assert.equal(result.details?.error, "agent required");
    assert.match(result.content[0].text, /specify which agent/i);
  });

  it("rejects a top-level spawn naming an unknown agent", async () => {
    const savedAllowed = process.env.PI_SUBAGENT_ALLOWED;
    delete process.env.PI_SUBAGENT_ALLOWED;
    try {
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
      assert.ok(subagentTool, "expected subagent tool to be registered");

      const result = await subagentTool.execute("call-1", {
        name: "x",
        task: "do it",
        agent: "wizard",
      });
      assert.equal(result.details?.error, "unknown agent");
      assert.match(result.content[0].text, /not a known agent/i);
    } finally {
      restoreEnvVar("PI_SUBAGENT_ALLOWED", savedAllowed);
    }
  });

  it("exposes a debloated schema: agent+task required, name/model/cwd optional, no override knobs", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const props = subagentTool.parameters.properties;
    assert.deepEqual(
      Object.keys(props).sort(),
      ["agent", "cwd", "model", "name", "task"],
      "only agent/task/name/model/cwd should remain",
    );
    assert.deepEqual(
      [...(subagentTool.parameters.required ?? [])].sort(),
      ["agent", "task"],
      "agent and task must be required",
    );
    // `name` is optional in the schema, but the description tells the model to
    // always set a short descriptive label \u2014 it titles the tab or pane.
    assert.match(props.name.description, /short descriptive label/i);
    assert.match(props.name.description, /kebab-case/i);
    // The removed override knobs must be gone.
    for (const gone of ["tools", "skills", "systemPrompt", "fork", "interactive", "resumeSessionId"]) {
      assert.equal(props[gone], undefined, `expected ${gone} param to be removed`);
    }
  });

  it("renders partial subagent tool-call args without throwing", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    const rendered = subagentTool.renderCall({}, theme);
    const output = rendered.render(80).join("\n");

    assert.match(output, /\(unnamed\)/);
  });

  it("registers subagent_message with name + message both required (name-only addressing)", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const messageTool = registeredTools.find((tool) => tool.name === "subagent_message");
    assert.ok(messageTool, "expected subagent_message tool to be registered");

    const props = messageTool.parameters.properties;
    assert.deepEqual(
      Object.keys(props).sort(),
      ["message", "name"],
      "only name/message should remain (sessionId dropped)",
    );
    assert.equal(props.message.type, "string");
    assert.equal(props.name.type, "string");
    assert.deepEqual(
      messageTool.parameters.required?.slice().sort(),
      ["message", "name"],
      "name and message should both be required",
    );
    assert.equal(props.sessionId, undefined, "sessionId should be removed");
    assert.equal(props.autoExit, undefined, "autoExit knob should be removed");
  });

  it("no longer registers subagent_interrupt or subagent_resume", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const names = registeredTools.map((tool) => tool.name);
    assert.equal(names.includes("subagent_interrupt"), false);
    assert.equal(names.includes("subagent_resume"), false);
  });
});

describe("subagent activity snapshots", () => {
  function validActivity(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      runningChildId: "child-1",
      createdAt: 1_000,
      updatedAt: 1_000,
      sequence: 1,
      latestEvent: "session_start",
      phase: "starting",
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
      ...overrides,
    };
  }

  it("writes and validates activity files by running child id", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-1");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-1",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.toolExecutionStart("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-1");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "active");
      assert.equal(read.activity.activeScope, "tool");
      assert.equal(read.activity.toolName, "bash");

      assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
        ok: false,
        reason: "wrong-id",
      });
    });
  });

  it("records waiting and final done states", () => {
    withTempDir((dir) => {
      let currentNow = 2_000;
      const activityFile = getSubagentActivityFile(dir, "child-2");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-2",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      currentNow = 3_000;
      recorder.agentEndWaiting();
      let read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "waiting");
      assert.equal(read.activity.waitingSince, 3_000);

      currentNow = 4_000;
      recorder.agentEndDone();
      read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "done");
      assert.equal(read.activity.agentActive, false);
    });
  });

  it("rejects malformed activity fields used by classification and rendering", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const cases = [
        { activeSince: "bad" },
        { waitingSince: "bad" },
        { activeScope: "database" },
        { latestEvent: "unknown" },
        { runningChildId: 42 },
        { toolActive: "yes" },
        { toolName: "bad\nname" },
      ];

      for (const [index, overrides] of cases.entries()) {
        const activityFile = getSubagentActivityFile(dir, `child-${index}`);
        const activity = validActivity({ runningChildId: `child-${index}`, ...overrides });
        writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

        const read = readSubagentActivityFile(activityFile, `child-${index}`);
        assert.equal(read.ok, false);
        assert.equal((read as { ok: false; reason: string }).reason, "invalid");
      }
    });
  });

  it("does not let tool_result resurrect finished tool activity", () => {
    withTempDir((dir) => {
      let currentNow = 1_000;
      const activityFile = getSubagentActivityFile(dir, "child-3");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-3",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      recorder.agentStart();
      recorder.turnStart(1);
      currentNow = 2_000;
      recorder.toolExecutionStart("tool-1", "bash");
      currentNow = 3_000;
      recorder.toolExecutionEnd("tool-1", "bash");
      currentNow = 4_000;
      recorder.toolResult("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-3");
      assert.ok(read.ok);
      assert.equal(read.activity.toolActive, false);
      assert.equal(read.activity.activeScope, "turn");
    });
  });

  it("does not mark reload shutdown as the final done snapshot", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-4");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-4",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.sessionShutdown("reload");

      const read = readSubagentActivityFile(activityFile, "child-4");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "starting");
      assert.equal(read.activity.latestEvent, "session_start");
    });
  });

  it("cancels pending throttled writes on reload shutdown", async () => {
    const dir = createTestDir();
    try {
      await new Promise<void>((resolve) => {
        let currentNow = 1_000;
        const activityFile = getSubagentActivityFile(dir, "child-5");
        const recorder = createSubagentActivityRecorder({
          runningChildId: "child-5",
          activityFile,
          now: () => currentNow,
        });

        recorder.sessionStart();
        currentNow = 1_100;
        recorder.messageUpdate("delta");
        recorder.sessionShutdown("reload");

        setTimeout(() => {
          const read = readSubagentActivityFile(activityFile, "child-5");
          assert.ok(read.ok);
          assert.equal(read.activity.phase, "starting");
          assert.equal(read.activity.latestEvent, "session_start");
          resolve();
        }, 650);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("subagent interruption", () => {
  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      name: "Worker",
      task: "",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "worker.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      ...overrides,
    };
  }

  it("registers subagent_message and not the old interrupt/resume tools", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const names = registeredTools.map((tool) => tool.name);
    assert.equal(names.includes("subagent_message"), true);
    assert.equal(names.includes("subagent_interrupt"), false);
    assert.equal(names.includes("subagent_resume"), false);
  });

  it("resolves a running subagent by exact name and reports ambiguity", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "a1", sessionFile: "a1.jsonl" }));
      runningMap.set("b2", makeRunning({ id: "b2", name: "Worker", surface: "b2", sessionFile: "b2.jsonl" }));
      runningMap.set("c3", makeRunning({ id: "c3", name: "Scout", surface: "c3", sessionFile: "c3.jsonl" }));

      const byName = testApi.resolveRunningByName("Scout");
      assert.equal(byName.running.id, "c3");

      const ambiguous = testApi.resolveRunningByName("Worker");
      assert.match(ambiguous.error, /Ambiguous subagent name/);

      const missing = testApi.resolveRunningByName("Ghost");
      assert.match(missing.error, /No running subagent named "Ghost"/);
    } finally {
      runningMap.clear();
    }
  });

  it("uniqueRunningName suffixes defaulted names that collide with running subagents", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      // No collision: base name is returned untouched.
      assert.equal(testApi.uniqueRunningName("worker"), "worker");

      runningMap.set("a1", makeRunning({ id: "a1", name: "worker", surface: "a1" }));
      assert.equal(testApi.uniqueRunningName("worker"), "worker-2");

      runningMap.set("b2", makeRunning({ id: "b2", name: "worker-2", surface: "b2" }));
      assert.equal(testApi.uniqueRunningName("worker"), "worker-3");

      // A distinct base is unaffected by the worker collisions.
      assert.equal(testApi.uniqueRunningName("scout"), "scout");
    } finally {
      runningMap.clear();
    }
  });

  it("uniqueRunningName also avoids names already taken in the persistent registry", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const reserved = testApi.reservedNames as Set<string>;
    runningMap.clear();
    reserved.clear();

    try {
      // A finished subagent's name lives in the registry even though nothing is
      // running — a fresh default must skip it so names stay unique session-wide.
      const registryNames = new Set(["worker", "worker-2"]);
      assert.equal(testApi.uniqueRunningName("worker", registryNames), "worker-3");
      // A name not in the registry (or running/reserved) is unaffected.
      assert.equal(testApi.uniqueRunningName("scout", registryNames), "scout");
      // An empty registry behaves like before.
      assert.equal(testApi.uniqueRunningName("worker", new Set()), "worker");
    } finally {
      runningMap.clear();
      reserved.clear();
    }
  });

  it("uniqueRunningName also avoids names reserved by in-flight parallel spawns", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const reserved = testApi.reservedNames as Set<string>;
    runningMap.clear();
    reserved.clear();

    try {
      // Simulate the first parallel spawn reserving its default name before it
      // has registered in runningSubagents.
      reserved.add(testApi.uniqueRunningName("scout")); // "scout"
      // The second spawn, running concurrently, must not reuse it.
      assert.equal(testApi.uniqueRunningName("scout"), "scout-2");
      reserved.add("scout-2");
      assert.equal(testApi.uniqueRunningName("scout"), "scout-3");
    } finally {
      runningMap.clear();
      reserved.clear();
    }
  });

  it("steers a running subagent by typing into its pane (newlines flattened)", () => {
    const testApi = (subagentsModule as any).__test__;
    let sentSurface = "";
    let sentText = "";
    const running = makeRunning();

    const result = testApi.steerSubagent(running, "do this\nthen that", (surface: string, text: string) => {
      sentSurface = surface;
      sentText = text;
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(sentSurface, "pane-1");
    assert.equal(sentText, "do this then that");
  });

  it("returns an explicit error when steering delivery fails", () => {
    const testApi = (subagentsModule as any).__test__;
    const running = makeRunning();

    const result = testApi.steerSubagent(running, "hi", () => {
      throw new Error("mux write failed");
    });

    assert.match(result.error, /Failed to deliver message/);
  });

  it("delivers a steer message and forces local status waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let sentSurface = "";
    let sentText = "";
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentSteer({ name: "Worker", message: "keep going" }, (surface: string, text: string) => {
          sentSurface = surface;
          sentText = text;
        }),
      );

      assert.equal(sentSurface, "pane-1");
      assert.equal(sentText, "keep going");
      assert.equal(result.content[0].text.includes('Message delivered to running subagent "Worker"'), true);
      assert.deepEqual(result.details, { id: "a1", name: "Worker", status: "steered" });
      const snapshot = classifyStatus(runningMap.get("a1").statusState, 20_000);
      assert.equal(snapshot.kind, "waiting");
      assert.equal(runningMap.has("a1"), true);
    } finally {
      runningMap.clear();
    }
  });

  it("requires a message when steering", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();
    try {
      runningMap.set("a1", makeRunning());
      const result = testApi.handleSubagentSteer({ name: "Worker", message: "  " }, () => {});
      assert.match(result.content[0].text, /`message` is required/);
    } finally {
      runningMap.clear();
    }
  });

  it("leaves status unchanged when steering delivery fails in the tool path", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentSteer({ name: "Worker", message: "go" }, () => {
          throw new Error("mux write failed");
        }),
      );

      assert.match(result.content[0].text, /Failed to deliver message/);
      assert.equal(classifyStatus(runningMap.get("a1").statusState, 20_000).kind, "active");
    } finally {
      runningMap.clear();
    }
  });

  it("formats exit code 130 as an ordinary failure", () => {
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 130,
        elapsed: 61,
        summary: "Sub-agent exited with code 130",
        sessionFile: "/tmp/subagent.jsonl",
        sessionId: "019f-abc",
      },
      "Worker",
    );

    assert.match(presentation, /failed \(exit code 130\)/);
    assert.doesNotMatch(presentation, /interrupted/);
    // Follow-ups reference the name (not the session id).
    assert.match(presentation, /subagent_message\(\{ name: "Worker"/);
    assert.doesNotMatch(presentation, /Session id:/);
  });

  it("presents infrastructure observation failure without inviting an unsafe resume", () => {
    for (const result of [
      {
        summary: "Infrastructure observation failure: process query timed out. Pane was kept open.",
        observationFailure: true,
      },
      {
        summary: "Process observation unavailable",
        observationFailure: true,
      },
      {
        summary: "Observation disposed during session shutdown or reload.",
        observationFailure: true,
        outcome: "interrupted" as const,
        error: "cancelled",
      },
    ]) {
      const presentation = subagentsModule.__test__.resolveResultPresentation(
        { exitCode: 1, elapsed: 10, ...result },
        "resumed-worker",
      );
      assert.match(presentation, /Sub-agent "resumed-worker" failed \(infrastructure observation failure\)/);
      assert.ok(presentation.includes(result.summary));
      assert.match(presentation, /pane was kept open/i);
      assert.match(presentation, /Resume is blocked until the previous process is confirmed finished/);
      assert.doesNotMatch(presentation, /Follow up with subagent_message/);
    }
  });

  it("does not invite resume while an in-memory or persistent observation guard is active", async () => {
    const { writeLostObservationMarker } = await import("../pi-extension/subagents/session.ts");
    const testApi = subagentsModule.__test__;
    withTempDir((dir) => {
      const sessionFile = join(dir, "guarded.jsonl");
      for (const guard of ["in-memory", "disk-only"]) {
        try {
          if (guard === "in-memory") testApi.lostObservationSessions.add(resolve(sessionFile));
          else writeLostObservationMarker(sessionFile);
          for (const { result, expected } of [
            { result: { outcome: "success" as const }, expected: /completed \(10s\)\.\n\nReal result/ },
            { result: { outcome: "failure" as const }, expected: /failed \(exit code 42\)/ },
            {
              result: { outcome: "failure" as const, errorMessage: "Anthropic 529 Overloaded" },
              expected: /failed after 10s[\s\S]*Error: Anthropic 529 Overloaded/,
            },
            {
              result: { outcome: "interrupted" as const, errorMessage: "Pane closed externally" },
              expected: /was interrupted after 10s[\s\S]*Pane closed externally/,
            },
            {
              result: { outcome: "interrupted" as const, error: "cancelled" },
              expected: /was cancelled after 10s/,
            },
            { result: { outcome: "cancelled" as const }, expected: /was cancelled after 10s/ },
          ]) {
            const presentation = testApi.resolveResultPresentation(
              { exitCode: result.outcome === "success" ? 0 : 42, elapsed: 10, summary: "Real result", sessionFile, ...result },
              "guarded-worker",
            );
            assert.match(presentation, expected);
            assert.match(presentation, /Resume is blocked until the previous process is confirmed finished/);
            assert.doesNotMatch(presentation, /infrastructure observation failure|pane was kept open/i);
            assert.doesNotMatch(presentation, /resume the session with subagent_message|Follow up with subagent_message/);
          }
        } finally {
          testApi.confirmProcessEnded(sessionFile);
        }
      }
    });
  });

  it("preserves successful presentation despite marker stat errors or a retained guard", async (t) => {
    const { __setStatSyncOverride } = await import("../pi-extension/subagents/session.ts");
    const testApi = subagentsModule.__test__;
    const sessionFile = join(tmpdir(), "successful-marker-stat-error.jsonl");
    let statChecks = 0;
    t.mock.method(console, "error", () => {});
    __setStatSyncOverride(() => {
      statChecks++;
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    try {
      for (const guarded of [false, true]) {
        if (guarded) testApi.lostObservationSessions.add(resolve(sessionFile));
        const presentation = testApi.resolveResultPresentation(
          { exitCode: 0, elapsed: 12, summary: "Completed work", outcome: "success", sessionFile },
          "successful-worker",
        );
        assert.match(presentation, /Sub-agent "successful-worker" completed \(12s\)\.\n\nCompleted work/);
        assert.match(presentation, /Resume is blocked until the previous process is confirmed finished/);
        assert.doesNotMatch(presentation, /infrastructure observation failure|Follow up with subagent_message/);
      }
      assert.equal(statChecks, 1, "check the disk guard unless the in-memory guard already blocks resume");
    } finally {
      __setStatSyncOverride(null);
      testApi.lostObservationSessions.delete(resolve(sessionFile));
    }
  });

  it("does not infer observation failure from summary or error text", () => {
    for (const observationFailure of [undefined, false]) {
      const presentation = subagentsModule.__test__.resolveResultPresentation(
        {
          exitCode: 1,
          elapsed: 10,
          summary: "Infrastructure observation failure: quoted agent output",
          error: "Agent discussed an infrastructure failure",
          observationFailure,
        },
        "worker",
      );
      assert.match(presentation, /failed \(exit code 1\)/);
      assert.match(presentation, /Follow up with subagent_message/);
      assert.doesNotMatch(presentation, /Resume is blocked/);
    }
  });

  it("renders a clear provider/agent error when errorMessage is set", () => {
    // Previously, an overload retry-exhaustion produced exitCode 0 with a
    // stale summary — the orchestrator thought the subagent finished
    // quickly. With the error sidecar plumbed through, the presentation
    // must call out the failure, include the underlying error, and tell the
    // orchestrator how to recover.
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 1,
        elapsed: 14,
        summary: "ignored when errorMessage is present",
        sessionFile: "/tmp/subagent.jsonl",
        sessionId: "019f-xyz",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
      "Worker",
    );

    assert.match(presentation, /Sub-agent "Worker" failed/);
    assert.match(presentation, /provider\/agent error — auto-retry exhausted/);
    assert.match(presentation, /Error: Anthropic 529 Overloaded after 3 retries/);
    assert.match(presentation, /subagent_message\(\{ name: "Worker"/);
    assert.doesNotMatch(presentation, /Session id:/);
    assert.doesNotMatch(presentation, /ignored when errorMessage is present/);
  });
});

describe("subagent status renderer", () => {
  function createTheme() {
    return {
      fg(_color: string, text: string) {
        return text;
      },
      bg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
  }

  it("renders only capped lines plus overflow", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const visibleLines = [
      "Worker running 5m, active (bash 2m).",
      "Scout running 3m, waiting 1m.",
      "Reviewer running 2m, active (streaming 30s).",
      "Planner running 4m, waiting 2m.",
    ];
    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: {
          lines: visibleLines,
          overflow: 2,
        },
      },
      { expanded: true },
      createTheme(),
    );
    const output = rendered.render(80).join("\n");

    assert.match(output, /Subagent status/);
    for (const line of visibleLines) {
      assert.match(output, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(output, /\+2 more running\./);
  });

  it("stays within narrow widths", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: { lines: ["Worker running 5m, active (bash 2m)."], overflow: 0 },
      },
      { expanded: true },
      createTheme(),
    );

    for (const width of [4, 5, 6]) {
      for (const line of rendered.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagents widget rendering", () => {
  it("keeps every rendered line within a very narrow width", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime: 1_000_000 - 13_000,
          sessionFile: "sess1",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 13_000 }),
        },
        {
          id: "a2",
          name: "B",
          task: "",
          surface: "s2",
          startTime: 1_000_000 - 21_000,
          sessionFile: "sess2",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 21_000 }),
        },
        {
          id: "a3",
          name: "C",
          task: "",
          surface: "s3",
          startTime: 1_000_000 - 27_000,
          sessionFile: "sess3",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 27_000 }),
        },
      ], 16);

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.borderLine, "function");

    const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const widths = [0, 1, 2];
    for (const width of widths) {
      const startTime = Date.now() - 5_000;
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime,
          sessionFile: "sess1",
          statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
        },
      ], width);

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent display helpers", () => {
  const testApi = (subagentsModule as any).__test__;

  describe("formatTokens", () => {
    it("renders raw counts below 1k, 1 decimal below 10k, rounded k above", () => {
      assert.equal(testApi.formatTokens(850), "850");
      assert.equal(testApi.formatTokens(3200), "3.2k");
      assert.equal(testApi.formatTokens(45000), "45k");
    });
  });

  describe("contextWindowFor", () => {
    it("maps known model families and returns undefined otherwise", () => {
      assert.equal(testApi.contextWindowFor("claude-sonnet-4-6"), 200_000);
      assert.equal(testApi.contextWindowFor("gemini-2.5-pro"), 1_000_000);
      assert.equal(testApi.contextWindowFor("some-unknown-model"), undefined);
      assert.equal(testApi.contextWindowFor(null), undefined);
    });
  });

  describe("formatContextUsage", () => {
    it("shows a percent gauge when the window is known", () => {
      assert.equal(testApi.formatContextUsage(36_000, 200_000), "18.0%/200k");
      assert.equal(testApi.formatContextUsage(500_000, 1_000_000), "50.0%/1.0M");
    });

    it("falls back to a window-less ctx label when unknown", () => {
      assert.equal(testApi.formatContextUsage(37_000, undefined), "37k ctx");
    });
  });

  describe("formatUsageSegments", () => {
    it("emits arrow/cache/cost segments, skipping zero fields", () => {
      const segs = testApi.formatUsageSegments({
        model: "claude-sonnet-4-6",
        toolCount: 3,
        inputTokens: 3200,
        outputTokens: 890,
        cacheReadTokens: 45000,
        cacheWriteTokens: 0,
        contextTokens: 7000,
        cost: 0.042,
      });
      assert.deepEqual(segs, ["↑3.2k", "↓890", "R45k", "$0.042"]);
    });

    it("returns an empty list when there is no usage", () => {
      assert.deepEqual(
        testApi.formatUsageSegments({
          model: null,
          toolCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          contextTokens: 0,
          cost: 0,
        }),
        [],
      );
    });
  });

  describe("widgetIcon", () => {
    it("maps active/running to a glyph and waiting/starting to another", () => {
      const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
      assert.equal(strip(testApi.widgetIcon("active")), "⟳");
      assert.equal(strip(testApi.widgetIcon("running")), "⟳");
      assert.equal(strip(testApi.widgetIcon("stalled")), "⟳");
      assert.equal(strip(testApi.widgetIcon("waiting")), "○");
      assert.equal(strip(testApi.widgetIcon("starting")), "○");
    });
  });
});

describe("rex.ts shell quoting", () => {
  describe("shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
      // Inside single quotes, everything is literal
      assert.ok(escaped.includes("$world"));
    });
  });
});

describe("Rex equal-share sizing (public session.view layout)", () => {
  const pane = (block_id: string): RexLayoutNode => ({ block_id, rect: [0, 0, 1, 1] });
  const split = (direction: "horizontal" | "vertical", ratio: number, before: RexLayoutNode, after: RexLayoutNode): RexLayoutNode => ({
    rect: [0, 0, 1, 1], split: { split_id: "split:fixture", direction, ratio, before, after },
  });
  const a = pane("block:a"), b = pane("block:b"), c = pane("block:c"), d = pane("block:d");

  it("balances repeated halvings into four equal columns using absolute border ratios", () => {
    const layout = split("horizontal", 0.5,
      split("horizontal", 0.6, split("horizontal", 0.5, a, b), c), d);
    assert.deepEqual(planEqualShares(layout), [
      { direction: "horizontal", before_block_id: "block:b", after_block_id: "block:c", ratio: 2 / 3 },
      { direction: "horizontal", before_block_id: "block:c", after_block_id: "block:d", ratio: 3 / 4 },
    ]);
    assert.equal(planEqualShares(split("horizontal", 0.75, a, b))[0].ratio, 0.5, "also shrinks the before share");
  });

  it("balances stacked rows and counts side-by-side panes as one row", () => {
    const layout = split("vertical", 0.5, a,
      split("vertical", 0.5, split("horizontal", 0.5, b, c), d));
    assert.deepEqual(planEqualShares(layout), [
      { direction: "vertical", before_block_id: "block:a", after_block_id: "block:b", ratio: 1 / 3 },
    ]);
  });

  it("counts stacked panes as one column in mixed-axis trees", () => {
    assert.deepEqual(planEqualShares(split("horizontal", 0.5, a, split("vertical", 0.5, b, c))), []);
    const layout = split("horizontal", 0.5,
      split("vertical", 0.7, split("horizontal", 0.5, a, b), c), d);
    assert.deepEqual(planEqualShares(layout), [
      { direction: "vertical", before_block_id: "block:b", after_block_id: "block:c", ratio: 0.5 },
      { direction: "horizontal", before_block_id: "block:c", after_block_id: "block:d", ratio: 2 / 3 },
    ]);
  });

  it("leaves a single pane, empty, already equal, and insignificant corrections alone", () => {
    for (const layout of [a, null, undefined, split("horizontal", 0.5, a, b), split("vertical", 0.504, a, b)]) {
      assert.deepEqual(planEqualShares(layout), []);
    }
  });

  it("abandons malformed layouts rather than applying a partial plan", () => {
    assert.deepEqual(planEqualShares(split("horizontal", 0.3,
      split("vertical", 0.1, a, b), {})), []);
  });
});

describe("integration harness profile guards", () => {
  function assertProfiles(dir: string, model: string): string[] {
    const agentsDir = join(dir, ".pi/agents");
    const files = readdirSync(agentsDir).filter((file) => file.endsWith(".md"));
    assert.ok(files.length > 0);
    for (const file of files) {
      const content = readFileSync(join(agentsDir, file), "utf8");
      const frontmatter = content.match(/^---\n([\s\S]*?)\n---(?=\n|$)/)?.[1];
      assert.ok(frontmatter, `${file} must have frontmatter`);
      assert.deepEqual(frontmatter.match(/^model:.*$/gm), [`model: ${model}`], file);
      assert.deepEqual(frontmatter.match(/^thinking:.*$/gm), ["thinking: off"], file);
    }
    return files;
  }

  it("rewrites every copied test profile with TEST_MODEL and thinking off", () => {
    const env = createTestEnv();
    try {
      const source = fileURLToPath(new URL("./integration/agents", import.meta.url));
      assert.deepEqual(assertProfiles(env.dir, TEST_MODEL), readdirSync(source).filter((file) => file.endsWith(".md")));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("replaces or adds LF and CRLF frontmatter settings with a literal special-character TEST_MODEL", async () => {
    const model = "test/model-$&-$$-$`-$'";
    const previousModel = process.env.PI_TEST_MODEL;
    try {
      process.env.PI_TEST_MODEL = model;
      // TEST_MODEL is read at module initialization; use a fresh module instance.
      const harness: typeof import("./integration/harness.ts") = await import(
        new URL("./integration/harness.ts?profile-guard-test", import.meta.url).href
      );
      assert.equal(harness.TEST_MODEL, model);
      withTempDir((agentsSrc) => {
        const profiles = {
          "existing-thinking": "model: unapproved/model\nthinking: high",
          "missing-thinking": "model: unapproved/model",
          "missing-model": "thinking: high",
          "missing-both": "description: no model or thinking",
          "empty-frontmatter": "",
        };
        const body = "Preserve these body examples:\nmodel: body/model\nthinking: high";
        for (const [name, frontmatter] of Object.entries(profiles)) {
          writeAgentFile(agentsSrc, name, frontmatter, body);
          const content = readFileSync(join(agentsSrc, `${name}.md`), "utf8");
          writeFileSync(join(agentsSrc, `${name}-crlf.md`), content.replace(/\n/g, "\r\n"));
        }
        const names = Object.keys(profiles).flatMap((name) => [name, `${name}-crlf`]);
        writeFileSync(join(agentsSrc, "ignored.txt"), "not an agent");
        const env = harness.createTestEnv({ agentsSrc });
        try {
          assert.deepEqual(assertProfiles(env.dir, harness.TEST_MODEL).sort(), names.map((name) => `${name}.md`).sort());
          for (const name of names) {
            const file = `${name}.md`;
            const copied = readFileSync(join(env.dir, ".pi/agents", file), "utf8");
            assert.ok(copied.endsWith(`\n\n${body}\n`), `${file} body must be unchanged`);
            assert.ok(!readFileSync(join(agentsSrc, file), "utf8").includes(model), `${file} source must be unchanged`);
          }
          assert.equal(existsSync(join(env.dir, ".pi/agents/ignored.txt")), false);
        } finally {
          harness.cleanupTestEnv(env);
        }
      });
    } finally {
      restoreEnvVar("PI_TEST_MODEL", previousModel);
    }
  });
});

describe("integration harness setup rollback", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let savedContext: NodeJS.ProcessEnv;
  let dir: string | undefined;
  let calls: string[][];
  let response: unknown;
  let newError: Error | undefined;
  let killError: Error | undefined;

  beforeEach(() => {
    originalEnv = process.env;
    process.env = {
      ...originalEnv,
      REX_SESSION: "session:caller",
      REX_BLOCK: "block:caller",
      PI_SUBAGENT_SETUP_TEST: "caller",
    };
    savedContext = { ...process.env };
    dir = undefined;
    calls = [];
    response = { session_id: "session:owned", initial_windows: [{ block_ids: ["block:owned"] }] };
    newError = undefined;
    killError = undefined;
    __rexTest__.setRexExecutor((args) => {
      calls.push(args);
      if (args[0] === "new") {
        dir = args[args.indexOf("-c") + 1];
        assert.equal(existsSync(join(dir, ".pi", "agents")), true);
        assert.deepEqual(process.env, savedContext, "context must not change before Rex setup");
        if (newError) throw newError;
        return JSON.stringify(response) ?? "";
      }
      assert.deepEqual(args, ["kill", "session:owned"]);
      if (killError) throw killError;
      return "";
    });
  });

  afterEach(() => {
    __rexTest__.setRexExecutor(null);
    process.env = originalEnv;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const malformedResponses = [
    ["null response", null, false],
    ["missing session ID", { initial_windows: [{ block_ids: ["block:owned"] }] }, false],
    ["numeric session ID", { session_id: 42, initial_windows: [{ block_ids: ["block:owned"] }] }, false],
    ["blank session ID", { session_id: "  ", initial_windows: [{ block_ids: ["block:owned"] }] }, false],
    ["missing windows", { session_id: "session:owned" }, true],
    ["empty windows", { session_id: "session:owned", initial_windows: [] }, true],
    ["non-array windows", { session_id: "session:owned", initial_windows: { 0: { block_ids: ["block:owned"] } } }, true],
    ...[
      ["missing block IDs", {}],
      ["null block IDs", { block_ids: null }],
      ["empty block IDs", { block_ids: [] }],
      ["non-array block IDs", { block_ids: "block:owned" }],
      ["null block ID", { block_ids: [null] }],
      ["numeric block ID", { block_ids: [42] }],
      ["object block ID", { block_ids: [{}] }],
      ["empty block ID", { block_ids: [""] }],
      ["blank block ID", { block_ids: ["  "] }],
    ].map(([name, window]) => [name, { session_id: "session:owned", initial_windows: [window] }, true]),
  ] as const;

  for (const [name, malformed, ownsSession] of malformedResponses) {
    it(`rolls back ${name} without mutating caller context`, () => {
      response = malformed;
      const writes: PropertyKey[] = [];
      process.env = new Proxy(process.env, {
        set(target, key, value) {
          writes.push(key);
          return Reflect.set(target, key, value);
        },
        deleteProperty(target, key) {
          writes.push(key);
          return Reflect.deleteProperty(target, key);
        },
      });

      assert.throws(() => createTestEnv({ isolateRex: true }), /Invalid Rex test session response/);
      assert.equal(calls.length, ownsSession ? 2 : 1);
      assert.equal(existsSync(dir!), false, "failed fixture directory must be removed");
      assert.deepEqual(process.env, savedContext);
      assert.deepEqual(writes, [], "invalid responses must be rejected before environment mutations");
    });
  }

  it("removes the fixture directory when rex new throws", () => {
    newError = new Error("rex new failed");
    assert.throws(() => createTestEnv({ isolateRex: true }), (error) => error === newError);
    assert.equal(calls.length, 1, "no session ID is available to kill");
    assert.equal(existsSync(dir!), false);
    assert.deepEqual(process.env, savedContext);
  });

  for (const killFails of [false, true]) {
    it(`restores partially modified context when setup fails${killFails ? " even if session kill fails" : ""}`, (t) => {
      const setupError = new Error("environment setup failed");
      const warning = t.mock.method(console, "warn", () => {});
      if (killFails) killError = new Error("kill failed");
      process.env = new Proxy(process.env, {
        set(target, key, value) {
          if (key === "REX_BLOCK" && value === "block:owned") {
            assert.equal(target.REX_SESSION, "session:owned");
            assert.equal(target.PI_SUBAGENT_SETUP_TEST, undefined);
            throw setupError;
          }
          return Reflect.set(target, key, value);
        },
      });

      assert.throws(() => createTestEnv({ isolateRex: true }), (error) => error === setupError);
      assert.equal(calls.length, 2);
      assert.equal(existsSync(dir!), false);
      assert.deepEqual(process.env, savedContext);
      assert.equal(warning.mock.callCount(), killFails ? 1 : 0);
      if (killFails) {
        assert.deepEqual(warning.mock.calls[0].arguments, ["Failed to kill Rex test session:", killError]);
      }
    });
  }

  it("returns a valid isolated fixture and restores context during normal cleanup", () => {
    const env = createTestEnv({ isolateRex: true });
    assert.equal(env.rexSession, "session:owned");
    assert.equal(process.env.REX_SESSION, "session:owned");
    assert.equal(process.env.REX_BLOCK, "block:owned");
    assert.equal(process.env.PI_SUBAGENT_SETUP_TEST, undefined);
    cleanupTestEnv(env);
    assert.equal(calls.length, 2);
    assert.equal(existsSync(env.dir), false);
    assert.deepEqual(process.env, savedContext);
  });
});

describe("integration harness cleanup", () => {
  for (const killFails of [false, true]) {
    it(`kills the owned session even if surface disposal throws${killFails ? " and kill fails" : ""}`, (t) => {
      const root = createTestDir();
      const dir = join(root, "project");
      const tempFile = join(root, "tracked.tmp");
      mkdirSync(dir);
      writeFileSync(tempFile, "test");
      const originalEnv = process.env;
      process.env = { ...originalEnv, REX_SESSION: "session:owned", REX_BLOCK: "block:owned" };
      const disposeError = new Error("surface disposal failed");
      const killError = new Error("session kill failed");
      const warning = t.mock.method(console, "warn", () => {});
      let killCalls = 0;
      registerSurfaceHandle({
        id: "harness-disposal-failure",
        name: "harness-disposal-failure",
        kind: "tab",
        sessionId: "session:owned",
        // Force the real disposer to fail while inspecting a tracked handle.
        get status(): "reserved" { throw disposeError; },
      });
      __rexTest__.setRexExecutor((args) => {
        assert.deepEqual(args, ["kill", "session:owned"]);
        killCalls++;
        if (killFails) throw killError;
        return "";
      });

      try {
        assert.doesNotThrow(() => cleanupTestEnv({
          dir,
          surfaces: [],
          tempFiles: [tempFile],
          rexSession: "session:owned",
          savedContext: { REX_SESSION: originalEnv.REX_SESSION, REX_BLOCK: originalEnv.REX_BLOCK },
        }));
        assert.equal(killCalls, 1);
        assert.equal(existsSync(dir), false);
        assert.equal(existsSync(tempFile), false);
        assert.deepEqual({ ...process.env }, { ...originalEnv });
        assert.equal(warning.mock.callCount(), killFails ? 2 : 1);
        assert.deepEqual(warning.mock.calls[0].arguments, ["Failed to dispose Rex surfaces:", disposeError]);
        if (killFails) {
          assert.deepEqual(warning.mock.calls[1].arguments, ["Failed to kill Rex test session:", killError]);
        }
      } finally {
        unregisterSurfaceHandle("harness-disposal-failure");
        __rexTest__.setRexExecutor(null);
        process.env = originalEnv;
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  for (const reason of ["session already closed", "RPC error"]) {
    it(`cleans local resources and restores context after ${reason}`, (t) => {
      const root = mkdtempSync(join(tmpdir(), "pi-cleanup-test-"));
      const dir = join(root, "project");
      const tempFile = join(root, "tracked.tmp");
      mkdirSync(dir);
      writeFileSync(join(dir, "project.tmp"), "test");
      writeFileSync(tempFile, "test");
      const savedContext = {
        REX_SESSION: "session:caller",
        REX_BLOCK: "block:caller",
        PI_SUBAGENT_CLEANUP_TEST: undefined,
      };
      const originalContext = Object.fromEntries(
        Object.keys(savedContext).map((key) => [key, process.env[key]]),
      );
      const error = new Error(reason);
      const warning = t.mock.method(console, "warn", () => {});
      let killCalls = 0;
      __rexTest__.setRexExecutor((args) => {
        assert.deepEqual(args, ["kill", "session:owned"]);
        killCalls++;
        throw error;
      });

      try {
        process.env.REX_SESSION = "session:owned";
        process.env.REX_BLOCK = "block:owned";
        process.env.PI_SUBAGENT_CLEANUP_TEST = "child";
        assert.doesNotThrow(() => cleanupTestEnv({
          dir,
          surfaces: [],
          // A missing file must not prevent removal of later tracked files.
          tempFiles: [join(root, "already-removed.tmp"), tempFile],
          rexSession: "session:owned",
          savedContext,
        }));

        assert.equal(killCalls, 1);
        assert.equal(existsSync(dir), false, "project directory must be removed");
        assert.equal(existsSync(tempFile), false, "external temp file must be removed");
        for (const [key, value] of Object.entries(savedContext)) {
          assert.equal(process.env[key], value, `${key} must be restored`);
        }
        assert.equal(warning.mock.callCount(), 1);
        assert.match(String(warning.mock.calls[0].arguments[0]), /Failed to kill Rex test session/);
        assert.equal(warning.mock.calls[0].arguments[1], error);
      } finally {
        __rexTest__.setRexExecutor(null);
        for (const [key, value] of Object.entries(originalContext)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe("rex.ts unit tests", () => {
  it("buildRexArgs includes server flag when server is specified or in env", async () => {
    const { __rexTest__ } = await import("../pi-extension/subagents/rex.ts");
    assert.deepEqual(
      __rexTest__.buildRexArgs(["window", "list"], "unix:///tmp/custom.sock"),
      ["-S", "unix:///tmp/custom.sock", "window", "list"],
    );
    const savedServer = process.env.REX_SERVER;
    delete process.env.REX_SERVER;
    try {
      assert.deepEqual(
        __rexTest__.buildRexArgs(["window", "list"], undefined),
        ["window", "list"],
      );
    } finally {
      if (savedServer !== undefined) process.env.REX_SERVER = savedServer;
    }
  });

  it("chooseSplitDirection maps auto geometry based on 2:1 column-to-row ratio", async () => {
    const { chooseSplitDirection } = await import("../pi-extension/subagents/rex.ts");
    assert.equal(chooseSplitDirection({ columns: 160, rows: 40 }, "auto"), "right"); // 160/40 = 4 >= 2 -> right
    assert.equal(chooseSplitDirection({ columns: 60, rows: 40 }, "auto"), "below"); // 60/40 = 1.5 < 2 -> below
    assert.equal(chooseSplitDirection(undefined, "auto"), "right"); // fallback
    assert.equal(chooseSplitDirection({ columns: 160, rows: 40 }, "down"), "below"); // explicit override
    assert.equal(chooseSplitDirection({ columns: 40, rows: 40 }, "right"), "right"); // explicit override
  });

  it("chooseSurfaceKind respects top-level tab default and nested split", async () => {
    const { chooseSurfaceKind } = await import("../pi-extension/subagents/rex.ts");
    assert.equal(chooseSurfaceKind(false, "tab"), "tab");
    assert.equal(chooseSurfaceKind(false, "pane"), "pane");
    assert.equal(chooseSurfaceKind(true, "tab"), "pane"); // nested always pane
    assert.equal(chooseSurfaceKind(true, "pane"), "pane");
  });

  it("validateTrustworthyProgramStatus rejects empty, malformed, or missing reports", async () => {
    const { __rexTest__ } = await import("../pi-extension/subagents/rex.ts");
    const emptyRes = __rexTest__.validateTrustworthyProgramStatus([]);
    assert.equal(emptyRes.ok, false);
    assert.match(emptyRes.error, /No program status records available/);

    const nonTargetRes = __rexTest__.validateTrustworthyProgramStatus([
      { state: "working", app: "other", updated_at: "2026-11-01T00:00:00Z" },
    ], "pi");
    assert.equal(nonTargetRes.ok, false);
    assert.match(nonTargetRes.error, /No trustworthy program status found/);
  });

  it("validateTrustworthyProgramStatus rejects blocked dialog records", async () => {
    const { __rexTest__ } = await import("../pi-extension/subagents/rex.ts");
    const blockedRes = __rexTest__.validateTrustworthyProgramStatus([
      { state: "blocked", kind: "permission", app: "pi", updated_at: "2026-11-01T00:00:00Z", msg: "Allow bash execution?" },
    ], "pi");
    assert.equal(blockedRes.ok, false);
    assert.match(blockedRes.error, /blocked on a permission dialog/);

    const blockedCustomRes = __rexTest__.validateTrustworthyProgramStatus([
      { state: "blocked", kind: "custom_kind", app: "pi", updated_at: "2026-11-01T00:00:00Z" },
    ], "pi");
    assert.equal(blockedCustomRes.ok, false);
    assert.match(blockedCustomRes.error, /blocked on a custom_kind dialog/);

    const errorRes = __rexTest__.validateTrustworthyProgramStatus([
      { state: "error", app: "pi", updated_at: "2026-11-01T00:00:00Z", msg: "Process failed" },
    ], "pi");
    assert.equal(errorRes.ok, false);
    assert.match(errorRes.error, /in an error state/);
  });

  it("validateTrustworthyProgramStatus accepts valid unblocked target report", async () => {
    const { __rexTest__ } = await import("../pi-extension/subagents/rex.ts");
    const okRes = __rexTest__.validateTrustworthyProgramStatus([
      { state: "working", app: "pi", updated_at: "2026-11-01T00:00:00Z" },
    ], "pi");
    assert.equal(okRes.ok, true);
    if (okRes.ok) {
      assert.equal(okRes.targetRecord.state, "working");
    }
  });

  it("validateAnchorBlock throws actionable error for nonexistent anchor", async () => {
    const { __rexTest__ } = await import("../pi-extension/subagents/rex.ts");
    __rexTest__.setRexContextOverride({
      server: "unix:///tmp/mock.sock",
      session: "session:mock-session",
      block: "block:mock-anchor",
    });
    __rexTest__.setCommandAvailabilityOverride(true);
    __rexTest__.setRexExecutor((args) => {
      if (args[0] === "block" && args[1] === "inspect" && args.includes("block:nonexistent")) {
        throw new Error('block target "block:nonexistent" not found');
      }
      return "{}";
    });

    try {
      assert.throws(
        () => __rexTest__.validateAnchorBlock("block:nonexistent", "session:mock-session"),
        /Target Rex block "block:nonexistent" does not exist/,
      );
    } finally {
      __rexTest__.setRexExecutor(null);
      __rexTest__.setCommandAvailabilityOverride(undefined);
      __rexTest__.setRexContextOverride(undefined);
    }
  });

  it("closeSurface closes only the block for split handles and respects nested blocks in tab handles", async () => {
    const { registerSurfaceHandle, unregisterSurfaceHandle, closeSurface, getSurfaceHandle, __rexTest__ } = await import("../pi-extension/subagents/rex.ts");
    const executed: string[][] = [];
    __rexTest__.setRexContextOverride({
      server: "unix:///tmp/mock.sock",
      session: "session:test",
      block: "block:test-block-1",
    });
    __rexTest__.setCommandAvailabilityOverride(true);
    __rexTest__.setRexExecutor((args) => {
      executed.push(args);
      if (args[0] === "window" && args[1] === "inspect") {
        return JSON.stringify({
          layers: [{ blocks: [{ block_id: "block:test-block-1" }, { block_id: "block:test-block-2" }] }],
        });
      }
      return "{}";
    });

    try {
      // Tab handle
      registerSurfaceHandle({
        id: "test-tab-handle",
        kind: "tab",
        name: "tab-agent",
        sessionId: "session:test",
        windowId: "window:test-win",
        blockId: "block:test-block-1",
        status: "launched",
      });
      // Split handle
      registerSurfaceHandle({
        id: "test-split-handle",
        kind: "split",
        name: "split-agent",
        sessionId: "session:test",
        windowId: "window:test-win", // windowId might be cached by getSurfaceTab
        blockId: "block:test-block-2",
        status: "launched",
      });

      closeSurface("test-split-handle");
      assert.equal(getSurfaceHandle("test-split-handle"), undefined);
      assert.ok(executed.some((c) => c[0] === "block" && c[1] === "close" && c.includes("block:test-block-2")));

      closeSurface("test-tab-handle");
      assert.equal(getSurfaceHandle("test-tab-handle"), undefined);
      // Because window has 2 blocks, tab handle close closes only block 1
      assert.ok(executed.some((c) => c[0] === "block" && c[1] === "close" && c.includes("block:test-block-1")));
    } finally {
      unregisterSurfaceHandle("test-tab-handle");
      unregisterSurfaceHandle("test-split-handle");
      __rexTest__.setRexExecutor(null);
      __rexTest__.setCommandAvailabilityOverride(undefined);
      __rexTest__.setRexContextOverride(undefined);
    }
  });

  it("validateTrustworthyProgramStatus rejects mixed or unattributed blocked/error records", async () => {
    const { __rexTest__ } = await import("../pi-extension/subagents/rex.ts");
    // An unattributed blocked record alongside a working pi record must reject delivery
    const mixedRes = __rexTest__.validateTrustworthyProgramStatus([
      { state: "working", app: "pi", updated_at: "2026-11-01T00:00:00Z" },
      { state: "blocked", kind: "auth", updated_at: "2026-11-01T00:00:00Z" },
    ], "pi");
    assert.equal(mixedRes.ok, false);
    assert.match(mixedRes.error, /blocked on a auth dialog/);

    // An unattributed error record alongside working pi record must reject delivery
    const unattributedError = __rexTest__.validateTrustworthyProgramStatus([
      { state: "working", app: "pi", updated_at: "2026-11-01T00:00:00Z" },
      { state: "error", updated_at: "2026-11-01T00:00:00Z", msg: "crash" },
    ], "pi");
    assert.equal(unattributedError.ok, false);
    assert.match(unattributedError.error, /in an error state/);

    // Another app's error record (e.g. bash) alongside working pi record must NOT block steering
    const otherAppError = __rexTest__.validateTrustworthyProgramStatus([
      { state: "working", app: "pi", updated_at: "2026-11-01T00:00:00Z" },
      { state: "error", app: "bash", updated_at: "2026-11-01T00:00:00Z", msg: "crash" },
    ], "pi");
    assert.equal(otherAppError.ok, true);
    assert.equal(otherAppError.targetRecord.state, "working");

    // Another app's blocked record (e.g. auth/dialog in bash/other) alongside working pi record must NOT block steering
    const otherAppBlocked = __rexTest__.validateTrustworthyProgramStatus([
      { state: "working", app: "pi", updated_at: "2026-11-01T00:00:00Z" },
      { state: "blocked", app: "other-tool", kind: "permission", msg: "confirm action", updated_at: "2026-11-01T00:00:00Z" },
    ], "pi");
    assert.equal(otherAppBlocked.ok, true);
    assert.equal(otherAppBlocked.targetRecord.state, "working");
  });

  it("createSurfaceSplit resolves fromSurface handle string to its blockId", async () => {
    const { registerSurfaceHandle, unregisterSurfaceHandle, createSurfaceSplit, getSurfaceHandle, __rexTest__ } = await import("../pi-extension/subagents/rex.ts");
    __rexTest__.setRexContextOverride({
      server: "unix:///tmp/mock.sock",
      session: "session:mock-session",
      block: "block:mock-anchor",
    });
    __rexTest__.setCommandAvailabilityOverride(true);
    __rexTest__.setRexExecutor((args) => {
      if (args[0] === "block" && args[1] === "inspect") {
        return JSON.stringify({ block: { block_id: args[args.length - 1] } });
      }
      return "{}";
    });

    registerSurfaceHandle({
      id: "parent-handle-id",
      kind: "tab",
      name: "parent-handle",
      sessionId: "session:mock-session",
      blockId: "block:parent-blk-1",
      status: "launched",
    });

    registerSurfaceHandle({
      id: "unlaunched-parent-id",
      kind: "tab",
      name: "unlaunched-parent",
      sessionId: "session:mock-session",
      status: "reserved",
    });

    try {
      const splitHandleId = createSurfaceSplit("child-split-test", "right", "parent-handle-id");
      const splitHandle = getSurfaceHandle(splitHandleId);
      assert.ok(splitHandle);
      assert.equal(splitHandle.anchorBlockId, "block:parent-blk-1", "fromSurface handle string should resolve to parent's blockId");

      assert.throws(
        () => createSurfaceSplit("child-fail-test", "right", "unlaunched-parent-id"),
        /has not been launched yet; no block ID available to split/,
      );
    } finally {
      unregisterSurfaceHandle("parent-handle-id");
      unregisterSurfaceHandle("unlaunched-parent-id");
      __rexTest__.setRexExecutor(null);
      __rexTest__.setCommandAvailabilityOverride(undefined);
      __rexTest__.setRexContextOverride(undefined);
    }
  });

  it("closeSurface deterministically calls window close for lone block and block close for multi-block/error", async () => {
    const { registerSurfaceHandle, unregisterSurfaceHandle, closeSurface, __rexTest__ } = await import("../pi-extension/subagents/rex.ts");
    const executedCommands: string[][] = [];

    try {
      // 1. Lone block tab -> window close
      __rexTest__.setRexExecutor((args) => {
        executedCommands.push(args);
        if (args[0] === "window" && args[1] === "inspect") {
          return JSON.stringify({
            layers: [{ blocks: [{ block_id: "block:lone-1" }] }],
          });
        }
        return "";
      });

      registerSurfaceHandle({
        id: "tab-lone",
        kind: "tab",
        name: "lone",
        sessionId: "session:test",
        windowId: "window:w1",
        blockId: "block:lone-1",
        status: "launched",
      });

      closeSurface("tab-lone");
      assert.deepEqual(executedCommands[executedCommands.length - 1], [
        "window", "close", "-s", "session:test", "window:w1",
      ]);

      // 2. Multi-block tab -> block close
      executedCommands.length = 0;
      __rexTest__.setRexExecutor((args) => {
        executedCommands.push(args);
        if (args[0] === "window" && args[1] === "inspect") {
          return JSON.stringify({
            layers: [{ blocks: [{ block_id: "block:parent" }, { block_id: "block:child" }] }],
          });
        }
        return "";
      });

      registerSurfaceHandle({
        id: "tab-multi",
        kind: "tab",
        name: "multi",
        sessionId: "session:test",
        windowId: "window:w1",
        blockId: "block:parent",
        status: "launched",
      });

      closeSurface("tab-multi");
      assert.deepEqual(executedCommands[executedCommands.length - 1], [
        "block", "close", "-s", "session:test", "block:parent",
      ]);

      // 3. Inspection throws error -> block close
      executedCommands.length = 0;
      __rexTest__.setRexExecutor((args) => {
        executedCommands.push(args);
        if (args[0] === "window" && args[1] === "inspect") {
          throw new Error("transport error");
        }
        return "";
      });

      registerSurfaceHandle({
        id: "tab-err",
        kind: "tab",
        name: "err",
        sessionId: "session:test",
        windowId: "window:w1",
        blockId: "block:err-1",
        status: "launched",
      });

      closeSurface("tab-err");
      assert.deepEqual(executedCommands[executedCommands.length - 1], [
        "block", "close", "-s", "session:test", "block:err-1",
      ]);

      // 4. Partial tab creation (windowId exists, blockId absent):
      // 4a. Zero blocks in window -> window close
      executedCommands.length = 0;
      __rexTest__.setRexExecutor((args) => {
        executedCommands.push(args);
        if (args[0] === "window" && args[1] === "inspect") {
          return JSON.stringify({ layers: [{ blocks: [] }] });
        }
        return "";
      });

      registerSurfaceHandle({
        id: "tab-partial-zero",
        kind: "tab",
        name: "partial-zero",
        sessionId: "session:test",
        windowId: "window:w-partial-zero",
        status: "launched",
      });

      closeSurface("tab-partial-zero");
      assert.deepEqual(executedCommands[executedCommands.length - 1], [
        "window", "close", "-s", "session:test", "window:w-partial-zero",
      ]);
      assert.equal(unregisterSurfaceHandle("tab-partial-zero"), undefined);

      // 4b. One block in window -> window close
      executedCommands.length = 0;
      __rexTest__.setRexExecutor((args) => {
        executedCommands.push(args);
        if (args[0] === "window" && args[1] === "inspect") {
          return JSON.stringify({ layers: [{ blocks: [{ block_id: "block:b1" }] }] });
        }
        return "";
      });

      registerSurfaceHandle({
        id: "tab-partial-one",
        kind: "tab",
        name: "partial-one",
        sessionId: "session:test",
        windowId: "window:w-partial-one",
        status: "launched",
      });

      closeSurface("tab-partial-one");
      assert.deepEqual(executedCommands[executedCommands.length - 1], [
        "window", "close", "-s", "session:test", "window:w-partial-one",
      ]);

      // 4c. Multiple blocks in window -> do NOT close window, do not unregister if close fails
      executedCommands.length = 0;
      __rexTest__.setRexExecutor((args) => {
        executedCommands.push(args);
        if (args[0] === "window" && args[1] === "inspect") {
          return JSON.stringify({
            layers: [{ blocks: [{ block_id: "block:b1" }, { block_id: "block:b2" }] }],
          });
        }
        return "";
      });

      registerSurfaceHandle({
        id: "tab-partial-multi",
        kind: "tab",
        name: "partial-multi",
        sessionId: "session:test",
        windowId: "window:w-partial-multi",
        status: "launched",
      });

      closeSurface("tab-partial-multi");
      assert.equal(
        executedCommands.some((c) => c[0] === "window" && c[1] === "close"),
        false,
        "must not close window when partial creation window has more than 1 block",
      );

      // 4d. Do not unregister handle if close throws unexpected error
      executedCommands.length = 0;
      __rexTest__.setRexExecutor((args) => {
        executedCommands.push(args);
        if (args[0] === "window" && args[1] === "inspect") {
          return JSON.stringify({ layers: [{ blocks: [] }] });
        }
        if (args[0] === "window" && args[1] === "close") {
          throw new Error("RPC connection failure");
        }
        return "";
      });

      registerSurfaceHandle({
        id: "tab-partial-fail",
        kind: "tab",
        name: "partial-fail",
        sessionId: "session:test",
        windowId: "window:w-partial-fail",
        status: "launched",
      });

      assert.throws(() => closeSurface("tab-partial-fail"), /RPC connection failure/);
      const { getSurfaceHandle } = await import("../pi-extension/subagents/rex.ts");
      assert.ok(getSurfaceHandle("tab-partial-fail"), "handle must remain registered when close fails");
    } finally {
      for (const id of ["tab-lone", "tab-multi", "tab-err", "tab-partial-zero", "tab-partial-one", "tab-partial-multi", "tab-partial-fail"]) {
        unregisterSurfaceHandle(id);
      }
      __rexTest__.setRexContextOverride(null);
      __rexTest__.setCommandAvailabilityOverride(null);
      __rexTest__.setRexExecutor(null);
    }
  });

  it("sendMessage deterministically checks safety status and sends paste + enter events", async () => {
    const { registerSurfaceHandle, unregisterSurfaceHandle, sendMessage, __rexTest__ } = await import("../pi-extension/subagents/rex.ts");
    const executedCommands: string[][] = [];

    try {
      __rexTest__.setRexContextOverride({
        server: "unix:///tmp/mock.sock",
        session: "session:mock-session",
        block: "block:mock-anchor",
      });
      __rexTest__.setCommandAvailabilityOverride(true);

      // (a) Absent/missing status report rejects delivery and sends zero input events
      __rexTest__.setRexExecutor((args) => {
        executedCommands.push(args);
        if (args[0] === "block" && args[1] === "call" && args[args.length - 1] === "program_status") {
          return JSON.stringify({ records: [] });
        }
        return "{}";
      });

      registerSurfaceHandle({
        id: "steer-handle-test",
        kind: "tab",
        name: "steer-test",
        sessionId: "session:test",
        blockId: "block:steer-1",
        status: "launched",
      });

      assert.throws(
        () => sendMessage("steer-handle-test", "hello"),
        /No program status records available/,
      );
      assert.equal(
        executedCommands.some((c) => c[0] === "api" && c[1] === "call" && c[2] === "block.event"),
        false,
        "no input events should be sent when status is missing",
      );
      assert.equal(
        executedCommands.some((c) => c.some((arg) => typeof arg === "string" && (arg.includes('"type":"paste"') || arg.includes('"key":"enter"')))),
        false,
        "no paste or enter events should be dispatched when status is missing",
      );

      // (b) Blocked/error status report rejects delivery and sends zero input events
      executedCommands.length = 0;
      __rexTest__.setRexExecutor((args) => {
        executedCommands.push(args);
        if (args[0] === "block" && args[1] === "call" && args[args.length - 1] === "program_status") {
          return JSON.stringify({
            records: [
              { state: "blocked", kind: "permission", app: "pi", updated_at: "2026-11-01T00:00:00Z" },
            ],
          });
        }
        return "{}";
      });

      assert.throws(
        () => sendMessage("steer-handle-test", "hello"),
        /blocked on a permission dialog/,
      );
      assert.equal(
        executedCommands.some((c) => c[0] === "api" && c[1] === "call" && c[2] === "block.event"),
        false,
        "no input events should be sent when subagent is blocked",
      );
      assert.equal(
        executedCommands.some((c) => c.some((arg) => typeof arg === "string" && (arg.includes('"type":"paste"') || arg.includes('"key":"enter"')))),
        false,
        "no paste or enter events should be dispatched when subagent is blocked",
      );

      // (c) Valid unblocked Pi status report delivers paste event followed by Enter key event
      executedCommands.length = 0;
      __rexTest__.setRexExecutor((args) => {
        executedCommands.push(args);
        if (args[0] === "block" && args[1] === "call" && args[args.length - 1] === "program_status") {
          return JSON.stringify({
            records: [
              { state: "working", app: "pi", updated_at: "2026-11-01T00:00:00Z" },
            ],
          });
        }
        return "{}";
      });

      sendMessage("steer-handle-test", "hello world\n");
      const apiCalls = executedCommands.filter((c) => c[0] === "api" && c[1] === "call");
      assert.equal(apiCalls.length, 2, "expected paste event followed by enter key event");

      const pastePayload = JSON.parse(apiCalls[0][3]);
      assert.equal(pastePayload.event.type, "paste");
      assert.equal(pastePayload.event.payload.text, "hello world");

      const enterPayload = JSON.parse(apiCalls[1][3]);
      assert.equal(enterPayload.event.type, "key");
      assert.equal(enterPayload.event.payload.key, "enter");
    } finally {
      unregisterSurfaceHandle("steer-handle-test");
      __rexTest__.setRexExecutor(null);
      __rexTest__.setCommandAvailabilityOverride(undefined);
      __rexTest__.setRexContextOverride(undefined);
    }
  });

  it("hasCommand and isRexAvailable work with paths containing spaces", async () => {
    const { rexBin, __rexTest__, isMuxAvailable } = await import("../pi-extension/subagents/rex.ts");
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tempDir = mkdtempSync(join(tmpdir(), "rex test spaces-"));
    const customBin = join(tempDir, "custom rex");
    writeFileSync(customBin, "#!/bin/sh\nexit 0\n");
    chmodSync(customBin, 0o755);

    const origBin = process.env.REX_BIN_PATH;
    process.env.REX_BIN_PATH = customBin;

    try {
      assert.equal(__rexTest__.hasCommand(customBin), true, "hasCommand should detect executable path with spaces");

      __rexTest__.setRexContextOverride({
        server: "unix:///tmp/mock.sock",
        session: "session:mock-session",
        block: "block:mock-anchor",
      });
      assert.equal(isMuxAvailable(), true, "isMuxAvailable should be true when REX_BIN_PATH has spaces");
    } finally {
      if (origBin !== undefined) process.env.REX_BIN_PATH = origBin;
      else delete process.env.REX_BIN_PATH;
      __rexTest__.setRexContextOverride(undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  for (const { label, failedRename } of [
    { label: "literal 'agent' $name", failedRename: undefined },
    { label: "literal 'agent' $name", failedRename: "block" },
    { label: "-agent-name", failedRename: undefined },
    { label: "-agent-name", failedRename: "window" },
    { label: "-agent-name", failedRename: "block" },
    { label: "--dash-name", failedRename: undefined },
    { label: "--dash-name", failedRename: "window" },
    { label: "--dash-name", failedRename: "block" },
  ] as const) {
    it(`labels the returned top-level command pane ${JSON.stringify(label)}${failedRename ? ` and preserves it if ${failedRename} labeling fails` : " without relying on focus"}`, async (t) => {
      const { createSurface, sendLongCommand, closeSurface, getSurfaceHandle, __rexTest__ } = await import("../pi-extension/subagents/rex.ts");
      const dir = mkdtempSync(join(tmpdir(), "rex-label-"));
      const renameError = new Error("rename unavailable");
      const warning = t.mock.method(console, "warn", () => {});
      const savedName = process.env.PI_SUBAGENT_NAME;
      const savedTop = process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
      delete process.env.PI_SUBAGENT_NAME;
      delete process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
      const calls: string[][] = [];
      __rexTest__.setCommandAvailabilityOverride(true);
      __rexTest__.setRexContextOverride({ session: "session:label", block: "block:anchor" });
      __rexTest__.setRexExecutor((args) => {
        calls.push(args);
        if (args[0] === "window" && args[1] === "new") return JSON.stringify({ window_id: "window:label", block_ids: ["block:created"] });
        if ((args[0] === "block" || args[0] === "window") && args[1] === "rename") {
          assert.equal(getSurfaceHandle(surface)?.status, "launched", "command must be marked launched before labeling");
          if (args[0] === failedRename) throw renameError;
        }
        if (args[0] === "block" && args[1] === "inspect") return JSON.stringify({ block: { window_id: "window:label" } });
        if (args[0] === "window" && args[1] === "inspect") return JSON.stringify({ layers: [{ blocks: [{ block_id: "block:created" }] }] });
        return "{}";
      });
      const surface = createSurface(label);
      try {
        const scriptPath = join(dir, "launch.sh");
        assert.equal(sendLongCommand(surface, "true", { scriptPath }), scriptPath);
        assert.equal(getSurfaceHandle(surface)?.status, "launched");
        assert.equal(getSurfaceHandle(surface)?.windowId, "window:label");
        assert.equal(getSurfaceHandle(surface)?.blockId, "block:created");
        assert.equal(getSurfaceHandle(surface)?.name, label, "the original name must be preserved in the handle");
        assert.equal(calls.some((c) => c[1] === "close" || c[1] === "kill"), false,
          "labeling must not close or kill the launched surface");
        assert.equal(warning.mock.callCount(), failedRename ? 1 : 0);
        if (failedRename) {
          assert.deepEqual(warning.mock.calls[0].arguments,
            [`Failed to set ${failedRename === "window" ? "tab" : "pane"} label for subagent "${label}":`, renameError]);
        }
        assert.deepEqual(calls.find((c) => c[0] === "window" && c[1] === "new"),
          ["window", "new", "-s", "session:label", label.startsWith("-") ? `subagent${label}` : label,
            "--focus=false", "--keep-open", "--json", "--", "bash", "-l", scriptPath]);
        const tabRenames = calls.filter((c) => c[0] === "window" && c[1] === "rename");
        assert.deepEqual(tabRenames, label.startsWith("-")
          ? [["window", "rename", "-s", "session:label", "--", "window:label", label]]
          : [], "only leading-dash labels should need a tab rename, targeting the returned window ID");
        assert.deepEqual(calls.find((c) => c[0] === "block" && c[1] === "rename"),
          ["block", "rename", "-s", "session:label", "--", "block:created", label]);
      } finally {
        closeSurface(surface);
        __rexTest__.setRexExecutor(null);
        __rexTest__.setCommandAvailabilityOverride(undefined);
        __rexTest__.setRexContextOverride(undefined);
        if (savedName === undefined) delete process.env.PI_SUBAGENT_NAME; else process.env.PI_SUBAGENT_NAME = savedName;
        if (savedTop === undefined) delete process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE; else process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = savedTop;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("launch failure cleans up created resources if Rex returns IDs on error.stdout", async () => {
    const { createSurface, sendLongCommand, getSurfaceHandle, __rexTest__ } = await import("../pi-extension/subagents/rex.ts");
    const executedCommands: string[][] = [];

    const savedName = process.env.PI_SUBAGENT_NAME;
    const savedTopLevel = process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
    delete process.env.PI_SUBAGENT_NAME;
    delete process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;

    try {
      __rexTest__.setRexContextOverride({
        server: "unix:///tmp/mock.sock",
        session: "session:mock-session",
        block: "block:mock-anchor",
      });
      __rexTest__.setCommandAvailabilityOverride(true);

      // Force an error where error.stdout contains JSON with window_id and block_ids
      // while error.message contains unrelated/extraneous JSON
      __rexTest__.setRexExecutor((args) => {
        executedCommands.push(args);
        if (args[0] === "block" && args[1] === "inspect") {
          return JSON.stringify({ block: { block_id: "block:mock-anchor" } });
        }
        if (args[0] === "window" && args[1] === "inspect") {
          return JSON.stringify({
            layers: [{ blocks: [{ block_id: "block:stdout-blk" }] }],
          });
        }
        if (args[0] === "window" && args[1] === "new") {
          const err = new Error('rex window new failed: {"message_extra_json": "ignore_me"}');
          (err as any).stdout = JSON.stringify({
            window_id: "window:stdout-win",
            block_ids: ["block:stdout-blk"],
          });
          throw err;
        }
        return "{}";
      });

      const surfaceId = createSurface("stdout-fail-test");
      const handle = getSurfaceHandle(surfaceId);
      assert.ok(handle);
      assert.equal(handle.kind, "tab");

      assert.throws(() => {
        sendLongCommand(surfaceId, "echo fail");
      });

      // Assert that closeSurface cleaned up the captured window_id from error.stdout
      assert.equal(getSurfaceHandle(surfaceId), undefined);
      assert.ok(
        executedCommands.some((c) => c[0] === "window" && c[1] === "close" && c.includes("window:stdout-win")),
        "closeSurface should have closed the created window extracted from error.stdout",
      );
    } finally {
      if (savedName !== undefined) process.env.PI_SUBAGENT_NAME = savedName;
      if (savedTopLevel !== undefined) process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = savedTopLevel;
      __rexTest__.setRexExecutor(null);
      __rexTest__.setCommandAvailabilityOverride(undefined);
      __rexTest__.setRexContextOverride(undefined);
    }
  });

  it("launch failure cleans up created resources if Rex returns IDs but post-processing fails", async () => {
    const { createSurface, sendLongCommand, getSurfaceHandle, __rexTest__ } = await import("../pi-extension/subagents/rex.ts");
    const executedCommands: string[][] = [];

    const savedName = process.env.PI_SUBAGENT_NAME;
    const savedTopLevel = process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
    delete process.env.PI_SUBAGENT_NAME;
    delete process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;

    try {
      __rexTest__.setRexContextOverride({
        server: "unix:///tmp/mock.sock",
        session: "session:mock-session",
        block: "block:mock-anchor",
      });
      __rexTest__.setCommandAvailabilityOverride(true);

      // Force an error after Rex creation (e.g. by intercepting launch)
      __rexTest__.setRexExecutor((args) => {
        executedCommands.push(args);
        if (args[0] === "block" && args[1] === "inspect") {
          return JSON.stringify({ block: { block_id: "block:mock-anchor" } });
        }
        if (args[0] === "window" && args[1] === "inspect") {
          return JSON.stringify({
            layers: [{ blocks: [{ block_id: "block:partial-blk" }] }],
          });
        }
        if (args[0] === "window" && args[1] === "new") {
          // returns malformed JSON that has a partial window_id in error message
          throw new Error('rex window new failed: {"window_id":"window:partial-win","block_ids":["block:partial-blk"]}');
        }
        return "{}";
      });

      const surfaceId = createSurface("fail-test");
      const handle = getSurfaceHandle(surfaceId);
      assert.ok(handle);
      assert.equal(handle.kind, "tab");

      assert.throws(() => {
        sendLongCommand(surfaceId, "echo fail");
      });

      // Assert that closeSurface cleaned up the captured partial window
      assert.equal(getSurfaceHandle(surfaceId), undefined);
      assert.ok(
        executedCommands.some((c) => c[0] === "window" && c[1] === "close" && c.includes("window:partial-win")),
        "closeSurface should have closed the created window after launch failure",
      );
    } finally {
      if (savedName !== undefined) process.env.PI_SUBAGENT_NAME = savedName;
      if (savedTopLevel !== undefined) process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = savedTopLevel;
      __rexTest__.setRexExecutor(null);
      __rexTest__.setCommandAvailabilityOverride(undefined);
      __rexTest__.setRexContextOverride(undefined);
    }
  });

  it("createSurfaceSplit parent-handle resolution runs deterministically with stubbed inspection", async () => {
    const { registerSurfaceHandle, unregisterSurfaceHandle, createSurfaceSplit, getSurfaceHandle, __rexTest__ } = await import("../pi-extension/subagents/rex.ts");

    __rexTest__.setRexContextOverride({
      server: "unix:///tmp/mock.sock",
      session: "session:mock-session",
      block: "block:mock-anchor",
    });
    __rexTest__.setCommandAvailabilityOverride(true);

    __rexTest__.setRexExecutor((args) => {
      if (args[0] === "block" && args[1] === "inspect") {
        return JSON.stringify({ block: { block_id: args[args.length - 1] } });
      }
      return "{}";
    });

    registerSurfaceHandle({
      id: "parent-handle-stub",
      kind: "tab",
      name: "parent-stub",
      sessionId: "session:stub",
      blockId: "block:stub-parent",
      status: "launched",
    });

    registerSurfaceHandle({
      id: "unlaunched-parent-stub",
      kind: "tab",
      name: "unlaunched-stub",
      sessionId: "session:stub",
      status: "reserved",
    });

    try {
      const splitHandleId = createSurfaceSplit("child-stub-test", "right", "parent-handle-stub");
      const splitHandle = getSurfaceHandle(splitHandleId);
      assert.ok(splitHandle);
      assert.equal(splitHandle.anchorBlockId, "block:stub-parent");
      assert.equal(splitHandle.sessionId, "session:stub");

      assert.throws(
        () => createSurfaceSplit("child-stub-fail", "right", "unlaunched-parent-stub"),
        /has not been launched yet; no block ID available to split/,
      );
    } finally {
      unregisterSurfaceHandle("parent-handle-stub");
      unregisterSurfaceHandle("unlaunched-parent-stub");
      __rexTest__.setRexExecutor(null);
      __rexTest__.setCommandAvailabilityOverride(undefined);
      __rexTest__.setRexContextOverride(undefined);
    }
  });

  describe("Milestone 3: Lifecycle and steering unit tests", () => {
    it("Task 3.1: generated launch scripts preserve real exit status, signals, sidecars, and alternate CLI sentinels", async () => {
      const { sendLongCommand, createSurface, getSurfaceHandle, registerSurfaceHandle, unregisterSurfaceHandle, __rexTest__ } = await import("../pi-extension/subagents/rex.ts");
      const { readFileSync } = await import("node:fs");
      const { spawnSync } = await import("node:child_process");
      const testApi = (subagentsModule as any).__test__;

      const savedName = process.env.PI_SUBAGENT_NAME;
      const savedTopLevel = process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
      delete process.env.PI_SUBAGENT_NAME;
      delete process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;

      __rexTest__.setRexContextOverride({
        server: "unix:///tmp/mock.sock",
        session: "session:mock-session",
        block: "block:mock-anchor",
      });
      __rexTest__.setCommandAvailabilityOverride(true);

      let launchedScript = "";
      __rexTest__.setRexExecutor((args) => {
        if (args[0] === "block" && args[1] === "inspect") {
          return JSON.stringify({ block: { block_id: "block:mock-anchor" } });
        }
        if (args[0] === "window" && args[1] === "new") {
          // extract the scriptPath argument
          launchedScript = args[args.length - 1];
          return JSON.stringify({ window_id: "window:w-status", block_ids: ["block:b-status"] });
        }
        if (args[0] === "split") {
          launchedScript = args[args.length - 1];
          return JSON.stringify({ block_ids: ["block:b-split"] });
        }
        return "{}";
      });

      let surfaceId: string | undefined;
      try {
        surfaceId = createSurface("status-preserve-test");
        // Test production wrapper builder wrapLaunchCommand directly
        const wrappedSuccess = testApi.wrapLaunchCommand("true");
        const wrappedFailure = testApi.wrapLaunchCommand("bash -c 'exit 42'");
        const wrappedSignal = testApi.wrapLaunchCommand("bash -c 'kill -TERM $$'");

        // Execute wrapped scripts through bash and verify exit status and sentinel
        const runSuccess = spawnSync("bash", ["-c", wrappedSuccess], { encoding: "utf8" });
        assert.equal(runSuccess.status, 0);
        assert.match(runSuccess.stdout, /__SUBAGENT_DONE_0__/);

        const runFailure = spawnSync("bash", ["-c", wrappedFailure], { encoding: "utf8" });
        assert.equal(runFailure.status, 42);
        assert.match(runFailure.stdout, /__SUBAGENT_DONE_42__/);

        const runSignal = spawnSync("bash", ["-c", wrappedSignal], { encoding: "utf8" });
        assert.equal(runSignal.status, 143); // 128 + 15
        assert.match(runSignal.stdout, /__SUBAGENT_DONE_143__/);

        // Verify sendLongCommand writes the wrapped command to the launch script
        const scriptPath = sendLongCommand(surfaceId, wrappedFailure);
        assert.ok(launchedScript.length > 0, "script must be launched");
        assert.equal(launchedScript, scriptPath);

        const content = readFileSync(scriptPath, "utf8");
        assert.match(content, /status=\$\?; echo "__SUBAGENT_DONE_\$\{status\}__"; exit "\$status"/);

        // Positive exit sidecar tests
        assert.deepEqual(
          __rexTest__.interpretExitSidecar({ type: "done" }),
          { reason: "done", exitCode: 0 },
        );
        assert.deepEqual(
          __rexTest__.interpretExitSidecar({ type: "error", errorMessage: "Rate limited", stopReason: "error" }),
          { reason: "error", exitCode: 1, errorMessage: "Rate limited" },
        );
        // Negative / fallback exit sidecar tests
        const emptyError = __rexTest__.interpretExitSidecar({ type: "error" });
        assert.equal(emptyError.reason, "error");
        assert.equal(emptyError.exitCode, 1);
        assert.match(emptyError.errorMessage ?? "", /no errorMessage/);

        // Unknown sidecar payload does not report success
        const unknownSidecar = __rexTest__.interpretExitSidecar({ type: "unknown" });
        assert.equal(unknownSidecar.reason, "error");
        assert.equal(unknownSidecar.exitCode, 1);
        assert.match(unknownSidecar.errorMessage ?? "", /Unrecognized or corrupt/);

        // Corrupt / null / string sidecar payload does not report success
        const nullSidecar = __rexTest__.interpretExitSidecar(null);
        assert.equal(nullSidecar.reason, "error");
        assert.equal(nullSidecar.exitCode, 1);
        assert.match(nullSidecar.errorMessage ?? "", /Unrecognized or corrupt/);
      } finally {
        if (savedName !== undefined) process.env.PI_SUBAGENT_NAME = savedName;
        if (savedTopLevel !== undefined) process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = savedTopLevel;
        if (surfaceId) unregisterSurfaceHandle(surfaceId);
        __rexTest__.setRexExecutor(null);
        __rexTest__.setCommandAvailabilityOverride(undefined);
        __rexTest__.setRexContextOverride(undefined);
      }
    });

    it("Task 3.2: cancellable process observation distinguishes live, done, interruption, and bounded sustained infrastructure failure", async () => {
      const { registerSurfaceHandle, unregisterSurfaceHandle, __rexTest__ } = await import("../pi-extension/subagents/rex.ts");

      // 1. Live process with done report
      let processCallCount = 0;
      __rexTest__.setRexExecutor((args) => {
        if (args[0] === "block" && args[1] === "call" && args[args.length - 1] === "process") {
          processCallCount++;
          if (processCallCount === 1) {
            // Live: last_exit is null
            return JSON.stringify({ last_exit: null, child: { pid: 1234, name: "pi" } });
          }
          // Completed: exit code 0
          return JSON.stringify({ last_exit: { exit_code: 0 } });
        }
        return "{}";
      });

      registerSurfaceHandle({
        id: "poll-done-surface",
        kind: "tab",
        name: "poll-done",
        sessionId: "session:mock",
        blockId: "block:done-1",
        status: "launched",
      });

      const abortCtrl = new AbortController();
      try {
        const res = await __rexTest__.pollForExit("poll-done-surface", abortCtrl.signal, { interval: 10 });
        assert.equal(res.reason, "done");
        assert.equal(res.exitCode, 0);

        // 2. Confirmed pane closure (not_found -> interrupted)
        __rexTest__.setRexExecutor((args) => {
          if (args[0] === "block" && args[1] === "call" && args[args.length - 1] === "process") {
            throw new Error('block "block:done-1" not found');
          }
          return "{}";
        });
        const interruptRes = await __rexTest__.pollForExit("poll-done-surface", abortCtrl.signal, { interval: 10 });
        assert.equal(interruptRes.reason, "interrupted");
        assert.equal(interruptRes.exitCode, 1);
        assert.match(interruptRes.errorMessage ?? "", /closed externally/);

        // 3. Transient transport failure recovers without interruption
        let failCount = 0;
        __rexTest__.setRexExecutor((args) => {
          if (args[0] === "block" && args[1] === "call" && args[args.length - 1] === "process") {
            failCount++;
            if (failCount === 1) {
              throw new Error("temporary network glitch");
            }
            return JSON.stringify({ last_exit: { exit_code: 0 } });
          }
          return "{}";
        });
        const recoverRes = await __rexTest__.pollForExit("poll-done-surface", abortCtrl.signal, { interval: 10 });
        assert.equal(recoverRes.reason, "done");
        assert.equal(recoverRes.exitCode, 0);

        // 4. Bounded sustained infrastructure failure throws error after maxConsecutiveErrors
        __rexTest__.setRexExecutor((args) => {
          if (args[0] === "block" && args[1] === "call" && args[args.length - 1] === "process") {
            throw new Error("persistent connection refused");
          }
          return "{}";
        });
        await assert.rejects(
          __rexTest__.pollForExit("poll-done-surface", abortCtrl.signal, { interval: 5, maxConsecutiveErrors: 3 }),
          /Sustained infrastructure failure observing Rex block/,
        );

        // 4b. Malformed empty object process reply triggers RexInfrastructureError without infinite polling
        __rexTest__.setRexExecutor((args) => {
          if (args[0] === "block" && args[1] === "call" && args[args.length - 1] === "process") {
            return "{}";
          }
          return "{}";
        });
        await assert.rejects(
          __rexTest__.pollForExit("poll-done-surface", abortCtrl.signal, { interval: 5, maxConsecutiveErrors: 3 }),
          /Sustained infrastructure failure observing Rex block/,
        );

        // 5. Cancellation via AbortSignal
        const preAborted = new AbortController();
        preAborted.abort();
        await assert.rejects(
          __rexTest__.pollForExit("poll-done-surface", preAborted.signal, { interval: 10 }),
          /Aborted/,
        );

        // 6. Sidecar file race test: if .exit exists while last_exit is null, polling continues until process exit
        const dir = createTestDir();
        const testSessionFile = join(dir, "race-test.jsonl");
        writeFileSync(testSessionFile, "");
        writeFileSync(
          `${testSessionFile}.exit`,
          JSON.stringify({ type: "error", errorMessage: "Early error", stopReason: "error" }),
        );

        let liveChecks = 0;
        __rexTest__.setRexExecutor((args) => {
          if (args[0] === "block" && args[1] === "call" && args[args.length - 1] === "process") {
            liveChecks++;
            if (liveChecks < 3) {
              // Still running when sidecar was first read
              return JSON.stringify({ last_exit: null, child: { pid: 4321, name: "pi" } });
            }
            // Finally terminated
            return JSON.stringify({ last_exit: { exit_code: 1, error: "Early error" } });
          }
          return "{}";
        });

        try {
          const raceRes = await __rexTest__.pollForExit("poll-done-surface", abortCtrl.signal, {
            interval: 5,
            sessionFile: testSessionFile,
          });
          assert.ok(liveChecks >= 3, `polling must continue until process exit (checked ${liveChecks} times)`);
          assert.equal(raceRes.reason, "error");
          assert.equal(raceRes.exitCode, 1);
          assert.equal(raceRes.errorMessage, "Early error");

          // Error sidecar accompanied by process exit code 42 must retain exit code 42
          const exit42SessionFile = join(dir, "sidecar-42.jsonl");
          writeFileSync(exit42SessionFile, JSON.stringify(SESSION_HEADER) + "\n");
          const exit42SidecarPath = `${exit42SessionFile}.exit`;
          writeFileSync(exit42SidecarPath, JSON.stringify({ type: "error", errorMessage: "Failed with custom exit code" }));

          registerSurfaceHandle({
            id: "poll-42-surface",
            kind: "split",
            name: "sidecar-42",
            sessionId: "session:mock",
            blockId: "block:sidecar-42-block",
            status: "launched",
          });

          __rexTest__.setRexExecutor((args) => {
            if (args[0] === "block" && args[1] === "call" && args[args.length - 1] === "process") {
              return JSON.stringify({ last_exit: { exit_code: 42, error: "Subagent process failed" } });
            }
            return "{}";
          });

          const res42 = await __rexTest__.pollForExit("poll-42-surface", abortCtrl.signal, {
            interval: 5,
            sessionFile: exit42SessionFile,
          });
          assert.equal(res42.reason, "error");
          assert.equal(res42.exitCode, 42, "provider sidecar must not hide real nonzero exit code (42)");
          assert.equal(res42.errorMessage, "Failed with custom exit code");
          unregisterSurfaceHandle("poll-42-surface");

          // Sidecar read while process is alive, then pane closed externally (not_found) => reason: "interrupted"
          const sidecarSessionFile = join(dir, "sidecar-interrupt.jsonl");
          writeFileSync(sidecarSessionFile, JSON.stringify(SESSION_HEADER) + "\n");
          const exitSidecarPath = `${sidecarSessionFile}.exit`;
          writeFileSync(exitSidecarPath, JSON.stringify({ type: "done" }));

          registerSurfaceHandle({
            id: "poll-sidecar-surface",
            kind: "split",
            name: "sidecar-interrupt",
            sessionId: "session:mock",
            blockId: "block:sidecar-block",
            status: "launched",
          });

          let queryCount = 0;
          __rexTest__.setRexExecutor((args) => {
            if (args[0] === "block" && args[1] === "call" && args[args.length - 1] === "process") {
              queryCount++;
              if (queryCount === 1) {
                // First query: process still alive, sidecar file will be read
                return JSON.stringify({ last_exit: null, child: { pid: 9999, name: "pi" } });
              }
              // Second query: pane was closed externally
              throw new Error('block "block:sidecar-block" not found');
            }
            return "{}";
          });

          const sidecarInterruptRes = await __rexTest__.pollForExit("poll-sidecar-surface", abortCtrl.signal, {
            interval: 5,
            sessionFile: sidecarSessionFile,
          });
          assert.equal(sidecarInterruptRes.reason, "interrupted", "pane closed externally after reading sidecar must report interrupted");
          unregisterSurfaceHandle("poll-sidecar-surface");

          // Late sidecar race: sidecar written concurrently with process exit query
          // Initial check before Rex query sees no sidecar; process returns exit 0; late check discovers sidecar!
          const lateSidecarSession = join(dir, "late-sidecar.jsonl");
          writeFileSync(lateSidecarSession, JSON.stringify(SESSION_HEADER) + "\n");
          registerSurfaceHandle({
            id: "poll-late-sidecar-surface",
            kind: "split",
            name: "late-sidecar",
            sessionId: "session:mock",
            blockId: "block:late-sidecar-block",
            status: "launched",
          });

          __rexTest__.setRexExecutor((args) => {
            if (args[0] === "block" && args[1] === "call" && args[args.length - 1] === "process") {
              // Simulate Pi writing the .exit sidecar concurrently while queryBlockProcess is running
              writeFileSync(
                `${lateSidecarSession}.exit`,
                JSON.stringify({ type: "error", errorMessage: "Late discovery error" }),
              );
              return JSON.stringify({ last_exit: { exit_code: 0 } });
            }
            return "{}";
          });

          const lateSidecarRes = await __rexTest__.pollForExit("poll-late-sidecar-surface", abortCtrl.signal, {
            interval: 5,
            sessionFile: lateSidecarSession,
          });
          assert.equal(lateSidecarRes.reason, "error", "late sidecar must be discovered and applied");
          assert.equal(lateSidecarRes.errorMessage, "Late discovery error");
          assert.equal(existsSync(`${lateSidecarSession}.exit`), false, "late sidecar file should be cleaned up");
          unregisterSurfaceHandle("poll-late-sidecar-surface");
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      } finally {
        unregisterSurfaceHandle("poll-done-surface");
        __rexTest__.setRexExecutor(null);
      }
    });

    it("Task 3.3: separates result collection from idempotent resource cleanup", async (t) => {
      const { registerSurfaceHandle, unregisterSurfaceHandle, closeSurface, getSurfaceHandle, __rexTest__ } = await import("../pi-extension/subagents/rex.ts");
      const testApi = (subagentsModule as any).__test__;

      const executedCommands: string[][] = [];
      __rexTest__.setRexExecutor((args) => {
        executedCommands.push(args);
        if (args[0] === "window" && args[1] === "close") {
          throw new Error("window already closed by user");
        }
        if (args[0] === "block" && args[1] === "close") {
          throw new Error("block already closed by user");
        }
        return "{}";
      });

      registerSurfaceHandle({
        id: "cleanup-res-surface",
        kind: "split",
        name: "cleanup-res",
        sessionId: "session:mock",
        blockId: "block:gone-block",
        status: "launched",
      });

      const dir = createTestDir();
      try {
        // closeSurface must be idempotent and not throw even if the target is already absent
        assert.doesNotThrow(() => closeSurface("cleanup-res-surface"));
        assert.equal(getSurfaceHandle("cleanup-res-surface"), undefined);

        // Second call on already-closed/unregistered surface is also a safe no-op
        assert.doesNotThrow(() => closeSurface("cleanup-res-surface"));

        // Transient transport error other than not_found must NOT silently drop tracking
        let transientExecuted = false;
        __rexTest__.setRexExecutor((args) => {
          if (args[0] === "block" && args[1] === "close") {
            transientExecuted = true;
            throw new Error("temporary network timeout communicating with server");
          }
          return "{}";
        });
        registerSurfaceHandle({
          id: "transient-fail-surface",
          kind: "split",
          name: "transient-fail",
          sessionId: "session:mock",
          blockId: "block:transient-block",
          status: "launched",
        });

        assert.throws(
          () => closeSurface("transient-fail-surface"),
          /temporary network timeout/,
        );
        assert.equal(transientExecuted, true);
        // Handle must still remain tracked because cleanup was uncertain
        assert.ok(getSurfaceHandle("transient-fail-surface"));
        unregisterSurfaceHandle("transient-fail-surface");
        // Pending cleanup retry queue test:
        // When safeCloseSurface encounters a transient error, it enqueues the surface in pendingCleanups.
        // When transport recovers, processPendingCleanups() successfully removes it.
        let closeAttempts = 0;
        __rexTest__.setRexExecutor((args) => {
          if (args[0] === "block" && args[1] === "close") {
            closeAttempts++;
            if (closeAttempts === 1) {
              throw new Error("transient socket glitch");
            }
            return "{}";
          }
          return "{}";
        });
        registerSurfaceHandle({
          id: "retry-queue-surface",
          kind: "split",
          name: "retry-queue",
          sessionId: "session:mock",
          blockId: "block:retry-blk",
          status: "launched",
        });

        testApi.safeCloseSurface("retry-queue-surface");
        assert.equal(testApi.pendingCleanups.has("retry-queue-surface"), true, "failed surface must be in pendingCleanups");
        assert.ok(getSurfaceHandle("retry-queue-surface"), "handle must remain tracked before recovery");

        // Transport recovers on next attempt
        testApi.processPendingCleanups();
        assert.equal(testApi.pendingCleanups.has("retry-queue-surface"), false, "recovered surface must be removed from queue");
        assert.equal(getSurfaceHandle("retry-queue-surface"), undefined, "handle must be closed and unregistered");

        const fakeRunning = {
          id: "r-cleanup",
          name: "clean-agent",
          task: "task",
          surface: "cleanup-res-surface",
          startTime: Date.now(),
          sessionFile: "/tmp/nonexistent-session.jsonl",
          interactive: false,
          statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }),
        };

        // Stub pollForExit by using mocked process call returning exit 0
        let polled = false;
        __rexTest__.setRexExecutor((args) => {
          if (args[0] === "block" && args[1] === "call" && args[args.length - 1] === "process") {
            polled = true;
            return JSON.stringify({ last_exit: { exit_code: 0 } });
          }
          if (args[0] === "block" && args[1] === "close") {
            throw new Error("close failed cosmetic");
          }
          return "{}";
        });
        registerSurfaceHandle({
          id: "cleanup-res-surface",
          kind: "split",
          name: "cleanup-res",
          sessionId: "session:mock",
          blockId: "block:polled-block",
          status: "launched",
        });

        const watchRes = await testApi.watchSubagent(fakeRunning, new AbortController().signal);
        assert.equal(polled, true);
        assert.equal(watchRes.outcome, "success");
        assert.equal(watchRes.exitCode, 0);
        assert.equal(watchRes.summary, "Sub-agent exited without output");

        await t.test("exhausted cleanup retries log the final error without changing the collected result", (t) => {
          const collectedResult = structuredClone(watchRes);
          const diagnostic = t.mock.method(console, "error", () => {});
          assert.ok(testApi.pendingCleanups.has("cleanup-res-surface"));
          for (let retry = 0; retry < 5; retry++) testApi.processPendingCleanups();
          assert.equal(testApi.pendingCleanups.has("cleanup-res-surface"), false);
          assert.equal(diagnostic.mock.calls.length, 1);
          assert.match(diagnostic.mock.calls[0].arguments[0], /Failed to clean up surface cleanup-res-surface after retries exhausted:/);
          assert.match(diagnostic.mock.calls[0].arguments[0], /close failed cosmetic/);
          assert.deepEqual(watchRes, collectedResult);
        });

        // Infrastructure observation failure test:
        // When polling fails with RexInfrastructureError after maxConsecutiveErrors,
        // watchSubagent must report the failure, keep the surface tracked, and NOT kill or close it.
        const infraRunning = {
          id: "r-infra",
          name: "infra-agent",
          task: "task",
          surface: "cleanup-res-surface",
          startTime: Date.now(),
          sessionFile: join(dir, "infra-session.jsonl"),
          interactive: false,
          statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }),
        };
        writeFileSync(infraRunning.sessionFile, JSON.stringify(SESSION_HEADER) + "\n");
        writeSubagentLoadout(infraRunning.sessionFile, {
          agent: "worker",
          toolAllowlist: "read",
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          autoExit: true,
          cwd: dir,
          agentDir: null,
        });
        const parentArtDir = join(dir, "artifacts", "main-sess");
        mkdirSync(parentArtDir, { recursive: true });
        registerName(parentArtDir, "infra-agent", {
          sessionFile: infraRunning.sessionFile,
          sessionId: "sess-infra",
        });

        __rexTest__.setRexExecutor((args) => {
          if (args[0] === "block" && args[1] === "call" && args[args.length - 1] === "process") {
            throw new Error("persistent connection refused");
          }
          if (args[0] === "block" && args[1] === "close") {
            throw new Error("should not be called on infra error");
          }
          return "{}";
        });
        registerSurfaceHandle({
          id: "cleanup-res-surface",
          kind: "split",
          name: "cleanup-res",
          sessionId: "session:mock",
          blockId: "block:infra-block",
          status: "launched",
        });

        const infraRes = await testApi.watchSubagent(infraRunning, new AbortController().signal);
        assert.equal(infraRes.outcome, "failure");
        assert.equal(infraRes.observationFailure, true);
        assert.match(infraRes.summary, /Pane was kept open/);
        assert.ok(getSurfaceHandle("cleanup-res-surface"), "surface must remain open and tracked on infrastructure error");

        // Verify finding 1: lost-observation session cannot be resumed
        assert.ok(testApi.lostObservationSessions.has(resolve(infraRunning.sessionFile)));
        __rexTest__.setCommandAvailabilityOverride(true);
        __rexTest__.setRexContextOverride({
          server: "unix:///tmp/mock.sock",
          session: "session:mock",
          block: "block:mock-anchor",
        });
        const { api: infraApi, registeredTools: infraTools } = createMockExtensionApi();
        (subagentsModule as any).default(infraApi);
        const infraMsgTool = infraTools.find((t: any) => t.name === "subagent_message");
        const resumeInfraRes = await infraMsgTool.execute(
          "msg-call-infra",
          { name: "infra-agent", message: "try resume" },
          undefined,
          undefined,
          {
            sessionManager: {
              getSessionDir: () => dir,
              getSessionId: () => "main-sess",
              getSessionFile: () => join(dir, "main.jsonl"),
            },
          },
        );
        assert.match(resumeInfraRes.content[0].text, /observation of its previous run was lost/);
        assert.match(resumeInfraRes.content[0].text, /process may still be active/);

        // Finding 1 restart simulation: clear in-memory set, persistent marker remains
        testApi.lostObservationSessions.clear();
        assert.equal(testApi.lostObservationSessions.size, 0);
        const restartResumeRes = await infraMsgTool.execute(
          "msg-call-restart",
          { name: "infra-agent", message: "try resume after restart" },
          undefined,
          undefined,
          {
            sessionManager: {
              getSessionDir: () => dir,
              getSessionId: () => "main-sess",
              getSessionFile: () => join(dir, "main.jsonl"),
            },
          },
        );
        assert.match(restartResumeRes.content[0].text, /observation of its previous run was lost/);
        assert.match(restartResumeRes.content[0].text, /process may still be active/);

        // Verify confirmProcessEnded clears the guard and allows resume
        testApi.confirmProcessEnded(infraRunning.sessionFile);
        assert.equal(testApi.lostObservationSessions.has(resolve(infraRunning.sessionFile)), false);
        const { hasLostObservationMarker } = await import("../pi-extension/subagents/session.ts");
        assert.equal(hasLostObservationMarker(infraRunning.sessionFile), false);

        // Verify hasLostObservationMarker fails closed when read/stat throws
        const { lostObservationMarkerPath, __setStatSyncOverride } = await import("../pi-extension/subagents/session.ts");
        const markerPath = lostObservationMarkerPath(infraRunning.sessionFile);
        // Test fails closed behavior directly by mocking statSync with non-ENOENT error
        try {
          __setStatSyncOverride((p: string) => {
            if (p === markerPath) {
              const err = new Error("Permission denied") as any;
              err.code = "EACCES";
              throw err;
            }
            return statSync(p);
          });
          assert.equal(hasLostObservationMarker(infraRunning.sessionFile), true, "hasLostObservationMarker must fail closed on EACCES");
        } finally {
          __setStatSyncOverride(null);
        }

        // Verify write failure handling in watchSubagent
        const readOnlyDir = join(dir, "readonly-dir");
        mkdirSync(readOnlyDir, { recursive: true });
        const readOnlySession = join(readOnlyDir, "sess-unwritable.jsonl");
        writeFileSync(readOnlySession, JSON.stringify(SESSION_HEADER) + "\n");
        const failingRunning = {
          id: "child-failing-writer",
          name: "failing-agent",
          task: "failing task",
          surface: "cleanup-res-surface",
          startTime: Date.now(),
          sessionFile: readOnlySession,
          interactive: false,
          statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }),
        };

        const { writeLostObservationMarker, __setWriteFileSyncOverride } = await import("../pi-extension/subagents/session.ts");
        try {
          __setWriteFileSyncOverride(((p: string, ...rest: any[]) => {
            if (typeof p === "string" && p.endsWith(".lost-observation")) {
              const err = new Error("Disk full or permission denied") as any;
              err.code = "EIO";
              throw err;
            }
            return (writeFileSync as any)(p, ...rest);
          }) as any);

          const writeFailRes = await testApi.watchSubagent(failingRunning, new AbortController().signal);
          assert.equal(writeFailRes.outcome, "failure");
          assert.equal(writeFailRes.observationFailure, true);
          assert.match(writeFailRes.summary, /failed to persist safety marker/);
          // Infrastructure failure must still be recorded in in-memory guard
          assert.ok(testApi.lostObservationSessions.has(resolve(readOnlySession)));
        } finally {
          __setWriteFileSyncOverride(null);
        }

        // writeLostObservationMarker throws when target directory does not exist
        assert.throws(() => writeLostObservationMarker("/nonexistent-dir/session.jsonl"));

        // Finding 1: reconcileLostObservations clears guard and enables resume when process exits or pane missing
        const reconcileDir = join(dir, "reconcile-test");
        mkdirSync(reconcileDir, { recursive: true });
        const reconcileSession = join(reconcileDir, "reconcile-sess.jsonl");
        writeFileSync(reconcileSession, JSON.stringify(SESSION_HEADER) + "\n");
        registerName(parentArtDir, "reconcile-agent", {
          sessionFile: reconcileSession,
          sessionId: "sess-reconcile",
        });
        registerSurfaceHandle({
          id: "reconcile-surface",
          kind: "split",
          name: "reconcile-agent",
          sessionId: "session:mock",
          blockId: "block:reconcile-block",
          status: "launched",
        });
        const reconcileRunning = {
          id: "reconcile-run-id",
          name: "reconcile-agent",
          task: "reconcile task",
          surface: "reconcile-surface",
          startTime: Date.now(),
          sessionFile: reconcileSession,
          interactive: false,
          statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }),
        };

        // Trigger infrastructure failure to put into lost-observation state
        __rexTest__.setRexExecutor((args) => {
          if (args[0] === "block" && args[1] === "call" && args[args.length - 1] === "process") {
            throw new Error("persistent connection refused");
          }
          return "{}";
        });
        await testApi.watchSubagent(reconcileRunning, new AbortController().signal);
        assert.ok(testApi.lostObservationSessions.has(resolve(reconcileSession)));
        assert.ok(hasLostObservationMarker(reconcileSession));

        // When queryBlockProcess reports process exit, reconcileLostObservations clears the guard
        __rexTest__.setRexExecutor((args) => {
          if (args[0] === "block" && args[1] === "call" && args[args.length - 1] === "process") {
            return JSON.stringify({ last_exit: { exit_code: 0 } });
          }
          if (args[0] === "block" && args[1] === "close") {
            return "{}";
          }
          return "{}";
        });
        testApi.reconcileLostObservations();
        assert.equal(testApi.lostObservationSessions.has(resolve(reconcileSession)), false);
        assert.equal(hasLostObservationMarker(reconcileSession), false);

        // Finding 1 restart simulation:
        // Disk marker has blockId and sessionId, but memory has lostObservationEntries/Sessions cleared
        writeLostObservationMarker(reconcileSession, {
          blockId: "block:mock-reconcile",
          sessionId: "session:mock",
          surface: "reconcile-surface",
        });
        testApi.lostObservationSessions.clear();
        testApi.lostObservationEntries.clear();
        assert.equal(testApi.lostObservationSessions.size, 0);
        assert.equal(testApi.lostObservationEntries.size, 0);
        assert.equal(hasLostObservationMarker(reconcileSession), true);

        // Resume tool handler checks readLostObservationMarker, queries queryBlockProcess, and clears marker
        const { api: restartApi, registeredTools: restartTools } = createMockExtensionApi();
        (subagentsModule as any).default(restartApi);
        const restartMsgTool = restartTools.find((t: any) => t.name === "subagent_message");
        assert.ok(restartMsgTool);

        await t.test("missing or empty process coordinates refuse resume and preserve the lost-observation guard", async () => {
          let rexCalls = 0;
          __rexTest__.setRexExecutor(() => {
            rexCalls++;
            throw new Error('block "block:mock-reconcile" not found');
          });
          const invalidCoordinates = [
            { blockId: "block:mock-reconcile" },
            { blockId: "block:mock-reconcile", sessionId: "" },
            { blockId: "block:mock-reconcile", sessionId: " \t " },
            { sessionId: "session:mock" },
            { blockId: "", sessionId: "session:mock" },
            { blockId: " \t ", sessionId: "session:mock" },
          ];
          for (const coordinates of invalidCoordinates) {
            for (const inMemory of [false, true]) {
              testApi.lostObservationSessions.clear();
              testApi.lostObservationEntries.clear();
              writeFileSync(lostObservationMarkerPath(reconcileSession), JSON.stringify(coordinates));
              if (inMemory) {
                testApi.lostObservationSessions.add(resolve(reconcileSession));
                testApi.lostObservationEntries.set(resolve(reconcileSession), {
                  sessionFile: reconcileSession,
                  surface: "reconcile-surface",
                  ...coordinates,
                  sessionId: coordinates.sessionId ?? "",
                });
              }
              const refused = await restartMsgTool.execute(
                "msg-incomplete-coordinates",
                { name: "reconcile-agent", message: "try resume" },
                undefined,
                undefined,
                {
                  sessionManager: {
                    getSessionDir: () => dir,
                    getSessionId: () => "main-sess",
                    getSessionFile: () => join(dir, "main.jsonl"),
                  },
                },
              );
              assert.match(refused.content[0].text, /observation of its previous run was lost/);
              assert.equal(hasLostObservationMarker(reconcileSession), true);
              if (inMemory) assert.ok(testApi.lostObservationSessions.has(resolve(reconcileSession)));
              assert.equal(rexCalls, 0, "incomplete coordinates must not query or close a process");
            }
          }
          testApi.lostObservationSessions.clear();
          testApi.lostObservationEntries.clear();
          writeLostObservationMarker(reconcileSession, {
            blockId: "block:mock-reconcile",
            sessionId: "session:mock",
            surface: "reconcile-surface",
          });
        });

        __rexTest__.setRexExecutor((args) => {
          if (args[0] === "block" && args[1] === "call" && args[args.length - 1] === "process") {
            return JSON.stringify({ last_exit: { exit_code: 0 } });
          }
          if (args[0] === "window" && args[1] === "new") {
            return JSON.stringify({ window_id: "win:resume-reconcile", block_ids: ["blk:resume-reconcile"] });
          }
          if (args[0] === "split") {
            return JSON.stringify({ block_ids: ["blk:resume-reconcile"] });
          }
          if (args[0] === "block" && args[1] === "inspect") {
            return JSON.stringify({ block: { block_id: "blk:resume-reconcile" } });
          }
          return "{}";
        });

        // Add loadout snapshot for reconcileSession so resume can execute
        writeSubagentLoadout(reconcileSession, {
          agent: "worker",
          toolAllowlist: "read",
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          autoExit: true,
          cwd: dir,
          agentDir: null,
        });

        const resumeRestartRes = await restartMsgTool.execute(
          "msg-reconcile-restart",
          { name: "reconcile-agent", message: "resume after restart" },
          undefined,
          undefined,
          {
            sessionManager: {
              getSessionDir: () => dir,
              getSessionId: () => "main-sess",
              getSessionFile: () => join(dir, "main.jsonl"),
            },
          },
        );

        assert.doesNotMatch(resumeRestartRes.content[0].text, /observation of its previous run was lost/);
        assert.equal(hasLostObservationMarker(reconcileSession), false);
      } finally {
        testApi.lostObservationSessions?.clear();
        testApi.lostObservationEntries?.clear();
        testApi.pendingCleanups?.clear();
        unregisterSurfaceHandle("cleanup-res-surface");
        unregisterSurfaceHandle("reconcile-surface");
        __rexTest__.setRexExecutor(null);
        __rexTest__.setCommandAvailabilityOverride(undefined);
        __rexTest__.setRexContextOverride(undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("Task 3.4: single-message newline flattening and safety status refusal vs ordinary input", async () => {
      const testApi = (subagentsModule as any).__test__;
      const { __rexTest__ } = await import("../pi-extension/subagents/rex.ts");

      // 1. Literal quotes, metacharacters, and multi-line message flattened to single turn
      let delivered = "";
      const fakeRunning = {
        id: "steer-test-id",
        name: "steer-test",
        task: "task",
        surface: "surf-1",
        startTime: Date.now(),
        sessionFile: "/tmp/s.jsonl",
        interactive: false,
        statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }),
      };

      const multiline = 'line 1\nline 2 "with quotes"\n`echo metachar` $VAR';
      const steerRes = testApi.steerSubagent(fakeRunning, multiline, (_surface: string, text: string) => {
        delivered = text;
      });
      assert.deepEqual(steerRes, { ok: true });
      assert.equal(delivered, 'line 1 line 2 "with quotes" `echo metachar` $VAR');

      // 2. Multi-record status where one is blocked or error refuses input
      const blockedRecords = [
        { state: "idle", app: "pi", updated_at: "2026-11-01T00:00:00Z" },
        { state: "blocked", kind: "question", app: "pi", msg: "Overwrite file?", updated_at: "2026-11-01T00:00:01Z" },
      ];
      const blockedCheck = __rexTest__.validateTrustworthyProgramStatus(blockedRecords, "pi");
      assert.equal(blockedCheck.ok, false);
      assert.match(blockedCheck.error, /blocked on a question dialog/);

      // 3. Ordinary waiting for orchestrator reply (state: idle/working, not blocked) succeeds
      const idleRecords = [
        { state: "idle", app: "pi", updated_at: "2026-11-01T00:00:00Z" },
      ];
      const idleCheck = __rexTest__.validateTrustworthyProgramStatus(idleRecords, "pi");
      assert.equal(idleCheck.ok, true);
      assert.equal(idleCheck.targetRecord.state, "idle");
    });

    it("Task 3.5: restricted name-based resume replays cwd/agent context and refuses missing snapshot", async () => {
      const { getSurfaceHandle } = await import("../pi-extension/subagents/rex.ts");
      const testApi = (subagentsModule as any).__test__;
      const dir = createTestDir();

      try {
        const sessionFile = join(dir, "resumable.jsonl");
        writeFileSync(sessionFile, JSON.stringify(SESSION_HEADER) + "\n");

        const sampleLoadout: SubagentLoadout = {
          agent: "worker",
          toolAllowlist: "read,write,edit",
          model: "anthropic/claude-3-5-sonnet",
          thinking: "medium",
          systemPromptMode: "append",
          identity: "You are the worker.",
          spawnable: ["scout", "researcher"],
          autoExit: true,
          cwd: "/path/to/custom/workdir",
          agentDir: "/path/to/agent/config",
        };
        writeSubagentLoadout(sessionFile, sampleLoadout);

        // Positive check: loadout reads back identical
        const loaded = readSubagentLoadout(sessionFile);
        assert.deepEqual(loaded, sampleLoadout);
        assert.equal(loaded?.cwd, "/path/to/custom/workdir");
        assert.deepEqual(loaded?.spawnable, ["scout", "researcher"]);

        // Negative check: session without loadout snapshot refuses resume
        const noSnapshotSession = join(dir, "no-snapshot.jsonl");
        writeFileSync(noSnapshotSession, JSON.stringify(SESSION_HEADER) + "\n");
        assert.equal(readSubagentLoadout(noSnapshotSession), null);

        // Verify subagent_message execution refuses when snapshot is absent
        const { api, registeredTools } = createMockExtensionApi();
        (subagentsModule as any).default(api);
        const messageTool = registeredTools.find((t: any) => t.name === "subagent_message");
        assert.ok(messageTool);

        const parentArtifactDir = join(dir, "artifacts", "main-sess");
        mkdirSync(parentArtifactDir, { recursive: true });
        registerName(parentArtifactDir, "missing-snapshot-agent", {
          sessionFile: noSnapshotSession,
          sessionId: "sess-no-snapshot",
        });

        // Mock context with sessionManager
        const mockCtx = {
          sessionManager: {
            getSessionDir: () => dir,
            getSessionId: () => "main-sess",
            getSessionFile: () => join(dir, "main.jsonl"),
          },
        };

        const { __rexTest__ } = await import("../pi-extension/subagents/rex.ts");
        __rexTest__.setRexContextOverride({
          server: "unix:///tmp/mock.sock",
          session: "session:mock-session",
          block: "block:mock-anchor",
        });
        __rexTest__.setCommandAvailabilityOverride(true);

        try {
          // Verify child command invocation builds restricted tool/model/identity arguments from snapshot
          const parts: string[] = ["pi", "--session", sampleLoadout.cwd!];
          const artifactDir = join(dir, "artifacts", "child-sess");
          mkdirSync(artifactDir, { recursive: true });
          testApi.applySandboxToParts(parts, sampleLoadout, { artifactDir, name: "worker" });

          assert.ok(parts.includes("--tools"), "parts must include --tools");
          const toolsIdx = parts.indexOf("--tools");
          assert.equal(parts[toolsIdx + 1], "'read,write,edit'");
          assert.ok(parts.includes("--model"), "parts must include --model");
          const modelIdx = parts.indexOf("--model");
          assert.equal(parts[modelIdx + 1], "'anthropic/claude-3-5-sonnet:medium'");
          assert.ok(parts.includes("--append-system-prompt"), "parts must include --append-system-prompt");
          const idIdx = parts.indexOf("--append-system-prompt");
          const sysPromptArg = parts[idIdx + 1];
          // applySandboxToParts writes long or multi-line system prompt to file and passes quoted path
          const strippedPath = sysPromptArg.replace(/^'|'$/g, "");
          assert.equal(readFileSync(strippedPath, "utf8"), "You are the worker.");

        // Verify resume when effectiveCwd is undefined replays ctx.cwd from the snapshot
        const rootSessionFile = join(dir, "default-cwd.jsonl");
        writeFileSync(rootSessionFile, JSON.stringify(SESSION_HEADER) + "\n");
        const defaultCwdLoadout: SubagentLoadout = {
          agent: "scout",
          toolAllowlist: "read,grep",
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          autoExit: true,
          cwd: "/path/from/parent/context/cwd",
          agentDir: null,
        };
        writeSubagentLoadout(rootSessionFile, defaultCwdLoadout);
        registerName(parentArtifactDir, "default-cwd-agent", {
          sessionFile: rootSessionFile,
          sessionId: "sess-default-cwd",
        });

        const rootLoaded = readSubagentLoadout(rootSessionFile);
        assert.equal(rootLoaded?.cwd, "/path/from/parent/context/cwd");

        let resumedCwd: string | undefined;
        let resumedScriptContent = "";
        __rexTest__.setRexExecutor((args) => {
          if (args[0] === "window" && args[1] === "new") {
            return JSON.stringify({ window_id: "win:resume-win", block_ids: ["blk:resume-blk"] });
          }
          if (args[0] === "split") {
            return JSON.stringify({ block_ids: ["blk:resume-blk"] });
          }
          if (args[0] === "block" && args[1] === "inspect") {
            return JSON.stringify({ block: { block_id: "blk:resume-blk" } });
          }
          if (args[0] === "block" && args[1] === "send") {
            // Check script execution cwd from command line or wrapper script
            return "{}";
          }
          return "{}";
        });

        const resumeMsgRes = await messageTool.execute(
          "msg-call-resume",
          { name: "default-cwd-agent", message: "resume task" },
          undefined,
          undefined,
          mockCtx,
        );
        assert.equal(resumeMsgRes.details?.status, "started");
        assert.ok(resumeMsgRes.details?.launchScriptFile);
        resumedScriptContent = readFileSync(resumeMsgRes.details.launchScriptFile, "utf8");
        assert.ok(
          resumedScriptContent.includes("cd '/path/from/parent/context/cwd'"),
          `resume script must cd to the snapshot's effective cwd (/path/from/parent/context/cwd). Found:\n${resumedScriptContent}`,
        );

        // Verify resume when loadout.agentDir === null does NOT fall back to PI_CODING_AGENT_DIR
        const nullAgentDirSessionFile = join(dir, "null-agent-dir.jsonl");
        writeFileSync(nullAgentDirSessionFile, JSON.stringify(SESSION_HEADER) + "\n");
        writeSubagentLoadout(nullAgentDirSessionFile, {
          agent: "worker",
          toolAllowlist: "read",
          model: null,
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          autoExit: true,
          cwd: dir,
          agentDir: null, // explicitly null
        });
        registerName(parentArtifactDir, "null-agent-dir-sub", {
          sessionFile: nullAgentDirSessionFile,
          sessionId: "sess-null-agent-dir",
        });

        const origEnvAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = "/changed/parent/agent/dir";
        try {
          const resumeNullAgentDirRes = await messageTool.execute(
            "msg-call-null-agent-dir",
            { name: "null-agent-dir-sub", message: "resume null agent dir" },
            undefined,
            undefined,
            mockCtx,
          );
          assert.equal(resumeNullAgentDirRes.details?.status, "started");
          assert.ok(resumeNullAgentDirRes.details?.launchScriptFile);
          const nullAgentScriptContent = readFileSync(resumeNullAgentDirRes.details.launchScriptFile, "utf8");
          assert.ok(
            !nullAgentScriptContent.includes("PI_CODING_AGENT_DIR="),
            `resumed script when loadout.agentDir is null must not inherit parent PI_CODING_AGENT_DIR. Found:\n${nullAgentScriptContent}`,
          );
        } finally {
          if (origEnvAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = origEnvAgentDir;
        }

        // Verify preparation failure releases surface reservation
        let createdSurface = "";
        const origCreateSurface = testApi.createSurface;
        (testApi as any).createSurface = (name: string) => {
          createdSurface = origCreateSurface(name);
          return createdSurface;
        };
        try {
          await assert.rejects(
            async () => {
              await testApi.launchSubagent(
                { agent: "worker", task: "prep fail", name: "prep-fail-agent" },
                {
                  sessionManager: {
                    getSessionFile: () => join(dir, "main.jsonl"),
                    getSessionId: () => "main-sess",
                    getSessionDir: () => "/nonexistent-dir/cannot-create-artifacts/artifacts",
                  },
                  cwd: dir,
                },
              );
            },
            /cannot-create-artifacts|ENOENT|prep fail/i,
          );
          assert.ok(createdSurface, "surface must have been created");
          assert.equal(getSurfaceHandle(createdSurface), undefined, "surface handle must be unregistered on preparation failure");
          assert.equal(
            Array.from(testApi.runningSubagents.values()).some((r: any) => r.name === "prep-fail-agent"),
            false,
            "failed preparation must not register running subagent",
          );
        } finally {
          (testApi as any).createSurface = origCreateSurface;
        }
        } finally {
          for (const [_id, agent] of testApi.runningSubagents) {
            agent.abortController?.abort();
          }
          testApi.runningSubagents.clear();
          const prevInterval = (globalThis as any)[Symbol.for("pi-subagents/widget-interval")];
          if (prevInterval) {
            clearInterval(prevInterval);
            (globalThis as any)[Symbol.for("pi-subagents/widget-interval")] = null;
          }
          const prevStatusInterval = (globalThis as any)[Symbol.for("pi-subagents/status-interval")];
          if (prevStatusInterval) {
            clearInterval(prevStatusInterval);
            (globalThis as any)[Symbol.for("pi-subagents/status-interval")] = null;
          }
          __rexTest__.setRexExecutor(null);
          __rexTest__.setCommandAvailabilityOverride(undefined);
          __rexTest__.setRexContextOverride(undefined);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("Task 3.6: interactive and pending-work auto-exit policy and clean exit", async () => {
      // Verify subagent-done agent_end handler directly:
      // (a) autoExit: false keeps session open
      const savedEnv = {
        session: process.env.PI_SUBAGENT_SESSION,
        autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
        name: process.env.PI_SUBAGENT_NAME,
      };
      const dir = createTestDir();
      try {
        const sessionFile = join(dir, "interactive.jsonl");
        writeFileSync(sessionFile, "");
        const handlers = new Map<string, Array<(...args: any[]) => void>>();
        const mockApi = {
          on(evt: string, fn: any) {
            if (!handlers.has(evt)) handlers.set(evt, []);
            handlers.get(evt)!.push(fn);
          },
          registerTool() {}, registerCommand() {}, registerMessageRenderer() {}, registerShortcut() {},
          sendUserMessage() {}, sendMessage() {}, getAllTools() { return []; },
        } as any;

        process.env.PI_SUBAGENT_SESSION = sessionFile;
        delete process.env.PI_SUBAGENT_AUTO_EXIT; // interactive / auto-exit off
        process.env.PI_SUBAGENT_NAME = "interactive-agent";

        subagentDoneExtension(mockApi);
        const emit = (evt: string, ...args: any[]) => (handlers.get(evt) ?? []).forEach((h) => h(...args));

        let shutdownCalled = false;
        emit("agent_start");
        emit("agent_end", { messages: [{ role: "assistant", stopReason: "end_turn" }] }, { shutdown() { shutdownCalled = true; } });
        assert.equal(shutdownCalled, false, "interactive agent (autoExit=false) must not shutdown on completion");

        // (b) autoExit: true with unanswered ask_question suppresses exit
        process.env.PI_SUBAGENT_AUTO_EXIT = "1";
        const askTools: any[] = [];
        mockApi.registerTool = (t: any) => askTools.push(t);
        subagentDoneExtension(mockApi);
        const askTool = askTools.find((t) => t.name === "ask_question");
        assert.ok(askTool);

        emit("agent_start");
        await askTool.execute("q1", { question: "What now?" }, undefined, undefined, { shutdown() {} });
        let qShutdown = false;
        emit("agent_end", { messages: [{ role: "assistant", stopReason: "end_turn" }] }, { shutdown() { qShutdown = true; } });
        assert.equal(qShutdown, false, "unanswered ask_question must suppress auto-exit");

        // (c) autoExit: true with user abort (stopReason: 'aborted') suppresses exit
        let abortShutdown = false;
        emit("input"); // answers question
        emit("agent_start");
        emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }, { shutdown() { abortShutdown = true; } });
        assert.equal(abortShutdown, false, "user abort must suppress auto-exit");

        // (d) autoExit: true with pending children suppresses exit
        let childShutdown = false;
        const countKey = Symbol.for("pi-subagents/running-children-count");
        const prevCountGetter = (globalThis as any)[countKey];
        (globalThis as any)[countKey] = () => 2;
        try {
          emit("agent_start");
          emit("agent_end", { messages: [{ role: "assistant", stopReason: "end_turn" }] }, { shutdown() { childShutdown = true; } });
          assert.equal(childShutdown, false, "running children > 0 must suppress auto-exit");
        } finally {
          (globalThis as any)[countKey] = prevCountGetter;
        }

        // (e) autoExit: true with unresolved lost-observation child suppresses exit
        let lostObservationShutdown = false;
        const testApi = (subagentsModule as any).__test__;
        const savedLost = new Set(testApi.lostObservationSessions);
        try {
          testApi.lostObservationSessions.add(join(dir, "lost-child.jsonl"));
          // Re-trigger running-children-count published by index.ts
          emit("agent_start");
          emit("agent_end", { messages: [{ role: "assistant", stopReason: "end_turn" }] }, { shutdown() { lostObservationShutdown = true; } });
          assert.equal(lostObservationShutdown, false, "lost-observation child must suppress auto-exit");
        } finally {
          testApi.lostObservationSessions.clear();
          for (const s of savedLost) testApi.lostObservationSessions.add(s);
        }

        // Restore env
      } finally {
        restoreEnvVar("PI_SUBAGENT_SESSION", savedEnv.session);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", savedEnv.autoExit);
        restoreEnvVar("PI_SUBAGENT_NAME", savedEnv.name);
        rmSync(dir, { recursive: true, force: true });
      }

      // 4. User abort (stopReason: "aborted") does not auto exit
      assert.equal(
        shouldAutoExitOnAgentEnd(false, [{ role: "assistant", stopReason: "aborted" }]),
        false,
        "abort must keep session open",
      );

      // 5. Normal completion (stopReason: "end_turn") auto exits
      assert.equal(
        shouldAutoExitOnAgentEnd(false, [{ role: "assistant", stopReason: "end_turn" }]),
        true,
        "clean completion must auto-exit",
      );

      // 6. Presentation distinguishing clean completion vs externally interrupted pane closure
      const testApi = (subagentsModule as any).__test__;
      const cleanPres = testApi.resolveResultPresentation(
        {
          exitCode: 0,
          elapsed: 10,
          summary: "Done nicely",
          outcome: "success",
        },
        "clean-worker",
      );
      assert.match(cleanPres, /Sub-agent "clean-worker" completed/);
      assert.match(cleanPres, /Done nicely/);

      const interruptedPres = testApi.resolveResultPresentation(
        {
          exitCode: 1,
          elapsed: 15,
          summary: "Pane closed",
          outcome: "interrupted",
          errorMessage: "Subagent Rex pane was closed externally before completion.",
        },
        "interrupted-worker",
      );
      assert.match(interruptedPres, /Sub-agent "interrupted-worker" was interrupted/);
      assert.match(interruptedPres, /pane closed externally/);
      assert.match(interruptedPres, /The session data was preserved/);

      // (b) Cancellation presentation distinguishes abort from external pane closure
      const cancelledPres = testApi.resolveResultPresentation(
        {
          exitCode: 1,
          elapsed: 5,
          summary: "Subagent cancelled.",
          outcome: "interrupted",
          error: "cancelled",
        },
        "cancelled-worker",
      );
      assert.match(cancelledPres, /Sub-agent "cancelled-worker" was cancelled/);
      assert.doesNotMatch(cancelledPres, /pane closed externally/);
      assert.match(cancelledPres, /The session data was preserved/);

      // (c) Interrupted run mentioning "cancelled" in summary/error is NOT mislabeled as user cancellation
      const textMentionPres = testApi.resolveResultPresentation(
        {
          exitCode: 1,
          elapsed: 12,
          summary: "Agent checked if task was cancelled before pane was closed",
          outcome: "interrupted",
          errorMessage: "Subagent pane closed while checking if order was cancelled",
        },
        "mention-worker",
      );
      assert.match(textMentionPres, /Sub-agent "mention-worker" was interrupted/);
      assert.doesNotMatch(textMentionPres, /was cancelled after/);
    });
  });
});

describe("resumed infrastructure failure delivery", () => {
  for (const withNewOutput of [false, true]) {
    it(`preserves the observation diagnostic ${withNewOutput ? "over partial output" : "without new output"}`, async (t) => {
      const { __rexTest__, unregisterSurfaceHandle } = await import("../pi-extension/subagents/rex.ts");
      const testApi = subagentsModule.__test__;
      const dir = createTestDir();
      const sessionFile = join(dir, "resumed.jsonl");
      const mock = createMockExtensionApi();
      const handlers = new Map<string, (...args: any[]) => void>();
      mock.api.on = (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler);
      subagentsModule.default(mock.api);
      const ctx = {
        hasUI: false,
        sessionManager: {
          getSessionDir: () => dir,
          getSessionId: () => "main-sess",
          getSessionFile: () => join(dir, "main.jsonl"),
        },
      };
      handlers.get("session_start")!({}, ctx);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      let surface: string | undefined;
      let queries = 0;
      let closes = 0;

      try {
        writeFileSync(sessionFile, JSON.stringify(SESSION_HEADER) + "\n");
        writeSubagentLoadout(sessionFile, {
          agent: "worker", toolAllowlist: "read", model: null, thinking: null,
          systemPromptMode: null, identity: null, spawnable: null,
          autoExit: true, cwd: dir, agentDir: null,
        });
        registerName(join(dir, "artifacts", "main-sess"), "resumed-worker", {
          sessionFile,
          sessionId: "sess-resumed",
        });
        __rexTest__.setCommandAvailabilityOverride(true);
        __rexTest__.setRexContextOverride({
          server: "unix:///tmp/mock.sock", session: "session:mock", block: "block:anchor",
        });
        __rexTest__.setRexExecutor((args) => {
          if (args[0] === "window" && args[1] === "new") {
            return JSON.stringify({ window_id: "win:resume-infra", block_ids: ["blk:resume-infra"] });
          }
          if (args[0] === "split") return JSON.stringify({ block_ids: ["blk:resume-infra"] });
          if (args[0] === "block" && args[1] === "inspect") {
            return JSON.stringify({ block: { block_id: "blk:resume-infra" } });
          }
          if (args[0] === "block" && args[1] === "call" && args.at(-1) === "process") {
            queries++;
            if (withNewOutput && queries === 1) {
              writeFileSync(sessionFile, JSON.stringify({
                type: "message", message: { role: "assistant", content: [{ type: "text", text: "Partial resumed output" }] },
              }) + "\n", { flag: "a" });
            }
            throw new Error("connection refused during resumed observation");
          }
          if (args[1] === "close") closes++;
          return "{}";
        });

        const messageTool = mock.registeredTools.find((tool) => tool.name === "subagent_message");
        const result = await messageTool.execute(
          "resume-infra", { name: "resumed-worker", message: "continue" }, undefined, undefined, ctx,
        );
        assert.equal(result.details.status, "started");
        surface = testApi.runningSubagents.get(result.details.id)!.surface;
        for (let i = 0; i < 9; i++) {
          t.mock.timers.tick(1000);
          await Promise.resolve();
        }
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.equal(queries, 10, "the resumed watcher must reach sustained infrastructure failure");
        const delivery = mock.sentMessages.find(({ message }) => message.customType === "subagent_result");
        assert.ok(delivery, "the resumed result must be delivered to the parent");
        assert.match(delivery.message.content, /Infrastructure observation failure:.*connection refused during resumed observation/);
        assert.match(delivery.message.content, /Pane was kept open/);
        assert.match(delivery.message.content, /Resume is blocked until the previous process is confirmed finished/);
        assert.doesNotMatch(delivery.message.content, /Resumed session exited with code|Partial resumed output/);
        assert.equal(closes, 0, "observation failure must leave the process pane open");
        assert.equal(testApi.lostObservationSessions.has(sessionFile), true);
      } finally {
        handlers.get("session_shutdown")!({}, ctx);
        testApi.lostObservationSessions.delete(sessionFile);
        testApi.lostObservationEntries.delete(sessionFile);
        if (surface) unregisterSurfaceHandle(surface);
        __rexTest__.setRexExecutor(null);
        __rexTest__.setCommandAvailabilityOverride(undefined);
        __rexTest__.setRexContextOverride(undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("subagent watcher disposal", () => {
  for (const reason of ["session_shutdown", "reload", "cancellation"] as const) {
    it(`${reason} ${reason === "cancellation" ? "closes" : "preserves"} a live watched child's pane`, async (t) => {
      const { registerSurfaceHandle, unregisterSurfaceHandle, getSurfaceHandle } = await import("../pi-extension/subagents/rex.ts");
      const testApi = subagentsModule.__test__;
      const { hasLostObservationMarker, readLostObservationMarker } = await import("../pi-extension/subagents/session.ts");
      const { api, registeredTools } = createMockExtensionApi();
      const handlers = new Map<string, (...args: any[]) => void>();
      api.on = (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler);
      subagentsModule.default(api);
      const dir = createTestDir();
      const ctx = {
        hasUI: false,
        sessionManager: {
          getSessionDir: () => dir,
          getSessionId: () => "main-sess",
        },
      };
      handlers.get("session_start")!({}, ctx);
      const controller = new AbortController();
      const id = `live-watcher-${reason}`;
      const running = {
        id, name: id, task: "keep running", surface: id,
        startTime: Date.now(), sessionFile: join(dir, "child.jsonl"),
        interactive: false,
        statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }),
        abortController: controller,
      };
      writeFileSync(running.sessionFile, JSON.stringify(SESSION_HEADER) + "\n");
      registerName(join(dir, "artifacts", "main-sess"), id, {
        sessionFile: running.sessionFile, sessionId: "sess-child",
      });
      const calls: string[][] = [];
      let processExited = false;
      t.mock.timers.enable({ apis: ["setTimeout"] });
      __rexTest__.setCommandAvailabilityOverride(true);
      // The child's coordinates must come from its handle, not the current parent.
      __rexTest__.setRexContextOverride({ session: "session:parent", block: "block:parent" });
      __rexTest__.setRexExecutor((args) => {
        calls.push(args);
        if (args.at(-1) === "process") {
          assert.ok(args.includes("block:live-child"));
          assert.ok(args.includes("session:test"));
          return JSON.stringify({ last_exit: processExited ? { exit_code: 0 } : null });
        }
        return "{}";
      });
      registerSurfaceHandle({
        id, name: id, kind: "split", status: "launched",
        sessionId: "session:test", blockId: "block:live-child",
      });
      testApi.runningSubagents.set(id, running);
      const watcher = testApi.watchSubagent(running, controller.signal);

      try {
        assert.equal(calls.filter((args) => args.at(-1) === "process").length, 1,
          "the watcher must observe a live child before disposal");
        if (reason === "session_shutdown") {
          handlers.get("session_shutdown")!({}, {});
          assert.equal(controller.signal.aborted, true, "shutdown also aborts the per-agent controller");
          assert.equal(hasLostObservationMarker(running.sessionFile), true,
            "shutdown must persist the guard before watcher continuations run");
        } else if (reason === "reload") {
          // Match module reload: abort the previous runtime, then replace the
          // global controller before the old watcher's catch branch executes.
          const key = Symbol.for("pi-subagents/poll-abort-controller");
          (globalThis as any)[key].abort();
          (globalThis as any)[key] = new AbortController();
        } else {
          controller.abort();
        }
        const watcherResult = await watcher;
        const presentation = testApi.resolveResultPresentation(watcherResult, id);
        assert.equal(watcherResult.outcome, "interrupted");
        if (reason === "cancellation") {
          assert.equal(watcherResult.error, "cancelled");
          assert.notEqual(watcherResult.observationFailure, true);
          assert.match(presentation, /You can resume the session with subagent_message/);
        } else {
          assert.equal(watcherResult.error, "observation_lost");
          assert.equal(watcherResult.observationFailure, true);
          assert.equal(watcherResult.summary,
            "Observation disposed during session shutdown or reload. The pane was kept open and resume is blocked until process exit is confirmed.");
          assert.ok(presentation.includes(watcherResult.summary));
          assert.match(presentation, /Resume is blocked until the previous process is confirmed finished/);
          assert.doesNotMatch(presentation, /was cancelled|You can resume|Follow up with subagent_message/);
        }
        assert.equal(testApi.runningSubagents.has(id), false, "disposed watchers must stop tracking");
        const closes = calls.filter((args) => args[1] === "close");
        assert.equal(closes.length, reason === "cancellation" ? 1 : 0,
          "only explicit cancellation may request pane closure");
        assert.equal(!!getSurfaceHandle(id), reason !== "cancellation",
          "shutdown/reload must retain the live pane's handle");
        assert.equal(testApi.pendingCleanups.has(id), false, "disposal must not enqueue a close retry");
        const callsAfterDisposal = calls.length;
        t.mock.timers.tick(5000);
        await Promise.resolve();
        assert.equal(calls.length, callsAfterDisposal, "disposal must stop background polling");

        if (reason === "cancellation") {
          assert.equal(hasLostObservationMarker(running.sessionFile), false);
          assert.equal(testApi.lostObservationSessions.has(resolve(running.sessionFile)), false);
        } else {
          const marker = readLostObservationMarker(running.sessionFile);
          assert.equal(marker?.blockId, "block:live-child");
          assert.equal(marker?.sessionId, "session:test");
          assert.equal(marker?.surface, id);
          assert.equal(testApi.lostObservationSessions.has(resolve(running.sessionFile)), true);

          handlers.get("session_start")!({}, ctx);
          const messageTool = registeredTools.find((tool) => tool.name === "subagent_message");
          for (const guard of ["in-memory", "disk-only"]) {
            if (guard === "disk-only") {
              // A replacement runtime has no running map or lost-observation memory.
              testApi.lostObservationSessions.clear();
              testApi.lostObservationEntries.clear();
            }
            const result = await messageTool.execute(
              `resume-${guard}`, { name: id, message: "continue" }, undefined, undefined, ctx,
            );
            assert.match(result.details.error, /Cannot resume.*process may still be active/,
              `${guard} guard must refuse unsafe name-based resume`);
            assert.equal(hasLostObservationMarker(running.sessionFile), true);
            assert.ok(getSurfaceHandle(id), "a refused resume must preserve the live child");
            assert.equal(calls.some((args) => args[0] === "split" || args[1] === "new"), false,
              "refused resume must not create another process surface");
            assert.equal(testApi.runningSubagents.size, 0);
          }

          processExited = true;
          testApi.reconcileLostObservations(running.sessionFile);
          assert.equal(hasLostObservationMarker(running.sessionFile), false,
            "confirmed process exit must clear the persisted guard");
          assert.equal(testApi.lostObservationSessions.has(resolve(running.sessionFile)), false);
          assert.equal(testApi.lostObservationEntries.has(resolve(running.sessionFile)), false);
          assert.equal(getSurfaceHandle(id), undefined, "only confirmed exit may close the retained pane");
        }
      } finally {
        handlers.get("session_shutdown")!({}, {});
        controller.abort();
        await watcher;
        testApi.lostObservationSessions.delete(resolve(running.sessionFile));
        testApi.lostObservationEntries.delete(resolve(running.sessionFile));
        unregisterSurfaceHandle(id);
        __rexTest__.setRexExecutor(null);
        __rexTest__.setCommandAvailabilityOverride(undefined);
        __rexTest__.setRexContextOverride(undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("subagent watcher exit during shutdown", () => {
  for (const { label, exitCode, errorMessage } of [
    { label: "completed", exitCode: 0, errorMessage: undefined },
    { label: "nonzero exit", exitCode: 42, errorMessage: undefined },
    { label: "provider error", exitCode: 1, errorMessage: "Anthropic 529 Overloaded after 3 retries" },
  ]) {
    it(`preserves a ${label} result when confirmProcessEnded cannot remove its marker`, async (t) => {
      const { registerSurfaceHandle, unregisterSurfaceHandle, getSurfaceHandle } = await import("../pi-extension/subagents/rex.ts");
      const { lostObservationMarkerPath, hasLostObservationMarker } = await import("../pi-extension/subagents/session.ts");
      const testApi = subagentsModule.__test__;
      const { api } = createMockExtensionApi();
      const handlers = new Map<string, (...args: any[]) => void>();
      api.on = (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler);
      subagentsModule.default(api);
      handlers.get("session_start")!({}, { hasUI: false });
      const dir = createTestDir();
      const id = "completed-marker-removal-failed";
      const now = Date.now();
      t.mock.method(Date, "now", () => now);
      const warning = t.mock.method(console, "warn", () => {});
      const sessionFile = createSessionFile(dir, [SESSION_HEADER, {
        ...ASSISTANT_MSG,
        message: { ...ASSISTANT_MSG.message, model: "test-model", usage: { input: 100, output: 50 } },
      }]);
      const expectedStats = summarizeSessionStats(sessionFile);
      const running = {
        id, name: id, task: "finished", surface: id, startTime: now - 12_000,
        sessionFile, interactive: false,
        statusState: createStatusState({ source: "pi", startTimeMs: now - 12_000 }),
      };
      registerSurfaceHandle({
        id, name: id, kind: "split", status: "launched",
        sessionId: "session:test", blockId: "block:completed-child",
      });
      // A directory at the marker path reliably makes non-recursive removal
      // throw, including when tests run with elevated filesystem privileges.
      mkdirSync(lostObservationMarkerPath(sessionFile));
      testApi.lostObservationSessions.add(resolve(sessionFile));
      testApi.lostObservationEntries.set(resolve(sessionFile), {
        sessionFile, surface: id, blockId: "block:completed-child", sessionId: "session:test",
      });
      testApi.runningSubagents.set(id, running);
      __rexTest__.setRexExecutor(() => JSON.stringify({ last_exit: { exit_code: exitCode, error: errorMessage } }));

      try {
        const result = await testApi.watchSubagent(running, new AbortController().signal);
        assert.equal(result.outcome, exitCode === 0 ? "success" : "failure");
        assert.equal(result.summary, "Here is my plan...");
        assert.equal(result.exitCode, exitCode);
        assert.equal(result.errorMessage, errorMessage);
        assert.notEqual(result.observationFailure, true);
        assert.equal(result.elapsed, 12);
        assert.equal(result.sessionId, SESSION_HEADER.id);
        assert.deepEqual(result.stats, expectedStats);
        assert.equal(result.error, undefined);
        assert.equal(warning.mock.callCount(), 1);
        assert.match(String(warning.mock.calls[0].arguments[0]), /Failed to clear lost-observation marker/);
        assert.equal(testApi.runningSubagents.has(id), false);
        assert.equal(testApi.lostObservationSessions.has(resolve(sessionFile)), true);
        assert.equal(testApi.lostObservationEntries.has(resolve(sessionFile)), true);
        assert.equal(hasLostObservationMarker(sessionFile), true, "failed removal must retain the persistent resume guard");
        assert.equal(getSurfaceHandle(id), undefined, "a real process exit must close its pane despite marker cleanup failure");
        const presentation = testApi.resolveResultPresentation(result, id);
        if (exitCode === 0) {
          assert.match(presentation, /completed/);
        } else {
          if (errorMessage) {
            assert.match(presentation, /failed after 12s[\s\S]*provider\/agent error/);
            assert.ok(presentation.includes(`Error: ${errorMessage}`));
          } else {
            assert.match(presentation, /failed \(exit code 42\)/);
            assert.match(presentation, /Here is my plan/);
          }
        }
        assert.match(presentation, /Resume is blocked until the previous process is confirmed finished/);
        assert.doesNotMatch(presentation, /resume the session with subagent_message|Follow up with subagent_message/);
        assert.doesNotMatch(presentation, /infrastructure observation failure|pane was kept open/i);
      } finally {
        handlers.get("session_shutdown")!({}, {});
        testApi.runningSubagents.delete(id);
        testApi.lostObservationSessions.delete(resolve(sessionFile));
        testApi.lostObservationEntries.delete(resolve(sessionFile));
        unregisterSurfaceHandle(id);
        __rexTest__.setRexExecutor(null);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  for (const exitObserved of [true, false]) {
    it(`clears a shutdown guard when exit is confirmed by ${exitObserved ? "polling" : "reconciliation"}`, async () => {
      const { registerSurfaceHandle, unregisterSurfaceHandle } = await import("../pi-extension/subagents/rex.ts");
      const { hasLostObservationMarker } = await import("../pi-extension/subagents/session.ts");
      const testApi = subagentsModule.__test__;
      const { api } = createMockExtensionApi();
      const handlers = new Map<string, (...args: any[]) => void>();
      api.on = (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler);
      subagentsModule.default(api);
      handlers.get("session_start")!({}, { hasUI: false });
      const dir = createTestDir();
      const id = "exited-during-shutdown";
      const running = {
        id, name: id, task: "finished", surface: id,
        startTime: Date.now(), sessionFile: join(dir, "child.jsonl"),
        interactive: false,
        statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }),
      };
      registerSurfaceHandle({
        id, name: id, kind: "split", status: "launched",
        sessionId: "session:test", blockId: "block:exited-child",
      });
      __rexTest__.setRexExecutor(() => JSON.stringify({ last_exit: exitObserved ? { exit_code: 0 } : null }));
      testApi.runningSubagents.set(id, running);
      const watcher = testApi.watchSubagent(running, new AbortController().signal);

      try {
        // The watcher has not resumed from its await, whether polling resolved
        // or is about to reject because of shutdown.
        handlers.get("session_shutdown")!({}, {});
        assert.equal(hasLostObservationMarker(running.sessionFile), true);
        if (!exitObserved) {
          __rexTest__.setRexExecutor(() => JSON.stringify({ last_exit: { exit_code: 0 } }));
          testApi.reconcileLostObservations(running.sessionFile);
        }
        const result = await watcher;
        assert.equal(result.outcome, exitObserved ? "success" : "interrupted");
        assert.equal(hasLostObservationMarker(running.sessionFile), false);
        assert.equal(testApi.lostObservationSessions.has(resolve(running.sessionFile)), false);
        assert.equal(testApi.lostObservationEntries.has(resolve(running.sessionFile)), false);
      } finally {
        handlers.get("session_shutdown")!({}, {});
        await watcher;
        testApi.runningSubagents.delete(id);
        testApi.lostObservationSessions.delete(resolve(running.sessionFile));
        testApi.lostObservationEntries.delete(resolve(running.sessionFile));
        unregisterSurfaceHandle(id);
        __rexTest__.setRexExecutor(null);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("lost-observation reconciliation timers", () => {
  for (const parentState of ["parked", "active", "reactivated", "resume-guard"]) {
    it(`reconciles the last child with parent state ${parentState} without spurious wakeups`, async () => {
      const { __rexTest__ } = await import("../pi-extension/subagents/rex.ts");
      const testApi = subagentsModule.__test__;
      const mock = createMockExtensionApi();
      const handlers = new Map<string, Array<(...args: any[]) => void>>();
      mock.api.on = (event: string, handler: (...args: any[]) => void) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
      };
      const emit = (event: string, ...args: any[]) => handlers.get(event)?.forEach((fn) => fn(...args));
      const savedAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
      const savedRunning = new Map(testApi.runningSubagents);
      const savedLost = new Set(testApi.lostObservationSessions);
      const savedEntries = new Map(testApi.lostObservationEntries);
      const parkedKey = Symbol.for("pi-subagents/parent-parked-for-children");
      const savedParked = (globalThis as any)[parkedKey];
      const dir = createTestDir();
      const sessionFile = join(dir, "lost-child.jsonl");
      let shutdowns = 0;
      const ctx = { shutdown() { shutdowns++; } };
      const event = { messages: [{ role: "assistant", stopReason: "stop" }] };

      try {
        testApi.runningSubagents.clear();
        testApi.lostObservationSessions.clear();
        testApi.lostObservationEntries.clear();
        process.env.PI_SUBAGENT_AUTO_EXIT = "1";
        subagentsModule.default(mock.api);
        subagentDoneExtension(mock.api);
        testApi.lostObservationSessions.add(sessionFile);
        testApi.lostObservationEntries.set(sessionFile, {
          sessionFile,
          surface: "",
          blockId: "block:parked-child",
          sessionId: "session:mock",
        });

        emit("agent_start");
        assert.equal((globalThis as any)[parkedKey], false, "active parents must not be marked parked");
        if (parentState !== "active") {
          emit("agent_end", event, ctx);
          assert.equal((globalThis as any)[parkedKey], true, "pending children must mark the parent parked");
          if (parentState === "reactivated") emit("agent_start");
        }
        assert.equal(shutdowns, 0, "parent must not exit while process observation is unresolved");
        assert.equal(runningChildrenCount(), 1);

        __rexTest__.setRexExecutor(() => JSON.stringify({ last_exit: null }));
        testApi.reconcileLostObservations();
        assert.equal(mock.sentMessages.length, 0, "a still-running child must not release the parent");

        __rexTest__.setRexExecutor(() => JSON.stringify({ last_exit: { exit_code: 0 } }));
        testApi.reconcileLostObservations(parentState === "resume-guard" ? sessionFile : undefined);
        assert.equal(runningChildrenCount(), 0);
        assert.equal(testApi.lostObservationEntries.size, 0);
        const expectedWakeups = parentState === "parked" ? 1 : 0;
        assert.equal(mock.sentMessages.length, expectedWakeups, "only background reconciliation of a parked parent may wake it");
        if (expectedWakeups) {
          assert.deepEqual(mock.sentMessages[0].options, { triggerTurn: true, deliverAs: "steer" });
          assert.match(mock.sentMessages[0].message.content, /No child subagents remain pending/);
        }

        emit("agent_start");
        emit("agent_end", event, ctx);
        assert.equal(shutdowns, 1, "the parent must be allowed to auto-exit after reconciliation");
        testApi.reconcileLostObservations();
        assert.equal(mock.sentMessages.length, expectedWakeups, "already-reconciled children must not wake the parent again");
      } finally {
        emit("session_shutdown", {});
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", savedAutoExit);
        testApi.runningSubagents.clear();
        for (const [key, value] of savedRunning) testApi.runningSubagents.set(key, value);
        testApi.lostObservationSessions.clear();
        for (const value of savedLost) testApi.lostObservationSessions.add(value);
        testApi.lostObservationEntries.clear();
        for (const [key, value] of savedEntries) testApi.lostObservationEntries.set(key, value);
        (globalThis as any)[parkedKey] = savedParked;
        __rexTest__.setRexExecutor(null);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("retains unqueryable guards without retrying and unrefs queryable retries", async (t) => {
    const { writeLostObservationMarker, hasLostObservationMarker } = await import("../pi-extension/subagents/session.ts");
    const testApi = subagentsModule.__test__;
    const { api } = createMockExtensionApi();
    let shutdown: () => void = () => {};
    api.on = (event: string, handler: () => void) => {
      if (event === "session_shutdown") shutdown = handler;
    };
    subagentsModule.default(api);
    shutdown();
    const savedLost = new Set(testApi.lostObservationSessions);
    const savedEntries = new Map(testApi.lostObservationEntries);
    const dir = createTestDir();
    const scheduled = t.mock.method(globalThis, "setTimeout");
    let processQueries = 0;
    let processExited = false;

    try {
      testApi.lostObservationSessions.clear();
      testApi.lostObservationEntries.clear();
      __rexTest__.setRexExecutor(() => {
        processQueries++;
        return JSON.stringify({ last_exit: processExited ? { exit_code: 0 } : null });
      });
      const unqueryable = [
        { blockId: undefined, sessionId: "session:mock" },
        { blockId: "", sessionId: "session:mock" },
        { blockId: " \t ", sessionId: "session:mock" },
        { blockId: "block:mock", sessionId: "" },
        { blockId: "block:mock", sessionId: " \t " },
      ];
      const guardedSessions = unqueryable.map((coordinates, i) => {
        const sessionFile = join(dir, `unqueryable-${i}.jsonl`);
        writeLostObservationMarker(sessionFile, coordinates);
        testApi.lostObservationSessions.add(sessionFile);
        testApi.lostObservationEntries.set(sessionFile, { sessionFile, surface: "", ...coordinates });
        return sessionFile;
      });

      for (let i = 0; i < 3; i++) testApi.reconcileLostObservations();
      assert.equal(processQueries, 0, "missing coordinates must not be queried");
      assert.equal(scheduled.mock.callCount(), 0, "unqueryable entries must not schedule retry timers");

      const queryableSession = join(dir, "queryable.jsonl");
      testApi.lostObservationSessions.add(queryableSession);
      testApi.lostObservationEntries.set(queryableSession, {
        sessionFile: queryableSession, surface: "", blockId: "block:mock", sessionId: "session:mock",
      });
      testApi.reconcileLostObservations();
      assert.equal(processQueries, 1);
      assert.equal(scheduled.mock.callCount(), 1, "queryable entries still need background reconciliation");
      const retryTimer = scheduled.mock.calls[0].result;
      assert.ok(retryTimer);
      assert.equal(retryTimer.hasRef(), false, "retries must not keep Node alive");

      processExited = true;
      testApi.reconcileLostObservations();
      assert.equal(processQueries, 2);
      assert.equal(scheduled.mock.callCount(), 1, "no new timer is needed after the last queryable entry ends");
      assert.equal(testApi.lostObservationEntries.size, guardedSessions.length);
      for (const sessionFile of guardedSessions) {
        assert.equal(testApi.lostObservationSessions.has(sessionFile), true);
        assert.equal(hasLostObservationMarker(sessionFile), true, "unqueryable guards must stay on disk");
      }
    } finally {
      shutdown();
      testApi.lostObservationSessions.clear();
      for (const value of savedLost) testApi.lostObservationSessions.add(value);
      testApi.lostObservationEntries.clear();
      for (const [key, value] of savedEntries) testApi.lostObservationEntries.set(key, value);
      __rexTest__.setRexContextOverride(null);
      __rexTest__.setCommandAvailabilityOverride(null);
      __rexTest__.setRexExecutor(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const queryFails of [false, true]) {
    it(`bounds automatic retries for ${queryFails ? "failed queries" : "active processes"} without releasing the resume guard`, async (t) => {
      const { writeLostObservationMarker, hasLostObservationMarker } = await import("../pi-extension/subagents/session.ts");
      const testApi = subagentsModule.__test__;
      const { api } = createMockExtensionApi();
      let shutdown = () => {};
      api.on = (event: string, handler: () => void) => {
        if (event === "session_shutdown") shutdown = handler;
      };
      subagentsModule.default(api);
      shutdown();
      const savedLost = new Set(testApi.lostObservationSessions);
      const savedEntries = new Map(testApi.lostObservationEntries);
      const dir = createTestDir();
      const sessionFile = join(dir, "bounded-retries.jsonl");
      const coordinates = { blockId: "block:bounded-retries", sessionId: "session:mock" };
      let processQueries = 0;
      let exited = false;
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const scheduled = t.mock.method(globalThis, "setTimeout");
      __rexTest__.setRexExecutor(() => {
        processQueries++;
        if (queryFails && !exited) throw new Error("server unavailable");
        return JSON.stringify({ last_exit: exited ? { exit_code: 0 } : null });
      });

      try {
        testApi.lostObservationSessions.clear();
        testApi.lostObservationEntries.clear();
        writeLostObservationMarker(sessionFile, coordinates);
        testApi.lostObservationSessions.add(sessionFile);
        testApi.lostObservationEntries.set(sessionFile, { sessionFile, surface: "", ...coordinates });
        testApi.reconcileLostObservations();
        const limit = testApi.MAX_AUTOMATIC_RECONCILIATION_ATTEMPTS;
        for (let i = 0; i < limit + 5; i++) t.mock.timers.tick(1000);
        assert.equal(processQueries, limit, "automatic polling must stop at the per-entry limit");
        assert.equal(scheduled.mock.callCount(), limit - 1, "exhausted entries must not schedule further timers");
        assert.equal(testApi.lostObservationSessions.has(sessionFile), true);
        assert.equal(testApi.lostObservationEntries.has(sessionFile), true);
        assert.equal(hasLostObservationMarker(sessionFile), true);

        testApi.reconcileLostObservations();
        assert.equal(processQueries, limit, "unrelated background calls must not reset an exhausted budget");
        testApi.reconcileLostObservations(sessionFile);
        assert.equal(processQueries, limit + 1, "on-demand resume checks must bypass the limit");
        assert.equal(testApi.lostObservationSessions.has(sessionFile), true);
        assert.equal(hasLostObservationMarker(sessionFile), true, "inconclusive resume checks must retain both guards");
        assert.equal(scheduled.mock.callCount(), limit - 1, "on-demand checks must not restart exhausted polling");

        exited = true;
        testApi.reconcileLostObservations(sessionFile);
        assert.equal(processQueries, limit + 2);
        assert.equal(testApi.lostObservationSessions.has(sessionFile), false);
        assert.equal(testApi.lostObservationEntries.has(sessionFile), false);
        assert.equal(hasLostObservationMarker(sessionFile), false, "confirmed exit must still clear both guards on demand");
      } finally {
        shutdown();
        testApi.lostObservationSessions.clear();
        for (const value of savedLost) testApi.lostObservationSessions.add(value);
        testApi.lostObservationEntries.clear();
        for (const [key, value] of savedEntries) testApi.lostObservationEntries.set(key, value);
        __rexTest__.setRexExecutor(null);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("unrefs both initial and subsequent cleanup retry timers", async (t) => {
    const { registerSurfaceHandle, unregisterSurfaceHandle } = await import("../pi-extension/subagents/rex.ts");
    const testApi = subagentsModule.__test__;
    const { api } = createMockExtensionApi();
    let shutdown = () => {};
    api.on = (event: string, handler: () => void) => {
      if (event === "session_shutdown") shutdown = handler;
    };
    subagentsModule.default(api);
    shutdown();
    const scheduled = t.mock.method(globalThis, "setTimeout");
    t.mock.method(console, "error", () => {});
    const id = "unref-cleanup-retry";
    registerSurfaceHandle({ id, name: id, kind: "split", status: "launched", sessionId: "session:mock", blockId: "block:retry" });
    __rexTest__.setRexExecutor((args) => {
      if (args[1] === "close") throw new Error("server unavailable");
      return "{}";
    });
    const retryTimers = () => scheduled.mock.calls.filter((call) => call.arguments[1] === 1000).map((call) => call.result);
    try {
      testApi.safeCloseSurface(id);
      assert.equal(retryTimers().length, 1);
      assert.equal(retryTimers()[0]!.hasRef(), false, "initial cleanup retry must be unref'ed");
      clearTimeout(retryTimers()[0]);
      testApi.processPendingCleanups();
      assert.equal(retryTimers().length, 2);
      assert.equal(retryTimers()[1]!.hasRef(), false, "subsequent cleanup retries must be unref'ed");
    } finally {
      shutdown();
      unregisterSurfaceHandle(id);
      __rexTest__.setRexExecutor(null);
    }
  });

  it("keeps one retry chain across direct calls and cancels it on shutdown", async (t) => {
    const { __rexTest__ } = await import("../pi-extension/subagents/rex.ts");
    const testApi = subagentsModule.__test__;
    const { api } = createMockExtensionApi();
    let shutdown: () => void = () => {};
    api.on = (event: string, handler: () => void) => {
      if (event === "session_shutdown") shutdown = handler;
    };
    subagentsModule.default(api);
    shutdown();
    t.mock.timers.enable({ apis: ["setTimeout"] });

    let processQueries = 0;
    __rexTest__.setRexExecutor(() => {
      processQueries++;
      return JSON.stringify({ last_exit: null });
    });
    const sessionFile = join(tmpdir(), "reconcile-timer-session.jsonl");
    testApi.lostObservationEntries.set(sessionFile, {
      sessionFile,
      surface: "",
      blockId: "block:reconcile-timer",
      sessionId: "session:mock",
    });

    try {
      for (let i = 0; i < 3; i++) testApi.reconcileLostObservations();
      assert.equal(processQueries, 3);
      t.mock.timers.tick(1000);
      assert.equal(processQueries, 4, "direct calls must leave only one retry timeout");
      t.mock.timers.tick(1000);
      assert.equal(processQueries, 5, "retries must continue as a single timer chain");

      for (let i = 0; i < 3; i++) testApi.reconcileLostObservations();
      assert.equal(processQueries, 8);
      shutdown();
      t.mock.timers.tick(5000);
      assert.equal(processQueries, 8, "shutdown must cancel every pending reconciliation timeout");
      assert.equal(testApi.lostObservationEntries.size, 1, "unresolved observations must remain tracked");
    } finally {
      shutdown();
      testApi.lostObservationEntries.clear();
      __rexTest__.setRexExecutor(null);
    }
  });
});

describe("Rex sizing lifecycle and bounded diagnostics", () => {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 140));
  const leaf = (block_id: string) => ({ block_id, rect: [0, 0, 1, 1] });
  const layout = { rect: [0, 0, 1, 1], split: {
    split_id: "split:fixture", direction: "horizontal", ratio: 0.8,
    before: leaf("block:a"), after: leaf("block:b"),
  } };
  const view = { active_window_id: "window:unrelated", windows: [
    { window_id: "window:target", layers: [
      { kind: "tiled", layout },
      { kind: "floating", layout: { ...layout, split: { ...layout.split, before: leaf("block:float-a"), after: leaf("block:float-b") } } },
    ] },
    { window_id: "window:unrelated", layers: [{ kind: "tiled", layout: { ...layout,
      split: { ...layout.split, before: leaf("block:other-a"), after: leaf("block:other-b") } } }] },
  ] };

  afterEach(() => {
    disposeRexSurfaces();
    __rexTest__.setRexExecutor(null);
    __rexTest__.setRexContextOverride(undefined);
    __rexTest__.setCommandAvailabilityOverride(undefined);
  });

  it("debounces by session/window and targets only tiled borders in the remembered tab", async () => {
    const { scheduleTabSizing } = await import("../pi-extension/subagents/rex.ts");
    const calls: string[][] = [];
    const servers: unknown[] = [];
    __rexTest__.setRexContextOverride({ server: "server:original" });
    __rexTest__.setRexExecutor((args, options) => {
      calls.push(args);
      servers.push(options?.server);
      return JSON.stringify(args[0] === "session" ? view : { revision: 1 });
    });
    for (let i = 0; i < 5; i++) scheduleTabSizing("session:test", "window:target");
    assert.equal(__rexTest__.sizingPassCount(), 1);
    __rexTest__.setRexContextOverride({ server: "server:later", session: "session:later" });
    await pause();
    assert.equal(calls.length, 2, "one fresh inspection and one border change");
    assert.deepEqual(calls[0], ["session", "inspect", "session:test", "--json"]);
    assert.deepEqual(JSON.parse(calls[1][3]), {
      session_id: "session:test", direction: "horizontal", before_block_id: "block:a", after_block_id: "block:b", ratio: 0.5,
    });
    assert.deepEqual(servers, ["server:original", "server:original"]);
    assert.equal(__rexTest__.sizingPassCount(), 0);
  });

  for (const lookupFails of [false, true]) {
    it(`bounds split-launch tab lookup and ${lookupFails ? "preserves the launch on timeout" : "schedules sizing on success"}`, async () => {
      const { registerSurfaceHandle, unregisterSurfaceHandle, getSurfaceHandle, sendLongCommand } = await import("../pi-extension/subagents/rex.ts");
      const id = `launch-lookup-${lookupFails}`;
      const dir = mkdtempSync(join(tmpdir(), "rex-launch-lookup-"));
      const scriptPath = join(dir, "launch.sh");
      const calls: string[][] = [];
      const lookupTimeouts: (number | undefined)[] = [];
      __rexTest__.setRexContextOverride({ session: "session:test", block: "block:anchor" });
      __rexTest__.setCommandAvailabilityOverride(true);
      __rexTest__.setRexExecutor((args, options) => {
        calls.push(args);
        if (args[0] === "split") return JSON.stringify({ block_ids: ["block:launched"] });
        if (args[0] === "block" && args[1] === "inspect") {
          lookupTimeouts.push(options?.timeoutMs);
          if (lookupFails) throw new Error("lookup timed out");
          return JSON.stringify({ block: { window_id: "window:target" } });
        }
        return "{}";
      });
      registerSurfaceHandle({ id, kind: "split", name: id, sessionId: "session:test", anchorBlockId: "block:anchor", status: "reserved" });
      try {
        assert.equal(sendLongCommand(id, "echo launched", { scriptPath }), scriptPath);
        assert.deepEqual(lookupTimeouts, [3000], "split-launch tab lookup must not use the 15-second default");
        assert.deepEqual(calls.map((args) => args.slice(0, 2)), [["split", "-s"], ["block", "inspect"]]);
        assert.equal(getSurfaceHandle(id)?.status, "launched");
        assert.equal(getSurfaceHandle(id)?.blockId, "block:launched");
        assert.equal(getSurfaceHandle(id)?.windowId, lookupFails ? undefined : "window:target");
        assert.equal(__rexTest__.sizingPassCount(), lookupFails ? 0 : 1);
      } finally {
        unregisterSurfaceHandle(id);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("remembers a split's tab before closing and rebalances survivors", async () => {
    const { registerSurfaceHandle, closeSurface } = await import("../pi-extension/subagents/rex.ts");
    const calls: string[][] = [];
    let closed = false;
    __rexTest__.setRexExecutor((args) => {
      calls.push(args);
      if (args[0] === "block" && args[1] === "inspect") {
        assert.equal(closed, false, "window lookup must precede removal");
        return JSON.stringify({ block: { window_id: "window:target" } });
      }
      if (args[0] === "block" && args[1] === "close") closed = true;
      return JSON.stringify(args[0] === "session" ? view : {});
    });
    registerSurfaceHandle({ id: "close-sizing", kind: "split", name: "close-sizing", sessionId: "session:test", windowId: "window:old-before-move", blockId: "block:removed", status: "launched" });
    closeSurface("close-sizing");
    await pause();
    assert.equal(closed, true);
    assert.equal(calls.filter((c) => c[0] === "api").length, 1);
    assert.equal(JSON.parse(calls.at(-1)![3]).before_block_id, "block:a");
  });

  for (const refreshFails of [false, true]) {
    it(`bounds pre-close tab lookup and reuses its ${refreshFails ? "failed" : "successful"} result during retries`, async () => {
      const { registerSurfaceHandle, unregisterSurfaceHandle, closeSurface, getSurfaceHandle } = await import("../pi-extension/subagents/rex.ts");
      const id = `close-lookup-${refreshFails}`;
      let lookups = 0;
      let closes = 0;
      __rexTest__.setRexExecutor((args, options) => {
        if (args[0] === "block" && args[1] === "inspect") {
          lookups++;
          assert.equal(options?.timeoutMs, 3000, "pre-close tab refresh must not use the 15-second default");
          if (refreshFails) throw new Error("lookup timed out");
          return JSON.stringify({ block: { window_id: "window:target" } });
        }
        if (args[0] === "block" && args[1] === "close") {
          closes++;
          if (closes < 3) throw new Error("transient close failure");
        }
        return "{}";
      });
      registerSurfaceHandle({ id, kind: "split", name: id, sessionId: "session:test", windowId: "window:old-before-move", blockId: "block:removed", status: "launched" });
      try {
        for (let i = 0; i < 2; i++) {
          assert.throws(() => closeSurface(id), /transient close failure/);
          assert.ok(getSurfaceHandle(id));
          assert.equal(lookups, 1, "cleanup retries must not repeat the tab lookup");
        }
        closeSurface(id);
        assert.equal(lookups, 1);
        assert.equal(closes, 3);
        assert.equal(getSurfaceHandle(id), undefined);
      } finally {
        unregisterSurfaceHandle(id);
      }
    });
  }

  it("balances a confirmed externally removed pane's remembered tab, but skips unknown transport failures", async () => {
    const { registerSurfaceHandle, closeSurface } = await import("../pi-extension/subagents/rex.ts");
    for (const missing of [true, false]) {
      let resizes = 0;
      __rexTest__.setRexExecutor((args) => {
        if (args[0] === "block" && args[1] === "inspect") {
          throw new Error(missing ? "block target block:removed not found" : "connection lost");
        }
        if (args[0] === "session") return JSON.stringify(view);
        if (args[0] === "api") resizes++;
        return "{}";
      });
      registerSurfaceHandle({ id: "already-removed", kind: "split", name: "already-removed", sessionId: "session:test", windowId: "window:target", blockId: "block:removed", status: "launched" });
      closeSurface("already-removed");
      await pause();
      assert.equal(resizes, missing ? 1 : 0);
    }
  });

  it("abandons missing/stale layouts and failed resizes without unhandled work", async () => {
    const { scheduleTabSizing } = await import("../pi-extension/subagents/rex.ts");
    for (const mode of ["missing", "inspect-failed", "resize-failed"]) {
      let resizes = 0;
      __rexTest__.setRexExecutor((args) => {
        if (args[0] === "session") {
          if (mode === "inspect-failed") throw new Error("disconnected");
          return JSON.stringify(mode === "missing" ? { windows: [] } : view);
        }
        resizes++;
        throw new Error("bad_request: split changed since inspection");
      });
      scheduleTabSizing("session:test", "window:target");
      await pause();
      assert.equal(resizes, mode === "resize-failed" ? 1 : 0);
      assert.equal(__rexTest__.sizingPassCount(), 0);
    }
  });

  it("shutdown cancels sizing and unlaunched reservations, permits a new session, and is idempotent", async () => {
    const { scheduleTabSizing, registerSurfaceHandle, getSurfaceHandle } = await import("../pi-extension/subagents/rex.ts");
    const handlers = new Map<string, Function>();
    const { api } = createMockExtensionApi();
    api.on = (event: string, handler: Function) => { handlers.set(event, handler); };
    (subagentsModule as any).default(api);
    let requests = 0;
    __rexTest__.setRexExecutor(() => { requests++; return JSON.stringify(view); });
    registerSurfaceHandle({ id: "shutdown-reservation", kind: "tab", name: "unused", sessionId: "session:test", status: "reserved" });
    scheduleTabSizing("session:test", "window:target");
    handlers.get("session_shutdown")!({}, {});
    handlers.get("session_shutdown")!({}, {});
    assert.equal(getSurfaceHandle("shutdown-reservation"), undefined);
    assert.equal(__rexTest__.sizingPassCount(), 0);
    await pause();
    assert.equal(requests, 0);
    scheduleTabSizing("session:test", "window:missing");
    await pause();
    assert.equal(requests, 1, "a subsequent session can schedule work");
  });

  it("reload disposal aborts an in-flight inspection before any resize", async () => {
    const { scheduleTabSizing } = await import("../pi-extension/subagents/rex.ts");
    let signal: AbortSignal | undefined;
    __rexTest__.setRexExecutor((args, options) => {
      assert.equal(args[0], "session");
      signal = options?.signal;
      (globalThis as any)[Symbol.for("pi-subagents/rex-dispose")]();
      return JSON.stringify(view);
    });
    scheduleTabSizing("session:test", "window:target");
    await pause();
    assert.equal(signal?.aborted, true);
    assert.equal(__rexTest__.sizingPassCount(), 0);
  });

  it("bounds large scrollback diagnostics to two reads and never captures for normal completion", async () => {
    const { registerSurfaceHandle, unregisterSurfaceHandle, readScreen, readScreenAsync, pollForExit, DIAGNOSTIC_MAX_BYTES } = await import("../pi-extension/subagents/rex.ts");
    const id = "bounded-diagnostics";
    registerSurfaceHandle({ id, kind: "split", name: id, blockId: "block:large", sessionId: "session:test", status: "launched" });
    __rexTest__.setRexContextOverride({ session: "session:test", block: "block:anchor" });
    __rexTest__.setCommandAvailabilityOverride(true);
    const text = 'long output with "quotes" and \\backslashes\n'.repeat(1_000_000) + "last line\n";
    let calls = 0;
    __rexTest__.setRexExecutor((args, options) => {
      calls++;
      assert.equal(options?.timeoutMs, 3000);
      const payload = JSON.parse(args[7]);
      assert.equal(payload.max_bytes, DIAGNOSTIC_MAX_BYTES);
      if (args[6] === "format") return JSON.stringify({ content: text.slice(0, 100), id: 17, total: text.length });
      assert.equal(args[6], "blob_read");
      assert.equal(payload.id, 17);
      assert.equal(payload.offset, text.length - Math.floor(DIAGNOSTIC_MAX_BYTES / 2));
      const data = text.slice(payload.offset);
      assert.ok(Buffer.byteLength(JSON.stringify(data)) <= DIAGNOSTIC_MAX_BYTES,
        "the tail must leave room for JSON escaping within the bounded reply");
      return JSON.stringify({ data, eof: true });
    });
    try {
      assert.equal(readScreen(id, 1), "last line");
      assert.equal(await readScreenAsync(id, 1), "last line");
      assert.equal(calls, 4);
      __rexTest__.setRexExecutor((args) => {
        assert.equal(args[6], "process", "normal completion must never read scrollback");
        return JSON.stringify({ last_exit: { exit_code: 0 } });
      });
      assert.equal((await pollForExit(id, new AbortController().signal, { interval: 1 })).reason, "done");
    } finally { unregisterSurfaceHandle(id); }
  });

  it("reads nesting and placement settings with safe documented defaults", async () => {
    const { chooseSurfaceKind, topLevelSurfaceSetting, splitDirectionSetting } = await import("../pi-extension/subagents/rex.ts");
    const savedName = process.env.PI_SUBAGENT_NAME;
    const savedTop = process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE;
    const savedDirection = process.env.PI_SUBAGENT_SPLIT_DIRECTION;
    try {
      delete process.env.PI_SUBAGENT_NAME;
      process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = "unknown";
      process.env.PI_SUBAGENT_SPLIT_DIRECTION = "unknown";
      assert.equal(topLevelSurfaceSetting(), "tab");
      assert.equal(splitDirectionSetting(), "auto");
      assert.equal(chooseSurfaceKind(), "tab");
      process.env.PI_SUBAGENT_NAME = "parent";
      assert.equal(chooseSurfaceKind(), "pane");
      process.env.PI_SUBAGENT_TOP_LEVEL_SURFACE = "pane";
      delete process.env.PI_SUBAGENT_NAME;
      assert.equal(chooseSurfaceKind(), "pane");
    } finally {
      restoreEnvVar("PI_SUBAGENT_NAME", savedName);
      restoreEnvVar("PI_SUBAGENT_TOP_LEVEL_SURFACE", savedTop);
      restoreEnvVar("PI_SUBAGENT_SPLIT_DIRECTION", savedDirection);
    }
  });
});

describe("Pi 1.4 native Rex capability and status compatibility", () => {
  const nativeKeys = ["PI_PROGRAM_STATUS", "PI_HYPERLINKS", "PI_IMAGE_PROTOCOL", "PI_TRUE_COLOR"] as const;
  const terminalKeys = [...nativeKeys, "TERM_PROGRAM", "TERM", "COLORTERM", "TMUX"];
  let saved: Array<[string, string | undefined]>;
  beforeEach(() => {
    saved = terminalKeys.map((key) => [key, process.env[key]]);
    for (const key of terminalKeys) delete process.env[key];
    process.env.TERM_PROGRAM = "rex";
    process.env.TERM = "xterm-256color";
    setCapabilityOverrides({});
    resetCapabilitiesCache();
  });
  afterEach(() => {
    for (const [key, value] of saved) restoreEnvVar(key, value);
    setCapabilityOverrides({});
    resetCapabilitiesCache();
  });

  it("uses native automatic Rex detection and auto overrides, not a second renderer", () => {
    const expected = { images: "kitty", trueColor: true, hyperlinks: true };
    assert.deepEqual(detectCapabilities(), expected);
    process.env.PI_HYPERLINKS = "auto";
    process.env.PI_IMAGE_PROTOCOL = "auto";
    process.env.PI_TRUE_COLOR = "auto";
    assert.deepEqual(detectCapabilities(), expected);
    assert.equal(getTerminalColorMode(), "truecolor");
    assert.match(hyperlink("Rex", "https://www.superlogical.com/rex"), /\x1b\]8;/);
  });

  it("honors native environment disablement and explicit image protocol selection", () => {
    process.env.PI_HYPERLINKS = "0";
    process.env.PI_IMAGE_PROTOCOL = "none";
    process.env.PI_TRUE_COLOR = "0";
    assert.deepEqual(detectCapabilities(), { images: null, trueColor: false, hyperlinks: false });
    assert.equal(getTerminalColorMode(), "256color");
    assert.equal(getCapabilities().hyperlinks, false);
    process.env.PI_IMAGE_PROTOCOL = "iterm2";
    assert.equal(detectCapabilities().images, "iterm2");
  });

  it("lets Pi settings override conflicting environment choices without writing settings", () => {
    process.env.PI_HYPERLINKS = "1";
    process.env.PI_IMAGE_PROTOCOL = "kitty";
    process.env.PI_TRUE_COLOR = "1";
    const settings = SettingsManager.inMemory({ terminal: { hyperlinks: false, images: false, trueColor: false } });
    setCapabilityOverrides(settings.getTerminalCapabilityOverrides());
    assert.deepEqual(getCapabilities(), { images: null, trueColor: false, hyperlinks: false });
    // Auto settings defer to native environment/detection; they are not forced values.
    const automatic = SettingsManager.inMemory({ terminal: { hyperlinks: "auto", images: "auto", trueColor: "auto" } });
    setCapabilityOverrides(automatic.getTerminalCapabilityOverrides());
    assert.deepEqual(getCapabilities(), { images: "kitty", trueColor: true, hyperlinks: true });
  });

  it("preserves explicit native overrides verbatim in server-launched wrappers and leaves auto unset", async () => {
    const { execFileSync } = await import("node:child_process");
    const { registerSurfaceHandle, unregisterSurfaceHandle, sendLongCommand } = await import("../pi-extension/subagents/rex.ts");
    const dir = createTestDir();
    const id = "native-overrides";
    __rexTest__.setRexContextOverride({ session: "session:test", block: "block:anchor" });
    __rexTest__.setCommandAvailabilityOverride(true);
    __rexTest__.setRexExecutor(() => JSON.stringify({ window_id: "window:child", block_ids: ["block:child"] }));
    try {
      for (const explicit of [false, true]) {
        registerSurfaceHandle({ id, kind: "tab", name: id, sessionId: "session:test", status: "reserved" });
        if (explicit) {
          process.env.PI_PROGRAM_STATUS = "0";
          process.env.PI_HYPERLINKS = "0";
          process.env.PI_IMAGE_PROTOCOL = "none";
          // Do not interpret/execute unexpected values; let Pi handle them.
          process.env.PI_TRUE_COLOR = "auto'; $(touch should-not-exist)";
        }
        const script = sendLongCommand(id, explicit ? 'echo "$PI_TRUE_COLOR"' : "exit 0", { scriptPath: join(dir, "launch.sh") });
        const text = readFileSync(script, "utf8");
        for (const key of nativeKeys) {
          if (explicit) assert.ok(text.includes(`export ${key}=${shellEscape(process.env[key]!)}`));
          else assert.equal(text.includes(key), false, "automatic detection must remain unset");
        }
        assert.equal(text.includes("PI_PROGRAM_STATUS=1"), false, "must not force status on");
        if (explicit) {
          const output = execFileSync("bash", [script], {
            cwd: dir,
            encoding: "utf8",
            // Require the wrapper to restore the value, rather than inherit it.
            env: { ...process.env, PI_TRUE_COLOR: undefined },
          });
          assert.equal(existsSync(join(dir, "should-not-exist")), false, "must not execute the injected command");
          assert.equal(output, "auto'; $(touch should-not-exist)\n");
        }
      }
    } finally {
      unregisterSurfaceHandle(id);
      __rexTest__.setRexExecutor(null);
      __rexTest__.setCommandAvailabilityOverride(undefined);
      __rexTest__.setRexContextOverride(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const mode of ["automatic-unavailable", "disabled", "forced-but-unavailable", "query-failed", "native-report"] as const) {
    it(`uses the target's actual status for ${mode}, without changing Pi environment/settings`, async () => {
      const { registerSurfaceHandle, unregisterSurfaceHandle, sendMessage } = await import("../pi-extension/subagents/rex.ts");
      const dir = createTestDir();
      const settingsFile = join(dir, "settings.json");
      const settings = '{"terminal":{"hyperlinks":false,"images":false,"trueColor":false}}\n';
      writeFileSync(settingsFile, settings);
      const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = dir;
      if (mode === "disabled" || mode === "native-report") process.env.PI_PROGRAM_STATUS = "0";
      if (mode === "forced-but-unavailable") process.env.PI_PROGRAM_STATUS = "1";
      const envBefore = { ...process.env };
      const calls: string[][] = [];
      const id = `native-status-${mode}`;
      __rexTest__.setRexContextOverride({ session: "session:test", block: "block:anchor" });
      __rexTest__.setCommandAvailabilityOverride(true);
      __rexTest__.setRexExecutor((args) => {
        calls.push(args);
        if (args.at(-1) === "program_status") {
          if (mode === "query-failed") throw new Error("server disconnected");
          return JSON.stringify({ records: mode === "native-report" ? [
            { state: "idle", app: "pi", updated_at: "2026-11-02T00:00:00Z" },
          ] : [] });
        }
        return "{}";
      });
      registerSurfaceHandle({ id, kind: "tab", name: id, sessionId: "session:test", blockId: "block:child", status: "launched" });
      try {
        if (mode === "native-report") {
          // The parent's disabled status is not evidence that the child's report is absent.
          sendMessage(id, "/hotkeys");
          assert.equal(calls.filter((args) => args.includes("block.event")).length, 2);
        } else {
          assert.throws(() => sendMessage(id, "do not submit"), (error: Error) => {
            assert.match(error.message, /Cannot deliver message safely/);
            assert.match(error.message, /PI_PROGRAM_STATUS \(0 disables reports\)/);
            assert.match(error.message, /OSC 7501/);
            assert.match(error.message, /interact with the child manually; no input was sent/);
            return true;
          });
          assert.equal(calls.some((args) => args.includes("block.event")), false);
        }
        // An assertion failure must not dump unrelated provider credentials.
        assert.ok(JSON.stringify({ ...process.env }) === JSON.stringify(envBefore), "adapter must not change process environment");
        assert.equal(readFileSync(settingsFile, "utf8"), settings);
        assert.equal(statSync(settingsFile).isFile(), true);
      } finally {
        restoreEnvVar("PI_CODING_AGENT_DIR", savedAgentDir);
        unregisterSurfaceHandle(id);
        __rexTest__.setRexExecutor(null);
        __rexTest__.setCommandAvailabilityOverride(undefined);
        __rexTest__.setRexContextOverride(undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("safe_bash tool", () => {
  function registerSafeBash() {
    const tools: any[] = [];
    safeBashExtension({ registerTool(t: any) { tools.push(t); } } as any);
    const tool = tools.find((t) => t.name === "safe_bash");
    assert.ok(tool, "safe-bash.ts registers a safe_bash tool");
    return tool;
  }

  it("runs a harmless command through pi's built-in bash tool", async () => {
    const tool = registerSafeBash();
    const result = await tool.execute("c1", { command: "echo safe-bash-ok" }, undefined, undefined, {});
    const text = result.content.map((c: any) => c.text ?? "").join("");
    assert.match(text, /safe-bash-ok/);
  });

  it("blocks a dangerous command before it reaches bash", async () => {
    const tool = registerSafeBash();
    await assert.rejects(
      tool.execute("c2", { command: "sudo echo nope" }, undefined, undefined, {}),
      /blocked by safe_bash/,
    );
  });
});
