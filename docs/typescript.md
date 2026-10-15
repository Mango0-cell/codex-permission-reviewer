# TypeScript, build and installation contract

Maintained code in src/, bin/, scripts/ and tests/ is TypeScript. The compiler uses
strict mode, noUncheckedIndexedAccess, noImplicitOverride, noFallthroughCasesInSwitch,
NodeNext ESM resolution, unused-code/return-path checks and a Node 20 API baseline. Explicit DTOs describe actions,
normalized flags, model reviews, decorated results, adapters, scheduling and child
protocol state. External JSON/process/store data is unknown until validated.
Types do not replace runtime checks of untrusted input or create authorizations.

## One source, one artifact

TypeScript imports name their emitted .js files so Node can execute the output
without extension rewriting or a runtime loader. Type-only imports erase cleanly
and stay within the same domain dependency boundaries. Source maps embed original
source and declarations accompany the public API. No runtime code uses any,
ts-ignore or ts-nocheck to silence a compiler failure.

npm run build cleans dist/, compiles the source/tests and generates the existing
bin/cli.mjs, scripts/server.mjs and scripts/app-server-client.mjs compatibility
paths. The wrappers only load compiled implementations. They are generated and
ignored by Git; do not edit or commit them. npm's bin and MCP manifest keep their
existing portable paths. The CLI resolves the bundled skill from the package
root rather than assuming source and compiled folders have the same depth.

## Development and packaging

```sh
npm ci
npm run check
npm test
npm run test:package
npm pack --dry-run
git diff --check
```

npm ci runs prepare, which builds the checkout with lockfile-pinned development
tools. check performs strict type checking; test clean-builds and runs compiled
Node tests. test:package packs the already-tested output with scripts disabled,
installs that archive into a temporary consumer with development dependencies and
install scripts disabled, then exercises CLI help, MCP initialization/tool listing,
invalid-action handling, compatibility imports and declaration presence. The install
path uses a temporary CODEX_HOME and a fake `codex` executable to verify skill asset
resolution, file permissions, and the generated MCP registration arguments without
changing real configuration. It never registers a real plugin, reads credentials or
runs a live reviewer.

CI installs development tools using npm ci --ignore-scripts, then type-checks,
builds/tests, and validates the exact compiled archive on Node 20, 22 and 24.
Build failure prevents emission; a clean build avoids shipping stale modules.
Do not pack with scripts disabled before building.

## Install paths

Published npm archives contain dist/ JavaScript/declarations and generated
compatibility launchers. They run without TypeScript, Node typings or a loader in
the consuming project. Prebuilt archives support disabled install scripts; they
are the preferred distribution artifact for a release. The current version-pinned
installer and per-user auth/config boundaries remain unchanged.

Git/GitHub source installs need prepare enabled: npm installs the checkout's
build-time development dependencies and prepares the package before installation.
The same build produces the same public paths as the prebuilt artifact; no global
tsc or machine-specific path is required. Use a reviewed version/tag/commit as
already documented, not a floating development branch for ordinary installation.
A new release/tag is separate from this source migration; existing v0.3.0 sources
are not retroactively changed by merging it.

For an unpublished checkout, npm ci builds runnable local launchers. Test CLI help
or invalid MCP fixtures without invoking install, which registers the version-pinned
released package. Actual installation/release/configuration requires the task's
authorization and is not part of source validation.

## Static and runtime boundary evidence

Tests preserve all 31 public server runtime exports, validate domain dependencies,
check emitted modules/declarations and verify generated-only JavaScript launchers.
Approval-memory fixtures prove exact scope retrieval, changed-scope rejection,
expiry and malformed-state handling using temporary state. JavaScript callers can
still send invalid values, so runtime guards and controlled failures remain.

Sources: [TypeScript strict](https://www.typescriptlang.org/tsconfig/strict.html),
[NodeNext and emitted imports](https://www.typescriptlang.org/docs/handbook/modules/reference.html),
[npm prepare lifecycle](https://docs.npmjs.com/cli/v11/using-npm/scripts/),
[npm package contents](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/).
