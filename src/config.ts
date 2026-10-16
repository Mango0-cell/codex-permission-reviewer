import { APP_SERVER_MODEL, APP_SERVER_EFFORT } from './runtime/config.js';

export const TOOL_NAME = "review_sensitive_action";
export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = Object.freeze([
  "2026-07-28",
  "2025-06-18",
  "2024-11-05",
]);
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_PROMPT_CHARS = 24_000;
export const MAX_OUTPUT_BYTES = 32 * 1024;
export const MAX_OUTPUT_TOKENS = 700;
export const DEFAULT_REVIEW_TIMEOUT_MS = 30_000;
export const MAX_REVIEW_TIMEOUT_MS = 60_000;
export const MAX_CONCURRENT_REVIEWS = 1;
export const MAX_QUEUED_REVIEWS = 4;
export const REVIEW_TTL_MS = 5 * 60 * 1_000;
export const REVIEW_RATE_LIMIT_MAX_CALLS = 5;
export const REVIEW_RATE_LIMIT_WINDOW_MS = 60 * 1_000;
export const MAX_REVIEW_CACHE_ENTRIES = 64;
export const REVIEW_MODEL = APP_SERVER_MODEL;
export const REVIEW_REASONING_EFFORT = APP_SERVER_EFFORT;
export const TRUSTED_ROOTS_ENV = "KIT_CODEX_AUTO_PERMISSION_WORKSPACE_ROOTS";
export const LEARNED_APPROVAL_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export const MAX_OPERATION_KIND_LENGTH = 64;
export const MAX_COMMAND_LENGTH = 12_000;
export const MAX_CWD_LENGTH = 2_048;
export const MAX_REASON_LENGTH = 4_000;
export const MAX_SIDE_EFFECT_LENGTH = 1_000;
export const MAX_FILE_TARGET_LENGTH = 2_048;
export const MAX_WORKSPACE_ROOT_LENGTH = 2_048;
export const MAX_FLAG_DETAIL_LENGTH = 1_000;
export const MAX_SIDE_EFFECTS = 32;
export const MAX_FILE_TARGETS = 64;
export const MAX_WORKSPACE_ROOTS = 16;
export const MAX_FLAG_DETAILS = 32;
export const MAX_OUTPUT_RATIONALE_LENGTH = 2_000;
export const MAX_OUTPUT_HAZARDS = 16;
export const MAX_OUTPUT_HAZARD_LENGTH = 500;
export const MAX_OUTPUT_ALTERNATIVE_LENGTH = 2_000;
export const MAX_CANONICAL_ACTION_BYTES = 128 * 1024;
export const MAX_SAFE_READ_TARGETS = 8;
export const MAX_SAFE_READ_SAMPLE_BYTES = 4_096;
export const MAX_LEARNED_APPROVALS = 128;
export const LEARNED_APPROVAL_POLICY_VERSION = 1;
export const LEARNED_APPROVAL_STATE_FILENAME = "learned-approvals.json";

