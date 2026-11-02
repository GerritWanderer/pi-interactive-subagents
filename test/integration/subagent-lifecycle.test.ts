/**
 * Opt-in REAL-model acceptance against workspace source (not installed packages).
 * Run: PI_TEST_MODEL=provider/model npm run test:integration
 * Each case owns a dedicated Rex session, including all descendant panes.
 * Assertions inspect persisted messages, never prompt echoes in terminal capture.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  getAvailableBackends, createTestEnv, cleanupTestEnv, createTrackedSurface,
  startPi, sleep, uniqueId, PI_TIMEOUT, TEST_MODEL, type TestEnv,
} from "./harness.ts";
import {
  rexJson, rexExec, getSurfaceHandle, queryBlockProcess, queryProgramStatus,
  sendMessage, shellEscape,
} from "../../pi-extension/subagents/rex.ts";

function messages(file: string): any[] {
  if (!existsSync(file)) return [];
  // The writer may be partway through its final JSONL line.
  return readFileSync(file, "utf8").split("\n").flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      return entry.type === "message" ? [entry.message]
        : entry.type === "custom_message" ? [{ ...entry, role: "custom" }] : [];
    }
    catch { return []; }
  });
}
function text(message: any): string {
  return typeof message?.content === "string" ? message.content
    : (message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}
function results(file: string, name: string): any[] {
  return messages(file).filter((m) => m.customType === "subagent_result" && m.details?.name === name);
}
function tools(file: string, tool: string): any[] {
  return messages(file).filter((m) => m.role === "toolResult" && m.toolName === tool);
}
async function until<T>(check: () => T | undefined | false, description: string, transcript?: string): Promise<T> {
  const deadline = Date.now() + PI_TIMEOUT;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(200);
  }
  const diagnostic = transcript ? messages(transcript).slice(-8).map((m) => ({
    role: m.role, tool: m.toolName, customType: m.customType, details: m.details, text: text(m).slice(-1000),
  })) : [];
  assert.fail(`Timed out: ${description}\n${JSON.stringify(diagnostic, null, 2)}`);
}
async function result(file: string, name: string, count = 1): Promise<any> {
  return until(() => results(file, name)[count - 1], `result ${count} from ${name}`, file);
}
function success(message: any): void {
  assert.equal(message.details.outcome, "success", text(message));
  assert.equal(message.details.exitCode, 0, text(message));
  assert.ok(existsSync(message.details.sessionFile), "result must retain the saved session");
}
async function assistant(file: string, token: string): Promise<any> {
  return until(() => messages(file).find((m) => m.role === "assistant" && text(m).includes(token)), `assistant ${token}`, file);
}
function blocks(): any[] {
  return rexJson(["block", "ls", "-s", process.env.REX_SESSION!, "--json"]).blocks;
}
async function block(name: string): Promise<any> {
  return until(() => blocks().find((b) => b.label === name), `pane ${name}`);
}
async function removed(name: string): Promise<void> {
  await until(() => !blocks().some((b) => b.label === name), `cleanup of ${name}`);
}
function isRunning(blockId: string): boolean {
  const observed = queryBlockProcess(blockId, process.env.REX_SESSION!);
  return observed !== "not_found" && observed.last_exit === null;
}
async function idle(blockId: string): Promise<void> {
  await until(() => queryProgramStatus(blockId, process.env.REX_SESSION!).some((r: any) =>
    (r.app?.toLowerCase() === "pi" || r.effective_app?.toLowerCase() === "pi") && (r.state === "idle" || r.state === "done")), `native Pi idle status in ${blockId}`);
}
function parentTask(params: object, continuation = "After its automatic result arrives, say PARENT_RECEIVED."): string {
  return `Call subagent exactly once with ${JSON.stringify(params)}. Do not execute the task yourself. ` +
    `After the launch acknowledgement, end your turn and wait for the automatic result; do not poll or call any other tool. ${continuation}`;
}

const backends = getAvailableBackends();
if (!backends.length) console.log("Rex unavailable: lifecycle cases require a live Rex terminal.");

for (const backend of backends) {
  describe(`subagent-lifecycle [${backend}] model=${TEST_MODEL}`, { timeout: PI_TIMEOUT * 24 }, () => {
    let env: TestEnv;
    let outside: { session: string; block: string };
    beforeEach(() => {
      outside = { session: process.env.REX_SESSION!, block: process.env.REX_BLOCK! };
      env = createTestEnv({ isolateRex: true });
      assert.notEqual(env.rexSession, outside.session);
      // Every copied profile, not just the parent, must use the approved model.
      const agentsDir = join(env.dir, ".pi/agents");
      const profiles = readdirSync(agentsDir).filter((file) => file.endsWith(".md"));
      assert.ok(profiles.length > 0, "test agent profiles must be copied");
      for (const file of profiles) {
        const content = readFileSync(join(agentsDir, file), "utf8");
        const frontmatter = content.match(/^---\n([\s\S]*?)\n---(?=\n|$)/)?.[1];
        assert.ok(frontmatter, `${file} must have frontmatter`);
        assert.deepEqual(frontmatter.match(/^model:.*$/gm), [`model: ${TEST_MODEL}`], `${file} must use the approved model`);
        assert.deepEqual(frontmatter.match(/^thinking:.*$/gm), ["thinking: off"], `${file} must disable thinking`);
      }
    });
    afterEach(() => {
      const ownedSession = env.rexSession;
      cleanupTestEnv(env);
      assert.ok(!rexJson(["ls", "--json"]).sessions.some((s: any) => s.session_id === ownedSession), "owned session and descendants must be gone");
      assert.ok(rexJson(["block", "ls", "-s", outside.session, "--json"]).blocks.some((b: any) => b.block_id === outside.block), "cleanup must preserve the invoking, unrelated pane");
    });

    it("returns an asynchronous launch acknowledgement, then exactly one persisted parent result", async () => {
      const name = `echo-${uniqueId()}`;
      const marker = join(env.dir, "echo.txt");
      const surface = createTrackedSurface(env, "parent");
      const session = startPi(surface, env.dir, parentTask({ name, agent: "test-echo", task:
        `Run bash: sleep 3; printf 'CHILD_OK' > ${shellEscape(marker)}. Then say CHILD_SUMMARY.` }));
      const ack = await until(() => tools(session, "subagent")[0], "spawn acknowledgement", session);
      assert.equal(ack.details.status, "started");
      assert.equal(results(session, name).length, 0, "launch must not await the task");
      const response = await result(session, name);
      success(response);
      assert.match(text(response), /CHILD_SUMMARY/);
      assert.equal(readFileSync(marker, "utf8"), "CHILD_OK");
      const child = response.details.sessionFile;
      assert.equal(JSON.parse(readFileSync(child, "utf8").split("\n")[0]).type, "session");
      assert.ok(messages(child).some((m) => m.role === "assistant" && `${m.provider}/${m.model}` === TEST_MODEL));
      await assistant(session, "PARENT_RECEIVED");
      assert.equal(results(session, name).length, 1);
      await removed(name);
    });

    it("keeps a long active tool call from surfacing a false stalled status", async () => {
      const name = `activity-${uniqueId()}`;
      const started = join(env.dir, "started.txt"), marker = join(env.dir, "activity.txt");
      const surface = createTrackedSurface(env, "parent");
      const session = startPi(surface, env.dir, parentTask({ name, agent: "test-echo", task:
        `Run this single bash call: printf STARTED > ${shellEscape(started)}; sleep 90; printf ACTIVE_OK > ${shellEscape(marker)}. Then say ACTIVITY_SUMMARY.` }));
      const ack = await until(() => tools(session, "subagent")[0], "activity launch", session);
      await until(() => existsSync(started), "long tool start", session);
      const parentId = JSON.parse(readFileSync(session, "utf8").split("\n")[0]).id;
      const activityFile = join(dirname(session), "artifacts", parentId, "subagent-activity", `${ack.details.id}.json`);
      await sleep(65_000); // Cross the normal watchdog window while the tool is alive.
      assert.equal(existsSync(marker), false);
      const activity = JSON.parse(readFileSync(activityFile, "utf8"));
      assert.equal(activity.phase, "active"); assert.equal(activity.activeScope, "tool");
      assert.equal(activity.toolName, "bash");
      assert.ok(!messages(session).some((m) => m.customType === "subagent_status" && /stalled/i.test(text(m))));
      success(await result(session, name));
      assert.equal(readFileSync(marker, "utf8"), "ACTIVE_OK");
      await assistant(session, "PARENT_RECEIVED"); await removed(name);
    });

    it("launches two live agents before either result and delivers both to the parent", async () => {
      const a = `parallel-a-${uniqueId()}`, b = `parallel-b-${uniqueId()}`;
      const surface = createTrackedSurface(env, "parent");
      const task = `Call subagent twice NOW, before waiting for either result: ` + JSON.stringify([
        { name: a, agent: "test-echo", task: `Run bash: sleep 8; printf 'A_OK' > ${shellEscape(join(env.dir, "a.txt"))}. Say A_SUMMARY.` },
        { name: b, agent: "test-echo", task: `Run bash: sleep 8; printf 'B_OK' > ${shellEscape(join(env.dir, "b.txt"))}. Say B_SUMMARY.` },
      ]) + `. Do not execute their tasks yourself. End your turn after both acknowledgements, then wait. After BOTH automatic results arrive, say BOTH_RECEIVED.`;
      const session = startPi(surface, env.dir, task);
      await until(() => tools(session, "subagent").length === 2, "two launch acknowledgements", session);
      assert.equal(results(session, a).length + results(session, b).length, 0);
      const [paneA, paneB] = await Promise.all([block(a), block(b)]);
      assert.ok(isRunning(paneA.block_id));
      assert.ok(isRunning(paneB.block_id));
      success(await result(session, a)); success(await result(session, b));
      await assistant(session, "BOTH_RECEIVED");
      assert.equal(readFileSync(join(env.dir, "a.txt"), "utf8"), "A_OK");
      assert.equal(readFileSync(join(env.dir, "b.txt"), "utf8"), "B_OK");
      assert.equal(results(session, a).length, 1); assert.equal(results(session, b).length, 1);
      await removed(a); await removed(b);
    });

    it("resumes by name with the original session, restricted loadout and special-character cwd", async () => {
      const name = `resume-${uniqueId()}`;
      const cwd = join(env.dir, "cwd 'quoted' space"); mkdirSync(cwd);
      const surface = createTrackedSurface(env, "parent");
      const session = startPi(surface, env.dir, parentTask({ name, agent: "test-echo", cwd,
        task: "Write FIRST_OK to first.txt in your cwd, then say FIRST_SUMMARY." },
      `After the first automatic result arrives, call subagent_message with name ${JSON.stringify(name)} and message "Write SECOND_OK to second.txt in your original cwd, then say SECOND_SUMMARY.". End your turn after its resume acknowledgement. After the second automatic result arrives, say RESUME_RECEIVED.`));
      const first = await result(session, name); success(first);
      const snapshot = readFileSync(`${first.details.sessionFile}.loadout.json`, "utf8");
      const second = await result(session, name, 2); success(second);
      assert.equal(first.details.sessionFile, second.details.sessionFile);
      assert.match(text(second), /SECOND_SUMMARY/);
      const resume = tools(session, "subagent_message")[0];
      assert.equal(resume.details.status, "started");
      assert.equal(resume.details.sessionFile, first.details.sessionFile);
      assert.equal(readFileSync(`${first.details.sessionFile}.loadout.json`, "utf8"), snapshot);
      const loadout = JSON.parse(snapshot);
      assert.equal(loadout.cwd, cwd); assert.equal(loadout.model, TEST_MODEL);
      const allowedTools = loadout.toolAllowlist.split(",").map((tool: string) => tool.trim());
      assert.equal(allowedTools.includes("subagent"), false);
      assert.equal(allowedTools.includes("bash"), true);
      assert.equal(allowedTools.includes("ask_question"), true);
      assert.match(readFileSync(resume.details.launchScriptFile, "utf8"), /--no-extensions/);
      assert.equal(readFileSync(join(cwd, "first.txt"), "utf8").trim(), "FIRST_OK");
      assert.equal(readFileSync(join(cwd, "second.txt"), "utf8").trim(), "SECOND_OK");
      await assistant(session, "RESUME_RECEIVED"); await removed(name);
    });

    it("delivers an ordinary ask_question and safely replies to the still-running child", async () => {
      const name = `question-${uniqueId()}`;
      const marker = join(env.dir, "answer.txt");
      const surface = createTrackedSurface(env, "parent");
      const session = startPi(surface, env.dir, parentTask({ name, agent: "test-question", task:
        `Call ask_question with question "Which acceptance token should I write?" and stop your turn. Do not guess. After the orchestrator replies, write its exact token to ${marker}, then say QUESTION_SUMMARY.` },
      `When its subagent_question arrives, reply using subagent_message name ${JSON.stringify(name)}, message "ANSWER_TOKEN_42". After replying end your turn and wait for the automatic completion result, then say QUESTION_RECEIVED.`));
      const response = await result(session, name); success(response);
      const question = messages(session).find((m) => m.customType === "subagent_question" && m.details?.name === name);
      assert.ok(question, "parent must actually receive the question");
      assert.match(question.details.question, /Which acceptance token/);
      assert.equal(tools(session, "subagent_message")[0].details.status, "steered", "reply must reach the original process, not relaunch it");
      assert.equal(readFileSync(marker, "utf8").trim(), "ANSWER_TOKEN_42");
      assert.ok(tools(response.details.sessionFile, "ask_question").length === 1);
      await assistant(session, "QUESTION_RECEIVED"); await removed(name);
    });

    it("keeps interactive Pi alive after a response, steers literal text, and collects a clean user exit", async () => {
      const name = `interactive-${uniqueId()}`;
      const marker = join(env.dir, "literal.txt"), injection = join(env.dir, "MUST_NOT_EXIST");
      const surface = createTrackedSurface(env, "parent");
      const session = startPi(surface, env.dir, parentTask({ name, agent: "test-interactive", task:
        `Say INTERACTIVE_READY now and stop your response. On a later message, copy that entire message into ${marker} using write, then say LITERAL_SAVED. Do not exit.` },
      `Do not send it any follow-up unless I explicitly ask. After its eventual process-exit result arrives, say INTERACTIVE_RECEIVED.`));
      const ack = await until(() => tools(session, "subagent")[0], "interactive launch", session);
      await assistant(ack.details.sessionFile, "INTERACTIVE_READY");
      const pane = await block(name); await idle(pane.block_id); await sleep(1500);
      assert.ok(isRunning(pane.block_id));
      assert.equal(results(session, name).length, 0, "response completion is not process completion");
      const literal = `literal "double" 'single'; $(touch ${injection})\nsecond line & | < >`;
      const parentBlock = getSurfaceHandle(surface)!.blockId!; await idle(parentBlock);
      sendMessage(surface, `Call subagent_message with name ${JSON.stringify(name)} and message ${JSON.stringify(literal)}. End your turn after sending; do not do the file write yourself.`);
      await assistant(ack.details.sessionFile, "LITERAL_SAVED");
      assert.equal(tools(session, "subagent_message")[0].details.status, "steered");
      assert.equal(readFileSync(marker, "utf8").trim(), literal.replace(/\n/g, " "));
      assert.equal(existsSync(injection), false);
      await idle(pane.block_id);
      rexExec(["send-key", "-s", env.rexSession!, "-b", pane.block_id, "ctrl+d"]);
      const response = await result(session, name); success(response);
      assert.match(text(response), /LITERAL_SAVED/);
      await assistant(session, "INTERACTIVE_RECEIVED");
      assert.equal(results(session, name).length, 1); await removed(name);
    });

    it("keeps an autonomous coordinator alive while a nested child is pending in its tab", async () => {
      const name = `coordinator-${uniqueId()}`, nested = `nested-${uniqueId()}`;
      const marker = join(env.dir, "nested.txt");
      const surface = createTrackedSurface(env, "parent");
      const session = startPi(surface, env.dir, parentTask({ name, agent: "test-coordinator", task:
        `Call subagent with ${JSON.stringify({ name: nested, agent: "test-echo", task: `Run bash: sleep 10; printf 'NESTED_OK' > ${shellEscape(marker)}. Say NESTED_CHILD_SUMMARY.` })}. End your turn with NESTED_WAITING. When the automatic child result arrives, say NESTED_COORDINATOR_SUMMARY.` }));
      const ack = await until(() => tools(session, "subagent")[0], "coordinator launch", session);
      await assistant(ack.details.sessionFile, "NESTED_WAITING");
      const coordinator = await block(name), child = await block(nested);
      assert.equal(child.window_id, coordinator.window_id, "nested child must split its spawning tab");
      assert.equal(results(session, name).length, 0);
      assert.ok(isRunning(coordinator.block_id), "pending child prevents parent auto-exit");
      success(await result(ack.details.sessionFile, nested));
      const response = await result(session, name); success(response);
      assert.match(text(response), /NESTED_COORDINATOR_SUMMARY/);
      assert.equal(readFileSync(marker, "utf8"), "NESTED_OK");
      await assistant(session, "PARENT_RECEIVED"); await removed(name); await removed(nested);
    });

    it("reports manual pane closure as interruption exactly once and permits saved-session follow-up", async () => {
      const name = `interrupted-${uniqueId()}`, marker = join(env.dir, "recovered.txt");
      const surface = createTrackedSurface(env, "parent");
      const session = startPi(surface, env.dir, parentTask({ name, agent: "test-interactive", task:
        "Say INTERRUPT_READY and stop your response. Remain open for later instructions." },
      `After its automatic interruption result arrives, say INTERRUPTION_RECEIVED. Do not resume until I explicitly request it.`));
      const ack = await until(() => tools(session, "subagent")[0], "interruptible launch", session);
      await assistant(ack.details.sessionFile, "INTERRUPT_READY");
      const pane = await block(name); assert.ok(isRunning(pane.block_id));
      rexExec(["block", "close", "-s", env.rexSession!, pane.block_id]);
      const interrupted = await result(session, name);
      assert.equal(interrupted.details.outcome, "interrupted");
      assert.notEqual(interrupted.details.exitCode, 0);
      assert.match(text(interrupted), /interrupt/i);
      assert.ok(existsSync(ack.details.sessionFile));
      assert.ok(existsSync(`${ack.details.sessionFile}.loadout.json`));
      await assistant(session, "INTERRUPTION_RECEIVED"); await sleep(1500);
      assert.equal(results(session, name).length, 1, "missing pane must terminate observation exactly once");
      await idle(getSurfaceHandle(surface)!.blockId!);
      sendMessage(surface, `Now call subagent_message with name ${JSON.stringify(name)}, message ${JSON.stringify(`Write RECOVERED_OK to ${marker}, then say RECOVERED_SUMMARY.`)}. End your turn and await its automatic result. Then say RECOVERY_RECEIVED.`);
      const recovered = await result(session, name, 2); success(recovered);
      assert.equal(recovered.details.sessionFile, ack.details.sessionFile);
      assert.match(text(recovered), /RECOVERED_SUMMARY/);
      assert.equal(readFileSync(marker, "utf8").trim(), "RECOVERED_OK");
      await assistant(session, "RECOVERY_RECEIVED"); await removed(name);
    });

    it("uses profile-selected fork lineage, project discovery and system-prompt identity", async () => {
      const name = `fork-${uniqueId()}`, marker = join(env.dir, "fork.txt");
      const surface = createTrackedSurface(env, "parent");
      const session = startPi(surface, env.dir,
        `First call subagents_list and confirm test-fork is available. Then ` + parentTask({ name, agent: "test-fork", task:
          `Write FORK_OK to ${marker} and summarize. Do not spawn any agents.` }));
      const response = await result(session, name); success(response);
      const header = JSON.parse(readFileSync(response.details.sessionFile, "utf8").split("\n")[0]);
      assert.equal(header.parentSession, session);
      assert.ok(tools(session, "subagents_list").length);
      const loadout = JSON.parse(readFileSync(`${response.details.sessionFile}.loadout.json`, "utf8"));
      assert.equal(loadout.systemPromptMode, "append");
      assert.match(loadout.identity, /CUSTOM_PROMPT_ACTIVE/);
      assert.ok(messages(response.details.sessionFile).some((m) => m.role === "system" &&
        JSON.stringify(m.sections).includes("CUSTOM_PROMPT_ACTIVE")), "profile identity must be in the actual Pi system prompt");
      assert.equal(readFileSync(marker, "utf8").trim(), "FORK_OK");
      await assistant(session, "PARENT_RECEIVED"); await removed(name);
    });
  });
}
