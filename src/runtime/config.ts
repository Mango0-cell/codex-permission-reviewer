export const REVIEW_MODEL_ENV = "CODEX_PERMISSION_REVIEW_MODEL";
export const REVIEW_EFFORT_ENV = "CODEX_PERMISSION_REVIEW_EFFORT";
export const DEFAULT_APP_SERVER_MODEL = "gpt-5.6-luna";
export const DEFAULT_APP_SERVER_EFFORT = "max";

const configuredModel = process.env[REVIEW_MODEL_ENV] ?? DEFAULT_APP_SERVER_MODEL;
const configuredEffort = process.env[REVIEW_EFFORT_ENV] ?? DEFAULT_APP_SERVER_EFFORT;
if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(configuredModel)) {
  throw new TypeError(`${REVIEW_MODEL_ENV} contains an invalid model identifier.`);
}
if (!["low", "medium", "high", "max"].includes(configuredEffort)) {
  throw new TypeError(`${REVIEW_EFFORT_ENV} must be low, medium, high, or max.`);
}
export const APP_SERVER_MODEL = configuredModel;
export const APP_SERVER_EFFORT = configuredEffort;
export const DEFAULT_APP_SERVER_TIMEOUT_MS = 30_000;
export const MAX_APP_SERVER_TIMEOUT_MS = 60_000;
export const MAX_APP_SERVER_LINE_BYTES = 128 * 1024;
export const MAX_APP_SERVER_STDOUT_BYTES = 256 * 1024;
export const MAX_APP_SERVER_STDERR_BYTES = 64 * 1024;
export const MAX_APP_SERVER_MESSAGE_BYTES = 128 * 1024;

