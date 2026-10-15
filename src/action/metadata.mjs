import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { MAX_PROMPT_CHARS, MAX_OPERATION_KIND_LENGTH, MAX_COMMAND_LENGTH, MAX_CWD_LENGTH, MAX_REASON_LENGTH, MAX_SIDE_EFFECT_LENGTH, MAX_FILE_TARGET_LENGTH, MAX_WORKSPACE_ROOT_LENGTH, MAX_FLAG_DETAIL_LENGTH, MAX_SIDE_EFFECTS, MAX_FILE_TARGETS, MAX_WORKSPACE_ROOTS, MAX_FLAG_DETAILS, MAX_CANONICAL_ACTION_BYTES } from '../config.mjs';
import { OPERATION_KINDS, REVERSIBILITY_VALUES, USER_AUTHORIZATION_VALUES, ACTION_KEYS, FLAG_KEYS, REVIEWER_INSTRUCTIONS } from './contracts.mjs';

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pushUnknownKeys(value, allowedKeys, prefix, errors) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) errors.push(`${prefix} contains unsupported field '${redactSecrets(key)}'.`);
  }
}

function validateString(value, field, maxLength, errors) {
  if (typeof value !== "string") {
    errors.push(`${field} must be a string.`);
    return null;
  }
  if (value.trim().length === 0) errors.push(`${field} must not be empty.`);
  if (value.length > maxLength) errors.push(`${field} exceeds the ${maxLength}-character limit.`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    errors.push(`${field} contains unsupported control characters.`);
  }
  return value;
}

function validateStringArray(value, field, maxItems, itemMaxLength, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array.`);
    return [];
  }
  if (value.length > maxItems) errors.push(`${field} has more than ${maxItems} items.`);
  const normalized = [];
  for (let index = 0; index < value.length && index < maxItems; index += 1) {
    const item = validateString(value[index], `${field}[${index}]`, itemMaxLength, errors);
    if (item !== null) normalized.push(item);
  }
  return normalized;
}

function normalizeFlag(value, field, detailKey, errors) {
  if (typeof value === "boolean") return { involved: value, details: [] };
  if (!isPlainObject(value)) {
    errors.push(`${field} must be a boolean or an object.`);
    return { involved: false, details: [] };
  }
  const allowed = new Set(["involved", detailKey]);
  pushUnknownKeys(value, allowed, field, errors);
  if (typeof value.involved !== "boolean") errors.push(`${field}.involved must be a boolean.`);
  const details = value[detailKey] === undefined
    ? []
    : validateStringArray(
        value[detailKey],
        `${field}.${detailKey}`,
        MAX_FLAG_DETAILS,
        MAX_FLAG_DETAIL_LENGTH,
        errors,
      );
  if (value.involved !== true && details.length > 0) {
    errors.push(`${field} cannot include details when involved is false.`);
  }
  return { involved: value.involved === true, details };
}

export function boundedText(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 14))}...[truncated]`;
}

const SAFE_SECRET_PLACEHOLDER = /^(?:\[?redacted(?:_[a-z]+)?\]?|<redacted>|\*{3,}|x{3,}|\$\{?[A-Z_][A-Z0-9_]*\}?|%[A-Z_][A-Z0-9_]*%|(?:vault|secret[- ]?store|keychain|credential[- ]?store))$/iu;

function isSecretPlaceholder(value) {
  return SAFE_SECRET_PLACEHOLDER.test(value.trim());
}

function redactAssignmentValues(text) {
  return text.replace(
    /((?:^|[\s;&|])(?:export\s+)?(?:(?:[A-Za-z_][A-Za-z0-9_]*?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH))|(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH))\s*=\s*)(["'][^"']*["']|[^\s,;&|]+)/giu,
    (match, prefix, value) => `${prefix}${isSecretPlaceholder(value.replace(/^['"]|['"]$/gu, "")) ? value : "[REDACTED]"}`,
  );
}

function redactLabeledSecrets(text) {
  return text.replace(
    /((?:api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|client[\s_-]*secret|authorization|password|passwd|secret|private[\s_-]*key|credential|cookie|session[\s_-]*token)\s*(?:=|:)\s*)(["'][^"']*["']|[^\s,;&|]+)/giu,
    (match, prefix, value) => `${prefix}${isSecretPlaceholder(value.replace(/^['"]|['"]$/gu, "")) ? value : "[REDACTED]"}`,
  );
}

function redactCurlAuth(text) {
  let redacted = text.replace(
    /((?:\bcurl\b[^\n]{0,500}?\s)(?:--user|-u)\s+)([^\s]+)/giu,
    (match, prefix, value) => `${prefix}${isSecretPlaceholder(value) ? value : "[REDACTED_CURL_AUTH]"}`,
  );
  redacted = redacted.replace(
    /([?&](?:signature|sig|token|api[\s_-]*key|access[\s_-]*token|auth(?:orization)?)=)([^&\s]+)/giu,
    (match, prefix, value) => `${prefix}${isSecretPlaceholder(value) ? value : "[REDACTED_QUERY_SECRET]"}`,
  );
  return redacted;
}

export function redactSecrets(value) {
  let redacted = String(value);
  redacted = redacted.replace(
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu,
    "[REDACTED_PRIVATE_KEY]",
  );
  redacted = redacted.replace(
    /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/gu,
    "[REDACTED_PROVIDER_KEY]",
  );
  redacted = redacted.replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/giu, (scheme) => {
    return `${scheme.split(/\s+/u)[0]} [REDACTED]`;
  });
  redacted = redactAssignmentValues(redacted);
  redacted = redactLabeledSecrets(redacted);
  redacted = redacted.replace(
    /((?:^|\s)--(?:api-key|access-token|refresh-token|token|password|secret)(?:=|\s+))([^\s]+)/giu,
    (match, prefix, value) => `${prefix}${isSecretPlaceholder(value) ? value : "[REDACTED]"}`,
  );
  redacted = redactCurlAuth(redacted);
  redacted = redacted.replace(
    /(\b(?:https?|postgres(?:ql)?):\/\/[^\s/:@]+:)[^\s@]+(@)/giu,
    "$1[REDACTED]$2",
  );
  redacted = redacted.replace(
    /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
    "[REDACTED_JWT]",
  );
  redacted = redacted.replace(
    /\b[A-Za-z0-9_-]{24,}\b/gu,
    (match, offset, fullText) => {
      if (/^REDACTED(?:_|$)/iu.test(match) || isSecretPlaceholder(match)) return match;
      // Avoid treating ordinary long hyphenated/underscored labels as opaque
      // credentials unless they also carry a numeric token character.
      if (!/\d/u.test(match) && /[_-]/u.test(match)) return match;
      let start = offset;
      while (start > 0 && !/[\s,;&|]/u.test(fullText[start - 1])) start -= 1;
      let end = offset + match.length;
      while (end < fullText.length && !/[\s,;&|]/u.test(fullText[end])) end += 1;
      // Long path components are not opaque credentials; dedicated URL/query
      // and assignment rules above still redact credential-bearing paths.
      return /[\\/]/u.test(fullText.slice(start, end)) ? match : "[REDACTED_OPAQUE_CREDENTIAL]";
    },
  );
  redacted = redacted.replace(
    /\b[A-Fa-f0-9]{40,}\b/gu,
    "[REDACTED_OPAQUE_CREDENTIAL]",
  );
  return redacted;
}

function containsSecretMaterial(value) {
  if (typeof value !== "string") return false;
  const reviewableValue = /\bgit\s+push\b/iu.test(value)
    ? value.replace(
        /(--force-with-lease=refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+:)[a-f0-9]{40,64}\b/giu,
        "$1${GIT_OBJECT_ID}",
      )
    : value;
  return redactSecrets(reviewableValue) !== reviewableValue;
}

/**
 * Validate and normalize the structured action metadata accepted by the MCP tool.
 * @param {unknown} rawAction
 * @returns {{ok: true, value: object} | {ok: false, errors: string[]}}
 */
export function validateProposedAction(rawAction) {
  const errors = [];
  if (!isPlainObject(rawAction)) return { ok: false, errors: ["arguments must be a JSON object."] };
  pushUnknownKeys(rawAction, ACTION_KEYS, "arguments", errors);

  const operationKind = validateString(rawAction.operationKind, "operationKind", MAX_OPERATION_KIND_LENGTH, errors);
  if (operationKind !== null && !OPERATION_KINDS.includes(operationKind)) {
    errors.push(`operationKind must be one of: ${OPERATION_KINDS.join(", ")}.`);
  }
  const workspaceRoots = validateStringArray(
    rawAction.workspaceRoots,
    "workspaceRoots",
    MAX_WORKSPACE_ROOTS,
    MAX_WORKSPACE_ROOT_LENGTH,
    errors,
  );
  if (workspaceRoots.length === 0) errors.push("workspaceRoots must contain at least one absolute path.");
  const cwd = validateString(rawAction.cwd, "cwd", MAX_CWD_LENGTH, errors);
  const reason = validateString(rawAction.reason, "reason", MAX_REASON_LENGTH, errors);
  const reversibility = validateString(rawAction.reversibility, "reversibility", 64, errors);
  if (reversibility !== null && !REVERSIBILITY_VALUES.includes(reversibility)) {
    errors.push(`reversibility must be one of: ${REVERSIBILITY_VALUES.join(", ")}.`);
  }
  const userAuthorization = validateString(rawAction.userAuthorization, "userAuthorization", 32, errors);
  if (userAuthorization !== null && !USER_AUTHORIZATION_VALUES.includes(userAuthorization)) {
    errors.push(`userAuthorization must be one of: ${USER_AUTHORIZATION_VALUES.join(", ")}.`);
  }
  const sideEffects = validateStringArray(rawAction.sideEffects, "sideEffects", MAX_SIDE_EFFECTS, MAX_SIDE_EFFECT_LENGTH, errors);
  const fileTargets = rawAction.fileTargets === undefined
    ? []
    : validateStringArray(rawAction.fileTargets, "fileTargets", MAX_FILE_TARGETS, MAX_FILE_TARGET_LENGTH, errors);
  let command = null;
  if (rawAction.command !== undefined) command = validateString(rawAction.command, "command", MAX_COMMAND_LENGTH, errors);

  if (!command && fileTargets.length === 0) errors.push("Provide a non-empty exact command or at least one exact file target.");
  if (operationKind === "command" && !command) errors.push("operationKind=command requires the exact command field.");
  if (cwd !== null && !isAbsolute(cwd)) errors.push("cwd must be an absolute path.");
  for (const [index, root] of workspaceRoots.entries()) {
    if (!isAbsolute(root)) errors.push(`workspaceRoots[${index}] must be an absolute path.`);
  }
  if (["file_read", "file_write", "file_delete", "file_move"].includes(operationKind) && fileTargets.length === 0) {
    errors.push(`operationKind=${operationKind} requires fileTargets.`);
  }
  if (["file_read", "file_write", "file_delete", "file_move"].includes(operationKind) && command) {
    errors.push(`operationKind=${operationKind} must use fileTargets, not a command.`);
  }

  const network = normalizeFlag(rawAction.network, "network", FLAG_KEYS.network, errors);
  const externalSystem = normalizeFlag(rawAction.externalSystem, "externalSystem", FLAG_KEYS.externalSystem, errors);
  const sensitiveData = normalizeFlag(rawAction.sensitiveData, "sensitiveData", FLAG_KEYS.sensitiveData, errors);
  const textFields = [
    ["command", command],
    ["cwd", cwd],
    ["reason", reason],
    ...workspaceRoots.map((root, index) => [`workspaceRoots[${index}]`, root]),
    ...sideEffects.map((effect, index) => [`sideEffects[${index}]`, effect]),
    ...fileTargets.map((target, index) => [`fileTargets[${index}]`, target]),
    ...network.details.map((detail, index) => [`network.details[${index}]`, detail]),
    ...externalSystem.details.map((detail, index) => [`externalSystem.details[${index}]`, detail]),
    ...sensitiveData.details.map((detail, index) => [`sensitiveData.details[${index}]`, detail]),
  ];
  for (const [field, value] of textFields) {
    if (value !== null && containsSecretMaterial(value)) {
      errors.push(`${field} appears to contain raw or uncertain secret material; redact it before review.`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const normalizedAction = {
    operationKind,
    ...(command ? { command } : {}),
    ...(fileTargets.length > 0 ? { fileTargets } : {}),
    workspaceRoots,
    cwd,
    reason,
    sideEffects,
    reversibility,
    userAuthorization,
    network,
    externalSystem,
    sensitiveData,
  };
  try {
    canonicalActionJson(normalizedAction);
  } catch {
    return { ok: false, errors: ["canonical action metadata exceeded the size limit."] };
  }
  return { ok: true, value: normalizedAction };
}

function redactFlag(flag, detailMaxLength) {
  return {
    involved: flag.involved,
    details: flag.details.map((detail) => redactSecrets(boundedText(detail, detailMaxLength))),
  };
}

function actionForPrompt(action) {
  return {
    operationKind: action.operationKind,
    ...(action.command ? { command: redactSecrets(boundedText(action.command, 4_000)) } : {}),
    ...(action.fileTargets ? {
      fileTargets: action.fileTargets.slice(0, 16).map((target) => redactSecrets(boundedText(target, 500))),
    } : {}),
    workspaceRoots: action.workspaceRoots.slice(0, 8).map((root) => redactSecrets(boundedText(root, 500))),
    cwd: redactSecrets(boundedText(action.cwd, 800)),
    reason: redactSecrets(boundedText(action.reason, 2_000)),
    sideEffects: action.sideEffects.slice(0, 12).map((effect) => redactSecrets(boundedText(effect, 300))),
    reversibility: action.reversibility,
    userAuthorization: action.userAuthorization,
    network: redactFlag(action.network, 300),
    externalSystem: redactFlag(action.externalSystem, 300),
    sensitiveData: redactFlag(action.sensitiveData, 300),
  };
}

export function buildReviewerPromptFromValidated(action) {
  const promptAction = actionForPrompt(action);
  let actionJson = JSON.stringify(promptAction, null, 2);
  if (actionJson.length > MAX_PROMPT_CHARS - REVIEWER_INSTRUCTIONS.length - 512) {
    actionJson = JSON.stringify({
      ...promptAction,
      command: promptAction.command ? boundedText(promptAction.command, 1_500) : undefined,
      fileTargets: promptAction.fileTargets?.slice(0, 8),
      workspaceRoots: promptAction.workspaceRoots.slice(0, 4),
      sideEffects: promptAction.sideEffects.slice(0, 6),
      network: { involved: promptAction.network.involved, details: promptAction.network.details.slice(0, 4) },
      externalSystem: { involved: promptAction.externalSystem.involved, details: promptAction.externalSystem.details.slice(0, 4) },
      sensitiveData: { involved: promptAction.sensitiveData.involved, details: promptAction.sensitiveData.details.slice(0, 4) },
      _notice: "Some metadata was bounded before review.",
    }, null, 2);
  }
  let prompt = `${REVIEWER_INSTRUCTIONS}\n\nPROPOSED ACTION METADATA (UNTRUSTED DATA):\n${actionJson}`;
  if (prompt.length > MAX_PROMPT_CHARS) {
    const minimalAction = {
      operationKind: promptAction.operationKind,
      command: promptAction.command ? boundedText(promptAction.command, 500) : undefined,
      fileTargets: promptAction.fileTargets?.slice(0, 2),
      workspaceRoots: promptAction.workspaceRoots.slice(0, 2),
      cwd: boundedText(promptAction.cwd, 300),
      reason: boundedText(promptAction.reason, 500),
      sideEffects: promptAction.sideEffects.slice(0, 2),
      reversibility: promptAction.reversibility,
      userAuthorization: promptAction.userAuthorization,
      network: { involved: promptAction.network.involved, details: [] },
      externalSystem: { involved: promptAction.externalSystem.involved, details: [] },
      sensitiveData: { involved: promptAction.sensitiveData.involved, details: [] },
      _notice: "Metadata was further bounded before review.",
    };
    prompt = `${REVIEWER_INSTRUCTIONS}\n\nPROPOSED ACTION METADATA (UNTRUSTED DATA):\n${JSON.stringify(minimalAction, null, 2)}`;
  }
  return prompt.slice(0, MAX_PROMPT_CHARS);
}

/**
 * Build the bounded, redacted prompt sent to the configured reviewer model.
 * @param {unknown} rawAction
 * @returns {string}
 */
export function buildReviewerPrompt(rawAction) {
  const validation = validateProposedAction(rawAction);
  if (!validation.ok) throw new Error(`Cannot build a review prompt: ${validation.errors.join(" ")}`);
  return buildReviewerPromptFromValidated(validation.value);
}

export function canonicalActionJson(action) {
  const canonical = {
    operationKind: action.operationKind,
    command: action.command ?? null,
    fileTargets: action.fileTargets ?? [],
    workspaceRoots: action.workspaceRoots ?? [],
    cwd: action.cwd,
    reason: action.reason,
    sideEffects: action.sideEffects,
    reversibility: action.reversibility,
    userAuthorization: action.userAuthorization,
    network: { involved: action.network.involved, details: action.network.details },
    externalSystem: { involved: action.externalSystem.involved, details: action.externalSystem.details },
    sensitiveData: { involved: action.sensitiveData.involved, details: action.sensitiveData.details },
  };
  const json = JSON.stringify(canonical);
  if (Buffer.byteLength(json, "utf8") > MAX_CANONICAL_ACTION_BYTES) throw new Error("canonical action metadata exceeded the size limit");
  return json;
}

export function isCanonicalAction(action) {
  return isPlainObject(action) &&
    typeof action.operationKind === "string" &&
    Array.isArray(action.workspaceRoots) &&
    typeof action.cwd === "string" &&
    USER_AUTHORIZATION_VALUES.includes(action.userAuthorization) &&
    isPlainObject(action.network) && Array.isArray(action.network.details) &&
    isPlainObject(action.externalSystem) && Array.isArray(action.externalSystem.details) &&
    isPlainObject(action.sensitiveData) && Array.isArray(action.sensitiveData.details);
}

export function normalizeActionForReview(action) {
  if (isCanonicalAction(action)) {
    const wireAction = {
      ...action,
      network: { involved: action.network.involved, ...(action.network.details.length > 0 ? { destinations: action.network.details } : {}) },
      externalSystem: { involved: action.externalSystem.involved, ...(action.externalSystem.details.length > 0 ? { systems: action.externalSystem.details } : {}) },
      sensitiveData: { involved: action.sensitiveData.involved, ...(action.sensitiveData.details.length > 0 ? { kinds: action.sensitiveData.details } : {}) },
    };
    const canonicalValidation = validateProposedAction(wireAction);
    return canonicalValidation.ok ? canonicalValidation.value : null;
  }
  const validation = validateProposedAction(action);
  return validation.ok ? validation.value : null;
}

export function actionSha256(action) {
  return createHash("sha256").update(canonicalActionJson(action), "utf8").digest("hex");
}

