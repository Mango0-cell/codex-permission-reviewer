import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Stats } from "node:fs";
import type { ExecutableIdentity, SafeItem, ReviewState, UnknownRecord, AppServerOptions } from "./protocol-types.ts";
import { APP_SERVER_MODEL, APP_SERVER_EFFORT, DEFAULT_APP_SERVER_TIMEOUT_MS, MAX_APP_SERVER_TIMEOUT_MS, MAX_APP_SERVER_LINE_BYTES, MAX_APP_SERVER_STDOUT_BYTES, MAX_APP_SERVER_STDERR_BYTES, MAX_APP_SERVER_MESSAGE_BYTES } from "./config.ts";
export * from "./config.ts";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { PACKAGE_VERSION } from "../version.ts";

/**
 * This client intentionally talks only to the local Codex app-server. It does
 * not contain an HTTP client, API endpoint, API-key environment variable, or
 * credential parser. Authentication is provided to the child only through an
 * OS-level symlink to the already-managed auth.json file.
 */

const CHILD_CLEANUP_TIMEOUT_MS = 1_500;
const TEMP_DIRECTORY_PREFIX = "codex-permission-reviewer-";
const MANAGED_AUTH_FILENAME = "auth.json";
const CODEX_EXECUTABLE_NAME = process.platform === "win32" ? "codex.exe" : "codex";
const EXPECTED_PERMISSION_PROFILE = "no-tools";
const EXPECTED_INITIALIZE_ID = 1;
const EXPECTED_THREAD_START_ID = 2;
const EXPECTED_TURN_START_ID = 3;

const ALLOWED_FEATURES = Object.freeze({
  shell_tool: false,
  unified_exec: false,
  apps: false,
  plugins: false,
  browser_use: false,
  browser_use_external: false,
  computer_use: false,
  multi_agent: false,
  hooks: false,
  goals: false,
  memories: false,
  view_image: false,
  image_generation: false,
});

export const NO_TOOLS_CONFIG = [
  'default_permissions = "no-tools"',
  'web_search = "disabled"',
  "",
  "[features]",
  ...Object.entries(ALLOWED_FEATURES).map(([name, enabled]) => `${name} = ${enabled}`),
  "",
  "[permissions]",
  "[permissions.no-tools]",
  'description = "No local command or network access"',
  'extends = ":read-only"',
  "",
  "[permissions.no-tools.filesystem]",
  '":root" = "deny"',
  "",
  "[permissions.no-tools.network]",
  "enabled = false",
  "",
  "[mcp_servers]",
  "",
].join("\n");

const ALLOWED_ENV_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
]);

const SAFE_NOTIFICATION_METHODS = new Set([
  "configWarning",
  "remoteControl/status/changed",
  "account/rateLimits/updated",
  "thread/started",
  "thread/settings/updated",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
]);

const SAFE_ITEM_TYPES = new Set(["userMessage", "reasoning", "agentMessage"]);

export class AppServerReviewError extends Error {
  constructor(readonly hazard: string, message = "The local reviewer did not complete safely.") {
    super(message);
    this.name = "AppServerReviewError";

  }
}

function fail(hazard: string, message: string): never {
  throw new AppServerReviewError(hazard, message);
}

function isObject(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedJson(value: unknown) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail("reviewer_malformed_output", "The app-server message was not serializable.");
  }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_APP_SERVER_MESSAGE_BYTES) {
    fail("reviewer_output_oversize", "The app-server message exceeded the size limit.");
  }
  return serialized;
}

function parseLine(line: string): UnknownRecord {
  if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > MAX_APP_SERVER_LINE_BYTES) {
    fail("reviewer_output_oversize", "The app-server line exceeded the size limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    fail("reviewer_malformed_output", "The app-server emitted malformed JSON.");
  }
  if (!isObject(value)) fail("reviewer_malformed_output", "The app-server message was not an object.");
  return value;
}

async function* readBoundedLines(stream: AsyncIterable<Buffer | string>, maxBytes = MAX_APP_SERVER_LINE_BYTES) {
  let pending = Buffer.alloc(0);
  let discarding = false;
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(String(rawChunk));
    let offset = 0;
    while (offset < chunk.length) {
      const newlineIndex = chunk.indexOf(0x0a, offset);
      const segmentEnd = newlineIndex === -1 ? chunk.length : newlineIndex;
      const segment = chunk.subarray(offset, segmentEnd);
      if (discarding) {
        if (newlineIndex === -1) {
          offset = chunk.length;
        } else {
          discarding = false;
          offset = newlineIndex + 1;
          yield null;
        }
        continue;
      }
      if (pending.length + segment.length > maxBytes) {
        pending = Buffer.alloc(0);
        if (newlineIndex === -1) {
          discarding = true;
          offset = chunk.length;
        } else {
          offset = newlineIndex + 1;
          yield null;
        }
        continue;
      }
      if (segment.length > 0) pending = Buffer.concat([pending, segment]);
      if (newlineIndex === -1) {
        offset = chunk.length;
        continue;
      }
      const line = pending[pending.length - 1] === 0x0d ? pending.subarray(0, pending.length - 1) : pending;
      pending = Buffer.alloc(0);
      offset = newlineIndex + 1;
      yield line.toString("utf8");
    }
  }
  if (discarding) yield null;
  else if (pending.length > 0) {
    const line = pending[pending.length - 1] === 0x0d ? pending.subarray(0, pending.length - 1) : pending;
    yield line.toString("utf8");
  }
}

export const readBoundedAppServerLines = readBoundedLines;

function jsonRpcRequest(id: number, method: string, params: object) {
  return { id, method, params };
}

export function buildAppServerRequests({ cwd, prompt, outputSchema }: { cwd: string; prompt: string; outputSchema: object }) {
  if (!isAbsolute(cwd) || typeof prompt !== "string" || prompt.length === 0 || !isObject(outputSchema)) {
    throw new TypeError("Invalid app-server request inputs.");
  }
  return Object.freeze({
    initialize: jsonRpcRequest(EXPECTED_INITIALIZE_ID, "initialize", {
      clientInfo: { name: "codex-permission-reviewer", version: PACKAGE_VERSION },
      capabilities: { experimentalApi: true },
    }),
    threadStart: jsonRpcRequest(EXPECTED_THREAD_START_ID, "thread/start", {
      model: APP_SERVER_MODEL,
      approvalPolicy: "never",
      permissions: EXPECTED_PERMISSION_PROFILE,
      ephemeral: true,
      cwd,
    }),
    turnStart: (threadId: string) => jsonRpcRequest(EXPECTED_TURN_START_ID, "turn/start", {
      threadId,
      model: APP_SERVER_MODEL,
      effort: APP_SERVER_EFFORT,
      input: [{ type: "text", text: prompt }],
      outputSchema,
    }),
  });
}

export function buildMinimalChildEnvironment(parentEnv: NodeJS.ProcessEnv = process.env, codexHome: string) {
  if (!isAbsolute(codexHome)) throw new TypeError("The child CODEX_HOME must be absolute.");
  const env: Record<string, string> = { CODEX_HOME: codexHome, NO_COLOR: "1" };
  for (const key of ALLOWED_ENV_KEYS) {
    if (key === "HOME") {
      env.HOME = codexHome;
    } else if (typeof parentEnv?.[key] === "string" && parentEnv[key].length <= 4_096) {
      env[key] = parentEnv[key];
    }
  }
  return Object.freeze(env);
}

export function appServerConfigText() {
  return NO_TOOLS_CONFIG;
}

function managedCodexHome() {
  const configured = process.env.CODEX_HOME;
  if (typeof configured === "string" && configured.length > 0 && isAbsolute(configured)) return configured;
  return join(homedir(), ".codex");
}

function executableIdentity(stats: Stats, resolvedPath: string): ExecutableIdentity {
  return {
    path: resolvedPath,
    device: String(stats.dev),
    inode: String(stats.ino),
    size: String(stats.size),
    mtimeMs: String(stats.mtimeMs),
    mode: String(stats.mode),
  };
}

async function inspectCodexExecutable(candidate: string) {
  let linkStats;
  try {
    linkStats = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    fail("reviewer_executable_unavailable", "The pinned Codex executable could not be inspected.");
  }
  let resolvedPath;
  let stats;
  try {
    resolvedPath = await realpath(candidate);
    stats = await stat(resolvedPath);
  } catch {
    fail("reviewer_executable_unavailable", "The pinned Codex executable could not be resolved.");
  }
  if (!linkStats.isFile() && !linkStats.isSymbolicLink()) {
    fail("reviewer_executable_unavailable", "The configured Codex executable is not a file.");
  }
  if (!stats.isFile()) fail("reviewer_executable_unavailable", "The resolved Codex executable is not a regular file.");
  if (process.platform !== "win32" && (stats.mode & fsConstants.S_IXUSR) === 0) {
    fail("reviewer_executable_unavailable", "The resolved Codex executable is not executable.");
  }
  return executableIdentity(stats, resolvedPath);
}

/**
 * Resolve the first absolute PATH entry containing a regular executable and
 * return its identity. The caller then spawns this absolute, pinned path;
 * it never asks the child process to resolve `codex` through PATH.
 */
export async function resolveCodexExecutable(pathValue = process.env.PATH) {
  if (typeof pathValue !== "string" || pathValue.length === 0 || pathValue.length > 16_384) {
    fail("reviewer_executable_unavailable", "The Codex executable PATH was invalid.");
  }
  for (const entry of pathValue.split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    const candidate = join(entry, CODEX_EXECUTABLE_NAME);
    const identity = await inspectCodexExecutable(candidate);
    if (identity !== null) return identity;
  }
  fail("reviewer_executable_unavailable", "The Codex executable was not found in an absolute PATH entry.");
}

async function verifyPinnedCodexExecutable(identity: ExecutableIdentity) {
  const current = await inspectCodexExecutable(identity.path);
  if (current === null || current.path !== identity.path || current.device !== identity.device || current.inode !== identity.inode || current.size !== identity.size || current.mtimeMs !== identity.mtimeMs || current.mode !== identity.mode) {
    fail("reviewer_executable_changed", "The pinned Codex executable changed before launch.");
  }
  return current.path;
}

async function assertManagedAuthFile(sourceHome: string) {
  const authPath = join(sourceHome, MANAGED_AUTH_FILENAME);
  let stats;
  try {
    stats = await lstat(authPath);
  } catch {
    fail("reviewer_auth_missing", "The managed Codex auth file is unavailable.");
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    fail("reviewer_auth_missing", "The managed Codex auth file is not a regular file.");
  }
  return authPath;
}

async function makeTemporaryRuntime() {
  const home = await realpath(await mkdtemp(join(tmpdir(), `${TEMP_DIRECTORY_PREFIX}home-`)));
  const cwd = await realpath(await mkdtemp(join(tmpdir(), `${TEMP_DIRECTORY_PREFIX}cwd-`)));
  try {
    await chmod(home, 0o700);
    await chmod(cwd, 0o700);
    const sourceHome = managedCodexHome();
    const sourceAuth = await assertManagedAuthFile(sourceHome);
    const targetAuth = join(home, MANAGED_AUTH_FILENAME);
    await symlink(sourceAuth, targetAuth);
    await writeFile(join(home, "config.toml"), NO_TOOLS_CONFIG, { encoding: "utf8", mode: 0o600 });
    return { home, cwd, targetAuth };
  } catch (error) {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof AppServerReviewError) throw error;
    fail("reviewer_auth_missing", "The isolated reviewer runtime could not be prepared.");
  }
}

function processGroupSignal(child: ChildProcessWithoutNullStreams | undefined, signal: NodeJS.Signals) {
  if (!child?.pid || !Number.isInteger(child.pid) || child.pid <= 0) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}

function waitForClose(child: ChildProcessWithoutNullStreams | undefined, timeoutMs = CHILD_CLEANUP_TIMEOUT_MS) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolvePromise) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.off?.("close", done);
      child.off?.("error", done);
      resolvePromise();
    };
    const timer = setTimeout(done, timeoutMs);
    child.once?.("close", done);
    child.once?.("error", done);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams | undefined) {
  if (!child) return;
  processGroupSignal(child, "SIGTERM");
  await Promise.race([waitForClose(child, 600), new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 650))]);
  if (child.exitCode === null && child.signalCode === null) processGroupSignal(child, "SIGKILL");
  await waitForClose(child, CHILD_CLEANUP_TIMEOUT_MS);
}

function outputFailureFromChild(error: unknown): never {
  if (error instanceof AppServerReviewError) throw error;
  throw new AppServerReviewError("reviewer_child_failure", "The local reviewer child failed.");
}

function validateRpcResponse(message: unknown, id: number): UnknownRecord {
  if (!isObject(message) || message.id !== id) fail("reviewer_malformed_output", "The app-server response id was invalid.");
  if (Object.hasOwn(message, "error")) {
    const code = isObject(message.error) && typeof message.error.code === "number" && Number.isInteger(message.error.code) ? String(Math.abs(message.error.code)) : "unknown";
    const detail = JSON.stringify(message.error ?? {}).slice(0, 2_000);
    const category = /default_permissions/iu.test(detail)
      ? "defaultprofile"
      : /unknown[^\n]{0,80}profile|profile[^\n]{0,80}(?:missing|not found)/iu.test(detail)
        ? "profilemissing"
        : /extends/iu.test(detail)
          ? "extends"
          : /approval/iu.test(detail)
            ? "approval"
            : /filesystem/iu.test(detail)
              ? "filesystem"
              : /network/iu.test(detail)
                ? "network"
                : /sandbox/iu.test(detail)
                  ? "sandbox"
                  : /model/iu.test(detail)
      ? "model"
      : /permission|profile|sandbox/iu.test(detail)
        ? "permission"
        : /config|toml/iu.test(detail)
          ? "config"
          : /auth|login|account/iu.test(detail)
            ? "auth"
            : /cwd|directory|path/iu.test(detail)
              ? "cwd"
              : "unknown";
    fail(`rpc${id}_${code}_${category}`, "The app-server returned an error.");
  }
  if (!isObject(message.result)) fail("reviewer_malformed_output", "The app-server result was invalid.");
  return message.result;
}

function validateThreadStart(result: UnknownRecord, cwd: string) {
  if (result.model !== APP_SERVER_MODEL) {
    fail("reviewer_thread_model_mismatch", "The app-server selected an unexpected thread model.");
  }
  if (result.approvalPolicy !== "never") {
    fail("reviewer_approval_policy_mismatch", "The app-server selected an unexpected approval policy.");
  }
  if (result.cwd !== cwd || !isObject(result.thread) || result.thread.ephemeral !== true || typeof result.thread.id !== "string") {
    fail("reviewer_malformed_output", "The app-server thread configuration was invalid.");
  }
  const profile = result.activePermissionProfile;
  if (!isObject(profile) || profile.id !== EXPECTED_PERMISSION_PROFILE) {
    fail("reviewer_permission_profile_mismatch", "The app-server did not activate the no-tools profile.");
  }
  if (result.sandbox !== undefined && (!isObject(result.sandbox) || result.sandbox.type !== "readOnly")) {
    fail("reviewer_permission_profile_mismatch", "The app-server reported a non-read-only sandbox.");
  }
  return result.thread.id;
}

function validateTurnStart(result: UnknownRecord) {
  const turn = result.turn;
  if (!isObject(turn) || typeof turn.id !== "string" || typeof turn.status !== "string") {
    fail("reviewer_malformed_output", "The app-server turn response was invalid.");
  }
  if (Object.hasOwn(turn, "items")) {
    if (!Array.isArray(turn.items)) fail("reviewer_malformed_output", "The app-server turn items were invalid.");
    validateItems(turn.items);
  }
  if (turn.status !== "inProgress" && turn.status !== "completed") {
    fail("reviewer_child_failure", "The app-server turn did not start successfully.");
  }
  return turn.id;
}

function diagnosticToken(value: unknown) {
  return typeof value === "string"
    ? value.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 48) || "unknown"
    : "unknown";
}

function validateItem(item: unknown): asserts item is SafeItem {
  if (!isObject(item) || typeof item.type !== "string" || !SAFE_ITEM_TYPES.has(item.type)) {
    fail(`reviewer_unexpected_item_${diagnosticToken(isObject(item) ? item.type : undefined)}`, "The app-server emitted an unexpected item.");
  }
  if (typeof item.id !== "string") fail("reviewer_malformed_output", "The app-server item id was invalid.");
  if (item.type === "agentMessage" && typeof item.text !== "string" && item.text !== undefined) {
    fail("reviewer_malformed_output", "The app-server assistant item text was invalid.");
  }
}

function validateItems(items: unknown): asserts items is SafeItem[] {
  if (!Array.isArray(items)) fail("reviewer_malformed_output", "The app-server turn items were invalid.");
  for (const item of items as unknown[]) validateItem(item);
}

function validateTurnNotification(params: unknown, expectedStatus: string) {
  if (!isObject(params) || typeof params.threadId !== "string" || !isObject(params.turn)) {
    fail("reviewer_malformed_output", "The app-server turn notification was invalid.");
  }
  const turn = params.turn;
  if (typeof turn.id !== "string" || turn.status !== expectedStatus) {
    fail("reviewer_malformed_output", "The app-server turn notification status was invalid.");
  }
  if (Object.hasOwn(turn, "items")) {
    if (!Array.isArray(turn.items)) fail("reviewer_malformed_output", "The app-server turn items were invalid.");
    validateItems(turn.items);
  }
}

function validateThreadSettingsNotification(params: unknown, state: ReviewState) {
  if (!isObject(params) || typeof params.threadId !== "string" || !isObject(params.threadSettings)) {
    fail("reviewer_malformed_output", "The app-server thread settings notification was invalid.");
  }
  const settings = params.threadSettings;
  if (settings.cwd !== state.expectedCwd || settings.model !== APP_SERVER_MODEL || settings.approvalPolicy !== "never") {
    fail("reviewer_model_mismatch", "The app-server thread settings changed unexpectedly.");
  }
  if (!isObject(settings.activePermissionProfile) || settings.activePermissionProfile.id !== EXPECTED_PERMISSION_PROFILE) {
    fail("reviewer_permission_profile_mismatch", "The app-server thread settings did not preserve the no-tools profile.");
  }
  if (!isObject(settings.sandboxPolicy) || settings.sandboxPolicy.type !== "readOnly") {
    fail("reviewer_permission_profile_mismatch", "The app-server thread settings did not preserve a read-only sandbox.");
  }
  if (settings.effort !== null && settings.effort !== undefined && settings.effort !== APP_SERVER_EFFORT) {
    fail("reviewer_effort_mismatch", "The app-server thread settings selected an unexpected reasoning effort.");
  }
  if (settings.effort === APP_SERVER_EFFORT) state.sawExpectedEffort = true;
  if (state.threadId !== null && params.threadId !== state.threadId) {
    fail("reviewer_malformed_output", "The app-server thread settings referenced another thread.");
  }
  state.settingsThreadId = params.threadId;
}

function validateThreadStatusNotification(params: unknown, state: ReviewState) {
  if (!isObject(params) || typeof params.threadId !== "string" || !isObject(params.status)) {
    fail("reviewer_malformed_output", "The app-server thread status notification was invalid.");
  }
  if (params.status.type !== "active" && params.status.type !== "idle") {
    fail("reviewer_child_failure", "The app-server thread entered an unsafe status.");
  }
  if (params.status.type === "active" && !Array.isArray(params.status.activeFlags)) {
    fail("reviewer_malformed_output", "The app-server active thread status was invalid.");
  }
  if (state.threadId !== null && params.threadId !== state.threadId) {
    fail("reviewer_malformed_output", "The app-server status referenced another thread.");
  }
  state.statusThreadId = params.threadId;
}

function validTokenUsageBreakdown(value: unknown) {
  if (!isObject(value)) return false;
  return [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ].every((key) => typeof value[key] === "number" && Number.isSafeInteger(value[key]) && value[key] >= 0);
}

function validateThreadTokenUsageNotification(params: unknown, state: ReviewState) {
  if (
    !isObject(params) ||
    typeof params.threadId !== "string" ||
    typeof params.turnId !== "string" ||
    !isObject(params.tokenUsage) ||
    !validTokenUsageBreakdown(params.tokenUsage.total) ||
    !validTokenUsageBreakdown(params.tokenUsage.last) ||
    (params.tokenUsage.modelContextWindow !== null &&
      (typeof params.tokenUsage.modelContextWindow !== "number" || !Number.isSafeInteger(params.tokenUsage.modelContextWindow) || params.tokenUsage.modelContextWindow <= 0))
  ) {
    fail("reviewer_malformed_output", "The app-server token usage notification was invalid.");
  }
  if (state.threadId !== null && params.threadId !== state.threadId) {
    fail("reviewer_malformed_output", "The app-server token usage referenced another thread.");
  }
  if (state.turnId !== null && params.turnId !== state.turnId) {
    fail("reviewer_malformed_output", "The app-server token usage referenced another turn.");
  }
  state.tokenUsageThreadId = params.threadId;
  state.tokenUsageTurnId = params.turnId;
}

function consumeServerMessage(message: UnknownRecord, state: ReviewState) {
  if (state.turnCompleted) fail("reviewer_unexpected_trailing_output", "The app-server emitted output after terminal completion.");
  if (Object.hasOwn(message, "id")) {
    if (message.id === EXPECTED_INITIALIZE_ID || message.id === EXPECTED_THREAD_START_ID || message.id === EXPECTED_TURN_START_ID) {
      state.responses.set(message.id, message);
      return;
    }
    fail("reviewer_unexpected_tool_item", "The app-server sent an unexpected request response.");
  }
  const method = message.method;
  if (typeof method !== "string" || !SAFE_NOTIFICATION_METHODS.has(method)) {
    fail(`reviewer_unsupported_notification_${diagnosticToken(method)}`, "The app-server emitted an unsupported notification.");
  }
  const params = isObject(message.params) ? message.params : {};
  if (method === "thread/settings/updated") {
    validateThreadSettingsNotification(params, state);
    return;
  }
  if (method === "thread/status/changed") {
    validateThreadStatusNotification(params, state);
    return;
  }
  if (method === "thread/tokenUsage/updated") {
    validateThreadTokenUsageNotification(params, state);
    return;
  }
  if (method === "turn/started") {
    validateTurnNotification(params, "inProgress");
    return;
  }
  if (method === "item/started") {
    validateItem(params.item);
    return;
  }
  if (method === "item/completed") {
    validateItem(params.item);
    if (params.item.type === "agentMessage") {
      if (state.agentMessageCount >= 1) fail("reviewer_malformed_output", "The app-server emitted multiple assistant messages.");
      state.agentMessageCount += 1;
      state.completedAgentText = params.item.text;
      state.agentMessageId = params.item.id;
    }
    return;
  }
  if (method === "item/agentMessage/delta") {
    if (typeof params.itemId !== "string" || typeof params.delta !== "string") {
      fail("reviewer_malformed_output", "The app-server assistant delta was invalid.");
    }
    if (state.agentMessageId !== null && params.itemId !== state.agentMessageId) {
      fail("reviewer_malformed_output", "The app-server assistant item id changed.");
    }
    state.agentMessageId ??= params.itemId;
    state.agentText += params.delta;
    if (Buffer.byteLength(state.agentText, "utf8") > MAX_APP_SERVER_STDOUT_BYTES) {
      fail("reviewer_output_oversize", "The app-server assistant output exceeded the size limit.");
    }
    return;
  }
  if (method === "turn/completed") {
    const turn = params.turn;
    if (!isObject(turn) || turn.status !== "completed" || (turn.error !== null && turn.error !== undefined)) {
      fail("reviewer_child_failure", "The app-server turn did not complete successfully.");
    }
    if (Object.hasOwn(turn, "items")) {
      if (!Array.isArray(turn.items)) fail("reviewer_malformed_output", "The app-server completed turn items were invalid.");
      validateItems(turn.items);
      const agentItems = turn.items.filter((item) => item.type === "agentMessage");
      if (agentItems.length !== 1) fail("reviewer_malformed_output", "The app-server turn did not contain one assistant message.");
      const item = agentItems[0]!;
      if (state.agentMessageCount === 0) {
        state.agentMessageCount = 1;
        state.agentMessageId = item.id;
        state.completedAgentText = item.text;
      } else if (state.completedAgentText !== item.text) {
        fail("reviewer_malformed_output", "The app-server assistant output was inconsistent.");
      }
    }
    state.turnCompleted = true;
  }
}

async function writeRequest(child: ChildProcessWithoutNullStreams, request: object) {
  const line = `${boundedJson(request)}\n`;
  if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
    fail("reviewer_child_failure", "The app-server input stream was unavailable.");
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = () => rejectPromise(new AppServerReviewError("reviewer_child_failure", "The app-server input stream failed."));
    child.stdin.once("error", onError);
    child.stdin.write(line, "utf8", (error) => {
      child.stdin.off("error", onError);
      if (error) rejectPromise(new AppServerReviewError("reviewer_child_failure", "The app-server input stream failed."));
      else resolvePromise();
    });
  }).catch(outputFailureFromChild);
}

async function waitForResponse(state: ReviewState, id: number, readerPromise: Promise<void>, childError: Promise<never>, abortPromise: Promise<never>) {
  while (!state.responses.has(id)) {
    const readerOutcome = readerPromise.then(() => {
      if (!state.responses.has(id)) fail("reviewer_malformed_output", "The app-server completed without the expected response.");
    });
    await Promise.race([
      new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5)),
      readerOutcome,
      childError,
      abortPromise,
    ]);
  }
}

function waitForChildTermination(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (error: Error | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off?.("close", onClose);
      child.off?.("error", onError);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const onClose = () => finish();
    const onError = () => finish(new AppServerReviewError("reviewer_child_failure", "The app-server child failed during drain."));
    const timer = setTimeout(() => finish(new AppServerReviewError("reviewer_timeout", "The app-server did not terminate after review.")), timeoutMs);
    child.once?.("close", onClose);
    child.once?.("error", onError);
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
}

async function runReader(child: ChildProcessWithoutNullStreams, state: ReviewState, timeoutMs: number) {
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stderrExceeded = false;
  let deadlineReached = false;
  const startedAt = Date.now();
  const onStderrData = (chunk: Buffer) => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > MAX_APP_SERVER_STDERR_BYTES) stderrExceeded = true;
  };
  child.stderr?.on("data", onStderrData);
  const timer = setTimeout(() => {
    deadlineReached = true;
    child.stdout?.destroy?.();
  }, timeoutMs);
  try {
    for await (const line of readBoundedLines(child.stdout)) {
      if (line === null) fail("reviewer_output_oversize", "The app-server line exceeded the size limit.");
      stdoutBytes += Buffer.byteLength(line, "utf8") + 1;
      if (stdoutBytes > MAX_APP_SERVER_STDOUT_BYTES) fail("reviewer_output_oversize", "The app-server output exceeded the size limit.");
      consumeServerMessage(parseLine(line), state);
      if (state.turnCompleted && !child.stdin?.writableEnded) {
        try {
          child.stdin?.end?.();
        } catch {
          fail("reviewer_child_failure", "The app-server input stream could not be closed for drain.");
        }
      }
    }
    if (state.turnCompleted) {
      const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
      await waitForChildTermination(child, remainingMs);
    }
  } catch (error) {
    child.stderr?.off?.("data", onStderrData);
    if (deadlineReached) fail("reviewer_timeout", "The app-server did not complete before the timeout.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
  child.stderr?.off?.("data", onStderrData);
  if (deadlineReached) fail("reviewer_timeout", "The app-server did not complete before the timeout.");
  if (stderrExceeded) fail("reviewer_output_oversize", "The app-server diagnostics exceeded the size limit.");
  if (!state.turnCompleted) fail("reviewer_timeout", "The app-server did not complete before the timeout.");
}

/**
 * Run one isolated, no-tools app-server review. The proposed action is never
 * passed to a shell or executed; only the bounded reviewer prompt is sent as
 * text input to the child.
 *
 * @param {string} prompt
 * @param {{signal?: AbortSignal, timeoutMs?: number, outputSchema: object}} options
 * @returns {Promise<string>}
 */
export function runCodexAppServer(prompt: string, options: AppServerOptions): Promise<string>;
export async function runCodexAppServer(prompt: unknown, options: Partial<AppServerOptions> = {}): Promise<string> {
  if (typeof prompt !== "string" || prompt.length === 0 || Buffer.byteLength(prompt, "utf8") > MAX_APP_SERVER_STDOUT_BYTES) {
    throw new AppServerReviewError("reviewer_prompt_oversize", "The reviewer prompt was invalid.");
  }
  if (!isObject(options.outputSchema)) throw new AppServerReviewError("reviewer_malformed_output", "The reviewer output schema was invalid.");
  if (options.signal?.aborted) throw new AppServerReviewError("reviewer_cancelled", "The reviewer was cancelled.");
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs ?? DEFAULT_APP_SERVER_TIMEOUT_MS), 1), MAX_APP_SERVER_TIMEOUT_MS);
  const runtime = await makeTemporaryRuntime();
  let child: ChildProcessWithoutNullStreams | undefined;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    const baseEnv = buildMinimalChildEnvironment(process.env, runtime.home);
    const pinnedExecutable = await resolveCodexExecutable(baseEnv.PATH);
    const executablePath = await verifyPinnedCodexExecutable(pinnedExecutable);
    const env = Object.freeze({ ...baseEnv, PATH: dirname(executablePath) });
    child = spawn(executablePath, ["app-server"], {
      cwd: runtime.cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const state: ReviewState = {
      responses: new Map(),
      agentMessageCount: 0,
      agentMessageId: null,
      agentText: "",
      completedAgentText: null,
      turnCompleted: false,
      expectedCwd: runtime.cwd,
      threadId: null,
      settingsThreadId: null,
      statusThreadId: null,
      turnId: null,
      tokenUsageThreadId: null,
      tokenUsageTurnId: null,
      sawExpectedEffort: false,
    };
    const childError = new Promise<never>((_, rejectPromise) => child!.once("error", () => rejectPromise(new AppServerReviewError("reviewer_child_failure", "The app-server child failed."))));
    childError.catch(() => undefined);
    const abortPromise = new Promise<never>((_, rejectPromise) => {
      if (controller.signal.aborted) rejectPromise(new AppServerReviewError("reviewer_cancelled", "The reviewer was cancelled."));
      else controller.signal.addEventListener("abort", () => rejectPromise(new AppServerReviewError("reviewer_cancelled", "The reviewer was cancelled.")), { once: true });
    });
    abortPromise.catch(() => undefined);
    const requests = buildAppServerRequests({ cwd: runtime.cwd, prompt, outputSchema: options.outputSchema });
    const readerPromise = runReader(child, state, timeoutMs);
    await writeRequest(child, requests.initialize);
    await waitForResponse(state, EXPECTED_INITIALIZE_ID, readerPromise, childError, abortPromise);
    const initialize = validateRpcResponse(state.responses.get(EXPECTED_INITIALIZE_ID), EXPECTED_INITIALIZE_ID);
    if (typeof initialize.userAgent !== "string" || !/codex/iu.test(initialize.userAgent)) {
      fail("reviewer_executable_mismatch", "The app-server did not identify itself as Codex.");
    }
    if (initialize.codexHome !== runtime.home) {
      fail("reviewer_codex_home_mismatch", "The app-server did not use the isolated Codex home.");
    }
    await writeRequest(child, requests.threadStart);
    await waitForResponse(state, EXPECTED_THREAD_START_ID, readerPromise, childError, abortPromise);
    const threadId = validateThreadStart(validateRpcResponse(state.responses.get(EXPECTED_THREAD_START_ID), EXPECTED_THREAD_START_ID), runtime.cwd);
    if (state.settingsThreadId !== null && state.settingsThreadId !== threadId) {
      fail("reviewer_malformed_output", "The app-server thread settings referenced another thread.");
    }
    if (state.statusThreadId !== null && state.statusThreadId !== threadId) {
      fail("reviewer_malformed_output", "The app-server status referenced another thread.");
    }
    state.threadId = threadId;
    await writeRequest(child, requests.turnStart(threadId));
    await waitForResponse(state, EXPECTED_TURN_START_ID, readerPromise, childError, abortPromise);
    const turnId = validateTurnStart(validateRpcResponse(state.responses.get(EXPECTED_TURN_START_ID), EXPECTED_TURN_START_ID));
    if (state.tokenUsageThreadId !== null && state.tokenUsageThreadId !== threadId) {
      fail("reviewer_malformed_output", "The app-server token usage referenced another thread.");
    }
    if (state.tokenUsageTurnId !== null && state.tokenUsageTurnId !== turnId) {
      fail("reviewer_malformed_output", "The app-server token usage referenced another turn.");
    }
    state.turnId = turnId;
    await readerPromise;
    if (!state.sawExpectedEffort) fail("reviewer_effort_mismatch", "The app-server did not prove the requested reasoning effort.");
    if (state.agentMessageCount !== 1 || typeof state.completedAgentText !== "string") fail("reviewer_malformed_output", "The app-server did not produce one assistant message.");
    if (state.agentText && state.agentText !== state.completedAgentText) fail("reviewer_malformed_output", "The app-server assistant deltas did not match the final item.");
    return state.completedAgentText;
  } catch (error) {
    if (error instanceof AppServerReviewError) throw error;
    throw new AppServerReviewError("reviewer_child_failure", "The local reviewer did not complete safely.");
  } finally {
    options.signal?.removeEventListener?.("abort", onAbort);
    controller.abort();
    if (child) await stopChild(child);
    await rm(runtime.home, { recursive: true, force: true }).catch(() => undefined);
    await rm(runtime.cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * A metadata-only auth check used before prompt construction. It checks only
 * path type and never opens or reads auth.json.
 */
export async function managedAuthAvailable() {
  try {
    await assertManagedAuthFile(managedCodexHome());
    return true;
  } catch (error) {
    if (error instanceof AppServerReviewError && error.hazard === "reviewer_auth_missing") return false;
    return false;
  }
}
