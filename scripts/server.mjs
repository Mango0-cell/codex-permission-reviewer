#!/usr/bin/env node

// Stable launcher and import surface for installed plugin snapshots.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { main } from "../src/transport/mcp.mjs";
export { TOOL_NAME, MCP_PROTOCOL_VERSION, SUPPORTED_MCP_PROTOCOL_VERSIONS, MAX_REQUEST_BYTES, MAX_PROMPT_CHARS, MAX_OUTPUT_BYTES, MAX_OUTPUT_TOKENS, DEFAULT_REVIEW_TIMEOUT_MS, MAX_REVIEW_TIMEOUT_MS, MAX_CONCURRENT_REVIEWS, REVIEW_TTL_MS, REVIEW_RATE_LIMIT_MAX_CALLS, REVIEW_RATE_LIMIT_WINDOW_MS, MAX_REVIEW_CACHE_ENTRIES, REVIEW_MODEL, REVIEW_REASONING_EFFORT, TRUSTED_ROOTS_ENV, LEARNED_APPROVAL_TTL_MS } from "../src/config.mjs";
export { OPERATION_KINDS, REVERSIBILITY_VALUES, USER_AUTHORIZATION_VALUES, REVIEW_RESPONSE_SCHEMA, TOOL_DEFINITION } from "../src/action/contracts.mjs";
export { validateProposedAction, buildReviewerPrompt } from "../src/action/metadata.mjs";
export { parseReviewerOutput } from "../src/action/review-result.mjs";
export { sameFileIdentity, verifySafeRead } from "../src/policy/policy.mjs";
export { runPermissionReviewer, reviewSensitiveAction } from "../src/review/service.mjs";
export { readBoundedLines } from "../src/transport/mcp.mjs";

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main().catch(() => { process.exitCode = 1; });
