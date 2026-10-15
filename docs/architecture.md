# Reviewer architecture

The runtime separates untrusted metadata, deterministic policy, local approval
state, model execution, orchestration, and MCP I/O. Stable files in scripts/
preserve installed plugin paths and the existing import API. No runtime package
dependencies or build step are required.

```mermaid
flowchart TD
  CLI[bin/cli.mjs] --> Launcher[scripts/server.mjs]
  Launcher --> MCP[src/transport: JSON-RPC and framing]
  MCP --> Review[src/review: service, cache and budgets]
  Review --> Action[src/action: contracts, validation, redaction and results]
  Review --> Policy[src/policy: deterministic authorization and file verification]
  Review --> Store[src/approvals: versioned hashes and expiry]
  Review --> Runtime[src/runtime: isolated app-server]
  Policy --> Action
  Store --> Action
  Runtime --> Child[Ephemeral no-tools reviewer]
```

Shared limits live in src/config.mjs. Model/effort configuration is a leaf module
in src/runtime/config.mjs, so loading contracts does not load process-launch code.
The action and policy domains do not depend on orchestration or transport.
Architecture tests reject cycles and imports outside these boundaries.

## Ownership and entrypoints

| Path | Owns |
| --- | --- |
| src/action/ | Action schemas, normalization, secret checks/redaction, prompts, canonical digests, model response validation |
| src/policy/ | Command signals, exact authorization blockers, learned-approval eligibility, trusted-root and file-identity checks |
| src/approvals/ | Expiring, versioned action hashes and timestamps; no raw metadata |
| src/review/ | Model call composition, concurrency/rate limits, result caching, cancellation and policy application |
| src/runtime/ | Validated model configuration, executable identity, isolated child configuration/environment, protocol and cleanup |
| src/transport/ | MCP lifecycle, bounded lines, cancellation routing and JSON-RPC output |
| scripts/ | Compatibility exports/launcher and local syntax check |
| bin/ | CLI installation and MCP process launch |

Every maintained directory has an AGENTS.md with its contract. New domains and
subfolders need their own specification. npm includes src/ so both the CLI and
plugin launcher work from a packaged install. No installer configuration, running
plugin, managed credentials, release tag, or published version is changed.

## Decision flow

1. Validate and normalize metadata, rejecting unsupported fields, raw secrets,
   missing scope, and oversized inputs. Compute the canonical action digest.
2. Reject cancellation before consulting learned approvals or result cache.
3. Consult eligible exact learned approvals; corrupt or unavailable state never
   grants permission. Explicit requests always require a fresh model review.
4. Reverify cached safe reads against current filesystem state. Otherwise enforce
   concurrency/rate limits and call the managed isolated reviewer.
5. Strictly validate the response. Preserve deny and needs_user, including after
   explicit user authorization. Apply deterministic restrictions to model allow.
6. Decorate the advisory result with its digest and timestamps. Persist only
   eligible successful explicit approvals, using hashes and timestamps.

The default service uses the real runtime. createReviewService accepts trusted
in-process adapters so tests can return controlled model responses without a
live Codex child or authentication. MCP metadata cannot inject these adapters.

## PR #2 review and expanded regression scope

PR #2 at `3f9a6c222c1e9000e439b3cff146ab8ba00646cd` correctly prevents the
reported Docker --rm option from matching the rm branch. Its original 16 fixtures
pass. No defect introduced by that one-line change was found. It is a valid
narrow correction to issue #1; it does not cover the wider pre-existing problems:

- Flag-order and spelling gaps: rm -fr, rm -f -r, and rm --force --recursive evade the
  old predicate. The old expression also consumes r/f in operands or later commands.
- Command boundaries: the old git expression can attribute --force from a later
  command to git push. Git global options and reordered reset flags are missed.
- SQL WHERE scope: a WHERE in another statement, string, or comment can hide a
  broad DELETE/UPDATE. Matching now scopes WHERE to a statement and ignores
  literals/comments when determining whether the qualifier exists.
- Model verdict handling: the old explicit-authorization branch replaces a valid
  model deny or needs_user with allow when deterministic blockers are absent.
  The model verdict is now preserved before explicit-authorization handling.
- Cancellation: previously an already-cancelled request could return an allow
  from cached results or learned state. Cancellation is checked before reuse.

The separate architecture PR includes the narrow correction with its original
authorship, replaces source-regex extraction with imports of production functions,
and exercises these cases at both signal and policy/service boundaries. These
are pre-existing gaps and follow-up improvements, not regressions caused by #2.

## Deliberate limits

Command matching is bounded conservative lexical analysis, not an interpreter or
a complete shell/SQL parser. It recognizes executable spellings, option tokens,
separators, absolute paths, wrappers and nested quoted strings; it does not resolve
shell variables, aliases, generated programs, eval, SQL procedures, dialect-specific
syntax, or every possible executable encoding. Inspecting nested strings can also
flag inert examples such as echo 'rm -rf path'. Absence of a signal never grants
permission: model review and other deterministic and host checks still apply.
Recursive rm is blocked even without force. A literal -- ends option parsing.

Learned-approval eligibility separately recognizes common `rm`, `unlink`,
`rmdir`, `find -delete`, and SQL row-mutation command forms. This prevents a
generic `command` operation label from making an exact destructive action
reusable. That signal suppresses approval memory; it does not by itself block a
fresh exact explicit review. The bounded tokenizer and SQL keyword checks are
not complete shell or SQL interpreters and may conservatively flag inert nested
text.

Safe-read verification and action digests are advisory snapshots. They do not
bind execution atomically or eliminate TOCTOU. The runtime adapter was relocated
without changing its isolation protocol. Tests verify composition and selected
runtime contracts, not every failure path of a real Codex app-server process.

## Validation

Run npm run check, npm test, npm pack --dry-run, and git diff --check. CI runs
syntax, tests, and a package dry-run on Node 20, 22, and 24. Fixture commands remain
strings; tests only launch the local MCP server with invalid metadata or use
trusted fake model adapters and temporary filesystem/approval state.
