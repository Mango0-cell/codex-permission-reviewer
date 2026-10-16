# Package CLI

Own installation and MCP launch in cli.ts. Preserve version-pinned installation, model/effort validation, explicit force requirement for differing installed skills, and relative package asset resolution. Never read managed credentials. The build generates bin/cli.mjs for package bin metadata; do not maintain a second implementation.

Validation: npm run check, npm test, and npm run test:package for packaged CLI help and package contents.

Maintain implementation and tests as strict TypeScript. Use type-only imports for
contracts, validate untrusted values from unknown, and keep built JavaScript in
dist/ or generated compatibility launchers. See docs/typescript.md at repo root.
