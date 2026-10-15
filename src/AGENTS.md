# Runtime composition

Own shared limits in config.mjs and domain source. Configuration may depend only on runtime/config.mjs; importing configuration must never spawn a child. Keep domain imports explicit and acyclic.

Validation: npm run check and npm test.
