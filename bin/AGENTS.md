# Package CLI

Own installation and MCP launch. Preserve version-pinned installation, model/effort validation, explicit force requirement for differing installed skills, and relative package asset resolution. Never read managed credentials. Keep CLI paths compatible with package bin metadata.

Validation: syntax checks, packaged CLI help, and package-content tests.

Maintain implementation and tests as strict TypeScript. Use type-only imports for
contracts, validate untrusted values from unknown, and keep built JavaScript in
dist/ or generated compatibility launchers. See docs/typescript.md at repo root.
