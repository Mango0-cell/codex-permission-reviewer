# Learned approval storage

Own versioned SHA-256 approval scope and timestamp persistence, TTL pruning, limits, and restrictive modes. Depend only on action helpers, config, and Node built-ins. Never persist commands, paths, reasons, secrets, or model output. Storage errors must never grant approval; eligibility is decided by policy before calling this domain. No model invocation or transport. Tests use a temporary CODEX_HOME and restore environment changes.

Validation: review-policy learned approval tests.
