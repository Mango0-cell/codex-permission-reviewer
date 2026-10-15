import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { NormalizedAction, Review, FileVerification } from "../action/types.js";
import { hasNonOverridableCommandSignal, hasUnlearnableCommandMutation } from "./command-signals.js";
import { O_NOFOLLOW, O_RDONLY } from "node:constants";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, delimiter, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { TRUSTED_ROOTS_ENV, MAX_WORKSPACE_ROOT_LENGTH, MAX_WORKSPACE_ROOTS, MAX_SAFE_READ_TARGETS, MAX_SAFE_READ_SAMPLE_BYTES } from '../config.js';
import { isCanonicalAction, normalizeActionForReview } from '../action/metadata.js';
import { sanitizeReviewOutput } from '../action/review-result.js';

const SAFE_READ_EXTENSIONS = new Set([
  ".adoc",
  ".cjs",
  ".css",
  ".go",
  ".graphql",
  ".hbs",
  ".htm",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".rst",
  ".sql",
  ".scss",
  ".swift",
  ".tex",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
]);

const SAFE_READ_BASENAMES = new Set([
  "changelog",
  "code_of_conduct",
  "contributing",
  "license",
  "notice",
  "readme",
  "security",
]);

const SENSITIVE_PATH_COMPONENTS = new Set([
  ".aws",
  ".azure",
  ".buildkite",
  ".circleci",
  ".codex",
  ".config",
  ".docker",
  ".git",
  ".github",
  ".gitlab",
  ".gnupg",
  ".idea",
  ".kube",
  ".netrc",
  ".npm",
  ".npmrc",
  ".ssh",
  ".terraform",
  ".venv",
  ".vscode",
  "appdata",
  "browser",
  "browsers",
  "cloud",
  "config",
  "credential",
  "credentials",
  "gcloud",
  "keychain",
  "keychains",
  "kube",
  "kubernetes",
  "library",
  "node_modules",
  "passwords",
  "profile",
  "profiles",
  "secrets",
  "session",
  "tokens",
  "vendor",
  "venv",
  "workflows",
]);

const AMBIGUITY_SIGNAL = /\b(?:ambiguous|guess|maybe|possibly|probably|uncertain|unclear|unknown|unsure|might|could\s+be|not\s+sure|best\s+effort)\b/iu;
const MUTATION_SIGNAL = /\b(?:alter|apply|chmod|chown|commit|create|delete|deploy|drop|edit|execute|force\s+push|install|kill|modify|move|mutate|mutation|patch|post|put|remove|rename|restart|run|send|truncate|uninstall|update|write|writes)\b/iu;
const HIGH_SENSITIVITY_SIGNAL = /\b(?:prod(?:uction)?|staging|external|network|internet|download|upload|curl|wget|ssh|scp|secret|secrets|credential|credentials|password|passwd|token|api[\s_-]*key|private[\s_-]*key|auth(?:entication|orization)?|permission|permissions|privilege|sudo|root|admin|acl|grant|revoke|deploy|deployment|release|database|db|schema|data[\s_-]*repair|repair|migration|drop|truncate|delete|destroy|force\s+push|history\s+rewrite|execute|execution|spawn|shell|install|uninstall|send|post|put|patch|webhook|mutation|write|writes|modify|create|remove|rename|restart|kill)\b/iu;

function broadFileTarget(target: string, cwd: string) {
  const trimmed = target.trim();
  if (!trimmed || trimmed.length < 2) return true;
  if (/[*?\[\]{}]/u.test(trimmed)) return true;
  if (/[/\\]$/u.test(trimmed)) return true;
  if (/^(?:[.]{1,2}|~)(?:[/\\])?$/u.test(trimmed)) return true;
  if (/^(?:\/|[A-Za-z]:[/\\]?)$/u.test(trimmed)) return true;
  try {
    if (resolve(cwd, trimmed) === resolve(cwd)) return true;
  } catch {
    return true;
  }
  return false;
}

function sensitiveFileTarget(target: string) {
  const components = target.split(/[\\/]+/u).filter(Boolean).map((component) => component.toLocaleLowerCase());
  const base = components.at(-1) ?? "";
  if (components.some((component) => component.startsWith(".env") || SENSITIVE_PATH_COMPONENTS.has(component))) return true;
  if (components.some((component) => /(?:config|settings|secret|credential|password|token|api[_-]?key|private[_-]?key|keychain|auth|profile|browser|cloud|kube)/iu.test(component))) return true;
  return /(?:\.pem|\.key|\.p12|\.pfx|\.kdbx|\.mobileprovision|\.netrc|\.npmrc|\.gpg|\.age|\.sqlite|\.db)$/iu.test(base);
}

function safeReadExtension(target: string) {
  const base = basename(target).toLocaleLowerCase();
  const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  return SAFE_READ_BASENAMES.has(base) || SAFE_READ_BASENAMES.has(stem) || SAFE_READ_EXTENSIONS.has(extname(base));
}

function actionTextFields(action: NormalizedAction): [string, string][] {
  return ([
    ["operationKind", action.operationKind],
    ["command", action.command],
    ["cwd", action.cwd],
    ["reason", action.reason],
    ["reversibility", action.reversibility],
    ...(action.workspaceRoots ?? []).map((value, index) => [`workspaceRoots[${index}]`, value]),
    ...(action.fileTargets ?? []).map((value, index) => [`fileTargets[${index}]`, value]),
    ...(action.sideEffects ?? []).map((value, index) => [`sideEffects[${index}]`, value]),
    ...(action.network?.details ?? []).map((value, index) => [`network.details[${index}]`, value]),
    ...(action.externalSystem?.details ?? []).map((value, index) => [`externalSystem.details[${index}]`, value]),
    ...(action.sensitiveData?.details ?? []).map((value, index) => [`sensitiveData.details[${index}]`, value]),
  ] as [string, string | undefined][]).filter((entry): entry is [string, string] => typeof entry[1] === "string");
}

function textSignals(action: NormalizedAction) {
  const values = actionTextFields(action).map(([, value]) => value);
  // Risk narration ("this could affect one row") is not uncertainty about the
  // action's scope. Let the model assess that context without an automatic veto.
  const ambiguity = actionTextFields(action)
    .filter(([field]) => field !== "reason" && !field.startsWith("sideEffects["))
    .some(([, value]) => AMBIGUITY_SIGNAL.test(value));
  const mutation = values.some((value) => MUTATION_SIGNAL.test(value));
  return { ambiguity, mutation };
}

export function deterministicHighSensitivityHazards(action: NormalizedAction) {
  const hazards = [];
  for (const [field, value] of actionTextFields(action)) {
    if (HIGH_SENSITIVITY_SIGNAL.test(value)) hazards.push(`high-sensitivity signal in ${field}`);
  }
  if (action.network?.involved) hazards.push("network access is involved");
  if (action.externalSystem?.involved) hazards.push("an external system is involved");
  if (action.sensitiveData?.involved) hazards.push("sensitive data is involved");
  return [...new Set(hazards)];
}

function broadWorkspaceRoot(root: string) {
  const trimmed = root.trim();
  if (!trimmed || /[*?\[\]{}]/u.test(trimmed) || /(?:^|[/\\])\.git(?:[/\\]|$)/iu.test(trimmed)) return true;
  try {
    const normalized = resolve(trimmed);
    return normalized === resolve(normalized, "..");
  } catch {
    return true;
  }
}

function pathIsWithin(root: string, candidate: string) {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

async function verifiedRealPath(path: string, expectDirectory = false, rejectFinalSymlink = false) {
  if (!isAbsolute(path)) return null;
  try {
    const stats = await lstat(path);
    if (rejectFinalSymlink && stats.isSymbolicLink()) return null;
    if (expectDirectory && !stats.isDirectory()) return null;
    return await realpath(path);
  } catch {
    return null;
  }
}

async function configuredTrustedWorkspaceRoots() {
  const raw = process.env[TRUSTED_ROOTS_ENV];
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  const configured = raw.split(delimiter).map((root) => root.trim()).filter(Boolean);
  if (configured.length === 0 || configured.length > MAX_WORKSPACE_ROOTS) return [];
  const resolvedRoots: string[] = [];
  for (const root of configured) {
    if (root.length > MAX_WORKSPACE_ROOT_LENGTH || !isAbsolute(root) || broadWorkspaceRoot(root) || sensitiveFileTarget(root)) continue;
    const realRoot = await verifiedRealPath(root, true);
    if (realRoot && !resolvedRoots.includes(realRoot)) resolvedRoots.push(realRoot);
  }
  return resolvedRoots;
}

export function sameFileIdentity(precheckStats: Stats | null | undefined, openedStats: Stats | null | undefined) {
  if (!precheckStats || !openedStats) return false;
  if (!Number.isInteger(precheckStats.mode) || !Number.isInteger(openedStats.mode)) return false;
  return String(precheckStats.dev) === String(openedStats.dev) &&
    String(precheckStats.ino) === String(openedStats.ino) &&
    (precheckStats.mode & 0o170000) === (openedStats.mode & 0o170000);
}

async function appearsBinaryOrUnreadable(handle: FileHandle) {
  try {
    const sample = Buffer.alloc(MAX_SAFE_READ_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    return sample.subarray(0, bytesRead).includes(0);
  } catch {
    return true;
  }
}

/**
 * Verify a read using the filesystem rather than trusting caller-supplied
 * cwd, roots, target strings, or reversibility. This is an advisory snapshot;
 * callers must still re-check authorization and the filesystem at execution.
 * @param {object} action
 * @returns {Promise<{verified: boolean, hazards: string[]}>}
 */
export async function verifySafeRead(action: unknown): Promise<FileVerification> {
  const normalizedAction = isCanonicalAction(action) ? action : normalizeActionForReview(action);
  if (
    !normalizedAction ||
    !Array.isArray(normalizedAction.sideEffects) ||
    !Array.isArray(normalizedAction.fileTargets) ||
    typeof normalizedAction.cwd !== "string" ||
    typeof normalizedAction.reversibility !== "string" ||
    typeof normalizedAction.network?.involved !== "boolean" ||
    typeof normalizedAction.externalSystem?.involved !== "boolean" ||
    typeof normalizedAction.sensitiveData?.involved !== "boolean"
  ) {
    return { verified: false, hazards: ["invalid action metadata"] };
  }
  const safeAction = normalizedAction;
  const hazards = [];
  hazards.push(...deterministicHighSensitivityHazards(safeAction));
  if (safeAction.operationKind !== "file_read") hazards.push("only file reads can be automatically allowed");
  if (safeAction.command) hazards.push("a command is present");
  if (safeAction.network.involved) hazards.push("network access is involved");
  if (safeAction.externalSystem.involved) hazards.push("an external system is involved");
  if (safeAction.sensitiveData.involved) hazards.push("sensitive data is involved");
  if (safeAction.sideEffects.length > 0) hazards.push("side effects were declared");
  if (safeAction.reversibility !== "reversible") hazards.push("reversibility is not exactly reversible");
  const signals = textSignals(safeAction);
  if (signals.ambiguity) hazards.push("metadata contains uncertainty or ambiguity");
  if (signals.mutation) hazards.push("metadata contains a mutation signal");
  if (!Array.isArray(safeAction.workspaceRoots) || safeAction.workspaceRoots.length === 0) hazards.push("workspace roots were not declared");
  if (!Array.isArray(safeAction.fileTargets) || safeAction.fileTargets.length === 0) hazards.push("exact read targets were not declared");
  if ((safeAction.fileTargets?.length ?? 0) > MAX_SAFE_READ_TARGETS) hazards.push("the read target set is broad");
  for (const target of safeAction.fileTargets ?? []) {
    if (broadFileTarget(target, safeAction.cwd)) hazards.push("a read target is broad or ambiguous");
    if (sensitiveFileTarget(target)) hazards.push("a read target may contain credentials or secrets");
    if (!safeReadExtension(target)) hazards.push("a read target is not on the safe text-file allowlist");
  }
  if (hazards.length > 0) return { verified: false, hazards: [...new Set(hazards)] };

  const rootRealPaths = await configuredTrustedWorkspaceRoots();
  if (rootRealPaths.length === 0) return { verified: false, hazards: ["trusted workspace roots are not configured"] };
  const cwdReal = await verifiedRealPath(safeAction.cwd, true, true);
  if (!cwdReal) hazards.push("the working directory could not be verified without symlinks");
  if (cwdReal && !rootRealPaths.some((root) => pathIsWithin(root, cwdReal))) hazards.push("the working directory is outside declared workspace roots");

  for (const target of safeAction.fileTargets ?? []) {
    const targetPath = isAbsolute(target) ? resolve(target) : resolve(safeAction.cwd, target);
    const targetReal = await verifiedRealPath(targetPath, false, true);
    if (!targetReal) {
      hazards.push("a read target could not be verified as a non-symlink file");
      continue;
    }
    let stats;
    try {
      stats = await lstat(targetPath);
    } catch {
      stats = null;
    }
    if (!stats?.isFile()) hazards.push("a read target is not a regular file");
    if (stats?.isFile() && (stats.mode & 0o111) !== 0) hazards.push("a read target is executable");
    if (!rootRealPaths.some((root) => pathIsWithin(root, targetReal))) {
      hazards.push("a read target is outside declared workspace roots");
      continue;
    }
    if (!stats?.isFile() || (stats.mode & 0o111) !== 0) continue;
    if (!Number.isInteger(O_NOFOLLOW) || O_NOFOLLOW <= 0) {
      hazards.push("no-follow file opening is unsupported");
      continue;
    }
    let handle;
    try {
      handle = await open(targetPath, O_RDONLY | O_NOFOLLOW);
      if (typeof handle.stat !== "function" || typeof handle.read !== "function") {
        hazards.push("no-follow file descriptor inspection is unsupported");
        continue;
      }
      const openedStats = await handle.stat();
      if (!sameFileIdentity(stats, openedStats) || !openedStats.isFile?.()) {
        hazards.push("the read target changed before the no-follow descriptor was opened");
        continue;
      }
      const currentStats = await lstat(targetPath);
      const currentReal = await verifiedRealPath(targetPath, false, true);
      if (!sameFileIdentity(openedStats, currentStats) || !currentReal || !rootRealPaths.some((root) => pathIsWithin(root, currentReal))) {
        hazards.push("the read target changed or left the trusted root during verification");
        continue;
      }
      if (await appearsBinaryOrUnreadable(handle)) hazards.push("a read target appears binary or unreadable");
    } catch {
      hazards.push("the read target could not be opened with no-follow read-only semantics");
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          hazards.push("the no-follow read descriptor could not be closed");
        }
      }
    }
  }
  return { verified: hazards.length === 0, hazards: [...new Set(hazards)] };
}

function deterministicRiskForNonRead(action: NormalizedAction) {
  const hazards = [];
  if (action.operationKind !== "file_read") hazards.push("the operation is not a verified read");
  if (action.operationKind === "file_write") hazards.push("writes are never automatically allowed");
  if (action.reversibility !== "reversible") hazards.push("reversibility is not exactly reversible");
  if (action.network.involved) hazards.push("network access is involved");
  if (action.externalSystem.involved) hazards.push("an external system is involved");
  if (action.sensitiveData.involved) hazards.push("sensitive data is involved");
  if (["file_delete", "file_move", "schema_change", "data_repair", "permission_change", "credential_change", "deployment", "history_rewrite"].includes(action.operationKind)) {
    hazards.push("the operation can cause a destructive, external, or authorization-sensitive mutation");
  }
  hazards.push(...deterministicHighSensitivityHazards(action));
  const signals = textSignals(action);
  if (signals.ambiguity) hazards.push("metadata contains uncertainty or ambiguity");
  if (signals.mutation) hazards.push("metadata contains a mutation signal");
  return [...new Set(hazards)];
}

const NEVER_LEARN_OPERATION_KINDS = new Set([
  "file_delete",
  "database",
  "schema_change",
  "data_repair",
  "permission_change",
  "credential_change",
  "process_spawn",
  "history_rewrite",
  "other",
]);

export function explicitAuthorizationBlockers(action: NormalizedAction) {
  const blockers = [];
  if (action.userAuthorization !== "explicit") blockers.push("the user did not explicitly authorize this exact action");
  if (action.command && hasNonOverridableCommandSignal(action.command)) {
    blockers.push("the command contains a catastrophic, broad, or history-destructive signal");
  }
  if (action.network.involved && action.network.details.length === 0) blockers.push("network destinations are not exact");
  if (action.externalSystem.involved && action.externalSystem.details.length === 0) blockers.push("external systems are not exact");
  if (textSignals(action).ambiguity) blockers.push("metadata contains uncertainty or ambiguity");
  for (const target of action.fileTargets ?? []) {
    if (broadFileTarget(target, action.cwd)) blockers.push("a file target is broad or ambiguous");
    if (sensitiveFileTarget(target)) blockers.push("a file target may contain credentials or secrets");
  }
  return [...new Set(blockers)];
}

export function learnedApprovalBlockers(action: NormalizedAction) {
  const blockers = explicitAuthorizationBlockers({ ...action, userAuthorization: "explicit" });
  if (action.command && hasUnlearnableCommandMutation(action.command)) {
    blockers.push("known file or row mutations require fresh review and are never learned");
  }
  if (action.reversibility !== "reversible") blockers.push("non-reversible approvals are never learned");
  if (action.sensitiveData.involved) blockers.push("sensitive-data approvals are never learned");
  if (NEVER_LEARN_OPERATION_KINDS.has(action.operationKind)) blockers.push("this sensitive operation category requires fresh confirmation");
  return [...new Set(blockers)];
}

export async function applyDeterministicPolicy(review: Review, action: NormalizedAction): Promise<Review> {
  const safeReview = sanitizeReviewOutput(review);
  if (safeReview.verdict !== "allow") return safeReview;
  if (action.userAuthorization === "explicit") {
    const blockers = explicitAuthorizationBlockers(action);
    if (blockers.length === 0) {
      return {
        verdict: "allow",
        riskLevel: safeReview.riskLevel === "low" ? "medium" : safeReview.riskLevel,
        rationale: "The user explicitly authorized this exact action, and deterministic policy found no non-overridable hazard.",
        detectedHazards: safeReview.detectedHazards,
        saferAlternative: safeReview.saferAlternative,
      };
    }
    return {
      verdict: "deny",
      riskLevel: blockers.some((blocker) => /critical|sensitive data|destructive|privilege|category/iu.test(blocker)) ? "critical" : "high",
      rationale: "Explicit user authorization cannot override a catastrophic, broad, history-destructive, or ambiguous safety boundary.",
      detectedHazards: [...new Set([...safeReview.detectedHazards, ...blockers])],
      saferAlternative: safeReview.saferAlternative || "Narrow the action or use the system's dedicated recovery and approval workflow.",
    };
  }
  const highSensitivityHazards = deterministicHighSensitivityHazards(action);
  if (highSensitivityHazards.length > 0 || action.operationKind !== "file_read") {
    const blockers = explicitAuthorizationBlockers({ ...action, userAuthorization: "explicit" });
    const confirmable = blockers.length === 0;
    return {
      verdict: confirmable ? "needs_user" : "deny",
      riskLevel: "high",
      rationale: confirmable
        ? "This exact action requires user authorization followed by a fresh model review."
        : "The action has a deterministic boundary that explicit authorization cannot override.",
      detectedHazards: [...new Set([...safeReview.detectedHazards, ...highSensitivityHazards, ...deterministicRiskForNonRead(action), ...blockers])],
      saferAlternative: confirmable
        ? "Ask the user to approve this exact action, then submit a fresh review with userAuthorization set to explicit."
        : safeReview.saferAlternative || "Narrow the action and resolve its non-overridable hazards.",
    };
  }
  const verification = await verifySafeRead(action);
  if (safeReview.riskLevel === "low" && safeReview.detectedHazards.length === 0 && verification.verified) return safeReview;
  const hazards = [
    "model allow was not accepted by deterministic safety policy",
    ...verification.hazards,
  ];
  return {
    verdict: verification.hazards.some((hazard) => /secret|network|external|broad|sensitive/iu.test(hazard)) ? "deny" : "needs_user",
    riskLevel: verification.hazards.length > 0 ? "medium" : "high",
    rationale: "The read was not independently verified as a narrow, safe workspace read; user confirmation is required.",
    detectedHazards: [...new Set(hazards)],
    saferAlternative: safeReview.saferAlternative || "Confirm the real path and declared workspace root before reading.",
  };
}
