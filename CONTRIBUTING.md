# Contributing

Human and coding-agent contributors use the same engineering contract. Start with
[AGENTS.md](AGENTS.md), [the maintenance map](docs/maintenance.md), and the nearest
domain specification. Claude Code also reads [CLAUDE.md](CLAUDE.md). Native
repository skills in `.agents/skills/` (Codex) and `.claude/skills/` (Claude
Code) route to shared architecture, policy, runtime, commit, and PR guides; they
do not install or modify global configuration.

## Choose a reviewable change

Describe the trigger, current behavior, intended result and owning domain. Keep
bug fixes/performance changes separate from architecture/rules-only work and from
maintenance tooling. If a behavioral change is inseparable from a move, explain
why and expose it clearly in the PR. Do not combine unrelated defects because
they happen to share a file.

Maintain strict TypeScript compiled to NodeNext ESM for Node >=20, with built-in
runtime modules. Follow the pattern selection guide in
docs/maintainers/architecture.md. Prefer small explicit contracts and local
functions; add new dependencies or infrastructure only for a concrete need.
Every new domain/subfolder outside the native agent-setup trees requires an
AGENTS.md specifying its owner, dependencies, invariants and relevant
validation. Use provider-native SKILL.md and rule formats inside `.agents/` and
`.claude/`; do not add AGENTS.md or CLAUDE.md there.

Follow [the code-writing conventions](docs/maintainers/engineering.md): keep
side effects at explicit boundaries, validate untrusted inputs before use, give
errors and resource lifetimes clear owners, and test observable behavior. In a
TypeScript source scope, use strict types and narrow external data from `unknown`;
do not introduce `any` as a shortcut. Use the source format declared by the active
branch and do not maintain handwritten duplicates of generated compatibility
files.

## Preserve the product's intent

The plugin advises; it never executes proposed actions, grants host permission,
or bypasses host approval. Keep exact human authorization, strict model-output
validation, deterministic restrictions, isolated child execution and credential
privacy intact. Do not treat reviewer outages or performance optimizations as a
reason to allow an unreviewed action. Preserve the fresh explicit-review path and
make confirmation requirements understandable to the caller.

## Develop and verify

The runtime uses built-in modules only. TypeScript and Node typings are pinned
development dependencies; run `npm ci` in a fresh checkout or after lockfile
changes. Then run:

```sh
npm ci
npm run check
npm test
npm run test:package
npm pack --dry-run
git diff --check
```

Use the nearest domain's validation notes for focused checks, then run the
required checks above before a PR. `npm test` builds before running the compiled
suite; `npm run test:package` exercises the built archive without development
dependencies in its consumer. CI covers Node 20, 22 and 24. For distribution
changes, unpack an npm archive into a temporary directory and check CLI/MCP asset
resolution. For a source move, verify stable exports and the moved implementation.

Use fixture strings, fake trusted reviewer adapters, and temporary filesystem and
approval state. Do not execute proposed/destructive commands, launch a live model
reviewer, inspect managed credentials, or alter an installed plugin for a source
test. Restore temporary environment changes. New tests should detect a meaningful
regression, not merely mirror a function's wording or private implementation.

For skill/rule changes, verify frontmatter and all shared-guide/import paths, and
walk a realistic navigation/change request through the relevant guide. Keep
provider-specific entrypoints thin; the shared expertise belongs in docs/maintainers/.

## Commits and GitHub PRs

Use [the commit guide](docs/maintainers/commits.md) for focused staging and
Conventional Commit messages. Commit types also determine automated release
versions; read [the release guide](docs/releases.md) before changing analyzer
rules or merging release-worthy commits to `main`. Use the
[PR guide](docs/maintainers/pull-requests.md) to inspect the full changed path,
review an exact PR head, prepare a description from the checked-in template, or
respond to feedback. An issue link is useful when one exists, but is not required.
Report the exact checks and PR head SHA that were verified. Posting a review or
changing a PR requires the task to call for that GitHub action; never merge unless
the task explicitly authorizes the merge.

## Submit and recover

Use the PR template to explain the user-visible behavior, design choice, actual
validation and material limits. Distinguish local fixtures from live inference
measurements. Include an issue or reproducer where relevant, and state how to
recover if contracts or stored approval scope change. Do not bump a version,
install a plugin, publish, or merge unless the task authorizes it. Existing task
authorization remains valid; routine reversible source work needs no extra prompt.
