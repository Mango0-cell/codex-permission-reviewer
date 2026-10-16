# Continuous integration and release

CI verifies types, deterministic tests, and the installable archive across the
supported Node versions. It must not install a developer plugin, contact a live
reviewer, run destructive fixtures, or require secrets. CI permissions stay
read-only.

The separate release job runs only for a `main` push after the complete CI
matrix succeeds. It uses full Git history and isolated Node 24+ release tooling.
Only that job may write repository contents so it can commit synchronized
version metadata, create a version tag/GitHub release, and attach the tested
archive. It must not publish to npm, write issues or pull requests, or use OIDC.

Validation: inspect triggers, job dependencies, exact job permissions, stale-head
handling, and local npm checks. Never validate by creating a real tag or release.
