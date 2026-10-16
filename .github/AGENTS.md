# Repository automation

Own CI and release workflow configuration. Keep the CI workflow read-only and
secret-free. A dedicated release job may receive only `contents: write`, after
the supported Node matrix succeeds on `main`; it must not publish npm packages,
comment on issues/PRs, or use OIDC. Every workflow and tooling subdirectory must
carry its own specification.

Validation: review triggers, dependencies, permissions, full-history checkout,
and stale-head handling; run npm run check, npm test and npm run test:package.
