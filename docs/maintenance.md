# Maintaining an agent-written permission reviewer

This plugin adds a small advisory check for meaningful damage or data-loss risk.
Routine tasks should not acquire extra review or confirmation steps. Exact active
user authorization is reused; genuine risk still has a human confirmation path.
It is not the executor, the host permission system, or a general code-review
service. Improving throughput must not turn an unavailable reviewer or missing
metadata into permission. Humans authorize exact actions; user authorization is
context for a fresh review, not a replacement for the host's approval rules.

## Navigation and expertise

| Work | Owner and entrypoint | Expertise guide |
| --- | --- | --- |
| Find a change's domain, split responsibilities, add a module | src/ and nearest AGENTS.md; scripts/ contains typed compatibility facades and generated `.mjs` launchers | [Architecture](maintainers/architecture.md) |
| Change metadata, response contracts, human confirmation, deterministic decisions or learned scope | src/action/, src/policy/, src/approvals/ | [Policy](maintainers/policy.md) |
| Change latency, review coordination, caching, child lifecycle, MCP framing or shutdown | src/review/, src/runtime/, src/transport/ | [Runtime](maintainers/runtime.md) |
| Change install or distribution | bin/cli.ts (generated `bin/cli.mjs`), package.json, .mcp.json, .codex-plugin/ | Architecture guide plus the local AGENTS.md |
| Automate versioned GitHub releases | .github/release/, .releaserc.json, .github/workflows/ci.yml and src/version.ts | The release folder specification; GitHub assets only, no npm publication |
| Change shipped instructions for agents using the plugin | skills/sensitive-permission-review/SKILL.md | Policy guide; keep usage aligned with real runtime behavior |
| Change how agents maintain this repository | .agents/skills/, .claude/skills/, .claude/rules/, CLAUDE.md, AGENTS.md | This guide and the relevant expertise guide |
| Write or reshape source code | Owning src/ domain and its nearest AGENTS.md | [Code-writing conventions](maintainers/engineering.md), plus the domain guide |
| Stage and commit a change | Current branch and working tree | [Commit conventions](maintainers/commits.md) |
| Review, prepare, or update a GitHub PR | PR base/head and changed files | [PR workflow](maintainers/pull-requests.md) |

For exact ownership and current behavior, consult [architecture.md](architecture.md).
The guides explain engineering decisions; source, tests, and exported contracts
establish what actually exists. Do not document a proposed feature as implemented.

## Native entrypoints, one engineering contract

Codex reads hierarchical AGENTS.md instructions and discovers repository skills
in `.agents/skills/<name>/SKILL.md`. Claude Code reads the root CLAUDE.md pointer,
uses one-line CLAUDE.md mirrors for product/code domain specs, and discovers
native project skills in `.claude/skills/<name>/SKILL.md`; `.claude/rules/`
contains path-scoped reminders. The five skills use matching names (`architecture`,
`commit`, `policy`, `pr`, `runtime`) and provider-native entrypoints. Keep shared
engineering knowledge in `docs/maintainers/` and route both entrypoints there
instead of copying full guides. Agent-setup folders intentionally have no nested
AGENTS.md or CLAUDE.md specs; the provider's native skill and rule formats own
those instructions. These repository-scoped files do not require global
installation.

The maintenance skills are repository-scoped. They are different from the
permission-review skill installed for agents *using* the plugin. They should not
change a user's global agent configuration, install themselves, or call a live
reviewer merely to maintain source code. Repository skill references assume this
checkout exists; they are not standalone global skill bundles.

## Change contract

Before editing, identify the trigger, current behavior, desired behavior, domain
owner, and observable acceptance check. Trace imports/callers around the boundary
instead of choosing a pattern from its name. Read only the relevant expertise
guide and nearest domain spec. Keep public launcher paths and Node >=20 native
ESM compatibility unless the task explicitly changes that contract.

Keep PRs independently reviewable: behavior fixes/performance work, architecture
and directory rules, and maintenance tooling each have separate purposes. Name
unavoidable coupling in the PR description. Avoid unrelated cleanups or changing
an approval policy while claiming a behavior-preserving refactor.

Use CONTRIBUTING.md for validation and review requirements. Describe measured
latency separately from model-answer quality; a passing fixture suite cannot
prove the quality of real model responses or claim a live speedup.

## Official conventions

- [Codex repository skill discovery](https://learn.chatgpt.com/docs/build-skills)
- [Codex AGENTS.md hierarchy](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [Claude Code memory, imports, and path rules](https://code.claude.com/docs/en/memory)

## Retrieve context without accumulating ceremony

Before a structural or policy change, retrieve the existing architecture notes
and the relevant shared guide; confirm the facts in source and tests. Preserve
durable ownership, contract and risk decisions in those maintained documents
instead of creating a new chat log for every edit. Update an existing decision
when the behavior changes, so future agents recover current context. This
engineering knowledge is separate from the plugin's private exact-scope approval
memory. Never place raw action commands, credentials or user approval history in
repository documentation.
