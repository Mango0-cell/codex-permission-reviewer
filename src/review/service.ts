import type { ReviewOptions, ReviewAdapters } from "./types.ts";
import type { NormalizedAction, ReviewResult } from "../action/types.ts";
import { DEFAULT_REVIEW_TIMEOUT_MS, MAX_REVIEW_TIMEOUT_MS, MAX_QUEUED_REVIEWS, REVIEW_TTL_MS, REVIEW_RATE_LIMIT_MAX_CALLS, REVIEW_RATE_LIMIT_WINDOW_MS, MAX_REVIEW_CACHE_ENTRIES, MAX_PROMPT_CHARS } from '../config.ts';
import { REVIEW_RESPONSE_SCHEMA } from '../action/contracts.ts';
import { validateProposedAction, buildReviewerPromptFromValidated, normalizeActionForReview, actionSha256, ReviewerPromptSizeError } from '../action/metadata.ts';
import { hasLearnedApproval, rememberLearnedApproval } from '../approvals/store.ts';
import { decorateReview, outputFailure, parseReviewerOutput, reviewerUnavailable } from '../action/review-result.ts';
import { deterministicHighSensitivityHazards, verifySafeRead, learnedApprovalBlockers, applyDeterministicPolicy } from '../policy/policy.ts';
import { AppServerReviewError, runCodexAppServer, managedAuthAvailable } from '../runtime/app-server-client.ts';
import { createReviewScheduler, ReviewSchedulingError, withReviewDeadline } from './scheduler.ts';
import { captureExecutableDependencyHome, isExecutableDependencyCandidate, reverifyExecutableDependencies, verifyExecutableDependencies } from '../policy/executable-dependencies.ts';
import type { ExecutableDependencyProof } from '../policy/executable-dependencies.ts';

// Only trusted in-process composition can configure adapters, never MCP input.
export function createReviewService({
  authAvailable = managedAuthAvailable,
  runAppServer = runCodexAppServer,
  approvalStore = { has: hasLearnedApproval, remember: rememberLearnedApproval },
  dependencyPolicyHome: configuredDependencyPolicyHome,
}: ReviewAdapters = {}) {
  const dependencyPolicyHome = captureExecutableDependencyHome(configuredDependencyPolicyHome);
  const scheduler = createReviewScheduler({ maxQueued: MAX_QUEUED_REVIEWS });
  const reviewCallTimestamps: number[] = [];
  const reviewCache = new Map<string, { expiresAtMs: number; review: ReviewResult }>();
  const cloneReview = (review: ReviewResult) => structuredClone(review);
  const cancelled = (action: NormalizedAction) => outputFailure("reviewer was cancelled", "reviewer_cancelled", action);

  function cachedReviewForDigest(digest: string) {
    const entry = reviewCache.get(digest);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      reviewCache.delete(digest);
      return null;
    }
    // Touch on access: the bounded cache retains frequently used scopes.
    reviewCache.delete(digest);
    reviewCache.set(digest, entry);
    return cloneReview(entry.review);
  }

  function cacheReviewForDigest(digest: string, review: ReviewResult) {
    // Infrastructure failures must not poison an exact scope for five minutes.
    // Only completed policy/model results are reusable. Error codes are not
    // model-controlled fields; reserved reviewer_* hazards are excluded too.
    if (review.reviewStatus === "unavailable" || review.detectedHazards.some((hazard) => hazard.startsWith("reviewer_"))) return;
    const expiresAtMs = Math.min(Date.parse(review.expiresAt), Date.now() + REVIEW_TTL_MS);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return;
    reviewCache.delete(digest);
    while (reviewCache.size >= MAX_REVIEW_CACHE_ENTRIES) reviewCache.delete(reviewCache.keys().next().value!);
    reviewCache.set(digest, { expiresAtMs, review: cloneReview(review) });
  }

  function consumeReviewBudget() {
    const now = Date.now();
    const cutoff = now - REVIEW_RATE_LIMIT_WINDOW_MS;
    while (reviewCallTimestamps.length && reviewCallTimestamps[0]! <= cutoff) reviewCallTimestamps.shift();
    if (reviewCallTimestamps.length >= REVIEW_RATE_LIMIT_MAX_CALLS) {
      return Math.max(1, reviewCallTimestamps[0]! + REVIEW_RATE_LIMIT_WINDOW_MS - now);
    }
    reviewCallTimestamps.push(now);
    return 0;
  }

  async function reusableReview(action: NormalizedAction, digest: string, signal?: AbortSignal): Promise<ReviewResult | null> {
    if (signal?.aborted) return cancelled(action);
    if (action.userAuthorization === "explicit") return null;
    if (learnedApprovalBlockers(action).length === 0) {
      try {
        const learned = await approvalStore.has(action);
        if (signal?.aborted) return cancelled(action);
        if (learned) return decorateReview({
          verdict: "allow", riskLevel: "medium",
          rationale: "A prior model-reviewed explicit approval matches this exact action scope and remains unexpired.",
          detectedHazards: [], saferAlternative: "",
        }, action);
      } catch {
        // Corrupt/unavailable learning state never grants permission.
      }
    }
    if (signal?.aborted) return cancelled(action);
    const cached = cachedReviewForDigest(digest);
    if (!cached) return null;
    if (cached.verdict === "allow") {
      const highSensitivityHazards = deterministicHighSensitivityHazards(action);
      if (highSensitivityHazards.length > 0) return decorateReview({
        verdict: "deny", riskLevel: "high",
        rationale: "The cached model result cannot override deterministic high-sensitivity policy.",
        detectedHazards: highSensitivityHazards,
        saferAlternative: "Request a fresh review of the exact sensitive action after user confirmation.",
      }, action);
      const verification = await verifySafeRead(action);
      if (signal?.aborted) return cancelled(action);
      if (!verification.verified) return decorateReview({
        verdict: "needs_user", riskLevel: "medium",
        rationale: "The cached read approval is no longer independently verifiable; user confirmation is required.",
        detectedHazards: ["cached_safe_read_verification_failed", ...verification.hazards],
        saferAlternative: "Reconfirm the trusted workspace root and exact file before reading.",
      }, action);
    }
    return signal?.aborted ? cancelled(action) : cached;
  }

  async function modelReview(action: NormalizedAction, signal: AbortSignal, remainingMs: () => number): Promise<ReviewResult> {
    if (signal.aborted) return cancelled(action);
    let prompt;
    try { prompt = buildReviewerPromptFromValidated(action); }
    catch (error) {
      if (!(error instanceof ReviewerPromptSizeError)) throw error;
      return decorateReview({
        verdict: "needs_user", riskLevel: "high",
        rationale: "The complete action is too large for a reliable bounded review; nothing was approved or sent to the model.",
        detectedHazards: ["reviewer_prompt_oversize"],
        saferAlternative: "Reduce redundant context or split the proposed scope into exact independently reviewable actions, then request a fresh review. Do not omit commands, targets or side effects.",
      }, action);
    }
    let dependencyProof: ExecutableDependencyProof | null = null;
    if (isExecutableDependencyCandidate(action) && action.userAuthorization === "explicit") {
      const home = await dependencyPolicyHome;
      dependencyProof = await verifyExecutableDependencies(action, home, { signal, remainingMs });
      if (signal.aborted) return cancelled(action);
      if (remainingMs() <= 0) return reviewerUnavailable("reviewer_timeout", action, 1_000);
      if (dependencyProof) {
        const evidence = [
          "HOST-VERIFIED EXECUTABLE DEPENDENCY EVIDENCE:",
          "The host matched these exact targets to action-bound SHA-256 pins and verified their file identities before this review:",
          ...dependencyProof.dependencies.map((dependency) => `- ${JSON.stringify(dependency.path)} (host identity and hash verified)`),
          "Hashes verify identity only. They do not establish code safety, imported-file contents, dependency closure, or future execution behavior.",
        ].join("\n");
        if (prompt.length + 2 + evidence.length > MAX_PROMPT_CHARS) {
          return decorateReview({
            verdict: "needs_user", riskLevel: "high",
            rationale: "The complete action and verified dependency evidence exceed the bounded reviewer prompt; nothing was approved or sent to the model.",
            detectedHazards: ["reviewer_prompt_oversize"],
            saferAlternative: "Narrow the exact action or dependency set, then request a fresh review without omitting targets or side effects.",
          }, action);
        }
        prompt = `${prompt}\n\n${evidence}`;
      }
    }
    if (!(await authAvailable())) return reviewerUnavailable("reviewer_auth_missing", action);
    if (signal.aborted) return cancelled(action);
    const retryAfterMs = consumeReviewBudget();
    if (retryAfterMs) return reviewerUnavailable("reviewer_rate_limited", action, retryAfterMs);
    try {
      const reviewerText = await runAppServer(prompt, {
        signal, timeoutMs: remainingMs(), outputSchema: REVIEW_RESPONSE_SCHEMA,
      });
      if (signal.aborted) return cancelled(action);
      if (dependencyProof) {
        const home = await dependencyPolicyHome;
        if (!(await reverifyExecutableDependencies(action, home, dependencyProof, { signal, remainingMs }))) dependencyProof = null;
      }
      if (signal.aborted) return cancelled(action);
      const parsed = parseReviewerOutput(reviewerText);
      if (!parsed.ok) return outputFailure("reviewer output failed strict validation", "reviewer_malformed_output", action);
      const review = await applyDeterministicPolicy(parsed.value, action, dependencyProof ?? undefined);
      if (signal.aborted) return cancelled(action);
      const result = decorateReview(review, action);
      if (dependencyProof) {
        result.decisionSha256 = dependencyProof.decisionSha256;
        result.dependencyPolicySha256 = dependencyProof.dependencyPolicySha256;
      }
      return result;
    } catch (error) {
      const hazard = error instanceof AppServerReviewError ? error.hazard : "reviewer_child_failure";
      if (signal.aborted || hazard === "reviewer_cancelled") return cancelled(action);
      if (["reviewer_timeout", "reviewer_child_failure"].includes(hazard)) return reviewerUnavailable(hazard, action, 1_000);
      return outputFailure("reviewer did not complete safely", hazard, action);
    }
  }

  async function scheduledReview(action: NormalizedAction, options: ReviewOptions, reuse: boolean): Promise<ReviewResult> {
    const rawTimeout = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
    if (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
      return outputFailure("invalid review timeout", "invalid_review_timeout", action);
    }
    const timeoutMs = Math.min(rawTimeout, MAX_REVIEW_TIMEOUT_MS);
    const digest = actionSha256(action);
    const dependencyCandidate = isExecutableDependencyCandidate(action);
    try {
      return await withReviewDeadline(async (signal, remainingMs) => {
        // Cached reads and learned scopes need not wait behind a model call.
        if (reuse && !dependencyCandidate) {
          const cached = await reusableReview(action, digest, signal);
          if (cached) return cached;
        }
        return scheduler.schedule(async () => {
          // A queued duplicate can reuse a completed result without spending a
          // second model call or rate token. Explicit confirmations never reuse.
          if (reuse && !dependencyCandidate) {
            const cached = await reusableReview(action, digest, signal);
            if (cached) return cached;
          }
          if (signal.aborted) return cancelled(action);
          const review = await modelReview(action, signal, remainingMs);
          if (signal.aborted) return cancelled(action);
          if (reuse && !dependencyCandidate && review.verdict === "allow" && action.userAuthorization === "explicit" && learnedApprovalBlockers(action).length === 0) {
            try { await approvalStore.remember(action); }
            catch { review.detectedHazards = [...new Set([...review.detectedHazards, "approval_memory_unavailable"])]; }
          }
          if (signal.aborted) return cancelled(action);
          if (reuse && !dependencyCandidate && action.userAuthorization !== "explicit") cacheReviewForDigest(digest, review);
          return review;
        }, { signal });
      }, { signal: options.signal, timeoutMs });
    } catch (error) {
      if (error instanceof ReviewSchedulingError) {
        if (error.hazard === "reviewer_cancelled") return cancelled(action);
        return reviewerUnavailable(error.hazard, action, 1_000);
      }
      return outputFailure("reviewer request failed unexpectedly", "reviewer_internal_failure", action);
    }
  }

  async function runPermissionReviewer(rawAction: unknown, options: ReviewOptions = {}) {
    const action = normalizeActionForReview(rawAction);
    if (!action) return outputFailure("invalid action metadata", "invalid_action_metadata");
    return scheduledReview(action, options, false);
  }

  async function reviewSensitiveAction(rawAction: unknown, options: ReviewOptions = {}) {
    const validation = validateProposedAction(rawAction);
    if (!validation.ok) return outputFailure("invalid action metadata", "invalid_action_metadata");
    const action = validation.value;
    return scheduledReview(action, options, true);
  }

  return { runPermissionReviewer, reviewSensitiveAction };
}

export const { runPermissionReviewer, reviewSensitiveAction } = createReviewService();
