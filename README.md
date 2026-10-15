# Codex Permission Reviewer

`codex-permission-reviewer` is a Codex plugin that adds a conservative,
advisory review before high-sensitivity actions. Its local
`review_sensitive_action` MCP tool sends bounded, redacted metadata to an
isolated child `codex app-server` using the managed ChatGPT/Codex account and
the configured reviewer model and effort. The default is `gpt-5.6-luna` at
`max`, and it can be changed without editing code.

The configured isolated model is the only permission reviewer. The plugin does
not invoke the general Codex code-review workflow. Routine reversible engineering actions remain
autonomous: commits, ordinary non-force pushes, PR operations, CI/review work,
narrow workspace edits, and read-only service interactions do not need this
plugin merely because they use the network or an external system.

The child is ephemeral and uses a temporary `CODEX_HOME`, a temporary cwd, and
a local `no-tools` permission profile. That profile extends `:read-only`,
denies the filesystem root, disables network access, leaves `mcp_servers`
empty, and disables shell, unified exec, apps, plugins, browser, image,
multi-agent, hook, goal, memory, and web-search capabilities. The plugin never
executes the proposed action. Before launch it resolves Codex from an absolute
PATH entry, pins its real-path/device/inode identity, and passes the absolute
executable path to the child.

## Installation

Install remotely from the versioned GitHub source with Node.js 20+ and Codex
`0.147+`:

```sh
npx -y github:adriancho91s/codex-permission-reviewer#v0.3.0 install
```

The installer copies only the bundled permission-review skill into your own
`CODEX_HOME` and registers this pinned MCP command:

```sh
npx -y github:adriancho91s/codex-permission-reviewer#v0.3.0 mcp
```

It does not read or copy Codex authentication. The MCP process uses your
existing managed Codex login at runtime. Existing differing skill content is
not overwritten unless you rerun the installer with `--force` after reviewing
the change.

Codex can also install the package from a configured marketplace snapshot:

```sh
codex plugin add codex-permission-reviewer@YOUR_MARKETPLACE
```

Start a new Codex thread after either installation path so the MCP schema and
skill are loaded from the installed version.

Choose another current or future Codex model by reinstalling the MCP entry:

```sh
npx -y github:adriancho91s/codex-permission-reviewer#v0.3.0 install --force \
  --model MODEL_ID --effort max
```

The installer stores only the model ID and effort in the MCP configuration.
Malformed identifiers or unsupported effort values fail closed. Every child
response is checked against the configured model and effort before its verdict
can be accepted.

## Setup

The plugin authenticates as the person who installed it by using that user's
existing managed Codex login. It never asks for, reads, copies, logs, publishes,
or stores an API key or login token. The parent Codex installation must have a
regular `auth.json` in its managed Codex home; the child receives only an
OS-level symlink to that file and the plugin never opens it. Every teammate
therefore uses their own Codex account, subscription usage, and authorization
boundary.

The bundled Codex MCP launcher uses the relative script path
`./scripts/server.mjs` and sets `cwd` to `"."`. Codex resolves that directory
relative to each teammate's installed plugin root. Do not replace it with a
machine-specific absolute path.

For automatic `allow`, configure trusted workspace roots outside the repository
and marketplace files:

```sh
export KIT_CODEX_AUTO_PERMISSION_WORKSPACE_ROOTS="/absolute/path/to/workspace"
```

Roots supplied in a request are untrusted context. Without a trusted server
root, a reviewer `allow` becomes `needs_user`. The plugin uses the same Codex
account/session billing and authentication boundary as the local app-server;
it does not create a separate API integration.

## Team and workspace sharing

The package is portable: it contains no user home paths, usernames, tokens,
auth material, API keys, or machine-specific Codex executable path. Each
teammate must use Codex `0.147+`, sign in to their own managed ChatGPT/Codex
account, and configure their own trusted workspace roots. The child resolves
that teammate's `CODEX_HOME`, managed `auth.json`, and `codex` executable at
runtime; the package never bundles or reads `auth.json`.

For workspace distribution, a workspace admin publishes from ChatGPT
**Plugins → Personal → Publish**, reviews the package and its local MCP
boundary, and chooses the appropriate installation and role access. This
package is not published or assigned to roles by the local install workflow.
Publishing does not create a separate API billing path: every teammate's
review remains on that teammate's managed Codex/ChatGPT account.

## Safety boundary

This plugin is advisory only. `allow` never grants host permission, changes the
Codex sandbox, bypasses an approval prompt, or suppresses `codex-auto-review`.
Host approvals, host policy, and the host's recheck at execution time remain
authoritative. The app-server call is independent and only avoids invoking the
host review mechanism for this plugin's own advisory request.

Every genuinely sensitive request declares `userAuthorization` as `none` or `explicit`. The caller
may use `explicit` only when the user authorized that exact action in the active
conversation. A fresh explicit configured-model review can allow a targeted production
database change, deployment, credential/permission operation, or other exact
sensitive action after informed confirmation. It cannot release plain force
pushes or unleased history rewrites, broad destructive SQL, destructive filesystem commands,
authorization bypass, download-and-execute pipelines, broad targets, or
ambiguous metadata. The field is part of the result digest, and explicit
reviews are never served from the ordinary result cache.

Successful explicit approvals can be learned for 30 days as a versioned
SHA-256 hash of the exact action scope plus timestamps. No raw commands,
targets, reasons, data, or secrets are stored. Production database/schema/data
repair, credentials/permissions, process spawning, destructive operations,
sensitive-data access, irreversible actions, history rewrites, and ambiguous
actions are never learned and always require fresh confirmation.
Common file and row mutation commands are also excluded from learning when the
caller labels them as a generic command. This is a memory restriction; command
review outcomes remain governed by the existing deterministic and model policy.

Without explicit authorization, only a narrow, regular-file `file_read` can be
automatically allowed, and only after deterministic high-sensitivity checks
plus real-path/no-follow descriptor verification inside a trusted root. Model
output cannot override the deterministic authorization boundaries above.

Every result includes a SHA-256 digest, review timestamp, and expiry. Any
metadata or filesystem/action change invalidates the advisory result; this is
not an atomic execution binding and does not eliminate TOCTOU risk.

The MCP server supports protocol versions `2026-07-28`, `2025-06-18`, and
`2024-11-05`,
requires `initialize` before tool access, bounds streaming input/output, and
fails closed on missing managed auth, malformed output, unexpected or embedded
raw/turn tool items, model/profile mismatch, timeout, or child failure. It uses one
in-flight review, a rolling limit of five child reviews per 60 seconds, and a
64-entry five-minute sanitized digest cache.

## Development and architecture

Runtime code is organized into action, policy, approvals, review, runtime, and
transport domains under `src/`. The existing `scripts/` paths remain stable
launchers and compatibility imports. Each maintained directory has an
`AGENTS.md` specification. See [the architecture and review notes](docs/architecture.md)
for dependency boundaries, decision flow, and classifier limitations.

Run `npm run check`, `npm test`, and `npm pack --dry-run` before submitting
changes. Tests use fixture strings, temporary files, and trusted fake reviewer
adapters; they do not execute proposed commands or require managed auth.
