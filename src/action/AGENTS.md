# Action contracts and serialization

Own wire schemas, validation, normalization, redaction, prompts, result parsing, and action digests. Depend only on shared config and Node built-ins. Reject unknown fields, secret-bearing input, oversized values, and malformed model output. Keep canonical field order stable; authorization is part of the digest. No filesystem reads, persistence, process launch, transport, or policy decisions.

Validation: action, policy, and compatibility tests.

Reviewer prompts carry the full validated scope, with redaction, within the
fixed prompt limit. Never silently drop command suffixes, targets, flags or side
effects to fit a prompt. Oversized complete scope requires a narrower request.
Only the host constructs availability/retry metadata; model output cannot add it.
