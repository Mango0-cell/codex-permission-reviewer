# Learned approval storage

Own versioned SHA-256 approval scope and timestamp persistence, TTL pruning, limits, and restrictive modes. Depend only on action helpers, config, and Node built-ins. Never persist commands, paths, reasons, secrets, or model output. Storage errors must never grant approval; eligibility is decided by policy before calling this domain. No model invocation or transport.

The process-local exact-hash index is bounded to one canonical store path and at most `MAX_LEARNED_APPROVALS` entries. Every hit must revalidate the trusted directory chain, regular-file `lstat` identity (`dev`, `ino`, size, nanosecond timestamps, and mode), and fixed expiry. Use `O_NOFOLLOW` when the platform provides it. Otherwise compare the opened handle's identity with the trusted pre-open identity before reading any content, then compare handle and path identity after the bounded read. This Windows path relies on the canonical local `CODEX_HOME` boundary; it is not equivalent to kernel no-follow or POSIX owner/mode checks. A missing, replaced, symlinked, malformed, unreadable, insecure, or expired record must never be allowed from stale memory. Keep the versioned JSON format and exact digest calculation stable. Persist with a unique same-directory temporary file, owner-only mode where supported, and atomic replacement; serialize writes within this process. Cross-process writes remain best-effort and may lose a remembered entry, which must result in a fresh review.

Tests use a temporary `CODEX_HOME`, restore environment changes, and never touch the developer's installed state. Cover one content read across warm lookups, per-lookup metadata checks, unchanged-file expiry, external replacement/revocation, pre-read symlink replacement with zero bytes read, post-read identity changes, corrupt/symlinked files, failed writes, and same-process concurrent remembers. A focused Node 20 Windows CI job exercises the platform fallback.

Validation: review-policy learned approval tests.

Maintain implementation and tests as strict TypeScript. Use type-only imports for
contracts, validate untrusted values from unknown, and keep built JavaScript in
dist/ or generated compatibility launchers. See docs/typescript.md at repo root.
