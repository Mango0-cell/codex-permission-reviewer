import type { NormalizedAction, Review, ReviewResult } from "./types.ts";
import { MAX_OUTPUT_BYTES, REVIEW_TTL_MS, MAX_OUTPUT_RATIONALE_LENGTH, MAX_OUTPUT_HAZARDS, MAX_OUTPUT_HAZARD_LENGTH, MAX_OUTPUT_ALTERNATIVE_LENGTH } from '../config.ts';
import { OUTPUT_KEYS, OUTPUT_VERDICTS, OUTPUT_RISK_LEVELS } from './contracts.ts';
import { isPlainObject, boundedText, redactSecrets, actionSha256 } from './metadata.ts';

function sanitizeReviewText(value: unknown, maxLength: number, fallback = "") {
  const text = typeof value === "string" ? value : fallback;
  return boundedText(redactSecrets(text.trim()), maxLength);
}

export function sanitizeReviewOutput(review: Partial<Review> | null | undefined): Review {
  const verdict = review?.verdict && OUTPUT_VERDICTS.has(review.verdict) ? review.verdict : "deny";
  const riskLevel = review?.riskLevel && OUTPUT_RISK_LEVELS.has(review.riskLevel) ? review.riskLevel : "critical";
  const rawHazards = Array.isArray(review?.detectedHazards) ? review.detectedHazards : [];
  const detectedHazards = rawHazards
    .filter((hazard) => typeof hazard === "string")
    .slice(0, MAX_OUTPUT_HAZARDS)
    .map((hazard) => sanitizeReviewText(hazard, MAX_OUTPUT_HAZARD_LENGTH))
    .filter(Boolean);
  return {
    verdict,
    riskLevel,
    rationale: sanitizeReviewText(review?.rationale, MAX_OUTPUT_RATIONALE_LENGTH, "The advisory reviewer did not provide a safe rationale."),
    detectedHazards,
    saferAlternative: sanitizeReviewText(review?.saferAlternative, MAX_OUTPUT_ALTERNATIVE_LENGTH),
  };
}

export function decorateReview(review: Review, action: NormalizedAction | null = null, reviewedAt = new Date()): ReviewResult {
  const safeReviewedAt = reviewedAt instanceof Date && !Number.isNaN(reviewedAt.valueOf()) ? reviewedAt : new Date();
  let digest = null;
  if (action !== null) {
    try {
      digest = actionSha256(action);
    } catch {
      digest = null;
    }
  }
  return {
    ...sanitizeReviewOutput(review),
    actionSha256: digest,
    reviewedAt: safeReviewedAt.toISOString(),
    expiresAt: new Date(safeReviewedAt.valueOf() + REVIEW_TTL_MS).toISOString(),
  };
}

export function outputFailure(_reason: string, hazard = "reviewer_unavailable", action: NormalizedAction | null = null): ReviewResult {
  return decorateReview({
    verdict: "deny",
    riskLevel: "critical",
    rationale: "The advisory permission review did not complete safely; the proposed action must not proceed.",
    detectedHazards: [hazard],
    saferAlternative: "Stop and ask the user directly, or retry after the reviewer is available.",
  }, action);
}

// Availability is not a completed policy decision. Never turn an outage into
// an approval, and do not tell callers a transport failure is a model denial.
export function reviewerUnavailable(hazard: string, action: NormalizedAction, retryAfterMs: number | null = null): ReviewResult {
  const retryable = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0;
  return {
    ...decorateReview({
      verdict: "needs_user",
      riskLevel: "high",
      rationale: "No advisory decision is available because the reviewer could not complete. The proposed action remains unapproved.",
      detectedHazards: [hazard],
      saferAlternative: retryable
        ? "Continue independent work. Retry the review after the indicated delay within a bounded retry budget; do not execute the proposed action without approval."
        : "Resolve the reviewer setup problem or ask the user for help; do not execute the proposed action on this incomplete review.",
    }, action),
    reviewStatus: "unavailable",
    retryable,
    ...(retryable ? { retryAfterMs: Math.ceil(retryAfterMs) } : {}),
  };
}

/**
 * Strictly parse the reviewer's JSON object. Structured Outputs is not a
 * substitute for local validation because the network response is untrusted.
 * @param {unknown} stdout
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function parseReviewerOutput(stdout: unknown): { ok: true; value: Review } | { ok: false; error: string } {
  if (typeof stdout !== "string") return { ok: false, error: "reviewer output was not text" };
  if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) return { ok: false, error: "reviewer output exceeded the size limit" };
  const trimmed = stdout.trim();
  if (!trimmed) return { ok: false, error: "reviewer output was empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "reviewer output was not valid JSON" };
  }
  if (!isPlainObject(parsed)) return { ok: false, error: "reviewer output must be a JSON object" };
  for (const key of Object.keys(parsed)) {
    if (!OUTPUT_KEYS.has(key)) return { ok: false, error: "reviewer output contains unsupported fields" };
  }
  if (typeof parsed.verdict !== "string" || !OUTPUT_VERDICTS.has(parsed.verdict)) return { ok: false, error: "reviewer output has an invalid verdict" };
  if (typeof parsed.riskLevel !== "string" || !OUTPUT_RISK_LEVELS.has(parsed.riskLevel)) return { ok: false, error: "reviewer output has an invalid risk level" };
  if (typeof parsed.rationale !== "string" || parsed.rationale.trim().length === 0 || parsed.rationale.length > MAX_OUTPUT_RATIONALE_LENGTH) {
    return { ok: false, error: "reviewer rationale was missing or too long" };
  }
  if (!Array.isArray(parsed.detectedHazards) || parsed.detectedHazards.length > MAX_OUTPUT_HAZARDS) {
    return { ok: false, error: "reviewer hazards were invalid" };
  }
  for (const hazard of parsed.detectedHazards) {
    if (typeof hazard !== "string" || hazard.trim().length === 0 || hazard.length > MAX_OUTPUT_HAZARD_LENGTH) {
      return { ok: false, error: "reviewer hazards contained invalid text" };
    }
  }
  if (typeof parsed.saferAlternative !== "string" || parsed.saferAlternative.length > MAX_OUTPUT_ALTERNATIVE_LENGTH) {
    return { ok: false, error: "reviewer safer alternative was invalid" };
  }
  return {
    ok: true,
    value: {
      verdict: parsed.verdict as Review["verdict"],
      riskLevel: parsed.riskLevel as Review["riskLevel"],
      rationale: redactSecrets(parsed.rationale),
      detectedHazards: parsed.detectedHazards.map((hazard) => redactSecrets(hazard)),
      saferAlternative: redactSecrets(parsed.saferAlternative),
    },
  };
}

