/**
 * Integration test harness for pi-interactive-subagents.
 *
 * Provides utilities to:
 * - Detect whether Rex is available
 * - Create isolated test environments with test agent definitions
 * - Start real pi sessions in Rex panes
 * - Poll for file creation and screen output
 * - Clean up panes and temp files after tests
 */
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readdirSync,
  rmSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  isMuxAvailable,
  createSurface,
  createSurfaceSplit,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  shellEscape,
  getFocusedSurface,
  getSurfaceTab,
  disposeRexSurfaces,
  rexJson,
  rexExec,
} from "../../pi-extension/subagents/rex.ts";

// Re-export Rex primitives for tests
export {
  createSurface,
  createSurfaceSplit,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  shellEscape,
  getFocusedSurface,
  getSurfaceTab,
};

// ── Paths ──

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HARNESS_DIR, "../..");
const TEST_AGENTS_SRC = join(HARNESS_DIR, "agents");

/**
 * Absolute path to the extension source in the working tree.
 *
 * Integration tests must exercise the code on the current branch — NOT the
 * version installed as a pi-package under `~/.pi/agent/git/...` or the project
 * mirror under `.pi/git/...`, which stays pinned to the last released tag.
 *
 * We force-load this file via `pi -ne -e <path>` in startPi() below so local
 * edits are always the code under test, regardless of what pi-packages are
 * installed on the host.
 */
const EXTENSION_SOURCE = join(PROJECT_ROOT, "pi-extension", "subagents", "index.ts");

// ── Configuration ──

/** Model used for integration tests. Override with PI_TEST_MODEL env var. */
export const TEST_MODEL = process.env.PI_TEST_MODEL ?? "anthropic/claude-haiku-4-5";

/** Per-test timeout in ms. Override with PI_TEST_TIMEOUT env var. */
export const PI_TIMEOUT = Number(process.env.PI_TEST_TIMEOUT ?? "120000");

// ── Backend detection ──

/**
 * Detect whether Rex is available in the current environment.
 * Returns ["rex"] or [].
 */
export function getAvailableBackends(): string[] {
  return isMuxAvailable() ? ["rex"] : [];
}

export async function waitForFocusedSurface(
  surface: string,
  timeout: number = PI_TIMEOUT,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (getFocusedSurface() === surface) return;
    await sleep(200);
  }

  throw new Error(
    `Timeout (${timeout}ms) waiting for focused Rex pane ${surface}; ` +
      `current focus is ${getFocusedSurface() ?? "unknown"}`,
  );
}

// ── Test environment ──

export interface TestEnv {
  /** Temp directory serving as the test project root */
  dir: string;
  /** Panes created during the test (cleaned up automatically) */
  surfaces: string[];
  /** Temp files to clean up */
  tempFiles: string[];
  /** Optional dedicated Rex session: includes descendants even if a test fails. */
  rexSession?: string;
  /** Restore the invoking terminal's identity after isolated-session cleanup. */
  savedContext?: Record<string, string | undefined>;
}

/**
 * Create an isolated test environment with test agent definitions.
 * The temp dir has `.pi/agents/` containing copies of all test agents.
 */
export function createTestEnv(opts?: { isolateRex?: boolean; agentsSrc?: string }): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "pi-integ-"));
  const env: TestEnv = { dir, surfaces: [], tempFiles: [] };
  try {
    const agentsDir = join(dir, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });

    // Allow isolated profile fixtures without modifying the shared test agents.
    const agentsSrc = opts?.agentsSrc ?? TEST_AGENTS_SRC;
    // Copy test agent definitions into the project-local agents dir
    if (existsSync(agentsSrc)) {
      for (const file of readdirSync(agentsSrc)) {
        if (file.endsWith(".md")) {
          const target = join(agentsDir, file);
          cpSync(join(agentsSrc, file), target);
          // Rewrite only frontmatter: body examples must not override this guard.
          // The approved model applies to parents AND profile-selected children.
          const content = readFileSync(target, "utf8").replace(/\r\n/g, "\n").replace(
            /^---\n((?:[^\n]*\n)*?)---(?=\n|$)/,
            (_match, frontmatter: string) => {
              frontmatter = /^model:/m.test(frontmatter)
                ? frontmatter.replace(/^model:.*$/gm, () => `model: ${TEST_MODEL}`)
                : `${frontmatter}model: ${TEST_MODEL}\n`;
              frontmatter = /^thinking:/m.test(frontmatter)
                ? frontmatter.replace(/^thinking:.*$/gm, () => "thinking: off")
                : `${frontmatter}thinking: off\n`;
              return `---\n${frontmatter}---`;
            },
          );
          writeFileSync(target, content);
        }
      }
    }

    if (opts?.isolateRex) {
      const created = rexJson(["new", `pi-lifecycle-${uniqueId()}`, "-c", dir, "--json", "--", "bash", "-c", "sleep 3600"]);
      // Record ownership before validating the rest of the response so rollback
      // can kill a created session even when its initial block is malformed.
      if (typeof created?.session_id === "string" && created.session_id.trim()) {
        env.rexSession = created.session_id;
      }
      const initialWindow = Array.isArray(created?.initial_windows) ? created.initial_windows[0] : undefined;
      const blockId = Array.isArray(initialWindow?.block_ids) ? initialWindow.block_ids[0] : undefined;
      if (!env.rexSession || typeof blockId !== "string" || !blockId.trim()) {
        throw new Error("Invalid Rex test session response: expected a session ID and an initial block ID");
      }

      const keys = ["REX_SESSION", "REX_BLOCK", ...Object.keys(process.env).filter((k) => k.startsWith("PI_SUBAGENT_"))];
      env.savedContext = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
      for (const key of keys) {
        if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
      }
      process.env.REX_SESSION = env.rexSession;
      process.env.REX_BLOCK = blockId;
    }
    return env;
  } catch (error) {
    try {
      if (env.rexSession) rexExec(["kill", env.rexSession]);
    } catch (cleanupError) {
      console.warn("Failed to kill Rex test session:", cleanupError);
    } finally {
      cleanupLocalTestResources(env);
    }
    throw error;
  }
}

/**
 * Clean up all resources created during the test.
 */
export function cleanupTestEnv(env: TestEnv): void {
  for (const surface of env.surfaces) {
    try {
      closeSurface(surface);
    } catch {}
  }
  try {
    try {
      disposeRexSurfaces();
    } catch (error) {
      console.warn("Failed to dispose Rex surfaces:", error);
    }
    if (env.rexSession) {
      try {
        // Only the exact session returned by this fixture's `rex new` is owned.
        // This also cleans descendant panes that outlived a failed assertion.
        rexExec(["kill", env.rexSession]);
      } catch (error) {
        console.warn("Failed to kill Rex test session:", error);
      }
    }
  } finally {
    cleanupLocalTestResources(env);
  }
}

/** Shared by normal teardown and setup rollback, even when Rex cleanup fails. */
function cleanupLocalTestResources(env: TestEnv): void {
  for (const [key, value] of Object.entries(env.savedContext ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const file of env.tempFiles) {
    try {
      unlinkSync(file);
    } catch {}
  }
  try {
    rmSync(env.dir, { recursive: true, force: true });
  } catch {}
}

/**
 * Create a surface and register it for automatic cleanup.
 */
export function createTrackedSurface(env: TestEnv, name: string): string {
  const surface = createSurface(name);
  env.surfaces.push(surface);
  return surface;
}

export function createTrackedSurfaceSplit(
  env: TestEnv,
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
  options?: { focus?: boolean },
): string {
  const surface = createSurfaceSplit(name, direction, fromSurface, options);
  env.surfaces.push(surface);
  return surface;
}

/**
 * Remove a surface from tracking (after manual close).
 */
export function untrackSurface(env: TestEnv, surface: string): void {
  env.surfaces = env.surfaces.filter((s) => s !== surface);
}

// ── Pi session management ──

/**
 * Start a pi session in a mux surface with the subagents extension loaded.
 * Returns the explicit parent transcript path immediately; Pi runs asynchronously.
 *
 * The command ends with a sentinel so we can detect when pi exits:
 *   `pi ...; echo '__TEST_DONE_'$?'__'`
 */
export function startPi(
  surface: string,
  testDir: string,
  task: string,
  opts?: { model?: string; extraArgs?: string },
): string {
  const sessionFile = join(testDir, `parent-${uniqueId()}.jsonl`);
  const model = opts?.model ?? TEST_MODEL;
  const extra = opts?.extraArgs ?? "";

  // Force pi to load the working-tree extension (not an installed pi-package
  // snapshot). `-ne` disables extension auto-discovery, `-e <path>` loads the
  // current branch's source directly. Without this, the tests silently run
  // against whatever version is checked out under `~/.pi/agent/git/...`.
  const cmd = [
    `cd ${shellEscape(testDir)} &&`,
    `pi`,
    `-ne`,
    `-e ${shellEscape(EXTENSION_SOURCE)}`,
    `--model ${shellEscape(model)}`,
    `--session ${shellEscape(sessionFile)}`,
    `--thinking off --no-mcp --no-skills --no-prompt-templates --no-context-files`,
    extra,
    shellEscape(task),
  ]
    .filter(Boolean)
    .join(" ");

  sendLongCommand(surface, `for key in \${!PI_SUBAGENT_@}; do unset "$key"; done\n${cmd}; status=$?; echo "__TEST_DONE_\${status}__"; exit "$status"`, {
    cwd: testDir,
    scriptPath: join(testDir, `test-launch-${uniqueId()}.sh`),
  });
  return sessionFile;
}

// ── Polling helpers ──

/**
 * Poll until a regex pattern appears in the surface's screen output.
 * Throws on timeout with the last screen contents for debugging.
 */
export async function waitForScreen(
  surface: string,
  pattern: RegExp,
  timeout: number = PI_TIMEOUT,
  lines: number = 200,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const screen = await readScreenAsync(surface, lines);
      if (pattern.test(screen)) return screen;
    } catch {}
    await sleep(2000);
  }

  let finalScreen = "";
  try {
    finalScreen = readScreen(surface, lines);
  } catch {}
  throw new Error(
    `Timeout (${timeout}ms) waiting for pattern ${pattern}.\nLast screen:\n${finalScreen.slice(-1000)}`,
  );
}

/**
 * Poll until a file exists and optionally matches a content pattern.
 * Returns the file content on success.
 */
export async function waitForFile(
  path: string,
  timeout: number = PI_TIMEOUT,
  contentPattern?: RegExp,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      if (!contentPattern || contentPattern.test(content)) return content;
    }
    await sleep(2000);
  }
  throw new Error(
    `Timeout (${timeout}ms) waiting for file: ${path}` +
      (contentPattern ? ` matching ${contentPattern}` : ""),
  );
}

/**
 * Wait for the pi process in a surface to exit (sentinel detection).
 * Returns the exit code.
 */
export async function waitForPiExit(
  surface: string,
  timeout: number = PI_TIMEOUT,
): Promise<number> {
  const screen = await waitForScreen(surface, /__TEST_DONE_(\d+)__/, timeout);
  const match = screen.match(/__TEST_DONE_(\d+)__/);
  return match ? parseInt(match[1], 10) : -1;
}

// ── Utilities ──

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Register a temp file for cleanup.
 */
export function trackTempFile(env: TestEnv, path: string): void {
  env.tempFiles.push(path);
}
