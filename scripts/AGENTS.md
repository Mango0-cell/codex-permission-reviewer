# Compatibility surfaces and package tooling

Own the typed server and app-server-client compatibility facades, package asset generation, and archive verification. Keep domain logic in src/. Importing facades must not start transport or spawn a reviewer. The build generates server.mjs and app-server-client.mjs launchers; package-assets.ts owns those outputs. Preserve executable server behavior and all legacy named exports.

Validation: npm run check, npm test, npm run test:package, and git diff --check.

Maintain implementation and tests as strict TypeScript. Use type-only imports for
contracts, validate untrusted values from unknown, and keep built JavaScript in
dist/ or generated compatibility launchers. See docs/typescript.md at repo root.
