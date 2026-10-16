# Project specification

This package is a lightweight advisory check for meaningful damage and data-loss risk.
Routine engineering work stays in the normal host workflow; avoid extra prompts
when exact task authorization already exists. It never executes a proposed
command, grants host permissions, changes host policy, or replaces host approval.

## Architecture

Read docs/architecture.md and the nearest AGENTS.md before changing a domain.
Runtime source lives in src/; scripts/ preserves installed launcher/import paths.
Maintain strict TypeScript targeting Node >=20 ESM with built-in runtime modules.
TypeScript, Node typings and tests are development tooling; consumers run compiled
JavaScript. Read docs/typescript.md before changing types, builds or packaging.
Keep runtime imports acyclic and domain dependencies enforced by
tests/architecture.test.ts.
Each new domain and every new tracked subdirectory outside native agent-setup
trees must include an AGENTS.md specifying ownership, dependencies, invariants,
and relevant validation. The `.agents/` and `.claude/` trees use each provider's
native skill/rule formats; do not add AGENTS.md or CLAUDE.md specs inside them.

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

Run npm ci, npm run check, npm test, npm run test:package, npm pack --dry-run,
and git diff --check. Changes to entrypoints or distribution must also preserve
package contents, launcher paths, MCP schemas, and legacy exports. No
release/version bump or installation is implied by a source refactor. Record
behavior changes and limitations in docs.

## Engineering navigation and scope

Read docs/maintenance.md for the domain map, design-pattern choices, and expertise
routes. Read docs/maintainers/engineering.md when writing code. Repository skills
under `.agents/skills/` are `architecture`, `commit`, `policy`, `pr`, and
`runtime`; Claude Code has native entrypoints with matching names in
`.claude/skills/`. Load the route relevant to the task. For Git history and PR work, read
docs/maintainers/commits.md and docs/maintainers/pull-requests.md. Keep
architecture/rules-only changes separate from behavioral fixes and performance
changes unless the user explicitly requests a combined PR. A useful new
abstraction has a concrete owner, a stable contract, and a demonstrated need;
prefer explicit module calls over introducing frameworks or event buses. When
TypeScript is present in the active source scope, use strict types, validate
external data from unknown, and avoid any.

## Typed source and distribution

Maintain source and tests in .ts files with strict compiler checks and explicit
module contracts. External JSON/process/persistence data starts as unknown and
is narrowed by runtime validation. Do not suppress errors with any, ts-ignore or
ts-nocheck. Generated .mjs launchers and dist/ JavaScript are build outputs, not
parallel implementations. Type-only imports follow the same domain ownership
as runtime imports. Build and smoke-test the artifact that will be distributed.
