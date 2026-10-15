# Project specification

This package is an advisory permission reviewer. It never executes a proposed
command, grants host permissions, changes host policy, or replaces host approval.

## Architecture

Read docs/architecture.md and the nearest AGENTS.md before changing a domain.
Runtime source lives in src/; scripts/ preserves installed launcher/import paths.
Use native Node.js ESM and built-in modules, targeting Node >=20. Keep runtime
imports acyclic and domain dependencies enforced by tests/architecture.test.mjs.
Each new domain and every new tracked subdirectory must include an AGENTS.md
specifying ownership, dependencies, invariants, and relevant validation.

## Required invariants

- Validate untrusted action metadata before prompt construction or persistence.
- A model deny/needs_user cannot become allow through explicit authorization.
- Deterministic policy may restrict an allow, never relax host policy.
- Only a verified safe read can be automatically allowed without exact explicit
  authorization or a matching, eligible, unexpired learned approval.
- Credentials are never opened, copied, logged, or stored. The isolated child
  receives only the existing managed-auth symlink and a no-tools profile.
- Persist only versioned action hashes and timestamps for eligible approvals.
- Bound requests, outputs, child lifetime, concurrency, rate, and cache size.
- Tests must use fixture strings, temporary files, and injected trusted adapters;
  never run proposed destructive commands, contact a live reviewer, or alter the
  developer's installed plugin, managed auth, configuration, or approval state.

## Validation

Run npm run check, npm test, npm pack --dry-run, and git diff --check. Changes to
entrypoints or distribution must also preserve package contents, launcher paths,
MCP schemas, and legacy exports. No release/version bump or installation is
implied by a source refactor. Record behavior changes and limitations in docs.

## Engineering navigation and scope

Read docs/maintenance.md for the domain map, design-pattern choices, and expertise
routes. Repository skills under .agents/skills/ provide architecture, policy, and
runtime/protocol maintenance guidance. Load the route relevant to the change.
Keep architecture/rules-only changes separate from behavioral fixes and
performance changes unless the user explicitly requests a combined PR. A useful
new abstraction has a concrete owner, a stable contract, and a demonstrated need;
prefer explicit module calls over introducing frameworks or event buses.
