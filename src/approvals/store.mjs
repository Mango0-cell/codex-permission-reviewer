import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { LEARNED_APPROVAL_TTL_MS, MAX_LEARNED_APPROVALS, LEARNED_APPROVAL_POLICY_VERSION, LEARNED_APPROVAL_STATE_FILENAME } from '../config.mjs';
import { isPlainObject, canonicalActionJson } from '../action/metadata.mjs';

function learnedApprovalSha256(action) {
  return createHash("sha256")
    .update(`policy:${LEARNED_APPROVAL_POLICY_VERSION}:`)
    .update(canonicalActionJson({ ...action, userAuthorization: "none" }), "utf8")
    .digest("hex");
}

function learnedApprovalStatePath() {
  const configuredHome = process.env.CODEX_HOME;
  const codexHome = typeof configuredHome === "string" && isAbsolute(configuredHome)
    ? configuredHome
    : join(homedir(), ".codex");
  return join(codexHome, "plugin-state", "codex-permission-reviewer", LEARNED_APPROVAL_STATE_FILENAME);
}

async function readLearnedApprovals() {
  let raw;
  try {
    raw = await readFile(learnedApprovalStatePath(), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) throw new Error("learned approval state exceeded the size limit");
  const parsed = JSON.parse(raw);
  if (!isPlainObject(parsed) || parsed.version !== LEARNED_APPROVAL_POLICY_VERSION || !Array.isArray(parsed.approvals)) {
    throw new Error("learned approval state was invalid");
  }
  return parsed.approvals
    .filter((entry) => isPlainObject(entry) && /^[a-f0-9]{64}$/u.test(entry.digest) && Number.isFinite(entry.expiresAtMs))
    .slice(-MAX_LEARNED_APPROVALS);
}

export async function hasLearnedApproval(action) {
  const digest = learnedApprovalSha256(action);
  const now = Date.now();
  const approvals = await readLearnedApprovals();
  return approvals.some((entry) => entry.digest === digest && entry.expiresAtMs > now);
}

export async function rememberLearnedApproval(action) {
  const statePath = learnedApprovalStatePath();
  const now = Date.now();
  const digest = learnedApprovalSha256(action);
  let approvals = [];
  try {
    approvals = await readLearnedApprovals();
  } catch {
    approvals = [];
  }
  approvals = approvals.filter((entry) => entry.expiresAtMs > now && entry.digest !== digest);
  approvals.push({ digest, approvedAtMs: now, expiresAtMs: now + LEARNED_APPROVAL_TTL_MS });
  approvals = approvals.slice(-MAX_LEARNED_APPROVALS);
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await writeFile(statePath, `${JSON.stringify({ version: LEARNED_APPROVAL_POLICY_VERSION, approvals })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(statePath, 0o600);
}

