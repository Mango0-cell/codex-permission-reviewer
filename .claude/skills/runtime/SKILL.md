---
name: runtime
description: Implement or debug this plugin's review lifecycle, async coordination, latency limits, caching, cancellation, isolated child process, or MCP/app-server transport. Use for runtime behavior; policy decisions belong to policy expertise.
---

# Runtime

Read the root `CLAUDE.md` (it imports the canonical `AGENTS.md`) and the nearest
domain specification. Read the
[runtime guide](../../../docs/maintainers/runtime.md) before changing review
coordination, child lifecycle, caching or transport. Use the
[maintenance map](../../../docs/maintenance.md) for ownership across domains
and the [code-writing guide](../../../docs/maintainers/engineering.md) for
source changes.

Locate the lifecycle owner and trace success, failure, saturation and
cancellation paths. Keep resource cleanup with its owner, bound asynchronous
work, and use trusted adapters and controlled fixtures to verify observable
behavior. Load policy expertise only when the authorization decision itself
changes.

This skill guides source maintenance; it does not invoke a live reviewer for
routine engineering work or authorize releases or unrelated GitHub writes. Honor
task authorization and report checks, observed behavior and material limits.
