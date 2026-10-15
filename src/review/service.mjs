import { DEFAULT_REVIEW_TIMEOUT_MS, MAX_REVIEW_TIMEOUT_MS, MAX_CONCURRENT_REVIEWS, REVIEW_TTL_MS, REVIEW_RATE_LIMIT_MAX_CALLS, REVIEW_RATE_LIMIT_WINDOW_MS, MAX_REVIEW_CACHE_ENTRIES } from '../config.mjs';
import { REVIEW_RESPONSE_SCHEMA } from '../action/contracts.mjs';
import { isPlainObject, validateProposedAction, buildReviewerPromptFromValidated, normalizeActionForReview, actionSha256 } from '../action/metadata.mjs';
import { hasLearnedApproval, rememberLearnedApproval } from '../approvals/store.mjs';
import { sanitizeReviewOutput, decorateReview, outputFailure, parseReviewerOutput } from '../action/review-result.mjs';
import { deterministicHighSensitivityHazards, verifySafeRead, learnedApprovalBlockers, applyDeterministicPolicy } from '../policy/policy.mjs';
import { AppServerReviewError, runCodexAppServer, managedAuthAvailable } from '../runtime/app-server-client.mjs';

// Dependencies are configured only by trusted in-process composition. MCP callers
// can supply cancellation and timeout, never an executable or reviewer adapter.
export function createReviewService({
  authAvailable = managedAuthAvailable,
  runAppServer = runCodexAppServer,
} = {}) {

  async function runPermissionReviewer(action, options = {}) {
    const safeAction = normalizeActionForReview(action);
    if (safeAction === null) return outputFailure("invalid action metadata", "invalid_action_metadata");
    if (options.signal?.aborted) return outputFailure("reviewer was cancelled", "reviewer_cancelled", safeAction);
    if (!(await authAvailable())) return outputFailure("managed Codex authentication is unavailable", "reviewer_auth_missing", safeAction);
    const prompt = buildReviewerPromptFromValidated(safeAction);
    try {
      const reviewerText = await runAppServer(prompt, {
        signal: options.signal,
        timeoutMs: Math.min(Math.max(Number(options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS), 1), MAX_REVIEW_TIMEOUT_MS),
        outputSchema: REVIEW_RESPONSE_SCHEMA,
      });
      const parsed = parseReviewerOutput(reviewerText);
      if (!parsed.ok) return outputFailure("reviewer output failed strict validation", "reviewer_malformed_output", safeAction);
      const policyReview = await applyDeterministicPolicy(parsed.value, safeAction);
      return decorateReview(policyReview, safeAction);
    } catch (error) {
      const hazard = error instanceof AppServerReviewError && typeof error.hazard === "string"
        ? error.hazard
        : "reviewer_child_failure";
      return outputFailure("the managed Codex reviewer did not complete safely", hazard, safeAction);
    }
  }

  let activeReviewCount = 0;
  const reviewCallTimestamps = [];
  const reviewCache = new Map();

  function cloneReview(review) {
    return JSON.parse(JSON.stringify(review));
  }

  function cachedReviewForDigest(digest) {
    const entry = reviewCache.get(digest);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      reviewCache.delete(digest);
      return null;
    }
    return cloneReview(entry.review);
  }

  function cacheReviewForDigest(digest, review) {
    if (!digest || !isPlainObject(review)) return;
    while (reviewCache.size >= MAX_REVIEW_CACHE_ENTRIES) {
      const oldestDigest = reviewCache.keys().next().value;
      if (oldestDigest === undefined) break;
      reviewCache.delete(oldestDigest);
    }
    reviewCache.set(digest, {
      expiresAtMs: Date.now() + REVIEW_TTL_MS,
      review: cloneReview({
        ...sanitizeReviewOutput(review),
        actionSha256: typeof review.actionSha256 === "string" ? review.actionSha256 : digest,
        reviewedAt: typeof review.reviewedAt === "string" ? review.reviewedAt : new Date().toISOString(),
        expiresAt: typeof review.expiresAt === "string" ? review.expiresAt : new Date(Date.now() + REVIEW_TTL_MS).toISOString(),
      }),
    });
  }

  function reviewBudgetAvailable() {
    const cutoff = Date.now() - REVIEW_RATE_LIMIT_WINDOW_MS;
    while (reviewCallTimestamps.length > 0 && reviewCallTimestamps[0] <= cutoff) reviewCallTimestamps.shift();
    if (reviewCallTimestamps.length >= REVIEW_RATE_LIMIT_MAX_CALLS) return false;
    reviewCallTimestamps.push(Date.now());
    return true;
  }

  /**
   * Validate, bound, and review a proposed action. Only the AbortSignal is
   * accepted from the MCP transport; child process configuration is fixed.
   * @param {unknown} rawAction
   * @param {{signal?: AbortSignal, timeoutMs?: number}} options
   * @returns {Promise<object>}
   */
  async function reviewSensitiveAction(rawAction, options = {}) {
    const validation = validateProposedAction(rawAction);
    if (!validation.ok) return outputFailure("invalid action metadata", "invalid_action_metadata");
    if (options.signal?.aborted) return outputFailure("reviewer was cancelled", "reviewer_cancelled", validation.value);
    const digest = actionSha256(validation.value);
    if (validation.value.userAuthorization === "none" && learnedApprovalBlockers(validation.value).length === 0) {
      try {
        if (await hasLearnedApproval(validation.value)) {
          return decorateReview({
            verdict: "allow",
            riskLevel: "medium",
            rationale: "A prior model-reviewed explicit approval matches this exact action scope and remains unexpired.",
            detectedHazards: [],
            saferAlternative: "",
          }, validation.value);
        }
      } catch {
        // Corrupt or unavailable learning state never grants permission.
      }
    }
    const cached = validation.value.userAuthorization === "explicit" ? null : cachedReviewForDigest(digest);
    if (cached) {
      if (cached.verdict === "allow") {
        const highSensitivityHazards = deterministicHighSensitivityHazards(validation.value);
        if (highSensitivityHazards.length > 0) {
          return decorateReview({
            verdict: "deny",
            riskLevel: "high",
            rationale: "A deterministic high-sensitivity signal was detected; the cached model result cannot override the read-only policy.",
            detectedHazards: highSensitivityHazards,
            saferAlternative: "Remove the high-sensitivity scope or ask the user to confirm the action directly.",
          }, validation.value);
        }
        const cachedVerification = await verifySafeRead(validation.value);
        if (!cachedVerification.verified) {
          return decorateReview({
            verdict: "needs_user",
            riskLevel: "medium",
            rationale: "The cached read approval is no longer independently verifiable; user confirmation is required.",
            detectedHazards: ["cached_safe_read_verification_failed", ...cachedVerification.hazards],
            saferAlternative: "Reconfirm the trusted workspace root and exact file before reading.",
          }, validation.value);
        }
      }
      return cached;
    }
    if (!(await authAvailable())) return outputFailure("managed Codex authentication is unavailable", "reviewer_auth_missing", validation.value);
    if (activeReviewCount >= MAX_CONCURRENT_REVIEWS) return outputFailure("another review is already in progress", "reviewer_busy", validation.value);
    if (!reviewBudgetAvailable()) {
      return decorateReview({
        verdict: "needs_user",
        riskLevel: "high",
        rationale: "The advisory review rate limit was reached; direct user confirmation is required.",
        detectedHazards: ["reviewer_rate_limited"],
        saferAlternative: "Wait for the review budget window to expire, or ask the user directly.",
      }, validation.value);
    }
    activeReviewCount += 1;
    try {
      const review = await runPermissionReviewer(validation.value, { signal: options.signal, timeoutMs: options.timeoutMs });
      if (
        review.verdict === "allow" &&
        validation.value.userAuthorization === "explicit" &&
        learnedApprovalBlockers(validation.value).length === 0
      ) {
        try {
          await rememberLearnedApproval(validation.value);
        } catch {
          review.detectedHazards = [...new Set([...review.detectedHazards, "approval_memory_unavailable"])];
        }
      }
      if (validation.value.userAuthorization !== "explicit") cacheReviewForDigest(digest, review);
      return review;
    } catch {
      return outputFailure("reviewer request failed unexpectedly", "reviewer_internal_failure", validation.value);
    } finally {
      activeReviewCount -= 1;
    }
  }


  return { runPermissionReviewer, reviewSensitiveAction };
}

export const { runPermissionReviewer, reviewSensitiveAction } = createReviewService();
