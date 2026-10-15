# Runtime composition

Own shared limits in config.ts and domain source. Configuration may depend only on runtime/config.ts; importing configuration must never spawn a child. Keep domain imports explicit and acyclic.

Validation: npm run check and npm test.

Maintain implementation and tests as strict TypeScript. Use type-only imports for
contracts, validate untrusted values from unknown, and keep built JavaScript in
dist/ or generated compatibility launchers. See docs/typescript.md at repo root.
