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
| Find a change's domain, split responsibilities, add a module | src/ and nearest AGENTS.md; scripts/ only preserves old entrypoints | [Architecture](maintainers/architecture.md) |
| Change metadata, response contracts, human confirmation, deterministic decisions or learned scope | src/action/, src/policy/, src/approvals/ | [Policy](maintainers/policy.md) |
| Change latency, review coordination, caching, child lifecycle, MCP framing or shutdown | src/review/, src/runtime/, src/transport/ | [Runtime](maintainers/runtime.md) |
| Change install or distribution | bin/cli.mjs, package.json, .mcp.json, .codex-plugin/ | Architecture guide plus the local AGENTS.md |
| Change shipped instructions for agents using the plugin | skills/sensitive-permission-review/SKILL.md | Policy guide; keep usage aligned with real runtime behavior |
| Change how agents maintain this repository | .agents/skills/, .claude/, CLAUDE.md, AGENTS.md | This guide and the relevant expertise guide |

For exact ownership and current behavior, consult [architecture.md](architecture.md).
The guides explain engineering decisions; source, tests, and exported contracts
establish what actually exists. Do not document a proposed feature as implemented.

## Native entrypoints, one engineering contract

Codex reads hierarchical AGENTS.md instructions and discovers the repository's
expertise skills in .agents/skills/. Claude Code reads CLAUDE.md, imports the shared
root contract there, uses one-line scoped CLAUDE.md mirrors to import each domain
specification, and uses .claude/rules/ for path-scoped reminders plus
.claude/skills/ for matching expertise. Claude's skill directories are relative symlinks to the canonical .agents/skills/
directories; both providers read the same SKILL.md and maintainers/ guides. Update shared knowledge there rather than copying design
rules into provider-specific files. Git checkouts must preserve these relative
symlinks; they stay inside this repository and require no global installation.

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
